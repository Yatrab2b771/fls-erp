import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";
import { getInTransitByItemId, getOnHandByDayStoreAndItem, getOnHandByPlantAndItem } from "../../src/modules/inventory/stock";

const app = createApp();
const DAY = 86_400_000;

/**
 * A batch ready to be dispensed (indent signed, batch number given) whose material reached the Day Store the proper way - through
 * a Warehouse issue, so the lots (GRN, expiry) it came from are on record.
 */
async function setup() {
  const production = await createUser(["PRODUCTION"]);
  const rnd = await createUser(["RND"]);
  const dayStoreLogin = await createUser(["STORE"]);
  const warehouse = await createUser(["STORE"]);
  const bd = await createUser(["BD"]);
  const stamp = Date.now();
  const dayStore = await prisma.dayStore.create({ data: { name: `DW Store ${stamp}`, createdById: production.user.id } });
  const plant = await prisma.plant.create({ data: { name: `DW Plant ${stamp}`, createdById: production.user.id, dayStoreId: dayStore.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: dayStoreLogin.user.id, dayStoreId: dayStore.id } });

  const whey = await prisma.inventoryItem.create({ data: { category: "RM", name: `DW Whey ${stamp}`, unit: "Kg" } });
  const tub = await prisma.inventoryItem.create({ data: { category: "PM", name: `DW Tub ${stamp}`, unit: "Count" } });

  // Two lots of whey (the earlier-expiring one first) and one of tubs, all issued to the Day Store through the API
  const lot = (item: { id: string }, unit: string, quantity: number, grn: string, days: number) =>
    prisma.inventoryTransaction.create({
      data: { itemId: item.id, createdById: warehouse.user.id, date: new Date(), unit, type: "RECEIVED", quantity, vendorName: "DW Vendor", grnNo: grn, batchNo: `${grn}-B`, receiptStatus: "ACCEPTED", acceptedById: warehouse.user.id, acceptedAt: new Date(), expiryDate: new Date(Date.now() + days * DAY) },
    });
  const wheyEarly = await lot(whey, "Kg", 25, `DW-WHEY-A-${stamp}`, 60);
  const wheyLate = await lot(whey, "Kg", 100, `DW-WHEY-B-${stamp}`, 300);
  const tubLot = await lot(tub, "Count", 200, `DW-TUB-${stamp}`, 500);
  const toStore = (item: { id: string }, unit: string, quantity: number) =>
    request(app).post("/api/inventory/transactions").set(authHeader(warehouse.token)).send({ itemId: item.id, type: "ISSUED_DAY_STORE", date: new Date().toISOString(), unit, quantity, dayStoreId: dayStore.id });
  expect((await toStore(whey, "Kg", 60)).status).toBe(201);
  expect((await toStore(tub, "Count", 100)).status).toBe(201);

  const customer = await request(app).post("/api/customers").set(authHeader(bd.token)).send({ companyName: `DW Customer ${stamp}` });
  const po = await request(app).post("/api/purchase-orders").set(authHeader(bd.token)).send({ customerId: customer.body.id, poNumber: `DW-PO-${stamp}`, items: [{ productName: "DW Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
  const itemId = po.body.items[0].id as string;
  await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved", planSentToProductionAt: new Date() } });
  await prisma.rmPlan.create({ data: { name: "DW rm", status: "CALCULATED", calculatedAt: new Date(), costingParams: {}, createdById: production.user.id, purchaseOrderItemId: itemId, resultSnapshot: { procurement: [{ name: whey.name, totalKg: 100 }] } } });
  await prisma.bomPlan.create({ data: { name: "DW bom", status: "CALCULATED", calculatedAt: new Date(), createdById: production.user.id, purchaseOrderItemId: itemId, resultSnapshot: { lines: [{ component: "Tub", itemName: tub.name, totalQty: 100 }] } } });

  const call = (token: string, method: "get" | "post" | "patch", path: string, body?: object) => {
    const r = request(app)[method](path).set(authHeader(token));
    return body ? r.send(body) : r;
  };
  const run = await call(production.token, "post", "/api/pre-productions", { purchaseOrderItemId: itemId, batchFlow: true, confirmNotReady: true });
  expect(run.status).toBe(201);
  const batch = (await call(production.token, "post", `/api/pre-productions/${run.body.id}/production-batches`, { plannedQty: 40 })).body;
  await call(production.token, "post", `/api/production-batches/${batch.id}/indent`, { prodIndentSlipSign: "DW Head", productionPlanDate: "2026-10-14" });
  await call(rnd.token, "post", `/api/production-batches/${batch.id}/batch-no/allocate`, {});
  return { call, production, rnd, dayStoreLogin, warehouse, whey, tub, wheyEarly, wheyLate, tubLot, dayStore, plant, batch, run: run.body };
}

const dispense = { rmDispensingDate: "2026-10-14", pmIssuedDate: "2026-10-14" };

/** Production confirms everything the Day Store sent for the batch. */
const receiveAll = async (s: Awaited<ReturnType<typeof setup>>) => {
  const lines = await prisma.batchDispensingLine.findMany({ where: { productionBatchId: s.batch.id, deliveryStatus: "PENDING" } });
  return s.call(s.production.token, "post", `/api/production-batches/${s.batch.id}/receive`, { lines: lines.map((l) => ({ lineId: l.id, action: "RECEIVE" })) });
};

describe("Dispensing records what was weighed, and the lots it came from", () => {
  it("takes the plan quantity when nothing different is entered, and remembers the lots (oldest expiry first)", async () => {
    const s = await setup();
    const res = await s.call(s.dayStoreLogin.token, "post", `/api/production-batches/${s.batch.id}/dispense`, dispense);
    expect(res.status).toBe(200);
    expect(res.body.prepStageId).toBe("RECEIVE"); // the material is on its way to the Plant
    expect((await receiveAll(s)).status).toBe(200);
    const lines = await prisma.batchDispensingLine.findMany({ where: { productionBatchId: s.batch.id } });
    const whey = lines.find((l) => l.itemId === s.whey.id)!;
    expect(whey).toMatchObject({ quantity: 40, plannedQty: 40 });

    // The 40 Kg of whey came out of the earlier-expiring lot (25) first, then 15 from the later one
    const trace = await s.call(s.warehouse.token, "get", `/api/inventory/lots/trace/batch/${s.batch.id}`);
    expect(trace.status).toBe(200);
    const m = trace.body.materials.find((x: { itemId: string }) => x.itemId === s.whey.id);
    expect(m.dispensedQty).toBe(40);
    expect(m.lotUnknownQty).toBe(0);
    expect(m.lots.map((l: { grnNo: string; usedQty: number }) => [l.grnNo, l.usedQty])).toEqual([
      [s.wheyEarly.grnNo, 25],
      [s.wheyLate.grnNo, 15],
    ]);
    expect(m.lots[0]).toMatchObject({ vendorName: "DW Vendor", batchNo: `${s.wheyEarly.grnNo}-B` });
  });

  it("records the weighed quantity; a weighing far from the plan needs a reason", async () => {
    const s = await setup();
    const url = `/api/production-batches/${s.batch.id}/dispense`;
    // 41 Kg against a plan of 40: within tolerance. 30 tubs against 40: far off, no reason given.
    const noReason = await s.call(s.dayStoreLogin.token, "post", url, { ...dispense, lines: [{ itemId: s.whey.id, actualQty: 41, grossWeight: 42.5, tareWeight: 1.5, arNo: "AR-77" }, { itemId: s.tub.id, actualQty: 30 }] });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toContain("write why");
    expect(await prisma.batchDispensingLine.count({ where: { productionBatchId: s.batch.id } })).toBe(0); // nothing was booked

    const ok = await s.call(s.dayStoreLogin.token, "post", url, { ...dispense, lines: [{ itemId: s.whey.id, actualQty: 41, grossWeight: 42.5, tareWeight: 1.5, arNo: "AR-77" }, { itemId: s.tub.id, actualQty: 30, note: "Pack of 10 was damaged" }] });
    expect(ok.status).toBe(200);
    const lines = await prisma.batchDispensingLine.findMany({ where: { productionBatchId: s.batch.id } });
    expect(lines.find((l) => l.itemId === s.whey.id)).toMatchObject({ quantity: 41, plannedQty: 40, grossWeight: 42.5, tareWeight: 1.5, arNo: "AR-77" });
    expect(lines.find((l) => l.itemId === s.tub.id)).toMatchObject({ quantity: 30, plannedQty: 40, note: "Pack of 10 was damaged" });
    // The Plant holds what was weighed (41 Kg), not the plan: the Day Store lost 41
    const sent = await prisma.inventoryTransaction.findFirstOrThrow({ where: { itemId: s.whey.id, type: "ISSUED_PRODUCTION", plantId: s.plant.id } });
    expect(sent.quantity).toBe(41);
  });

  it("refuses a weighed line for a material that is not in the batch's plan", async () => {
    const s = await setup();
    const stranger = await prisma.inventoryItem.create({ data: { category: "RM", name: `DW Stranger ${Date.now()}`, unit: "Kg" } });
    const res = await s.call(s.dayStoreLogin.token, "post", `/api/production-batches/${s.batch.id}/dispense`, { ...dispense, lines: [{ itemId: stranger.id, actualQty: 5 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not in this batch's plan");
  });

  it("raw material wasted or rejected at the Plant goes on the Recycle Store's books", async () => {
    const s = await setup();
    expect((await s.call(s.dayStoreLogin.token, "post", `/api/production-batches/${s.batch.id}/dispense`, dispense)).status).toBe(200);
    expect((await receiveAll(s)).status).toBe(200);
    const entry = await s.call(s.production.token, "post", `/api/plant-consumption/${s.run.id}/entries`, { itemId: s.whey.id, wastedQty: 2, rejectedQty: 1, unit: "Kg", note: "Spilled while opening the bag" });
    expect(entry.status).toBe(201);
    const rows = await prisma.inventoryTransaction.findMany({ where: { itemId: s.whey.id, type: "ISSUED_RECYCLE" }, orderBy: { quantity: "desc" } });
    expect(rows.map((r) => r.quantity)).toEqual([2, 1]);
    expect(rows[0]!.plantId).toBe(s.plant.id);
    const feed = await s.call(s.production.token, "get", "/api/recycle-store/transactions");
    expect(feed.body.filter((r: { kind: string; itemName: string }) => r.kind === "material" && r.itemName === s.whey.name)).toHaveLength(2);
  });

  it("Production's Material Received list is batch by batch: nothing before Dispensing, then what was weighed, and what the batch used", async () => {
    const s = await setup();
    const board = async () => (await s.call(s.production.token, "get", "/api/production-batches/material-board")).body as { batchId: string; batchNo: string; batchQty: number; material: string; requiredQty: number; receivedQty: number; inTransitQty: number; usedQty: number; wastedQty: number; status: string }[];

    const before = (await board()).filter((r) => r.batchId === s.batch.id);
    expect(before).toHaveLength(2); // whey and tubs
    expect(before.every((r) => r.status === "NOT_DISPENSED" && r.receivedQty === 0)).toBe(true);
    expect(before[0]).toMatchObject({ batchQty: 40 });

    await s.call(s.dayStoreLogin.token, "post", `/api/production-batches/${s.batch.id}/dispense`, { ...dispense, lines: [{ itemId: s.whey.id, actualQty: 41 }] });
    // Sent, not yet confirmed by Production: on its way, nothing in the Plant yet
    const onTheWay = (await board()).filter((r) => r.batchId === s.batch.id);
    expect(onTheWay.map((r) => r.status)).toEqual(["IN_TRANSIT", "IN_TRANSIT"]);
    expect(onTheWay.find((r) => r.material === s.whey.name)).toMatchObject({ receivedQty: 0, inTransitQty: 41 });
    expect((await receiveAll(s)).status).toBe(200);
    await s.call(s.production.token, "post", `/api/plant-consumption/${s.run.id}/entries`, { itemId: s.whey.id, productionBatchId: s.batch.id, consumedQty: 30, wastedQty: 2, unit: "Kg" });

    const after = (await board()).filter((r) => r.batchId === s.batch.id);
    const whey = after.find((r) => r.material === s.whey.name)!;
    expect(whey).toMatchObject({ requiredQty: 40, receivedQty: 41, usedQty: 32, wastedQty: 2, status: "FULL" });
    expect(after.find((r) => r.material === s.tub.name)).toMatchObject({ receivedQty: 40, status: "FULL" });

    // A run from before the per-batch flow has no batches: it stays on the old product-wise board, and a batch-flow product is left off it
    const legacy = await s.call(s.production.token, "get", "/api/pre-productions/material-board?legacyOnly=1");
    expect(legacy.status).toBe(200);
    expect(legacy.body.some((r: { itemId: string }) => r.itemId === s.batch.preProduction?.purchaseOrderItemId)).toBe(false);
  });
});

describe("Production receives what the Day Store dispensed, material by material", () => {
  const receive = (s: Awaited<ReturnType<typeof setup>>, token: string, lines: object[]) => s.call(token, "post", `/api/production-batches/${s.batch.id}/receive`, { lines });
  const pendingOf = (s: Awaited<ReturnType<typeof setup>>) => prisma.batchDispensingLine.findMany({ where: { productionBatchId: s.batch.id, deliveryStatus: "PENDING" } });
  const plantOnHand = async (s: Awaited<ReturnType<typeof setup>>, itemId: string) => (await getOnHandByPlantAndItem(s.plant.id, [itemId])).get(itemId) ?? 0;
  const storeOnHand = async (s: Awaited<ReturnType<typeof setup>>, itemId: string) => (await getOnHandByDayStoreAndItem(s.dayStore.id, [itemId])).get(itemId)?.onHand ?? 0;

  it("keeps the material on its way (out of the Day Store, not yet in the Plant) and tells Production", async () => {
    const s = await setup();
    const res = await s.call(s.dayStoreLogin.token, "post", `/api/production-batches/${s.batch.id}/dispense`, dispense);
    expect(res.body.prepStageId).toBe("RECEIVE");
    expect(await storeOnHand(s, s.whey.id)).toBe(20); // 60 - 40 sent
    expect(await plantOnHand(s, s.whey.id)).toBe(0); // not received yet
    expect((await getInTransitByItemId([s.whey.id])).get(s.whey.id)).toBe(40);
    expect(await prisma.notification.count({ where: { title: { contains: "material is on its way" } } })).toBeGreaterThan(0);

    // The Receive board lists it, with the lines to confirm
    const board = (await s.call(s.production.token, "get", "/api/production-batches/prep-board?stage=RECEIVE")).body as { id: string; receiveLines: { itemName: string; sentQty: number }[] }[];
    const row = board.find((r) => r.id === s.batch.id)!;
    expect(row.receiveLines.map((l) => l.sentQty).sort()).toEqual([40, 40]);
  });

  it("a full receipt puts the material into the Plant and makes the batch READY; only Production receives", async () => {
    const s = await setup();
    await s.call(s.dayStoreLogin.token, "post", `/api/production-batches/${s.batch.id}/dispense`, dispense);
    const lines = (await pendingOf(s)).map((l) => ({ lineId: l.id, action: "RECEIVE" }));
    expect((await receive(s, s.dayStoreLogin.token, lines)).status).toBe(403);
    expect((await receive(s, s.rnd.token, lines)).status).toBe(403);
    const done = await receive(s, s.production.token, lines);
    expect(done.status).toBe(200);
    expect(done.body.prepStageId).toBe("READY");
    expect(await plantOnHand(s, s.whey.id)).toBe(40);
    expect((await getInTransitByItemId([s.whey.id])).get(s.whey.id)).toBeUndefined();
    expect((await receive(s, s.production.token, lines)).status).toBe(409); // nothing left to receive
  });

  it("a short receipt needs a reason, books what arrived, and keeps the difference as a recorded loss", async () => {
    const s = await setup();
    await s.call(s.dayStoreLogin.token, "post", `/api/production-batches/${s.batch.id}/dispense`, dispense);
    const whey = s.whey.id;
    const tub = s.tub.id;
    const lines = await pendingOf(s);
    const wheyLine = lines.find((l) => l.itemId === whey)!;
    const tubLine = lines.find((l) => l.itemId === tub)!;
    const more = await receive(s, s.production.token, [{ lineId: wheyLine.id, action: "RECEIVE", receivedQty: 45 }]);
    expect(more.status).toBe(400); // more than was sent
    const noReason = await receive(s, s.production.token, [{ lineId: wheyLine.id, action: "RECEIVE", receivedQty: 38 }]);
    expect(noReason.status).toBe(400);
    expect((await pendingOf(s)).length).toBe(2); // nothing was booked

    // Whey arrives short (38 of 40); the tubs have not been looked at yet: the batch waits at Receive
    const partial = await receive(s, s.production.token, [{ lineId: wheyLine.id, action: "RECEIVE", receivedQty: 38, note: "Bag torn on the way" }]);
    expect(partial.status).toBe(200);
    expect(partial.body.prepStageId).toBe("RECEIVE");
    expect(await plantOnHand(s, whey)).toBe(38);
    const issue = await prisma.inventoryTransaction.findFirstOrThrow({ where: { itemId: whey, type: "ISSUED_PRODUCTION" } });
    expect(issue).toMatchObject({ shortQty: 2, shortNote: "Bag torn on the way" });
    expect((await prisma.batchDispensingLine.findUniqueOrThrow({ where: { id: wheyLine.id } })).quantity).toBe(38); // what the batch really holds

    const rest = await receive(s, s.production.token, [{ lineId: tubLine.id, action: "RECEIVE" }]);
    expect(rest.body.prepStageId).toBe("READY");
  });

  it("a refused material goes back to the Day Store; the batch returns to Dispensing for that material only, then goes on", async () => {
    const s = await setup();
    await s.call(s.dayStoreLogin.token, "post", `/api/production-batches/${s.batch.id}/dispense`, dispense);
    const whey = s.whey.id;
    const tub = s.tub.id;
    const lines = await pendingOf(s);
    const wheyLine = lines.find((l) => l.itemId === whey)!;
    const tubLine = lines.find((l) => l.itemId === tub)!;

    expect((await receive(s, s.production.token, [{ lineId: wheyLine.id, action: "REFUSE" }])).status).toBe(400); // a reason is needed
    const out = await receive(s, s.production.token, [
      { lineId: wheyLine.id, action: "REFUSE", note: "Wrong grade of whey" },
      { lineId: tubLine.id, action: "RECEIVE" },
    ]);
    expect(out.status).toBe(200);
    expect(out.body.prepStageId).toBe("DISPENSING");
    expect(await storeOnHand(s, whey)).toBe(60); // the whey is back with the Day Store
    expect(await plantOnHand(s, tub)).toBe(40);

    // The Day Store sees why, and dispenses only what is missing (the tubs are already there)
    const board = (await s.call(s.dayStoreLogin.token, "get", "/api/production-batches/prep-board?stage=DISPENSING")).body as { id: string; requirements: { itemId: string; dispensed: boolean; refusedNote: string | null }[] }[];
    const reqs = board.find((r) => r.id === s.batch.id)!.requirements;
    expect(reqs.find((r) => r.itemId === whey)).toMatchObject({ dispensed: false, refusedNote: "Wrong grade of whey" });
    expect(reqs.find((r) => r.itemId === tub)).toMatchObject({ dispensed: true });

    const again = await s.call(s.dayStoreLogin.token, "post", `/api/production-batches/${s.batch.id}/dispense`, dispense);
    expect(again.status).toBe(200);
    expect(again.body.prepStageId).toBe("RECEIVE");
    expect(await prisma.inventoryTransaction.count({ where: { itemId: tub, type: "ISSUED_PRODUCTION", deletedAt: null } })).toBe(1); // the tubs were not sent twice
    const second = await pendingOf(s);
    expect(second.map((l) => l.itemId)).toEqual([whey]);
    const finished = await receive(s, s.production.token, [{ lineId: second[0]!.id, action: "RECEIVE" }]);
    expect(finished.body.prepStageId).toBe("READY");
    expect(await plantOnHand(s, whey)).toBe(40);

    // The refused line no longer counts as given
    const trace = await s.call(s.warehouse.token, "get", `/api/inventory/lots/trace/batch/${s.batch.id}`);
    expect(trace.body.materials.find((m: { itemId: string }) => m.itemId === whey).dispensedQty).toBe(40);
  });
});
