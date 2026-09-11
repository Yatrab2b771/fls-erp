import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

async function createItemWithStock(storeToken: string, quantity: number, unit = "Kg") {
  const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: `RND Sample Item ${Math.random().toString(36).slice(2)}` });
  await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: item.body.id, type: "RECEIVED", date: "2026-09-01", unit, quantity, isOpeningStock: true });
  return item.body.id as string;
}

// The real trigger for step 1 per the client: R&D asks Store for material
// (RndSampleRequest), Store fulfills it — that's what actually creates the
// RndTransfer(TO_RND). Returns the fulfilled request body.
async function requestAndFulfill(rndToken: string, storeToken: string, itemId: string, quantity: number, unit = "Kg", note?: string) {
  const req = await request(app).post("/api/rnd-store/requests").set(authHeader(rndToken)).send({ itemId, quantity, unit, note });
  return request(app).post(`/api/rnd-store/requests/${req.body.id}/fulfill`).set(authHeader(storeToken));
}

describe("R&D Store — the full 6-step sample lifecycle", () => {
  it("R&D requests -> Store fulfills -> R&D confirms -> research consumption + customer dispatch -> back to Warehouse, each step moving the right ledger", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: rndToken } = await createUser(["RND"]);
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "R&D Sample Customer" });

    const itemId = await createItemWithStock(storeToken, 100);

    // Step 1 — R&D asks, Store fulfills. Warehouse stock drops immediately on fulfillment.
    const fulfilled = await requestAndFulfill(rndToken, storeToken, itemId, 30, "Kg", "Trial batch");
    expect(fulfilled.status).toBe(200);
    expect(fulfilled.body.status).toBe("FULFILLED");
    const transferId = fulfilled.body.transferId as string;

    const warehouseAfterSend = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
    const row = warehouseAfterSend.body.find((r: { item: { id: string } }) => r.item.id === itemId);
    expect(row.onHand).toBe(70); // 100 - 30

    // R&D Store has nothing yet — only confirming creates its side.
    const rndStockBeforeConfirm = await request(app).get("/api/rnd-store/stock").set(authHeader(rndToken));
    expect(rndStockBeforeConfirm.body.find((r: { item: { id: string } }) => r.item.id === itemId)).toBeUndefined();

    // Step 2 — R&D confirms receipt. R&D Store stock increases.
    const confirmInbound = await request(app).post(`/api/rnd-store/transfers/${transferId}/confirm`).set(authHeader(rndToken));
    expect(confirmInbound.status).toBe(200);
    expect(confirmInbound.body.status).toBe("CONFIRMED");

    // Confirming twice is refused.
    const doubleConfirm = await request(app).post(`/api/rnd-store/transfers/${transferId}/confirm`).set(authHeader(rndToken));
    expect(doubleConfirm.status).toBe(409);

    let rndStock = await request(app).get("/api/rnd-store/stock").set(authHeader(rndToken));
    expect(rndStock.body.find((r: { item: { id: string } }) => r.item.id === itemId).onHand).toBe(30);

    // Step 3 — research consumes some, wastes some, rejects some.
    const used = await request(app).post("/api/rnd-store/consume").set(authHeader(rndToken)).send({ itemId, quantity: 10, unit: "Kg", reason: "TESTING" });
    expect(used.status).toBe(201);
    const wastage = await request(app).post("/api/rnd-store/consume").set(authHeader(rndToken)).send({ itemId, quantity: 3, unit: "Kg", reason: "WASTAGE" });
    expect(wastage.status).toBe(201);
    const rejected = await request(app).post("/api/rnd-store/consume").set(authHeader(rndToken)).send({ itemId, quantity: 2, unit: "Kg", reason: "REJECTED" });
    expect(rejected.status).toBe(201);

    rndStock = await request(app).get("/api/rnd-store/stock").set(authHeader(rndToken));
    expect(rndStock.body.find((r: { item: { id: string } }) => r.item.id === itemId).onHand).toBe(15); // 30 - 10 - 3 - 2

    // Step 4 — a sample goes straight to the customer.
    const dispatched = await request(app)
      .post("/api/rnd-store/dispatch")
      .set(authHeader(rndToken))
      .send({ itemId, quantity: 5, unit: "Kg", customerId: customer.body.id, note: "Client sample" });
    expect(dispatched.status).toBe(201);

    rndStock = await request(app).get("/api/rnd-store/stock").set(authHeader(rndToken));
    expect(rndStock.body.find((r: { item: { id: string } }) => r.item.id === itemId).onHand).toBe(10); // 15 - 5

    // Step 5 — leftover (10 Kg) sent back to the Warehouse. R&D stock drops immediately.
    const returnTransfer = await request(app).post("/api/rnd-store/transfers").set(authHeader(rndToken)).send({ direction: "TO_WAREHOUSE", itemId, quantity: 10, unit: "Kg" });
    expect(returnTransfer.status).toBe(201);
    expect(returnTransfer.body.status).toBe("PENDING");

    rndStock = await request(app).get("/api/rnd-store/stock").set(authHeader(rndToken));
    expect(rndStock.body.find((r: { item: { id: string } }) => r.item.id === itemId)).toBeUndefined(); // net 0, filtered out

    // Warehouse hasn't received it yet — still 70.
    let warehouseStock = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
    expect(warehouseStock.body.find((r: { item: { id: string } }) => r.item.id === itemId).onHand).toBe(70);

    // Step 6 — Store confirms receipt. No QC gate — straight back into stock.
    const confirmReturn = await request(app).post(`/api/rnd-store/transfers/${returnTransfer.body.id}/confirm`).set(authHeader(storeToken));
    expect(confirmReturn.status).toBe(200);
    expect(confirmReturn.body.status).toBe("CONFIRMED");

    warehouseStock = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
    expect(warehouseStock.body.find((r: { item: { id: string } }) => r.item.id === itemId).onHand).toBe(80); // 70 + 10, no QC pending anywhere

    const txns = await request(app).get("/api/inventory/transactions").set(authHeader(storeToken));
    const returnTxn = txns.body.find((t: { itemId: string; isRndReturn: boolean }) => t.itemId === itemId && t.isRndReturn);
    expect(returnTxn.receiptStatus).toBe("ACCEPTED"); // skipped PENDING_QC entirely

    // The advance tracking report ties every gram together.
    const report = await request(app).get("/api/rnd-store/report").set(authHeader(rndToken));
    const reportRow = report.body.find((r: { itemId: string }) => r.itemId === itemId);
    expect(reportRow).toMatchObject({ inboundQty: 30, testingQty: 10, wastageQty: 3, rejectedQty: 2, dispatchedQty: 5, returnedQty: 10, onHand: 0 });
  });
});

describe("R&D Store — sample requests (R&D asks, Store fulfills/rejects)", () => {
  it("only R&D can raise a request, only Store can fulfill it, and Store can no longer push a sample directly", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: rndToken } = await createUser(["RND"]);
    const itemId = await createItemWithStock(storeToken, 50);

    // Store can no longer create a TO_RND transfer directly — must go through a request.
    const directPush = await request(app).post("/api/rnd-store/transfers").set(authHeader(storeToken)).send({ direction: "TO_RND", itemId, quantity: 10, unit: "Kg" });
    expect(directPush.status).toBe(403);

    const deniedRequest = await request(app).post("/api/rnd-store/requests").set(authHeader(storeToken)).send({ itemId, quantity: 10, unit: "Kg" });
    expect(deniedRequest.status).toBe(403);

    const req = await request(app).post("/api/rnd-store/requests").set(authHeader(rndToken)).send({ itemId, quantity: 10, unit: "Kg", note: "For client trial" });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe("PENDING");

    const deniedFulfill = await request(app).post(`/api/rnd-store/requests/${req.body.id}/fulfill`).set(authHeader(rndToken));
    expect(deniedFulfill.status).toBe(403);

    const fulfilled = await request(app).post(`/api/rnd-store/requests/${req.body.id}/fulfill`).set(authHeader(storeToken));
    expect(fulfilled.status).toBe(200);
    expect(fulfilled.body.status).toBe("FULFILLED");
    expect(fulfilled.body.transferId).toBeTruthy();

    // Already fulfilled — can't fulfill or reject again.
    const reFulfill = await request(app).post(`/api/rnd-store/requests/${req.body.id}/fulfill`).set(authHeader(storeToken));
    expect(reFulfill.status).toBe(409);

    const deniedConfirm = await request(app).post(`/api/rnd-store/transfers/${fulfilled.body.transferId}/confirm`).set(authHeader(storeToken));
    expect(deniedConfirm.status).toBe(403);

    const confirm = await request(app).post(`/api/rnd-store/transfers/${fulfilled.body.transferId}/confirm`).set(authHeader(rndToken));
    expect(confirm.status).toBe(200);
  });

  it("Store can reject a request with a reason, and R&D can cancel its own still-pending request", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: rndToken } = await createUser(["RND"]);
    const itemId = await createItemWithStock(storeToken, 50);

    const req1 = await request(app).post("/api/rnd-store/requests").set(authHeader(rndToken)).send({ itemId, quantity: 5, unit: "Kg" });
    const rejected = await request(app).post(`/api/rnd-store/requests/${req1.body.id}/reject`).set(authHeader(storeToken)).send({ reason: "Not enough stock for this quarter" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("REJECTED");
    expect(rejected.body.rejectionReason).toBe("Not enough stock for this quarter");

    const req2 = await request(app).post("/api/rnd-store/requests").set(authHeader(rndToken)).send({ itemId, quantity: 5, unit: "Kg" });
    const deniedCancel = await request(app).post(`/api/rnd-store/requests/${req2.body.id}/cancel`).set(authHeader(storeToken));
    expect(deniedCancel.status).toBe(403);

    const cancelled = await request(app).post(`/api/rnd-store/requests/${req2.body.id}/cancel`).set(authHeader(rndToken));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("CANCELLED");

    const reCancel = await request(app).post(`/api/rnd-store/requests/${req2.body.id}/cancel`).set(authHeader(rndToken));
    expect(reCancel.status).toBe(409);
  });
});

describe("R&D Store — bulk request import", () => {
  it("only RND can import, matches existing items by name+category and creates new ones, and every row lands PENDING", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: rndToken } = await createUser(["RND"]);
    const existingItem = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Bulk Import Existing Item" });

    const deniedImport = await request(app)
      .post("/api/rnd-store/requests/import")
      .set(authHeader(storeToken))
      .send({ rows: [{ category: "RM", itemName: existingItem.body.name, quantity: 5, unit: "Kg" }] });
    expect(deniedImport.status).toBe(403);

    const imported = await request(app)
      .post("/api/rnd-store/requests/import")
      .set(authHeader(rndToken))
      .send({
        rows: [
          { category: "RM", itemName: existingItem.body.name, quantity: 5, unit: "Kg", note: "Row 1" },
          { category: "PM", itemName: "Bulk Import Brand New Item", quantity: 200, unit: "Count", note: "Row 2" },
        ],
      });
    expect(imported.status).toBe(201);
    expect(imported.body).toEqual({ requestsCreated: 2, itemsCreated: 1 }); // only the PM item is new

    const requests = await request(app).get("/api/rnd-store/requests?status=PENDING").set(authHeader(rndToken));
    const importedRows = requests.body.filter((r: { note: string }) => r.note === "Row 1" || r.note === "Row 2");
    expect(importedRows).toHaveLength(2);
    expect(importedRows.every((r: { status: string }) => r.status === "PENDING")).toBe(true);
  });
});

describe("R&D Store — role gates and stock guards", () => {
  it("only RND can send back to Warehouse, only STORE can confirm it", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: rndToken } = await createUser(["RND"]);
    const itemId = await createItemWithStock(storeToken, 50);
    const fulfilled = await requestAndFulfill(rndToken, storeToken, itemId, 20, "Kg");
    await request(app).post(`/api/rnd-store/transfers/${fulfilled.body.transferId}/confirm`).set(authHeader(rndToken));

    const deniedReturn = await request(app).post("/api/rnd-store/transfers").set(authHeader(storeToken)).send({ direction: "TO_WAREHOUSE", itemId, quantity: 5, unit: "Kg" });
    expect(deniedReturn.status).toBe(403);

    const ret = await request(app).post("/api/rnd-store/transfers").set(authHeader(rndToken)).send({ direction: "TO_WAREHOUSE", itemId, quantity: 5, unit: "Kg" });
    expect(ret.status).toBe(201);

    const deniedConfirm = await request(app).post(`/api/rnd-store/transfers/${ret.body.id}/confirm`).set(authHeader(rndToken));
    expect(deniedConfirm.status).toBe(403);

    const confirm = await request(app).post(`/api/rnd-store/transfers/${ret.body.id}/confirm`).set(authHeader(storeToken));
    expect(confirm.status).toBe(200);
  });

  it("can't fulfill, consume, or dispatch more than what's actually on hand at each ledger", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: rndToken } = await createUser(["RND"]);
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Overdraw Customer" });
    const itemId = await createItemWithStock(storeToken, 10);

    const overFulfill = await requestAndFulfill(rndToken, storeToken, itemId, 999, "Kg");
    expect(overFulfill.status).toBe(409);

    const fulfilled = await requestAndFulfill(rndToken, storeToken, itemId, 10, "Kg");
    await request(app).post(`/api/rnd-store/transfers/${fulfilled.body.transferId}/confirm`).set(authHeader(rndToken));

    const overConsume = await request(app).post("/api/rnd-store/consume").set(authHeader(rndToken)).send({ itemId, quantity: 999, unit: "Kg", reason: "TESTING" });
    expect(overConsume.status).toBe(409);

    const overDispatch = await request(app).post("/api/rnd-store/dispatch").set(authHeader(rndToken)).send({ itemId, quantity: 999, unit: "Kg", customerId: customer.body.id });
    expect(overDispatch.status).toBe(409);

    const overReturn = await request(app).post("/api/rnd-store/transfers").set(authHeader(rndToken)).send({ direction: "TO_WAREHOUSE", itemId, quantity: 999, unit: "Kg" });
    expect(overReturn.status).toBe(409);
  });
});
