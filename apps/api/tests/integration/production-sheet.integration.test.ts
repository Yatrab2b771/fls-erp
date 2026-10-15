import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

async function setup() {
  const { token: store, user } = await createUser(["STORE"]);
  const { token: prodA, user: userA } = await createUser(["PRODUCTION"]);
  const { token: prodB, user: userB } = await createUser(["PRODUCTION"]);
  const { token: prodAll, user: userAll } = await createUser(["PRODUCTION"]);
  const { token: bd } = await createUser(["BD"]);
  const a = await prisma.dayStore.create({ data: { name: "SHT Store A", createdById: user.id } });
  const b = await prisma.dayStore.create({ data: { name: "SHT Store B", createdById: user.id } });
  const plantA = await prisma.plant.create({ data: { name: "SHT Store A", createdById: user.id, dayStoreId: a.id } });
  const plantB = await prisma.plant.create({ data: { name: "SHT Store B", createdById: user.id, dayStoreId: b.id } });
  await prisma.plantAssignment.create({ data: { userId: userA.id, plantId: plantA.id } });
  await prisma.plantAssignment.create({ data: { userId: userB.id, plantId: plantB.id } });

  const customer = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "SHT Customer" });
  const makeItem = async (poNumber: string, plantId: string) => {
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bd))
      .send({ customerId: customer.body.id, poNumber, items: [{ productName: `${poNumber} Capsules`, productCategory: "Capsule", quantity: 3000, unit: "SKU", volume: 120 }] });
    const itemId = po.body.items[0].id as string;
    await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plantId, planSentToProductionAt: new Date() } });
    return itemId;
  };
  const itemA = await makeItem("SHT-PO-A", plantA.id);
  const itemB = await makeItem("SHT-PO-B", plantB.id);
  return { store, prodA, prodB, prodAll, userAll, plantA, itemA, itemB };
}

describe("New Plans and the batch production sheet", () => {
  it("lists the plans sent to Production whose run has not started, ready-filled, scoped to the Plant", async () => {
    const { prodA, prodB, prodAll, itemA, itemB } = await setup();
    const ids = async (token: string) => ((await request(app).get("/api/pre-productions/new-plans").set(authHeader(token))).body as { itemId: string }[]).map((r) => r.itemId).sort();

    expect(await ids(prodA)).toEqual([itemA]);
    expect(await ids(prodB)).toEqual([itemB]);
    expect(await ids(prodAll)).toEqual([itemA, itemB].sort());

    const row = (await request(app).get("/api/pre-productions/new-plans").set(authHeader(prodA))).body[0];
    expect(row).toMatchObject({ poNumber: "SHT-PO-A", customerName: "SHT Customer", productName: "SHT-PO-A Capsules", productCategory: "Capsule", quantity: 3000, unit: "SKU", volume: 120 });
    expect(row.plant.name).toBe("SHT Store A");

    // Once its run starts, the plan is no longer "new"
    await prisma.preProduction.create({ data: { purchaseOrderItemId: itemA, plannedQty: 3000, plantId: row.plant.id } });
    expect(await ids(prodA)).toEqual([]);
    expect(await ids(prodAll)).toEqual([itemB]);
  });

  it("a batch takes shift, manpower and full start / end date-time; a bad shift or an end before the start is refused", async () => {
    const { prodA, userAll, plantA, itemA } = await setup();
    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemA, plannedQty: 3000, plantId: plantA.id } });
    const batch = await prisma.productionBatch.create({ data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: userAll.id } }, plannedQty: 1000 } });
    const patch = (body: Record<string, unknown>) => request(app).patch(`/api/production-batches/${batch.id}`).set(authHeader(prodA)).send(body);

    const ok = await patch({ shift: "Night", manpowerCount: 8, shiftStartAt: "2026-10-06T20:00:00.000Z", shiftEndAt: "2026-10-07T04:00:00.000Z" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ shift: "Night", manpowerCount: 8 });
    expect(new Date(ok.body.shiftStartAt).toISOString()).toBe("2026-10-06T20:00:00.000Z");
    expect(new Date(ok.body.shiftEndAt).toISOString()).toBe("2026-10-07T04:00:00.000Z");

    expect((await patch({ shift: "Evening" })).status).toBe(400);
    expect((await patch({ shiftStartAt: "2026-10-06T20:00:00.000Z", shiftEndAt: "2026-10-06T08:00:00.000Z" })).status).toBe(400);
  });

  it("the plans board lists every plan sent to Production with its batches and batch-wise material utilization", async () => {
    const { prodA, prodB, userAll, plantA, itemA, itemB } = await setup();
    const board = async (token: string) => (await request(app).get("/api/pre-productions/plans-board").set(authHeader(token))).body as { itemId: string; run: { id: string } | null; batches: { id: string; materials: { itemName: string; consumedQty: number; wastedQty: number; sampleQty: number; returnedQty: number }[] }[]; unassigned: { itemName: string; consumedQty: number }[] }[];

    // Not started: it is on the board with no run
    expect((await board(prodA)).map((r) => r.itemId)).toEqual([itemA]);
    expect((await board(prodA))[0]!.run).toBeNull();

    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemA, plannedQty: 3000, plantId: plantA.id } });
    const mk = (plannedQty: number) => prisma.productionBatch.create({ data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: userAll.id } }, plannedQty, shift: "Day", manpowerCount: 10 } });
    const [b1, b2] = [await mk(1000), await mk(500)];
    const item = await prisma.inventoryItem.create({ data: { name: "SHT Base", category: "RM", unit: "Kg" } });
    const use = (productionBatchId: string | null, purpose: "PRODUCTION" | "WASTE" | "SAMPLE", quantity: number) =>
      prisma.batchMaterialConsumption.create({ data: { preProductionId: run.id, productionBatchId, itemId: item.id, quantity, unit: "Kg", purpose, createdById: userAll.id } });
    await use(b1.id, "PRODUCTION", 40);
    await use(b1.id, "WASTE", 2);
    await use(b2.id, "PRODUCTION", 18);
    await use(b2.id, "SAMPLE", 1);
    await use(null, "PRODUCTION", 5); // logged before batches were tracked

    const [row] = await board(prodA);
    expect(row!.run!.id).toBe(run.id);
    expect(row!.batches).toHaveLength(2);
    expect(row!.batches[0]!.materials[0]).toMatchObject({ itemName: "SHT Base", consumedQty: 40, wastedQty: 2, sampleQty: 0, returnedQty: 0 });
    expect(row!.batches[1]!.materials[0]).toMatchObject({ consumedQty: 18, sampleQty: 1 });
    expect(row!.unassigned[0]).toMatchObject({ itemName: "SHT Base", consumedQty: 5 });

    // Another Plant's login sees only its own plan
    expect((await board(prodB)).map((r) => r.itemId)).toEqual([itemB]);
  });

  it("a Plant entry can be tied to a batch (with a sample quantity), and only to a batch of its own run", async () => {
    const { prodA, userAll, plantA, itemA, itemB } = await setup();
    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemA, plannedQty: 3000, plantId: plantA.id } });
    const otherRun = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemB, plannedQty: 3000 } });
    const batch = await prisma.productionBatch.create({ data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: userAll.id } }, plannedQty: 1000 } });
    const otherBatch = await prisma.productionBatch.create({ data: { preProduction: { connect: { id: otherRun.id } }, createdBy: { connect: { id: userAll.id } }, plannedQty: 1000 } });
    const item = await prisma.inventoryItem.create({ data: { name: "SHT Flour", category: "RM", unit: "Kg" } });
    await prisma.inventoryTransaction.create({ data: { itemId: item.id, type: "ISSUED_PRODUCTION", date: new Date(), unit: "Kg", quantity: 100, plantId: plantA.id, dayStoreId: plantA.dayStoreId, createdById: userAll.id, deliveredAt: new Date(), deliveredById: userAll.id } });

    const log = (body: Record<string, unknown>) => request(app).post(`/api/plant-consumption/${run.id}/entries`).set(authHeader(prodA)).send({ itemId: item.id, unit: "Kg", ...body });
    expect((await log({ consumedQty: 10, productionBatchId: otherBatch.id })).status).toBe(400);
    expect((await log({ consumedQty: 40, wastedQty: 2, sampleQty: 1, productionBatchId: batch.id })).status).toBe(201);

    const rows = await prisma.batchMaterialConsumption.findMany({ where: { preProductionId: run.id } });
    expect(rows.map((r) => `${r.purpose}:${r.quantity}:${r.productionBatchId === batch.id}`).sort()).toEqual(["PRODUCTION:40:true", "SAMPLE:1:true", "WASTE:2:true"]);
  });
});
