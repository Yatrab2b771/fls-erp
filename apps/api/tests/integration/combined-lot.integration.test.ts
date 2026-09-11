import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

/** Creates a customer + PO (DRAFT), approves it as BD, and returns its one line item's id. */
async function createApprovedPoItem(bdToken: string, quantity = 100, productName = "Medicine A") {
  const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });
  const po = await request(app)
    .post("/api/purchase-orders")
    .set(authHeader(bdToken))
    .send({ customerId: customer.body.id, items: [{ productName, quantity, unit: "KG" }] });
  await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
  return po.body.items[0].id as string;
}

/** All the tokens a full pipeline walk needs. */
async function makeTokens() {
  return {
    production: (await createUser(["PRODUCTION"])).token,
    store: (await createUser(["STORE"])).token,
    ppic: (await createUser(["PPIC"])).token,
    qa: (await createUser(["QA_QC"])).token,
    accounts: (await createUser(["ACCOUNTS"])).token,
    dispatch: (await createUser(["DISPATCH"])).token,
  };
}

/** Walks a PreProduction run to its own terminal stage, plans and completes exactly one ProductionBatch covering the whole plannedQty, and returns the CombinedLot that creates. */
async function createFreshCombinedLot(itemId: string, tokens: Awaited<ReturnType<typeof makeTokens>>, plannedQty = 100) {
  const run = (await request(app).post("/api/pre-productions").set(authHeader(tokens.production)).send({ purchaseOrderItemId: itemId })).body;
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.store)).send({ action: "FORWARD" });
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.ppic)).send({ action: "FORWARD" });
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.qa)).send({ action: "FORWARD", lineClearanceStatus: "Approved" });
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.store)).send({ action: "FORWARD" });
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.qa)).send({ action: "FORWARD", sampleQcStatus: "Approved" });

  const pb = (await request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(tokens.production)).send({ plannedQty })).body;
  await request(app).patch(`/api/production-batches/${pb.id}`).set(authHeader(tokens.production)).send({ outputQty: plannedQty });
  const completed = await request(app).post(`/api/production-batches/${pb.id}/complete`).set(authHeader(tokens.production));
  return completed.body.combinedLot as { id: string; currentStageId: string };
}

describe("PATCH /api/combined-lots/:id/stage — full forward walk", () => {
  it("walks a lot from IPQC through Dispatch Plan, each stage gated to its department, fields persisted along the way", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const itemId = await createApprovedPoItem(bdToken);
    const lot = await createFreshCombinedLot(itemId, tokens);
    expect(lot.currentStageId).toBe("IPQC");

    // IPQC — QA_QC. Hard gate + Bulk Reconciliation fields (BMR-1.docx 8.0).
    const wrongDept = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(tokens.production)).send({ action: "FORWARD" });
    expect(wrongDept.status).toBe(403);

    const beforeRes = await request(app).get(`/api/combined-lots/${lot.id}`).set(authHeader(tokens.qa));
    expect(beforeRes.body.bulkReconciliation).toEqual({ yieldPct: null, processLoss: null });

    const heldIpqc = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(tokens.qa)).send({ action: "FORWARD", ipqcStatus: "Not Approved" });
    expect(heldIpqc.status).toBe(200);
    expect(heldIpqc.body.currentStageId).toBe("IPQC");

    const ipqc = await request(app)
      .patch(`/api/combined-lots/${lot.id}/stage`)
      .set(authHeader(tokens.qa))
      .send({ action: "FORWARD", ipqcStatus: "Approved", bulkTheoreticalWeight: 100, bulkActualWeight: 99, bulkQcSampleWeight: 0.6, bulkTransferToPackingQty: 99 });
    expect(ipqc.status).toBe(200);
    expect(ipqc.body.currentStageId).toBe("QA_GATE_MFG");
    // (99+0.6)/100*100 = 99.6%, loss = 100-99.6 = 0.4
    expect(ipqc.body.bulkReconciliation).toEqual({ yieldPct: 99.6, processLoss: 0.4 });

    // QA_GATE_MFG — "Hold" saves but parks the lot.
    const heldMfg = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(tokens.qa)).send({ action: "FORWARD", mfgQaStatus: "Hold", mfgQcStatus: "Hold", mfgWastageQty: 4 });
    expect(heldMfg.status).toBe(200);
    expect(heldMfg.body.currentStageId).toBe("QA_GATE_MFG");
    expect(heldMfg.body.recycleLogs).toHaveLength(0); // not logged until the gate actually clears

    const qaGateMfg = await request(app)
      .patch(`/api/combined-lots/${lot.id}/stage`)
      .set(authHeader(tokens.qa))
      .send({ action: "FORWARD", mfgQaStatus: "Approved", mfgQcStatus: "Approved", mfgApprovedQty: 90, mfgRejectedQty: 5 });
    expect(qaGateMfg.body.currentStageId).toBe("BULK_QC");
    expect(qaGateMfg.body.mfgRejectedQty).toBe(5);
    expect(qaGateMfg.body.recycleLogs).toHaveLength(1);
    expect(qaGateMfg.body.recycleLogs[0]).toMatchObject({ stageId: "QA_GATE_MFG", quantity: 4 });

    // BULK_QC — same hard gate.
    const bulkQc = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(tokens.qa)).send({ action: "FORWARD", bulkQcStatus: "Approved" });
    expect(bulkQc.status).toBe(200);
    expect(bulkQc.body.currentStageId).toBe("PACKAGING");

    // PACKAGING — Production, gated on status reading "Completed".
    const packBlank = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(tokens.production)).send({ action: "FORWARD" });
    expect(packBlank.status).toBe(200);
    expect(packBlank.body.currentStageId).toBe("PACKAGING");
    const packaging = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(tokens.production)).send({ action: "FORWARD", packagingStatus: "completed" });
    expect(packaging.body.currentStageId).toBe("QA_GATE_PACKAGING");

    // QA_GATE_PACKAGING — same Approved/Rejected/Wastage split as QA Gate Mfg.
    const qaGatePackaging = await request(app)
      .patch(`/api/combined-lots/${lot.id}/stage`)
      .set(authHeader(tokens.qa))
      .send({ action: "FORWARD", packQaStatus: "Approved", packQcStatus: "Approved", packApprovedQty: 85, packRejectedQty: 2, packWastageQty: 3 });
    expect(qaGatePackaging.body.currentStageId).toBe("BILLING_EWAY_BILL");
    expect(qaGatePackaging.body.recycleLogs).toHaveLength(2);

    // BILLING_EWAY_BILL — Accounts.
    const billing = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(tokens.accounts)).send({ action: "FORWARD", invoiceNo: "INV-9001" });
    expect(billing.body.currentStageId).toBe("DISPATCH_PLAN");
    expect(billing.body.invoiceNo).toBe("INV-9001");

    // DISPATCH_PLAN — Dispatch. Terminal, completes in place.
    const dispatchDenied = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(tokens.qa)).send({ action: "FORWARD" });
    expect(dispatchDenied.status).toBe(403);

    const dispatchPlan = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(tokens.dispatch)).send({ action: "FORWARD", dispatchDate: "2026-08-07" });
    expect(dispatchPlan.status).toBe(200);
    expect(dispatchPlan.body.currentStageId).toBe("DISPATCH_PLAN");
    expect(dispatchPlan.body.dispatchDate).toBeTruthy();

    // Still amendable afterwards (e.g. correcting a shipper qty typo).
    const amend = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(tokens.dispatch)).send({ action: "FORWARD", remainingQty: 0 });
    expect(amend.status).toBe(200);
    expect(amend.body.currentStageId).toBe("DISPATCH_PLAN");

    expect(dispatchPlan.body.stageEvents.length).toBeGreaterThan(6);
  });
});

// Real business rule: one PO ships as one combined shipment, not
// item-by-item — saving Dispatch Plan details on one item's lot should
// warn (not silently allow) when a sibling item's lot on the same PO
// hasn't caught up yet, with an explicit override for a genuine partial
// shipment.
describe("PATCH /api/combined-lots/:id/stage — combined-shipment guard at Dispatch Plan", () => {
  async function createApprovedPoWithTwoItems(bdToken: string) {
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Two-Item Co." });
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({
        customerId: customer.body.id,
        items: [
          { productName: "Medicine A", quantity: 100, unit: "KG" },
          { productName: "Medicine B", quantity: 50, unit: "KG" },
        ],
      });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    return [po.body.items[0].id as string, po.body.items[1].id as string] as const;
  }

  async function fastForwardToDispatchPlan(lotId: string, tokens: Awaited<ReturnType<typeof makeTokens>>) {
    await request(app).patch(`/api/combined-lots/${lotId}/stage`).set(authHeader(tokens.qa)).send({ action: "FORWARD", ipqcStatus: "Approved" });
    await request(app).patch(`/api/combined-lots/${lotId}/stage`).set(authHeader(tokens.qa)).send({ action: "FORWARD", mfgQaStatus: "Approved", mfgQcStatus: "Approved" });
    await request(app).patch(`/api/combined-lots/${lotId}/stage`).set(authHeader(tokens.qa)).send({ action: "FORWARD", bulkQcStatus: "Approved" });
    await request(app).patch(`/api/combined-lots/${lotId}/stage`).set(authHeader(tokens.production)).send({ action: "FORWARD", packagingStatus: "Completed" });
    await request(app).patch(`/api/combined-lots/${lotId}/stage`).set(authHeader(tokens.qa)).send({ action: "FORWARD", packQaStatus: "Approved", packQcStatus: "Approved" });
    await request(app).patch(`/api/combined-lots/${lotId}/stage`).set(authHeader(tokens.accounts)).send({ action: "FORWARD" });
  }

  it("doesn't block when a sibling item on the same PO never even started production — nothing to compare against", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const [itemA, itemB] = await createApprovedPoWithTwoItems(bdToken);
    const lotA = await createFreshCombinedLot(itemA, tokens, 100);
    // itemB is left behind — no PreProduction/CombinedLot ever created for it.
    void itemB;

    await fastForwardToDispatchPlan(lotA.id, tokens);
    const saved = await request(app).patch(`/api/combined-lots/${lotA.id}/stage`).set(authHeader(tokens.dispatch)).send({ action: "FORWARD", dispatchDate: "2026-09-01" });
    // The guard only fires once a sibling item actually has a lot that
    // isn't yet at Dispatch Plan — with no sibling lot at all, this alone
    // succeeds with no override needed.
    expect(saved.status).toBe(200);
  });

  it("blocks (409) when a sibling item's lot exists but hasn't reached Dispatch Plan, and confirmPartialDispatch overrides it", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const [itemA, itemB] = await createApprovedPoWithTwoItems(bdToken);
    const lotA = await createFreshCombinedLot(itemA, tokens, 100);
    const lotB = await createFreshCombinedLot(itemB, tokens, 50); // stays at IPQC

    await fastForwardToDispatchPlan(lotA.id, tokens);
    const blocked = await request(app).patch(`/api/combined-lots/${lotA.id}/stage`).set(authHeader(tokens.dispatch)).send({ action: "FORWARD", dispatchDate: "2026-09-01" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.siblingsNotReady).toHaveLength(1);
    expect(blocked.body.details.siblingsNotReady[0]).toMatchObject({ combinedLotId: lotB.id, productName: "Medicine B", currentStageId: "IPQC" });

    const overridden = await request(app)
      .patch(`/api/combined-lots/${lotA.id}/stage`)
      .set(authHeader(tokens.dispatch))
      .send({ action: "FORWARD", dispatchDate: "2026-09-01", confirmPartialDispatch: true });
    expect(overridden.status).toBe(200);
    expect(overridden.body.currentStageId).toBe("DISPATCH_PLAN");
  });
});

// Certificate of Analysis — matches "COA format.docx" item for item:
// per-test-parameter results (a full replace each save) plus the doc's
// three sequential sign-offs.
describe("Certificate of Analysis — /coa/results and /coa/sign", () => {
  it("PUT /coa/results is QA-only and fully replaces the test list each save", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const itemId = await createApprovedPoItem(bdToken);
    const lot = await createFreshCombinedLot(itemId, tokens);

    const denied = await request(app)
      .put(`/api/combined-lots/${lot.id}/coa/results`)
      .set(authHeader(tokens.store))
      .send({ results: [{ testName: "Moisture", specification: "NMT 7% (w/w)", observation: "5.2%" }] });
    expect(denied.status).toBe(403);

    const first = await request(app)
      .put(`/api/combined-lots/${lot.id}/coa/results`)
      .set(authHeader(tokens.qa))
      .send({
        results: [
          { testName: "Description", specification: "Brown colour free flowing powder", observation: "Conforms" },
          { testName: "Moisture", specification: "NMT 7% (w/w)", observation: "5.2%" },
        ],
      });
    expect(first.status).toBe(200);
    expect(first.body.coaResults).toHaveLength(2);
    expect(first.body.coaResults[0]).toMatchObject({ testName: "Description", sortOrder: 0 });

    const second = await request(app)
      .put(`/api/combined-lots/${lot.id}/coa/results`)
      .set(authHeader(tokens.qa))
      .send({ results: [{ testName: "pH (10% aqua. sol.)", specification: "4.5-7.5", observation: "6.1" }] });
    expect(second.status).toBe(200);
    expect(second.body.coaResults).toHaveLength(1);
  });

  it("POST /coa/sign enforces Analyzed -> Reviewed -> Approved order, each settable once", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const itemId = await createApprovedPoItem(bdToken);
    const lot = await createFreshCombinedLot(itemId, tokens);

    const reviewTooSoon = await request(app).post(`/api/combined-lots/${lot.id}/coa/sign`).set(authHeader(tokens.qa)).send({ step: "REVIEWED" });
    expect(reviewTooSoon.status).toBe(409);

    const analyzed = await request(app).post(`/api/combined-lots/${lot.id}/coa/sign`).set(authHeader(tokens.qa)).send({ step: "ANALYZED" });
    expect(analyzed.status).toBe(200);
    expect(analyzed.body.coaAnalyzedById).toBeTruthy();

    const reAnalyze = await request(app).post(`/api/combined-lots/${lot.id}/coa/sign`).set(authHeader(tokens.qa)).send({ step: "ANALYZED" });
    expect(reAnalyze.status).toBe(409);

    const reviewed = await request(app).post(`/api/combined-lots/${lot.id}/coa/sign`).set(authHeader(tokens.qa)).send({ step: "REVIEWED" });
    expect(reviewed.status).toBe(200);

    const approved = await request(app).post(`/api/combined-lots/${lot.id}/coa/sign`).set(authHeader(tokens.qa)).send({ step: "APPROVED" });
    expect(approved.status).toBe(200);
    expect(approved.body.coaApprovedById).toBeTruthy();
  });

  it("saves the COA's final verdict (Complies/Does Not Comply) via the BULK_QC field form, separate from bulkQcStatus", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const { token: adminToken } = await createUser(["ADMIN"]);
    const itemId = await createApprovedPoItem(bdToken);
    const lot = await createFreshCombinedLot(itemId, tokens);
    await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "BULK_QC" });

    const saved = await request(app)
      .patch(`/api/combined-lots/${lot.id}/stage`)
      .set(authHeader(tokens.qa))
      .send({ action: "FORWARD", bulkQcStatus: "Approved", coaResult: "Complies", coaRemark: "All parameters within specification." });
    expect(saved.status).toBe(200);
    expect(saved.body.coaResult).toBe("Complies");
  });

  // Production Process Flow.docx tags Bulk QC Sampling & Testing (which
  // COA is part of) as R&D's own work — RND gets the same access QA_QC
  // already has here, added alongside it, not replacing it.
  it("RND can also carry out Bulk QC — save COA results, sign off, and forward the BULK_QC stage", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { token: rndToken } = await createUser(["RND"]);
    const itemId = await createApprovedPoItem(bdToken);
    const lot = await createFreshCombinedLot(itemId, tokens);
    await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "BULK_QC" });

    const results = await request(app)
      .put(`/api/combined-lots/${lot.id}/coa/results`)
      .set(authHeader(rndToken))
      .send({ results: [{ testName: "Moisture", specification: "NMT 7% (w/w)", observation: "5.2%" }] });
    expect(results.status).toBe(200);

    const analyzed = await request(app).post(`/api/combined-lots/${lot.id}/coa/sign`).set(authHeader(rndToken)).send({ step: "ANALYZED" });
    expect(analyzed.status).toBe(200);

    const forwarded = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(rndToken)).send({ action: "FORWARD", bulkQcStatus: "Approved" });
    expect(forwarded.status).toBe(200);
    expect(forwarded.body.currentStageId).toBe("PACKAGING");
  });
});

describe("PATCH /api/combined-lots/:id/checklist", () => {
  it("Line Clearance (bulk mfg): Production owns the dept column instead of Store", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const itemId = await createApprovedPoItem(bdToken);
    const lot = await createFreshCombinedLot(itemId, tokens);

    const fresh = await request(app).get(`/api/combined-lots/${lot.id}`).set(authHeader(tokens.production));
    expect(fresh.body.lineClearanceChecklist).toHaveLength(7);
    const bulkKey = fresh.body.lineClearanceChecklist[0].itemKey as string;

    const storeDenied = await request(app).patch(`/api/combined-lots/${lot.id}/checklist`).set(authHeader(tokens.store)).send({ column: "DEPT", items: [{ itemKey: bulkKey, ok: true }] });
    expect(storeDenied.status).toBe(403);

    const productionChecked = await request(app).patch(`/api/combined-lots/${lot.id}/checklist`).set(authHeader(tokens.production)).send({ column: "DEPT", items: [{ itemKey: bulkKey, ok: true }] });
    expect(productionChecked.status).toBe(200);
    const bulkRow = productionChecked.body.lineClearanceChecklist.find((r: { itemKey: string }) => r.itemKey === bulkKey);
    expect(bulkRow).toMatchObject({ deptOk: true, qaOk: null });

    await request(app).patch(`/api/combined-lots/${lot.id}/checklist`).set(authHeader(tokens.qa)).send({ column: "QA", items: [{ itemKey: bulkKey, ok: true }] });
    const final = await request(app).get(`/api/combined-lots/${lot.id}`).set(authHeader(tokens.store));
    const finalRow = final.body.lineClearanceChecklist.find((r: { itemKey: string }) => r.itemKey === bulkKey);
    expect(finalRow).toMatchObject({ deptOk: true, qaOk: true });
  });
});

describe("PATCH /api/combined-lots/:id/stage — admin JUMP", () => {
  it("is restricted to ADMIN and moves the lot straight to any stage, bypassing the normal sequence", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const itemId = await createApprovedPoItem(bdToken);
    const lot = await createFreshCombinedLot(itemId, tokens);

    const denied = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(tokens.store)).send({ action: "JUMP", targetStageId: "PACKAGING" });
    expect(denied.status).toBe(403);

    const { token: adminToken } = await createUser(["ADMIN"]);
    const jumped = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "PACKAGING", note: "Correcting a stuck lot." });
    expect(jumped.status).toBe(200);
    expect(jumped.body.currentStageId).toBe("PACKAGING");
    expect(jumped.body.stageEvents.at(-1)).toMatchObject({ action: "JUMP", fromStageId: "IPQC", toStageId: "PACKAGING" });
  });
});

describe("GET /api/combined-lots/:id/export.pdf", () => {
  it("is restricted to ADMIN and only available once the lot reaches Dispatch Plan", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const itemId = await createApprovedPoItem(bdToken);
    const lot = await createFreshCombinedLot(itemId, tokens);

    const { token: adminToken } = await createUser(["ADMIN"]);
    const tooEarly = await request(app).get(`/api/combined-lots/${lot.id}/export.pdf`).set(authHeader(adminToken));
    expect(tooEarly.status).toBe(400);

    const notAdmin = await request(app).get(`/api/combined-lots/${lot.id}/export.pdf`).set(authHeader(tokens.production));
    expect(notAdmin.status).toBe(403);

    await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "DISPATCH_PLAN" });

    const exported = await request(app).get(`/api/combined-lots/${lot.id}/export.pdf`).set(authHeader(adminToken));
    expect(exported.status).toBe(200);
    expect(exported.headers["content-type"]).toBe("application/pdf");
  });
});

// Billing/Dispatch Plan traceability link — closes the gap where these
// stages duplicated the real Inventory-side record (an FG dispatch
// transfer) instead of pointing at it.
describe("PATCH /api/combined-lots/:id/stage — cross-module traceability link", () => {
  it("links Billing/Dispatch Plan to a real FG DispatchTransfer, and rejects a BILL-type transfer", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const { token: adminToken } = await createUser(["ADMIN"]);
    const itemId = await createApprovedPoItem(bdToken);
    const lot = await createFreshCombinedLot(itemId, tokens);
    const lotDetail = await request(app).get(`/api/combined-lots/${lot.id}`).set(authHeader(tokens.accounts));
    const customerId = lotDetail.body.preProduction.purchaseOrderItem.purchaseOrder.customer.id;

    const fgTransfer = await request(app)
      .post("/api/inventory/dispatch-transfers")
      .set(authHeader(tokens.store))
      .send({ type: "FG", date: "2026-08-01", customerId, productName: "Medicine A", quantity: 100 });
    const billTransfer = await request(app)
      .post("/api/inventory/dispatch-transfers")
      .set(authHeader(tokens.store))
      .send({ type: "BILL", date: "2026-08-01", customerId, productName: "Medicine A", quantity: 100 });

    await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "BILLING_EWAY_BILL" });

    const wrongType = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(tokens.accounts)).send({ action: "FORWARD", dispatchTransferId: billTransfer.body.id });
    expect(wrongType.status).toBe(400);

    const billed = await request(app)
      .patch(`/api/combined-lots/${lot.id}/stage`)
      .set(authHeader(tokens.accounts))
      .send({ action: "FORWARD", invoiceNo: "INV-LINK-1", dispatchTransferId: fgTransfer.body.id });
    expect(billed.status).toBe(200);
    expect(billed.body.dispatchTransferId).toBe(fgTransfer.body.id);
    expect(billed.body.dispatchTransfer.productName).toBe("Medicine A");

    const dispatched = await request(app)
      .patch(`/api/combined-lots/${lot.id}/stage`)
      .set(authHeader(tokens.dispatch))
      .send({ action: "FORWARD", dispatchDate: "2026-08-02", dispatchTransferId: fgTransfer.body.id });
    expect(dispatched.status).toBe(200);
    expect(dispatched.body.dispatchTransferId).toBe(fgTransfer.body.id);
  });
});
