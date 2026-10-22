import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();
const DAY = 86_400_000;

/**
 * A batch ready to be dispensed (indent signed, batch number given) whose material reached the Day Store the proper way - through
 * a Warehouse issue. The batch is 40 of the product's 100: it needs 40 Kg of whey and 40 tubs, the Day Store holds 60 Kg and 100 tubs.
 */
async function setup() {
  const production = await createUser(["PRODUCTION"]);
  const rnd = await createUser(["RND"]);
  const dayStoreLogin = await createUser(["STORE"]);
  const warehouse = await createUser(["STORE"]);
  const bd = await createUser(["BD"]);
  const stamp = Date.now();
  const dayStore = await prisma.dayStore.create({ data: { name: `DR Store ${stamp}`, createdById: production.user.id } });
  const plant = await prisma.plant.create({ data: { name: `DR Plant ${stamp}`, createdById: production.user.id, dayStoreId: dayStore.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: dayStoreLogin.user.id, dayStoreId: dayStore.id } });

  const whey = await prisma.inventoryItem.create({ data: { category: "RM", name: `DR Whey ${stamp}`, unit: "Kg" } });
  const tub = await prisma.inventoryItem.create({ data: { category: "PM", name: `DR Tub ${stamp}`, unit: "Count" } });
  const lot = (item: { id: string }, unit: string, quantity: number, grn: string) =>
    prisma.inventoryTransaction.create({
      data: { itemId: item.id, createdById: warehouse.user.id, date: new Date(), unit, type: "RECEIVED", quantity, vendorName: "DR Vendor", grnNo: grn, batchNo: `${grn}-B`, receiptStatus: "ACCEPTED", acceptedById: warehouse.user.id, acceptedAt: new Date(), expiryDate: new Date(Date.now() + 300 * DAY) },
    });
  await lot(whey, "Kg", 100, `DR-WHEY-${stamp}`);
  await lot(tub, "Count", 200, `DR-TUB-${stamp}`);
  const toStore = (item: { id: string }, unit: string, quantity: number) =>
    request(app).post("/api/inventory/transactions").set(authHeader(warehouse.token)).send({ itemId: item.id, type: "ISSUED_DAY_STORE", date: new Date().toISOString(), unit, quantity, dayStoreId: dayStore.id });
  expect((await toStore(whey, "Kg", 60)).status).toBe(201);
  expect((await toStore(tub, "Count", 100)).status).toBe(201);

  const customer = await request(app).post("/api/customers").set(authHeader(bd.token)).send({ companyName: `DR Customer ${stamp}` });
  const po = await request(app).post("/api/purchase-orders").set(authHeader(bd.token)).send({ customerId: customer.body.id, poNumber: `DR-PO-${stamp}`, items: [{ productName: "DR Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
  const itemId = po.body.items[0].id as string;
  await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved", planSentToProductionAt: new Date() } });
  await prisma.rmPlan.create({ data: { name: "DR rm", status: "CALCULATED", calculatedAt: new Date(), costingParams: {}, createdById: production.user.id, purchaseOrderItemId: itemId, resultSnapshot: { procurement: [{ name: whey.name, totalKg: 100 }] } } });
  await prisma.bomPlan.create({ data: { name: "DR bom", status: "CALCULATED", calculatedAt: new Date(), createdById: production.user.id, purchaseOrderItemId: itemId, resultSnapshot: { lines: [{ component: "Tub", itemName: tub.name, totalQty: 100 }] } } });

  const call = (token: string, method: "get" | "post" | "patch", path: string, body?: object) => {
    const r = request(app)[method](path).set(authHeader(token));
    return body ? r.send(body) : r;
  };
  const run = await call(production.token, "post", "/api/pre-productions", { purchaseOrderItemId: itemId, batchFlow: true, confirmNotReady: true });
  expect(run.status).toBe(201);
  const batch = (await call(production.token, "post", `/api/pre-productions/${run.body.id}/production-batches`, { plannedQty: 40 })).body;
  await call(production.token, "post", `/api/production-batches/${batch.id}/indent`, { prodIndentSlipSign: "DR Head", productionPlanDate: "2026-10-14" });
  const allocated = await call(rnd.token, "post", `/api/production-batches/${batch.id}/batch-no/allocate`, {});
  return { call, production, rnd, dayStoreLogin, warehouse, whey, tub, dayStore, plant, batch, batchNo: allocated.body.batchNo as string, run: run.body };
}

type S = Awaited<ReturnType<typeof setup>>;
const dispense = { rmDispensingDate: "2026-10-14", pmIssuedDate: "2026-10-14" };

const url = (s: S, path: string) => `/api/production-batches/${s.batch.id}/${path}`;
const pending = (s: S) => prisma.batchDispensingLine.findMany({ where: { productionBatchId: s.batch.id, deliveryStatus: "PENDING" } });
const receiveAll = async (s: S) => s.call(s.production.token, "post", url(s, "receive"), { lines: (await pending(s)).map((l) => ({ lineId: l.id, action: "RECEIVE" })) });
const grnPreview = (s: S) => s.call(s.dayStoreLogin.token, "get", url(s, "grn-preview"));
/** A round of dispensing: only the given materials, each for the given quantity (partial), with the GRN the Generate button showed. */
const round = async (s: S, lines: { itemId: string; actualQty: number; note?: string }[]) => {
  const grnNo = (await grnPreview(s)).body.grnNo as string;
  return s.call(s.dayStoreLogin.token, "post", url(s, "dispense"), { ...dispense, grnNo, partial: true, lines });
};
const dispensingBoard = async (s: S) =>
  (await s.call(s.dayStoreLogin.token, "get", "/api/production-batches/prep-board?stage=DISPENSING")).body as { id: string; prepStageId: string; requirements: { itemId: string; givenQty: number; remainingQty: number; dispensed: boolean }[] }[];

describe("The GRN of a dispensing is generated, not typed", () => {
  it("Generate shows FLS-<3 letters of the product>-<batch no>-<running number> and does not use the number up; dispensing does", async () => {
    const s = await setup();
    const first = (await grnPreview(s)).body.grnNo as string;
    expect(first).toMatch(new RegExp(`^FLS-DRP-${s.batchNo}-\\d{2,}$`));
    expect((await grnPreview(s)).body.grnNo).toBe(first); // pressing it again changes nothing
    expect((await s.call(s.production.token, "get", url(s, "grn-preview"))).status).toBe(403); // it is the Store's button
    const done = await s.call(s.dayStoreLogin.token, "post", url(s, "dispense"), { ...dispense, grnNo: first });
    expect(done.status).toBe(200);
    expect(done.body.grnNo).toBe(first);
    expect((await prisma.batchDispensingLine.findMany({ where: { productionBatchId: s.batch.id } })).every((l) => l.grnNo === first)).toBe(true);
  });

  it("refuses a GRN that is not the one the system would make, and makes it itself when none is sent", async () => {
    const s = await setup();
    const shown = (await grnPreview(s)).body.grnNo as string;
    const typed = await s.call(s.dayStoreLogin.token, "post", url(s, "dispense"), { ...dispense, grnNo: "BF-TYPED-1" });
    expect(typed.status).toBe(409);
    expect(typed.body.error).toMatch(/GRN has changed/);
    expect(await prisma.batchDispensingLine.count({ where: { productionBatchId: s.batch.id } })).toBe(0);
    expect((await s.call(s.dayStoreLogin.token, "post", url(s, "dispense"), { ...dispense, grnNo: shown })).status).toBe(200);

    const s2 = await setup(); // a script or an old screen sends no GRN: the system makes it, and it never repeats an earlier one
    const auto = await s2.call(s2.dayStoreLogin.token, "post", url(s2, "dispense"), dispense);
    expect(auto.status).toBe(200);
    expect(auto.body.grnNo).toMatch(/^FLS-DRP-.+-\d{2,}$/);
    expect(auto.body.grnNo).not.toBe(shown);
  });
});

describe("Partial dispensing", () => {
  it("by material: some now, the rest later - even while Production is still receiving the first round - each round with its own GRN letter", async () => {
    const s = await setup();
    const r1 = await round(s, [{ itemId: s.whey.id, actualQty: 40 }]); // the tubs wait
    expect(r1.status).toBe(200);
    expect(r1.body.prepStageId).toBe("RECEIVE");
    const base = r1.body.grnNo as string;
    expect(base).toMatch(/^FLS-DRP-.+-\d{2,}$/);

    // Production has not received yet, but the Day Store still sees the batch for the tubs and can dispense them
    const row = (await dispensingBoard(s)).find((b) => b.id === s.batch.id)!;
    expect(row).toBeTruthy();
    expect(row.requirements.find((m) => m.itemId === s.whey.id)).toMatchObject({ dispensed: true, givenQty: 40 });
    expect(row.requirements.find((m) => m.itemId === s.tub.id)).toMatchObject({ dispensed: false, givenQty: 0, remainingQty: 40 });
    const summary = (await s.call(s.dayStoreLogin.token, "get", "/api/production-batches/prep-summary")).body;
    expect(summary.DISPENSING).toBe(1);
    expect(summary.RECEIVE).toBe(1);

    const r2 = await round(s, [{ itemId: s.tub.id, actualQty: 40 }]);
    expect(r2.status).toBe(200);
    expect(r2.body.grnNo).toBe(`${base}-A`);
    expect(r2.body.prepStageId).toBe("RECEIVE");
    expect((await dispensingBoard(s)).some((b) => b.id === s.batch.id)).toBe(false); // everything is dispensed: it only waits for Production
    const done = await receiveAll(s);
    expect(done.status).toBe(200);
    expect(done.body.prepStageId).toBe("READY");
    const lines = await prisma.batchDispensingLine.findMany({ where: { productionBatchId: s.batch.id }, orderBy: { createdAt: "asc" } });
    expect(lines.map((l) => l.grnNo)).toEqual([base, `${base}-A`]);
  });

  it("by quantity: a part of one material now, the rest later; the batch is READY only once all is given and received", async () => {
    const s = await setup();
    expect((await round(s, [{ itemId: s.whey.id, actualQty: 25 }, { itemId: s.tub.id, actualQty: 40 }])).status).toBe(200);
    const mid = (await dispensingBoard(s)).find((b) => b.id === s.batch.id)!.requirements.find((m) => m.itemId === s.whey.id)!;
    expect(mid).toMatchObject({ givenQty: 25, remainingQty: 15, dispensed: false });

    // Production receives the first round: whey is still not all given, so the batch goes back to Dispensing, not READY
    const first = await receiveAll(s);
    expect(first.body.prepStageId).toBe("DISPENSING");
    expect((await round(s, [{ itemId: s.whey.id, actualQty: 15 }])).status).toBe(200);
    const second = await receiveAll(s);
    expect(second.body.prepStageId).toBe("READY");
    const wheyLines = await prisma.batchDispensingLine.findMany({ where: { productionBatchId: s.batch.id, itemId: s.whey.id } });
    expect(wheyLines.reduce((n, l) => n + l.quantity, 0)).toBe(40);
  });

  it("what is left within 5% of the plan counts as given; more than what is left needs a reason; a done material cannot be dispensed again", async () => {
    const s = await setup();
    // 39 of 40 Kg: the 1 Kg (2.5%) left is within the tolerance, so the whey is done
    expect((await round(s, [{ itemId: s.whey.id, actualQty: 39 }])).status).toBe(200);
    expect((await dispensingBoard(s)).find((b) => b.id === s.batch.id)!.requirements.find((m) => m.itemId === s.whey.id)!.dispensed).toBe(true);
    expect((await round(s, [{ itemId: s.whey.id, actualQty: 1 }])).status).toBe(409);
    // 45 of 40 tubs is more than what is left, with no reason
    const over = await round(s, [{ itemId: s.tub.id, actualQty: 45 }]);
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/write why/);
    expect((await round(s, [{ itemId: s.tub.id, actualQty: 45, note: "A full carton was opened" }])).status).toBe(200);
  });

  it("a partial round needs at least one material, and a material the store cannot cover can be left out", async () => {
    const s = await setup();
    const grnNo = (await grnPreview(s)).body.grnNo as string;
    const none = await s.call(s.dayStoreLogin.token, "post", url(s, "dispense"), { ...dispense, grnNo, partial: true, lines: [] });
    expect(none.status).toBe(400);
    // 400 tubs: far more than the store holds (100) -> refused as a whole; leave the tubs out and the whey goes
    const tooMuch = await round(s, [{ itemId: s.whey.id, actualQty: 40 }, { itemId: s.tub.id, actualQty: 400, note: "Too many for the store" }]);
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toMatch(/does not hold enough/);
    expect((await round(s, [{ itemId: s.whey.id, actualQty: 40 }])).status).toBe(200);
  });
});
