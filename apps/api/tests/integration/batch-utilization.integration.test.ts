import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser, BATCH_START } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

/** A run that has cleared Line Clearance, whose calculated RM plan needs one material (so every batch has to log it). */
async function setup() {
  const { token: production, user } = await createUser(["PRODUCTION"]);
  const { token: bd } = await createUser(["BD"]);
  const stamp = Date.now();
  const store = await prisma.dayStore.create({ data: { name: `BU Store ${stamp}`, createdById: user.id } });
  const plant = await prisma.plant.create({ data: { name: `BU Plant ${stamp}`, createdById: user.id, dayStoreId: store.id } });
  const customer = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: `BU Customer ${stamp}` });
  const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: customer.body.id, poNumber: `BU-PO-${stamp}`, items: [{ productName: "BU Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
  const itemId = po.body.items[0].id as string;
  await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id } });
  const material = `BU Whey ${stamp}`;
  await prisma.rmPlan.create({
    data: { name: "BU rm plan", status: "CALCULATED", calculatedAt: new Date(), costingParams: {}, createdById: user.id, purchaseOrderItemId: itemId, resultSnapshot: { procurement: [{ name: material, totalKg: 100 }] } },
  });
  const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemId, plannedQty: 100, plantId: plant.id, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
  return { production, user, run, material };
}

describe("Batch Utilization books the material the Store dispensed to the run", () => {
  it("takes a batch's usage out of the Dispensing pool (no new stock needed); only what goes beyond the pool has to be on hand at the Plant", async () => {
    const { production, user, run, material } = await setup();
    const item = await prisma.inventoryItem.create({ data: { category: "RM", name: material, unit: "Kg" } });
    // The Day Store gave the Plant 100 Kg and logged all of it as consumed by the run at Dispensing: the Plant now holds 0, the run's pool has 100
    await prisma.inventoryTransaction.create({ data: { itemId: item.id, type: "ISSUED_PRODUCTION", quantity: 100, unit: "Kg", plantId: run.plantId!, date: new Date(), createdById: user.id, deliveredAt: new Date() } });
    await prisma.batchMaterialConsumption.create({ data: { preProductionId: run.id, itemId: item.id, quantity: 100, unit: "Kg", purpose: "PRODUCTION", createdById: user.id } });

    const batch = (await request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(production)).send({ ...BATCH_START, plannedQty: 40 })).body as { id: string };
    const log = (body: object) => request(app).post(`/api/plant-consumption/${run.id}/entries`).set(authHeader(production)).send({ itemId: item.id, unit: "Kg", productionBatchId: batch.id, ...body });
    const poolLeft = async () => (await prisma.batchMaterialConsumption.aggregate({ where: { preProductionId: run.id, productionBatchId: null, purpose: "PRODUCTION" }, _sum: { quantity: true } }))._sum.quantity ?? 0;
    const onBatch = async () => (await prisma.batchMaterialConsumption.aggregate({ where: { productionBatchId: batch.id, purpose: "PRODUCTION" }, _sum: { quantity: true } }))._sum.quantity ?? 0;

    expect((await log({ consumedQty: 40 })).status).toBe(201); // the Plant holds 0, but this is the batch's share of what was dispensed
    expect(await poolLeft()).toBe(60);
    expect(await onBatch()).toBe(40);
    expect((await log({ consumedQty: 60 })).status).toBe(201); // the rest of the pool
    expect(await poolLeft()).toBe(0);
    const tooMuch = await log({ consumedQty: 5 }); // beyond the pool: new consumption, and the Plant has nothing
    expect(tooMuch.status).toBe(409);
    expect(await onBatch()).toBe(100);
  });
});

describe("Batch: start fields, then Utilization, then output and completion", () => {
  it("needs every start field to start; output / end / complete wait until each plan material has a Production quantity on the batch", async () => {
    const { production, user, run, material } = await setup();
    const create = (body: object) => request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(production)).send(body);

    // A batch is divided with just its quantity; the production sheet (shift, manpower, ONE start date-time) may come with it
    const started = await create({ ...BATCH_START, plannedQty: 40 });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ shift: "Day", manpowerCount: 5, utilization: { required: 1, logged: 0, complete: false, missing: [material] } });
    expect(started.body.manufacturingStartDate).toBe(started.body.shiftStartAt); // one start date-time
    expect((await create({ plannedQty: 10 })).status).toBe(201);
    const id = started.body.id as string;
    const patch = (body: object) => request(app).patch(`/api/production-batches/${id}`).set(authHeader(production)).send(body);

    // The start fields can still be corrected; the finishing ones are shut while the Utilization is empty
    expect((await patch({ manpowerCount: 7 })).status).toBe(200);
    for (const body of [{ outputQty: 40 }, { shiftEndAt: "2026-10-01T17:00:00.000Z" }, { manufacturingStatus: "Completed" }, { manufacturingRemarks: "ok" }]) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.body.error).toMatch(/Fill the RM Utilization first/);
    }
    expect((await request(app).post(`/api/production-batches/${id}/complete`).set(authHeader(production))).status).toBe(409);

    // Log the material's Production quantity on THIS batch: everything opens
    await prisma.batchMaterialConsumption.create({ data: { preProductionId: run.id, productionBatchId: id, itemId: (await prisma.inventoryItem.findFirstOrThrow({ where: { name: material } })).id, quantity: 40, unit: "Kg", purpose: "PRODUCTION", createdById: user.id } });
    const done = await patch({ outputQty: 40, shiftEndAt: "2026-10-01T17:00:00.000Z", manufacturingStatus: "Completed" });
    expect(done.status).toBe(200);
    expect(done.body.utilization).toMatchObject({ logged: 1, complete: true, missing: [] });
    expect(done.body.manufacturingEndDate).toBe(done.body.shiftEndAt); // one end date-time
    expect((await request(app).post(`/api/production-batches/${id}/complete`).set(authHeader(production))).status).toBe(200);
  });
});
