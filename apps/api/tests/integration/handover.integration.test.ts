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
  const { token: bd } = await createUser(["BD"]);
  const mkPlant = async (name: string) => {
    const store = await prisma.dayStore.create({ data: { name, createdById: userA.id } });
    return prisma.plant.create({ data: { name, createdById: userA.id, dayStoreId: store.id } });
  };
  const plantA = await mkPlant("HO Store A");
  const plantB = await mkPlant("HO Store B");
  await prisma.plantAssignment.create({ data: { userId: userA.id, plantId: plantA.id } });
  await prisma.plantAssignment.create({ data: { userId: userB.id, plantId: plantB.id } });

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
  return { prodA, prodB, dispatch, mk };
}

describe("Production's Handover to QA", () => {
  it("a batch can be handed over once packaging reads Completed: it moves on to QA's packaging gate and stays in Production's list until QA has passed it", async () => {
    const { prodA, prodB, dispatch, mk } = await setup();
    const batch = await mk("HO-1");
    const handover = (token: string) => request(app).post(`/api/production-batches/${batch.id}/handover`).set(authHeader(token));

    // Packaging is not Completed yet
    expect((await handover(prodA)).status).toBe(409);

    await prisma.productionBatch.update({ where: { id: batch.id }, data: { packagingStatus: "Completed" } });
    expect((await handover(prodB)).status).toBe(403); // another Plant's login
    const done = await handover(prodA);
    expect(done.status).toBe(200);
    expect(done.body.currentStageId).toBe("QA_GATE_PACKAGING");
    expect(done.body.handedOverToDispatchAt).toBeNull(); // Dispatch hears about it only after QA and the Day Store have done their part
    expect((await handover(prodA)).status).toBe(409); // already handed over

    const board = (token: string) => request(app).get("/api/production-batches/handover-board").set(authHeader(token));
    expect((await board(prodA)).body.map((r: { batchNo: string }) => r.batchNo)).toEqual(["HO-1"]);
    expect((await board(prodA)).body[0]).toMatchObject({ poNumber: "HO-PO-1", productName: "HO Powder", handedOverAt: expect.any(String), currentStageId: "QA_GATE_PACKAGING" });
    expect((await board(prodB)).body).toEqual([]); // not their Plant
    expect((await board(dispatch)).status).toBe(403); // the Handover list is Production's

    // Once QA passes the packaging gate the finished goods are with the Day Store and leave Production's list
    await prisma.productionBatch.update({ where: { id: batch.id }, data: { currentStageId: "FG_STORE" } });
    expect((await board(prodA)).body).toEqual([]);
  });

  it("a batch that is not yet at Packaging cannot be handed over", async () => {
    const { prodA, mk } = await setup();
    const early = await mk("HO-EARLY", { currentStageId: "IPQC" });
    await mk("HO-PACKING", { packagingStatus: "Completed" });
    expect((await request(app).post(`/api/production-batches/${early.id}/handover`).set(authHeader(prodA))).status).toBe(409);

    const board = (token: string) => request(app).get("/api/production-batches/handover-board").set(authHeader(token));
    // The board lists only batches that have reached Packaging: one still at IPQC has not been packed, so it is not Production's to hand over yet
    expect((await board(prodA)).body.map((r: { batchNo: string }) => r.batchNo).sort()).toEqual(["HO-PACKING"]);
  });
});
