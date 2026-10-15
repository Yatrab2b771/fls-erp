import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";
import { getOnHandByDayStoreAndItem, getOnHandByItemId, getOnHandByPlantAndItem } from "../../src/modules/inventory/stock";

const app = createApp();

/** Warehouse seat, a Day Store login for store A and one for store B, Production. 50 Kg of Cocoa sits in store A. */
async function setup() {
  const { token: warehouse, user } = await createUser(["STORE"]);
  const { token: storeA, user: userA } = await createUser(["STORE"]);
  const { token: storeB, user: userB } = await createUser(["STORE"]);
  const { token: production } = await createUser(["PRODUCTION"]);
  const cocoa = await prisma.inventoryItem.create({ data: { category: "RM", name: "STX Cocoa", unit: "Kg" } });
  const a = await prisma.dayStore.create({ data: { name: "STX Store A", createdById: user.id } });
  const b = await prisma.dayStore.create({ data: { name: "STX Store B", createdById: user.id } });
  const plantA = await prisma.plant.create({ data: { name: "STX Store A", createdById: user.id, dayStoreId: a.id } });
  const plantB = await prisma.plant.create({ data: { name: "STX Store B", createdById: user.id, dayStoreId: b.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: userA.id, dayStoreId: a.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: userB.id, dayStoreId: b.id } });
  const base = { itemId: cocoa.id, createdById: user.id, date: new Date(), unit: "Kg" };
  await prisma.inventoryTransaction.create({ data: { ...base, type: "RECEIVED", quantity: 100, vendorName: "V", receiptStatus: "ACCEPTED", acceptedById: user.id, acceptedAt: new Date() } });
  await prisma.inventoryTransaction.create({ data: { ...base, type: "ISSUED_DAY_STORE", quantity: 50, dayStoreId: a.id, deliveredAt: new Date() } });
  return { warehouse, storeA, storeB, production, cocoa, a, b, plantA, plantB };
}

const send = (token: string, body: Record<string, unknown>) => request(app).post("/api/stock-transfers").set(authHeader(token)).send(body);

describe("Stock transfers - a Day Store returns stock to the Warehouse or sends it to its own Plant", () => {
  it("only a Day Store sends its own stock: not the Warehouse, not to another store, not to another store's Plant", async () => {
    const { warehouse, storeA, cocoa, a, b, plantB } = await setup();
    const base = { itemId: cocoa.id, quantity: 10, unit: "Kg", sourceType: "DAY_STORE", sourceDayStoreId: a.id };

    expect((await send(warehouse, { ...base, destinationType: "WAREHOUSE" })).status).toBe(403); // the Warehouse does not send from a Day Store
    expect((await send(storeA, { ...base, destinationType: "DAY_STORE", destDayStoreId: b.id })).status).toBe(400); // never to another Day Store
    expect((await send(storeA, { ...base, destinationType: "PLANT", destPlantId: plantB.id })).status).toBe(400); // not another store's Plant
    expect((await send(storeA, { ...base, sourceDayStoreId: b.id, destinationType: "WAREHOUSE" })).status).toBe(403); // not another store's stock
    expect((await send(storeA, { ...base, quantity: 500, destinationType: "WAREHOUSE" })).status).toBe(409); // more than it holds
  });

  it("a return to the Warehouse is confirmed by the Warehouse (not the Day Store login) and lands as stock", async () => {
    const { warehouse, storeA, cocoa, a } = await setup();
    const sent = await send(storeA, { itemId: cocoa.id, quantity: 10, unit: "Kg", sourceType: "DAY_STORE", sourceDayStoreId: a.id, destinationType: "WAREHOUSE" });
    expect(sent.status).toBe(201);
    // The store's balance drops at once; the Warehouse only gains it on confirm
    expect((await getOnHandByDayStoreAndItem(a.id, [cocoa.id])).get(cocoa.id)?.onHand).toBe(40);
    expect((await getOnHandByItemId([cocoa.id])).get(cocoa.id)).toBe(50);

    expect((await request(app).post(`/api/stock-transfers/${sent.body.id}/confirm`).set(authHeader(storeA))).status).toBe(403);
    expect((await request(app).post(`/api/stock-transfers/${sent.body.id}/confirm`).set(authHeader(warehouse))).status).toBe(200);
    expect((await getOnHandByItemId([cocoa.id])).get(cocoa.id)).toBe(60);
  });

  it("a send to its own Plant is confirmed by Production, and each store sees only its own transfers", async () => {
    const { storeA, storeB, production, cocoa, a, plantA } = await setup();
    const sent = await send(storeA, { itemId: cocoa.id, quantity: 20, unit: "Kg", sourceType: "DAY_STORE", sourceDayStoreId: a.id, destinationType: "PLANT", destPlantId: plantA.id });
    expect(sent.status).toBe(201);
    expect((await request(app).post(`/api/stock-transfers/${sent.body.id}/confirm`).set(authHeader(production))).status).toBe(200);
    expect((await getOnHandByPlantAndItem(plantA.id, [cocoa.id])).get(cocoa.id)).toBe(20);
    expect((await getOnHandByDayStoreAndItem(a.id, [cocoa.id])).get(cocoa.id)?.onHand).toBe(30);

    const own = await request(app).get("/api/stock-transfers").set(authHeader(storeA));
    expect(own.body).toHaveLength(1);
    const other = await request(app).get("/api/stock-transfers").set(authHeader(storeB));
    expect(other.body).toHaveLength(0);
  });
});
