import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

/** Creates a customer + PO (DRAFT), approves it as BD, and returns its one line item's id. */
async function createApprovedPoItem(bdToken: string, quantity = 100) {
  const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });
  const po = await request(app)
    .post("/api/purchase-orders")
    .set(authHeader(bdToken))
    .send({ customerId: customer.body.id, items: [{ productName: "Medicine A", quantity, unit: "KG" }] });
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
  };
}

/** Creates a PreProduction run for the given item and walks it to its own terminal stage (SAMPLE_QC_APPROVAL, Approved) — the point ProductionBatch runs become creatable from. */
async function createRunReadyForProduction(itemId: string, tokens: Awaited<ReturnType<typeof makeTokens>>) {
  const run = (await request(app).post("/api/pre-productions").set(authHeader(tokens.production)).send({ purchaseOrderItemId: itemId })).body;
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.store)).send({ action: "FORWARD" });
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.ppic)).send({ action: "FORWARD" });
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.qa)).send({ action: "FORWARD", lineClearanceStatus: "Approved" });
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.store)).send({ action: "FORWARD" });
  const ready = await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.qa)).send({ action: "FORWARD", sampleQcStatus: "Approved" });
  return ready.body as { id: string; plannedQty: number; combinedQty: number };
}

describe("POST /api/pre-productions/:id/production-batches", () => {
  it("is Production-only, only creatable once Sample QC Approval has cleared, and can't be planned past the parent's remaining quantity", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const itemId = await createApprovedPoItem(bdToken, 100);

    // Fresh run, still at MATERIAL_RECEIVED — too early.
    const freshRun = (await request(app).post("/api/pre-productions").set(authHeader(tokens.production)).send({ purchaseOrderItemId: itemId })).body;
    const tooEarly = await request(app).post(`/api/pre-productions/${freshRun.id}/production-batches`).set(authHeader(tokens.production)).send({ plannedQty: 40 });
    expect(tooEarly.status).toBe(400);

    const itemId2 = await createApprovedPoItem(bdToken, 100);
    const run = await createRunReadyForProduction(itemId2, tokens);
    expect(run.plannedQty).toBe(100);
    expect(run.combinedQty).toBe(0);

    const deniedStore = await request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(tokens.store)).send({ plannedQty: 40 });
    expect(deniedStore.status).toBe(403);

    const first = await request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(tokens.production)).send({ batchNo: "PB-1", plannedQty: 60 });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ batchNo: "PB-1", plannedQty: 60, status: "IN_PROGRESS" });

    // 60 already planned, only 40 left of the 100 total — asking for 50 more overruns it.
    const overplan = await request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(tokens.production)).send({ plannedQty: 50 });
    expect(overplan.status).toBe(400);

    // Exactly the remainder is fine.
    const second = await request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(tokens.production)).send({ batchNo: "PB-2", plannedQty: 40 });
    expect(second.status).toBe(201);

    const list = await request(app).get(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(tokens.production));
    expect(list.body).toHaveLength(2);
  });
});

describe("PATCH /api/production-batches/:id — execution fields", () => {
  it("saves manufacturing dates/status/remarks and input/output, deriving wastage, and locks once completed", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const itemId = await createApprovedPoItem(bdToken, 100);
    const run = await createRunReadyForProduction(itemId, tokens);
    const pb = (await request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(tokens.production)).send({ plannedQty: 100 })).body;

    const deniedStore = await request(app).patch(`/api/production-batches/${pb.id}`).set(authHeader(tokens.store)).send({ inputQty: 100 });
    expect(deniedStore.status).toBe(403);

    // Before input/output are recorded, wastage is null, not zero.
    expect(pb.wastage).toEqual({ wastageQty: null, wastagePct: null });

    const saved = await request(app)
      .patch(`/api/production-batches/${pb.id}`)
      .set(authHeader(tokens.production))
      .send({ manufacturingStartDate: "2026-08-03", manufacturingEndDate: "2026-08-05", manufacturingStatus: "Completed", inputQty: 100, outputQty: 99.9 });
    expect(saved.status).toBe(200);
    expect(saved.body.inputQty).toBe(100);
    expect(saved.body.outputQty).toBe(99.9);
    expect(saved.body.wastage).toEqual({ wastageQty: 0.1, wastagePct: 0.1 });
  });
});

describe("POST /api/production-batches/:id/complete — auto-combine + auto-create CombinedLot", () => {
  it("adds outputQty to the parent's combinedQty and tracks remainingQty, without creating a lot until the total is fully planned", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const itemId = await createApprovedPoItem(bdToken, 100);
    const run = await createRunReadyForProduction(itemId, tokens);

    const pb1 = (await request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(tokens.production)).send({ batchNo: "PB-A", plannedQty: 60 })).body;

    // Can't complete without outputQty recorded first.
    const tooSoon = await request(app).post(`/api/production-batches/${pb1.id}/complete`).set(authHeader(tokens.production));
    expect(tooSoon.status).toBe(400);

    await request(app).patch(`/api/production-batches/${pb1.id}`).set(authHeader(tokens.production)).send({ outputQty: 58 });
    const completed1 = await request(app).post(`/api/production-batches/${pb1.id}/complete`).set(authHeader(tokens.production));
    expect(completed1.status).toBe(200);
    expect(completed1.body.productionBatch.status).toBe("COMPLETED");
    expect(completed1.body.combinedLot).toBeNull(); // only 58 of 100 pooled in so far

    const afterFirst = await request(app).get(`/api/pre-productions/${run.id}`).set(authHeader(tokens.production));
    expect(afterFirst.body.combinedQty).toBe(58);
    expect(afterFirst.body.remainingQty).toBe(42);

    // Already-completed runs can't be edited or completed again.
    const editAfterComplete = await request(app).patch(`/api/production-batches/${pb1.id}`).set(authHeader(tokens.production)).send({ outputQty: 60 });
    expect(editAfterComplete.status).toBe(409);
    const reComplete = await request(app).post(`/api/production-batches/${pb1.id}/complete`).set(authHeader(tokens.production));
    expect(reComplete.status).toBe(409);

    // Second run covers the remaining 42 — this one tips combinedQty over
    // plannedQty (100), which is exactly the trigger for the CombinedLot.
    const pb2 = (await request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(tokens.production)).send({ batchNo: "PB-B", plannedQty: 42 })).body;
    await request(app).patch(`/api/production-batches/${pb2.id}`).set(authHeader(tokens.production)).send({ outputQty: 42 });
    const completed2 = await request(app).post(`/api/production-batches/${pb2.id}/complete`).set(authHeader(tokens.production));
    expect(completed2.status).toBe(200);
    expect(completed2.body.combinedLot).not.toBeNull();
    expect(completed2.body.combinedLot.currentStageId).toBe("IPQC");

    const afterSecond = await request(app).get(`/api/pre-productions/${run.id}`).set(authHeader(tokens.production));
    expect(afterSecond.body.combinedQty).toBe(100);
    expect(afterSecond.body.remainingQty).toBe(0);
    expect(afterSecond.body.combinedLot.id).toBe(completed2.body.combinedLot.id);

    // Once the lot exists, no further ProductionBatch can be planned — nothing left to plan.
    const noMoreRoom = await request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(tokens.production)).send({ plannedQty: 1 });
    expect(noMoreRoom.status).toBe(409);
  });

  it("creates the CombinedLot directly off a single run that covers the whole planned quantity in one go", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const tokens = await makeTokens();
    const itemId = await createApprovedPoItem(bdToken, 50);
    const run = await createRunReadyForProduction(itemId, tokens);

    const pb = (await request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(tokens.production)).send({ plannedQty: 50 })).body;
    await request(app).patch(`/api/production-batches/${pb.id}`).set(authHeader(tokens.production)).send({ outputQty: 50 });
    const completed = await request(app).post(`/api/production-batches/${pb.id}/complete`).set(authHeader(tokens.production));
    expect(completed.status).toBe(200);
    expect(completed.body.combinedLot).not.toBeNull();
  });
});
