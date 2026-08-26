import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

async function createApprovedPo(bdToken: string, poNumber: string) {
  const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: `Customer for ${poNumber}` });
  const po = await request(app)
    .post("/api/purchase-orders")
    .set(authHeader(bdToken))
    .send({ customerId: customer.body.id, poNumber, items: [{ productName: "Whey Protein 1Kg Jar", quantity: 500, unit: "SKU" }] });
  await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
  return po.body;
}

describe("PO Material Readiness", () => {
  it("is PPIC-only (ADMIN bypasses); a plain user is denied", async () => {
    const { token: plainToken } = await createUser([]);
    const { token: adminToken } = await createUser(["ADMIN"]);

    const denied = await request(app).get("/api/po-readiness").set(authHeader(plainToken));
    expect(denied.status).toBe(403);

    const ok = await request(app).get("/api/po-readiness").set(authHeader(adminToken));
    expect(ok.status).toBe(200);
  });

  it("manual add: takes real ids (not free text), upserts on re-add, rejects a category/item mismatch and an unknown PO/item", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const po = await createApprovedPo(bdToken, "PO-MANUAL-1001");
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Manual Add Test Item" });

    const badCategory = await request(app)
      .post("/api/po-readiness")
      .set(authHeader(ppicToken))
      .send({ purchaseOrderId: po.id, itemId: item.body.id, category: "PM", requiredQty: 10, unit: "Kg" });
    expect(badCategory.status).toBe(400);

    const unknownPo = await request(app)
      .post("/api/po-readiness")
      .set(authHeader(ppicToken))
      .send({ purchaseOrderId: "00000000-0000-0000-0000-000000000000", itemId: item.body.id, category: "RM", requiredQty: 10, unit: "Kg" });
    expect(unknownPo.status).toBe(400);

    const created = await request(app)
      .post("/api/po-readiness")
      .set(authHeader(ppicToken))
      .send({ purchaseOrderId: po.id, itemId: item.body.id, category: "RM", requiredQty: 10, unit: "Kg" });
    expect(created.status).toBe(201);
    expect(created.body.requiredQty).toBe(10);

    // Re-adding the same (PO, item) pair updates the quantity, doesn't duplicate.
    const updated = await request(app)
      .post("/api/po-readiness")
      .set(authHeader(ppicToken))
      .send({ purchaseOrderId: po.id, itemId: item.body.id, category: "RM", requiredQty: 25, unit: "Kg" });
    expect(updated.status).toBe(201);

    const detail = await request(app).get(`/api/po-readiness/${po.id}`).set(authHeader(ppicToken));
    expect(detail.body.totalItems).toBe(1);
    expect(detail.body.items[0].requiredQty).toBe(25);
  });

  it("import matches by PO number, creates items as needed, upserts on re-upload, and reports unmatched PO numbers", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const po = await createApprovedPo(bdToken, "PO-READY-1001");

    const imported = await request(app)
      .post("/api/po-readiness/import")
      .set(authHeader(ppicToken))
      .send({
        rows: [
          { poNumber: "PO-READY-1001", category: "RM", itemName: "Whey Protein Concentrate", requiredQty: 60, unit: "Kg" },
          { poNumber: "PO-READY-1001", category: "PM", itemName: "1Kg Jar", requiredQty: 500, unit: "Count" },
          { poNumber: "PO-DOES-NOT-EXIST", category: "RM", itemName: "Ghost Item", requiredQty: 10, unit: "Kg" },
        ],
      });
    expect(imported.status).toBe(201);
    expect(imported.body).toEqual({ rowsImported: 2, itemsCreated: 2, unmatchedPoNumbers: ["PO-DOES-NOT-EXIST"] });

    const detail = await request(app).get(`/api/po-readiness/${po.id}`).set(authHeader(ppicToken));
    expect(detail.status).toBe(200);
    expect(detail.body.totalItems).toBe(2);
    expect(detail.body.isReady).toBe(false); // nothing received yet

    // Re-upload with a corrected quantity — updates in place, doesn't duplicate.
    const reimported = await request(app)
      .post("/api/po-readiness/import")
      .set(authHeader(ppicToken))
      .send({ rows: [{ poNumber: "PO-READY-1001", category: "RM", itemName: "Whey Protein Concentrate", requiredQty: 45, unit: "Kg" }] });
    expect(reimported.body).toEqual({ rowsImported: 1, itemsCreated: 0, unmatchedPoNumbers: [] });

    const detailAfter = await request(app).get(`/api/po-readiness/${po.id}`).set(authHeader(ppicToken));
    expect(detailAfter.body.totalItems).toBe(2); // still 2 rows, not 3
    const rm = detailAfter.body.items.find((i: { category: string }) => i.category === "RM");
    expect(rm.requiredQty).toBe(45);
  });

  it("computes per-PO readiness live off stock, and lists only ready POs under ?ready=true", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const poReady = await createApprovedPo(bdToken, "PO-READY-2001");
    const poShort = await createApprovedPo(bdToken, "PO-READY-2002");

    await request(app)
      .post("/api/po-readiness/import")
      .set(authHeader(ppicToken))
      .send({
        rows: [
          { poNumber: "PO-READY-2001", category: "RM", itemName: "Creatine Monohydrate", requiredQty: 20, unit: "Kg" },
          { poNumber: "PO-READY-2002", category: "RM", itemName: "Creatine Monohydrate", requiredQty: 20, unit: "Kg" },
          { poNumber: "PO-READY-2002", category: "PM", itemName: "Scoop", requiredQty: 1000, unit: "Count" }, // never arrives
        ],
      });

    // Only enough Creatine for one PO's worth, and it never gets the Scoops PO-READY-2002 needs.
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: (await request(app).get("/api/inventory/items?category=RM").set(authHeader(storeToken))).body.find((i: { name: string }) => i.name === "Creatine Monohydrate").id, type: "RECEIVED", date: "2026-08-25", unit: "Kg", quantity: 40, isOpeningStock: true });

    const all = await request(app).get("/api/po-readiness").set(authHeader(ppicToken));
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(2);
    const readyRow = all.body.find((r: { purchaseOrder: { id: string } }) => r.purchaseOrder.id === poReady.id);
    const shortRow = all.body.find((r: { purchaseOrder: { id: string } }) => r.purchaseOrder.id === poShort.id);
    expect(readyRow.isReady).toBe(true);
    expect(shortRow.isReady).toBe(false);

    const onlyReady = await request(app).get("/api/po-readiness?ready=true").set(authHeader(ppicToken));
    expect(onlyReady.body).toHaveLength(1);
    expect(onlyReady.body[0].purchaseOrder.id).toBe(poReady.id);
    expect(onlyReady.headers["x-total-count"]).toBe("1");
  });

  it("notifies PPIC exactly when a PO crosses into ready — not before, not again on a later unrelated top-up", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken1 } = await createUser(["PPIC"]);
    const { token: ppicToken2 } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const po = await createApprovedPo(bdToken, "PO-READY-3001");

    await request(app)
      .post("/api/po-readiness/import")
      .set(authHeader(ppicToken1))
      .send({ rows: [{ poNumber: "PO-READY-3001", category: "RM", itemName: "Sucralose", requiredQty: 10, unit: "Kg" }] });

    const item = (await request(app).get("/api/inventory/items?category=RM").set(authHeader(storeToken))).body.find((i: { name: string }) => i.name === "Sucralose");

    // Partial receipt — not enough yet, no notification expected.
    await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: item.id, type: "RECEIVED", date: "2026-08-25", unit: "Kg", quantity: 4, isOpeningStock: true });
    const before = await request(app).get("/api/notifications").set(authHeader(ppicToken2));
    expect(before.body.notifications.some((n: { link: string }) => n.link === "/po-readiness")).toBe(false);

    // The rest arrives — crosses into ready, PPIC gets notified.
    await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: item.id, type: "RECEIVED", date: "2026-08-25", unit: "Kg", quantity: 6, isOpeningStock: true });
    const after = await request(app).get("/api/notifications").set(authHeader(ppicToken2));
    const readyNotif = after.body.notifications.find((n: { link: string }) => n.link === "/po-readiness");
    expect(readyNotif).toBeTruthy();
    expect(readyNotif.title).toMatch(/PO-READY-3001/);

    // A further top-up of the same item shouldn't re-notify — it was already ready.
    await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: item.id, type: "RECEIVED", date: "2026-08-25", unit: "Kg", quantity: 5, isOpeningStock: true });
    const afterTopUp = await request(app).get("/api/notifications").set(authHeader(ppicToken2));
    const readyNotifs = afterTopUp.body.notifications.filter((n: { link: string }) => n.link === "/po-readiness");
    expect(readyNotifs).toHaveLength(1);
  });

  it("two POs both needing 10 Kg of an item the Warehouse only has 10 Kg of: the earlier-recorded requirement gets covered, the later one doesn't — not both", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const poFirst = await createApprovedPo(bdToken, "PO-CONTEND-1001");
    const poSecond = await createApprovedPo(bdToken, "PO-CONTEND-1002");

    // poFirst's requirement is recorded first — it should win the claim.
    await request(app)
      .post("/api/po-readiness/import")
      .set(authHeader(ppicToken))
      .send({ rows: [{ poNumber: "PO-CONTEND-1001", category: "RM", itemName: "Contended Item", requiredQty: 10, unit: "Kg" }] });
    await request(app)
      .post("/api/po-readiness/import")
      .set(authHeader(ppicToken))
      .send({ rows: [{ poNumber: "PO-CONTEND-1002", category: "RM", itemName: "Contended Item", requiredQty: 10, unit: "Kg" }] });

    const item = (await request(app).get("/api/inventory/items?category=RM").set(authHeader(storeToken))).body.find((i: { name: string }) => i.name === "Contended Item");
    await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: item.id, type: "RECEIVED", date: "2026-08-25", unit: "Kg", quantity: 10, isOpeningStock: true });

    const all = await request(app).get("/api/po-readiness?pageSize=200").set(authHeader(ppicToken));
    const rowFirst = all.body.find((r: { purchaseOrder: { id: string } }) => r.purchaseOrder.id === poFirst.id);
    const rowSecond = all.body.find((r: { purchaseOrder: { id: string } }) => r.purchaseOrder.id === poSecond.id);

    expect(rowFirst.isReady).toBe(true);
    expect(rowFirst.items[0].onHand).toBe(10); // saw the full 10 Kg, claimed it
    expect(rowSecond.isReady).toBe(false); // NOT also "ready" against the same 10 Kg
    expect(rowSecond.items[0].onHand).toBe(0); // nothing left after poFirst's claim
    expect(rowSecond.items[0].covered).toBe(false);

    // The single-PO detail endpoint has to agree with the list — it
    // can't independently re-check "is 10 Kg on hand?" in isolation and
    // say yes, ignoring that poFirst already has first claim on it.
    const detailSecond = await request(app).get(`/api/po-readiness/${poSecond.id}`).set(authHeader(ppicToken));
    expect(detailSecond.body.isReady).toBe(false);
  });

  it("counts material already moved to a Day Store or a Plant, not just what's still sitting in the Warehouse — per the 2026-08-26 PO-execution cascade call", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);

    // --- Day Store leg ---
    const poDayStore = await createApprovedPo(bdToken, "PO-LOCATION-1001");
    await request(app)
      .post("/api/po-readiness/import")
      .set(authHeader(ppicToken))
      .send({ rows: [{ poNumber: "PO-LOCATION-1001", category: "RM", itemName: "Staged At Day Store Item", requiredQty: 10, unit: "Kg" }] });
    const dsItem = (await request(app).get("/api/inventory/items?category=RM").set(authHeader(storeToken))).body.find((i: { name: string }) => i.name === "Staged At Day Store Item");
    await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: dsItem.id, type: "RECEIVED", date: "2026-08-26", unit: "Kg", quantity: 10, isOpeningStock: true });
    const dayStore = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Reco Test Day Store" });
    // Move the entire 10 Kg out of the Warehouse into a Day Store —
    // Warehouse-only on-hand drops to 0, but the material still
    // physically exists and is still usable for this PO.
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: dsItem.id, type: "ISSUED_DAY_STORE", date: "2026-08-26", unit: "Kg", quantity: 10, dayStoreId: dayStore.body.id });

    const dayStoreReadiness = await request(app).get(`/api/po-readiness/${poDayStore.id}`).set(authHeader(ppicToken));
    expect(dayStoreReadiness.body.isReady).toBe(true);
    expect(dayStoreReadiness.body.items[0].onHand).toBe(10);
    expect(dayStoreReadiness.body.items[0].covered).toBe(true);

    // --- Plant leg ---
    const poPlant = await createApprovedPo(bdToken, "PO-LOCATION-1002");
    await request(app)
      .post("/api/po-readiness/import")
      .set(authHeader(ppicToken))
      .send({ rows: [{ poNumber: "PO-LOCATION-1002", category: "RM", itemName: "Staged At Plant Item", requiredQty: 8, unit: "Kg" }] });
    const plantItem = (await request(app).get("/api/inventory/items?category=RM").set(authHeader(storeToken))).body.find((i: { name: string }) => i.name === "Staged At Plant Item");
    await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: plantItem.id, type: "RECEIVED", date: "2026-08-26", unit: "Kg", quantity: 8, isOpeningStock: true });
    const plant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Reco Test Plant" });
    // Plant-tagged stock only exists via the real Material Request path —
    // POST /transactions has no plantId field at all (it's carried off
    // the request PPIC raised, see /requests/:id/issue), so this has to
    // go through raise -> approve -> issue, not a direct ledger entry.
    const plantRequest = await request(app)
      .post("/api/inventory/requests")
      .set(authHeader(ppicToken))
      .send({ itemId: plantItem.id, category: "RM", requestedQty: 8, purpose: "ISSUED_PRODUCTION", plantId: plant.body.id });
    await request(app).patch(`/api/inventory/requests/${plantRequest.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
    await request(app)
      .post(`/api/inventory/requests/${plantRequest.body.id}/issue`)
      .set(authHeader(storeToken))
      .send({ date: "2026-08-26", unit: "Kg", quantity: 8, dayStoreId: null });

    const plantReadiness = await request(app).get(`/api/po-readiness/${poPlant.id}`).set(authHeader(ppicToken));
    expect(plantReadiness.body.isReady).toBe(true);
    expect(plantReadiness.body.items[0].onHand).toBe(8);
    expect(plantReadiness.body.items[0].covered).toBe(true);
  });

  it("DELETE removes one requirement row, restricted to PPIC", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: plainToken } = await createUser([]);
    const po = await createApprovedPo(bdToken, "PO-READY-4001");

    await request(app)
      .post("/api/po-readiness/import")
      .set(authHeader(ppicToken))
      .send({ rows: [{ poNumber: "PO-READY-4001", category: "RM", itemName: "Maltodextrin", requiredQty: 5, unit: "Kg" }] });

    const detail = await request(app).get(`/api/po-readiness/${po.id}`).set(authHeader(ppicToken));
    const itemId = detail.body.items[0].itemId;

    const denied = await request(app).delete(`/api/po-readiness/${po.id}/items/${itemId}`).set(authHeader(plainToken));
    expect(denied.status).toBe(403);

    const removed = await request(app).delete(`/api/po-readiness/${po.id}/items/${itemId}`).set(authHeader(ppicToken));
    expect(removed.status).toBe(204);

    const detailAfter = await request(app).get(`/api/po-readiness/${po.id}`).set(authHeader(ppicToken));
    expect(detailAfter.status).toBe(404); // no requirements left at all
  });
});
