import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser, ensurePlant } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

/** Creates a customer + PO (DRAFT), approves it as BD, and returns its one line item's id. */
async function createApprovedPoItem(bdToken: string) {
  const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });
  const po = await request(app)
    .post("/api/purchase-orders")
    .set(authHeader(bdToken))
    .send({ customerId: customer.body.id, items: [{ productName: "Medicine A", productCategory: "Powder", quantity: 100, unit: "KG" }] });
  await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
  return po.body.items[0].id as string;
}

// Closing the gap the user described: a product needs several RM/PM
// items, but logging just one of them used to be enough to forward past
// Dispensing anyway. The run's linked, calculated RmPlan/BomPlan (the
// "Generate" flow — see po-generate.integration.test.ts) is the source
// of truth for what's actually required.
describe("Dispensing requires the run's full linked recipe/BOM, not just one item", () => {
  it("GET dispensing-requirements is empty when no plan is linked — no gate, existing behavior unchanged", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const itemId = await createApprovedPoItem(bdToken);
    await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { planSentToProductionAt: new Date() } }); // PPIC has sent the plan to Production
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId, confirmNotReady: true });

    const reqs = await request(app).get(`/api/pre-productions/${run.body.id}/dispensing-requirements`).set(authHeader(ppicToken));
    expect(reqs.status).toBe(200);
    expect(reqs.body.items).toEqual([]);
  });

  it("blocks the stage advance (but still saves) when only some required items are logged; advances once the rest are topped up", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: bdToken } = await createUser(["BD"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: adminToken } = await createUser(["ADMIN"]); // run steps belong to the plant's Day Store; ADMIN may step in
    const { token: qaToken } = await createUser(["QA_QC"]);

    const { token: rndToken } = await createUser(["RND"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Dispensing Gate Customer" });
    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({ recipes: [{ name: "Dispensing Gate Product", customerId: customer.body.id, ingredients: [{ name: "Gate Test Protein", brand: "TestBrand", costPerKg: 300, gPerServing: 10, proteinPct: 0.5 }] }] });
    await request(app)
      .post("/api/catalog/import")
      .set(authHeader(rndToken))
      .send({ customers: [{ customerName: "Dispensing Gate Customer", skus: [{ productName: "Dispensing Gate Product", jar: "1kg HDPE Jar", scoopMl: "30ml" }] }] });

    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.body.id, poNumber: "PO-DISP-GATE-1", items: [{ productName: "Dispensing Gate Product", productCategory: "Powder", quantity: 10, unit: "Kg", packSize: "1 kg" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    const itemId = po.body.items[0].id;

    await ensurePlant(itemId);
    const bomPlan = await request(app).post("/api/bom/plans").set(authHeader(bdToken)).send({ name: "Dispensing Gate — BOM", purchaseOrderItemId: itemId });
    expect(bomPlan.body.status).toBe("CALCULATED");
    await ensurePlant(itemId);
    const rmPlan = await request(app).post("/api/rm-costing/plans").set(authHeader(bdToken)).send({ name: "Dispensing Gate — RM", purchaseOrderItemId: itemId });
    expect(rmPlan.body.status).toBe("CALCULATED");

    await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { planSentToProductionAt: new Date() } }); // PPIC has sent the plan to Production
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId, confirmNotReady: true });
    const runId = run.body.id;

    // Walk to Dispensing.
    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(adminToken)).send({ action: "FORWARD" }); // MATERIAL_RECEIVED -> INDENT_ISSUE
    const atDispensing = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(productionToken)).send({ action: "FORWARD" }); // INDENT_ISSUE (Production) -> DISPENSING
    expect(atDispensing.body.currentStageId).toBe("DISPENSING");

    // The run's Plant has its own Day Store (Dispensing hands the Day Store's material over to Production)
    const adminUser = await prisma.user.findFirstOrThrow({ select: { id: true } });
    const dayStore = await prisma.dayStore.create({ data: { name: `Dispensing Gate Store ${Date.now()}`, createdById: adminUser.id } });
    const plant = { body: await prisma.plant.create({ data: { name: `Dispensing Gate Plant ${Date.now()}`, createdById: adminUser.id, dayStoreId: dayStore.id } }) };
    await request(app).patch(`/api/pre-productions/${runId}/plant`).set(authHeader(ppicToken)).send({ plantId: plant.body.id });

    // The linked plans resolve into at least one RM ingredient and one PM
    // component — a real "many items needed" case, matching the report.
    const reqs = await request(app).get(`/api/pre-productions/${runId}/dispensing-requirements`).set(authHeader(storeToken));
    expect(reqs.status).toBe(200);
    expect(reqs.body.items.length).toBeGreaterThanOrEqual(2);
    for (const it of reqs.body.items) expect(it.covered).toBe(false);

    // Stock every required item at the Day Store; Dispensing issues to the Plant what the Plant lacks, in the same step.
    for (const it of reqs.body.items) {
      await prisma.inventoryTransaction.create({ data: { itemId: it.itemId, type: "ISSUED_DAY_STORE", date: new Date(), unit: it.unit, quantity: it.requiredQty, createdById: adminUser.id, dayStoreId: dayStore.id, deliveredAt: new Date() } });
    }

    // Forward with only the FIRST required item logged — exactly the
    // user's complaint scenario ("sirf ek item hi issue hua").
    const [first, ...rest] = reqs.body.items as { itemId: string; itemName: string; category: string; unit: string; requiredQty: number }[];
    const partial = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(adminToken))
      .send({ action: "FORWARD", consumption: [{ itemId: first!.itemId, quantity: first!.requiredQty, unit: first!.unit }] });
    expect(partial.status).toBe(200);
    expect(partial.body.currentStageId).toBe("DISPENSING"); // did NOT advance
    expect(partial.body.consumptions).toHaveLength(1); // but the logged line wasn't discarded
    expect(partial.body.dispensingShortfall).toHaveLength(rest.length);
    expect(partial.body.dispensingShortfall.every((s: { covered: boolean }) => s.covered === false)).toBe(true);

    // Top up the rest in a follow-up save — now it actually advances, on to
    // Sample QC Approval, this run's own terminal stage.
    const complete = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(adminToken))
      .send({ action: "FORWARD", consumption: rest.map((it) => ({ itemId: it.itemId, quantity: it.requiredQty, unit: it.unit })) });
    expect(complete.status).toBe(200);
    expect(complete.body.currentStageId).toBe("SAMPLE_QC_APPROVAL");
    expect(complete.body.dispensingShortfall).toBeUndefined();
    expect(complete.body.consumptions).toHaveLength(reqs.body.items.length);

    const sampleQcApproval = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", sampleQcStatus: "Approved" });
    expect(sampleQcApproval.status).toBe(200);
    expect(sampleQcApproval.body.currentStageId).toBe("SAMPLE_QC_APPROVAL"); // completes in place — Production takes over from here (Tier 2)

    const finalCheck = await request(app).get(`/api/pre-productions/${runId}/dispensing-requirements`).set(authHeader(storeToken));
    expect(finalCheck.body.items.every((i: { covered: boolean }) => i.covered)).toBe(true);
  });

  // PreProduction is 1:1 with a PO item now — plannedQty is always the
  // item's own full ordered quantity, so the required-quantity scale is
  // always 1:1 against the order, not split down per run the way the old
  // per-Batch version of this had to be.
  it("plannedQty is always the item's full ordered quantity, so the required quantity is never scaled down", async () => {
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: bdToken } = await createUser(["BD"]);
    const { token: storeToken } = await createUser(["STORE"]);

    const { token: rndToken } = await createUser(["RND"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Full Qty Customer" });
    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({ recipes: [{ name: "Full Qty Product", customerId: customer.body.id, ingredients: [{ name: "Full Qty Protein", brand: "TestBrand", costPerKg: 300, gPerServing: 10, proteinPct: 0.5 }] }] });
    await request(app)
      .post("/api/catalog/import")
      .set(authHeader(rndToken))
      .send({ customers: [{ customerName: "Full Qty Customer", skus: [{ productName: "Full Qty Product", jar: "1kg HDPE Jar" }] }] });

    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.body.id, poNumber: "PO-FULL-QTY-1", items: [{ productName: "Full Qty Product", productCategory: "Powder", quantity: 100, unit: "Kg", packSize: "1 kg" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    const itemId = po.body.items[0].id;

    await ensurePlant(itemId);
    const rmPlan = await request(app).post("/api/rm-costing/plans").set(authHeader(bdToken)).send({ name: "Full Qty — RM", purchaseOrderItemId: itemId });
    expect(rmPlan.body.status).toBe("CALCULATED");
    const fullRequiredKg = rmPlan.body.result.procurement[0].totalKg as number;

    await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { planSentToProductionAt: new Date() } }); // PPIC has sent the plan to Production
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId, confirmNotReady: true });
    expect(run.body.plannedQty).toBe(100);

    const reqs = await request(app).get(`/api/pre-productions/${run.body.id}/dispensing-requirements`).set(authHeader(storeToken));
    expect(reqs.body.items[0].requiredQty).toBeCloseTo(fullRequiredKg, 5);
  });
});
