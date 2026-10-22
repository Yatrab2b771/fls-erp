import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

/** A Warehouse seat, a Day Store login (store A), PPIC and Purchase; 60 Kg of Cocoa in the Warehouse. */
async function setup() {
  const { token: warehouse, user } = await createUser(["STORE"]);
  const { token: storeA, user: userA } = await createUser(["STORE"]);
  const { token: ppic } = await createUser(["PPIC"]);
  const { token: purchase } = await createUser(["PURCHASE"]);
  const cocoa = await prisma.inventoryItem.create({ data: { category: "RM", name: "MRQ Cocoa", unit: "Kg" } });
  const a = await prisma.dayStore.create({ data: { name: "MRQ Store A", createdById: user.id } });
  await prisma.plant.create({ data: { name: "MRQ Store A", createdById: user.id, dayStoreId: a.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: userA.id, dayStoreId: a.id } });
  await prisma.inventoryTransaction.create({
    data: { itemId: cocoa.id, createdById: user.id, date: new Date(), unit: "Kg", type: "RECEIVED", quantity: 60, vendorName: "V", receiptStatus: "ACCEPTED", acceptedById: user.id, acceptedAt: new Date() },
  });
  return { warehouse, storeA, ppic, purchase, cocoa, a };
}

describe("Material Requests from Stores - Warehouse issue, short -> PPIC -> Purchase", () => {
  it("a Store asks, the Warehouse approves and part-issues, then the short balance goes PPIC -> Purchase -> On order", async () => {
    const { warehouse, storeA, ppic, purchase, cocoa, a } = await setup();
    const get = (token: string, path: string) => request(app).get(`/api/inventory${path}`).set(authHeader(token));

    // The Day Store asks for 100 Kg
    const created = await request(app).post("/api/inventory/my-store/requests").set(authHeader(storeA)).send({ itemId: cocoa.id, requestedQty: 100, note: "for trials" });
    expect(created.status).toBe(201);
    const requestId = created.body.id as string;

    // The Warehouse sees it as open and short (60 on hand, 100 asked)
    const list = await get(warehouse, "/material-requests?requester=MRQ%20Store%20A");
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ source: "store", requesterName: "MRQ Store A", requestedQty: 100, remainingQty: 100, status: "Pending", warehouseOnHand: 60, short: true, shortBy: 40, supply: "NONE" });
    expect((await get(warehouse, "/material-requests/summary")).body.open).toBeGreaterThanOrEqual(1);

    // A Day Store login can neither see the Warehouse queue, nor review, nor issue to itself
    expect((await get(storeA, "/material-requests")).status).toBe(403);
    expect((await request(app).patch(`/api/inventory/requests/${requestId}/review`).set(authHeader(storeA)).send({ action: "APPROVE" })).status).toBe(403);

    // Warehouse approves and issues what it has (60) - always into the store that asked
    expect((await request(app).patch(`/api/inventory/requests/${requestId}/review`).set(authHeader(warehouse)).send({ action: "APPROVE" })).status).toBe(200);
    const issue = await request(app).post(`/api/inventory/requests/${requestId}/issue`).set(authHeader(warehouse)).send({ date: "2026-10-05", unit: "Kg", quantity: 60, dayStoreId: null });
    expect(issue.status).toBe(201);
    expect(issue.body.dayStoreId).toBe(a.id);
    expect((await request(app).post(`/api/inventory/requests/${requestId}/issue`).set(authHeader(storeA)).send({ date: "2026-10-05", unit: "Kg", quantity: 10, dayStoreId: null })).status).toBe(403);

    const afterIssue = (await get(warehouse, "/material-requests?requester=MRQ%20Store%20A")).body[0];
    expect(afterIssue).toMatchObject({ status: "Partly issued", issuedQty: 60, remainingQty: 40, warehouseOnHand: 0, short: true, shortBy: 40 });

    // Short -> escalate to PPIC (once)
    const escalate = await request(app).post(`/api/inventory/material-requests/store/${requestId}/escalate`).set(authHeader(warehouse));
    expect(escalate.status).toBe(201);
    expect((await request(app).post(`/api/inventory/material-requests/store/${requestId}/escalate`).set(authHeader(warehouse))).status).toBe(409);
    expect((await get(warehouse, "/material-requests?requester=MRQ%20Store%20A")).body[0]).toMatchObject({ supply: "WITH_PPIC", supplyLabel: "With PPIC" });

    // PPIC sees it (tagged to the request); Purchase does not yet
    const ppicList = await request(app).get("/api/inventory/requirements").set(authHeader(ppic));
    const need = ppicList.body.find((r: { id: string }) => r.id === escalate.body.requirementId);
    expect(need).toMatchObject({ itemId: cocoa.id, shortQty: 40, sourceRequestId: requestId });
    const purchaseBefore = await request(app).get("/api/inventory/requirements").set(authHeader(purchase));
    expect(purchaseBefore.body.find((r: { id: string }) => r.id === escalate.body.requirementId)).toBeUndefined();

    // PPIC sends it to Purchase -> Purchase sees it and logs a PI
    expect((await request(app).post(`/api/inventory/requirements/${escalate.body.requirementId}/notify-purchase`).set(authHeader(ppic))).status).toBe(200);
    expect((await get(warehouse, "/material-requests?requester=MRQ%20Store%20A")).body[0].supply).toBe("WITH_PURCHASE");
    const purchaseAfter = await request(app).get("/api/inventory/requirements").set(authHeader(purchase));
    expect(purchaseAfter.body.find((r: { id: string }) => r.id === escalate.body.requirementId)).toBeDefined();

    const pi = await request(app).patch(`/api/inventory/requirements/${escalate.body.requirementId}/purchase`).set(authHeader(purchase)).send({ poNumber: "MRQ-PI-1", vendorName: "MRQ Vendor", eta: "2026-10-20" });
    expect(pi.status).toBe(200);
    const onOrder = (await get(warehouse, "/material-requests?requester=MRQ%20Store%20A")).body[0];
    expect(onOrder).toMatchObject({ supply: "ON_ORDER", piNumber: "MRQ-PI-1" });
    expect(onOrder.eta).toContain("2026-10-20");

    // The Day Store follows the same trail on its own list
    const mine = await get(storeA, "/my-store/requests");
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({ supply: "ON_ORDER", issuedQty: 60, remainingQty: 40 });
    expect((await get(storeA, "/my-store/summary")).body.requests).toBe(1);
  });

  it("filters, and refuses to escalate a request the Warehouse can fill", async () => {
    const { warehouse, storeA, cocoa } = await setup();
    const created = await request(app).post("/api/inventory/my-store/requests").set(authHeader(storeA)).send({ itemId: cocoa.id, requestedQty: 20 }); // 60 on hand: not short
    const id = created.body.id as string;
    const count = async (qs: string) => (await request(app).get(`/api/inventory/material-requests?requester=MRQ%20Store%20A&${qs}`).set(authHeader(warehouse))).headers["x-total-count"];

    expect(await count("short=No")).toBe("1");
    expect(await count("short=Yes")).toBe("0");
    expect(await count("category=PM")).toBe("0");
    expect(await count("status=Pending")).toBe("1");
    expect(await count("status=Issued")).toBe("0");
    expect(await count("supply=With%20PPIC")).toBe("0");
    expect(await count(`dateFrom=2999-01-01`)).toBe("0");
    expect(await count("aging=0-7%20days")).toBe("1");

    expect((await request(app).post(`/api/inventory/material-requests/store/${id}/escalate`).set(authHeader(warehouse))).status).toBe(409); // has enough stock
    const opt = await request(app).get("/api/inventory/material-requests/options?field=requester&q=MRQ").set(authHeader(warehouse));
    expect(opt.body.values).toEqual(["MRQ Store A"]);
    expect((await request(app).get("/api/inventory/material-requests/options?field=nope").set(authHeader(warehouse))).status).toBe(400);
  });
});
