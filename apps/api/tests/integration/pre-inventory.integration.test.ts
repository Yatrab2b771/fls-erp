import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

/** Gives an item real, accepted stock via the Opening Stock path — the simplest way to get live stock-on-hand without going through QC. */
async function giveStock(storeToken: string, itemId: string, quantity: number) {
  await request(app)
    .post("/api/inventory/transactions")
    .set(authHeader(storeToken))
    .send({ itemId, type: "RECEIVED", date: "2026-08-21", unit: "Kg", quantity, isOpeningStock: true });
}

describe("Pre-Inventory — S1-S4 requirement planning loop (live stock, no manual availability step)", () => {
  it("PPIC creates a requirement (S1); it's visible to Store/Purchase/Accounts and scoped to own for PPIC, with live currentStock attached", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: otherPpicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: purchaseToken } = await createUser(["PURCHASE"]);
    const { token: accountsToken } = await createUser(["ACCOUNTS"]);
    const { token: plainToken } = await createUser([]);

    const denied = await request(app)
      .post("/api/inventory/requirements")
      .set(authHeader(storeToken))
      .send({ date: "2026-08-21", category: "RM", itemId: "00000000-0000-0000-0000-000000000000", unit: "Kg", requiredQty: 100 });
    expect(denied.status).toBe(403);

    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });

    const badItem = await request(app)
      .post("/api/inventory/requirements")
      .set(authHeader(ppicToken))
      .send({ date: "2026-08-21", category: "RM", itemId: "00000000-0000-0000-0000-000000000000", unit: "Kg", requiredQty: 100 });
    expect(badItem.status).toBe(400);

    const created = await request(app)
      .post("/api/inventory/requirements")
      .set(authHeader(ppicToken))
      .send({ date: "2026-08-21", category: "RM", itemId: item.body.id, unit: "Kg", requiredQty: 100 });
    expect(created.status).toBe(201);
    // No stock exists yet for this item — live currentStock is 0, fully short.
    expect(created.body.currentStock).toBe(0);
    expect(created.body.shortQty).toBe(100);

    const deniedRead = await request(app).get("/api/inventory/requirements").set(authHeader(plainToken));
    expect(deniedRead.status).toBe(403);

    const asOwner = await request(app).get("/api/inventory/requirements").set(authHeader(ppicToken));
    expect(asOwner.body.length).toBe(1);

    const asOtherPpic = await request(app).get("/api/inventory/requirements").set(authHeader(otherPpicToken));
    expect(asOtherPpic.body.length).toBe(0);

    const asStore = await request(app).get("/api/inventory/requirements").set(authHeader(storeToken));
    expect(asStore.body.length).toBe(1);
    const asPurchase = await request(app).get("/api/inventory/requirements").set(authHeader(purchaseToken));
    expect(asPurchase.body.length).toBe(1);
    const asAccounts = await request(app).get("/api/inventory/requirements").set(authHeader(accountsToken));
    expect(asAccounts.body.length).toBe(1);
  });

  it("currentStock/shortQty are computed live off the real stock ledger, updating as stock changes — no manual confirmation step", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: purchaseToken } = await createUser(["PURCHASE"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    const requirement = await request(app)
      .post("/api/inventory/requirements")
      .set(authHeader(ppicToken))
      .send({ date: "2026-08-21", category: "RM", itemId: item.body.id, unit: "Kg", requiredQty: 100 });
    const id = requirement.body.id;

    // Purchase blocked before there's a shortfall to act on — this
    // fresh requirement is already 100 short (0 on hand), so it's
    // actionable immediately, no separate "confirm availability" wait.
    const tooEarlyFullyCovered = await request(app).patch(`/api/inventory/requirements/${id}/purchase`).set(authHeader(purchaseToken)).send({ poNumber: "PO-1", vendorName: "Acme", eta: "2026-09-01" });
    expect(tooEarlyFullyCovered.status).toBe(200); // it IS short (0/100), so this succeeds

    // A second requirement, on an item that already has full stock —
    // live currentStock reflects it immediately, no shortfall, Purchase blocked.
    await giveStock(storeToken, item.body.id, 500);
    const requirement2 = await request(app)
      .post("/api/inventory/requirements")
      .set(authHeader(ppicToken))
      .send({ date: "2026-08-21", category: "RM", itemId: item.body.id, unit: "Kg", requiredQty: 20 });
    expect(requirement2.body.currentStock).toBe(500);
    expect(requirement2.body.shortQty).toBe(0);

    const blockedFullyCovered = await request(app)
      .patch(`/api/inventory/requirements/${requirement2.body.id}/purchase`)
      .set(authHeader(purchaseToken))
      .send({ poNumber: "PO-2", vendorName: "Acme", eta: "2026-09-01" });
    expect(blockedFullyCovered.status).toBe(409);

    const shortOnly = await request(app).get("/api/inventory/requirements?short=true").set(authHeader(purchaseToken));
    expect(shortOnly.body.map((r: { id: string }) => r.id)).toEqual([]); // both requirements are resolved: #1 has a PO, #2 is fully covered
  });

  // Per the client: a shortfall existing isn't reason enough for the
  // system to tell Purchase on its own — PPIC has to explicitly send it.
  it("POST /:id/notify-purchase — PPIC-only, requires an actual live shortfall, and is the only way Purchase gets told now", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: purchaseToken } = await createUser(["PURCHASE"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Notify-Purchase Protein" });

    const created = await request(app)
      .post("/api/inventory/requirements")
      .set(authHeader(ppicToken))
      .send({ date: "2026-08-21", category: "RM", itemId: item.body.id, unit: "Kg", requiredQty: 50 });

    // Creating it alone raised no notification at all.
    const beforeSend = await request(app).get("/api/notifications").set(authHeader(purchaseToken));
    expect(beforeSend.body.unreadCount).toBe(0);

    const deniedRole = await request(app).post(`/api/inventory/requirements/${created.body.id}/notify-purchase`).set(authHeader(storeToken));
    expect(deniedRole.status).toBe(403);

    const sent = await request(app).post(`/api/inventory/requirements/${created.body.id}/notify-purchase`).set(authHeader(ppicToken));
    expect(sent.status).toBe(200);

    const afterSend = await request(app).get("/api/notifications").set(authHeader(purchaseToken));
    expect(afterSend.body.notifications.some((n: { title: string }) => n.title.includes("Notify-Purchase Protein"))).toBe(true);

    // A second send still works (no state change to block a repeat) —
    // but once fully covered, it's refused.
    await giveStock(storeToken, item.body.id, 100);
    const nothingToSend = await request(app).post(`/api/inventory/requirements/${created.body.id}/notify-purchase`).set(authHeader(ppicToken));
    expect(nothingToSend.status).toBe(400);
  });

  it("bulk-imports requirements (S1) — no auto-notify to Purchase any more, that's PPIC's own explicit call now", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: purchaseToken } = await createUser(["PURCHASE"]);

    const denied = await request(app)
      .post("/api/inventory/requirements/import")
      .set(authHeader(storeToken))
      .send({ rows: [{ date: "2026-08-21", category: "RM", itemName: "Whey Protein", unit: "Kg", requiredQty: 50 }] });
    expect(denied.status).toBe(403);

    // Give "Jar 1Kg" enough stock upfront that its row imports as covered.
    const jar = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "PM", name: "Jar 1Kg" });
    await giveStock(storeToken, jar.body.id, 300);

    const imported = await request(app)
      .post("/api/inventory/requirements/import")
      .set(authHeader(ppicToken))
      .send({
        rows: [
          { date: "2026-08-21", category: "RM", itemName: "Whey Protein", unit: "Kg", requiredQty: 50 }, // no stock — short
          { date: "2026-08-22", category: "PM", itemName: "Jar 1Kg", unit: "Count", requiredQty: 200 }, // 300 on hand — covered
        ],
      });
    expect(imported.status).toBe(201);
    expect(imported.body).toEqual({ requirementsCreated: 2, itemsCreated: 1 });

    const purchaseInbox = await request(app).get("/api/notifications").set(authHeader(purchaseToken));
    expect(purchaseInbox.body.unreadCount).toBe(0);

    const shortOnly = await request(app).get("/api/inventory/requirements?short=true&category=RM").set(authHeader(storeToken));
    expect(shortOnly.body.length).toBe(1);
    expect(shortOnly.body[0].item.name).toBe("Whey Protein");
  });

  it("deletion: PPIC can remove their own requirement until a PO is logged against it; not after", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: otherPpicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: purchaseToken } = await createUser(["PURCHASE"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    const requirement = await request(app)
      .post("/api/inventory/requirements")
      .set(authHeader(ppicToken))
      .send({ date: "2026-08-21", category: "RM", itemId: item.body.id, unit: "Kg", requiredQty: 100 });

    const deniedOther = await request(app).delete(`/api/inventory/requirements/${requirement.body.id}`).set(authHeader(otherPpicToken));
    expect(deniedOther.status).toBe(403);

    await request(app).patch(`/api/inventory/requirements/${requirement.body.id}/purchase`).set(authHeader(purchaseToken)).send({ poNumber: "PO-1", vendorName: "Acme", eta: "2026-09-01" });
    const tooLate = await request(app).delete(`/api/inventory/requirements/${requirement.body.id}`).set(authHeader(ppicToken));
    expect(tooLate.status).toBe(409);

    // A fresh one, untouched by Purchase, can still be withdrawn.
    const requirement2 = await request(app)
      .post("/api/inventory/requirements")
      .set(authHeader(ppicToken))
      .send({ date: "2026-08-21", category: "RM", itemId: item.body.id, unit: "Kg", requiredQty: 5 });
    const deleted = await request(app).delete(`/api/inventory/requirements/${requirement2.body.id}`).set(authHeader(ppicToken));
    expect(deleted.status).toBe(204);
  });

  // Per the client: Purchase shouldn't have to wait on PPIC to raise a
  // shortfall it already knows about — but logging the actual PO/Vendor/
  // ETA stays Purchase-only; PPIC's role is planning (raising the
  // requirement), not buying.
  it("Purchase can log a requirement directly (not just react to one PPIC raised) — but logging the PO/Vendor/ETA stays Purchase-only, not PPIC's", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: purchaseToken } = await createUser(["PURCHASE"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);

    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Direct-Log Protein" });

    // Purchase raises the requirement itself — no PPIC involved at all.
    const deniedCreate = await request(app)
      .post("/api/inventory/requirements")
      .set(authHeader(qaToken))
      .send({ date: "2026-08-21", category: "RM", itemId: item.body.id, unit: "Kg", requiredQty: 20 });
    expect(deniedCreate.status).toBe(403);

    const created = await request(app)
      .post("/api/inventory/requirements")
      .set(authHeader(purchaseToken))
      .send({ date: "2026-08-21", category: "RM", itemId: item.body.id, unit: "Kg", requiredQty: 20 });
    expect(created.status).toBe(201);

    // Purchase can immediately follow up with the PO/Vendor/ETA on the
    // same row it just raised.
    const purchased = await request(app)
      .patch(`/api/inventory/requirements/${created.body.id}/purchase`)
      .set(authHeader(purchaseToken))
      .send({ poNumber: "PO-DIRECT-1", vendorName: "Direct Vendor Co.", eta: "2026-09-15" });
    expect(purchased.status).toBe(200);
    expect(purchased.body.poNumber).toBe("PO-DIRECT-1");

    // PPIC raises its own requirement (planning) but can't log the PO
    // against it — that's Purchase's job.
    const item2 = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "PPIC-Logged Protein" });
    const raisedByPpic = await request(app)
      .post("/api/inventory/requirements")
      .set(authHeader(ppicToken))
      .send({ date: "2026-08-21", category: "RM", itemId: item2.body.id, unit: "Kg", requiredQty: 10 });
    expect(raisedByPpic.status).toBe(201);

    const deniedPurchaseByPpic = await request(app)
      .patch(`/api/inventory/requirements/${raisedByPpic.body.id}/purchase`)
      .set(authHeader(ppicToken))
      .send({ poNumber: "PO-DIRECT-2", vendorName: "PPIC's Own Vendor", eta: "2026-09-20" });
    expect(deniedPurchaseByPpic.status).toBe(403);
  });

  it("bulk-logs POs (S3), matching rows to open requirements by item + category, oldest first, skipping what's already covered or unmatched", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: purchaseToken } = await createUser(["PURCHASE"]);
    const { token: accountsToken } = await createUser(["ACCOUNTS"]);

    // Logging a PO is Purchase-only — Store (and PPIC, planning only) are
    // both denied here.
    const denied = await request(app)
      .post("/api/inventory/requirements/purchase/import")
      .set(authHeader(storeToken))
      .send({ rows: [{ itemName: "Whey Protein", category: "RM", poNumber: "PO-1", vendorName: "Acme", eta: "2026-09-01" }] });
    expect(denied.status).toBe(403);
    const deniedPpic = await request(app)
      .post("/api/inventory/requirements/purchase/import")
      .set(authHeader(ppicToken))
      .send({ rows: [{ itemName: "Whey Protein", category: "RM", poNumber: "PO-1", vendorName: "Acme", eta: "2026-09-01" }] });
    expect(deniedPpic.status).toBe(403);

    // Two separate open requirements for the same item — the import
    // should claim them in FIFO order, not double-book the first one.
    const whey = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    const req1 = await request(app).post("/api/inventory/requirements").set(authHeader(ppicToken)).send({ date: "2026-08-21", category: "RM", itemId: whey.body.id, unit: "Kg", requiredQty: 100 });
    const req2 = await request(app).post("/api/inventory/requirements").set(authHeader(ppicToken)).send({ date: "2026-08-21", category: "RM", itemId: whey.body.id, unit: "Kg", requiredQty: 50 });

    // A fully-covered requirement — the import should treat it like the
    // single-item route does (409 there) and just skip it as unmatched.
    const jar = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "PM", name: "Jar 1Kg" });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: jar.body.id, type: "RECEIVED", date: "2026-08-21", unit: "Count", quantity: 500, isOpeningStock: true });
    await request(app).post("/api/inventory/requirements").set(authHeader(ppicToken)).send({ date: "2026-08-21", category: "PM", itemId: jar.body.id, unit: "Count", requiredQty: 200 });

    const imported = await request(app)
      .post("/api/inventory/requirements/purchase/import")
      .set(authHeader(purchaseToken))
      .send({
        rows: [
          { itemName: "Whey Protein", category: "RM", poNumber: "PO-1", vendorName: "Acme", eta: "2026-09-01" },
          { itemName: "Whey Protein", category: "RM", poNumber: "PO-2", vendorName: "Acme", eta: "2026-09-05" },
          { itemName: "Jar 1Kg", category: "PM", poNumber: "PO-3", vendorName: "PackCo", eta: "2026-09-01" },
          { itemName: "Nonexistent Item", category: "RM", poNumber: "PO-4", vendorName: "Nobody", eta: "2026-09-01" },
        ],
      });
    expect(imported.status).toBe(201);
    expect(imported.body.posLogged).toBe(2);
    expect(imported.body.unmatched).toEqual(["Jar 1Kg (PM)", "Nonexistent Item (RM)"]);

    const reqs = await request(app).get("/api/inventory/requirements?category=RM").set(authHeader(ppicToken));
    const row1 = reqs.body.find((r: { id: string }) => r.id === req1.body.id);
    const row2 = reqs.body.find((r: { id: string }) => r.id === req2.body.id);
    expect(row1.poNumber).toBe("PO-1"); // older requirement got the first row
    expect(row2.poNumber).toBe("PO-2");

    const ppicInbox = await request(app).get("/api/notifications").set(authHeader(ppicToken));
    expect(ppicInbox.body.notifications.filter((n: { title: string }) => n.title === "PO logged for Whey Protein")).toHaveLength(2);

    const accountsInbox = await request(app).get("/api/notifications").set(authHeader(accountsToken));
    expect(accountsInbox.body.notifications.some((n: { title: string }) => n.title.includes("2 new POs logged from a bulk import"))).toBe(true);
  });

  it('"Stock Now Available" fires only on the 0→positive crossing, only when a requirement is actually waiting on it', async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });

    const requirement = await request(app)
      .post("/api/inventory/requirements")
      .set(authHeader(ppicToken))
      .send({ date: "2026-08-21", category: "RM", itemId: item.body.id, unit: "Kg", requiredQty: 300 });
    expect(requirement.status).toBe(201);

    // First delivery — 0 -> 150, the crossing. Goes through the normal
    // QC path (not Opening Stock), to prove the alert fires from there too.
    const received = await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-21", unit: "Kg", quantity: 150 });
    await request(app).patch(`/api/inventory/transactions/${received.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });
    await request(app).post(`/api/inventory/transactions/${received.body.id}/accept`).set(authHeader(storeToken));

    const ppicInbox = await request(app).get("/api/notifications").set(authHeader(ppicToken));
    expect(ppicInbox.body.notifications.some((n: { title: string }) => n.title === "Whey Protein now available")).toBe(true);
    const productionInbox = await request(app).get("/api/notifications").set(authHeader(productionToken));
    expect(productionInbox.body.notifications.some((n: { title: string }) => n.title === "Whey Protein now available")).toBe(true);

    // Second delivery on top of existing stock — no repeat alert, it already crossed.
    await request(app).post("/api/notifications/read-all").set(authHeader(ppicToken));
    const received2 = await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-22", unit: "Kg", quantity: 50 });
    await request(app).patch(`/api/inventory/transactions/${received2.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });
    await request(app).post(`/api/inventory/transactions/${received2.body.id}/accept`).set(authHeader(storeToken));

    const ppicInboxAfter = await request(app).get("/api/notifications").set(authHeader(ppicToken));
    expect(ppicInboxAfter.body.unreadCount).toBe(0);

    // Opening Stock on an item nobody asked for — crosses 0 -> positive, but no requirement exists, so silence.
    const otherItem = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Creatine" });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: otherItem.body.id, type: "RECEIVED", date: "2026-08-21", unit: "Kg", quantity: 100, isOpeningStock: true });
    const productionInboxAfter = await request(app).get("/api/notifications").set(authHeader(productionToken));
    expect(productionInboxAfter.body.notifications.some((n: { title: string }) => n.title === "Creatine now available")).toBe(false);
  });

  it('"Stock Now Available" also fires from a bulk Opening Stock import, summed per item across rows', async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });

    await request(app)
      .post("/api/inventory/requirements")
      .set(authHeader(ppicToken))
      .send({ date: "2026-08-21", category: "RM", itemId: item.body.id, unit: "Kg", requiredQty: 300 });

    await request(app)
      .post("/api/inventory/transactions/import")
      .set(authHeader(storeToken))
      .send({
        type: "RECEIVED",
        isOpeningStock: true,
        rows: [
          { category: "RM", itemName: "Whey Protein", date: "2026-08-21", unit: "Kg", quantity: 60 },
          { category: "RM", itemName: "Whey Protein", date: "2026-08-21", unit: "Kg", quantity: 40 },
        ],
      });

    const ppicInbox = await request(app).get("/api/notifications").set(authHeader(ppicToken));
    const notif = ppicInbox.body.notifications.find((n: { title: string }) => n.title === "Whey Protein now available");
    expect(notif).toBeTruthy();
    expect(notif.body).toContain("100"); // both rows' quantities summed before the crossing check
  });

  it("GET /vendors is open to STORE and PURCHASE, and lists vendor names from both Material Received and logged POs", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: purchaseToken } = await createUser(["PURCHASE"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });

    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-21", unit: "Kg", quantity: 10, vendorName: "Sunrise Ingredients" });

    const requirement = await request(app)
      .post("/api/inventory/requirements")
      .set(authHeader(ppicToken))
      .send({ date: "2026-08-21", category: "RM", itemId: item.body.id, unit: "Kg", requiredQty: 100 });
    await request(app)
      .patch(`/api/inventory/requirements/${requirement.body.id}/purchase`)
      .set(authHeader(purchaseToken))
      .send({ poNumber: "PO-1", vendorName: "PureCreatine Traders", eta: "2026-09-01" });

    const deniedRole = await request(app).get("/api/inventory/vendors").set(authHeader(qaToken));
    expect(deniedRole.status).toBe(403);

    // PPIC plans, doesn't buy — no reason to see the vendor picker either.
    const deniedPpic = await request(app).get("/api/inventory/vendors").set(authHeader(ppicToken));
    expect(deniedPpic.status).toBe(403);

    const asPurchase = await request(app).get("/api/inventory/vendors").set(authHeader(purchaseToken));
    expect(asPurchase.status).toBe(200);
    expect(asPurchase.body).toEqual({ vendors: ["PureCreatine Traders", "Sunrise Ingredients"], suggested: null });
  });

  it("paginates — both the plain list and the short=true derived-filter view slice correctly with a matching X-Total-Count", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });

    // 5 requirements, all short (no stock given).
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/inventory/requirements").set(authHeader(ppicToken)).send({ date: "2026-08-21", category: "RM", itemId: item.body.id, unit: "Kg", requiredQty: i + 1 });
    }

    const defaultPage = await request(app).get("/api/inventory/requirements").set(authHeader(ppicToken));
    expect(defaultPage.body.length).toBe(5);
    expect(defaultPage.headers["x-total-count"]).toBe("5");

    const firstPage = await request(app).get("/api/inventory/requirements?page=1&pageSize=2").set(authHeader(ppicToken));
    expect(firstPage.body.length).toBe(2);
    expect(firstPage.headers["x-total-count"]).toBe("5");
    const secondPage = await request(app).get("/api/inventory/requirements?page=2&pageSize=2").set(authHeader(ppicToken));
    expect(secondPage.body.length).toBe(2);
    const thirdPage = await request(app).get("/api/inventory/requirements?page=3&pageSize=2").set(authHeader(ppicToken));
    expect(thirdPage.body.length).toBe(1);
    const seenIds = new Set([...firstPage.body, ...secondPage.body, ...thirdPage.body].map((r: { id: string }) => r.id));
    expect(seenIds.size).toBe(5);

    // short=true is a derived (non-DB) filter — must page the already-filtered set, not the raw query.
    const shortDefault = await request(app).get("/api/inventory/requirements?short=true").set(authHeader(ppicToken));
    expect(shortDefault.body.length).toBe(5); // all 5 are short
    expect(shortDefault.headers["x-total-count"]).toBe("5");

    const shortFirstPage = await request(app).get("/api/inventory/requirements?short=true&page=1&pageSize=3").set(authHeader(ppicToken));
    expect(shortFirstPage.body.length).toBe(3);
    expect(shortFirstPage.headers["x-total-count"]).toBe("5");
    const shortSecondPage = await request(app).get("/api/inventory/requirements?short=true&page=2&pageSize=3").set(authHeader(ppicToken));
    expect(shortSecondPage.body.length).toBe(2);
  });
});
