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

  it("computes stock on hand as sum(RECEIVED) - sum(ISSUED) per item", async () => {
    const { token } = await createUser(["STORE"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(token)).send({ category: "RM", name: "Whey Protein", unit: "Kg" });
    const itemId = item.body.id;

    await request(app).post("/api/inventory/transactions").set(authHeader(token)).send({ itemId, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 100 });
    await request(app).post("/api/inventory/transactions").set(authHeader(token)).send({ itemId, type: "RECEIVED", date: "2026-08-02", unit: "Kg", quantity: 50 });
    await request(app).post("/api/inventory/transactions").set(authHeader(token)).send({ itemId, type: "ISSUED", date: "2026-08-03", unit: "Kg", quantity: 30 });

    const stock = await request(app).get("/api/inventory/stock").set(authHeader(token));
    expect(stock.status).toBe(200);
    expect(stock.body).toEqual([expect.objectContaining({ receivedQty: 150, issuedQty: 30, onHand: 120 })]);
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
});
