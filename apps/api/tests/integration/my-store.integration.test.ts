import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

/**
 * Cocoa: 100 received. 40 -> Day Store A (5 of it on to A's Plant), 30 -> Day Store B.
 * A Day Store login assigned to A sees only A's side; the Warehouse-side Store seat sees everything.
 */
async function setup() {
  const { token: warehouse, user } = await createUser(["STORE"]);
  const { token: storeA, user: userA } = await createUser(["STORE"]);
  const cocoa = await prisma.inventoryItem.create({ data: { category: "RM", name: "MYS Cocoa", unit: "Kg" } });
  const a = await prisma.dayStore.create({ data: { name: "MYS Store A", createdById: user.id } });
  const b = await prisma.dayStore.create({ data: { name: "MYS Store B", createdById: user.id } });
  const plantA = await prisma.plant.create({ data: { name: "MYS Store A", createdById: user.id, dayStoreId: a.id } });
  await prisma.plant.create({ data: { name: "MYS Store B", createdById: user.id, dayStoreId: b.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: userA.id, dayStoreId: a.id } });

  const base = { itemId: cocoa.id, createdById: user.id, date: new Date(), unit: "Kg", deliveredAt: new Date() };
  await prisma.inventoryTransaction.create({ data: { ...base, type: "RECEIVED", quantity: 100, vendorName: "V", receiptStatus: "ACCEPTED", acceptedById: user.id, acceptedAt: new Date() } });
  await prisma.inventoryTransaction.create({ data: { ...base, type: "ISSUED_DAY_STORE", quantity: 40, dayStoreId: a.id, batchNo: "MYS-B1" } });
  await prisma.inventoryTransaction.create({ data: { ...base, type: "ISSUED_DAY_STORE", quantity: 30, dayStoreId: b.id } });
  await prisma.inventoryTransaction.create({ data: { ...base, type: "ISSUED_PRODUCTION", quantity: 5, dayStoreId: a.id, plantId: plantA.id } });
  return { warehouse, storeA, a, b, plantA };
}

describe("Day Store login - works like a Warehouse for its own store only", () => {
  it("info lists only the assigned store and its Plant; the Warehouse seat is unscoped", async () => {
    const { warehouse, storeA } = await setup();
    const mine = await request(app).get("/api/inventory/my-store/info").set(authHeader(storeA));
    expect(mine.body.scoped).toBe(true);
    expect(mine.body.stores).toHaveLength(1);
    expect(mine.body.stores[0]).toMatchObject({ name: "MYS Store A", plantName: "MYS Store A" });

    const all = await request(app).get("/api/inventory/my-store/info").set(authHeader(warehouse));
    expect(all.body.scoped).toBe(false);
    expect(all.body.stores.length).toBeGreaterThanOrEqual(2);
  });

  it("received / issued-to-plant show only this store's movements, with filters", async () => {
    const { warehouse, storeA } = await setup();
    const received = await request(app).get("/api/inventory/my-store/received").set(authHeader(storeA));
    expect(received.headers["x-total-count"]).toBe("1");
    expect(received.body[0]).toMatchObject({ itemName: "MYS Cocoa", quantity: 40, storeName: "MYS Store A", batchNo: "MYS-B1", status: "Delivered" });

    const toPlant = await request(app).get("/api/inventory/my-store/issued-to-plant").set(authHeader(storeA));
    expect(toPlant.headers["x-total-count"]).toBe("1");
    expect(toPlant.body[0]).toMatchObject({ quantity: 5, storeName: "MYS Store A", plantName: "MYS Store A" });

    expect((await request(app).get("/api/inventory/my-store/received?batchNo=NOPE").set(authHeader(storeA))).headers["x-total-count"]).toBe("0");
    expect((await request(app).get("/api/inventory/my-store/received?category=PM").set(authHeader(storeA))).headers["x-total-count"]).toBe("0");

    const summary = await request(app).get("/api/inventory/my-store/summary").set(authHeader(storeA));
    expect(summary.body).toEqual({ received: 1, issuedToPlant: 1, requests: 0, productionRequests: 0, productsCovered: 0, productsShort: 0 });

    // The Warehouse-side seat sees both stores' receipts
    const all = await request(app).get("/api/inventory/my-store/received?store=MYS%20Store%20A&store=MYS%20Store%20B").set(authHeader(warehouse));
    expect(all.headers["x-total-count"]).toBe("2");

    const opt = await request(app).get("/api/inventory/my-store/received/options?field=store").set(authHeader(storeA));
    expect(opt.body.values).toEqual(["MYS Store A"]);
  });

  it("Available Stock is limited to the store and its Plant; Warehouse-side lists are closed to it", async () => {
    const { storeA, a, plantA } = await setup();
    const meta = await request(app).get("/api/inventory/available-stock/meta").set(authHeader(storeA));
    expect(meta.body.locations.map((l: { key: string }) => l.key)).toEqual([`ds:${a.id}`, `plant:${plantA.id}`]);

    const list = await request(app).get("/api/inventory/available-stock?view=item").set(authHeader(storeA));
    const cocoa = list.body.find((r: { itemName: string }) => r.itemName === "MYS Cocoa");
    expect(cocoa.total).toBe(40); // Store A 35 + its Plant 5 - nothing from the Warehouse or Store B
    expect(cocoa.locations).toEqual({ [`ds:${a.id}`]: 35, [`plant:${plantA.id}`]: 5 });

    for (const path of ["stock-received", "quarantine-list", "fg-list", "stock-issued"]) {
      expect((await request(app).get(`/api/inventory/${path}`).set(authHeader(storeA))).status).toBe(403);
    }
  });
});
