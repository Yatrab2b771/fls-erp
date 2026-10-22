import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";
import { computePm, computeRm, resultsForSlot } from "../../src/modules/packaging-bom/bom-slots";

const app = createApp();

describe("Urgent production: R&D changes a product's plan to V1 while it is still with PPIC", () => {
  it("re-works both plans from the version, moves the product to PO Readiness and lets R&D send it to Production", async () => {
    const rnd = await createUser(["RND"]);
    const ppic = await createUser(["PPIC"]);
    const bd = await createUser(["BD"]);
    const stamp = Date.now();
    const call = (token: string, method: "get" | "post" | "put" | "delete", path: string, body?: object) => {
      const r = request(app)[method](path).set(authHeader(token));
      return body ? r.send(body) : r;
    };

    // The catalog: a recipe (Whey short at the Warehouse) and a packaging BOM; stock for the material V1 will use instead
    const dayStore = await prisma.dayStore.create({ data: { name: `BS Store ${stamp}`, createdById: rnd.user.id } });
    const plant = await prisma.plant.create({ data: { name: `BS Plant ${stamp}`, createdById: rnd.user.id, dayStoreId: dayStore.id } });
    const item = async (category: "RM" | "PM", name: string, unit: string, stock: number) => {
      const it = await prisma.inventoryItem.create({ data: { category, name: `${name} ${stamp}`, unit } });
      if (stock > 0) await prisma.inventoryTransaction.create({ data: { itemId: it.id, createdById: rnd.user.id, date: new Date(), unit, type: "RECEIVED", quantity: stock, vendorName: "V", receiptStatus: "ACCEPTED", acceptedById: rnd.user.id, acceptedAt: new Date() } });
      return it;
    };
    const whey = await item("RM", "BS Whey", "Kg", 0);
    const isolate = await item("RM", "BS Whey Isolate", "Kg", 500);
    const cocoa = await item("RM", "BS Cocoa", "Kg", 500);
    const tub = await item("PM", "BS Tub", "Count", 5000);

    const customer = (await call(bd.token, "post", "/api/customers", { companyName: `BS Customer ${stamp}` })).body as { id: string };
    const product = `BS Powder ${stamp}`;
    const recipe = await prisma.recipe.create({
      data: {
        name: product,
        customerId: customer.id,
        totalServing: 30,
        ingredients: { create: [{ name: whey.name, brand: "A", costPerKg: 0, gPerServing: 25, proteinPct: 0.8, sortOrder: 0 }, { name: cocoa.name, brand: "B", costPerKg: 0, gPerServing: 5, proteinPct: 0, sortOrder: 1 }] },
      },
    });
    const sku = await prisma.sku.create({ data: { customerId: customer.id, productName: product, packagingComponents: { create: [{ type: "Tub", quantity: 1, unit: "Nos", pmItemId: tub.id }] } } });

    // A PO product with both plans calculated from the Display BOM
    const po = await call(bd.token, "post", "/api/purchase-orders", { customerId: customer.id, poNumber: `BS-PO-${stamp}`, items: [{ productName: product, productCategory: "Powder", quantity: 100, unit: "KG" }] });
    const itemId = po.body.items[0].id as string;
    await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
    await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved" } });
    const displayView = (await call(rnd.token, "get", `/api/bom-slots?customerId=${customer.id}&productName=${encodeURIComponent(product)}`)).body;
    await prisma.rmPlan.create({
      data: { name: "BS rm", status: "CALCULATED", calculatedAt: new Date(), costingParams: {}, createdById: rnd.user.id, purchaseOrderItemId: itemId, resultSnapshot: computeRm(product, displayView.display.rm, 100) as never, items: { create: [{ recipeId: recipe.id, batchSizeKg: 100, addedById: rnd.user.id }] } },
    });
    await prisma.bomPlan.create({
      data: { name: "BS bom", status: "CALCULATED", calculatedAt: new Date(), createdById: rnd.user.id, purchaseOrderItemId: itemId, resultSnapshot: (await computePm(customer.id, product, displayView.display.pm, 100)) as never, items: { create: [{ skuId: sku.id, targetYield: 100, addedById: rnd.user.id }] } },
    });
    const planningOf = async () => ((await call(ppic.token, "get", "/api/ppic/material-planning")).body as { purchaseOrderItemId: string; material: string; status: string }[]).filter((r) => r.purchaseOrderItemId === itemId);

    // Short on the Display BOM: it waits in Material Planning
    expect((await planningOf()).find((r) => r.material === whey.name)).toMatchObject({ status: "SHORT" });
    expect((await call(rnd.token, "get", "/api/bom-slots/planning-summary")).body).toMatchObject({ short: 1, ready: 0, changedByRnd: 0 });
    // The short Whey has gone to Purchase by itself
    await call(ppic.token, "get", "/api/purchase-orders/reports/material-planning");
    const wheyRequest = () => prisma.preInventoryRequirement.findFirst({ where: { sourcePoItemId: itemId, itemId: whey.id } });
    expect((await wheyRequest())?.deletedAt ?? null).toBeNull();
    expect(await wheyRequest()).not.toBeNull();
    expect((await call(rnd.token, "post", `/api/purchase-orders/${po.body.id}/items/${itemId}/send-plan-to-production`, {})).status).toBe(403); // not before it is changed (and not PPIC's material gate either)

    // R&D's V1 uses whey isolate instead
    const v1 = await call(rnd.token, "put", "/api/bom-slots/V1", { customerId: customer.id, productName: product, rm: { ingredients: [{ name: isolate.name, brand: "C", gPerServing: 25, proteinPct: 90 }, { name: cocoa.name, brand: "B", gPerServing: 5 }] }, note: "Whey short" });
    expect(v1.status).toBe(200);

    // Only R&D switches; V2 is empty; a reason is needed
    const sw = (token: string, slot: string, reason = "Urgent: whey is short") => call(token, "post", "/api/bom-slots/switch", { purchaseOrderItemId: itemId, slot, reason });
    expect((await sw(ppic.token, "V1")).status).toBe(403);
    const empty = await sw(rnd.token, "V2");
    expect(empty.status).toBe(409);
    expect(empty.body.error).toMatch(/V2 is empty/);
    expect((await sw(rnd.token, "V1", "")).status).toBe(400);
    expect((await sw(rnd.token, "DISPLAY")).status).toBe(409); // already on it

    // The switch: both plans follow V1, nothing is short any more
    const done = await sw(rnd.token, "V1");
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ slot: "V1", ready: true, shortages: [] });
    const rm = await prisma.rmPlan.findFirstOrThrow({ where: { purchaseOrderItemId: itemId } });
    expect(JSON.stringify(rm.resultSnapshot)).toContain(isolate.name);
    expect(JSON.stringify(rm.resultSnapshot)).not.toContain(whey.name);
    expect((await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemId } })).activeBomSlot).toBe("V1");
    expect((await planningOf()).every((r) => r.status === "COVERED")).toBe(true);
    expect((await call(rnd.token, "get", "/api/bom-slots/planning-summary")).body).toMatchObject({ short: 0, ready: 1, changedByRnd: 1 });
    expect(await prisma.notification.count({ where: { title: { contains: "R&D changed the plan to V1" } } })).toBeGreaterThan(0); // PPIC is told
    expect((await wheyRequest())?.deletedAt).not.toBeNull(); // the plan no longer needs Whey: its request to Purchase is taken back
    const info = (await call(rnd.token, "get", `/api/bom-slots/item/${itemId}`)).body;
    expect(info).toMatchObject({ activeSlot: "V1", planSent: false, slots: { V1: { rm: true, pm: false }, V2: null } });
    expect(info.onOrder).toEqual([]); // nothing of it has a PI yet
    expect(info.switches[0]).toMatchObject({ fromSlot: "DISPLAY", toSlot: "V1", reason: "Urgent: whey is short", phase: "PLANNING" });

    // Back to the Display BOM makes it short again; the Display BOM itself was never touched
    expect((await sw(rnd.token, "DISPLAY", "Whey arrived")).body).toMatchObject({ ready: false });
    expect((await call(rnd.token, "get", `/api/bom-slots?customerId=${customer.id}&productName=${encodeURIComponent(product)}`)).body.display.rm.ingredients[0].name).toBe(whey.name);
    expect((await sw(rnd.token, "V1")).status).toBe(200);

    // R&D sends it to Production by itself (only the whole order)
    expect((await call(rnd.token, "post", `/api/purchase-orders/${po.body.id}/items/${itemId}/send-plan-to-production`, { quantity: 10 })).status).toBe(403);
    const sent = await call(rnd.token, "post", `/api/purchase-orders/${po.body.id}/items/${itemId}/send-plan-to-production`, {});
    expect(sent.status).toBe(200);
    expect((await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemId } })).planSentToProductionAt).not.toBeNull();

    // ---- With Production now: R&D changes the BOM of the batches without PPIC seeing anything
    const production = await createUser(["PRODUCTION"]);
    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemId, plantId: plant.id, plannedQty: 100, batchFlow: true, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
    const mkBatch = (batchNo: string, extra: object) => prisma.productionBatch.create({ data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: rnd.user.id } }, batchNo, plannedQty: 50, status: "IN_PROGRESS", ...extra } });
    const dispensed = await mkBatch("BS-1", { prepStageId: "READY", dispensedAt: new Date() });
    const waiting = await mkBatch("BS-2", { prepStageId: "DISPENSING" });
    const itemsOf = async () => {
      const list = (await call(production.token, "get", `/api/pre-productions/${run.id}/production-batches`)).body as { id: string; utilization: { items: { itemName: string }[] } }[];
      const names = (id: string) => list.find((b) => b.id === id)!.utilization.items.map((i) => i.itemName);
      return { dispensed: names(dispensed.id), waiting: names(waiting.id) };
    };
    expect((await itemsOf()).waiting).toContain(isolate.name); // both follow the plan PPIC sees (V1)
    // BS-1 was dispensed under that plan: the Day Store gave it exactly its share of every material
    const share = ((await call(production.token, "get", `/api/pre-productions/${run.id}/production-batches`)).body as { id: string; utilization: { items: { itemId: string; requiredQty: number; unit: string }[] } }[]).find((b) => b.id === dispensed.id)!.utilization.items;
    await prisma.batchDispensingLine.createMany({ data: share.map((i) => ({ productionBatchId: dispensed.id, itemId: i.itemId, quantity: i.requiredQty, plannedQty: i.requiredQty, unit: i.unit, createdById: rnd.user.id })) });

    expect((await call(ppic.token, "get", "/api/bom-slots/in-production")).status).toBe(403); // R&D's list
    const mine = (await call(rnd.token, "get", "/api/bom-slots/in-production")).body as { purchaseOrderItemId: string; activeBomSlot: string; batches: { notDispensed: number; inProduction: number } }[];
    expect(mine.find((r) => r.purchaseOrderItemId === itemId)).toMatchObject({ activeBomSlot: "V1", batches: { notDispensed: 1, inProduction: 1 } });

    const inProd = await sw(rnd.token, "DISPLAY", "Whey arrived in the Plant");
    expect(inProd.status).toBe(200);
    expect(inProd.body).toMatchObject({ phase: "PRODUCTION", slot: "DISPLAY" });
    expect(inProd.body.changes.map((c: { material: string }) => c.material).sort()).toEqual([isolate.name, whey.name].sort());
    expect(inProd.body.batches).toEqual([{ batchNo: "BS-1", dispensed: true }, { batchNo: "BS-2", dispensed: false }]);
    // The dispensed batch keeps its material; what the new version still needs for it (Whey) is asked from the Day Store as an extra request for the batch
    expect(inProd.body.extraRequests).toHaveLength(1);
    expect(inProd.body.extraRequests[0]).toMatchObject({ batchNo: "BS-1", material: whey.name, unit: "Kg" });
    expect(inProd.body.extraRequests[0].qty).toBeCloseTo(41.667, 2);
    const extra = () => prisma.inventoryRequest.findMany({ where: { productionBatchId: dispensed.id, isExtra: true, deletedAt: null } });
    expect(await extra()).toHaveLength(1);
    expect((await extra())[0]).toMatchObject({ itemId: whey.id, plantId: plant.id, extraForPoItemId: itemId, purpose: "ISSUED_PRODUCTION", status: "PENDING" });
    expect((await extra())[0]!.note).toMatch(/R&D changed the BOM to Display BOM.*Whey arrived in the Plant.*BS-1/);
    const after = await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(after).toMatchObject({ activeBomSlot: "V1", productionBomSlot: "DISPLAY" }); // PPIC's plan is untouched
    expect(JSON.stringify((await prisma.rmPlan.findFirstOrThrow({ where: { purchaseOrderItemId: itemId } })).resultSnapshot)).toContain(isolate.name);
    expect((await prisma.productionBatch.findUniqueOrThrow({ where: { id: dispensed.id } })).bomSlot).toBe("DISPLAY"); // the open dispensed batch follows the new version too
    expect((await prisma.productionBatch.findUniqueOrThrow({ where: { id: waiting.id } })).bomSlot).toBeNull();
    const names = await itemsOf();
    expect(names.dispensed).toContain(whey.name); // its Utilization now needs Whey
    expect(names.dispensed).not.toContain(isolate.name);
    expect(names.waiting).toContain(whey.name); // the batch not dispensed yet follows the new version
    expect(names.waiting).not.toContain(isolate.name);
    expect(await prisma.notification.count({ where: { recipientId: production.user.id, title: { contains: "R&D changed the BOM to" } } })).toBe(1);
    expect(await prisma.notification.count({ where: { recipientId: ppic.user.id, title: { contains: "changed the BOM" } } })).toBe(0); // PPIC is not told
    const seenByPpic = (await call(ppic.token, "get", `/api/bom-slots/item/${itemId}`)).body;
    expect(seenByPpic.switches.every((x: { phase: string }) => x.phase === "PLANNING")).toBe(true);
    expect(seenByPpic.activeSlot).toBe("V1"); // PPIC keeps seeing the plan it knows
    expect((await call(rnd.token, "get", `/api/bom-slots/item/${itemId}`)).body).toMatchObject({ activeSlot: "DISPLAY", phase: "PRODUCTION", locked: null });
    expect((await sw(rnd.token, "DISPLAY")).status).toBe(409); // already

    // The batch reports say which BOM version each batch was made from: Production sees R&D's choice and why, PPIC only the plan it knows
    type ReportRow = { batchId: string; bomVersion: string; bomVersionNote: string | null };
    const reportOf = async (token: string) => ((await call(token, "get", "/api/production-batches/report-board")).body as ReportRow[]).filter((r) => [dispensed.id, waiting.id].includes(r.batchId));
    const prodReport = await reportOf(production.token);
    expect(prodReport.map((r) => r.bomVersion)).toEqual(["Display BOM", "Display BOM"]);
    expect(prodReport[0]!.bomVersionNote).toBeNull(); // the Display BOM needs no explanation
    const ppicReport = await reportOf(ppic.token);
    expect(ppicReport.map((r) => r.bomVersion)).toEqual(["V1", "V1"]); // PPIC is not told about the Production-phase change
    expect(ppicReport[0]!.bomVersionNote).toMatch(/Urgent: whey is short/);
    expect(JSON.stringify(ppicReport)).not.toContain("Whey arrived in the Plant");
    const bmr = await request(app).get(`/api/production-batches/${waiting.id}/bmr-report.pdf`).set(authHeader(production.token));
    expect(bmr.status).toBe(200);

    // Back to the plan PPIC sees clears the choice
    expect((await sw(rnd.token, "V1", "Whey is gone again")).status).toBe(200);
    expect((await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemId } })).productionBomSlot).toBeNull();
    expect((await itemsOf()).waiting).toContain(isolate.name);
    expect(await extra()).toHaveLength(0); // the Store had not started on the Whey: it is withdrawn
    expect((await prisma.productionBatch.findUniqueOrThrow({ where: { id: dispensed.id } })).bomSlot).toBe("BASE");
    expect((await itemsOf()).dispensed).toContain(isolate.name);

    // Once every batch is past Bulk QC nothing is left to change
    await prisma.productionBatch.updateMany({ where: { preProductionId: run.id }, data: { status: "COMPLETED", currentStageId: "PACKAGING" } });
    const late = await sw(rnd.token, "DISPLAY");
    expect(late.status).toBe(409);
    expect(late.body.error).toMatch(/past Bulk QC/);
  });

  it("works for a plan with several recipes and SKUs: only this product's own is made from the version, the others stay as they are", async () => {
    const rnd = await createUser(["RND"]);
    const bd = await createUser(["BD"]);
    const stamp = Date.now();
    const call = (token: string, method: "get" | "post" | "put", path: string, body?: object) => {
      const r = request(app)[method](path).set(authHeader(token));
      return body ? r.send(body) : r;
    };
    const customer = (await call(bd.token, "post", "/api/customers", { companyName: `MS Customer ${stamp}` })).body as { id: string };
    const mine = `MS Powder ${stamp}`;
    const other = `MS Bar ${stamp}`;
    const recipeOf = (name: string, ingredients: { name: string; g: number }[]) =>
      prisma.recipe.create({ data: { name, customerId: customer.id, totalServing: ingredients.reduce((t, i) => t + i.g, 0), ingredients: { create: ingredients.map((i, n) => ({ name: i.name, brand: "A", costPerKg: 0, gPerServing: i.g, proteinPct: 0, sortOrder: n })) } } });
    const myRecipe = await recipeOf(mine, [{ name: `MS Whey ${stamp}`, g: 25 }, { name: `MS Cocoa ${stamp}`, g: 5 }]);
    const otherRecipe = await recipeOf(other, [{ name: `MS Oats ${stamp}`, g: 40 }]);
    const mySku = await prisma.sku.create({ data: { customerId: customer.id, productName: mine, packagingComponents: { create: [{ type: `MS Tub ${stamp}`, quantity: 1, unit: "Nos" }] } } });
    const otherSku = await prisma.sku.create({ data: { customerId: customer.id, productName: other, packagingComponents: { create: [{ type: `MS Wrapper ${stamp}`, quantity: 1, unit: "Nos" }] } } });

    const po = await call(bd.token, "post", "/api/purchase-orders", { customerId: customer.id, poNumber: `MS-PO-${stamp}`, items: [{ productName: mine, productCategory: "Powder", quantity: 100, unit: "KG" }] });
    const itemId = po.body.items[0].id as string;
    await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
    // One plan holding two recipes and two SKUs (this product's and another's)
    const rmPlan = await prisma.rmPlan.create({
      data: { name: "MS rm", status: "CALCULATED", calculatedAt: new Date(), costingParams: {}, createdById: rnd.user.id, purchaseOrderItemId: itemId, items: { create: [{ recipeId: myRecipe.id, batchSizeKg: 100, addedById: rnd.user.id }, { recipeId: otherRecipe.id, batchSizeKg: 40, addedById: rnd.user.id }] } },
    });
    const bomPlan = await prisma.bomPlan.create({
      data: { name: "MS bom", status: "CALCULATED", calculatedAt: new Date(), createdById: rnd.user.id, purchaseOrderItemId: itemId, items: { create: [{ skuId: mySku.id, targetYield: 100, addedById: rnd.user.id }, { skuId: otherSku.id, targetYield: 50, addedById: rnd.user.id }] } },
    });
    const base = await resultsForSlot(itemId, "DISPLAY");
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const names = (r: { procurement: { name: string }[] }) => r.procurement.map((l) => l.name).sort();
    expect(names(base.rm)).toEqual([`MS Cocoa ${stamp}`, `MS Oats ${stamp}`, `MS Whey ${stamp}`].sort());
    await prisma.rmPlan.update({ where: { id: rmPlan.id }, data: { resultSnapshot: base.rm as never } });
    await prisma.bomPlan.update({ where: { id: bomPlan.id }, data: { resultSnapshot: base.pm as never } });

    // V1 swaps the Whey; the other recipe (Oats) and the other SKU's wrapper stay in the plan
    const v1 = await call(rnd.token, "put", "/api/bom-slots/V1", { customerId: customer.id, productName: mine, rm: { ingredients: [{ name: `MS Isolate ${stamp}`, brand: "C", gPerServing: 25 }, { name: `MS Cocoa ${stamp}`, brand: "B", gPerServing: 5 }] } });
    expect(v1.status).toBe(200);
    const done = await call(rnd.token, "post", "/api/bom-slots/switch", { purchaseOrderItemId: itemId, slot: "V1", reason: "Whey is short" });
    expect(done.status).toBe(200);
    const after = await prisma.rmPlan.findUniqueOrThrow({ where: { id: rmPlan.id } });
    expect(names(after.resultSnapshot as unknown as { procurement: { name: string }[] })).toEqual([`MS Cocoa ${stamp}`, `MS Isolate ${stamp}`, `MS Oats ${stamp}`].sort());
    const pm = (await prisma.bomPlan.findUniqueOrThrow({ where: { id: bomPlan.id } })).resultSnapshot as unknown as { lines: { component: string; itemName?: string }[] };
    expect(JSON.stringify(pm)).toContain(`MS Wrapper ${stamp}`); // the other SKU is still planned
    expect(JSON.stringify(pm)).toContain(`MS Tub ${stamp}`); // this product's PM comes from Display (V1 has no PM half)
  });
});
