import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

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

describe("Dispensing records what was weighed, and the lots it came from", () => {
  it("takes the plan quantity when nothing different is entered, and remembers the lots (oldest expiry first)", async () => {
    const s = await setup();
    const res = await s.call(s.dayStoreLogin.token, "post", `/api/production-batches/${s.batch.id}/dispense`, dispense);
    expect(res.status).toBe(200);
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
    const entry = await s.call(s.production.token, "post", `/api/plant-consumption/${s.run.id}/entries`, { itemId: s.whey.id, wastedQty: 2, rejectedQty: 1, unit: "Kg", note: "Spilled while opening the bag" });
    expect(entry.status).toBe(201);
    const rows = await prisma.inventoryTransaction.findMany({ where: { itemId: s.whey.id, type: "ISSUED_RECYCLE" }, orderBy: { quantity: "desc" } });
    expect(rows.map((r) => r.quantity)).toEqual([2, 1]);
    expect(rows[0]!.plantId).toBe(s.plant.id);
    const feed = await s.call(s.production.token, "get", "/api/recycle-store/transactions");
    expect(feed.body.filter((r: { kind: string; itemName: string }) => r.kind === "material" && r.itemName === s.whey.name)).toHaveLength(2);
  });
});
