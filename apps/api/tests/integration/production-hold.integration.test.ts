import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

const call = (token: string, method: "get" | "post" | "patch", path: string, body?: object) => {
  const r = request(app)[method](path).set(authHeader(token));
  return body ? r.send(body) : r;
};

/** An approved product PPIC has sent to Production. `withRun` also starts its run, with one batch at Indent Issue. */
async function setup(withRun: boolean, withBatch = withRun) {
  const production = await createUser(["PRODUCTION"]);
  const ppic = await createUser(["PPIC"]);
  const rnd = await createUser(["RND"]);
  const bd = await createUser(["BD"]);
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const dayStore = await prisma.dayStore.create({ data: { name: `PH Store ${stamp}`, createdById: production.user.id } });
  const plant = await prisma.plant.create({ data: { name: `PH Plant ${stamp}`, createdById: production.user.id, dayStoreId: dayStore.id } });
  const customer = await request(app).post("/api/customers").set(authHeader(bd.token)).send({ companyName: `PH Customer ${stamp}` });
  const po = await request(app).post("/api/purchase-orders").set(authHeader(bd.token)).send({ customerId: customer.body.id, poNumber: `PH-PO-${stamp}`, items: [{ productName: "PH Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
  const itemId = po.body.items[0].id as string;
  await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved", planSentToProductionAt: new Date() } });
  let runId: string | null = null;
  let batchId: string | null = null;
  if (withRun) {
    const run = await call(production.token, "post", "/api/pre-productions", { purchaseOrderItemId: itemId, batchFlow: true, confirmNotReady: true });
    expect(run.status).toBe(201);
    runId = run.body.id;
    if (withBatch) batchId = (await call(production.token, "post", `/api/pre-productions/${runId}/production-batches`, { plannedQty: 40 })).body.id;
  }
  const hold = (token: string, held: boolean, reason?: string) => call(token, "patch", `/api/production-batches/products/${itemId}/hold`, { held, reason });
  const planBoard = async () => ((await call(production.token, "get", "/api/pre-productions/plans-board")).body as { itemId: string }[]).map((r) => r.itemId);
  const heldList = async () => ((await call(production.token, "get", "/api/production-batches/held-products")).body as { itemId: string; productHeld: boolean; productionHeld: boolean; productionHoldReason: string | null; batches: unknown[] }[]).find((r) => r.itemId === itemId);
  const told = async (token: string) => ((await call(token, "get", "/api/notifications")).body.notifications as { title: string }[]).map((n) => n.title);
  return { production: production.token, ppic: ppic.token, rnd: rnd.token, itemId, poId: po.body.id as string, runId, batchId, hold, planBoard, heldList, told };
}

describe("Production's own Hold on a product", () => {
  it("moves the product from New Plan to Held Products, stops its batches, and Production releases it from there", async () => {
    const s = await setup(true);
    expect(await s.planBoard()).toContain(s.itemId);
    expect(await s.heldList()).toBeUndefined();

    // Only Production holds, and it needs a reason
    expect((await s.hold(s.ppic, true, "x")).status).toBe(403);
    expect((await s.hold(s.production, true)).status).toBe(400);
    expect((await s.hold(s.production, true, "Line is down for maintenance")).status).toBe(200);
    expect((await s.hold(s.production, true, "again")).status).toBe(409);

    // Off New Plan, onto Held Products with the reason; PPIC is told
    expect(await s.planBoard()).not.toContain(s.itemId);
    expect(await s.heldList()).toMatchObject({ productionHeld: true, productHeld: false, productionHoldReason: "Line is down for maintenance" });
    expect((await s.told(s.ppic)).some((t) => /Production put PH Powder .* on hold/.test(t))).toBe(true);

    // Its batch cannot move, and no new batch can be made
    const indent = await call(s.production, "post", `/api/production-batches/${s.batchId}/indent`, { prodIndentSlipSign: "PH Head", productionPlanDate: "2026-10-14" });
    expect(indent.status).toBe(409);
    expect(indent.body.error).toContain("Production has put this product on hold");
    const more = await call(s.production, "post", `/api/pre-productions/${s.runId}/production-batches`, { plannedQty: 10 });
    expect(more.status).toBe(409);
    // ...and it is not at the Indent Issue step
    const board = await call(s.production, "get", "/api/production-batches/prep-board?stage=INDENT_ISSUE");
    expect((board.body as { id: string }[]).map((b) => b.id)).not.toContain(s.batchId);

    // Release: back on New Plan, the batch moves again
    expect((await s.hold(s.production, false)).status).toBe(200);
    expect(await s.heldList()).toBeUndefined();
    expect(await s.planBoard()).toContain(s.itemId);
    const again = await call(s.production, "post", `/api/production-batches/${s.batchId}/indent`, { prodIndentSlipSign: "PH Head", productionPlanDate: "2026-10-14" });
    expect(again.status).toBe(200);
  });

  it("can hold a product whose run has not been started yet; it shows on Held Products", async () => {
    const s = await setup(false);
    expect((await s.hold(s.production, true, "Waiting for the customer")).status).toBe(200);
    expect(await s.planBoard()).not.toContain(s.itemId);
    expect(await s.heldList()).toMatchObject({ productionHeld: true, batches: [] });
    expect((await call(s.production, "post", "/api/pre-productions", { purchaseOrderItemId: s.itemId, batchFlow: true, confirmNotReady: true })).status).toBe(409);
    expect((await s.hold(s.production, false)).status).toBe(200);
    expect(await s.planBoard()).toContain(s.itemId);
  });

  it("cannot be held once a batch is in production", async () => {
    const s = await setup(true);
    await prisma.productionBatch.update({ where: { id: s.batchId! }, data: { prepStageId: "READY" } });
    const res = await s.hold(s.production, true, "too late");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already in production");
  });

  it("PPIC's hold and Production's hold are separate: releasing one leaves the other", async () => {
    const s = await setup(true);
    expect((await s.hold(s.production, true, "mine")).status).toBe(200);
    expect((await call(s.ppic, "patch", `/api/purchase-orders/${s.poId}/items/${s.itemId}/material-hold`, { held: true })).status).toBe(200);
    expect((await call(s.ppic, "patch", `/api/purchase-orders/${s.poId}/items/${s.itemId}/material-hold`, { held: false })).status).toBe(200);
    expect(await s.heldList()).toMatchObject({ productionHeld: true, productHeld: false });
  });
});

describe("Production's Cancel", () => {
  it("cancels the product for good, as PPIC's cancel does, and tells PPIC and BD", async () => {
    const s = await setup(true, false);
    const url = `/api/production-batches/products/${s.itemId}/cancel`;
    expect((await call(s.ppic, "post", url, { reason: "Customer withdrew" })).status).toBe(403);
    expect((await call(s.production, "post", url, {})).status).toBe(400);
    // A product Production holds can be cancelled too; the hold goes with it
    expect((await s.hold(s.production, true, "waiting")).status).toBe(200);
    const res = await call(s.production, "post", url, { reason: "Customer withdrew the order" });
    expect(res.status).toBe(200);

    const item = await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: s.itemId } });
    expect(item.cancelledAt).not.toBeNull();
    expect(item.cancelReason).toBe("By Production - Customer withdrew the order");
    expect(item.productionHeldAt).toBeNull();
    expect(await s.planBoard()).not.toContain(s.itemId);
    expect(await s.heldList()).toBeUndefined();
    expect((await s.told(s.ppic)).some((t) => /PH Powder cancelled by Production/.test(t))).toBe(true);
    expect((await call(s.production, "post", url, { reason: "again" })).status).toBe(409); // already cancelled
    // Nothing of it can move any more
    expect((await call(s.production, "post", "/api/pre-productions", { purchaseOrderItemId: s.itemId, batchFlow: true, confirmNotReady: true })).status).toBe(409);
  });

  it("is refused once a batch has been made", async () => {
    const s = await setup(true);
    const res = await call(s.production, "post", `/api/production-batches/products/${s.itemId}/cancel`, { reason: "Changed our mind" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("batch");
    expect((await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: s.itemId } })).cancelledAt).toBeNull();
  });
});
