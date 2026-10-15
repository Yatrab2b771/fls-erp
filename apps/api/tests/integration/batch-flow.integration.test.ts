import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";
import { BATCH_LINE_CLEARANCE_ITEMS } from "../../src/modules/batches/batch-checklists";

const app = createApp();

/**
 * The per-batch flow: Start run divides nothing yet, each batch goes Indent (Production) -> Batch No (R&D) -> Dispensing (Day Store) ->
 * Line Clearance (QA), then Production runs it (start fields, RM Utilization, end, complete), then Packaging (PM Utilization).
 */
async function setup() {
  const production = await createUser(["PRODUCTION"]);
  const rnd = await createUser(["RND"]);
  const qa = await createUser(["QA_QC"]);
  const store = await createUser(["STORE"]);
  const bd = await createUser(["BD"]);
  const stamp = Date.now();
  const dayStore = await prisma.dayStore.create({ data: { name: `BF Store ${stamp}`, createdById: production.user.id } });
  const plant = await prisma.plant.create({ data: { name: `BF Plant ${stamp}`, createdById: production.user.id, dayStoreId: dayStore.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: store.user.id, dayStoreId: dayStore.id } });

  const whey = await prisma.inventoryItem.create({ data: { category: "RM", name: `BF Whey ${stamp}`, unit: "Kg" } });
  const tub = await prisma.inventoryItem.create({ data: { category: "PM", name: `BF Tub ${stamp}`, unit: "Count" } });
  const stock = async (item: { id: string }, unit: string, quantity: number) => {
    const base = { itemId: item.id, createdById: production.user.id, date: new Date(), unit };
    await prisma.inventoryTransaction.create({ data: { ...base, type: "RECEIVED", quantity, vendorName: "V", receiptStatus: "ACCEPTED", acceptedById: production.user.id, acceptedAt: new Date() } });
    await prisma.inventoryTransaction.create({ data: { ...base, type: "ISSUED_DAY_STORE", quantity, dayStoreId: dayStore.id, deliveredAt: new Date() } });
  };

  const customer = await request(app).post("/api/customers").set(authHeader(bd.token)).send({ companyName: `BF Customer ${stamp}` });
  const po = await request(app).post("/api/purchase-orders").set(authHeader(bd.token)).send({ customerId: customer.body.id, poNumber: `BF-PO-${stamp}`, items: [{ productName: "BF Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
  const itemId = po.body.items[0].id as string;
  await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved", planSentToProductionAt: new Date() } });
  await prisma.rmPlan.create({ data: { name: "BF rm", status: "CALCULATED", calculatedAt: new Date(), costingParams: {}, createdById: production.user.id, purchaseOrderItemId: itemId, resultSnapshot: { procurement: [{ name: whey.name, totalKg: 100 }] } } });
  await prisma.bomPlan.create({ data: { name: "BF bom", status: "CALCULATED", calculatedAt: new Date(), createdById: production.user.id, purchaseOrderItemId: itemId, resultSnapshot: { lines: [{ component: "Tub", itemName: tub.name, totalQty: 100 }] } } });
  return { userId: production.user.id, production: production.token, rnd: rnd.token, qa: qa.token, store: store.token, itemId, plant, dayStore, whey, tub, stock };
}

describe("The per-batch flow: Indent -> Batch No -> Dispensing -> Line Clearance -> production -> Packaging", () => {
  it("walks two batches through it, each with its own number and material, and derives input and output from the Utilization", async () => {
    const s = await setup();
    const call = (token: string, method: "get" | "post" | "patch", path: string, body?: object) => {
      const r = request(app)[method](path).set(authHeader(token));
      return body ? r.send(body) : r;
    };

    // Start run in the per-batch flow: the run has no stages of its own
    const run = await call(s.production, "post", "/api/pre-productions", { purchaseOrderItemId: s.itemId, batchFlow: true, confirmNotReady: true });
    expect(run.status).toBe(201);
    expect(run.body).toMatchObject({ batchFlow: true, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" });
    const runId = run.body.id as string;

    // Divide: only the quantity; each batch starts at Indent Issue
    const b1 = (await call(s.production, "post", `/api/pre-productions/${runId}/production-batches`, { plannedQty: 40 })).body;
    const b2 = (await call(s.production, "post", `/api/pre-productions/${runId}/production-batches`, { plannedQty: 35 })).body;
    expect(b1).toMatchObject({ plannedQty: 40, prepStageId: "INDENT_ISSUE", batchNo: null });
    expect((await call(s.production, "get", "/api/production-batches/prep-board?stage=INDENT_ISSUE")).body.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([b1.id, b2.id]));

    // The steps cannot be skipped, and each belongs to its own department
    expect((await call(s.rnd, "post", `/api/production-batches/${b1.id}/batch-no/allocate`, {})).status).toBe(409); // no indent yet
    expect((await call(s.store, "post", `/api/production-batches/${b1.id}/dispense`, { rmDispensingDate: "2026-10-14", pmIssuedDate: "2026-10-14" })).status).toBe(409);
    expect((await call(s.production, "patch", `/api/production-batches/${b1.id}`, { shift: "Day" })).status).toBe(409); // not cleared for production
    const indent = { prodIndentSlipSign: "BF Head", productionPlanDate: "2026-10-14" };
    expect((await call(s.rnd, "post", `/api/production-batches/${b1.id}/indent`, indent)).status).toBe(403);
    expect((await call(s.production, "post", `/api/production-batches/${b1.id}/indent`, { prodIndentSlipSign: "" })).status).toBe(400);
    expect((await call(s.production, "post", `/api/production-batches/${b1.id}/indent`, indent)).status).toBe(200);
    expect((await call(s.production, "post", `/api/production-batches/${b1.id}/indent`, indent)).status).toBe(409); // once
    expect((await call(s.production, "post", `/api/production-batches/${b2.id}/indent`, indent)).status).toBe(200);

    // R&D allocates serial numbers: unique, counting up; a typed number is checked for duplicates
    const n1 = (await call(s.rnd, "post", `/api/production-batches/${b1.id}/batch-no/allocate`, {})).body.batchNo as string;
    expect(n1).toMatch(/^FLS-\d\d-\d{4}$/);
    const typed = await call(s.rnd, "post", `/api/production-batches/${b2.id}/batch-no/allocate`, { batchNo: n1 });
    expect(typed.status).toBe(409);
    const n2 = (await call(s.rnd, "post", `/api/production-batches/${b2.id}/batch-no/allocate`, {})).body.batchNo as string;
    expect(n2).toMatch(/^FLS-\d\d-\d{4}$/);
    expect(n2).not.toBe(n1);
    expect(Number(n2.slice(-4))).toBeGreaterThan(Number(n1.slice(-4)));
    expect((await call(s.rnd, "patch", `/api/production-batches/${b2.id}/batch-no`, { batchNo: n1 })).status).toBe(409); // a correction cannot take a used number

    // Dispensing is the batch's own material (40 of 100 Kg, 40 of 100 tubs); the Day Store has to hold it
    const board = (await call(s.store, "get", "/api/production-batches/prep-board?stage=DISPENSING")).body as { id: string; requirements: { itemName: string; requiredQty: number; enough: boolean }[] }[];
    const row = board.find((r) => r.id === b1.id)!;
    expect(row.requirements.map((r) => r.requiredQty).sort()).toEqual([40, 40]);
    expect(row.requirements.every((r) => !r.enough)).toBe(true);
    const dispense = { rmDispensingDate: "2026-10-14", pmIssuedDate: "2026-10-14", grnNo: "BF-GRN-1" };
    const short = await call(s.store, "post", `/api/production-batches/${b1.id}/dispense`, dispense);
    expect(short.status).toBe(409);
    expect(short.body.error).toMatch(/does not hold enough/);
    await s.stock(s.whey, "Kg", 100);
    await s.stock(s.tub, "Count", 100);
    expect((await call(s.production, "post", `/api/production-batches/${b1.id}/dispense`, dispense)).status).toBe(403);
    expect((await call(s.store, "post", `/api/production-batches/${b1.id}/dispense`, dispense)).status).toBe(200);
    expect((await call(s.store, "post", `/api/production-batches/${b1.id}/dispense`, dispense)).status).toBe(409); // once
    const given = await prisma.batchDispensingLine.findMany({ where: { productionBatchId: b1.id }, select: { quantity: true } });
    expect(given.map((g) => g.quantity)).toEqual([40, 40]);

    // QA clears the line
    expect((await call(s.production, "post", `/api/production-batches/${b1.id}/line-clearance`, { lineClearanceStatus: "Approved" })).status).toBe(403);
    expect((await call(s.qa, "post", `/api/production-batches/${b1.id}/line-clearance`, { lineClearanceStatus: "Hold" })).status).toBe(400); // a remark is needed
    expect((await call(s.qa, "post", `/api/production-batches/${b1.id}/line-clearance`, { lineClearanceStatus: "Hold", lineClearanceRemarks: "Line is wet" })).status).toBe(200);
    expect((await call(s.production, "patch", `/api/production-batches/${b1.id}`, { shift: "Day" })).status).toBe(409); // Hold: still not cleared
    // Approving needs every item of QA's BMR 4.0 checklist ticked
    const allTicked = Object.fromEntries(BATCH_LINE_CLEARANCE_ITEMS.map((i) => [i.key, true]));
    const partial = await call(s.qa, "post", `/api/production-batches/${b1.id}/line-clearance`, { lineClearanceStatus: "Approved", lineClearanceChecks: { ...allTicked, [BATCH_LINE_CLEARANCE_ITEMS[0]!.key]: false } });
    expect(partial.status).toBe(400);
    expect(JSON.stringify(partial.body)).toMatch(/Tick every Line Clearance checklist item/);
    expect((await call(s.qa, "post", `/api/production-batches/${b1.id}/line-clearance`, { lineClearanceStatus: "Approved", lineClearanceChecks: { not_an_item: true } })).status).toBe(400);
    expect((await call(s.qa, "post", `/api/production-batches/${b1.id}/line-clearance`, { lineClearanceStatus: "Approved" })).status).toBe(400); // no checklist at all
    expect((await call(s.qa, "post", `/api/production-batches/${b1.id}/line-clearance`, { lineClearanceStatus: "Approved", lineClearanceChecks: allTicked })).body).toMatchObject({ prepStageId: "READY" });
    expect((await call(s.rnd, "patch", `/api/production-batches/${b1.id}/batch-no`, { batchNo: "FLS-99-9999" })).status).toBe(409); // locked once dispensed
    const summary = (await call(s.production, "get", "/api/production-batches/prep-summary")).body;
    expect(summary.READY).toBeGreaterThanOrEqual(1);

    // Production: the start fields, then the RM Utilization, then the end; input and output are worked out from the Utilization
    expect((await call(s.production, "patch", `/api/production-batches/${b1.id}`, { shift: "Day", manpowerCount: 8, shiftStartAt: "2026-10-14T08:00:00.000Z" })).status).toBe(200);
    const early = await call(s.production, "patch", `/api/production-batches/${b1.id}`, { shiftEndAt: "2026-10-14T17:00:00.000Z" });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/RM Utilization/);
    const log = (itemId: string, unit: string, body: object) => call(s.production, "post", `/api/plant-consumption/${runId}/entries`, { itemId, unit, productionBatchId: b1.id, ...body });
    expect((await log(s.whey.id, "Kg", { consumedQty: 37, wastedQty: 1, rejectedQty: 0.5, sampleQty: 0.5, returnedQty: 1 })).status).toBe(201);
    const listed = (await call(s.production, "get", `/api/pre-productions/${runId}/production-batches`)).body as { id: string; utilization: { complete: boolean; pm: { complete: boolean; missing: string[] }; items: { itemName: string; givenQty: number; requiredQty: number }[] } }[];
    const u1 = listed.find((b) => b.id === b1.id)!.utilization;
    expect(u1.complete).toBe(true);
    expect(u1.pm.complete).toBe(false); // the tubs are used at Packaging
    expect(u1.items.find((i) => i.itemName === s.whey.name)).toMatchObject({ givenQty: 40, requiredQty: 40 });
    expect((await call(s.production, "post", `/api/production-batches/${b1.id}/complete`)).status).toBe(409); // no end time yet
    expect((await call(s.production, "patch", `/api/production-batches/${b1.id}`, { shiftEndAt: "2026-10-14T17:00:00.000Z", manufacturingStatus: "Completed", outputQty: 999 })).status).toBe(200);
    const done = await call(s.production, "post", `/api/production-batches/${b1.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.productionBatch).toMatchObject({ status: "COMPLETED", inputQty: 39, outputQty: 37 }); // input 37+1+0.5+0.5 (the 1 left over is not used); the typed 999 was ignored

    // The leftover (E) stays in the Plant's stock; Production sends it back to the Day Store from Plant Stock
    type StockRow = { itemId: string; onHand: number; reserved: number; free: number; pendingReturn: number };
    const stockOf = async () => ((await call(s.production, "get", `/api/plant-stock?plantId=${s.plant.id}`)).body.rows as StockRow[]).find((r) => r.itemId === s.whey.id);
    expect(await stockOf()).toMatchObject({ onHand: 1, reserved: 0, free: 1, pendingReturn: 1 });
    const sendBack = (quantity: number) => call(s.production, "post", "/api/plant-stock/return", { plantId: s.plant.id, itemId: s.whey.id, quantity });
    expect((await sendBack(2)).status).toBe(409); // only 1 is free
    expect((await call(s.store, "post", "/api/plant-stock/return", { plantId: s.plant.id, itemId: s.whey.id, quantity: 1 })).status).toBe(403); // Production's call
    expect((await sendBack(1)).status).toBe(201);
    expect(await stockOf()).toBeUndefined(); // nothing of it is left at the Plant
    const moved = await prisma.stockTransfer.findFirstOrThrow({ where: { itemId: s.whey.id, sourcePlantId: s.plant.id } });
    expect(moved).toMatchObject({ quantity: 1, destinationType: "DAY_STORE", destDayStoreId: s.dayStore.id });

    // Packaging: its own production sheet and the PM Utilization (the tubs)
    await prisma.productionBatch.update({ where: { id: b1.id }, data: { currentStageId: "PACKAGING" } });
    const pack = (body: object) => call(s.production, "patch", `/api/production-batches/${b1.id}/packaging`, body);
    expect((await pack({ packagingShift: "Day", packagingManpowerCount: 6, packagingStartAt: "2026-10-15T14:00:00.000Z", packagingStatus: "Labelling" })).status).toBe(200);
    const blocked = await pack({ packagingStatus: "Completed", packagingEndAt: "2026-10-15T19:00:00.000Z" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/PM Utilization/);
    expect((await log(s.tub.id, "Count", { consumedQty: 38, wastedQty: 1 })).status).toBe(201);
    const finished = await pack({ packagingStatus: "Completed", packagingEndAt: "2026-10-15T19:00:00.000Z", packagingRemarks: "Packed" });
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ packagingStatus: "Completed", packagingShift: "Day", packagingManpowerCount: 6 });
    expect(finished.body.packagingEndDate).toBe(finished.body.packagingEndAt);
    const board2 = (await call(s.production, "get", "/api/production-batches/packaging-board")).body as { id: string }[];
    expect(board2.map((b) => b.id)).toContain(b1.id);

    // The Production Report's batch detail: timeline, Packaging's sheet and the RM / PM Utilization (with Given and the leftover)
    type ReportMaterial = { itemName: string; category: string; inPlan: boolean; requiredQty: number; givenQty: number; consumedQty: number; wastedQty: number; returnedQty: number };
    const report = (await call(s.production, "get", "/api/production-batches/report-board")).body as { batchId: string; batchNo: string; packagingShift: string; packagingManpowerCount: number; indentSignedAt: string | null; dispensedAt: string | null; lineClearanceStatus: string; materials: ReportMaterial[] }[];
    const r1 = report.find((b) => b.batchId === b1.id)!;
    expect(r1).toMatchObject({ batchNo: n1, packagingShift: "Day", packagingManpowerCount: 6, lineClearanceStatus: "Approved" });
    expect(r1.indentSignedAt).not.toBeNull();
    expect(r1.dispensedAt).not.toBeNull();
    expect(r1.materials.find((m) => m.itemName === s.whey.name)).toMatchObject({ category: "RM", inPlan: true, requiredQty: 40, givenQty: 40, consumedQty: 37, wastedQty: 1, returnedQty: 1 });
    expect(r1.materials.find((m) => m.itemName === s.tub.name)).toMatchObject({ category: "PM", inPlan: true, requiredQty: 40, givenQty: 40, consumedQty: 38, wastedQty: 1 });
    expect((await call(s.store, "get", "/api/production-batches/report-board")).status).toBe(403); // Production and PPIC only
    expect(r1).toMatchObject({ lineClearanceChecks: allTicked, dispatchedQty: 0, dispatchDate: null });

    // Dispatch: what customer shipments have sent counts for the batch, wherever the batch is now; extra material shows per product
    await prisma.fgShipment.create({ data: { productionBatchId: b1.id, type: "CUSTOMER", status: "DISPATCHED", quantity: 12, dispatchDate: new Date("2026-10-20T10:00:00.000Z"), invoiceDate: new Date("2026-10-19T10:00:00.000Z"), requestedById: s.userId } });
    await prisma.inventoryRequest.create({ data: { itemId: s.whey.id, category: "RM", requestedQty: 10, purpose: "ISSUED_PRODUCTION", requestedById: s.userId, plantId: s.plant.id, isExtra: true, extraForPoItemId: s.itemId } });
    const again = (await call(s.production, "get", "/api/production-batches/report-board")).body as { batchId: string; dispatchedQty: number; dispatchDate: string | null; invoiceDate: string | null; materials: { itemName: string; extraRequestedQty: number; extraIssuedQty: number }[] }[];
    const r1b = again.find((b) => b.batchId === b1.id)!;
    expect(r1b.dispatchedQty).toBe(12);
    expect(r1b.dispatchDate).toBe("2026-10-20T10:00:00.000Z");
    expect(r1b.invoiceDate).toBe("2026-10-19T10:00:00.000Z");
    expect(r1b.materials.find((m) => m.itemName === s.whey.name)).toMatchObject({ extraRequestedQty: 10, extraIssuedQty: 0 });
  });
});
