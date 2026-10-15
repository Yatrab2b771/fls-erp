import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser, BATCH_START } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";
import { getOnHandByPlantAndItem } from "../../src/modules/inventory/stock";

const app = createApp();

/**
 * Production split by Plant: Production A is limited to Plant A, Production B to Plant B, an unassigned Production seat
 * still sees everything. Each Plant has one product's run; Day Store A sent Plant A some Cocoa.
 */
async function setup() {
  const { token: store, user } = await createUser(["STORE"]);
  const { token: prodA, user: userA } = await createUser(["PRODUCTION"]);
  const { token: prodB, user: userB } = await createUser(["PRODUCTION"]);
  const { token: prodAll } = await createUser(["PRODUCTION"]);
  const { token: bd } = await createUser(["BD"]);
  const a = await prisma.dayStore.create({ data: { name: "PRD Store A", createdById: user.id } });
  const b = await prisma.dayStore.create({ data: { name: "PRD Store B", createdById: user.id } });
  const plantA = await prisma.plant.create({ data: { name: "PRD Store A", createdById: user.id, dayStoreId: a.id } });
  const plantB = await prisma.plant.create({ data: { name: "PRD Store B", createdById: user.id, dayStoreId: b.id } });
  await prisma.plantAssignment.create({ data: { userId: userA.id, plantId: plantA.id } });
  await prisma.plantAssignment.create({ data: { userId: userB.id, plantId: plantB.id } });

  const cocoa = await prisma.inventoryItem.create({ data: { category: "RM", name: "PRD Cocoa", unit: "Kg" } });
  const customer = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "PRD Customer" });
  const makeRun = async (poNumber: string, plantId: string) => {
    const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: customer.body.id, poNumber, items: [{ productName: `${poNumber} Product`, productCategory: "Powder", quantity: 10, unit: "Kg" }] });
    const itemId = po.body.items[0].id as string;
    await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plantId } });
    return prisma.preProduction.create({ data: { purchaseOrderItemId: itemId, plannedQty: 10, plantId } });
  };
  const runA = await makeRun("PRD-PO-A", plantA.id);
  const runB = await makeRun("PRD-PO-B", plantB.id);

  const base = { itemId: cocoa.id, createdById: user.id, date: new Date(), unit: "Kg" };
  await prisma.inventoryTransaction.create({ data: { ...base, type: "RECEIVED", quantity: 100, vendorName: "V", receiptStatus: "ACCEPTED", acceptedById: user.id, acceptedAt: new Date() } });
  await prisma.inventoryTransaction.create({ data: { ...base, type: "ISSUED_DAY_STORE", quantity: 50, dayStoreId: a.id, deliveredAt: new Date() } });
  return { store, prodA, prodB, prodAll, cocoa, a, plantA, plantB, runA, runB };
}

describe("Production split by Plant - each Production login covers one Plant", () => {
  it("sees only its own Plant's runs; an unassigned Production seat still sees every Plant", async () => {
    const { prodA, prodB, prodAll, runA, runB } = await setup();
    const ids = async (token: string) => ((await request(app).get("/api/pre-productions").set(authHeader(token))).body as { id: string }[]).map((r) => r.id).sort();

    expect(await ids(prodA)).toEqual([runA.id]);
    expect(await ids(prodB)).toEqual([runB.id]);
    expect(await ids(prodAll)).toEqual([runA.id, runB.id].sort());

    expect((await request(app).get(`/api/pre-productions/${runA.id}`).set(authHeader(prodA))).status).toBe(200);
    expect((await request(app).get(`/api/pre-productions/${runB.id}`).set(authHeader(prodA))).status).toBe(403); // another Plant's run
    expect((await request(app).patch(`/api/pre-productions/${runB.id}/stage`).set(authHeader(prodA)).send({ action: "FORWARD" })).status).toBe(403);
    expect((await request(app).get(`/api/pre-productions/${runB.id}`).set(authHeader(prodAll))).status).toBe(200);
  });

  it("confirms only what reaches its own Plant, and sees only its own Plant's transfers", async () => {
    const { prodA, prodB, cocoa, a, plantA } = await setup();
    const { token: storeA, user: userA } = await createUser(["STORE"]);
    await prisma.dayStoreAssignment.create({ data: { userId: userA.id, dayStoreId: a.id } });

    const sent = await request(app).post("/api/stock-transfers").set(authHeader(storeA)).send({ itemId: cocoa.id, quantity: 20, unit: "Kg", sourceType: "DAY_STORE", sourceDayStoreId: a.id, destinationType: "PLANT", destPlantId: plantA.id });
    expect(sent.status).toBe(201);

    expect((await request(app).get("/api/stock-transfers").set(authHeader(prodA))).body).toHaveLength(1);
    expect((await request(app).get("/api/stock-transfers").set(authHeader(prodB))).body).toHaveLength(0);
    expect((await request(app).post(`/api/stock-transfers/${sent.body.id}/confirm`).set(authHeader(prodB))).status).toBe(403); // another Plant's login
    expect((await request(app).post(`/api/stock-transfers/${sent.body.id}/confirm`).set(authHeader(prodA))).status).toBe(200);
    expect((await getOnHandByPlantAndItem(plantA.id, [cocoa.id])).get(cocoa.id)).toBe(20);
  });

  it("batches: another Plant's run cannot take a new batch", async () => {
    const { prodA, runB } = await setup();
    const res = await request(app).post(`/api/pre-productions/${runB.id}/production-batches`).set(authHeader(prodA)).send({ ...BATCH_START, plannedQty: 5 });
    expect(res.status).toBe(403);
  });
});
