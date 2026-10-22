import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

/**
 * The per-batch flow: Start run divides nothing yet, each batch goes Indent (Production) -> Batch No (R&D) -> Dispensing (Day Store) ->
 * then Production runs it (start fields, RM Utilization, end, complete), then Packaging (PM Utilization).
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

describe("The per-batch flow: Indent -> Batch No -> Dispensing -> production -> Packaging", () => {
  it("walks two batches through it, each with its own number and material, and fills the Utilization of the whole batch after Bulk QC (editable)", async () => {
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
    const dispense = { rmDispensingDate: "2026-10-14", pmIssuedDate: "2026-10-14" };
    const short = await call(s.store, "post", `/api/production-batches/${b1.id}/dispense`, dispense);
    expect(short.status).toBe(409);
    expect(short.body.error).toMatch(/does not hold enough/);
    await s.stock(s.whey, "Kg", 100);
    await s.stock(s.tub, "Count", 100);
    expect((await call(s.production, "post", `/api/production-batches/${b1.id}/dispense`, dispense)).status).toBe(403);
    expect((await call(s.store, "post", `/api/production-batches/${b1.id}/dispense`, dispense)).status).toBe(200);
    expect((await call(s.store, "post", `/api/production-batches/${b1.id}/dispense`, dispense)).status).toBe(409); // once
    // The GRN is made by the system: FLS-<3 letters of the product>-<batch no>-<running number>
    const dispensed = await prisma.productionBatch.findUniqueOrThrow({ where: { id: b1.id }, select: { grnNo: true } });
    expect(dispensed.grnNo).toMatch(new RegExp(`^FLS-[A-Z]{3}-${n1}-\\d{2,}$`));
    const given = await prisma.batchDispensingLine.findMany({ where: { productionBatchId: b1.id }, select: { quantity: true } });
    expect(given.map((g) => g.quantity)).toEqual([40, 40]);

    // What the Day Store sent is on its way: Production receives it before the batch is READY
    const sent = await prisma.batchDispensingLine.findMany({ where: { productionBatchId: b1.id, deliveryStatus: "PENDING" } });
    expect(sent).toHaveLength(2);
    expect((await call(s.production, "patch", `/api/production-batches/${b1.id}`, { shift: "Day" })).status).toBe(409); // material not received yet: not READY
    expect((await call(s.store, "post", `/api/production-batches/${b1.id}/receive`, { lines: sent.map((l) => ({ lineId: l.id, action: "RECEIVE" })) })).status).toBe(403); // not the Store's step
    const received = await call(s.production, "post", `/api/production-batches/${b1.id}/receive`, { lines: sent.map((l) => ({ lineId: l.id, action: "RECEIVE" })) });
    expect(received.status).toBe(200);
    expect(received.body).toMatchObject({ prepStageId: "READY" }); // no Line Clearance step: READY as soon as the material is received

    expect((await call(s.qa, "post", `/api/production-batches/${b1.id}/line-clearance`, { lineClearanceStatus: "Approved" })).status).toBe(404); // the step no longer exists
    expect((await call(s.rnd, "patch", `/api/production-batches/${b1.id}/batch-no`, { batchNo: "FLS-99-9999" })).status).toBe(409); // locked once dispensed
    const summary = (await call(s.production, "get", "/api/production-batches/prep-summary")).body;
    expect(summary.READY).toBeGreaterThanOrEqual(1);

    // Production: the start fields. The batch is then at In-Process QA (still in production); QA and R&D work on it; and only once Bulk QC has
    // passed does it come back to Production for the RM Utilization of the whole batch, the end time and Send to Packaging
    const runNow = () => prisma.preProduction.findUniqueOrThrow({ where: { id: runId }, select: { combinedQty: true } });
    const put = (token: string, category: string, body: object) => request(app).put(`/api/production-batches/${b1.id}/utilization/${category}`).set(authHeader(token)).send(body);
    const rmBody = (produced: number, waste: number, reject: number, sample: number) => ({
      producedQty: produced,
      wasteQty: waste,
      rejectQty: reject,
      sampleQty: sample,
      lines: [{ itemId: s.whey.id, consumedQty: produced, wastedQty: waste, rejectedQty: reject, sampleQty: sample }],
    });
    expect((await put(s.production, "RM", rmBody(37, 1, 0.5, 0.5))).status).toBe(409); // not started yet: the start fields come first
    expect((await call(s.production, "patch", `/api/production-batches/${b1.id}`, { shift: "Day", manpowerCount: 8, shiftStartAt: "2026-10-14T08:00:00.000Z" })).status).toBe(200);
    // Started: the batch sits at In-Process QA and QA / R&D can work on it, but Production's Utilization and end time are shut until Bulk QC has passed
    const early = await call(s.production, "get", "/api/production-batches");
    expect(early.body.find((b: { id: string }) => b.id === b1.id)).toMatchObject({ status: "IN_PROGRESS", currentStageId: "IPQC" });
    const qaBoard = (await call(s.qa, "get", "/api/qc/board?stage=IPQC")).body as { link: string }[];
    expect(qaBoard.some((r) => r.link === `/production-batches/${b1.id}`)).toBe(true); // it is on QA's In-Process QA list as soon as it has started
    const tooEarlyRm = await put(s.production, "RM", rmBody(37, 1, 0.5, 0.5));
    expect(tooEarlyRm.status).toBe(409);
    expect(tooEarlyRm.body.error).toMatch(/Bulk QC/);
    const tooEarlyEnd = await call(s.production, "patch", `/api/production-batches/${b1.id}`, { shiftEndAt: "2026-10-14T17:00:00.000Z" });
    expect(tooEarlyEnd.status).toBe(409);
    expect(tooEarlyEnd.body.error).toMatch(/Bulk QC/);
    const tooEarlyComplete = await call(s.production, "post", `/api/production-batches/${b1.id}/complete`);
    expect(tooEarlyComplete.status).toBe(409);
    expect(tooEarlyComplete.body.error).toMatch(/Bulk QC/);
    const step = (token: string, body: object) => call(token, "patch", `/api/production-batches/${b1.id}/stage`, { action: "FORWARD", ...body });
    expect((await step(s.production, { ipqcStatus: "Approved" })).status).toBe(403); // In-Process QA is QA's
    const ipqc = await step(s.qa, { ipqcStatus: "Approved" });
    expect(ipqc.status).toBe(200);
    expect(ipqc.body).toMatchObject({ status: "IN_PROGRESS", currentStageId: "QA_GATE_MFG" });
    expect((await step(s.rnd, { mfgQaStatus: "Approved", mfgQcStatus: "Approved" })).status).toBe(403); // the QA Gate is QA's
    const gate = await step(s.qa, { mfgQaStatus: "Approved", mfgQcStatus: "Approved" });
    expect(gate.status).toBe(200);
    expect(gate.body).toMatchObject({ status: "IN_PROGRESS", currentStageId: "BULK_QC" });
    const bulk = await step(s.rnd, { bulkQcStatus: "Approved" }); // Bulk QC is R&D's
    expect(bulk.status).toBe(200);
    expect(bulk.body).toMatchObject({ status: "IN_PROGRESS", currentStageId: "PACKAGING" }); // back with Production
    expect((await runNow()).combinedQty).toBe(0); // nothing counts as made until the batch is sent to Packaging

    const endFirst = await call(s.production, "patch", `/api/production-batches/${b1.id}`, { shiftEndAt: "2026-10-14T17:00:00.000Z", manufacturingStatus: "Completed" });
    expect(endFirst.status).toBe(409); // the end time opens only once the RM Utilization is filled
    expect(endFirst.body.error).toMatch(/RM Utilization/);
    const completeFirst = await call(s.production, "post", `/api/production-batches/${b1.id}/complete`);
    expect(completeFirst.status).toBe(409);
    expect(completeFirst.body.error).toMatch(/RM Utilization/);

    expect((await put(s.qa, "RM", rmBody(37, 1, 0.5, 0.5))).status).toBe(403); // Production's step
    expect((await put(s.production, "PM", rmBody(37, 1, 0.5, 0.5))).status).toBe(409); // the PM sheet is Packaging's
    expect((await put(s.production, "RM", { producedQty: 37, lines: [] })).status).toBe(400); // every plan material needs its A
    expect((await put(s.production, "RM", { ...rmBody(37, 1, 0.5, 0.5), lines: [{ itemId: s.tub.id, consumedQty: 5 }] })).status).toBe(400); // a PM material is not an RM material
    const tooMuch = await put(s.production, "RM", rmBody(50, 1, 0.5, 0.5)); // the Plant holds only the 40 it was given
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toMatch(/on hand/);
    const saved = await put(s.production, "RM", rmBody(37, 1, 0.5, 0.5));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ status: "IN_PROGRESS", outputQty: 37, inputQty: 39 }); // Produced is the batch's output
    expect(saved.body.utilization).toMatchObject({ complete: true, sheets: { RM: { producedQty: 37, wasteQty: 1, rejectQty: 0.5, sampleQty: 0.5 }, PM: null } });
    expect(saved.body.utilization.entries.find((e: { itemId: string }) => e.itemId === s.whey.id)).toMatchObject({ consumedQty: 37, wastedQty: 1, rejectedQty: 0.5, sampleQty: 0.5 });
    expect((await runNow()).combinedQty).toBe(0); // a batch still in production adds to "made so far" when it is completed, not before
    expect((await call(s.production, "get", `/api/pre-productions/${runId}/production-batches`)).body.find((b: { id: string }) => b.id === b1.id).utilization.items.find((i: { itemName: string }) => i.itemName === s.whey.name)).toMatchObject({ givenQty: 40, requiredQty: 40 });

    // Edit it: saving again replaces the earlier rows (the Plant's stock and the Recycle Store follow), nothing is counted twice
    const edited = await put(s.production, "RM", rmBody(38, 1, 0.5, 0.5));
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ outputQty: 38, inputQty: 40 });
    const wheyRows = await prisma.batchMaterialConsumption.findMany({ where: { productionBatchId: b1.id, itemId: s.whey.id }, select: { purpose: true, quantity: true } });
    expect(wheyRows.reduce((t, r) => t + r.quantity, 0)).toBe(40);
    expect(wheyRows).toHaveLength(4);
    const sink = await prisma.inventoryTransaction.findMany({ where: { productionBatchId: b1.id, type: "ISSUED_RECYCLE", deletedAt: null }, select: { recycleKind: true, quantity: true } });
    expect(sink.map((r) => `${r.recycleKind}:${r.quantity}`).sort()).toEqual(["REJECTED:0.5", "WASTAGE:1"]);

    // The output is not typed any more: a value sent for it is ignored, the end time opens, and the batch completes
    const ignored = await call(s.production, "patch", `/api/production-batches/${b1.id}`, { outputQty: 99 });
    expect(ignored.status).toBe(200);
    expect(ignored.body.outputQty).toBe(38);
    expect((await call(s.production, "patch", `/api/production-batches/${b1.id}`, { shiftEndAt: "2026-10-14T17:00:00.000Z", manufacturingStatus: "Completed" })).status).toBe(200);
    const done = await call(s.production, "post", `/api/production-batches/${b1.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.productionBatch).toMatchObject({ status: "COMPLETED", outputQty: 38 });
    expect((await runNow()).combinedQty).toBe(38);

    // Packaging: the RM Utilization was filled before the batch was sent, so Packaging has only its own sheet and the PM Utilization: the RM sheet
    // is no longer taken here, and Packaging does not ask for it
    const pack = (body: object) => call(s.production, "patch", `/api/production-batches/${b1.id}/packaging`, body);
    const rmAtPackaging = await put(s.production, "RM", rmBody(37, 1, 0.5, 0.5));
    expect(rmAtPackaging.status).toBe(409);
    expect(rmAtPackaging.body.error).toMatch(/before it is sent to Packaging/);
    expect((await runNow()).combinedQty).toBe(38);

    // Packaging's own sheet is open now; its end (and Handover) wait for the PM Utilization
    // The status is one of three (In Progress, Completed, On Hold) and is In Progress by itself once the start fields are saved
    const badStatus = await pack({ packagingStatus: "Labelling" });
    expect(badStatus.status).toBe(400);
    expect(JSON.stringify(badStatus.body)).toMatch(/In Progress, Completed, On Hold/);
    const started = await pack({ packagingShift: "Day", packagingManpowerCount: 6, packagingStartAt: "2026-10-15T14:00:00.000Z" });
    expect(started.status).toBe(200);
    expect(started.body.packagingStatus).toBe("In Progress");
    const onHold = await pack({ packagingStatus: "on hold" });
    expect(onHold.body.packagingStatus).toBe("On Hold");
    expect((await pack({ packagingStatus: "In Progress" })).body.packagingStatus).toBe("In Progress");
    expect((await call(s.production, "post", `/api/production-batches/${b1.id}/handover-to-store`)).status).toBe(409); // not through QA's packaging gate yet
    const blocked = await pack({ packagingStatus: "Completed", packagingEndAt: "2026-10-15T19:00:00.000Z" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/PM Utilization/);
    const pmSaved = await put(s.production, "PM", { producedQty: 38, wasteQty: 1, lines: [{ itemId: s.tub.id, consumedQty: 38, wastedQty: 1 }] });
    expect(pmSaved.status).toBe(200);
    expect(pmSaved.body.utilization).toMatchObject({ pm: { complete: true }, sheets: { PM: { producedQty: 38, wasteQty: 1 } } });
    expect(pmSaved.body.outputQty).toBe(38); // the PM sheet does not touch the batch's output
    const finished = await pack({ packagingStatus: "Completed", packagingEndAt: "2026-10-15T19:00:00.000Z", packagingRemarks: "Packed" });
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ packagingStatus: "Completed", packagingShift: "Day", packagingManpowerCount: 6 });
    expect(finished.body.packagingEndDate).toBe(finished.body.packagingEndAt);
    // Saving the finished sheet (start fields, end time, PM Utilization) sent the batch to QA's packaging gate by itself; it stays on the Packaging and Handover lists, waiting
    expect(finished.body.currentStageId).toBe("QA_GATE_PACKAGING");
    const board2 = (await call(s.production, "get", "/api/production-batches/packaging-board")).body as { id: string; currentStageId: string }[];
    expect(board2.find((b) => b.id === b1.id)?.currentStageId).toBe("QA_GATE_PACKAGING");
    const handBoard = async () => ((await call(s.production, "get", "/api/production-batches/handover-board")).body as { batchId: string; waitingForQa: boolean; awaitingStoreHandover: boolean }[]).find((b) => b.batchId === b1.id);
    expect(await handBoard()).toMatchObject({ waitingForQa: true, awaitingStoreHandover: false });
    expect((await pack({ packagingRemarks: "Changed" })).status).toBe(409); // the sheet is closed while QA decides
    const tooEarly = await call(s.production, "post", `/api/production-batches/${b1.id}/handover-to-store`);
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.error).toMatch(/QA has not approved/);

    // QA approves the packaging gate: the goods are Production's to hand over to the store; Production is told, the Day Store is not yet
    const approved = await step(s.qa, { packQaStatus: "Approved", packQcStatus: "Approved", packApprovedQty: 38 });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ currentStageId: "FG_STORE", handedToStoreAt: null });
    expect(await handBoard()).toMatchObject({ waitingForQa: false, awaitingStoreHandover: true });
    expect((await call(s.production, "get", "/api/production-batches/packaging-board")).body.find((b: { id: string }) => b.id === b1.id).currentStageId).toBe("FG_STORE");
    const fgList = async () => ((await call(s.store, "get", "/api/fg/store-board?stage=FG_STORE")).body as { batchId?: string; id?: string }[]);
    expect((await fgList()).some((r) => (r.batchId ?? r.id) === b1.id)).toBe(false); // not the Store's finished goods yet
    expect((await call(s.store, "post", `/api/production-batches/${b1.id}/handover-to-store`)).status).toBe(403); // Production's step
    const handed = await call(s.production, "post", `/api/production-batches/${b1.id}/handover-to-store`);
    expect(handed.status).toBe(200);
    expect(handed.body.handedToStoreAt).not.toBeNull();
    expect((await call(s.production, "post", `/api/production-batches/${b1.id}/handover-to-store`)).status).toBe(409); // already handed over
    expect(await handBoard()).toBeUndefined(); // it leaves Production's lists
    expect((await fgList()).some((r) => (r.batchId ?? r.id) === b1.id)).toBe(true); // and shows in the Store's finished goods

    // The Production Report's batch detail: timeline, Packaging's sheet and the RM / PM Utilization (with Given and the leftover)
    type ReportMaterial = { itemName: string; category: string; inPlan: boolean; requiredQty: number; givenQty: number; consumedQty: number; wastedQty: number; returnedQty: number };
    const report = (await call(s.production, "get", "/api/production-batches/report-board")).body as { batchId: string; batchNo: string; packagingShift: string; packagingManpowerCount: number; indentSignedAt: string | null; dispensedAt: string | null; lineClearanceStatus: string; materials: ReportMaterial[] }[];
    const r1 = report.find((b) => b.batchId === b1.id)!;
    expect(r1).toMatchObject({ batchNo: n1, packagingShift: "Day", packagingManpowerCount: 6 });
    expect(r1.indentSignedAt).not.toBeNull();
    expect(r1.dispensedAt).not.toBeNull();
    expect(r1.materials.find((m) => m.itemName === s.whey.name)).toMatchObject({ category: "RM", inPlan: true, requiredQty: 40, givenQty: 40, consumedQty: 38, wastedQty: 1, returnedQty: 0 });
    expect(r1.materials.find((m) => m.itemName === s.tub.name)).toMatchObject({ category: "PM", inPlan: true, requiredQty: 40, givenQty: 40, consumedQty: 38, wastedQty: 1 });
    expect((await call(s.store, "get", "/api/production-batches/report-board")).status).toBe(403); // Production and PPIC only
    expect(r1).toMatchObject({ dispatchedQty: 0, dispatchDate: null });

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
