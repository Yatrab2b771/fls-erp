import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

/** An order of 100 Kg sent to Production, its run started. */
async function setup() {
  const production = await createUser(["PRODUCTION"]);
  const ppic = await createUser(["PPIC"]);
  const bd = await createUser(["BD"]);
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const dayStore = await prisma.dayStore.create({ data: { name: `SF Store ${stamp}`, createdById: production.user.id } });
  const plant = await prisma.plant.create({ data: { name: `SF Plant ${stamp}`, createdById: production.user.id, dayStoreId: dayStore.id } });
  const customer = await request(app).post("/api/customers").set(authHeader(bd.token)).send({ companyName: `SF Customer ${stamp}` });
  const po = await request(app).post("/api/purchase-orders").set(authHeader(bd.token)).send({ customerId: customer.body.id, poNumber: `SF-PO-${stamp}`, items: [{ productName: "SF Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
  const itemId = po.body.items[0].id as string;
  await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved", planSentToProductionAt: new Date() } });
  const run = await request(app).post("/api/pre-productions").set(authHeader(production.token)).send({ purchaseOrderItemId: itemId, batchFlow: true, confirmNotReady: true });
  expect(run.status).toBe(201);
  const addBatch = (plannedQty: number, reason?: string) => request(app).post(`/api/pre-productions/${run.body.id}/production-batches`).set(authHeader(production.token)).send({ plannedQty, reason });
  const board = async () => ((await request(app).get("/api/pre-productions/plans-board").set(authHeader(production.token))).body as { itemId: string; releasedQty: number; run: { combinedQty: number }; batches: { plannedQty: number; status: string }[] }[]).find((r) => r.itemId === itemId)!;
  return { production, runId: run.body.id as string, itemId, addBatch, board };
}

describe("A batch for the shortfall", () => {
  it("needs a reason only when the earlier batches made less than planned; Production adds it itself and nobody is asked", async () => {
    const s = await setup();

    // The whole order is divided in one batch: that needs no reason
    const first = await s.addBatch(100);
    expect(first.status).toBe(201);
    // ...and nothing more can be planned: all of it is planned
    expect((await s.addBatch(10, "more")).status).toBe(400);

    // The batch is made: only 75 Kg came out (the rest went in waste, rejects and samples)
    await prisma.productionBatch.update({ where: { id: first.body.id }, data: { status: "COMPLETED", outputQty: 75, inputQty: 100, prepStageId: "READY" } });
    await prisma.preProduction.update({ where: { id: s.runId }, data: { combinedQty: 75 } });
    const row = await s.board();
    expect(row.run.combinedQty).toBe(75);
    expect(row.batches.map((b) => b.plannedQty)).toEqual([100]); // the plan still says 100: the screen works out the 25 that is missing

    // A batch for the missing 25: a reason is required, and it cannot be more than is missing
    const noReason = await s.addBatch(25);
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toContain("Write why");
    expect((await s.addBatch(30, "make up the loss")).status).toBe(400);
    const ok = await s.addBatch(25, "The first batch lost 25 Kg in waste, rejects and samples");
    expect(ok.status).toBe(201);
    expect(ok.body.plannedQty).toBe(25);

    // It is on record, and PPIC was not told
    const audit = await prisma.auditLog.findFirst({ where: { action: "production_batch.created_for_shortfall", entityId: ok.body.id } });
    expect(audit).not.toBeNull();
    const ppic = await prisma.notification.count({ where: { title: { contains: "SF Powder" }, recipient: { roles: { some: { role: { name: "PPIC" } } } } } });
    expect(ppic).toBe(0);

    // Everything is planned again
    expect((await s.addBatch(1, "one more")).status).toBe(400);
  });

  it("a normal batch (within what the order covers) never needs a reason", async () => {
    const s = await setup();
    expect((await s.addBatch(40)).status).toBe(201);
    expect((await s.addBatch(60)).status).toBe(201);
  });
});
