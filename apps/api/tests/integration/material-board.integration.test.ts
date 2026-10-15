import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("Production's Material Received board", () => {
  it("shows, per product and material, what was required, received, in transit, still to come, used and left", async () => {
    const { token: prod, user } = await createUser(["PRODUCTION"]);
    const { token: bd } = await createUser(["BD"]);
    const store = await prisma.dayStore.create({ data: { name: "MB Store", createdById: user.id } });
    const plant = await prisma.plant.create({ data: { name: "MB Store", createdById: user.id, dayStoreId: store.id } });
    const customer = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "MB Customer" });
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bd))
      .send({ customerId: customer.body.id, poNumber: "MB-PO-1", items: [{ productName: "MB Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
    await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
    const itemId = po.body.items[0].id as string;
    await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved", planSentToProductionAt: new Date() } });

    // The PPIC plan: 100 Kg of MB Flour (RM) and 50 of MB Jar (PM)
    const recipe = await prisma.recipe.create({ data: { name: "MB Powder", totalServing: 30 } });
    const sku = await prisma.sku.create({ data: { customerId: customer.body.id, productName: "MB Powder" } });
    const rmPlan = await prisma.rmPlan.create({
      data: { name: "MB rm", status: "CALCULATED", calculatedAt: new Date(), costingParams: {}, createdById: user.id, purchaseOrderItemId: itemId, resultSnapshot: { batches: [], procurement: [{ name: "MB Flour", sources: { "MB Powder": 100 } }] } },
    });
    await prisma.rmPlanItem.create({ data: { planId: rmPlan.id, recipeId: recipe.id, batchSizeKg: 100, addedById: user.id } });
    const bomPlan = await prisma.bomPlan.create({
      data: { name: "MB bom", status: "CALCULATED", calculatedAt: new Date(), createdById: user.id, purchaseOrderItemId: itemId, resultSnapshot: { totalYield: 1, brands: [], lines: [{ category: "Jar", component: "MB Jar", spec: "", baseQty: 50, wastageRate: 0, bufferQty: 0, totalQty: 50, sources: { "MB Customer (MB Powder)": 50 } }] } },
    });
    await prisma.bomPlanItem.create({ data: { planId: bomPlan.id, skuId: sku.id, targetYield: 1, addedById: user.id } });

    const flour = await prisma.inventoryItem.create({ data: { name: "MB Flour", category: "RM", unit: "Kg" } });
    await prisma.inventoryItem.create({ data: { name: "MB Jar", category: "PM", unit: "Nos" } });

    // The Day Store issued 60 Kg to the Plant (received) and 10 more that is still on the way
    const req = await prisma.inventoryRequest.create({ data: { itemId: flour.id, category: "RM", requestedQty: 100, purpose: "ISSUED_PRODUCTION", requestedById: user.id, plantId: plant.id, purchaseOrderItemId: itemId } });
    const issue = (quantity: number, delivered: boolean) =>
      prisma.inventoryTransaction.create({
        data: { itemId: flour.id, type: "ISSUED_PRODUCTION", date: new Date(), unit: "Kg", quantity, plantId: plant.id, dayStoreId: store.id, createdById: user.id, fulfillsRequestId: req.id, ...(delivered ? { deliveredAt: new Date(), deliveredById: user.id } : {}) },
      });
    await issue(60, true);
    await issue(10, false);

    // The run has used 20 Kg and 5 Kg went back to the store
    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemId, plannedQty: 100, plantId: plant.id } });
    await prisma.batchMaterialConsumption.create({ data: { preProductionId: run.id, itemId: flour.id, quantity: 20, unit: "Kg", purpose: "PRODUCTION", createdById: user.id } });
    await prisma.stockTransfer.create({
      data: { itemId: flour.id, quantity: 5, unit: "Kg", sourceType: "PLANT", sourcePlantId: plant.id, destinationType: "DAY_STORE", destDayStoreId: store.id, preProductionId: run.id, sentById: user.id },
    });

    // Production sees material only once it has been dispensed to it: before that, nothing
    const early = (await request(app).get("/api/pre-productions/material-board").set(authHeader(prod))).body as Record<string, unknown>[];
    expect(early.find((r) => r.material === "MB Flour")).toMatchObject({ receivedQty: 0, inTransitQty: 0, status: "NOT_DISPENSED" });

    // Dispensing is done: now what reached the Plant shows
    await prisma.preProduction.update({ where: { id: run.id }, data: { currentStageId: "SAMPLE_QC_APPROVAL" } });
    const rows = (await request(app).get("/api/pre-productions/material-board").set(authHeader(prod))).body as Record<string, unknown>[];
    const rm = rows.find((r) => r.material === "MB Flour")!;
    expect(rm).toMatchObject({ category: "RM", requiredQty: 100, receivedQty: 60, inTransitQty: 10, balanceQty: 30, usedQty: 15, leftQty: 45, status: "PARTIAL", poNumber: "MB-PO-1" });
    const pm = rows.find((r) => r.material === "MB Jar")!;
    expect(pm).toMatchObject({ category: "PM", requiredQty: 50, receivedQty: 0, balanceQty: 50, status: "NOT_RECEIVED" });
  });
});
