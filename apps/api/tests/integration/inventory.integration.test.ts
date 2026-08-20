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
    await request(app).post(`/api/inventory/requests/${req.body.id}/issue`).set(authHeader(token)).send({ date: "2026-08-04", unit: "Kg", quantity: 20 });

    const stock = await request(app).get("/api/inventory/stock").set(authHeader(token));
    expect(stock.status).toBe(200);
    expect(stock.body).toEqual([
      expect.objectContaining({ receivedQty: 150, issuedDayStoreQty: 30, issuedProductionQty: 20, issuedQty: 50, onHand: 100 }),
    ]);
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

      const issued = await request(app).post(`/api/inventory/requests/${created.body.id}/issue`).set(authHeader(storeToken)).send({ date: "2026-08-01", unit: "Kg", quantity: 10 });
      expect(issued.status).toBe(201);
      expect(issued.body.type).toBe("ISSUED_PRODUCTION");

      const doubleIssue = await request(app).post(`/api/inventory/requests/${created.body.id}/issue`).set(authHeader(storeToken)).send({ date: "2026-08-01", unit: "Kg", quantity: 10 });
      expect(doubleIssue.status).toBe(409);
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

      const issueRejected = await request(app).post(`/api/inventory/requests/${created.body.id}/issue`).set(authHeader(storeToken)).send({ date: "2026-08-01", unit: "Kg", quantity: 10 });
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
      await request(app).post(`/api/inventory/requests/${pendingRequest.body.id}/issue`).set(authHeader(storeToken)).send({ date: "2026-08-09", unit: "Kg", quantity: 10 });

      const linkToIssued = await request(app)
        .post("/api/inventory/dispatch-transfers")
        .set(authHeader(storeToken))
        .send({ type: "FG", date: "2026-08-10", customerId: customer.body.id, productName: "Whey Gold 1Kg", quantity: 50, sourceRequestId: pendingRequest.body.id });
      expect(linkToIssued.status).toBe(201);
      expect(linkToIssued.body.sourceRequest.id).toBe(pendingRequest.body.id);
      expect(linkToIssued.body.sourceRequest.item.name).toBe("Whey Protein");
    });
  });
});
