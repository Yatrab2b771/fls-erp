import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

/** Creates a customer + PO (DRAFT), approves it as BD, and returns its one line item's id. */
async function createApprovedPoItem(bdToken: string) {
  const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });
  const po = await request(app)
    .post("/api/purchase-orders")
    .set(authHeader(bdToken))
    .send({ customerId: customer.body.id, items: [{ productName: "Medicine A", quantity: 100, unit: "KG" }] });
  await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
  return po.body.items[0].id as string;
}

describe("POST /api/batches", () => {
  it("is restricted to PPIC, requires an approved PO, validates the line item exists, and starts at PO_RELEASE", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Draft Co." });
    const draftPo = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.body.id, items: [{ productName: "Medicine A", quantity: 100, unit: "KG" }] });
    const draftItemId = draftPo.body.items[0].id;

    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);

    const denied = await request(app).post("/api/batches").set(authHeader(storeToken)).send({ purchaseOrderItemId: draftItemId });
    expect(denied.status).toBe(403);

    // PPIC, but the PO is still DRAFT — blocked until BD approves it.
    const notApproved = await request(app).post("/api/batches").set(authHeader(ppicToken)).send({ purchaseOrderItemId: draftItemId });
    expect(notApproved.status).toBe(400);

    const badItem = await request(app).post("/api/batches").set(authHeader(ppicToken)).send({ purchaseOrderItemId: "00000000-0000-0000-0000-000000000000" });
    expect(badItem.status).toBe(400);

    const itemId = await createApprovedPoItem(bdToken);
    const created = await request(app).post("/api/batches").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId, batchNo: "B-001" });
    expect(created.status).toBe(201);
    expect(created.body.currentStageId).toBe("PO_RELEASE");
    expect(created.body.stageEvents).toHaveLength(0);
  });
});

describe("PATCH /api/batches/:id/stage — full forward walk", () => {
  it("walks a batch from PO Release through Dispatch Plan, each stage gated to its department, fields persisted along the way", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemId = await createApprovedPoItem(bdToken);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const batch = await request(app).post("/api/batches").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    const batchId = batch.body.id;

    const { token: purchaseToken } = await createUser(["PURCHASE"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: accountsToken } = await createUser(["ACCOUNTS"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: dispatchToken } = await createUser(["DISPATCH"]);

    // PO_RELEASE — Purchase. Wrong department blocked, right one forwards with fields.
    const wrongDept = await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD" });
    expect(wrongDept.status).toBe(403);

    const poRelease = await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(purchaseToken)).send({ action: "FORWARD", rmStatus: "Available", pmStatus: "Available" });
    expect(poRelease.status).toBe(200);
    expect(poRelease.body.currentStageId).toBe("MATERIAL_RECEIVED");
    expect(poRelease.body.rmStatus).toBe("Available");

    // MATERIAL_RECEIVED (covers material receipt + GRN) — Store, status-only.
    const materialReceived = await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD" });
    expect(materialReceived.body.currentStageId).toBe("INDENT_ISSUE");

    // INDENT_ISSUE — PPIC. Also carries the former Production Plan fields.
    const indentIssue = await request(app)
      .patch(`/api/batches/${batchId}/stage`)
      .set(authHeader(ppicToken))
      .send({ action: "FORWARD", prodIndentSlipSign: "PPIC-IND-1", productionPlanDate: "2026-08-01", unit: "41" });
    expect(indentIssue.body.currentStageId).toBe("DISPENSING");
    expect(indentIssue.body.prodIndentSlipSign).toBe("PPIC-IND-1");

    // DISPENSING — Store.
    const dispensing = await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD", rmDispensingDate: "2026-08-02" });
    expect(dispensing.body.currentStageId).toBe("PRODUCTION_EXECUTION");

    // PRODUCTION_EXECUTION — Production.
    const productionExecution = await request(app)
      .patch(`/api/batches/${batchId}/stage`)
      .set(authHeader(productionToken))
      .send({ action: "FORWARD", manufacturingStartDate: "2026-08-03", manufacturingEndDate: "2026-08-05" });
    expect(productionExecution.body.currentStageId).toBe("QA_GATE_MFG");

    // QA_GATE_MFG — QA_QC.
    const qaGateMfg = await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", mfgQaStatus: "Approved", mfgQcStatus: "Approved" });
    expect(qaGateMfg.body.currentStageId).toBe("PACKAGING");

    // PACKAGING — Production.
    const packaging = await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(productionToken)).send({ action: "FORWARD", packagingEndDate: "2026-08-06" });
    expect(packaging.body.currentStageId).toBe("QA_GATE_PACKAGING");

    // QA_GATE_PACKAGING — QA_QC. "Hold" isn't a valid value at this gate (no Hold option here).
    const badPackQa = await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", packQaStatus: "Hold" });
    expect(badPackQa.status).toBe(400);

    const qaGatePackaging = await request(app)
      .patch(`/api/batches/${batchId}/stage`)
      .set(authHeader(qaToken))
      .send({ action: "FORWARD", packQaStatus: "Approved", packQcStatus: "Approved" });
    expect(qaGatePackaging.body.currentStageId).toBe("BILLING_EWAY_BILL");

    // BILLING_EWAY_BILL — Accounts, status-only.
    const billingEwayBill = await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(accountsToken)).send({ action: "FORWARD" });
    expect(billingEwayBill.body.currentStageId).toBe("DISPATCH_PLAN");

    // DISPATCH_PLAN — Dispatch. Terminal.
    const dispatchDenied = await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD" });
    expect(dispatchDenied.status).toBe(403);

    const dispatchPlan = await request(app)
      .patch(`/api/batches/${batchId}/stage`)
      .set(authHeader(dispatchToken))
      .send({ action: "FORWARD", dispatchDate: "2026-08-07", customerConfirmation: "Received" });
    expect(dispatchPlan.status).toBe(200);
    expect(dispatchPlan.body.currentStageId).toBe("DISPATCH_PLAN"); // the last stage — completes in place
    expect(dispatchPlan.body.dispatchDate).toBeTruthy();

    // Dispatch Plan is terminal but not a dead end — Dispatch can still
    // amend its own fields afterwards (e.g. correcting a shipper qty typo).
    const amend = await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(dispatchToken)).send({ action: "FORWARD", remainingQty: 0 });
    expect(amend.status).toBe(200);
    expect(amend.body.currentStageId).toBe("DISPATCH_PLAN");

    expect(dispatchPlan.body.stageEvents.length).toBeGreaterThan(6);
  });
});

describe("Wastage & quality rejection — Production Execution / QA Gate Mfg", () => {
  it("Production logs input/output at Production Execution; the batch response carries the derived wastage", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemId = await createApprovedPoItem(bdToken);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const batch = await request(app).post("/api/batches").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    await request(app).patch(`/api/batches/${batch.body.id}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "PRODUCTION_EXECUTION" });

    // Before input/output are recorded, wastage is null, not zero.
    const beforeRes = await request(app).get(`/api/batches/${batch.body.id}`).set(authHeader(productionToken));
    expect(beforeRes.body.wastage).toEqual({ wastageQty: null, wastagePct: null });

    const logged = await request(app)
      .patch(`/api/batches/${batch.body.id}/stage`)
      .set(authHeader(productionToken))
      .send({ action: "FORWARD", manufacturingStartDate: "2026-08-03", manufacturingEndDate: "2026-08-05", inputQty: 100, outputQty: 99.9 });
    expect(logged.status).toBe(200);
    expect(logged.body.inputQty).toBe(100);
    expect(logged.body.outputQty).toBe(99.9);
    expect(logged.body.wastage).toEqual({ wastageQty: 0.1, wastagePct: 0.1 });
  });

  it("QC logs a quality rejection at QA Gate Mfg, independent of wastage", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemId = await createApprovedPoItem(bdToken);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const batch = await request(app).post("/api/batches").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    await request(app).patch(`/api/batches/${batch.body.id}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "QA_GATE_MFG" });

    const reviewed = await request(app)
      .patch(`/api/batches/${batch.body.id}/stage`)
      .set(authHeader(qaToken))
      .send({ action: "FORWARD", mfgQaStatus: "Approved", mfgQcStatus: "Approved", mfgRejectedQty: 0.5 });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.mfgRejectedQty).toBe(0.5);
    // Rejection is its own number — this stage never touches input/output/wastage.
    expect(reviewed.body.wastage).toEqual({ wastageQty: null, wastagePct: null });
  });
});

describe("PATCH /api/batches/:id/stage — send back", () => {
  it("requires a note, is gated to the current stage's department, and returns the batch to the previous stage", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemId = await createApprovedPoItem(bdToken);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const batch = await request(app).post("/api/batches").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    const batchId = batch.body.id;

    const { token: purchaseToken } = await createUser(["PURCHASE"]);
    const { token: storeToken } = await createUser(["STORE"]);

    await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(purchaseToken)).send({ action: "FORWARD" });
    // Now at MATERIAL_RECEIVED (Store).

    const wrongDept = await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(purchaseToken)).send({ action: "REJECT", note: "not mine" });
    expect(wrongDept.status).toBe(403);

    const noNote = await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(storeToken)).send({ action: "REJECT" });
    expect(noNote.status).toBe(400);

    const rejected = await request(app)
      .patch(`/api/batches/${batchId}/stage`)
      .set(authHeader(storeToken))
      .send({ action: "REJECT", note: "PO details look wrong, please recheck vendor terms." });
    expect(rejected.status).toBe(200);
    expect(rejected.body.currentStageId).toBe("PO_RELEASE"); // back to the previous stage
    expect(rejected.body.stageEvents.at(-1).action).toBe("REJECT");
    expect(rejected.body.stageEvents.at(-1).note).toMatch(/vendor terms/);
  });

  it("has nothing to send back from the very first stage", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemId = await createApprovedPoItem(bdToken);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const batch = await request(app).post("/api/batches").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });

    const { token: purchaseToken } = await createUser(["PURCHASE"]);
    const res = await request(app).patch(`/api/batches/${batch.body.id}/stage`).set(authHeader(purchaseToken)).send({ action: "REJECT", note: "n/a" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/batches/:id/stage — admin JUMP", () => {
  it("is restricted to ADMIN and moves the batch straight to any stage, bypassing the normal sequence", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemId = await createApprovedPoItem(bdToken);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const batch = await request(app).post("/api/batches").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    const batchId = batch.body.id;

    // A department that owns the current stage still can't jump — only ADMIN can.
    const { token: purchaseToken } = await createUser(["PURCHASE"]);
    const denied = await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(purchaseToken)).send({ action: "JUMP", targetStageId: "PACKAGING" });
    expect(denied.status).toBe(403);

    const { token: adminToken } = await createUser(["ADMIN"]);
    const missingTarget = await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(adminToken)).send({ action: "JUMP" });
    expect(missingTarget.status).toBe(400);

    const jumped = await request(app)
      .patch(`/api/batches/${batchId}/stage`)
      .set(authHeader(adminToken))
      .send({ action: "JUMP", targetStageId: "PACKAGING", note: "Correcting a stuck batch." });
    expect(jumped.status).toBe(200);
    expect(jumped.body.currentStageId).toBe("PACKAGING");
    expect(jumped.body.stageEvents.at(-1).action).toBe("JUMP");
    expect(jumped.body.stageEvents.at(-1).fromStageId).toBe("PO_RELEASE");
    expect(jumped.body.stageEvents.at(-1).toStageId).toBe("PACKAGING");
  });
});

describe("GET /api/batches/:id/export.pdf", () => {
  it("is restricted to ADMIN and only available once the batch reaches Dispatch Plan", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemId = await createApprovedPoItem(bdToken);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const batch = await request(app).post("/api/batches").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    const batchId = batch.body.id;

    const { token: adminToken } = await createUser(["ADMIN"]);
    const tooEarly = await request(app).get(`/api/batches/${batchId}/export.pdf`).set(authHeader(adminToken));
    expect(tooEarly.status).toBe(400);

    const notAdmin = await request(app).get(`/api/batches/${batchId}/export.pdf`).set(authHeader(ppicToken));
    expect(notAdmin.status).toBe(403);

    // Admin JUMP straight to Dispatch Plan, then export.
    await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "DISPATCH_PLAN" });

    const exported = await request(app).get(`/api/batches/${batchId}/export.pdf`).set(authHeader(adminToken));
    expect(exported.status).toBe(200);
    expect(exported.headers["content-type"]).toBe("application/pdf");
  });
});
