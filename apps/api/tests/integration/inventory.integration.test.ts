import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("Inventory module", () => {
  it("item creation is restricted to STORE (ADMIN bypasses)", async () => {
    const { token: plainToken } = await createUser([]);
    const denied = await request(app).post("/api/inventory/items").set(authHeader(plainToken)).send({ category: "RM", name: "Whey Protein" });
    expect(denied.status).toBe(403);

    const { token: storeToken } = await createUser(["STORE"]);
    const asStore = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein", unit: "Kg" });
    expect(asStore.status).toBe(201);
    expect(asStore.body.category).toBe("RM");

    const { token: adminToken } = await createUser(["ADMIN"]);
    const asAdmin = await request(app).post("/api/inventory/items").set(authHeader(adminToken)).send({ category: "PM", name: "Jar 500ml" });
    expect(asAdmin.status).toBe(201);
  });

  it("rejects a duplicate item name within the same category", async () => {
    const { token } = await createUser(["STORE"]);
    await request(app).post("/api/inventory/items").set(authHeader(token)).send({ category: "RM", name: "Whey Protein" });
    const dup = await request(app).post("/api/inventory/items").set(authHeader(token)).send({ category: "RM", name: "Whey Protein" });
    expect(dup.status).toBe(409);
  });

  it("read access (items, stock, transactions) is locked to STORE/ADMIN — not open to every authenticated user", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein", unit: "Kg" });

    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 100, vendorName: "Acme Vendor" });

    // A plain authenticated user (any other department) is denied outright.
    const { token: plainToken } = await createUser([]);
    const deniedItems = await request(app).get("/api/inventory/items").set(authHeader(plainToken));
    expect(deniedItems.status).toBe(403);
    const deniedStock = await request(app).get("/api/inventory/stock").set(authHeader(plainToken));
    expect(deniedStock.status).toBe(403);
    const deniedTxns = await request(app).get("/api/inventory/transactions").set(authHeader(plainToken));
    expect(deniedTxns.status).toBe(403);

    // Store and Admin both read fine.
    const items = await request(app).get("/api/inventory/items").set(authHeader(storeToken));
    expect(items.status).toBe(200);
    expect(items.body.length).toBe(1);

    const { token: adminToken } = await createUser(["ADMIN"]);
    const txns = await request(app).get("/api/inventory/transactions").set(authHeader(adminToken));
    expect(txns.status).toBe(200);
    expect(txns.body.length).toBe(1);
    expect(txns.body[0].item.name).toBe("Whey Protein");
  });

  it("computes stock on hand as sum(RECEIVED) - sum(ISSUED_DAY_STORE) - sum(ISSUED_PRODUCTION) per item", async () => {
    const { token } = await createUser(["STORE"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(token)).send({ category: "RM", name: "Whey Protein", unit: "Kg" });
    const itemId = item.body.id;

    // A RECEIVED row only counts once it clears inward QC and Store
    // accepts it — see the dedicated "Inward QC gate" describe block.
    const r1 = await request(app).post("/api/inventory/transactions").set(authHeader(token)).send({ itemId, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 100 });
    await request(app).patch(`/api/inventory/transactions/${r1.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });
    await request(app).post(`/api/inventory/transactions/${r1.body.id}/accept`).set(authHeader(token));

    const r2 = await request(app).post("/api/inventory/transactions").set(authHeader(token)).send({ itemId, type: "RECEIVED", date: "2026-08-02", unit: "Kg", quantity: 50 });
    await request(app).patch(`/api/inventory/transactions/${r2.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });
    await request(app).post(`/api/inventory/transactions/${r2.body.id}/accept`).set(authHeader(token));

    await request(app).post("/api/inventory/transactions").set(authHeader(token)).send({ itemId, type: "ISSUED_DAY_STORE", date: "2026-08-03", unit: "Kg", quantity: 30 });

    // ISSUED_PRODUCTION can only reach the ledger through an approved
    // Material Request — see the dedicated describe block below.
    const req = await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId, category: "RM", requestedQty: 20, purpose: "ISSUED_PRODUCTION" });
    await request(app).patch(`/api/inventory/requests/${req.body.id}/review`).set(authHeader(token)).send({ action: "APPROVE" });
    await request(app).post(`/api/inventory/requests/${req.body.id}/issue`).set(authHeader(token)).send({ date: "2026-08-04", unit: "Kg", quantity: 20, dayStoreId: null });

    const stock = await request(app).get("/api/inventory/stock").set(authHeader(token));
    expect(stock.status).toBe(200);
    expect(stock.body).toEqual([
      expect.objectContaining({ receivedQty: 150, issuedDayStoreQty: 30, issuedProductionQty: 20, issuedQty: 50, onHand: 100 }),
    ]);
  });

  describe("concurrent issues can't jointly overdraw stock (SERIALIZABLE gate)", () => {
    it("two Store users issuing the same item to a Day Store at once: exactly one succeeds, the other is rejected, stock never goes negative", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: qaToken } = await createUser(["QA_QC"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
      const itemId = item.body.id;

      // Only 10 on hand — two concurrent requests each ask for 10. A
      // check-then-write race would let both read "10 on hand" before
      // either write lands and let both through; the SERIALIZABLE
      // transaction (see runSerializable) must let only one commit.
      const r = await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 10 });
      await request(app).patch(`/api/inventory/transactions/${r.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });
      await request(app).post(`/api/inventory/transactions/${r.body.id}/accept`).set(authHeader(storeToken));

      const issue = () =>
        request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId, type: "ISSUED_DAY_STORE", date: "2026-08-02", unit: "Kg", quantity: 10 });
      const [a, b] = await Promise.all([issue(), issue()]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);

      const stock = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
      const row = stock.body.find((s: { item: { id: string } }) => s.item.id === itemId);
      expect(row.onHand).toBe(0);
    });

    it("two Store users issuing against the same Material Request at once: exactly one fulfillment is created, the request's remaining balance stays correct", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: ppicToken } = await createUser(["PPIC"]);
      const { token: qaToken } = await createUser(["QA_QC"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
      const itemId = item.body.id;

      const r = await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 10 });
      await request(app).patch(`/api/inventory/transactions/${r.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });
      await request(app).post(`/api/inventory/transactions/${r.body.id}/accept`).set(authHeader(storeToken));

      const reqRow = await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId, category: "RM", requestedQty: 10, purpose: "ISSUED_PRODUCTION" });
      await request(app).patch(`/api/inventory/requests/${reqRow.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });

      const issue = () =>
        request(app)
          .post(`/api/inventory/requests/${reqRow.body.id}/issue`)
          .set(authHeader(storeToken))
          .send({ date: "2026-08-02", unit: "Kg", quantity: 10, dayStoreId: null });
      const [a, b] = await Promise.all([issue(), issue()]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);

      const final = await request(app).get("/api/inventory/requests").set(authHeader(storeToken));
      const row = final.body.find((r: { id: string }) => r.id === reqRow.body.id);
      expect(row.status).toBe("ISSUED");
      expect(row.issuedQty).toBe(10);
      expect(row.remainingQty).toBe(0);
    });
  });

  it("rejects a transaction against an unknown item", async () => {
    const { token } = await createUser(["STORE"]);
    const res = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(token))
      .send({ itemId: "00000000-0000-0000-0000-000000000000", type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 10 });
    expect(res.status).toBe(400);
  });

  it("transaction deletion is restricted to STORE (ADMIN bypasses)", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    const txn = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 10 });

    const { token: plainToken } = await createUser([]);
    const denied = await request(app).delete(`/api/inventory/transactions/${txn.body.id}`).set(authHeader(plainToken));
    expect(denied.status).toBe(403);

    const ok = await request(app).delete(`/api/inventory/transactions/${txn.body.id}`).set(authHeader(storeToken));
    expect(ok.status).toBe(204);
  });

  it("blocks deleting an ACCEPTED Received entry that other issues already depend on — deletion would send stock negative", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });

    const received = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 100, isOpeningStock: true });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "ISSUED_DAY_STORE", date: "2026-08-02", unit: "Kg", quantity: 80 });

    // 80 of the 100 already left the shelf — deleting the only RECEIVED
    // row would leave stock at -80.
    const blocked = await request(app).delete(`/api/inventory/transactions/${received.body.id}`).set(authHeader(storeToken));
    expect(blocked.status).toBe(409);

    const stock = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
    expect(stock.body[0].onHand).toBe(20); // untouched — the delete never happened

    // A second RECEIVED row not otherwise depended on deletes cleanly.
    const spare = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-03", unit: "Kg", quantity: 5, isOpeningStock: true });
    const okDelete = await request(app).delete(`/api/inventory/transactions/${spare.body.id}`).set(authHeader(storeToken));
    expect(okDelete.status).toBe(204);

    // A RECEIVED row still PENDING_QC (never counted toward stock) deletes freely, no matter the quantity.
    const pending = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-04", unit: "Kg", quantity: 999 });
    const pendingDelete = await request(app).delete(`/api/inventory/transactions/${pending.body.id}`).set(authHeader(storeToken));
    expect(pendingDelete.status).toBe(204);
  });

  it("logs and lists FG / Bill transfers to Dispatch, keyed to a real customer", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });

    const fg = await request(app)
      .post("/api/inventory/dispatch-transfers")
      .set(authHeader(storeToken))
      .send({ type: "FG", date: "2026-08-10", customerId: customer.body.id, productName: "Whey Protein 1Kg Jar", quantity: 200 });
    expect(fg.status).toBe(201);
    expect(fg.body.customer.companyName).toBe("Acme Nutrition Pvt. Ltd.");

    const bill = await request(app)
      .post("/api/inventory/dispatch-transfers")
      .set(authHeader(storeToken))
      .send({ type: "BILL", date: "2026-08-11", customerId: customer.body.id, productName: "Whey Protein 1Kg Jar", quantity: 200 });
    expect(bill.status).toBe(201);

    const fgList = await request(app).get("/api/inventory/dispatch-transfers?type=FG").set(authHeader(storeToken));
    expect(fgList.status).toBe(200);
    expect(fgList.body.length).toBe(1);
    expect(fgList.body[0].type).toBe("FG");

    const rejectUnknownCustomer = await request(app)
      .post("/api/inventory/dispatch-transfers")
      .set(authHeader(storeToken))
      .send({ type: "FG", date: "2026-08-10", customerId: "00000000-0000-0000-0000-000000000000", productName: "X", quantity: 1 });
    expect(rejectUnknownCustomer.status).toBe(400);
  });

  describe("Material Requests — the department-wise gate on Issued to Production", () => {
    it("blocks a direct ISSUED_PRODUCTION entry — it must come from an approved request", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });

      const direct = await request(app)
        .post("/api/inventory/transactions")
        .set(authHeader(storeToken))
        .send({ itemId: item.body.id, type: "ISSUED_PRODUCTION", date: "2026-08-01", unit: "Kg", quantity: 10 });
      expect(direct.status).toBe(400);

      // ADMIN can still bypass, same override pattern as the Batch pipeline's JUMP action.
      const { token: adminToken } = await createUser(["ADMIN"]);
      const asAdmin = await request(app)
        .post("/api/inventory/transactions")
        .set(authHeader(adminToken))
        .send({ itemId: item.body.id, type: "ISSUED_PRODUCTION", date: "2026-08-01", unit: "Kg", quantity: 10 });
      expect(asAdmin.status).toBe(201);
    });

    it("only PPIC can raise a request; only Store can review or issue it", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: ppicToken } = await createUser(["PPIC"]);
      const { token: plainToken } = await createUser([]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
      await request(app)
        .post("/api/inventory/transactions")
        .set(authHeader(storeToken))
        .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 10, isOpeningStock: true });

      const deniedCreate = await request(app)
        .post("/api/inventory/requests")
        .set(authHeader(plainToken))
        .send({ itemId: item.body.id, category: "RM", requestedQty: 10, purpose: "ISSUED_PRODUCTION" });
      expect(deniedCreate.status).toBe(403);

      const created = await request(app)
        .post("/api/inventory/requests")
        .set(authHeader(ppicToken))
        .send({ itemId: item.body.id, category: "RM", requestedQty: 10, purpose: "ISSUED_PRODUCTION" });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe("PENDING");

      const deniedReview = await request(app).patch(`/api/inventory/requests/${created.body.id}/review`).set(authHeader(ppicToken)).send({ action: "APPROVE" });
      expect(deniedReview.status).toBe(403);

      const approved = await request(app).patch(`/api/inventory/requests/${created.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe("APPROVED");

      const deniedIssue = await request(app).post(`/api/inventory/requests/${created.body.id}/issue`).set(authHeader(ppicToken)).send({ date: "2026-08-01", unit: "Kg", quantity: 10 });
      expect(deniedIssue.status).toBe(403);

      const issued = await request(app)
        .post(`/api/inventory/requests/${created.body.id}/issue`)
        .set(authHeader(storeToken))
        .send({ date: "2026-08-01", unit: "Kg", quantity: 10, dayStoreId: null });
      expect(issued.status).toBe(201);
      expect(issued.body.type).toBe("ISSUED_PRODUCTION");

      const doubleIssue = await request(app)
        .post(`/api/inventory/requests/${created.body.id}/issue`)
        .set(authHeader(storeToken))
        .send({ date: "2026-08-01", unit: "Kg", quantity: 10, dayStoreId: null });
      expect(doubleIssue.status).toBe(409);
    });

    it("supports issuing a request in parts — stays open with a remaining balance until fully covered", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: ppicToken } = await createUser(["PPIC"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });

      // Issuing checks live stock, not just the request's own remaining
      // balance — give the item real stock via Opening Stock first.
      await request(app)
        .post("/api/inventory/transactions")
        .set(authHeader(storeToken))
        .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 300, isOpeningStock: true });

      const created = await request(app)
        .post("/api/inventory/requests")
        .set(authHeader(ppicToken))
        .send({ itemId: item.body.id, category: "RM", requestedQty: 300, purpose: "ISSUED_PRODUCTION" });
      expect(created.body.issuedQty).toBe(0);
      expect(created.body.remainingQty).toBe(300);
      await request(app).patch(`/api/inventory/requests/${created.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });

      // Can't issue more than what's actually left.
      const tooMuch = await request(app)
        .post(`/api/inventory/requests/${created.body.id}/issue`)
        .set(authHeader(storeToken))
        .send({ date: "2026-08-01", unit: "Kg", quantity: 301, dayStoreId: null });
      expect(tooMuch.status).toBe(400);

      const firstIssue = await request(app)
        .post(`/api/inventory/requests/${created.body.id}/issue`)
        .set(authHeader(storeToken))
        .send({ date: "2026-08-01", unit: "Kg", quantity: 150, dayStoreId: null });
      expect(firstIssue.status).toBe(201);

      const afterFirst = await request(app).get("/api/inventory/requests").set(authHeader(ppicToken));
      const row = afterFirst.body.find((r: { id: string }) => r.id === created.body.id);
      expect(row.status).toBe("PARTIALLY_ISSUED");
      expect(row.issuedQty).toBe(150);
      expect(row.remainingQty).toBe(150);
      expect(row.fulfillments).toHaveLength(1);

      // Still can't exceed the new remaining balance.
      const stillTooMuch = await request(app)
        .post(`/api/inventory/requests/${created.body.id}/issue`)
        .set(authHeader(storeToken))
        .send({ date: "2026-08-05", unit: "Kg", quantity: 151, dayStoreId: null });
      expect(stillTooMuch.status).toBe(400);

      // Withdrawing a partially-issued request is blocked — real ledger transactions exist against it.
      const deniedDelete = await request(app).delete(`/api/inventory/requests/${created.body.id}`).set(authHeader(ppicToken));
      expect(deniedDelete.status).toBe(409);

      const secondIssue = await request(app)
        .post(`/api/inventory/requests/${created.body.id}/issue`)
        .set(authHeader(storeToken))
        .send({ date: "2026-08-05", unit: "Kg", quantity: 150, dayStoreId: null });
      expect(secondIssue.status).toBe(201);

      const afterSecond = await request(app).get("/api/inventory/requests").set(authHeader(ppicToken));
      const finalRow = afterSecond.body.find((r: { id: string }) => r.id === created.body.id);
      expect(finalRow.status).toBe("ISSUED");
      expect(finalRow.issuedQty).toBe(300);
      expect(finalRow.remainingQty).toBe(0);
      expect(finalRow.fulfillments).toHaveLength(2);

      const stock = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
      expect(stock.body[0].issuedProductionQty).toBe(300);
    });

    it("blocks issuing more than what's actually on hand, even when the request's own remaining balance allows it", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: ppicToken } = await createUser(["PPIC"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Sucralose Powder" });

      // No stock given at all — PPIC's remainingQty ceiling would happily
      // allow issuing 5, but there's genuinely nothing on the shelf.
      const created = await request(app)
        .post("/api/inventory/requests")
        .set(authHeader(ppicToken))
        .send({ itemId: item.body.id, category: "RM", requestedQty: 5, purpose: "ISSUED_DAY_STORE" });
      await request(app).patch(`/api/inventory/requests/${created.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });

      const blocked = await request(app)
        .post(`/api/inventory/requests/${created.body.id}/issue`)
        .set(authHeader(storeToken))
        .send({ date: "2026-08-01", unit: "Kg", quantity: 5, dayStoreId: null });
      expect(blocked.status).toBe(409);

      const stockAfter = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
      expect(stockAfter.body[0].onHand).toBe(0); // still 0 — nothing actually moved

      // Once real stock exists, the same request can be issued for real.
      await request(app)
        .post("/api/inventory/transactions")
        .set(authHeader(storeToken))
        .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 5, isOpeningStock: true });
      const allowed = await request(app)
        .post(`/api/inventory/requests/${created.body.id}/issue`)
        .set(authHeader(storeToken))
        .send({ date: "2026-08-02", unit: "Kg", quantity: 5, dayStoreId: null });
      expect(allowed.status).toBe(201);
    });

    it("rejecting a request requires a reason, and a rejected request can't be issued", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: ppicToken } = await createUser(["PPIC"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
      const created = await request(app)
        .post("/api/inventory/requests")
        .set(authHeader(ppicToken))
        .send({ itemId: item.body.id, category: "RM", requestedQty: 10, purpose: "ISSUED_PRODUCTION" });

      const missingReason = await request(app).patch(`/api/inventory/requests/${created.body.id}/review`).set(authHeader(storeToken)).send({ action: "REJECT" });
      expect(missingReason.status).toBe(400);

      const rejected = await request(app)
        .patch(`/api/inventory/requests/${created.body.id}/review`)
        .set(authHeader(storeToken))
        .send({ action: "REJECT", rejectionReason: "Not enough stock this week" });
      expect(rejected.status).toBe(200);
      expect(rejected.body.status).toBe("REJECTED");

      const issueRejected = await request(app)
        .post(`/api/inventory/requests/${created.body.id}/issue`)
        .set(authHeader(storeToken))
        .send({ date: "2026-08-01", unit: "Kg", quantity: 10, dayStoreId: null });
      expect(issueRejected.status).toBe(409);
    });

    it("PPIC only sees its own requests; Store/Admin see all", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: ppicToken1 } = await createUser(["PPIC"]);
      const { token: ppicToken2 } = await createUser(["PPIC"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });

      await request(app).post("/api/inventory/requests").set(authHeader(ppicToken1)).send({ itemId: item.body.id, category: "RM", requestedQty: 5, purpose: "ISSUED_PRODUCTION" });
      await request(app).post("/api/inventory/requests").set(authHeader(ppicToken2)).send({ itemId: item.body.id, category: "RM", requestedQty: 7, purpose: "ISSUED_DAY_STORE" });

      const asPpic1 = await request(app).get("/api/inventory/requests").set(authHeader(ppicToken1));
      expect(asPpic1.body.length).toBe(1);
      expect(asPpic1.body[0].requestedQty).toBe(5);

      const asStore = await request(app).get("/api/inventory/requests").set(authHeader(storeToken));
      expect(asStore.body.length).toBe(2);
    });

    it("paginates — page/pageSize query params slice the list and X-Total-Count reports the full count", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: ppicToken } = await createUser(["PPIC"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });

      for (let i = 0; i < 5; i++) {
        await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId: item.body.id, category: "RM", requestedQty: i + 1, purpose: "ISSUED_PRODUCTION" });
      }

      const defaultPage = await request(app).get("/api/inventory/requests").set(authHeader(ppicToken));
      expect(defaultPage.body.length).toBe(5);
      expect(defaultPage.headers["x-total-count"]).toBe("5");
      expect(defaultPage.headers["x-page"]).toBe("1");
      expect(defaultPage.headers["x-page-size"]).toBe("50");

      const firstPage = await request(app).get("/api/inventory/requests?page=1&pageSize=2").set(authHeader(ppicToken));
      expect(firstPage.body.length).toBe(2);
      expect(firstPage.headers["x-total-count"]).toBe("5");

      const secondPage = await request(app).get("/api/inventory/requests?page=2&pageSize=2").set(authHeader(ppicToken));
      expect(secondPage.body.length).toBe(2);

      const thirdPage = await request(app).get("/api/inventory/requests?page=3&pageSize=2").set(authHeader(ppicToken));
      expect(thirdPage.body.length).toBe(1);

      // No overlap between pages.
      const seenIds = new Set([...firstPage.body, ...secondPage.body, ...thirdPage.body].map((r: { id: string }) => r.id));
      expect(seenIds.size).toBe(5);
    });
  });

  describe("Inward QC gate — Material Received", () => {
    it("starts PENDING_QC and doesn't count toward stock until QC-approved and accepted", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: qaToken } = await createUser(["QA_QC"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
      const itemId = item.body.id;

      const created = await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 100 });
      expect(created.body.receiptStatus).toBe("PENDING_QC");

      const stockBefore = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
      expect(stockBefore.body[0].receivedQty).toBe(0);
      expect(stockBefore.body[0].onHand).toBe(0);

      const acceptBeforeQc = await request(app).post(`/api/inventory/transactions/${created.body.id}/accept`).set(authHeader(storeToken));
      expect(acceptBeforeQc.status).toBe(409);

      const approved = await request(app).patch(`/api/inventory/transactions/${created.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });
      expect(approved.status).toBe(200);
      expect(approved.body.receiptStatus).toBe("QC_APPROVED");

      const stockStillPending = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
      expect(stockStillPending.body[0].receivedQty).toBe(0);

      const accepted = await request(app).post(`/api/inventory/transactions/${created.body.id}/accept`).set(authHeader(storeToken));
      expect(accepted.status).toBe(200);
      expect(accepted.body.receiptStatus).toBe("ACCEPTED");

      const stockAfter = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
      expect(stockAfter.body[0].receivedQty).toBe(100);
      expect(stockAfter.body[0].onHand).toBe(100);
    });

    it("two QA_QC users reviewing the same entry at once: exactly one review lands, the other gets a clean 409 instead of silently overwriting it", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: qaToken1 } = await createUser(["QA_QC"]);
      const { token: qaToken2 } = await createUser(["QA_QC"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
      const created = await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 10 });

      const [a, b] = await Promise.all([
        request(app).patch(`/api/inventory/transactions/${created.body.id}/qc`).set(authHeader(qaToken1)).send({ action: "APPROVE" }),
        request(app).patch(`/api/inventory/transactions/${created.body.id}/qc`).set(authHeader(qaToken2)).send({ action: "APPROVE" }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);

      // Two concurrent accepts on the same now-QC_APPROVED row: same story.
      const [x, y] = await Promise.all([
        request(app).post(`/api/inventory/transactions/${created.body.id}/accept`).set(authHeader(storeToken)),
        request(app).post(`/api/inventory/transactions/${created.body.id}/accept`).set(authHeader(storeToken)),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
    });

    it("is role-gated: only QA_QC reviews, only Store accepts", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: qaToken } = await createUser(["QA_QC"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
      const created = await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 10 });

      const deniedQc = await request(app).patch(`/api/inventory/transactions/${created.body.id}/qc`).set(authHeader(storeToken)).send({ action: "APPROVE" });
      expect(deniedQc.status).toBe(403);

      await request(app).patch(`/api/inventory/transactions/${created.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });

      const deniedAccept = await request(app).post(`/api/inventory/transactions/${created.body.id}/accept`).set(authHeader(qaToken));
      expect(deniedAccept.status).toBe(403);
    });

    it("QC rejection requires a note and is terminal — a rejected entry can't be accepted", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: qaToken } = await createUser(["QA_QC"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
      const created = await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 10 });

      const missingNote = await request(app).patch(`/api/inventory/transactions/${created.body.id}/qc`).set(authHeader(qaToken)).send({ action: "REJECT" });
      expect(missingNote.status).toBe(400);

      const rejected = await request(app).patch(`/api/inventory/transactions/${created.body.id}/qc`).set(authHeader(qaToken)).send({ action: "REJECT", note: "Damaged packaging" });
      expect(rejected.status).toBe(200);
      expect(rejected.body.receiptStatus).toBe("QC_REJECTED");

      const accept = await request(app).post(`/api/inventory/transactions/${created.body.id}/accept`).set(authHeader(storeToken));
      expect(accept.status).toBe(409);
    });

    it("supports partial rejection — part of a delivery fails inspection, the rest still counts toward stock", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: qaToken } = await createUser(["QA_QC"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
      const created = await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 50 });

      const missingNote = await request(app).patch(`/api/inventory/transactions/${created.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE", rejectedQty: 5 });
      expect(missingNote.status).toBe(400);

      const wholeQty = await request(app).patch(`/api/inventory/transactions/${created.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE", rejectedQty: 50, note: "All damaged" });
      expect(wholeQty.status).toBe(400);

      const approved = await request(app)
        .patch(`/api/inventory/transactions/${created.body.id}/qc`)
        .set(authHeader(qaToken))
        .send({ action: "APPROVE", rejectedQty: 5, note: "5 Kg damaged packaging" });
      expect(approved.status).toBe(200);
      expect(approved.body.receiptStatus).toBe("QC_APPROVED");
      expect(approved.body.rejectedQty).toBe(5);

      await request(app).post(`/api/inventory/transactions/${created.body.id}/accept`).set(authHeader(storeToken));

      const stock = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
      expect(stock.body[0]).toEqual(expect.objectContaining({ receivedQty: 45, rejectedQty: 5, onHand: 45 }));
    });

    it("a plain approve (no rejectedQty) behaves exactly as before — 0 rejected, full quantity counts", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: qaToken } = await createUser(["QA_QC"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
      const created = await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 50 });

      const approved = await request(app).patch(`/api/inventory/transactions/${created.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });
      expect(approved.body.rejectedQty).toBe(0);
      await request(app).post(`/api/inventory/transactions/${created.body.id}/accept`).set(authHeader(storeToken));

      const stock = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
      expect(stock.body[0]).toEqual(expect.objectContaining({ receivedQty: 50, rejectedQty: 0, onHand: 50 }));
    });
  });

  describe("Opening Stock — one-time go-live migration, skips the inward QC gate", () => {
    it("a single entry counts toward stock immediately, already ACCEPTED, no QC step needed", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });

      const created = await request(app)
        .post("/api/inventory/transactions")
        .set(authHeader(storeToken))
        .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-21", unit: "Kg", quantity: 250, isOpeningStock: true });
      expect(created.status).toBe(201);
      expect(created.body.isOpeningStock).toBe(true);
      expect(created.body.receiptStatus).toBe("ACCEPTED");
      expect(created.body.acceptedBy.id).toBeTruthy();

      const stock = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
      expect(stock.body[0]).toEqual(expect.objectContaining({ receivedQty: 250, onHand: 250 }));

      // A normal (non-opening-stock) entry still goes through PENDING_QC as usual.
      const normal = await request(app)
        .post("/api/inventory/transactions")
        .set(authHeader(storeToken))
        .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-21", unit: "Kg", quantity: 10 });
      expect(normal.body.isOpeningStock).toBe(false);
      expect(normal.body.receiptStatus).toBe("PENDING_QC");
    });

    it("is rejected for any non-RECEIVED type", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });

      const res = await request(app)
        .post("/api/inventory/transactions")
        .set(authHeader(storeToken))
        .send({ itemId: item.body.id, type: "ISSUED_DAY_STORE", date: "2026-08-21", unit: "Kg", quantity: 10, isOpeningStock: true });
      expect(res.status).toBe(400);
    });

    it("bulk import loads every row as ACCEPTED, counts toward stock immediately, and never notifies QA_QC", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: qaToken } = await createUser(["QA_QC"]);

      const imported = await request(app)
        .post("/api/inventory/transactions/import")
        .set(authHeader(storeToken))
        .send({
          type: "RECEIVED",
          isOpeningStock: true,
          rows: [
            { category: "RM", itemName: "Whey Protein", date: "2026-08-21", unit: "Kg", quantity: 300 },
            { category: "PM", itemName: "1kg Jar", date: "2026-08-21", unit: "Count", quantity: 1000 },
          ],
        });
      expect(imported.status).toBe(201);
      expect(imported.body).toEqual({ transactionsCreated: 2, itemsCreated: 2, dayStoresCreated: 0 });

      const stock = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
      expect(stock.body).toEqual(
        expect.arrayContaining([expect.objectContaining({ receivedQty: 300, onHand: 300 }), expect.objectContaining({ receivedQty: 1000, onHand: 1000 })]),
      );

      const qaInbox = await request(app).get("/api/notifications").set(authHeader(qaToken));
      expect(qaInbox.body.unreadCount).toBe(0);

      const rejected = await request(app)
        .post("/api/inventory/transactions/import")
        .set(authHeader(storeToken))
        .send({ type: "ISSUED_DAY_STORE", isOpeningStock: true, rows: [{ category: "RM", itemName: "Whey Protein", date: "2026-08-21", unit: "Kg", quantity: 10 }] });
      expect(rejected.status).toBe(400);
    });
  });

  describe("Outward QC gate — FG dispatch transfers", () => {
    it("an FG transfer starts PENDING_QC; a BILL transfer never gets a qcStatus", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: bdToken } = await createUser(["BD"]);
      const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });

      const fg = await request(app)
        .post("/api/inventory/dispatch-transfers")
        .set(authHeader(storeToken))
        .send({ type: "FG", date: "2026-08-10", customerId: customer.body.id, productName: "Whey Protein 1Kg Jar", quantity: 200 });
      expect(fg.body.qcStatus).toBe("PENDING_QC");

      const bill = await request(app)
        .post("/api/inventory/dispatch-transfers")
        .set(authHeader(storeToken))
        .send({ type: "BILL", date: "2026-08-11", customerId: customer.body.id, productName: "Whey Protein 1Kg Jar", quantity: 200 });
      expect(bill.body.qcStatus).toBeNull();
    });

    it("only QA_QC can review outward QC, and a BILL transfer can't go through it", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: qaToken } = await createUser(["QA_QC"]);
      const { token: bdToken } = await createUser(["BD"]);
      const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });
      const fg = await request(app)
        .post("/api/inventory/dispatch-transfers")
        .set(authHeader(storeToken))
        .send({ type: "FG", date: "2026-08-10", customerId: customer.body.id, productName: "Whey Protein 1Kg Jar", quantity: 200 });
      const bill = await request(app)
        .post("/api/inventory/dispatch-transfers")
        .set(authHeader(storeToken))
        .send({ type: "BILL", date: "2026-08-11", customerId: customer.body.id, productName: "Whey Protein 1Kg Jar", quantity: 200 });

      const deniedRole = await request(app).patch(`/api/inventory/dispatch-transfers/${fg.body.id}/qc`).set(authHeader(storeToken)).send({ action: "APPROVE" });
      expect(deniedRole.status).toBe(403);

      const wrongType = await request(app).patch(`/api/inventory/dispatch-transfers/${bill.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });
      expect(wrongType.status).toBe(400);

      const approved = await request(app).patch(`/api/inventory/dispatch-transfers/${fg.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });
      expect(approved.status).toBe(200);
      expect(approved.body.qcStatus).toBe("QC_APPROVED");

      const again = await request(app).patch(`/api/inventory/dispatch-transfers/${fg.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });
      expect(again.status).toBe(409);
    });
  });

  describe("FG transfer → Material Request traceability tag", () => {
    it("only accepts an ISSUED request, and only on an FG transfer", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: ppicToken } = await createUser(["PPIC"]);
      const { token: bdToken } = await createUser(["BD"]);
      const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
      await request(app)
        .post("/api/inventory/transactions")
        .set(authHeader(storeToken))
        .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 10, isOpeningStock: true });
      const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });

      const pendingRequest = await request(app)
        .post("/api/inventory/requests")
        .set(authHeader(ppicToken))
        .send({ itemId: item.body.id, category: "RM", requestedQty: 10, purpose: "ISSUED_PRODUCTION" });

      const linkToPending = await request(app)
        .post("/api/inventory/dispatch-transfers")
        .set(authHeader(storeToken))
        .send({ type: "FG", date: "2026-08-10", customerId: customer.body.id, productName: "Whey Gold 1Kg", quantity: 50, sourceRequestId: pendingRequest.body.id });
      expect(linkToPending.status).toBe(400);

      const linkToBill = await request(app)
        .post("/api/inventory/dispatch-transfers")
        .set(authHeader(storeToken))
        .send({ type: "BILL", date: "2026-08-10", customerId: customer.body.id, productName: "Whey Gold 1Kg", quantity: 50, sourceRequestId: pendingRequest.body.id });
      expect(linkToBill.status).toBe(400);

      await request(app).patch(`/api/inventory/requests/${pendingRequest.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
      await request(app)
        .post(`/api/inventory/requests/${pendingRequest.body.id}/issue`)
        .set(authHeader(storeToken))
        .send({ date: "2026-08-09", unit: "Kg", quantity: 10, dayStoreId: null });

      const linkToIssued = await request(app)
        .post("/api/inventory/dispatch-transfers")
        .set(authHeader(storeToken))
        .send({ type: "FG", date: "2026-08-10", customerId: customer.body.id, productName: "Whey Gold 1Kg", quantity: 50, sourceRequestId: pendingRequest.body.id });
      expect(linkToIssued.status).toBe(201);
      expect(linkToIssued.body.sourceRequest.id).toBe(pendingRequest.body.id);
      expect(linkToIssued.body.sourceRequest.item.name).toBe("Whey Protein");
    });
  });

  describe("POST /api/inventory/requests/import — bulk indent sheet", () => {
    it("is restricted to PPIC, creates one PENDING request per row, resolving-or-creating items same as the transactions import", async () => {
      const { token: ppicToken } = await createUser(["PPIC"]);
      const { token: storeToken } = await createUser(["STORE"]);

      const denied = await request(app)
        .post("/api/inventory/requests/import")
        .set(authHeader(storeToken))
        .send({ rows: [{ category: "RM", itemName: "Whey Protein", requestedQty: 10, purpose: "ISSUED_PRODUCTION" }] });
      expect(denied.status).toBe(403);

      const imported = await request(app)
        .post("/api/inventory/requests/import")
        .set(authHeader(ppicToken))
        .send({
          rows: [
            { category: "RM", itemName: "Whey Protein", requestedQty: 10, purpose: "ISSUED_PRODUCTION" },
            { category: "RM", itemName: "Whey Protein", requestedQty: 5, purpose: "ISSUED_DAY_STORE" }, // same item, different row — no collapsing
            { category: "PM", itemName: "Jar 1Kg", requestedQty: 200, purpose: "ISSUED_PRODUCTION", note: "For batch GB-0098" },
          ],
        });
      expect(imported.status).toBe(201);
      expect(imported.body).toEqual({ requestsCreated: 3, itemsCreated: 2 });

      const list = await request(app).get("/api/inventory/requests").set(authHeader(ppicToken));
      expect(list.body.length).toBe(3);
      expect(list.body.every((r: { status: string }) => r.status === "PENDING")).toBe(true);
    });
  });

  describe("POST /api/inventory/dispatch-transfers/import — bulk shipment sheet", () => {
    it("matches customers by exact name, never creates one, and reports unmatched names back", async () => {
      const { token: storeToken } = await createUser(["STORE"]);
      const { token: bdToken } = await createUser(["BD"]);
      await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });

      const denied = await request(app)
        .post("/api/inventory/dispatch-transfers/import")
        .set(authHeader(bdToken))
        .send({ type: "FG", rows: [{ customerName: "Acme Nutrition Pvt. Ltd.", date: "2026-08-10", productName: "Whey Gold 1Kg", quantity: 50 }] });
      expect(denied.status).toBe(403);

      const imported = await request(app)
        .post("/api/inventory/dispatch-transfers/import")
        .set(authHeader(storeToken))
        .send({
          type: "FG",
          rows: [
            { customerName: "Acme Nutrition Pvt. Ltd.", date: "2026-08-10", productName: "Whey Gold 1Kg", quantity: 50 },
            { customerName: "Acme Nutrition Pvt. Ltd.", date: "2026-08-10", productName: "BCAA 2:1:1", quantity: 30 },
            { customerName: "Nonexistent Customer LLC", date: "2026-08-10", productName: "Creatine", quantity: 20 },
          ],
        });
      expect(imported.status).toBe(201);
      expect(imported.body.transfersCreated).toBe(2);
      expect(imported.body.unknownCustomers).toEqual(["Nonexistent Customer LLC"]);

      const list = await request(app).get("/api/inventory/dispatch-transfers?type=FG").set(authHeader(storeToken));
      expect(list.body.length).toBe(2);
      expect(list.body.every((d: { qcStatus: string }) => d.qcStatus === "PENDING_QC")).toBe(true);
    });
  });
});
