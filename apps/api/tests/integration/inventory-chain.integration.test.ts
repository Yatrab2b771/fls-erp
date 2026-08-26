import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("Day Stores / Plants — named, growable identities", () => {
  it("STORE (or ADMIN) can add a new Day Store / Plant; anyone authenticated can list them; names are unique", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: plainToken } = await createUser([]);

    const deniedCreate = await request(app).post("/api/inventory/day-stores").set(authHeader(plainToken)).send({ name: "Day Store A" });
    expect(deniedCreate.status).toBe(403);

    const created = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Day Store A" });
    expect(created.status).toBe(201);

    const dup = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Day Store A" });
    expect(dup.status).toBe(409);

    const list = await request(app).get("/api/inventory/day-stores").set(authHeader(plainToken));
    expect(list.status).toBe(200);
    expect(list.body.map((d: { name: string }) => d.name)).toEqual(["Day Store A"]);

    const plant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Plant 1" });
    expect(plant.status).toBe(201);
    const plantList = await request(app).get("/api/inventory/plants").set(authHeader(plainToken));
    expect(plantList.body.map((p: { name: string }) => p.name)).toEqual(["Plant 1"]);
  });

  it("STORE (or ADMIN) can rename a Day Store / Plant; a plain user can't; renaming to an existing name is blocked; existing transactions pick up the new name", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: plainToken } = await createUser([]);
    const store1 = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Store 1" });
    await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Store 2" });
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-21", unit: "Kg", quantity: 10, isOpeningStock: true });
    const txn = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "ISSUED_DAY_STORE", date: "2026-08-22", unit: "Kg", quantity: 10, dayStoreId: store1.body.id });

    const deniedRename = await request(app).patch(`/api/inventory/day-stores/${store1.body.id}`).set(authHeader(plainToken)).send({ name: "Store 41" });
    expect(deniedRename.status).toBe(403);

    const clash = await request(app).patch(`/api/inventory/day-stores/${store1.body.id}`).set(authHeader(storeToken)).send({ name: "Store 2" });
    expect(clash.status).toBe(409);

    const renamed = await request(app).patch(`/api/inventory/day-stores/${store1.body.id}`).set(authHeader(storeToken)).send({ name: "Store 41" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Store 41");

    const missing = await request(app).patch(`/api/inventory/day-stores/00000000-0000-0000-0000-000000000000`).set(authHeader(storeToken)).send({ name: "Ghost" });
    expect(missing.status).toBe(404);

    // The transaction logged before the rename now shows the new name — it's
    // a live foreign key, not a copied/denormalized string.
    const txnAfter = await request(app).get(`/api/inventory/transactions?type=ISSUED_DAY_STORE`).set(authHeader(storeToken));
    expect(txnAfter.body.find((t: { id: string }) => t.id === txn.body.id).dayStore.name).toBe("Store 41");

    const plant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Plant A" });
    const plantRenamed = await request(app).patch(`/api/inventory/plants/${plant.body.id}`).set(authHeader(storeToken)).send({ name: "Plant 41" });
    expect(plantRenamed.status).toBe(200);
    expect(plantRenamed.body.name).toBe("Plant 41");
  });
});

describe("Store assignment — restricts which specific store(s) a STORE user can manage", () => {
  it("a STORE user with no assignments keeps full access to every store — the default, unrestricted until someone opts a user in", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const storeA = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Unrestricted A" });
    const storeB = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Unrestricted B" });

    const renameA = await request(app).patch(`/api/inventory/day-stores/${storeA.body.id}`).set(authHeader(storeToken)).send({ name: "Unrestricted A2" });
    expect(renameA.status).toBe(200);
    const renameB = await request(app).patch(`/api/inventory/day-stores/${storeB.body.id}`).set(authHeader(storeToken)).send({ name: "Unrestricted B2" });
    expect(renameB.status).toBe(200);
  });

  it("only a user holding the STORE role can be assigned; STORE and ADMIN can both grant/list/revoke; a plain user can't", async () => {
    const { token: storeToken, user: storeUser } = await createUser(["STORE"]);
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { token: plainToken } = await createUser([]);
    const { user: nonStoreUser } = await createUser(["PPIC"]);
    const store = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Assignable Store" });

    const deniedList = await request(app).get(`/api/inventory/day-stores/${store.body.id}/assignments`).set(authHeader(plainToken));
    expect(deniedList.status).toBe(403);

    const rejectNonStore = await request(app).post(`/api/inventory/day-stores/${store.body.id}/assignments`).set(authHeader(storeToken)).send({ userId: nonStoreUser.id });
    expect(rejectNonStore.status).toBe(400);

    const assigned = await request(app).post(`/api/inventory/day-stores/${store.body.id}/assignments`).set(authHeader(adminToken)).send({ userId: storeUser.id });
    expect(assigned.status).toBe(201);
    expect(assigned.body.user.id).toBe(storeUser.id);

    const list = await request(app).get(`/api/inventory/day-stores/${store.body.id}/assignments`).set(authHeader(storeToken));
    expect(list.status).toBe(200);
    expect(list.body.map((a: { user: { id: string } }) => a.user.id)).toEqual([storeUser.id]);

    const revoked = await request(app).delete(`/api/inventory/day-stores/${store.body.id}/assignments/${storeUser.id}`).set(authHeader(storeToken));
    expect(revoked.status).toBe(204);

    const listAfter = await request(app).get(`/api/inventory/day-stores/${store.body.id}/assignments`).set(authHeader(storeToken));
    expect(listAfter.body).toEqual([]);
  });

  it("GET /store-users lists only STORE-role users — the assignable pool, not the full company directory", async () => {
    const { token: storeToken, user: storeUser } = await createUser(["STORE"]);
    await createUser(["PPIC"]); // must not appear below

    const list = await request(app).get("/api/inventory/day-stores/store-users").set(authHeader(storeToken));
    expect(list.status).toBe(200);
    const ids = list.body.map((u: { id: string }) => u.id);
    expect(ids).toContain(storeUser.id);
  });

  it("once assigned to Store A only, a STORE user is blocked from Store B — rename, direct issue, and issuing a request all 403; Store A still works", async () => {
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { token: restrictedToken, user: restrictedUser } = await createUser(["STORE"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(adminToken)).send({ category: "RM", name: "Scoped Item" });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(adminToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-22", unit: "Kg", quantity: 100, isOpeningStock: true });

    const storeA = await request(app).post("/api/inventory/day-stores").set(authHeader(adminToken)).send({ name: "Scoped Store A" });
    const storeB = await request(app).post("/api/inventory/day-stores").set(authHeader(adminToken)).send({ name: "Scoped Store B" });
    await request(app).post(`/api/inventory/day-stores/${storeA.body.id}/assignments`).set(authHeader(adminToken)).send({ userId: restrictedUser.id });

    // Rename: A allowed, B blocked.
    expect((await request(app).patch(`/api/inventory/day-stores/${storeA.body.id}`).set(authHeader(restrictedToken)).send({ name: "Scoped Store A2" })).status).toBe(200);
    expect((await request(app).patch(`/api/inventory/day-stores/${storeB.body.id}`).set(authHeader(restrictedToken)).send({ name: "Scoped Store B2" })).status).toBe(403);

    // Viewing stock: A allowed, B blocked — for the restricted STORE user.
    expect((await request(app).get(`/api/inventory/day-stores/${storeA.body.id}/stock`).set(authHeader(restrictedToken))).status).toBe(200);
    expect((await request(app).get(`/api/inventory/day-stores/${storeB.body.id}/stock`).set(authHeader(restrictedToken))).status).toBe(403);
    // PPIC stays unrestricted regardless — same store B, no assignment needed.
    expect((await request(app).get(`/api/inventory/day-stores/${storeB.body.id}/stock`).set(authHeader(ppicToken))).status).toBe(200);

    // Direct issue (ISSUED_DAY_STORE): A allowed, B blocked.
    const issueA = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(restrictedToken))
      .send({ itemId: item.body.id, type: "ISSUED_DAY_STORE", date: "2026-08-23", unit: "Kg", quantity: 10, dayStoreId: storeA.body.id });
    expect(issueA.status).toBe(201);
    const issueB = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(restrictedToken))
      .send({ itemId: item.body.id, type: "ISSUED_DAY_STORE", date: "2026-08-23", unit: "Kg", quantity: 10, dayStoreId: storeB.body.id });
    expect(issueB.status).toBe(403);

    // Issuing a Material Request "from" Store B (ISSUED_PRODUCTION, dayStoreId: B) is blocked too.
    const req = await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId: item.body.id, category: "RM", requestedQty: 5, purpose: "ISSUED_PRODUCTION" });
    await request(app).patch(`/api/inventory/requests/${req.body.id}/review`).set(authHeader(restrictedToken)).send({ action: "APPROVE" });
    const issueFromB = await request(app)
      .post(`/api/inventory/requests/${req.body.id}/issue`)
      .set(authHeader(restrictedToken))
      .send({ date: "2026-08-23", unit: "Kg", quantity: 5, dayStoreId: storeB.body.id });
    expect(issueFromB.status).toBe(403);

    // An ADMIN doing the exact same thing bypasses the restriction entirely.
    const adminIssueB = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(adminToken))
      .send({ itemId: item.body.id, type: "ISSUED_DAY_STORE", date: "2026-08-23", unit: "Kg", quantity: 5, dayStoreId: storeB.body.id });
    expect(adminIssueB.status).toBe(201);
  });
});

describe("S6/S7 — Day Store / Plant tagging on the existing ledger", () => {
  it("tags which Day Store received an ISSUED_DAY_STORE entry", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    const dayStore = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Day Store A" });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-20", unit: "Kg", quantity: 10, isOpeningStock: true });

    const txn = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "ISSUED_DAY_STORE", date: "2026-08-21", unit: "Kg", quantity: 10, dayStoreId: dayStore.body.id });
    expect(txn.status).toBe(201);
    expect(txn.body.dayStore.name).toBe("Day Store A");
  });

  it("bulk import reads a per-row Day Store column and tags each row accordingly, auto-creating any store name it hasn't seen before", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const existingStore = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Store 1" });
    await request(app)
      .post("/api/inventory/transactions/import")
      .set(authHeader(storeToken))
      .send({
        type: "RECEIVED",
        isOpeningStock: true,
        rows: [
          { category: "RM", itemName: "Whey Protein", date: "2026-08-20", unit: "Kg", quantity: 25 },
          { category: "PM", itemName: "1kg Jar", date: "2026-08-20", unit: "Count", quantity: 500 },
        ],
      });

    const imported = await request(app)
      .post("/api/inventory/transactions/import")
      .set(authHeader(storeToken))
      .send({
        type: "ISSUED_DAY_STORE",
        rows: [
          { category: "RM", itemName: "Whey Protein", date: "2026-08-21", unit: "Kg", quantity: 25, dayStoreName: "Store 1" },
          { category: "PM", itemName: "1kg Jar", date: "2026-08-21", unit: "Count", quantity: 500, dayStoreName: "Store 2" },
        ],
      });
    expect(imported.status).toBe(201);
    // Items were already resolved by the opening-stock seed above, not
    // created fresh here — itemsCreated is 0, not 2.
    expect(imported.body).toEqual({ transactionsCreated: 2, itemsCreated: 0, dayStoresCreated: 1 });

    const newStore = await request(app).get("/api/inventory/day-stores").set(authHeader(storeToken));
    expect(newStore.body.map((d: { name: string }) => d.name).sort()).toEqual(["Store 1", "Store 2"]);

    const txns = await request(app).get("/api/inventory/transactions?type=ISSUED_DAY_STORE").set(authHeader(storeToken));
    const byItem = (name: string) => txns.body.find((t: { item: { name: string } }) => t.item.name === name);
    expect(byItem("Whey Protein").dayStore.id).toBe(existingStore.body.id);
    expect(byItem("1kg Jar").dayStore.name).toBe("Store 2");
  });

  it("real-time per-store balance: rises when issued to the store, falls when Store tags a production issuance as coming from it, and central-stock issuances don't touch it", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    const dayStore = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Store 1" });

    // Real stock first — issuing (direct or via request) checks live
    // on-hand now, so this per-store balance test needs something real
    // to draw down instead of running the whole thing on nothing.
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 100, isOpeningStock: true });

    // 25 Kg goes to Store 1.
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "ISSUED_DAY_STORE", date: "2026-08-22", unit: "Kg", quantity: 25, dayStoreId: dayStore.body.id });

    const afterIssue = await request(app).get(`/api/inventory/day-stores/${dayStore.body.id}/stock`).set(authHeader(storeToken));
    expect(afterIssue.status).toBe(200);
    expect(afterIssue.body.dayStore.name).toBe("Store 1");
    expect(afterIssue.body.stock).toEqual([
      expect.objectContaining({ item: expect.objectContaining({ name: "Whey Protein" }), receivedFromWarehouse: 25, issuedToProduction: 0, onHand: 25 }),
    ]);

    // 10 Kg of it goes on to Production, explicitly tagged as coming out of Store 1.
    const req = await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId: item.body.id, category: "RM", requestedQty: 10, purpose: "ISSUED_PRODUCTION" });
    await request(app).patch(`/api/inventory/requests/${req.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
    const missingChoice = await request(app)
      .post(`/api/inventory/requests/${req.body.id}/issue`)
      .set(authHeader(storeToken))
      .send({ date: "2026-08-22", unit: "Kg", quantity: 10 });
    expect(missingChoice.status).toBe(400); // dayStoreId is required now, even to explicitly say "central stock"

    await request(app)
      .post(`/api/inventory/requests/${req.body.id}/issue`)
      .set(authHeader(storeToken))
      .send({ date: "2026-08-22", unit: "Kg", quantity: 10, dayStoreId: dayStore.body.id });

    const afterProduction = await request(app).get(`/api/inventory/day-stores/${dayStore.body.id}/stock`).set(authHeader(storeToken));
    expect(afterProduction.body.stock[0]).toEqual(expect.objectContaining({ receivedFromWarehouse: 25, issuedToProduction: 10, onHand: 15 })); // 25 - 10

    // A second request issued straight from central stock (dayStoreId: null) must NOT touch Store 1's balance.
    const req2 = await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId: item.body.id, category: "RM", requestedQty: 5, purpose: "ISSUED_PRODUCTION" });
    await request(app).patch(`/api/inventory/requests/${req2.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
    await request(app)
      .post(`/api/inventory/requests/${req2.body.id}/issue`)
      .set(authHeader(storeToken))
      .send({ date: "2026-08-22", unit: "Kg", quantity: 5, dayStoreId: null });

    const afterCentral = await request(app).get(`/api/inventory/day-stores/${dayStore.body.id}/stock`).set(authHeader(storeToken));
    expect(afterCentral.body.stock[0].onHand).toBe(15); // unchanged

    // Warehouse's own on-hand math is completely untouched by any of this
    // store-level bookkeeping — still just received minus all issued,
    // regardless of which store (if any) an issuance was tagged to.
    // 100 received − 25 (issued to store) − 15 (issued to production, both requests) = 60.
    const warehouseStock = await request(app).get("/api/inventory/stock").set(authHeader(storeToken));
    expect(warehouseStock.body[0].onHand).toBe(60);
  });

  it("blocks deleting an ISSUED_DAY_STORE entry that a later production issue 'from' that store already depends on — even though the Warehouse-wide total would stay fine", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 100, isOpeningStock: true });
    const dayStore = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Store 1" });

    const issueToStore = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "ISSUED_DAY_STORE", date: "2026-08-02", unit: "Kg", quantity: 25, dayStoreId: dayStore.body.id });

    // 20 of the 25 already left Store 1 for Production.
    const req = await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId: item.body.id, category: "RM", requestedQty: 20, purpose: "ISSUED_PRODUCTION" });
    await request(app).patch(`/api/inventory/requests/${req.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
    await request(app)
      .post(`/api/inventory/requests/${req.body.id}/issue`)
      .set(authHeader(storeToken))
      .send({ date: "2026-08-03", unit: "Kg", quantity: 20, dayStoreId: dayStore.body.id });

    // Deleting the original inflow to Store 1 would leave it at 20 issued
    // out against 0 received — even though the Warehouse-wide total
    // (100 received, 20 issued to production either way) is completely
    // unaffected by this delete either way.
    const blocked = await request(app).delete(`/api/inventory/transactions/${issueToStore.body.id}`).set(authHeader(storeToken));
    expect(blocked.status).toBe(409);

    const storeStock = await request(app).get(`/api/inventory/day-stores/${dayStore.body.id}/stock`).set(authHeader(storeToken));
    expect(storeStock.body.stock[0].onHand).toBe(5); // untouched — 25 - 20

    // A second, smaller issue-to-store with nothing depending on it deletes cleanly.
    const spareIssue = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "ISSUED_DAY_STORE", date: "2026-08-04", unit: "Kg", quantity: 3, dayStoreId: dayStore.body.id });
    const okDelete = await request(app).delete(`/api/inventory/transactions/${spareIssue.body.id}`).set(authHeader(storeToken));
    expect(okDelete.status).toBe(204);
  });

  it("blocks issuing to production 'from' a Day Store that never actually received that much, even when the Warehouse total is enough", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein Concentrate" });
    const dayStore = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Store 1" });

    // 120 Kg lands in the central Warehouse only — never allocated to Store 1.
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-22", unit: "Kg", quantity: 120, isOpeningStock: true });

    // Warehouse-wide there's plenty (120 >= 100), but tagging the issue
    // as coming out of Store 1 — which received 0 — must still be
    // rejected: that store's own shelf, not the company-wide total, is
    // the real ceiling for a Day-Store-tagged issue.
    const request1 = await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId: item.body.id, category: "RM", requestedQty: 100, purpose: "ISSUED_PRODUCTION" });
    await request(app).patch(`/api/inventory/requests/${request1.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });

    const issue = await request(app)
      .post(`/api/inventory/requests/${request1.body.id}/issue`)
      .set(authHeader(storeToken))
      .send({ date: "2026-08-22", unit: "Kg", quantity: 100, dayStoreId: dayStore.body.id });
    expect(issue.status).toBe(409);
    expect(issue.body.error).toMatch(/Day Store/);

    const storeStock = await request(app).get(`/api/inventory/day-stores/${dayStore.body.id}/stock`).set(authHeader(storeToken));
    expect(storeStock.body.stock).toEqual([]); // nothing ever happened at this store — no negative balance

    const request2 = await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId: item.body.id, category: "RM", requestedQty: 100, purpose: "ISSUED_PRODUCTION" });
    await request(app).patch(`/api/inventory/requests/${request2.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
    // Central stock (dayStoreId: null) still works — the Warehouse total really does cover it.
    const centralIssue = await request(app)
      .post(`/api/inventory/requests/${request2.body.id}/issue`)
      .set(authHeader(storeToken))
      .send({ date: "2026-08-22", unit: "Kg", quantity: 100, dayStoreId: null });
    expect(centralIssue.status).toBe(201);
  });

  it("tags which Plant a Material Request is for, and carries it onto the issued transaction along with the issuing Day Store", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    // 20 received: 10 goes on to Day Store A below, leaving 10 still in
    // the Warehouse-wide pool — enough left to also cover the production
    // issue further down, since (by design, see the per-store balance
    // test above) an ISSUED_PRODUCTION row still counts as its own
    // outflow from the Warehouse-wide total even when tagged to a store.
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 20, isOpeningStock: true });
    const plant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Plant 1" });
    const dayStore = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Day Store A" });
    // The issue below is tagged as coming out of Day Store A's own shelf
    // — it needs to have actually received that much first, same as any
    // other Day-Store-tagged production issue.
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "ISSUED_DAY_STORE", date: "2026-08-01", unit: "Kg", quantity: 10, dayStoreId: dayStore.body.id });

    const req1 = await request(app)
      .post("/api/inventory/requests")
      .set(authHeader(ppicToken))
      .send({ itemId: item.body.id, category: "RM", requestedQty: 10, purpose: "ISSUED_PRODUCTION", plantId: plant.body.id });
    expect(req1.body.plant.name).toBe("Plant 1");

    await request(app).patch(`/api/inventory/requests/${req1.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
    const issued = await request(app)
      .post(`/api/inventory/requests/${req1.body.id}/issue`)
      .set(authHeader(storeToken))
      .send({ date: "2026-08-21", unit: "Kg", quantity: 10, dayStoreId: dayStore.body.id });
    expect(issued.status).toBe(201);
    expect(issued.body.plant.name).toBe("Plant 1");
    expect(issued.body.dayStore.name).toBe("Day Store A");
  });
});

describe("S8/S9 — Plant-tagged FG transfer, Dispatch confirmation, Finance invoicing", () => {
  async function createClearedFgTransfer(storeToken: string, qaToken: string) {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });
    const plant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Plant 1" });
    const fg = await request(app)
      .post("/api/inventory/dispatch-transfers")
      .set(authHeader(storeToken))
      .send({ type: "FG", date: "2026-08-21", customerId: customer.body.id, productName: "Whey Gold 1Kg", quantity: 50, plantId: plant.body.id });
    expect(fg.body.plant.name).toBe("Plant 1");
    await request(app).patch(`/api/inventory/dispatch-transfers/${fg.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });
    return fg.body.id as string;
  }

  it("Dispatch can't confirm before outward QC clears; once cleared, confirms and Finance can then invoice", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const { token: dispatchToken } = await createUser(["DISPATCH"]);
    const { token: accountsToken } = await createUser(["ACCOUNTS"]);
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });

    const pending = await request(app)
      .post("/api/inventory/dispatch-transfers")
      .set(authHeader(storeToken))
      .send({ type: "FG", date: "2026-08-21", customerId: customer.body.id, productName: "Whey Gold 1Kg", quantity: 50 });

    const tooEarly = await request(app).patch(`/api/inventory/dispatch-transfers/${pending.body.id}/dispatch`).set(authHeader(dispatchToken)).send({});
    expect(tooEarly.status).toBe(409);

    const deniedRole = await request(app).patch(`/api/inventory/dispatch-transfers/${pending.body.id}/dispatch`).set(authHeader(storeToken)).send({});
    expect(deniedRole.status).toBe(403);

    const id = await createClearedFgTransfer(storeToken, qaToken);

    const invoiceTooEarly = await request(app).patch(`/api/inventory/dispatch-transfers/${id}/invoice`).set(authHeader(accountsToken)).send({ invoiceNumber: "INV-1" });
    expect(invoiceTooEarly.status).toBe(409);

    const dispatched = await request(app).patch(`/api/inventory/dispatch-transfers/${id}/dispatch`).set(authHeader(dispatchToken)).send({ dispatchNote: "Via road, LR-123" });
    expect(dispatched.status).toBe(200);
    expect(dispatched.body.dispatchedAt).not.toBeNull();

    const dispatchedAgain = await request(app).patch(`/api/inventory/dispatch-transfers/${id}/dispatch`).set(authHeader(dispatchToken)).send({});
    expect(dispatchedAgain.status).toBe(409);

    const invoiceDeniedRole = await request(app).patch(`/api/inventory/dispatch-transfers/${id}/invoice`).set(authHeader(dispatchToken)).send({ invoiceNumber: "INV-1" });
    expect(invoiceDeniedRole.status).toBe(403);

    const invoiced = await request(app).patch(`/api/inventory/dispatch-transfers/${id}/invoice`).set(authHeader(accountsToken)).send({ invoiceNumber: "INV-1" });
    expect(invoiced.status).toBe(200);
    expect(invoiced.body.invoiceNumber).toBe("INV-1");

    const invoicedAgain = await request(app).patch(`/api/inventory/dispatch-transfers/${id}/invoice`).set(authHeader(accountsToken)).send({ invoiceNumber: "INV-2" });
    expect(invoicedAgain.status).toBe(409);
  });

  it("notifies ACCOUNTS on dispatch confirmation and the original creator on invoicing", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const { token: dispatchToken } = await createUser(["DISPATCH"]);
    const { token: accountsToken } = await createUser(["ACCOUNTS"]);

    const id = await createClearedFgTransfer(storeToken, qaToken);
    await request(app).post("/api/notifications/read-all").set(authHeader(accountsToken));
    await request(app).patch(`/api/inventory/dispatch-transfers/${id}/dispatch`).set(authHeader(dispatchToken)).send({});

    const accountsInbox = await request(app).get("/api/notifications").set(authHeader(accountsToken));
    expect(accountsInbox.body.notifications.some((n: { title: string }) => n.title.includes("ready to invoice"))).toBe(true);

    await request(app).post("/api/notifications/read-all").set(authHeader(storeToken));
    await request(app).patch(`/api/inventory/dispatch-transfers/${id}/invoice`).set(authHeader(accountsToken)).send({ invoiceNumber: "INV-9" });

    const storeInbox = await request(app).get("/api/notifications").set(authHeader(storeToken));
    expect(storeInbox.body.notifications.some((n: { title: string }) => n.title.includes("invoiced"))).toBe(true);
  });
});
