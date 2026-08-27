import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("Recycle Bin", () => {
  it("is ADMIN-only for both listing and restoring", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: adminToken } = await createUser(["ADMIN"]);

    const deniedList = await request(app).get("/api/recycle-bin").set(authHeader(storeToken));
    expect(deniedList.status).toBe(403);

    const okList = await request(app).get("/api/recycle-bin").set(authHeader(adminToken));
    expect(okList.status).toBe(200);

    const deniedRestore = await request(app).post("/api/recycle-bin/inventory-transaction/00000000-0000-0000-0000-000000000000/restore").set(authHeader(storeToken));
    expect(deniedRestore.status).toBe(403);
  });

  it("a deleted Material Received entry disappears from stock and from every list, shows up in the bin, and restoring it brings stock back exactly as it was", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: adminToken } = await createUser(["ADMIN"]);

    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Recycle Bin Test Item" });
    const txn = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-26", unit: "Kg", quantity: 40, isOpeningStock: true, vendorName: "Bin Test Vendor" });
    expect(txn.status).toBe(201);

    const stockBefore = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
    expect(stockBefore.body.find((s: { item: { id: string } }) => s.item.id === item.body.id).onHand).toBe(40);

    const del = await request(app).delete(`/api/inventory/transactions/${txn.body.id}`).set(authHeader(storeToken));
    expect(del.status).toBe(204);

    // Gone from stock on-hand and from the transaction list — same
    // external behavior a hard delete always had.
    const stockAfterDelete = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
    const rowAfterDelete = stockAfterDelete.body.find((s: { item: { id: string } }) => s.item.id === item.body.id);
    expect(rowAfterDelete?.onHand ?? 0).toBe(0);

    const txnList = await request(app).get(`/api/inventory/transactions?itemId=${item.body.id}`).set(authHeader(storeToken));
    expect(txnList.body).toHaveLength(0);

    // But it's not actually gone — it's in the bin, Admin-visible.
    const bin = await request(app).get("/api/recycle-bin").set(authHeader(adminToken));
    const binRow = bin.body.find((r: { entityType: string; id: string }) => r.entityType === "inventory-transaction" && r.id === txn.body.id);
    expect(binRow).toBeTruthy();
    expect(binRow.label).toContain("Recycle Bin Test Item");
    expect(binRow.deletedBy.id).toBeTruthy();

    // Restoring it brings the stock number back exactly as it was —
    // nothing double-counted, nothing lost.
    const restore = await request(app).post(`/api/recycle-bin/inventory-transaction/${txn.body.id}/restore`).set(authHeader(adminToken));
    expect(restore.status).toBe(204);

    const stockAfterRestore = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
    expect(stockAfterRestore.body.find((s: { item: { id: string } }) => s.item.id === item.body.id).onHand).toBe(40);

    const binAfterRestore = await request(app).get("/api/recycle-bin").set(authHeader(adminToken));
    expect(binAfterRestore.body.find((r: { id: string }) => r.id === txn.body.id)).toBeUndefined();

    // Restoring the same thing again finds nothing to restore.
    const restoreAgain = await request(app).post(`/api/recycle-bin/inventory-transaction/${txn.body.id}/restore`).set(authHeader(adminToken));
    expect(restoreAgain.status).toBe(404);
  });

  it("a deleted PO line item drops out of the PO's own items list and restores back into it", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: adminToken } = await createUser(["ADMIN"]);

    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Recycle Bin Test Customer" });
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({
        customerId: customer.body.id,
        poNumber: "PO-BIN-1001",
        items: [
          { productName: "Product A", quantity: 10, unit: "KG" },
          { productName: "Product B", quantity: 20, unit: "KG" },
        ],
      });
    expect(po.body.items).toHaveLength(2);
    const itemId = po.body.items.find((i: { productName: string }) => i.productName === "Product B").id;

    const del = await request(app).delete(`/api/purchase-orders/${po.body.id}/items/${itemId}`).set(authHeader(bdToken));
    expect(del.status).toBe(204);

    const afterDelete = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authHeader(bdToken));
    expect(afterDelete.body.items).toHaveLength(1);
    expect(afterDelete.body.items[0].productName).toBe("Product A");

    const bin = await request(app).get("/api/recycle-bin").set(authHeader(adminToken));
    const binRow = bin.body.find((r: { entityType: string; id: string }) => r.entityType === "purchase-order-item" && r.id === itemId);
    expect(binRow).toBeTruthy();
    expect(binRow.detail).toContain("PO-BIN-1001");

    const restore = await request(app).post(`/api/recycle-bin/purchase-order-item/${itemId}/restore`).set(authHeader(adminToken));
    expect(restore.status).toBe(204);

    const afterRestore = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authHeader(bdToken));
    expect(afterRestore.body.items).toHaveLength(2);
  });

  it("rejects restoring with an unknown entity type", async () => {
    const { token: adminToken } = await createUser(["ADMIN"]);
    const res = await request(app).post("/api/recycle-bin/not-a-real-type/00000000-0000-0000-0000-000000000000/restore").set(authHeader(adminToken));
    expect(res.status).toBe(400);
  });
});
