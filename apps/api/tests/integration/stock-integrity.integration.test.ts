import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";
import { getExpiredRemainingByItemId, getInTransitByItemId, getOnHandByDayStoreAndItem, getOnHandByItemId, getTotalAvailableByItemId } from "../../src/modules/inventory/stock";

const app = createApp();
const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY);
let seq = 0;

/** A Warehouse seat, Accounts, a Day Store login for store A, R&D and an admin; one RM item with `received` Kg accepted into the Warehouse. */
async function setup(received = 100, opts: { expiry?: Date | null; unit?: string } = {}) {
  seq += 1;
  const warehouse = await createUser(["STORE"]); // no store assignment = the Warehouse seat
  const accounts = await createUser(["ACCOUNTS"]);
  const admin = await createUser(["ADMIN"]);
  const rnd = await createUser(["RND"]);
  const production = await createUser(["PRODUCTION"]);
  const storeAUser = await createUser(["STORE"]);
  const item = await prisma.inventoryItem.create({ data: { category: "RM", name: `SI Cocoa ${seq}-${Date.now()}`, unit: opts.unit ?? "Kg" } });
  const storeA = await prisma.dayStore.create({ data: { name: `SI Store ${seq}-${Date.now()}`, createdById: warehouse.user.id } });
  const plantA = await prisma.plant.create({ data: { name: storeA.name, createdById: warehouse.user.id, dayStoreId: storeA.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: storeAUser.user.id, dayStoreId: storeA.id } });
  const base = { itemId: item.id, createdById: warehouse.user.id, date: new Date(), unit: opts.unit ?? "Kg" };
  const receipt = received
    ? await prisma.inventoryTransaction.create({
        data: { ...base, type: "RECEIVED", quantity: received, vendorName: "V1", grnNo: `GRN-${seq}`, batchNo: `B-${seq}`, receiptStatus: "ACCEPTED", acceptedById: warehouse.user.id, acceptedAt: new Date(), expiryDate: opts.expiry === undefined ? inDays(300) : opts.expiry },
      })
    : null;
  return { warehouse, accounts, admin, rnd, production, storeAUser, item, storeA, plantA, base, receipt };
}

const issueToStore = (s: Awaited<ReturnType<typeof setup>>, quantity: number) =>
  prisma.inventoryTransaction.create({ data: { ...s.base, type: "ISSUED_DAY_STORE", quantity, dayStoreId: s.storeA.id, deliveredAt: new Date() } });

describe("Expiry is applied first-expiry-first-out: stock issued before it expired never turns the Warehouse negative", () => {
  it("receive 100, issue 60, the rest expires: Warehouse 0 (not -60), 40 sits in Quarantine, the Store still has its 60", async () => {
    const s = await setup(100);
    await issueToStore(s, 60);
    await prisma.inventoryTransaction.update({ where: { id: s.receipt!.id }, data: { expiryDate: inDays(-1) } }); // time passes

    expect((await getOnHandByItemId([s.item.id])).get(s.item.id)).toBe(0);
    expect((await getExpiredRemainingByItemId([s.item.id])).get(s.item.id)).toBe(40);
    expect((await getOnHandByDayStoreAndItem(s.storeA.id, [s.item.id])).get(s.item.id)?.onHand).toBe(60);

    // The Quarantine list shows the lot with the 40 that is still here, not the 100 that was received
    const quarantine = await request(app).get("/api/inventory/quarantine").set(authHeader(s.warehouse.token));
    const row = quarantine.body.find((r: { id: string }) => r.id === s.receipt!.id);
    expect(row).toMatchObject({ quarantineReason: "EXPIRED", remainingQty: 40 });
  });

  it("an expired lot that was fully issued before it expired is not in Quarantine at all", async () => {
    const s = await setup(50);
    await issueToStore(s, 50);
    await prisma.inventoryTransaction.update({ where: { id: s.receipt!.id }, data: { expiryDate: inDays(-1) } });
    expect((await getOnHandByItemId([s.item.id])).get(s.item.id)).toBe(0);
    expect((await getExpiredRemainingByItemId([s.item.id])).get(s.item.id)).toBeUndefined();
    const quarantine = await request(app).get("/api/inventory/quarantine").set(authHeader(s.warehouse.token));
    expect(quarantine.body.find((r: { id: string }) => r.id === s.receipt!.id)).toBeUndefined();
  });
});

describe("Stock corrections: raised by the place, approved by a second person, only then do they change stock", () => {
  const raise = (token: string, body: Record<string, unknown>) => request(app).post("/api/stock-adjustments").set(authHeader(token)).send(body);
  const review = (token: string, id: string, body: Record<string, unknown>) => request(app).post(`/api/stock-adjustments/${id}/review`).set(authHeader(token)).send(body);

  it("a physical count becomes a pending correction; nothing changes until Accounts approves", async () => {
    const s = await setup(100);
    const made = await raise(s.warehouse.token, { itemId: s.item.id, locationType: "WAREHOUSE", mode: "COUNT", countedQty: 90, note: "Shelf count on 15 Oct" });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ quantityDelta: -10, systemQty: 100, countedQty: 90, status: "PENDING", reason: "COUNT_CORRECTION" });
    expect((await getOnHandByItemId([s.item.id])).get(s.item.id)).toBe(100); // not yet

    expect((await review(s.warehouse.token, made.body.id, { action: "APPROVE" })).status).toBe(403); // not the raiser's call
    expect((await review(s.accounts.token, made.body.id, { action: "APPROVE" })).status).toBe(200);
    expect((await getOnHandByItemId([s.item.id])).get(s.item.id)).toBe(90);
    expect((await review(s.accounts.token, made.body.id, { action: "APPROVE" })).status).toBe(409); // already decided
  });

  it("a rejected correction never changes stock, and needs a reason", async () => {
    const s = await setup(100);
    const made = await raise(s.warehouse.token, { itemId: s.item.id, locationType: "WAREHOUSE", mode: "DELTA", quantityDelta: -5, reason: "DAMAGED", note: "Bags torn" });
    expect((await review(s.accounts.token, made.body.id, { action: "REJECT" })).status).toBe(400);
    expect((await review(s.accounts.token, made.body.id, { action: "REJECT", note: "Photo please" })).status).toBe(200);
    expect((await getOnHandByItemId([s.item.id])).get(s.item.id)).toBe(100);
  });

  it("refuses what could never be approved: a count equal to the system, taking out more than is there, found-extra that is negative", async () => {
    const s = await setup(100);
    expect((await raise(s.warehouse.token, { itemId: s.item.id, locationType: "WAREHOUSE", mode: "COUNT", countedQty: 100, note: "Counted again" })).status).toBe(400);
    expect((await raise(s.warehouse.token, { itemId: s.item.id, locationType: "WAREHOUSE", mode: "DELTA", quantityDelta: -500, reason: "SPILLAGE", note: "Big spill" })).status).toBe(409);
    expect((await raise(s.warehouse.token, { itemId: s.item.id, locationType: "WAREHOUSE", mode: "DELTA", quantityDelta: -2, reason: "FOUND_EXTRA", note: "wrong sign" })).status).toBe(400);
    expect((await raise(s.accounts.token, { itemId: s.item.id, locationType: "WAREHOUSE", mode: "DELTA", quantityDelta: 1, note: "Accounts cannot raise" })).status).toBe(403);
  });

  it("only the right seat corrects a place: a Store login its own store, not the Warehouse", async () => {
    const s = await setup(100);
    await issueToStore(s, 30);
    const own = await raise(s.storeAUser.token, { itemId: s.item.id, locationType: "DAY_STORE", dayStoreId: s.storeA.id, mode: "COUNT", countedQty: 28, note: "Two sacks short" });
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({ quantityDelta: -2, systemQty: 30 });
    expect((await raise(s.storeAUser.token, { itemId: s.item.id, locationType: "WAREHOUSE", mode: "DELTA", quantityDelta: -1, reason: "OTHER", note: "not my place" })).status).toBe(403);
    expect((await review(s.admin.token, own.body.id, { action: "APPROVE" })).status).toBe(200);
    expect((await getOnHandByDayStoreAndItem(s.storeA.id, [s.item.id])).get(s.item.id)?.onHand).toBe(28);
    expect((await getOnHandByItemId([s.item.id])).get(s.item.id)).toBe(70); // the Warehouse is untouched
  });

  it("expired stock thrown away comes out of Quarantine, not out of usable stock", async () => {
    const s = await setup(100);
    await issueToStore(s, 60);
    await prisma.inventoryTransaction.update({ where: { id: s.receipt!.id }, data: { expiryDate: inDays(-1) } });
    const tooMuch = await raise(s.warehouse.token, { itemId: s.item.id, locationType: "WAREHOUSE", mode: "DELTA", quantityDelta: -41, reason: "EXPIRED_DISPOSAL", note: "Destroy" });
    expect(tooMuch.status).toBe(409); // only 40 is expired in Quarantine
    const made = await raise(s.warehouse.token, { itemId: s.item.id, locationType: "WAREHOUSE", mode: "DELTA", quantityDelta: -40, reason: "EXPIRED_DISPOSAL", note: "Destroyed with certificate 7" });
    expect(made.status).toBe(201);
    expect((await review(s.accounts.token, made.body.id, { action: "APPROVE" })).status).toBe(200);
    expect((await getExpiredRemainingByItemId([s.item.id])).get(s.item.id)).toBeUndefined();
    expect((await getOnHandByItemId([s.item.id])).get(s.item.id)).toBe(0);
    expect((await getOnHandByDayStoreAndItem(s.storeA.id, [s.item.id])).get(s.item.id)?.onHand).toBe(60);
  });

  it("an item kept in Kg cannot be corrected in grams", async () => {
    const s = await setup(100);
    const bad = await raise(s.warehouse.token, { itemId: s.item.id, locationType: "WAREHOUSE", mode: "DELTA", quantityDelta: -1, unit: "gm", reason: "SPILLAGE", note: "wrong unit" });
    expect(bad.status).toBe(400);
  });
});

describe("Material in transit: short receipt, refusal, and it is never in no ledger", () => {
  const send = (token: string, body: Record<string, unknown>) => request(app).post("/api/stock-transfers").set(authHeader(token)).send(body);
  const toWarehouse = (s: Awaited<ReturnType<typeof setup>>, quantity: number) => send(s.storeAUser.token, { itemId: s.item.id, quantity, unit: "Kg", sourceType: "DAY_STORE", sourceDayStoreId: s.storeA.id, destinationType: "WAREHOUSE" });

  it("counts material that has been sent but not confirmed in Total Available (no phantom shortage)", async () => {
    const s = await setup(100);
    await issueToStore(s, 50);
    expect((await getTotalAvailableByItemId([s.item.id])).get(s.item.id)).toBe(100);
    const sent = await toWarehouse(s, 10);
    expect(sent.status).toBe(201);
    expect((await getInTransitByItemId([s.item.id])).get(s.item.id)).toBe(10);
    expect((await getTotalAvailableByItemId([s.item.id])).get(s.item.id)).toBe(100); // 50 + 40 + 10 on its way
  });

  it("the receiver can confirm less than was sent - with a reason - and the difference is a recorded loss", async () => {
    const s = await setup(100);
    await issueToStore(s, 50);
    const sent = await toWarehouse(s, 10);
    const confirm = (body: Record<string, unknown>) => request(app).post(`/api/stock-transfers/${sent.body.id}/confirm`).set(authHeader(s.warehouse.token)).send(body);

    expect((await confirm({ receivedQty: 11 })).status).toBe(400); // more than was sent
    expect((await confirm({ receivedQty: 7 })).status).toBe(400); // short without a reason
    const done = await confirm({ receivedQty: 7, note: "Bag torn on the way" });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "CONFIRMED", shortQty: 3, shortNote: "Bag torn on the way" });
    expect((await getOnHandByItemId([s.item.id])).get(s.item.id)).toBe(57); // 50 + the 7 that arrived
    expect((await getOnHandByDayStoreAndItem(s.storeA.id, [s.item.id])).get(s.item.id)?.onHand).toBe(40);
  });

  it("the receiver can refuse a transfer: the material goes back to the sender", async () => {
    const s = await setup(100);
    await issueToStore(s, 50);
    const sent = await toWarehouse(s, 10);
    expect((await getOnHandByDayStoreAndItem(s.storeA.id, [s.item.id])).get(s.item.id)?.onHand).toBe(40);
    const refuse = (token: string, body: Record<string, unknown>) => request(app).post(`/api/stock-transfers/${sent.body.id}/reject`).set(authHeader(token)).send(body);
    expect((await refuse(s.warehouse.token, {})).status).toBe(400); // a reason is needed
    expect((await refuse(s.production.token, { reason: "x" })).status).toBe(403);
    expect((await refuse(s.warehouse.token, { reason: "Wrong item sent" })).status).toBe(200);
    expect((await getOnHandByDayStoreAndItem(s.storeA.id, [s.item.id])).get(s.item.id)?.onHand).toBe(50); // back with the store
    expect((await refuse(s.warehouse.token, { reason: "again" })).status).toBe(404);
  });

  it("an R&D transfer can be received short, refused, and taken back by its sender while it is unconfirmed", async () => {
    const s = await setup(100);
    const sendToRnd = async (qty: number) => (await request(app).post("/api/rnd-store/transfers").set(authHeader(s.admin.token)).send({ direction: "TO_RND", itemId: s.item.id, quantity: qty, unit: "Kg" })).body;

    const t1 = await sendToRnd(20);
    expect((await getOnHandByItemId([s.item.id])).get(s.item.id)).toBe(80);
    // Short receipt at the R&D Store
    const confirmed = await request(app).post(`/api/rnd-store/transfers/${t1.id}/confirm`).set(authHeader(s.rnd.token)).send({ receivedQty: 18, note: "Seal broken" });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ shortQty: 2 });
    const stock = await request(app).get("/api/rnd-store/stock").set(authHeader(s.rnd.token));
    expect(stock.body.find((r: { item: { id: string } }) => r.item.id === s.item.id)?.onHand).toBe(18);

    // Refused by R&D: back in the Warehouse
    const t2 = await sendToRnd(10);
    expect((await request(app).post(`/api/rnd-store/transfers/${t2.id}/reject`).set(authHeader(s.rnd.token)).send({ reason: "Not what we asked for" })).status).toBe(200);
    expect((await getOnHandByItemId([s.item.id])).get(s.item.id)).toBe(80);

    // Taken back by the sender while unconfirmed; a confirmed one can't be
    const t3 = await sendToRnd(5);
    expect((await getOnHandByItemId([s.item.id])).get(s.item.id)).toBe(75);
    expect((await request(app).delete(`/api/rnd-store/transfers/${t3.id}`).set(authHeader(s.admin.token))).status).toBe(204);
    expect((await getOnHandByItemId([s.item.id])).get(s.item.id)).toBe(80);
    expect((await request(app).delete(`/api/rnd-store/transfers/${t1.id}`).set(authHeader(s.admin.token))).status).toBe(409);
  });
});

describe("The Material Reconciliation no longer raises false alarms", () => {
  it("returns from R&D / a Store, expired stock and material in transit all reconcile to a variance of 0", async () => {
    const s = await setup(100);
    await issueToStore(s, 50);
    // A Day Store returns 10 to the Warehouse (confirmed), and sends 5 more that is still on its way
    const sent = await request(app).post("/api/stock-transfers").set(authHeader(s.storeAUser.token)).send({ itemId: s.item.id, quantity: 10, unit: "Kg", sourceType: "DAY_STORE", sourceDayStoreId: s.storeA.id, destinationType: "WAREHOUSE" });
    await request(app).post(`/api/stock-transfers/${sent.body.id}/confirm`).set(authHeader(s.warehouse.token));
    await request(app).post("/api/stock-transfers").set(authHeader(s.storeAUser.token)).send({ itemId: s.item.id, quantity: 5, unit: "Kg", sourceType: "DAY_STORE", sourceDayStoreId: s.storeA.id, destinationType: "WAREHOUSE" });
    // 20 goes to R&D, 4 is used up there, 6 comes back
    const toRnd = (await request(app).post("/api/rnd-store/transfers").set(authHeader(s.admin.token)).send({ direction: "TO_RND", itemId: s.item.id, quantity: 20, unit: "Kg" })).body;
    await request(app).post(`/api/rnd-store/transfers/${toRnd.id}/confirm`).set(authHeader(s.rnd.token));
    await request(app).post("/api/rnd-store/consume").set(authHeader(s.rnd.token)).send({ itemId: s.item.id, quantity: 4, unit: "Kg", reason: "TESTING" });
    const back = (await request(app).post("/api/rnd-store/transfers").set(authHeader(s.rnd.token)).send({ direction: "TO_WAREHOUSE", itemId: s.item.id, quantity: 6, unit: "Kg" })).body;
    await request(app).post(`/api/rnd-store/transfers/${back.id}/confirm`).set(authHeader(s.warehouse.token));
    // Some of what is left in the Warehouse expires
    await prisma.inventoryTransaction.update({ where: { id: s.receipt!.id }, data: { expiryDate: inDays(-1) } });

    const res = await request(app).get("/api/inventory/reconciliation").set(authHeader(s.warehouse.token));
    expect(res.status).toBe(200);
    const row = res.body.find((r: { item: { id: string } }) => r.item.id === s.item.id);
    expect(row).toMatchObject({ receivedQty: 100, onHandRnd: 10, inTransit: 5, rndTesting: 4 });
    expect(row.variance).toBe(0);
  });
});

describe("Rejected stock: returned to the vendor or destroyed, never silently stuck in Quarantine", () => {
  it("records returns and destructions against the rejected quantity, and refuses more than is left", async () => {
    const s = await setup(0);
    const rejected = await prisma.inventoryTransaction.create({
      data: { ...s.base, type: "RECEIVED", quantity: 20, vendorName: "Bad Vendor", grnNo: "BAD-1", receiptStatus: "QC_REJECTED", qcNote: "Moisture too high", qcCheckedAt: new Date() },
    });
    const list = async (token = s.warehouse.token) => (await request(app).get("/api/inventory/rejected-stock").set(authHeader(token))).body as { id: string; remainingQty: number; rejectedQty: number }[];
    expect((await list()).find((r) => r.id === rejected.id)).toMatchObject({ rejectedQty: 20, remainingQty: 20 });

    const dispose = (body: Record<string, unknown>) => request(app).post(`/api/inventory/rejected-stock/${rejected.id}/dispositions`).set(authHeader(s.warehouse.token)).send(body);
    expect((await dispose({ kind: "RETURNED_TO_VENDOR", quantity: 15 })).status).toBe(400); // a return needs its challan number
    expect((await dispose({ kind: "RETURNED_TO_VENDOR", quantity: 15, challanNo: "RET-9" })).status).toBe(201);
    expect((await dispose({ kind: "DESTROYED", quantity: 6 })).status).toBe(409); // only 5 left
    expect((await dispose({ kind: "DESTROYED", quantity: 5 })).status).toBe(201);
    expect((await list()).find((r) => r.id === rejected.id)).toBeUndefined(); // fully dealt with
    expect(((await request(app).get("/api/inventory/rejected-stock?all=1").set(authHeader(s.warehouse.token))).body as { id: string; remainingQty: number }[]).find((r) => r.id === rejected.id)?.remainingQty).toBe(0);
  });

  it("the rejected part of an approved delivery is tracked too", async () => {
    const s = await setup(0);
    const partial = await prisma.inventoryTransaction.create({ data: { ...s.base, type: "RECEIVED", quantity: 50, rejectedQty: 4, vendorName: "V", receiptStatus: "ACCEPTED" } });
    const rows = (await request(app).get("/api/inventory/rejected-stock").set(authHeader(s.warehouse.token))).body as { id: string; rejectedQty: number }[];
    expect(rows.find((r) => r.id === partial.id)?.rejectedQty).toBe(4);
  });
});

describe("Lots: stock is issued oldest-expiry first, never from an expired lot, and every issue remembers its lots", () => {
  it("draws the earliest-expiry lot first, skips an expired lot, and can be traced both ways", async () => {
    const s = await setup(0);
    const lot = (qty: number, grn: string, expiryDate: Date) =>
      prisma.inventoryTransaction.create({ data: { ...s.base, type: "RECEIVED", quantity: qty, vendorName: "LotVendor", grnNo: grn, batchNo: `${grn}-B`, receiptStatus: "ACCEPTED", acceptedById: s.warehouse.user.id, acceptedAt: new Date(), expiryDate } });
    const expired = await lot(30, "L-EXPIRED", inDays(-3));
    const soon = await lot(40, "L-SOON", inDays(20));
    const late = await lot(100, "L-LATE", inDays(200));

    expect((await getOnHandByItemId([s.item.id])).get(s.item.id)).toBe(140); // the expired 30 is not usable

    const issue = await request(app).post("/api/inventory/transactions").set(authHeader(s.warehouse.token)).send({ itemId: s.item.id, type: "ISSUED_DAY_STORE", date: new Date().toISOString(), unit: "Kg", quantity: 60, dayStoreId: s.storeA.id });
    expect(issue.status).toBe(201);
    const drawn = await prisma.lotAllocation.findMany({ where: { issueTxnId: issue.body.id }, orderBy: { quantity: "desc" } });
    expect(drawn.map((d) => [d.receiptId, d.quantity])).toEqual([
      [late.id, 20],
      [soon.id, 40],
    ].sort((a, b) => (b[1] as number) - (a[1] as number)));
    expect(drawn.some((d) => d.receiptId === expired.id)).toBe(false);

    // The item's lots: the earliest-expiry lot is used up, the later one has 80 left, the expired one is flagged
    const lots = await request(app).get(`/api/inventory/lots/item/${s.item.id}`).set(authHeader(s.warehouse.token));
    expect(lots.status).toBe(200);
    const byGrn = Object.fromEntries(lots.body.warehouse.map((l: { grnNo: string; remaining: number; status: string }) => [l.grnNo, l]));
    expect(byGrn["L-SOON"].remaining).toBe(0);
    expect(byGrn["L-LATE"].remaining).toBe(80);
    expect(byGrn["L-EXPIRED"].status).toBe("EXPIRED");
    // ... and the Day Store holds 40 of L-SOON and 20 of L-LATE
    const place = lots.body.places.find((p: { kind: string }) => p.kind === "DAY_STORE");
    expect(place.lots.map((l: { grnNo: string; remaining: number }) => [l.grnNo, l.remaining]).sort()).toEqual([["L-LATE", 20], ["L-SOON", 40]]);

    // Forward trace: where did L-SOON go?
    const trace = await request(app).get(`/api/inventory/lots/trace/lot/${soon.id}`).set(authHeader(s.warehouse.token));
    expect(trace.body.movements).toHaveLength(1);
    expect(trace.body.movements[0]).toMatchObject({ kind: "ISSUED_DAY_STORE", quantity: 40 });
    expect(trace.body.movements[0].to).toContain(s.storeA.name);

    // Search finds it by GRN
    const found = await request(app).get("/api/inventory/lots/search?q=L-SOON").set(authHeader(s.warehouse.token));
    expect(found.body.map((l: { receiptId: string }) => l.receiptId)).toContain(soon.id);

    // Expiring list: the expired lot (30 left in Quarantine) and the 20-day lot are reported at the Warehouse
    const expiring = await request(app).get("/api/inventory/lots/expiring?days=60").set(authHeader(s.warehouse.token));
    const keys = expiring.body.map((l: { grnNo: string; place: string }) => `${l.grnNo}@${l.place}`);
    expect(keys).toContain("L-EXPIRED@Warehouse");
    expect(keys).toContain(`L-SOON@Store: ${s.storeA.name}`);
  });

  it("deleting an issue gives its lots back", async () => {
    const s = await setup(0);
    const lot = await prisma.inventoryTransaction.create({ data: { ...s.base, type: "RECEIVED", quantity: 50, grnNo: "L-DEL", receiptStatus: "ACCEPTED", expiryDate: inDays(90) } });
    const issue = await request(app).post("/api/inventory/transactions").set(authHeader(s.warehouse.token)).send({ itemId: s.item.id, type: "ISSUED_DAY_STORE", date: new Date().toISOString(), unit: "Kg", quantity: 20, dayStoreId: s.storeA.id });
    const remaining = async () => (await request(app).get(`/api/inventory/lots/item/${s.item.id}`).set(authHeader(s.warehouse.token))).body.warehouse.find((l: { receiptId: string }) => l.receiptId === lot.id).remaining;
    expect(await remaining()).toBe(30);
    expect((await request(app).delete(`/api/inventory/transactions/${issue.body.id}`).set(authHeader(s.warehouse.token))).status).toBe(204);
    expect(await remaining()).toBe(50);
  });
});

describe("Units, over-receipt and delete guards", () => {
  it("refuses a movement in another unit than the item is kept in, and accepts a spelling of the same unit", async () => {
    const s = await setup(100);
    const post = (unit: string) => request(app).post("/api/inventory/transactions").set(authHeader(s.warehouse.token)).send({ itemId: s.item.id, type: "ISSUED_DAY_STORE", date: new Date().toISOString(), unit, quantity: 1, dayStoreId: s.storeA.id });
    const bad = await post("gm");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("kept in Kg");
    expect((await post("kgs")).status).toBe(201);
  });

  it("does not let a delivery run past the ordered quantity (beyond the delivery tolerance) on a Vendor PO", async () => {
    const s = await setup(0);
    const purchase = await createUser(["PURCHASE"]);
    const vendor = await prisma.vendor.create({ data: { name: `OR Vendor ${Date.now()}`, createdById: purchase.user.id } });
    const vpo = await request(app)
      .post("/api/vendor-purchase-orders")
      .set(authHeader(purchase.token))
      .send({ vendorId: vendor.id, poNumber: `OR-${Date.now()}`, orderDate: new Date().toISOString(), items: [{ itemId: s.item.id, quantity: 10, unit: "Kg", rate: 100, gstPct: 5 }] });
    expect(vpo.status).toBe(201);
    const lineId = vpo.body.items[0].id as string;
    const receive = (quantity: number) => request(app).post(`/api/vendor-purchase-orders/${vpo.body.id}/items/${lineId}/receive`).set(authHeader(s.warehouse.token)).send({ quantity, expiryDate: inDays(100).toISOString() });
    expect((await receive(10)).status).toBe(201);
    expect((await receive(0.4)).status).toBe(201); // within the 5% tolerance (10.5)
    const over = await receive(1);
    expect(over.status).toBe(409);
    expect(over.body.error).toContain("delivery tolerance");
  });

  it("an entry that is one half of a confirmed return can't be deleted on its own, and nor can an R&D issue", async () => {
    const s = await setup(100);
    await issueToStore(s, 50);
    const sent = await request(app).post("/api/stock-transfers").set(authHeader(s.storeAUser.token)).send({ itemId: s.item.id, quantity: 10, unit: "Kg", sourceType: "DAY_STORE", sourceDayStoreId: s.storeA.id, destinationType: "WAREHOUSE" });
    await request(app).post(`/api/stock-transfers/${sent.body.id}/confirm`).set(authHeader(s.warehouse.token));
    const receipt = await prisma.inventoryTransaction.findFirstOrThrow({ where: { stockTransferId: sent.body.id } });
    expect((await request(app).delete(`/api/inventory/transactions/${receipt.id}`).set(authHeader(s.warehouse.token))).status).toBe(409);

    await request(app).post("/api/rnd-store/transfers").set(authHeader(s.admin.token)).send({ direction: "TO_RND", itemId: s.item.id, quantity: 5, unit: "Kg" });
    const rndIssue = await prisma.inventoryTransaction.findFirstOrThrow({ where: { itemId: s.item.id, type: "ISSUED_RND" } });
    expect((await request(app).delete(`/api/inventory/transactions/${rndIssue.id}`).set(authHeader(s.warehouse.token))).status).toBe(409);
  });

  it("deleting the issue that filled a Material Request puts the request back to what is really issued", async () => {
    const s = await setup(100);
    const ppic = await createUser(["PPIC"]);
    const req = await request(app).post("/api/inventory/requests").set(authHeader(ppic.token)).send({ itemId: s.item.id, category: "RM", requestedQty: 20, purpose: "ISSUED_DAY_STORE" });
    expect(req.status).toBe(201);
    await request(app).patch(`/api/inventory/requests/${req.body.id}/review`).set(authHeader(s.warehouse.token)).send({ action: "APPROVE" });
    const issued = await request(app).post(`/api/inventory/requests/${req.body.id}/issue`).set(authHeader(s.warehouse.token)).send({ quantity: 20, unit: "Kg", date: new Date().toISOString(), dayStoreId: s.storeA.id });
    expect(issued.status).toBe(201);
    expect((await prisma.inventoryRequest.findUniqueOrThrow({ where: { id: req.body.id } })).status).toBe("ISSUED");
    expect((await request(app).delete(`/api/inventory/transactions/${issued.body.id}`).set(authHeader(s.warehouse.token))).status).toBe(204);
    expect((await prisma.inventoryRequest.findUniqueOrThrow({ where: { id: req.body.id } })).status).toBe("APPROVED");
  });

  it("the Recycle Bin won't restore an issue the stock no longer covers", async () => {
    const s = await setup(100);
    const first = await prisma.inventoryTransaction.create({ data: { ...s.base, type: "ISSUED_DAY_STORE", quantity: 80, dayStoreId: s.storeA.id, deliveredAt: new Date() } });
    await prisma.inventoryTransaction.update({ where: { id: first.id }, data: { deletedAt: new Date() } }); // deleted: the stock is free again
    await issueToStore(s, 60); // ... and 60 of it is issued again
    const restore = await request(app).post(`/api/recycle-bin/inventory-transaction/${first.id}/restore`).set(authHeader(s.admin.token));
    expect(restore.status).toBe(409); // restoring 80 would leave the Warehouse at -40
  });
});

describe("A batch's quantities have to add up between stages, and the QA gate's waste and rejects reach the Recycle Store", () => {
  it("won't approve more than the batch made; works the approved quantity out; logs wastage and rejects", async () => {
    const bd = await createUser(["BD"]);
    const qa = await createUser(["QA_QC"]);
    const owner = await createUser(["PRODUCTION"]);
    const store = await createUser(["STORE"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bd.token)).send({ companyName: `MB Customer ${Date.now()}` });
    const po = await request(app).post("/api/purchase-orders").set(authHeader(bd.token)).send({ customerId: customer.body.id, poNumber: `MB-${Date.now()}`, items: [{ productName: "MB Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
    const itemId = po.body.items[0].id as string;
    const plant = await prisma.plant.create({ data: { name: `MB Plant ${Date.now()}`, createdById: store.user.id } });
    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemId, plannedQty: 100, plantId: plant.id, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
    const batch = await prisma.productionBatch.create({
      data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: owner.user.id } }, batchNo: `MB-${Date.now()}`, plannedQty: 100, outputQty: 100, status: "COMPLETED", completedAt: new Date(), currentStageId: "QA_GATE_MFG" },
    });
    const stage = (body: Record<string, unknown>) => request(app).patch(`/api/production-batches/${batch.id}/stage`).set(authHeader(qa.token)).send(body);

    // 98 approved + 5 rejected is more than the 100 the batch made
    const over = await stage({ action: "FORWARD", mfgQaStatus: "Approved", mfgQcStatus: "Approved", mfgApprovedQty: 98, mfgRejectedQty: 5 });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain("more than the batch produced");
    expect((await prisma.productionBatch.findUniqueOrThrow({ where: { id: batch.id } })).currentStageId).toBe("QA_GATE_MFG");

    // Left blank, the approved quantity is what remains: 100 - 5 rejected - 3 wasted
    const ok = await stage({ action: "FORWARD", mfgQaStatus: "Approved", mfgQcStatus: "Approved", mfgRejectedQty: 5, mfgWastageQty: 3 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ currentStageId: "BULK_QC", mfgApprovedQty: 92 });

    // The 3 wasted and the 5 rejected are on the Recycle Store's books, under this batch
    const logs = await prisma.batchRecycleLog.findMany({ where: { productionBatchId: batch.id }, orderBy: { kind: "asc" } });
    expect(logs.map((l) => [l.kind, l.quantity, l.stageId])).toEqual([
      ["REJECTED", 5, "QA_GATE_MFG"],
      ["WASTAGE", 3, "QA_GATE_MFG"],
    ]);
    const byBatch = await request(app).get("/api/recycle-store/by-batch").set(authHeader(store.token));
    expect(byBatch.status).toBe(200);
    expect(byBatch.body.filter((r: { productionBatchId: string }) => r.productionBatchId === batch.id).map((r: { outputKind: string; totalQty: number }) => [r.outputKind, r.totalQty]).sort()).toEqual([
      ["REJECTED", 5],
      ["WASTAGE", 3],
    ]);
  });
});
