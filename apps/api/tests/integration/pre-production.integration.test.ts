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

describe("POST /api/pre-productions", () => {
  it("is restricted to Production alone — PPIC gets no part of it, not even against an approved PO — requires an approved PO, validates the line item exists, plannedQty defaults to the item's own ordered quantity, and starts at MATERIAL_RECEIVED", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Draft Co." });
    const draftPo = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.body.id, items: [{ productName: "Medicine A", quantity: 100, unit: "KG" }] });
    const draftItemId = draftPo.body.items[0].id;

    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: storeToken } = await createUser(["STORE"]);

    const deniedStore = await request(app).post("/api/pre-productions").set(authHeader(storeToken)).send({ purchaseOrderItemId: draftItemId });
    expect(deniedStore.status).toBe(403);

    // PPIC no longer has any part in production creation — not even a 400
    // on a draft PO tells it anything; it's flatly 403, same as any other
    // outside department.
    const itemId = await createApprovedPoItem(bdToken);
    const deniedPpic = await request(app).post("/api/pre-productions").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    expect(deniedPpic.status).toBe(403);

    // Production, but the PO is still DRAFT — blocked until BD approves it.
    const notApproved = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: draftItemId });
    expect(notApproved.status).toBe(400);

    const badItem = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: "00000000-0000-0000-0000-000000000000" });
    expect(badItem.status).toBe(400);

    const created = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    expect(created.status).toBe(201);
    expect(created.body.currentStageId).toBe("MATERIAL_RECEIVED");
    expect(created.body.plannedQty).toBe(100); // the item's own ordered quantity — no manual split at this tier any more
    expect(created.body.combinedQty).toBe(0);
    expect(created.body.remainingQty).toBe(100);
    expect(created.body.stageEvents).toHaveLength(0);

    // A second run against the same item is refused — one PreProduction per PO item.
    const again = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    expect(again.status).toBe(409);
  });
});

// Checklist — matches BMR-1.docx's real paper form item for item, with a
// Store column and a QA column. See batch-checklists.ts for the fixed
// item set.
describe("PATCH /api/pre-productions/:id/checklist", () => {
  it("Line Clearance (dispensing): starts as 7 unchecked rows, each side can only fill in its own column, and rejects an unknown item key", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemId = await createApprovedPoItem(bdToken);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    const runId = run.body.id;

    expect(run.body.lineClearanceChecklist).toHaveLength(7);
    expect(run.body.lineClearanceChecklist.every((r: { deptOk: unknown; qaOk: unknown }) => r.deptOk === null && r.qaOk === null)).toBe(true);
    const firstKey = run.body.lineClearanceChecklist[0].itemKey as string;

    // Store can't fill in the QA column and vice versa.
    const storeDeniedQa = await request(app).patch(`/api/pre-productions/${runId}/checklist`).set(authHeader(storeToken)).send({ column: "QA", items: [{ itemKey: firstKey, ok: true }] });
    expect(storeDeniedQa.status).toBe(403);
    const qaDeniedDept = await request(app).patch(`/api/pre-productions/${runId}/checklist`).set(authHeader(qaToken)).send({ column: "DEPT", items: [{ itemKey: firstKey, ok: true }] });
    expect(qaDeniedDept.status).toBe(403);

    // An unknown item key is rejected before anything is written.
    const badKey = await request(app).patch(`/api/pre-productions/${runId}/checklist`).set(authHeader(storeToken)).send({ column: "DEPT", items: [{ itemKey: "not_a_real_item", ok: true }] });
    expect(badKey.status).toBe(400);

    // Store checks off the first item; QA independently checks it off too.
    const storeChecked = await request(app).patch(`/api/pre-productions/${runId}/checklist`).set(authHeader(storeToken)).send({ column: "DEPT", items: [{ itemKey: firstKey, ok: true }] });
    expect(storeChecked.status).toBe(200);
    const firstRowAfterStore = storeChecked.body.lineClearanceChecklist.find((r: { itemKey: string }) => r.itemKey === firstKey);
    expect(firstRowAfterStore).toMatchObject({ deptOk: true, qaOk: null });

    const qaChecked = await request(app).patch(`/api/pre-productions/${runId}/checklist`).set(authHeader(qaToken)).send({ column: "QA", items: [{ itemKey: firstKey, ok: true }] });
    expect(qaChecked.status).toBe(200);
    const firstRowAfterQa = qaChecked.body.lineClearanceChecklist.find((r: { itemKey: string }) => r.itemKey === firstKey);
    expect(firstRowAfterQa).toMatchObject({ deptOk: true, qaOk: true }); // Store's earlier check survived

    // The other 6 rows are untouched.
    const untouched = qaChecked.body.lineClearanceChecklist.filter((r: { itemKey: string }) => r.itemKey !== firstKey);
    expect(untouched.every((r: { deptOk: unknown; qaOk: unknown }) => r.deptOk === null && r.qaOk === null)).toBe(true);
  });
});

describe("PATCH /api/pre-productions/:id/stage — full forward walk", () => {
  it("walks a run from Material Received through Sample QC Approval, each stage gated to its department, fields persisted along the way, and completes in place at the terminal stage", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemId = await createApprovedPoItem(bdToken);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    const runId = run.body.id;

    const { token: purchaseToken } = await createUser(["PURCHASE"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const { token: ppicToken } = await createUser(["PPIC"]);

    // MATERIAL_RECEIVED — Store. Wrong department blocked, right one forwards with fields.
    const wrongDept = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(purchaseToken)).send({ action: "FORWARD" });
    expect(wrongDept.status).toBe(403);

    const materialReceived = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD", grnNo: "GRN-9001" });
    expect(materialReceived.status).toBe(200);
    expect(materialReceived.body.currentStageId).toBe("INDENT_ISSUE");
    expect(materialReceived.body.grnNo).toBe("GRN-9001");

    // INDENT_ISSUE — PPIC. Also carries the former Production Plan fields.
    const indentIssue = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(ppicToken))
      .send({ action: "FORWARD", prodIndentSlipSign: "PPIC-IND-1", productionPlanDate: "2026-08-01", unit: "41" });
    expect(indentIssue.body.currentStageId).toBe("LINE_CLEARANCE");
    expect(indentIssue.body.prodIndentSlipSign).toBe("PPIC-IND-1");

    // LINE_CLEARANCE — QA_QC. Hard gate — must literally read Approved.
    const lineClearance = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", lineClearanceStatus: "Approved" });
    expect(lineClearance.status).toBe(200);
    expect(lineClearance.body.currentStageId).toBe("DISPENSING");

    // DISPENSING — Store.
    const dispensing = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD", rmDispensingDate: "2026-08-02" });
    expect(dispensing.body.currentStageId).toBe("SAMPLE_QC_APPROVAL");

    // SAMPLE_QC_APPROVAL — QA_QC. Anything other than a literal "Approved" parks the run here.
    const heldSampleQc = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", sampleQcStatus: "Not Approved" });
    expect(heldSampleQc.status).toBe(200);
    expect(heldSampleQc.body.currentStageId).toBe("SAMPLE_QC_APPROVAL");

    const sampleQcApproval = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", sampleQcStatus: "Approved" });
    expect(sampleQcApproval.status).toBe(200);
    // Own terminal stage — completes in place, ready for Production to start ProductionBatch runs.
    expect(sampleQcApproval.body.currentStageId).toBe("SAMPLE_QC_APPROVAL");

    // Forwarding again from here is still allowed — same "completes in
    // place, but still amendable" shape as CombinedLot's own DISPATCH_PLAN
    // terminal stage — it just re-saves in place rather than erroring.
    const amend = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", sampleQcStatus: "Approved", sampleQcRemarks: "Re-confirmed" });
    expect(amend.status).toBe(200);
    expect(amend.body.currentStageId).toBe("SAMPLE_QC_APPROVAL");

    expect(sampleQcApproval.body.stageEvents.length).toBeGreaterThan(3);
  });
});

describe("Pre-Production Plant + real-time per-Plant balance", () => {
  it("requires a Plant before Dispensing can log consumption; consumption reduces the Plant's balance against ISSUED_PRODUCTION inflow", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: storeToken } = await createUser(["STORE"]);

    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 50, isOpeningStock: true });

    // Run created with NO plant — walk it up to Dispensing.
    const itemId1 = await createApprovedPoItem(bdToken);
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId1 });
    const runId = run.body.id;
    expect(run.body.plantId).toBeNull();

    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD" });
    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(ppicToken)).send({ action: "FORWARD" });
    const { token: qaTokenForClearance } = await createUser(["QA_QC"]);
    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(qaTokenForClearance)).send({ action: "FORWARD", lineClearanceStatus: "Approved" });

    const check = await request(app).get(`/api/pre-productions/${runId}`).set(authHeader(storeToken));
    expect(check.body.currentStageId).toBe("DISPENSING");

    // No plant assigned yet — logging consumption is blocked.
    const blockedNoPlant = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(storeToken))
      .send({ action: "FORWARD", consumption: [{ itemId: item.body.id, quantity: 5, unit: "Kg" }] });
    expect(blockedNoPlant.status).toBe(400);

    // Assign the plant (PPIC's call), then unknown-item consumption is rejected too.
    const plant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Plant Alpha" });
    const deniedPlantAssign = await request(app).patch(`/api/pre-productions/${runId}/plant`).set(authHeader(storeToken)).send({ plantId: plant.body.id });
    expect(deniedPlantAssign.status).toBe(403); // PPIC-only

    const assigned = await request(app).patch(`/api/pre-productions/${runId}/plant`).set(authHeader(ppicToken)).send({ plantId: plant.body.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.plant.name).toBe("Plant Alpha");

    const badItem = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(storeToken))
      .send({ action: "FORWARD", consumption: [{ itemId: "00000000-0000-0000-0000-000000000000", quantity: 5, unit: "Kg" }] });
    expect(badItem.status).toBe(400);

    // Give the plant some inflow first, via the normal Material Request -> issue flow.
    const req1 = await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId: item.body.id, category: "RM", requestedQty: 50, purpose: "ISSUED_PRODUCTION", plantId: plant.body.id });
    await request(app).patch(`/api/inventory/requests/${req1.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
    await request(app).post(`/api/inventory/requests/${req1.body.id}/issue`).set(authHeader(storeToken)).send({ date: "2026-08-22", unit: "Kg", quantity: 50, dayStoreId: null });

    const beforeConsumption = await request(app).get(`/api/inventory/plants/${plant.body.id}/stock`).set(authHeader(storeToken));
    expect(beforeConsumption.body.stock).toEqual([expect.objectContaining({ onHand: 50 })]);

    // Now log real consumption at Dispensing — this is the actual point of the feature.
    const dispensed = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(storeToken))
      .send({ action: "FORWARD", rmDispensingDate: "2026-08-22", consumption: [{ itemId: item.body.id, quantity: 18, unit: "Kg" }] });
    expect(dispensed.status).toBe(200);
    expect(dispensed.body.currentStageId).toBe("SAMPLE_QC_APPROVAL");
    expect(dispensed.body.consumptions).toHaveLength(1);
    expect(dispensed.body.consumptions[0]).toMatchObject({ itemId: item.body.id, quantity: 18, unit: "Kg" });

    const afterConsumption = await request(app).get(`/api/inventory/plants/${plant.body.id}/stock`).set(authHeader(storeToken));
    expect(afterConsumption.body.stock).toEqual([expect.objectContaining({ onHand: 32 })]); // 50 - 18
  });

  it("blocks logging more RM/PM consumption than the run's Plant has actually received, even mid-pipeline, and locks the Plant once real consumption is logged", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: storeToken } = await createUser(["STORE"]);

    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 50, isOpeningStock: true });

    const itemId1 = await createApprovedPoItem(bdToken);
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId1 });
    const runId = run.body.id;

    const plant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Plant Gamma" });
    await request(app).patch(`/api/pre-productions/${runId}/plant`).set(authHeader(ppicToken)).send({ plantId: plant.body.id });

    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD" });
    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(ppicToken)).send({ action: "FORWARD" });
    const { token: qaTokenForClearance2 } = await createUser(["QA_QC"]);
    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(qaTokenForClearance2)).send({ action: "FORWARD", lineClearanceStatus: "Approved" });

    // Only 10 Kg ever makes it to this Plant.
    const req1 = await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId: item.body.id, category: "RM", requestedQty: 10, purpose: "ISSUED_PRODUCTION", plantId: plant.body.id });
    await request(app).patch(`/api/inventory/requests/${req1.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
    await request(app).post(`/api/inventory/requests/${req1.body.id}/issue`).set(authHeader(storeToken)).send({ date: "2026-08-22", unit: "Kg", quantity: 10, dayStoreId: null });

    // Trying to log 20 Kg of consumption — more than the 10 this Plant actually has — is rejected.
    const overConsume = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(storeToken))
      .send({ action: "FORWARD", consumption: [{ itemId: item.body.id, quantity: 20, unit: "Kg" }] });
    expect(overConsume.status).toBe(409);
    expect(overConsume.body.error).toMatch(/Whey Protein/);

    // Nothing moved — run is still at DISPENSING, no consumption row was written, Plant balance is untouched.
    const stillDispensing = await request(app).get(`/api/pre-productions/${runId}`).set(authHeader(storeToken));
    expect(stillDispensing.body.currentStageId).toBe("DISPENSING");
    expect(stillDispensing.body.consumptions).toHaveLength(0);
    const plantStock = await request(app).get(`/api/inventory/plants/${plant.body.id}/stock`).set(authHeader(storeToken));
    expect(plantStock.body.stock).toEqual([expect.objectContaining({ onHand: 10 })]);

    // Exactly what's available goes through fine.
    const okConsume = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(storeToken))
      .send({ action: "FORWARD", consumption: [{ itemId: item.body.id, quantity: 10, unit: "Kg" }] });
    expect(okConsume.status).toBe(200);
    expect(okConsume.body.currentStageId).toBe("SAMPLE_QC_APPROVAL");

    // Once real consumption is logged against this Plant, it's locked.
    const otherPlant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Plant Delta" });
    const reassignBlocked = await request(app).patch(`/api/pre-productions/${runId}/plant`).set(authHeader(ppicToken)).send({ plantId: otherPlant.body.id });
    expect(reassignBlocked.status).toBe(409);
    const clearBlocked = await request(app).patch(`/api/pre-productions/${runId}/plant`).set(authHeader(ppicToken)).send({ plantId: null });
    expect(clearBlocked.status).toBe(409);

    // Re-confirming the *same* plant it's already on is a no-op, not a reassignment — that stays allowed.
    const sameSuccess = await request(app).patch(`/api/pre-productions/${runId}/plant`).set(authHeader(ppicToken)).send({ plantId: plant.body.id });
    expect(sameSuccess.status).toBe(200);
  });
});

// The Dispensing Sheet's own weighing fields — matches BMR-1.docx's
// "3.0 DISPENSING SHEET OF RAW MATERIAL" (Gross/Tare/Net weight, A.R.
// No.), plus QA's per-line "Verified By" sign-off.
describe("Dispensing Sheet — weighing fields and QA line verification", () => {
  it("logs gross/tare/A.R. No. per consumption line, derives net weight, and lets QA verify each line exactly once", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);

    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Weighing Sheet Protein" });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 50, isOpeningStock: true });

    const itemId1 = await createApprovedPoItem(bdToken);
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId1 });
    const runId = run.body.id;
    const plant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Weighing Sheet Plant" });
    await request(app).patch(`/api/pre-productions/${runId}/plant`).set(authHeader(ppicToken)).send({ plantId: plant.body.id });
    const req1 = await request(app)
      .post("/api/inventory/requests")
      .set(authHeader(ppicToken))
      .send({ itemId: item.body.id, category: "RM", requestedQty: 18, purpose: "ISSUED_PRODUCTION", plantId: plant.body.id });
    await request(app).patch(`/api/inventory/requests/${req1.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
    await request(app).post(`/api/inventory/requests/${req1.body.id}/issue`).set(authHeader(storeToken)).send({ date: "2026-08-21", unit: "Kg", quantity: 18, dayStoreId: null });

    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD" }); // -> INDENT_ISSUE
    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(ppicToken)).send({ action: "FORWARD" }); // -> LINE_CLEARANCE
    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", lineClearanceStatus: "Approved" }); // -> DISPENSING

    const dispensed = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(storeToken))
      .send({ action: "FORWARD", consumption: [{ itemId: item.body.id, quantity: 18, unit: "Kg", grossWeight: 20.5, tareWeight: 2.5, arNo: "AR-2026-0091" }] });
    expect(dispensed.status).toBe(200);
    expect(dispensed.body.consumptions).toHaveLength(1);
    const line = dispensed.body.consumptions[0];
    expect(line).toMatchObject({ grossWeight: 20.5, tareWeight: 2.5, netWeight: 18, arNo: "AR-2026-0091", qaVerifiedById: null, qaVerifiedByName: null });

    // Only QA can verify; only once.
    const storeDenied = await request(app).post(`/api/pre-productions/${runId}/consumptions/${line.id}/verify`).set(authHeader(storeToken));
    expect(storeDenied.status).toBe(403);

    const verified = await request(app).post(`/api/pre-productions/${runId}/consumptions/${line.id}/verify`).set(authHeader(qaToken));
    expect(verified.status).toBe(200);
    const verifiedLine = verified.body.consumptions[0];
    expect(verifiedLine.qaVerifiedById).toBeTruthy();
    expect(verifiedLine.qaVerifiedByName).toBeTruthy();
    expect(verifiedLine.qaVerifiedAt).toBeTruthy();

    const reVerify = await request(app).post(`/api/pre-productions/${runId}/consumptions/${line.id}/verify`).set(authHeader(qaToken));
    expect(reVerify.status).toBe(409);
  });
});

describe("PATCH /api/pre-productions/:id/stage — send back", () => {
  it("requires a note, is gated to the current stage's department, and returns the run to the previous stage", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemId = await createApprovedPoItem(bdToken);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    const runId = run.body.id;

    const { token: storeToken } = await createUser(["STORE"]);

    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD" });
    // Now at INDENT_ISSUE (PPIC).

    const wrongDept = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(storeToken)).send({ action: "REJECT", note: "not mine" });
    expect(wrongDept.status).toBe(403);

    const noNote = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(ppicToken)).send({ action: "REJECT" });
    expect(noNote.status).toBe(400);

    const rejected = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(ppicToken))
      .send({ action: "REJECT", note: "GRN details look wrong, please recheck the delivery." });
    expect(rejected.status).toBe(200);
    expect(rejected.body.currentStageId).toBe("MATERIAL_RECEIVED"); // back to the previous stage
    expect(rejected.body.stageEvents.at(-1).action).toBe("REJECT");
    expect(rejected.body.stageEvents.at(-1).note).toMatch(/delivery/);
  });

  it("has nothing to send back from the very first stage", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemId = await createApprovedPoItem(bdToken);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });

    const { token: storeToken } = await createUser(["STORE"]);
    const res = await request(app).patch(`/api/pre-productions/${run.body.id}/stage`).set(authHeader(storeToken)).send({ action: "REJECT", note: "n/a" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/pre-productions/:id/stage — admin JUMP", () => {
  it("is restricted to ADMIN and moves the run straight to any stage, bypassing the normal sequence", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemId = await createApprovedPoItem(bdToken);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    const runId = run.body.id;

    // A department that owns the current stage still can't jump — only ADMIN can.
    const { token: storeToken } = await createUser(["STORE"]);
    const denied = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(storeToken)).send({ action: "JUMP", targetStageId: "DISPENSING" });
    expect(denied.status).toBe(403);

    const { token: adminToken } = await createUser(["ADMIN"]);
    const missingTarget = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(adminToken)).send({ action: "JUMP" });
    expect(missingTarget.status).toBe(400);

    const jumped = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(adminToken))
      .send({ action: "JUMP", targetStageId: "SAMPLE_QC_APPROVAL", note: "Correcting a stuck run." });
    expect(jumped.status).toBe(200);
    expect(jumped.body.currentStageId).toBe("SAMPLE_QC_APPROVAL");
    expect(jumped.body.stageEvents.at(-1).action).toBe("JUMP");
    expect(jumped.body.stageEvents.at(-1).fromStageId).toBe("MATERIAL_RECEIVED");
    expect(jumped.body.stageEvents.at(-1).toStageId).toBe("SAMPLE_QC_APPROVAL");
  });
});

// PO Readiness soft-block gate — closing the gap where production could
// be started against a PO that PPIC's own tracked material requirements
// say isn't actually ready yet.
describe("POST /api/pre-productions — PO Readiness gate", () => {
  /** Approves a PO with one line item, returns both the PO id and the item id. */
  async function createApprovedPoWithId(bdToken: string, poNumber: string) {
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: `Customer for ${poNumber}` });
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.body.id, poNumber, items: [{ productName: "Medicine A", quantity: 100, unit: "KG" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    return { poId: po.body.id as string, itemId: po.body.items[0].id as string };
  }

  it("blocks (409) starting production against a PO whose tracked requirements aren't covered by live stock, and confirmNotReady overrides it", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { poId, itemId } = await createApprovedPoWithId(bdToken, "PO-GATE-1001");

    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Gate Test Item" });
    // 50 Kg required, nothing on hand — this PO is not ready.
    await request(app).post("/api/po-readiness").set(authHeader(ppicToken)).send({ purchaseOrderId: poId, itemId: item.body.id, category: "RM", requiredQty: 50, unit: "Kg" });

    const blocked = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.items).toHaveLength(1);
    expect(blocked.body.details.items[0].covered).toBe(false);

    const overridden = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId, confirmNotReady: true });
    expect(overridden.status).toBe(201);
  });

  it("doesn't block when the PO's tracked requirements are fully covered, or when nothing has been tracked at all", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: storeToken } = await createUser(["STORE"]);

    // Nothing tracked for this PO at all — no rows, no gate.
    const untracked = await createApprovedPoWithId(bdToken, "PO-GATE-1002");
    const noData = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: untracked.itemId });
    expect(noData.status).toBe(201);

    // Tracked, but fully covered by live stock.
    const covered = await createApprovedPoWithId(bdToken, "PO-GATE-1003");
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Gate Covered Item" });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 50, isOpeningStock: true });
    await request(app).post("/api/po-readiness").set(authHeader(ppicToken)).send({ purchaseOrderId: covered.poId, itemId: item.body.id, category: "RM", requiredQty: 50, unit: "Kg" });

    const created = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: covered.itemId });
    expect(created.status).toBe(201);
  });
});

// Indent Issue → real InventoryRequest — closes the gap where the stage's
// only record of the ask was a free-text sign-off, disconnected from
// Store's actual "what leaves the shelf for Production" gate.
describe("PATCH /api/pre-productions/:id/stage — Indent Issue lines create real InventoryRequest rows", () => {
  it("creates a PENDING InventoryRequest per line, tagged to the run, only when at Indent Issue", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const itemId = await createApprovedPoItem(bdToken);
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    const runId = run.body.id;

    const rm = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Indent Test RM" });

    // Walk to Indent Issue first.
    const atIndentIssue = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD" }); // MATERIAL_RECEIVED -> INDENT_ISSUE
    expect(atIndentIssue.body.currentStageId).toBe("INDENT_ISSUE");

    // Wrong category for the item — rejected before anything is written.
    const mismatch = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(ppicToken))
      .send({ action: "FORWARD", indentLines: [{ itemId: rm.body.id, category: "PM", requestedQty: 10 }] });
    expect(mismatch.status).toBe(400);

    const forwarded = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(ppicToken))
      .send({ action: "FORWARD", indentLines: [{ itemId: rm.body.id, category: "RM", requestedQty: 10 }] });
    expect(forwarded.status).toBe(200);
    expect(forwarded.body.currentStageId).toBe("LINE_CLEARANCE");
    expect(forwarded.body.indentRequests).toHaveLength(1);
    expect(forwarded.body.indentRequests[0]).toMatchObject({ itemId: rm.body.id, category: "RM", requestedQty: 10, status: "PENDING" });

    // Store's own Material Requests queue sees it too — it's a real row.
    const requests = await request(app).get("/api/inventory/requests?status=PENDING").set(authHeader(storeToken));
    expect(requests.body.some((r: { id: string }) => r.id === forwarded.body.indentRequests[0].id)).toBe(true);
  });
});

// Material Received traceability link — closes the gap where the stage
// duplicated the real Inventory-side record (a GRN receipt) instead of
// pointing at it.
describe("PATCH /api/pre-productions/:id/stage — cross-module traceability link", () => {
  it("links Material Received to a real RECEIVED transaction, and rejects an unknown id", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const itemId = await createApprovedPoItem(bdToken);
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    const runId = run.body.id;
    // Already at MATERIAL_RECEIVED (Store) — that's the very first stage.

    const rm = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "GRN Link Item" });
    const receipt = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: rm.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 25, isOpeningStock: true, grnNo: "GRN-LINK-1" });

    const badLink = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD", sourceReceiptId: "00000000-0000-0000-0000-000000000000" });
    expect(badLink.status).toBe(400);

    const linked = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD", sourceReceiptId: receipt.body.id, grnNo: "GRN-9001" });
    expect(linked.status).toBe(200);
    expect(linked.body.sourceReceiptId).toBe(receipt.body.id);
    expect(linked.body.sourceReceipt.grnNo).toBe("GRN-LINK-1");
  });
});
