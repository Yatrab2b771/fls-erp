import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("Production's extra material: Store -> Warehouse -> PPIC -> Purchase, then back down the same way", () => {
  it("walks one request from Production to the Plant", async () => {
    const { user: productionUser, token: production } = await createUser(["PRODUCTION"]);
    const { token: otherProduction, user: otherProductionUser } = await createUser(["PRODUCTION"]);
    const { user: dayStoreUser, token: dayStore } = await createUser(["STORE"]);
    const { token: warehouse } = await createUser(["STORE"]);
    const { token: ppic } = await createUser(["PPIC"]);
    const { token: purchase } = await createUser(["PURCHASE"]);
    const { token: rnd } = await createUser(["RND"]);

    const mk = async (name: string, owner: string) => {
      const store = await prisma.dayStore.create({ data: { name: `${name} ${Date.now()}`, createdById: owner } });
      return { store, plant: await prisma.plant.create({ data: { name: `${name} Plant ${Date.now()}`, createdById: owner, dayStoreId: store.id } }) };
    };
    const mine = await mk("EX", dayStoreUser.id);
    const other = await mk("EX Other", dayStoreUser.id);
    await prisma.dayStoreAssignment.create({ data: { userId: dayStoreUser.id, dayStoreId: mine.store.id } });
    await prisma.plantAssignment.create({ data: { userId: productionUser.id, plantId: mine.plant.id } });
    await prisma.plantAssignment.create({ data: { userId: otherProductionUser.id, plantId: other.plant.id } });

    // A product on a PO with a run at Plant "mine", and its batches: extra material is always asked for one batch
    const { token: bd } = await createUser(["BD"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "EX Customer" });
    const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: customer.body.id, poNumber: "EX-PO-1", items: [{ productName: "EX Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: po.body.items[0].id, plannedQty: 100, plantId: mine.plant.id, batchFlow: true, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
    const mkBatch = (batchNo: string | null, extraData: Record<string, unknown> = {}) =>
      prisma.productionBatch.create({ data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: productionUser.id } }, batchNo, plannedQty: 50, status: "IN_PROGRESS", ...extraData } });
    const batch = await mkBatch("EXB-1");

    const item = await request(app).post("/api/inventory/items").set(authHeader(warehouse)).send({ category: "RM", name: `EX Resin ${Date.now()}`, unit: "Kg" });
    const extra = (token: string, body: Record<string, unknown>) => request(app).post("/api/inventory/extra-requests").set(authHeader(token)).send({ itemId: item.body.id, requestedQty: 40, reason: "Spillage on the line", productionBatchId: batch.id, neededBy: "2026-10-20", ...body });

    // Production raises it for one batch of its own Plant, with a reason; the batch gives the PO, the product and the Plant
    expect((await extra(production, { reason: "x" })).status).toBe(400);
    expect((await extra(production, { productionBatchId: undefined })).status).toBe(400); // no batch, no request
    expect((await extra(production, { productionBatchId: "00000000-0000-0000-0000-000000000000" })).status).toBe(400); // unknown batch
    const noNumber = await mkBatch(null);
    expect((await extra(production, { productionBatchId: noNumber.id })).status).toBe(409); // no batch number yet
    const packed = await mkBatch("EXB-PACKED", { currentStageId: "FG_STORE" });
    expect((await extra(production, { productionBatchId: packed.id })).status).toBe(409); // already packed: no more material for it
    expect((await extra(dayStore, {})).status).toBe(403); // Production only
    expect((await extra(otherProduction, {})).status).toBe(403); // not that Plant's login
    const batchList = (token: string) => request(app).get("/api/inventory/extra-requests/batches").set(authHeader(token));
    expect((await batchList(production)).body).toEqual([expect.objectContaining({ batchId: batch.id, batchNo: "EXB-1", productName: "EX Powder", poNumber: "EX-PO-1", plantId: mine.plant.id })]); // only numbered batches that are not yet packed
    expect((await batchList(otherProduction)).body).toEqual([]); // another Plant's login sees none of them
    expect((await batchList(dayStore)).status).toBe(403);
    const created = await extra(production, {});
    expect(created.status).toBe(201);
    const productionRequestId = created.body.id as string;

    // The Store of that Plant sees it as extra for that batch, approves it; it has no stock, so it asks the Warehouse
    const dsList = async () => ((await request(app).get("/api/inventory/my-store/production-requests?pageSize=200").set(authHeader(dayStore))).body as { id: string; isExtra: boolean; productName: string | null; note: string | null; toAsk: number; purchaseState: string | null; purchaseEta: string | null; stage: string }[]);
    const seen = (await dsList()).find((r) => r.id === productionRequestId);
    expect(seen).toMatchObject({ isExtra: true, productName: null, note: "Spillage on the line", toAsk: 40, batchNo: "EXB-1", bundleTitle: "Extra material - for EX Powder, batch EXB-1" });
    expect((await request(app).patch(`/api/inventory/requests/${productionRequestId}/review`).set(authHeader(dayStore)).send({ action: "APPROVE" })).status).toBe(200);
    const ask = await request(app).post(`/api/inventory/my-store/production-requests/${productionRequestId}/request-from-warehouse`).set(authHeader(dayStore));
    expect(ask.status).toBe(201);
    const askId = ask.body.id as string;

    // The Warehouse has nothing, so the need went to PPIC by itself - only the missing 40 Kg
    const requirement = await prisma.preInventoryRequirement.findFirst({ where: { sourceRequestId: askId } });
    expect(requirement).toBeTruthy();
    expect(requirement!.requiredQty).toBeCloseTo(40, 6);
    expect(requirement!.note).toContain("Extra material");
    const trail = async () => ((await request(app).get("/api/inventory/extra-requests").set(authHeader(production))).body as { id: string; supplyStage: string | null; purchaseEta: string | null; status: string; stage: string; issuedQty: number }[]).find((r) => r.id === productionRequestId)!;
    expect((await trail()).supplyStage).toBe("WITH_PPIC");
    expect((await request(app).get("/api/inventory/extra-requests").set(authHeader(otherProduction))).body).toEqual([]); // another Plant's login does not see it
    const again = await request(app).get("/api/inventory/material-requests").set(authHeader(warehouse)); // reading the Warehouse list does not escalate it twice
    expect(again.status).toBe(200);
    expect(await prisma.preInventoryRequirement.count({ where: { sourceRequestId: askId } })).toBe(1);

    // PPIC sends it to Purchase; Purchase logs a PI with an ETA, which shows to Production and the Day Store
    expect((await request(app).post(`/api/inventory/requirements/${requirement!.id}/notify-purchase`).set(authHeader(ppic))).status).toBe(200);
    expect((await trail()).supplyStage).toBe("WITH_PURCHASE");
    const pi = await request(app).patch(`/api/inventory/requirements/${requirement!.id}/purchase`).set(authHeader(purchase)).send({ poNumber: "PI-EX-1", vendorName: "EX Vendor", eta: "2026-10-18", quantity: 40 });
    expect(pi.status).toBe(200);
    expect(await trail()).toMatchObject({ supplyStage: "ON_ORDER", purchaseEta: expect.stringContaining("2026-10-18") });
    expect((await dsList()).find((r) => r.id === productionRequestId)).toMatchObject({ purchaseState: "ON_ORDER", purchaseEta: expect.stringContaining("2026-10-18") });

    // The material arrives: the Warehouse receives it, R&D approves it, the Warehouse issues to the Day Store, the Day Store issues to the Plant
    const received = await request(app).post("/api/inventory/transactions").set(authHeader(warehouse)).send({ itemId: item.body.id, type: "RECEIVED", date: "2026-10-05", unit: "Kg", quantity: 50, vendorName: "EX Vendor" });
    expect(received.status).toBe(201);
    expect((await request(app).patch(`/api/inventory/transactions/${received.body.id}/qc`).set(authHeader(rnd)).send({ action: "APPROVE", samplingDate: "2026-10-05" })).status).toBe(200);
    expect((await request(app).patch(`/api/inventory/requests/${askId}/review`).set(authHeader(warehouse)).send({ action: "APPROVE" })).status).toBe(200);
    const toStore = await request(app).post(`/api/inventory/requests/${askId}/issue`).set(authHeader(warehouse)).send({ date: "2026-10-05", unit: "Kg", quantity: 40, dayStoreId: mine.store.id });
    expect(toStore.status).toBe(201);
    const toPlant = await request(app).post(`/api/inventory/requests/${productionRequestId}/issue`).set(authHeader(dayStore)).send({ date: "2026-10-05", unit: "Kg", quantity: 40, dayStoreId: mine.store.id });
    expect(toPlant.status).toBe(201);
    const done = await trail();
    expect(done).toMatchObject({ status: "Issued", issuedQty: 40, stage: "ISSUED_TO_PLANT", batchNo: "EXB-1", refProduct: "EX Powder", refPoNumber: "EX-PO-1" });

    // The material is traced to the batch: its Utilization lists it (issued 40, to fill in what was used) and the Production Report shows asked / issued
    const batchRow = ((await request(app).get(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(production))).body as { id: string; utilization: { extraItems: { itemId: string; givenQty: number; category: string }[] } }[]).find((b) => b.id === batch.id)!;
    expect(batchRow.utilization.extraItems).toEqual([expect.objectContaining({ itemId: item.body.id, givenQty: 40, category: "RM" })]);
    const report = (await request(app).get("/api/production-batches/report-board").set(authHeader(production))).body as { batchId: string; materials: { itemId: string; inPlan: boolean; extraRequestedQty: number; extraIssuedQty: number }[] }[];
    expect(report.find((b) => b.batchId === batch.id)!.materials.find((m) => m.itemId === item.body.id)).toMatchObject({ inPlan: false, extraRequestedQty: 40, extraIssuedQty: 40 });

    // Production can withdraw only what the Day Store has not started on
    const second = await extra(production, { requestedQty: 5 });
    expect((await request(app).delete(`/api/inventory/extra-requests/${second.body.id}`).set(authHeader(otherProduction))).status).toBe(403);
    expect((await request(app).delete(`/api/inventory/extra-requests/${second.body.id}`).set(authHeader(production))).status).toBe(204);
    expect((await request(app).delete(`/api/inventory/extra-requests/${productionRequestId}`).set(authHeader(production))).status).toBe(409);
  });
});

describe("Production types in a material that is not in the item list (RM, PM or Other)", () => {
  it("creates the item once (a same-named one is reused), flags the request as a new material, and sends it down the same chain", async () => {
    const { user: productionUser, token: production } = await createUser(["PRODUCTION"]);
    const { user: dayStoreUser, token: dayStore } = await createUser(["STORE"]);
    const { token: warehouse } = await createUser(["STORE"]);
    const { token: ppic } = await createUser(["PPIC"]);
    const { token: bd } = await createUser(["BD"]);
    const store = await prisma.dayStore.create({ data: { name: `EXN ${Date.now()}`, createdById: dayStoreUser.id } });
    const plant = await prisma.plant.create({ data: { name: `EXN Plant ${Date.now()}`, createdById: dayStoreUser.id, dayStoreId: store.id } });
    await prisma.dayStoreAssignment.create({ data: { userId: dayStoreUser.id, dayStoreId: store.id } });
    await prisma.plantAssignment.create({ data: { userId: productionUser.id, plantId: plant.id } });
    const customer = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "EXN Customer" });
    const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: customer.body.id, poNumber: "EXN-PO-1", items: [{ productName: "EXN Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: po.body.items[0].id, plannedQty: 100, plantId: plant.id, batchFlow: true, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
    const batch = await prisma.productionBatch.create({ data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: productionUser.id } }, batchNo: "EXB-1", plannedQty: 50, status: "IN_PROGRESS" } });
    const ask = (body: Record<string, unknown>) => request(app).post("/api/inventory/extra-requests").set(authHeader(production)).send({ requestedQty: 12, reason: "Gloves ran out on the line", productionBatchId: batch.id, ...body });
    const unique = Date.now();

    // Exactly one of an item or a new material
    expect((await ask({})).status).toBe(400);
    const anItem = await request(app).post("/api/inventory/items").set(authHeader(warehouse)).send({ category: "RM", name: `EXN Resin ${unique}`, unit: "Kg" });
    expect((await ask({ itemId: anItem.body.id, newItem: { category: "OTHER", name: "Gloves", unit: "Nos" } })).status).toBe(400);
    expect((await ask({ newItem: { category: "OTHER", name: "G", unit: "Nos" } })).status).toBe(400); // a name worth reading
    expect((await ask({ newItem: { category: "OTHER", name: "Gloves", unit: "" } })).status).toBe(400); // a unit

    // Other: typed by hand. The item is created (no code, no stock) and the request is flagged
    const name = `EXN Nitrile Gloves ${unique}`;
    const first = await ask({ newItem: { category: "OTHER", name, unit: "Nos" } });
    expect(first.status).toBe(201);
    const created = await prisma.inventoryItem.findMany({ where: { name } });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ category: "OTHER", unit: "Nos", code: null });
    expect(await prisma.inventoryRequest.findUnique({ where: { id: first.body.id } })).toMatchObject({ newMaterial: true, isExtra: true, productionBatchId: batch.id, itemId: created[0]!.id, category: "OTHER" });

    // The same name again (any case) reuses the item: no duplicate, and it is no longer "new"
    const again = await ask({ newItem: { category: "OTHER", name: name.toUpperCase(), unit: "Nos" }, requestedQty: 5 });
    expect(again.status).toBe(201);
    expect(await prisma.inventoryItem.count({ where: { name: { equals: name, mode: "insensitive" } } })).toBe(1);
    expect(await prisma.inventoryRequest.findUnique({ where: { id: again.body.id } })).toMatchObject({ newMaterial: false, itemId: created[0]!.id });

    // An RM typed in works the same way
    const rm = await ask({ newItem: { category: "RM", name: `EXN Colour ${unique}`, unit: "Kg" } });
    expect(rm.status).toBe(201);
    expect(await prisma.inventoryItem.findFirst({ where: { name: `EXN Colour ${unique}` } })).toMatchObject({ category: "RM", unit: "Kg" });

    // The Store sees it flagged; it has none, so it asks the Warehouse, and the need goes to PPIC marked as a new material
    const mineList = async () => ((await request(app).get("/api/inventory/my-store/production-requests?pageSize=200").set(authHeader(dayStore))).body as { id: string; newMaterial: boolean; category: string; batchNo: string }[]);
    expect((await mineList()).find((r) => r.id === first.body.id)).toMatchObject({ newMaterial: true, category: "OTHER", batchNo: "EXB-1" });
    expect((await request(app).patch(`/api/inventory/requests/${first.body.id}/review`).set(authHeader(dayStore)).send({ action: "APPROVE" })).status).toBe(200);
    const toWarehouse = await request(app).post(`/api/inventory/my-store/production-requests/${first.body.id}/request-from-warehouse`).set(authHeader(dayStore));
    expect(toWarehouse.status).toBe(201);
    expect((await request(app).get("/api/inventory/material-requests").set(authHeader(warehouse))).status).toBe(200); // escalates by itself
    const requirement = await prisma.preInventoryRequirement.findFirst({ where: { sourceRequestId: toWarehouse.body.id } });
    expect(requirement).toMatchObject({ category: "OTHER", unit: "Nos" });
    expect(requirement!.note).toContain("new material");
  });
});
