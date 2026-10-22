import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser, receiveAcceptedStock } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

// The test setup lets Warehouse -> Store issues arrive at once (so other tests need not confirm them); here the receiving step itself is under test.
beforeEach(() => {
  (globalThis as { __flsStoreReceivesAtOnce?: boolean }).__flsStoreReceivesAtOnce = false;
});

async function setup() {
  const { token: warehouse } = await createUser(["STORE"]); // not limited to a Store: the Warehouse seat
  const { token: store, user: storeUser } = await createUser(["STORE"]);
  const { token: otherStore, user: otherUser } = await createUser(["STORE"]);
  const mine = await prisma.dayStore.create({ data: { name: `SR Store ${Date.now()}`, createdById: storeUser.id } });
  const other = await prisma.dayStore.create({ data: { name: `SR Other ${Date.now()}`, createdById: storeUser.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: storeUser.id, dayStoreId: mine.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: otherUser.id, dayStoreId: other.id } });
  const item = await request(app).post("/api/inventory/items").set(authHeader(warehouse)).send({ category: "RM", name: `SR Resin ${Date.now()}`, unit: "Kg" });
  await receiveAcceptedStock(warehouse, { itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 200, isOpeningStock: true });
  const issue = (body: Record<string, unknown> = {}) =>
    request(app).post("/api/inventory/transactions").set(authHeader(warehouse)).send({ itemId: item.body.id, type: "ISSUED_DAY_STORE", date: "2026-08-10", unit: "Kg", quantity: 40, dayStoreId: mine.id, ...body });
  const storeStock = async () => {
    const res = await request(app).get(`/api/inventory/day-stores/${mine.id}/stock`).set(authHeader(store));
    return (res.body.stock as { onHand: number }[]).reduce((sum, s) => sum + s.onHand, 0);
  };
  const warehouseOnHand = async () => {
    const res = await request(app).get("/api/inventory/stock").set(authHeader(warehouse));
    const row = (res.body as { item: { id: string }; onHand: number }[]).find((r) => r.item.id === item.body.id);
    return row?.onHand ?? 0;
  };
  const received = (token: string, query = "") => request(app).get(`/api/inventory/my-store/received?pageSize=50${query}`).set(authHeader(token));
  return { warehouse, store, storeUser, otherStore, mine, item, issue, storeStock, warehouseOnHand, received };
}

describe("What the Warehouse issues to a Store is received by the Store", () => {
  it("is in transit until the Store receives it: it leaves the Warehouse at once but counts at the Store only after (a shortage is recorded, a refusal sends it back)", async () => {
    const { warehouse, store, otherStore, issue, storeStock, warehouseOnHand, received } = await setup();
    expect(await warehouseOnHand()).toBe(200);

    // Even when the Warehouse says "not in transit", an issue to a Store is in transit
    const sent = await issue({ isTransitTracked: false });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ isTransitTracked: true, deliveredAt: null });
    expect(await warehouseOnHand()).toBe(160); // left the Warehouse at once
    expect(await storeStock()).toBe(0); // not the Store's yet

    // It shows on the Store's Stock Received as In Transit, with how many are waiting
    const list = await received(store);
    expect(list.body).toEqual([expect.objectContaining({ id: sent.body.id, status: "In Transit", quantity: 40 })]);
    expect((await received(store, "&status=In%20Transit")).headers["x-total-count"]).toBe("1");

    // Another Store cannot receive it
    expect((await request(app).post(`/api/inventory/transactions/${sent.body.id}/confirm-delivery`).set(authHeader(otherStore)).send({})).status).toBe(403);
    // Less than was sent needs a reason; with one, the shortage is recorded and only what arrived counts
    expect((await request(app).post(`/api/inventory/transactions/${sent.body.id}/confirm-delivery`).set(authHeader(store)).send({ receivedQty: 35 })).status).toBe(400);
    const got = await request(app).post(`/api/inventory/transactions/${sent.body.id}/confirm-delivery`).set(authHeader(store)).send({ receivedQty: 35, note: "5 Kg spilled in the van" });
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ shortQty: 5 });
    expect(got.body.deliveredAt).not.toBeNull();
    expect(await storeStock()).toBe(35);
    expect((await received(store)).body[0]).toMatchObject({ status: "Delivered" });
    expect((await request(app).post(`/api/inventory/transactions/${sent.body.id}/confirm-delivery`).set(authHeader(store)).send({})).status).toBe(409); // once

    // A refused issue goes back to the Warehouse's stock (and never counted at the Store)
    const wrong = await issue({ quantity: 10 });
    expect(await warehouseOnHand()).toBe(150);
    expect((await request(app).post(`/api/inventory/transactions/${wrong.body.id}/reject-delivery`).set(authHeader(store)).send({ reason: "Wrong item sent" })).status).toBe(200);
    expect(await warehouseOnHand()).toBe(160);
    expect(await storeStock()).toBe(35);
    void warehouse;
  });

  it("the bulk import and the issue against a Store's request are in transit as well", async () => {
    const { warehouse, store, storeUser, mine, item, storeStock, received } = await setup();

    const imported = await request(app)
      .post("/api/inventory/transactions/import")
      .set(authHeader(warehouse))
      .send({ type: "ISSUED_DAY_STORE", dayStoreId: mine.id, rows: [{ itemName: (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.body.id } })).name, category: "RM", date: "2026-08-12", unit: "Kg", quantity: 12 }] });
    expect(imported.status).toBe(201);
    expect((await received(store)).body).toEqual([expect.objectContaining({ status: "In Transit", quantity: 12 })]);
    expect(await storeStock()).toBe(0);

    // The Store asks the Warehouse for material; the Warehouse issues against it: in transit too
    const ask = await prisma.inventoryRequest.create({ data: { itemId: item.body.id, category: "RM", requestedQty: 30, purpose: "ISSUED_DAY_STORE", requestedById: storeUser.id, requestingDayStoreId: mine.id, status: "APPROVED" } });
    const against = await request(app).post(`/api/inventory/requests/${ask.id}/issue`).set(authHeader(warehouse)).send({ date: "2026-08-13", unit: "Kg", quantity: 30, dayStoreId: mine.id });
    expect(against.status).toBe(201);
    expect(against.body).toMatchObject({ isTransitTracked: true, deliveredAt: null });
    expect(await storeStock()).toBe(0);
    for (const row of (await received(store, "&status=In%20Transit")).body as { id: string }[]) {
      expect((await request(app).post(`/api/inventory/transactions/${row.id}/confirm-delivery`).set(authHeader(store)).send({})).status).toBe(200);
    }
    expect(await storeStock()).toBe(42);
  });
});
