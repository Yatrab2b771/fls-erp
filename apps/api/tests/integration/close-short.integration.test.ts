import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();
const call = (token: string, method: "get" | "post", path: string, body?: object) => {
  const r = request(app)[method](path).set(authHeader(token));
  return body ? r.send(body) : r;
};

/** An order of 100 Kg sent to Production, with one batch of 100 made. */
async function setup(output: number) {
  const production = await createUser(["PRODUCTION"]);
  const ppic = await createUser(["PPIC"]);
  const bd = await createUser(["BD"]);
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const dayStore = await prisma.dayStore.create({ data: { name: `CS Store ${stamp}`, createdById: production.user.id } });
  const plant = await prisma.plant.create({ data: { name: `CS Plant ${stamp}`, createdById: production.user.id, dayStoreId: dayStore.id } });
  const customer = await call(bd.token, "post", "/api/customers", { companyName: `CS Customer ${stamp}` });
  const po = await call(bd.token, "post", "/api/purchase-orders", { customerId: customer.body.id, poNumber: `CS-PO-${stamp}`, items: [{ productName: "CS Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
  const itemId = po.body.items[0].id as string;
  await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved", planSentToProductionAt: new Date() } });
  const run = await call(production.token, "post", "/api/pre-productions", { purchaseOrderItemId: itemId, batchFlow: true, confirmNotReady: true });
  expect(run.status).toBe(201);
  const batch = await call(production.token, "post", `/api/pre-productions/${run.body.id}/production-batches`, { plannedQty: 100 });
  expect(batch.status).toBe(201);
  const finish = async () => {
    await prisma.productionBatch.update({ where: { id: batch.body.id }, data: { status: "COMPLETED", outputQty: output, inputQty: 100, prepStageId: "READY" } });
    await prisma.preProduction.update({ where: { id: run.body.id }, data: { combinedQty: output } });
  };
  const close = (token: string, reason = "Customer agreed to the lower quantity") => call(token, "post", `/api/production-batches/products/${itemId}/close-short`, { reason });
  const completion = async () => {
    const res = await call(bd.token, "get", `/api/purchase-orders/${po.body.id}`);
    return { item: res.body.items[0].dispatch.isCompleted as boolean, po: res.body.completion.isCompleted as boolean };
  };
  return { production, ppic, bd, itemId, runId: run.body.id as string, batchId: batch.body.id as string, finish, close, completion };
}

describe("Close short", () => {
  it("ends a product at what was made: the order completes once that is dispatched, and BD (not PPIC) is told", async () => {
    const s = await setup(75);

    // A batch still in progress: not yet
    expect((await s.close(s.production.token)).status).toBe(409);
    await s.finish();

    // Only Production, with a reason
    expect((await s.close(s.ppic.token)).status).toBe(403);
    expect((await call(s.production.token, "post", `/api/production-batches/products/${s.itemId}/close-short`, {})).status).toBe(400);
    const res = await s.close(s.production.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ madeQty: 75, orderedQty: 100 });
    const item = await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: s.itemId } });
    expect(item).toMatchObject({ closedShortQty: 75, closedShortReason: "Customer agreed to the lower quantity" });
    expect((await s.close(s.production.token)).status).toBe(409); // already closed

    // BD is told; PPIC is not
    const titles = async (token: string) => ((await call(token, "get", "/api/notifications")).body.notifications as { title: string }[]).map((n) => n.title);
    expect((await titles(s.bd.token)).some((t) => /CS Powder closed short at 75/.test(t))).toBe(true);
    expect((await titles(s.ppic.token)).some((t) => /CS Powder/.test(t))).toBe(false);

    // Not complete until the 75 has been sent; then the product and the PO are
    expect(await s.completion()).toEqual({ item: false, po: false });
    await prisma.productionBatch.update({ where: { id: s.batchId }, data: { currentStageId: "DISPATCH_PLAN", dispatchedQty: 75 } });
    expect(await s.completion()).toEqual({ item: true, po: true });

    // No more batches for a product that was closed short
    const more = await call(s.production.token, "post", `/api/pre-productions/${s.runId}/production-batches`, { plannedQty: 10, reason: "x" });
    expect(more.status).toBe(409);
    expect(more.body.error).toContain("closed short");
  });

  it("can be taken back: the full quantity is ordered again", async () => {
    const s = await setup(75);
    await s.finish();
    expect((await s.close(s.production.token)).status).toBe(200);
    await prisma.productionBatch.update({ where: { id: s.batchId }, data: { currentStageId: "DISPATCH_PLAN", dispatchedQty: 75 } });
    expect((await s.completion()).item).toBe(true);

    const url = `/api/production-batches/products/${s.itemId}/reopen-short`;
    expect((await call(s.ppic.token, "post", url)).status).toBe(403);
    expect((await call(s.production.token, "post", url)).status).toBe(200);
    expect((await call(s.production.token, "post", url)).status).toBe(409); // not closed any more
    expect((await s.completion()).item).toBe(false); // 75 of 100 again
    // ...and the missing 25 can be made again
    expect((await call(s.production.token, "post", `/api/pre-productions/${s.runId}/production-batches`, { plannedQty: 25, reason: "make up the loss" })).status).toBe(201);
  });

  it("is refused when nothing is short or nothing was made", async () => {
    const full = await setup(100);
    await full.finish();
    const res = await full.close(full.production.token);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Nothing is short");

    const none = await setup(0);
    await prisma.productionBatch.update({ where: { id: none.batchId }, data: { status: "COMPLETED", outputQty: 0 } });
    expect((await none.close(none.production.token)).status).toBe(409);
  });
});
