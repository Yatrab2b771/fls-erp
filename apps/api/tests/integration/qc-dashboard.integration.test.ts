import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

async function createApprovedPoItem(bdToken: string) {
  const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });
  const po = await request(app)
    .post("/api/purchase-orders")
    .set(authHeader(bdToken))
    .send({ customerId: customer.body.id, items: [{ productName: "Medicine A", quantity: 100, unit: "KG" }] });
  await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
  return po.body.items[0].id as string;
}

/** Walks a PreProduction run to Sample QC Approval, then a ProductionBatch through to completion — returns the auto-created CombinedLot. */
async function createFreshCombinedLot(itemId: string, tokens: { production: string; admin: string }) {
  const run = (await request(app).post("/api/pre-productions").set(authHeader(tokens.production)).send({ purchaseOrderItemId: itemId })).body;
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.admin)).send({ action: "JUMP", targetStageId: "SAMPLE_QC_APPROVAL" });
  // JUMP only moves currentStageId — Production can't start until
  // sampleQcStatus is literally "Approved" too (see
  // production-batches.routes.ts's own gate). ADMIN bypasses the stage's
  // own department check, same as JUMP does.
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.admin)).send({ action: "FORWARD", sampleQcStatus: "Approved" });
  const pb = (await request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(tokens.production)).send({ plannedQty: 100 })).body;
  await request(app).patch(`/api/production-batches/${pb.id}`).set(authHeader(tokens.production)).send({ outputQty: 100 });
  const completed = await request(app).post(`/api/production-batches/${pb.id}/complete`).set(authHeader(tokens.production));
  return completed.body.combinedLot as { id: string };
}

// One aggregate view over every QC checkpoint — see qc.routes.ts. Nothing
// here is new data (every row is one already reachable via the Inventory,
// PreProduction, or CombinedLot endpoints); this just counts and lists
// what's pending/on hold.
describe("GET /api/qc/dashboard", () => {
  it("is restricted to QA_QC (ADMIN bypasses)", async () => {
    const { token: plainToken } = await createUser([]);
    const denied = await request(app).get("/api/qc/dashboard").set(authHeader(plainToken));
    expect(denied.status).toBe(403);

    const { token: qaToken } = await createUser(["QA_QC"]);
    const ok = await request(app).get("/api/qc/dashboard").set(authHeader(qaToken));
    expect(ok.status).toBe(200);
    expect(ok.body.counts).toBeTruthy();
  });

  it("counts pending and held rows across Material Received and FG Dispatch", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const { token: bdToken } = await createUser(["BD"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });

    // One receipt left pending, one held.
    const pendingReceipt = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 10 });
    const heldReceipt = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 20 });
    await request(app).patch(`/api/inventory/transactions/${heldReceipt.body.id}/qc`).set(authHeader(qaToken)).send({ action: "HOLD", note: "Checking vendor COA" });

    // One dispatch transfer left pending, one held.
    const pendingDispatch = await request(app)
      .post("/api/inventory/dispatch-transfers")
      .set(authHeader(storeToken))
      .send({ type: "FG", date: "2026-08-10", customerId: customer.body.id, productName: "Whey Protein 1Kg Jar", quantity: 50 });
    const heldDispatch = await request(app)
      .post("/api/inventory/dispatch-transfers")
      .set(authHeader(storeToken))
      .send({ type: "FG", date: "2026-08-10", customerId: customer.body.id, productName: "Whey Protein 1Kg Jar", quantity: 60 });
    await request(app).patch(`/api/inventory/dispatch-transfers/${heldDispatch.body.id}/qc`).set(authHeader(qaToken)).send({ action: "HOLD", note: "Confirming batch traceability" });

    const dashboard = await request(app).get("/api/qc/dashboard").set(authHeader(qaToken));
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.counts.pendingReceiptQc).toBe(1);
    expect(dashboard.body.counts.onHoldReceiptQc).toBe(1);
    expect(dashboard.body.counts.pendingDispatchQc).toBe(1);
    expect(dashboard.body.counts.onHoldDispatchQc).toBe(1);
    expect(dashboard.body.counts.onHoldTotal).toBeGreaterThanOrEqual(2);
    expect(dashboard.body.receipts.pending.map((r: { id: string }) => r.id)).toEqual([pendingReceipt.body.id]);
    expect(dashboard.body.receipts.onHold.map((r: { id: string }) => r.id)).toEqual([heldReceipt.body.id]);
    expect(dashboard.body.dispatches.pending.map((d: { id: string }) => d.id)).toEqual([pendingDispatch.body.id]);
    expect(dashboard.body.dispatches.onHold.map((d: { id: string }) => d.id)).toEqual([heldDispatch.body.id]);
  });

  it("counts a lot held at a QA gate, but not once it's since advanced past that gate — the leftover \"Hold\" string doesn't get miscounted", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemIdHeld = await createApprovedPoItem(bdToken);
    const itemIdResolved = await createApprovedPoItem(bdToken);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const tokens = { production: productionToken, admin: adminToken };

    const lotHeld = await createFreshCombinedLot(itemIdHeld, tokens);
    const lotResolved = await createFreshCombinedLot(itemIdResolved, tokens);
    await request(app).patch(`/api/combined-lots/${lotHeld.id}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "QA_GATE_MFG" });
    await request(app).patch(`/api/combined-lots/${lotResolved.id}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "QA_GATE_MFG" });

    // One stays held.
    await request(app).patch(`/api/combined-lots/${lotHeld.id}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", mfgQaStatus: "Hold", mfgQcStatus: "Hold" });
    // The other is held, then resolved and moves on — leaving a stale
    // "Hold" string on a row no longer at QA_GATE_MFG.
    await request(app).patch(`/api/combined-lots/${lotResolved.id}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", mfgQaStatus: "Hold", mfgQcStatus: "Hold" });
    const resolved = await request(app)
      .patch(`/api/combined-lots/${lotResolved.id}/stage`)
      .set(authHeader(qaToken))
      .send({ action: "FORWARD", mfgQaStatus: "Approved", mfgQcStatus: "Approved" });
    expect(resolved.body.currentStageId).toBe("BULK_QC"); // moved on — the point is it's no longer at QA_GATE_MFG

    const dashboard = await request(app).get("/api/qc/dashboard").set(authHeader(qaToken));
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.counts.onHoldMfgBatches).toBe(1);
    expect(dashboard.body.batches.onHoldMfg.map((b: { id: string }) => b.id)).toEqual([lotHeld.id]);
  });

  // Closes the gap the client hit: the pipeline itself already blocks
  // manufacturing until QC actually Approves the sample, but nothing on
  // this dashboard ever mentioned it — a run could sit there needing
  // QC's attention with no visible queue for it.
  it("lists every run sitting at Sample QC Approval — even one with no status set yet, not just an explicit Hold", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemId = await createApprovedPoItem(bdToken);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { token: qaToken } = await createUser(["QA_QC"]);

    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    await request(app).patch(`/api/pre-productions/${run.body.id}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "SAMPLE_QC_APPROVAL" });

    const freshlyArrived = await request(app).get("/api/qc/dashboard").set(authHeader(qaToken));
    expect(freshlyArrived.body.counts.pendingSampleQcBatches).toBe(1);
    expect(freshlyArrived.body.batches.pendingSampleQc.map((b: { id: string }) => b.id)).toEqual([run.body.id]);

    // Once QC actually Approves it, it drops out of the queue — same
    // "scoped to current stage" rule as the QA gates. (The run itself
    // stays at SAMPLE_QC_APPROVAL — it's this tier's own terminal stage —
    // but Approved is no longer "pending".)
    await request(app).patch(`/api/pre-productions/${run.body.id}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", sampleQcStatus: "Approved" });
    const afterApproval = await request(app).get("/api/qc/dashboard").set(authHeader(qaToken));
    expect(afterApproval.body.counts.pendingSampleQcBatches).toBe(0);
    expect(afterApproval.body.batches.pendingSampleQc).toEqual([]);
  });

  // Same rule, extended to Line Clearance (PreProduction) and IPQC/Bulk QC
  // (CombinedLot) — the three extra QC checkpoints added against the
  // client's Production Process Flow doc.
  it("lists every run/lot sitting at Line Clearance, IPQC, or Bulk QC too", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemLc = await createApprovedPoItem(bdToken);
    const itemIpqc = await createApprovedPoItem(bdToken);
    const itemBulk = await createApprovedPoItem(bdToken);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const tokens = { production: productionToken, admin: adminToken };

    const runLc = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemLc });
    await request(app).patch(`/api/pre-productions/${runLc.body.id}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "LINE_CLEARANCE" });

    const lotIpqc = await createFreshCombinedLot(itemIpqc, tokens); // already sits at IPQC — no JUMP needed
    const lotBulk = await createFreshCombinedLot(itemBulk, tokens);
    await request(app).patch(`/api/combined-lots/${lotBulk.id}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "BULK_QC" });

    const dashboard = await request(app).get("/api/qc/dashboard").set(authHeader(qaToken));
    expect(dashboard.body.counts.pendingLineClearanceBatches).toBe(1);
    expect(dashboard.body.counts.pendingIpqcBatches).toBe(1);
    expect(dashboard.body.counts.pendingBulkQcBatches).toBe(1);
    expect(dashboard.body.batches.pendingLineClearance.map((b: { id: string }) => b.id)).toEqual([runLc.body.id]);
    expect(dashboard.body.batches.pendingIpqc.map((b: { id: string }) => b.id)).toEqual([lotIpqc.id]);
    expect(dashboard.body.batches.pendingBulkQc.map((b: { id: string }) => b.id)).toEqual([lotBulk.id]);
  });
});
