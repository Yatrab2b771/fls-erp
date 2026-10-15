import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser, BATCH_START } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";
import { getMaterialPlanning } from "../../src/modules/purchase-orders/material-planning";

const app = createApp();

// A 100 Kg order, Regulatory approved, Plant planned and a plan calculated - ready for PPIC to release.
async function setup() {
  const { token: ppic, user: ppicUser } = await createUser(["PPIC"]);
  const { token: production } = await createUser(["PRODUCTION"]);
  const { token: bd } = await createUser(["BD"]);
  const store = await prisma.dayStore.create({ data: { name: "PR Store", createdById: ppicUser.id } });
  const plant = await prisma.plant.create({ data: { name: "PR Store", createdById: ppicUser.id, dayStoreId: store.id } });
  const customer = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "PR Customer" });
  const po = await request(app)
    .post("/api/purchase-orders")
    .set(authHeader(bd))
    .send({ customerId: customer.body.id, poNumber: "PR-PO-1", items: [{ productName: "PR Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
  const itemId = po.body.items[0].id as string;
  await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } }); // PPIC / Production only see approved POs
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved" } });
  await prisma.bomPlan.create({ data: { name: "PR plan", status: "CALCULATED", calculatedAt: new Date(), createdById: ppicUser.id, purchaseOrderItemId: itemId } });
  await prisma.rmPlan.create({ data: { name: "PR rm plan", status: "CALCULATED", calculatedAt: new Date(), costingParams: {}, createdById: ppicUser.id, purchaseOrderItemId: itemId } });
  return { ppic, production, poId: po.body.id as string, itemId, plant };
}

describe("Partial release of a plan to Production", () => {
  it("PPIC can release part of the order, any quantity, and keep releasing until the whole order is out", async () => {
    const { ppic, poId, itemId } = await setup();
    const send = (body?: Record<string, unknown>) => request(app).post(`/api/purchase-orders/${poId}/items/${itemId}/send-plan-to-production`).set(authHeader(ppic)).send(body ?? {});

    expect((await send({ quantity: 0 })).status).toBe(400);
    expect((await send({ quantity: 150 })).status).toBe(400); // more than the order

    const first = await send({ quantity: 20 });
    expect(first.status).toBe(200);
    expect(first.body.releasedQty).toBe(20);
    expect(first.body.planSentToProductionAt).toBeTruthy();

    // Any quantity works, not just the first one - and it adds up
    expect((await send({ quantity: 50 })).body.releasedQty).toBe(70);
    expect((await send({ quantity: 40 })).status).toBe(400); // only 30 left

    const info = await request(app).get(`/api/purchase-orders/${poId}/items/${itemId}/release-info`).set(authHeader(ppic));
    expect(info.body).toMatchObject({ orderQty: 100, releasedQty: 70, remainingQty: 30 });

    // No quantity = release everything that is left; then it is fully out
    const rest = await send();
    expect(rest.status).toBe(200);
    expect(rest.body.releasedQty).toBeNull();
    expect((await send({ quantity: 1 })).status).toBe(409);
  });

  it("Production can only plan batches up to what has been released, and more opens up with the next release", async () => {
    const { ppic, production, poId, itemId, plant } = await setup();
    await request(app).post(`/api/purchase-orders/${poId}/items/${itemId}/send-plan-to-production`).set(authHeader(ppic)).send({ quantity: 20 });

    // The New Plan list shows how much has been released
    const plans = await request(app).get("/api/pre-productions/new-plans").set(authHeader(production));
    const row = plans.body.find((r: { itemId: string }) => r.itemId === itemId);
    expect(row).toMatchObject({ quantity: 100, releasedQty: 20 });

    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemId, plannedQty: 100, plantId: plant.id, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
    const addBatch = (plannedQty: number) => request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(production)).send({ ...BATCH_START, plannedQty });

    const tooMuch = await addBatch(30);
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toMatch(/released 20 of 100/);
    expect((await addBatch(20)).status).toBe(201);
    expect((await addBatch(1)).status).toBe(400); // the released 20 is fully planned

    // PPIC releases 30 more -> 30 more can be planned
    await request(app).post(`/api/purchase-orders/${poId}/items/${itemId}/send-plan-to-production`).set(authHeader(ppic)).send({ quantity: 30 });
    expect((await addBatch(30)).status).toBe(201);
    expect((await addBatch(1)).status).toBe(400);
  });

  it("Production's plan view can be scaled to the released part", async () => {
    const { ppic, production, poId, itemId } = await setup();
    await request(app).post(`/api/purchase-orders/${poId}/items/${itemId}/send-plan-to-production`).set(authHeader(ppic)).send({ quantity: 25 });
    const view = await request(app).get(`/api/purchase-orders/${poId}/items/${itemId}/plan?released=1`).set(authHeader(production));
    expect(view.status).toBe(200);
    expect(view.body.release).toMatchObject({ orderQty: 100, releasedQty: 25 });
  });

  it("a partly released product stays in Material Planning / PO Readiness until the whole order is released", async () => {
    const { ppic, poId, itemId, plant } = await setup();
    const send = (body?: Record<string, unknown>) => request(app).post(`/api/purchase-orders/${poId}/items/${itemId}/send-plan-to-production`).set(authHeader(ppic)).send(body ?? {});
    const inList = async () => (await getMaterialPlanning()).products.find((p) => p.purchaseOrderItemId === itemId);

    expect((await inList())?.state).toBe("ACTIVE");
    await send({ quantity: 20 });
    // Part released, and Production even starts the run - it is still in the lists, marked as partly released
    await prisma.preProduction.create({ data: { purchaseOrderItemId: itemId, plannedQty: 100, plantId: plant.id } });
    expect(await inList()).toMatchObject({ state: "ACTIVE", releasedQty: 20 });

    await send(); // the rest
    expect((await inList())?.state).not.toBe("ACTIVE"); // fully released: it leaves (shows as sent / in production)
  });
});
