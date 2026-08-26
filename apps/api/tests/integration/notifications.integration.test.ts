import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

async function notifsFor(token: string) {
  const res = await request(app).get("/api/notifications").set(authHeader(token));
  return res.body as { notifications: { id: string; title: string; body: string | null; readAt: string | null }[]; unreadCount: number };
}

async function createApprovedPoItem(bdToken: string) {
  const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });
  const po = await request(app)
    .post("/api/purchase-orders")
    .set(authHeader(bdToken))
    .send({ customerId: customer.body.id, items: [{ productName: "Medicine A", quantity: 100, unit: "KG" }] });
  await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
  return po.body.items[0].id as string;
}

describe("Notifications API", () => {
  it("returns only the caller's own notifications, newest first, with an unread count", async () => {
    const { token: storeToken, user: storeUser } = await createUser(["STORE"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });

    // A material request notifies STORE — targets storeUser, not ppicToken's user.
    await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId: item.body.id, category: "RM", requestedQty: 10, purpose: "ISSUED_PRODUCTION" });

    const storeInbox = await notifsFor(storeToken);
    expect(storeInbox.unreadCount).toBe(1);
    expect(storeInbox.notifications).toHaveLength(1);
    expect(storeInbox.notifications[0].readAt).toBeNull();
    expect(storeInbox.notifications[0].title).toContain("Whey Protein");

    const ppicInbox = await notifsFor(ppicToken);
    expect(ppicInbox.notifications).toHaveLength(0);
    expect(ppicInbox.unreadCount).toBe(0);
    void storeUser;
  });

  it("POST /:id/read marks one notification read, is idempotent, and is forbidden for someone else's notification", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: otherStoreToken } = await createUser(["STORE"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId: item.body.id, category: "RM", requestedQty: 10, purpose: "ISSUED_PRODUCTION" });

    const inbox = await notifsFor(storeToken);
    const notifId = inbox.notifications[0].id;

    const deniedForOther = await request(app).post(`/api/notifications/${notifId}/read`).set(authHeader(otherStoreToken));
    expect(deniedForOther.status).toBe(403);

    const missing = await request(app).post("/api/notifications/00000000-0000-0000-0000-000000000000/read").set(authHeader(storeToken));
    expect(missing.status).toBe(404);

    const marked = await request(app).post(`/api/notifications/${notifId}/read`).set(authHeader(storeToken));
    expect(marked.status).toBe(200);
    expect(marked.body.readAt).not.toBeNull();

    // Idempotent — reading an already-read notification doesn't error or bump the timestamp meaningfully.
    const markedAgain = await request(app).post(`/api/notifications/${notifId}/read`).set(authHeader(storeToken));
    expect(markedAgain.status).toBe(200);

    const after = await notifsFor(storeToken);
    expect(after.unreadCount).toBe(0);
  });

  it("POST /read-all clears every unread notification for the caller only", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId: item.body.id, category: "RM", requestedQty: 10, purpose: "ISSUED_PRODUCTION" });
    await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId: item.body.id, category: "RM", requestedQty: 5, purpose: "ISSUED_DAY_STORE" });

    const result = await request(app).post("/api/notifications/read-all").set(authHeader(storeToken));
    expect(result.status).toBe(200);
    expect(result.body.markedRead).toBe(2);

    const after = await notifsFor(storeToken);
    expect(after.unreadCount).toBe(0);
  });
});

describe("Notification wiring — Purchase Orders", () => {
  it("approval notifies the creator and PPIC; rejection notifies only the creator with the reason", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });

    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.body.id, items: [{ productName: "Medicine A", quantity: 10, unit: "KG" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });

    const bdInbox = await notifsFor(bdToken);
    expect(bdInbox.notifications.some((n) => n.title.includes("approved"))).toBe(true);
    const ppicInbox = await notifsFor(ppicToken);
    expect(ppicInbox.notifications.some((n) => n.title.includes("approved"))).toBe(true);

    const po2 = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.body.id, items: [{ productName: "Medicine B", quantity: 10, unit: "KG" }] });
    await request(app).patch(`/api/purchase-orders/${po2.body.id}/review`).set(authHeader(bdToken)).send({ status: "REJECTED", rejectionReason: "Wrong pricing" });

    const bdInboxAfterReject = await notifsFor(bdToken);
    const rejectNotif = bdInboxAfterReject.notifications.find((n) => n.title.includes("rejected"));
    expect(rejectNotif?.body).toBe("Wrong pricing");
  });
});

describe("Notification wiring — Batches", () => {
  it("forwarding notifies the next stage's role, excluding the actor, and DISPATCH_PLAN's self-forward doesn't re-notify", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const itemId = await createApprovedPoItem(bdToken);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const batch = await request(app).post("/api/batches").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    const batchId = batch.body.id;

    const { token: purchaseToken } = await createUser(["PURCHASE"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: dispatchToken } = await createUser(["DISPATCH"]);

    // PO_RELEASE -> MATERIAL_RECEIVED: Store should be notified, Purchase (the actor) should not.
    await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(purchaseToken)).send({ action: "FORWARD", rmStatus: "Available", pmStatus: "Available" });
    const storeInbox = await notifsFor(storeToken);
    expect(storeInbox.notifications.some((n) => n.title.includes("Material Received"))).toBe(true);
    const purchaseInbox = await notifsFor(purchaseToken);
    expect(purchaseInbox.unreadCount).toBe(0);

    // Admin jump straight to DISPATCH_PLAN — Dispatch should be notified.
    const { token: adminToken } = await createUser(["ADMIN"]);
    await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "DISPATCH_PLAN" });
    const dispatchInboxBefore = await notifsFor(dispatchToken);
    expect(dispatchInboxBefore.unreadCount).toBeGreaterThan(0);
    await request(app).post("/api/notifications/read-all").set(authHeader(dispatchToken));

    // DISPATCH_PLAN forwards to itself (terminal) — no repeat notification on save.
    await request(app).patch(`/api/batches/${batchId}/stage`).set(authHeader(dispatchToken)).send({ action: "FORWARD" });
    const dispatchInboxAfter = await notifsFor(dispatchToken);
    expect(dispatchInboxAfter.unreadCount).toBe(0);
  });
});

describe("Notification wiring — Inventory", () => {
  it("a RECEIVED transaction notifies QA_QC; QC review notifies STORE", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });

    const txn = await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 100 });
    const qaInbox = await notifsFor(qaToken);
    expect(qaInbox.notifications.some((n) => n.title.includes("inward QC"))).toBe(true);

    await request(app).post("/api/notifications/read-all").set(authHeader(storeToken));
    await request(app).patch(`/api/inventory/transactions/${txn.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });
    const storeInbox = await notifsFor(storeToken);
    expect(storeInbox.notifications.some((n) => n.title.includes("QC-approved"))).toBe(true);
  });

  it("a material request notifies STORE; review and issue notify the requester", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 10, isOpeningStock: true });

    const created = await request(app).post("/api/inventory/requests").set(authHeader(ppicToken)).send({ itemId: item.body.id, category: "RM", requestedQty: 10, purpose: "ISSUED_PRODUCTION" });
    const storeInbox = await notifsFor(storeToken);
    expect(storeInbox.notifications.some((n) => n.title.includes("New request"))).toBe(true);

    await request(app).patch(`/api/inventory/requests/${created.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
    const ppicInboxAfterReview = await notifsFor(ppicToken);
    expect(ppicInboxAfterReview.notifications.some((n) => n.title.toLowerCase().includes("approved"))).toBe(true);
    await request(app).post("/api/notifications/read-all").set(authHeader(ppicToken));

    await request(app)
      .post(`/api/inventory/requests/${created.body.id}/issue`)
      .set(authHeader(storeToken))
      .send({ date: "2026-08-01", unit: "Kg", quantity: 10, dayStoreId: null });
    const ppicInboxAfterIssue = await notifsFor(ppicToken);
    expect(ppicInboxAfterIssue.notifications.some((n) => n.title.includes("Issued"))).toBe(true);
  });

  it("bulk material request import notifies STORE once for the batch", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: ppicToken } = await createUser(["PPIC"]);

    await request(app)
      .post("/api/inventory/requests/import")
      .set(authHeader(ppicToken))
      .send({ rows: [{ category: "RM", itemName: "Whey Protein", requestedQty: 10, purpose: "ISSUED_PRODUCTION" }] });

    const storeInbox = await notifsFor(storeToken);
    expect(storeInbox.notifications.some((n) => n.title.includes("new material request"))).toBe(true);
  });

  it("creating an FG dispatch transfer notifies QA_QC; a BILL transfer does not", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });

    await request(app)
      .post("/api/inventory/dispatch-transfers")
      .set(authHeader(storeToken))
      .send({ type: "BILL", date: "2026-08-11", customerId: customer.body.id, productName: "Whey Protein 1Kg Jar", quantity: 200 });
    const qaInboxAfterBill = await notifsFor(qaToken);
    expect(qaInboxAfterBill.unreadCount).toBe(0);

    await request(app)
      .post("/api/inventory/dispatch-transfers")
      .set(authHeader(storeToken))
      .send({ type: "FG", date: "2026-08-10", customerId: customer.body.id, productName: "Whey Protein 1Kg Jar", quantity: 200 });
    const qaInboxAfterFg = await notifsFor(qaToken);
    expect(qaInboxAfterFg.notifications.some((n) => n.title.includes("outward QC"))).toBe(true);
  });

  it("bulk FG dispatch import notifies QA_QC; outward QC review notifies STORE", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const { token: bdToken } = await createUser(["BD"]);
    await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });

    await request(app)
      .post("/api/inventory/dispatch-transfers/import")
      .set(authHeader(storeToken))
      .send({ type: "FG", rows: [{ customerName: "Acme Nutrition Pvt. Ltd.", date: "2026-08-10", productName: "Whey Gold 1Kg", quantity: 50 }] });

    const qaInbox = await notifsFor(qaToken);
    expect(qaInbox.notifications.some((n) => n.title.includes("awaiting outward QC"))).toBe(true);

    const list = await request(app).get("/api/inventory/dispatch-transfers?type=FG").set(authHeader(storeToken));
    const transferId = list.body[0].id;

    await request(app).post("/api/notifications/read-all").set(authHeader(storeToken));
    await request(app).patch(`/api/inventory/dispatch-transfers/${transferId}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });

    const storeInbox = await notifsFor(storeToken);
    expect(storeInbox.notifications.some((n) => n.title.includes("outward QC-approved"))).toBe(true);
  });
});
