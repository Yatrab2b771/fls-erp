import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("A product's plan reaches its Plant's Store by itself", () => {
  it("needs a Plant before Generate; both plans calculated raise the requests; a recalculation does not duplicate them; the old button is gone", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token: rnd } = await createUser(["RND"]);
    const { token: ppic } = await createUser(["PPIC"]);
    const { user: dayStoreUser, token: dayStore } = await createUser(["STORE"]);

    const product = "Auto Request Whey";
    const customer = (await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "Auto Request Customer" })).body;
    await request(app).post("/api/rm-costing/recipes/import").set(authHeader(rnd)).send({ recipes: [{ name: product, customerId: customer.id, ingredients: [{ name: "AR Whey Isolate", brand: "TestBrand", gPerServing: 25, proteinPct: 0.9 }, { name: "AR Cocoa", brand: "TestBrand", gPerServing: 5, proteinPct: 0 }] }] });
    await request(app).post("/api/catalog/import").set(authHeader(rnd)).send({ customers: [{ customerName: "Auto Request Customer", skus: [{ productName: product, jar: "1kg HDPE Jar", scoopMl: "30ml" }] }] });
    const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: customer.id, poNumber: "PO-AUTO-REQ-1", items: [{ productName: product, productCategory: "Powder", quantity: 100, unit: "Kg", packSize: "1 kg" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bd)).send({ status: "APPROVED" });
    const itemId = po.body.items[0].id;

    // No Plant yet: no plan
    const noPlant = await request(app).post("/api/bom/plans").set(authHeader(ppic)).send({ name: "x", purchaseOrderItemId: itemId });
    expect(noPlant.status).toBe(400);
    expect(noPlant.body.code).toBe("PLANT_REQUIRED");
    expect((await request(app).post("/api/rm-costing/plans").set(authHeader(ppic)).send({ name: "x", purchaseOrderItemId: itemId })).status).toBe(400);

    // The Plant, with its own Day Store (and a user assigned to it)
    const store = await prisma.dayStore.create({ data: { name: `AR Store ${Date.now()}`, createdById: dayStoreUser.id } });
    const plant = await prisma.plant.create({ data: { name: `AR Plant ${Date.now()}`, createdById: dayStoreUser.id, dayStoreId: store.id } });
    await prisma.dayStoreAssignment.create({ data: { userId: dayStoreUser.id, dayStoreId: store.id } });
    expect((await request(app).patch(`/api/purchase-orders/${po.body.id}/items/${itemId}/planned-plant`).set(authHeader(ppic)).send({ plantId: plant.id })).status).toBe(200);

    const requestsOf = () => prisma.inventoryRequest.findMany({ where: { purchaseOrderItemId: itemId, deletedAt: null }, include: { item: true } });

    // One plan calculated is not enough: half a plan would raise half the materials
    const bom = await request(app).post("/api/bom/plans").set(authHeader(ppic)).send({ name: "AR BOM", purchaseOrderItemId: itemId });
    expect(bom.status).toBe(201);
    expect(bom.body.status).toBe("CALCULATED");
    expect(await requestsOf()).toHaveLength(0);

    const rm = await request(app).post("/api/rm-costing/plans").set(authHeader(ppic)).send({ name: "AR RM", purchaseOrderItemId: itemId });
    expect(rm.body.status).toBe("CALCULATED");
    const rows = await requestsOf();
    const expected = bom.body.result.lines.filter((l: { totalQty: number }) => l.totalQty > 0).length + rm.body.result.procurement.length;
    expect(rows).toHaveLength(expected);
    expect(rows.every((r) => r.purpose === "ISSUED_PRODUCTION" && r.status === "APPROVED" && r.plantId === plant.id && r.preProductionId === null)).toBe(true);
    const whey = rows.find((r) => r.item.name === "AR Whey Isolate");
    expect(whey?.requestedQty).toBeCloseTo((25 * 100 * 1000) / 30 / 1000, 3); // batch 100 Kg, 25 g of 30 g per serving

    // Recalculating changes nothing it should not
    expect((await request(app).post(`/api/rm-costing/plans/${rm.body.id}/calculate`).set(authHeader(ppic))).status).toBe(200);
    expect(await requestsOf()).toHaveLength(expected);

    // The Day Store of that Plant is told, and sees the requests
    const told = await prisma.notification.findMany({ where: { recipientId: dayStoreUser.id } });
    expect(told.some((n) => n.title.includes(product))).toBe(true);
    const seen = await request(app).get("/api/inventory/my-store/production-requests").set(authHeader(dayStore));
    expect(seen.status).toBe(200);
    expect((seen.body as { productName: string | null }[]).filter((r) => r.productName === product)).toHaveLength(expected);

    // The tile counts products: nothing is on the shelf yet, so the product is short, not covered
    const summary = (await request(app).get("/api/inventory/my-store/summary").set(authHeader(dayStore))).body;
    expect(summary.productsShort).toBe(1);
    expect(summary.productsCovered).toBe(0);

    // Material Received & GRN waits for the material to reach the Plant
    await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { regulatoryStatus: "Approved", planSentToProductionAt: new Date() } });
    const { token: production } = await createUser(["PRODUCTION"]);
    const run = await request(app).post("/api/pre-productions").set(authHeader(production)).send({ purchaseOrderItemId: itemId, confirmNotReady: true });
    expect(run.status).toBe(201);
    const stage = (token: string) => request(app).patch(`/api/pre-productions/${run.body.id}/stage`).set(authHeader(token)).send({ action: "FORWARD", grnNo: "GRN-1" });

    const before = await request(app).get(`/api/pre-productions/${run.body.id}/material-coverage`).set(authHeader(dayStore));
    expect(before.body.allCovered).toBe(false);
    expect(before.body.lines).toHaveLength(expected);
    // The Day Store's GRN tile lists the run (Production has no say in it)
    expect((await request(app).get("/api/pre-productions/store-board?stage=MATERIAL_RECEIVED").set(authHeader(production))).status).toBe(403);
    const grnRows = (await request(app).get("/api/pre-productions/store-board?stage=MATERIAL_RECEIVED").set(authHeader(dayStore))).body as { id: string; materials: unknown[]; allCovered: boolean }[];
    expect(grnRows.find((r) => r.id === run.body.id)?.materials).toHaveLength(expected);
    expect(grnRows.find((r) => r.id === run.body.id)?.allCovered).toBe(false);
    const blocked = await stage(dayStore);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("has not all reached the Store yet");

    // Material on the Day Store's own shelf counts as covered: stock it for one material and only the rest is missing
    const first = (await requestsOf())[0]!;
    await prisma.inventoryTransaction.create({ data: { itemId: first.itemId, type: "ISSUED_DAY_STORE", date: new Date(), unit: first.item.unit ?? "Kg", quantity: first.requestedQty, createdById: dayStoreUser.id, dayStoreId: store.id, deliveredAt: new Date() } });
    const partlyStocked = (await request(app).get(`/api/pre-productions/${run.body.id}/material-coverage`).set(authHeader(dayStore))).body;
    const firstLine = partlyStocked.lines.find((l: { material: string }) => l.material === first.item.name);
    expect(firstLine.covered).toBe(true);
    expect(firstLine.atDayStoreQty).toBeGreaterThan(0);
    expect(partlyStocked.allCovered).toBe(false);

    // The Day Store issues everything to the Plant (delivered)
    for (const r of await requestsOf()) {
      await prisma.inventoryTransaction.create({ data: { itemId: r.itemId, type: "ISSUED_PRODUCTION", date: new Date(), unit: r.item.unit ?? "Kg", quantity: r.requestedQty, createdById: dayStoreUser.id, fulfillsRequestId: r.id, deliveredAt: new Date() } });
    }
    expect((await request(app).get(`/api/pre-productions/${run.body.id}/material-coverage`).set(authHeader(dayStore))).body.allCovered).toBe(true);
    const moved = await stage(dayStore);
    expect(moved.status).toBe(200);
    expect(moved.body.currentStageId).toBe("INDENT_ISSUE");

    // Indent Issue is Production's tile and follows the plan: the same materials, nothing typed per material
    expect((await request(app).get("/api/pre-productions/indent-board").set(authHeader(dayStore))).status).toBe(403);
    const board = (await request(app).get("/api/pre-productions/indent-board").set(authHeader(production))).body as { id: string; materials: unknown[]; allCovered: boolean; grnNo: string | null }[];
    const onBoard = board.find((r) => r.id === run.body.id);
    expect(onBoard?.materials).toHaveLength(expected);
    expect(onBoard?.allCovered).toBe(true);
    expect(onBoard?.grnNo).toBe("GRN-1");
    // Production sees material only once it has been dispensed to it
    const materialRows = async () => ((await request(app).get("/api/pre-productions/material-board").set(authHeader(production))).body as { itemId: string; status: string; receivedQty: number }[]).filter((m) => m.itemId === itemId);
    const beforeDispense = await materialRows();
    expect(beforeDispense).toHaveLength(expected);
    expect(beforeDispense.every((m) => m.status === "NOT_DISPENSED" && m.receivedQty === 0)).toBe(true);
    const indent = await request(app)
      .patch(`/api/pre-productions/${run.body.id}/stage`)
      .set(authHeader(production))
      .send({ action: "FORWARD", prodIndentSlipSign: "IND-1", productionPlanDate: "2026-10-10", indentLines: [{ itemId: first.itemId, category: first.category, requestedQty: 5 }] });
    expect(indent.status).toBe(200);
    expect(indent.body.currentStageId).toBe("DISPENSING");
    expect(await requestsOf()).toHaveLength(expected); // no extra request lines were created
    expect((await request(app).get("/api/pre-productions/indent-board").set(authHeader(production))).body.some((r: { id: string }) => r.id === run.body.id)).toBe(false);

    const dispenseRows = (await request(app).get("/api/pre-productions/store-board?stage=DISPENSING").set(authHeader(dayStore))).body as { id: string; required: { itemId: string }[] }[];
    expect(dispenseRows.find((r) => r.id === run.body.id)?.required).toHaveLength(expected);
    // Dispensing hands the material over: what the Plant lacks is issued from its Day Store in the same step
    const required = ((await request(app).get(`/api/pre-productions/${run.body.id}/dispensing-requirements`).set(authHeader(dayStore))).body.items as { itemId: string; requiredQty: number; unit: string }[]);
    expect(required).toHaveLength(expected);
    const lines = required.map((r) => ({ itemId: r.itemId, quantity: r.requiredQty, unit: r.unit, purpose: "PRODUCTION" }));
    const dispense = () => request(app).patch(`/api/pre-productions/${run.body.id}/stage`).set(authHeader(dayStore)).send({ action: "FORWARD", consumption: lines });
    const stocked = new Set<string>();
    for (const r of required.slice(0, -1)) {
      await prisma.inventoryTransaction.create({ data: { itemId: r.itemId, type: "ISSUED_DAY_STORE", date: new Date(), unit: r.unit, quantity: r.requiredQty * 2, createdById: dayStoreUser.id, dayStoreId: store.id, deliveredAt: new Date() } });
      stocked.add(r.itemId);
    }
    const lacking = await dispense();
    expect(lacking.status).toBe(409);
    expect(lacking.body.error).toContain("Store");
    const last = required[required.length - 1]!;
    await prisma.inventoryTransaction.create({ data: { itemId: last.itemId, type: "ISSUED_DAY_STORE", date: new Date(), unit: last.unit, quantity: last.requiredQty * 2, createdById: dayStoreUser.id, dayStoreId: store.id, deliveredAt: new Date() } });
    const done = await dispense();
    expect(done.status).toBe(200);
    expect(done.body.currentStageId).toBe("SAMPLE_QC_APPROVAL");
    const afterDispense = await materialRows();
    expect(afterDispense.some((m) => m.status === "NOT_DISPENSED")).toBe(false);
    expect(afterDispense.some((m) => m.receivedQty > 0)).toBe(true);
    const issued = await prisma.inventoryTransaction.findMany({ where: { remark: "Issued to the Plant at Dispensing", plantId: plant.id } });
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.every((x) => x.dayStoreId === store.id)).toBe(true);
    const closed = await prisma.inventoryRequest.findMany({ where: { purchaseOrderItemId: itemId, preProductionId: null, deletedAt: null } });
    expect(closed.every((x) => x.status === "ISSUED" || x.status === "PARTIALLY_ISSUED" || x.status === "PENDING" || x.status === "APPROVED")).toBe(true);

    // "Send to Pre-Inventory" no longer exists
    expect((await request(app).post(`/api/bom/plans/${bom.body.id}/send-to-pre-inventory`).set(authHeader(ppic))).status).toBe(404);
    expect((await request(app).post(`/api/rm-costing/plans/${rm.body.id}/send-to-pre-inventory`).set(authHeader(ppic))).status).toBe(404);
  });
});
