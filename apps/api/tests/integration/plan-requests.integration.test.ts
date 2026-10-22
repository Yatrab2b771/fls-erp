import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000);

/**
 * A product is planned at Day Store A's Plant. A production request for 100 Kg of Cocoa goes to Day Store A, which
 * holds 10; the Warehouse holds 60. The plan-driven chain: Day Store approves -> fills what it has -> asks the
 * Warehouse for the rest (urgent, "Material Request (Plan)") -> Warehouse issues -> Day Store fills the Plant.
 */
async function setup() {
  const { token: warehouse, user } = await createUser(["STORE"]);
  const { token: storeA, user: userA } = await createUser(["STORE"]);
  const { token: storeB, user: userB } = await createUser(["STORE"]);
  const { token: bd } = await createUser(["BD"]);
  const cocoa = await prisma.inventoryItem.create({ data: { category: "RM", name: "PLN Cocoa", unit: "Kg" } });
  const a = await prisma.dayStore.create({ data: { name: "PLN Store A", createdById: user.id } });
  const b = await prisma.dayStore.create({ data: { name: "PLN Store B", createdById: user.id } });
  const plantA = await prisma.plant.create({ data: { name: "PLN Store A", createdById: user.id, dayStoreId: a.id } });
  await prisma.plant.create({ data: { name: "PLN Store B", createdById: user.id, dayStoreId: b.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: userA.id, dayStoreId: a.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: userB.id, dayStoreId: b.id } });

  const base = { itemId: cocoa.id, createdById: user.id, date: new Date(), unit: "Kg" };
  await prisma.inventoryTransaction.create({ data: { ...base, type: "RECEIVED", quantity: 70, vendorName: "V", receiptStatus: "ACCEPTED", acceptedById: user.id, acceptedAt: new Date() } });
  await prisma.inventoryTransaction.create({ data: { ...base, type: "ISSUED_DAY_STORE", quantity: 10, dayStoreId: a.id, deliveredAt: new Date() } }); // Warehouse 60, Store A 10

  const customer = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "PLN Customer" });
  const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: customer.body.id, poNumber: "PLN-PO-1", items: [{ productName: "PLN Protein Bar", productCategory: "Powder", quantity: 100, unit: "Kg" }] });
  const poItemId = po.body.items[0].id as string;
  await prisma.purchaseOrderItem.update({ where: { id: poItemId }, data: { plannedPlantId: plantA.id } });

  const production = await prisma.inventoryRequest.create({
    data: { itemId: cocoa.id, category: "RM", requestedQty: 100, purpose: "ISSUED_PRODUCTION", status: "PENDING", requestedById: user.id, plantId: plantA.id, purchaseOrderItemId: poItemId, neededBy: daysFromNow(-1), note: "PLN plan" },
  });
  return { warehouse, storeA, storeB, cocoa, a, plantA, production };
}

describe("Plan requests - production request -> Plant's Store -> Warehouse (urgent) -> Plant", () => {
  it("goes to the Plant's Store, which fills what it has and asks the Warehouse for the rest", async () => {
    const { warehouse, storeA, storeB, production } = await setup();
    const mine = () => request(app).get("/api/inventory/my-store/production-requests").set(authHeader(storeA));

    const list = await mine();
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ productName: "PLN Protein Bar", poNumber: "PLN-PO-1", plantName: "PLN Store A", requestedQty: 100, storeStock: 10, short: true, toAsk: 90, stage: "WITH_DAY_STORE", overdue: true });
    // Another Day Store neither sees it nor can act on it
    expect((await request(app).get("/api/inventory/my-store/production-requests").set(authHeader(storeB))).body).toHaveLength(0);
    expect((await request(app).patch(`/api/inventory/requests/${production.id}/review`).set(authHeader(storeB)).send({ action: "APPROVE" })).status).toBe(403);

    // Store A approves and issues what its shelf holds into its own Plant
    expect((await request(app).patch(`/api/inventory/requests/${production.id}/review`).set(authHeader(storeA)).send({ action: "APPROVE" })).status).toBe(200);
    const issue = await request(app).post(`/api/inventory/requests/${production.id}/issue`).set(authHeader(storeA)).send({ date: "2026-10-06", unit: "Kg", quantity: 10, dayStoreId: (await prisma.dayStore.findFirstOrThrow({ where: { name: "PLN Store A" } })).id });
    expect(issue.status).toBe(201);
    expect((await mine()).body[0]).toMatchObject({ issuedQty: 10, remainingQty: 90, storeStock: 0, toAsk: 90 });

    // ...then asks the Warehouse for the rest (once)
    const ask = await request(app).post(`/api/inventory/my-store/production-requests/${production.id}/request-from-warehouse`).set(authHeader(storeA));
    expect(ask.status).toBe(201);
    expect(ask.body.requestedQty).toBe(90);
    expect((await request(app).post(`/api/inventory/my-store/production-requests/${production.id}/request-from-warehouse`).set(authHeader(storeA))).status).toBe(409);
    expect((await mine()).body[0]).toMatchObject({ stage: "REQUESTED_FROM_WAREHOUSE", askedFromWarehouse: 90, toAsk: 0 });

    // The Warehouse sees it in the urgent Plan list - not in the regular one
    const summary = (await request(app).get("/api/inventory/material-requests/summary").set(authHeader(warehouse))).body;
    expect(summary).toMatchObject({ plan: 1, planOverdue: 1 });
    const plan = await request(app).get("/api/inventory/material-requests?kind=plan").set(authHeader(warehouse));
    expect(plan.body).toHaveLength(1);
    expect(plan.body[0]).toMatchObject({ forPlan: true, requesterName: "PLN Store A", productName: "PLN Protein Bar", poNumber: "PLN-PO-1", plantName: "PLN Store A", requestedQty: 90, overdue: true, warehouseOnHand: 60, short: true, shortBy: 30 });
    const regular = await request(app).get("/api/inventory/material-requests?requester=PLN%20Store%20A").set(authHeader(warehouse));
    expect(regular.body).toHaveLength(0);

    // Warehouse approves and issues the 60 it has; the Day Store can then fill the Plant with it
    expect((await request(app).patch(`/api/inventory/requests/${plan.body[0].id}/review`).set(authHeader(warehouse)).send({ action: "APPROVE" })).status).toBe(200);
    expect((await request(app).post(`/api/inventory/requests/${plan.body[0].id}/issue`).set(authHeader(warehouse)).send({ date: "2026-10-06", unit: "Kg", quantity: 60, dayStoreId: null })).status).toBe(201);
    expect((await mine()).body[0]).toMatchObject({ storeStock: 60, remainingQty: 90 });
  });

  it("shares one pile of shelf stock between the plans that need the same material, earliest needed first", async () => {
    const { storeA, cocoa, plantA, production } = await setup();
    const { user } = await createUser(["BD"]);
    // A second plan needs 30 more of the same Cocoa, needed later than the first; the shelf holds 10 in all
    await prisma.inventoryRequest.create({
      data: { itemId: cocoa.id, category: "RM", requestedQty: 30, purpose: "ISSUED_PRODUCTION", status: "PENDING", requestedById: user.id, plantId: plantA.id, neededBy: daysFromNow(5), note: "PLN second plan" },
    });
    const rows = (await request(app).get("/api/inventory/my-store/production-requests").set(authHeader(storeA))).body as { id: string; storeStock: number; storeShare: number; toAsk: number; short: boolean }[];
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.id === production.id)!;
    const second = rows.find((r) => r.id !== production.id)!;
    expect(first).toMatchObject({ storeStock: 10, storeShare: 10, toAsk: 90 }); // needed first: the shelf covers it
    expect(second).toMatchObject({ storeStock: 10, storeShare: 0, toAsk: 30, short: true }); // the same 10 are not counted twice
  });

  it("filters the Store's production requests and the Warehouse's plan list", async () => {
    const { warehouse, storeA } = await setup();
    const count = async (qs: string) => (await request(app).get(`/api/inventory/my-store/production-requests?${qs}`).set(authHeader(storeA))).headers["x-total-count"];
    expect(await count("product=PLN%20Protein%20Bar")).toBe("1");
    expect(await count("po=NOPE")).toBe("0");
    expect(await count("short=No")).toBe("0");
    expect(await count("status=Pending")).toBe("1");
    const opt = await request(app).get("/api/inventory/my-store/production-requests/options?field=product").set(authHeader(storeA));
    expect(opt.body.values).toEqual(["PLN Protein Bar"]);
    expect((await request(app).get("/api/inventory/material-requests/options?field=product&kind=plan").set(authHeader(warehouse))).body.values).toEqual([]);
  });
});
