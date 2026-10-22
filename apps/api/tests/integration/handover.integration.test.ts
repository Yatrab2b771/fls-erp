import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

async function setup() {
  const { token: prodA, user: userA } = await createUser(["PRODUCTION"]);
  const { token: prodB, user: userB } = await createUser(["PRODUCTION"]);
  const { token: dispatch } = await createUser(["DISPATCH"]);
  const { token: store, user: storeUser } = await createUser(["STORE"]);
  const { token: bd } = await createUser(["BD"]);
  const mkPlant = async (name: string) => {
    const dayStore = await prisma.dayStore.create({ data: { name, createdById: userA.id } });
    return prisma.plant.create({ data: { name, createdById: userA.id, dayStoreId: dayStore.id } });
  };
  const plantA = await mkPlant("HO Store A");
  const plantB = await mkPlant("HO Store B");
  await prisma.plantAssignment.create({ data: { userId: userA.id, plantId: plantA.id } });
  await prisma.plantAssignment.create({ data: { userId: userB.id, plantId: plantB.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: storeUser.id, dayStoreId: plantA.dayStoreId! } }); // the Store of Plant A

  const customer = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "HO Customer" });
  const po = await request(app)
    .post("/api/purchase-orders")
    .set(authHeader(bd))
    .send({ customerId: customer.body.id, poNumber: "HO-PO-1", items: [{ productName: "HO Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
  const itemId = po.body.items[0].id as string;
  const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemId, plannedQty: 100, plantId: plantA.id, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
  const mk = (batchNo: string, extra: Record<string, unknown> = {}) =>
    prisma.productionBatch.create({
      data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: userA.id } }, batchNo, plannedQty: 50, outputQty: 50, status: "COMPLETED", completedAt: new Date(), currentStageId: "PACKAGING", ...extra },
    });
  return { prodA, prodB, dispatch, store, mk };
}

const board = (token: string) => request(app).get("/api/production-batches/handover-board").set(authHeader(token));

describe("Production's Handover to Store", () => {
  it("a batch waits at QA's packaging gate (listed, not yet to hand over); once QA approves it Production hands it over to the store and it leaves the list", async () => {
    const { prodA, prodB, dispatch, store, mk } = await setup();
    const batch = await mk("HO-1", { currentStageId: "QA_GATE_PACKAGING", packagingStatus: "Completed" });
    const handover = (token: string) => request(app).post(`/api/production-batches/${batch.id}/handover-to-store`).set(authHeader(token));

    // Waiting for QA: listed, but not Production's to hand over yet
    const waiting = await board(prodA);
    expect(waiting.body.map((r: { batchNo: string }) => r.batchNo)).toEqual(["HO-1"]);
    expect(waiting.body[0]).toMatchObject({ poNumber: "HO-PO-1", productName: "HO Powder", currentStageId: "QA_GATE_PACKAGING", waitingForQa: true, awaitingStoreHandover: false, sentForQaAt: expect.any(String) });
    const tooEarly = await handover(prodA);
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.error).toMatch(/QA has not approved/);

    // QA approved: the goods are at FG Store but not the Day Store's until Production hands them over
    await prisma.productionBatch.update({ where: { id: batch.id }, data: { currentStageId: "FG_STORE" } });
    expect((await board(prodA)).body[0]).toMatchObject({ currentStageId: "FG_STORE", waitingForQa: false, awaitingStoreHandover: true });
    const fgBoard = (token: string) => request(app).get("/api/fg/store-board").set(authHeader(token));
    expect((await fgBoard(store)).body.map((r: { batchNo: string }) => r.batchNo)).not.toContain("HO-1");
    expect((await handover(prodB)).status).toBe(403); // another Plant's login
    expect((await handover(dispatch)).status).toBe(403); // Production's step
    const done = await handover(prodA);
    expect(done.status).toBe(200);
    expect(done.body.handedToStoreAt).not.toBeNull();
    expect(done.body.currentStageId).toBe("FG_STORE");
    expect(done.body.handedOverToDispatchAt).toBeNull(); // Dispatch hears about it only after QA's release and the Store's hand-over
    expect((await handover(prodA)).status).toBe(409); // already handed over

    expect((await board(prodA)).body).toEqual([]); // it leaves Production's list
    expect((await board(prodB)).body).toEqual([]); // not their Plant
    expect((await board(dispatch)).status).toBe(403); // the Handover list is Production's
    expect((await fgBoard(store)).body.map((r: { batchNo: string }) => r.batchNo)).toContain("HO-1"); // and is now the Store's finished goods
  });

  it("the Store gets nothing to receive until Production has handed the goods over", async () => {
    const { prodA, store, mk } = await setup();
    const batch = await mk("HO-FWD", { currentStageId: "FG_STORE" });
    const forward = () => request(app).patch(`/api/production-batches/${batch.id}/stage`).set(authHeader(store)).send({ action: "FORWARD" });
    const blocked = await forward();
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/not handed these finished goods over/);
    await request(app).post(`/api/production-batches/${batch.id}/handover-to-store`).set(authHeader(prodA));
    expect((await prisma.productionBatch.findUnique({ where: { id: batch.id } }))?.handedToStoreAt).not.toBeNull();
  });

  it("a batch that is not yet at Packaging cannot be handed over", async () => {
    const { prodA, mk } = await setup();
    const early = await mk("HO-EARLY", { currentStageId: "IPQC" });
    await mk("HO-PACKING", { packagingStatus: "In Progress" });
    const res = await request(app).post(`/api/production-batches/${early.id}/handover-to-store`).set(authHeader(prodA));
    expect(res.status).toBe(409);

    // The board lists only batches that have reached Packaging: one still at IPQC has not been packed, so it is not Production's to hand over yet
    const rows = (await board(prodA)).body as { batchNo: string; waitingForQa: boolean; awaitingStoreHandover: boolean }[];
    expect(rows.map((r) => r.batchNo)).toEqual(["HO-PACKING"]);
    expect(rows[0]).toMatchObject({ waitingForQa: false, awaitingStoreHandover: false }); // still with Production's Packaging sheet
  });
});
