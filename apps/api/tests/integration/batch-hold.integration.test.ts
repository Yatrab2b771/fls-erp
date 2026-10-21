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

/** An approved product sent to Production, with a run in the per-batch flow and two batches at Indent Issue. */
async function setup() {
  const production = await createUser(["PRODUCTION"]);
  const ppic = await createUser(["PPIC"]);
  const rnd = await createUser(["RND"]);
  const qa = await createUser(["QA_QC"]);
  const bd = await createUser(["BD"]);
  const stamp = Date.now();
  const dayStore = await prisma.dayStore.create({ data: { name: `BH Store ${stamp}`, createdById: production.user.id } });
  const plant = await prisma.plant.create({ data: { name: `BH Plant ${stamp}`, createdById: production.user.id, dayStoreId: dayStore.id } });
  const customer = await request(app).post("/api/customers").set(authHeader(bd.token)).send({ companyName: `BH Customer ${stamp}` });
  const po = await request(app).post("/api/purchase-orders").set(authHeader(bd.token)).send({ customerId: customer.body.id, poNumber: `BH-PO-${stamp}`, items: [{ productName: "BH Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
  const itemId = po.body.items[0].id as string;
  await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved", planSentToProductionAt: new Date() } });
  const run = await call(production.token, "post", "/api/pre-productions", { purchaseOrderItemId: itemId, batchFlow: true, confirmNotReady: true });
  expect(run.status).toBe(201);
  const batch = async (qty: number) => (await call(production.token, "post", `/api/pre-productions/${run.body.id}/production-batches`, { plannedQty: qty })).body as { id: string };
  const b1 = await batch(30);
  const b2 = await batch(30);
  const b3 = await batch(30);
  const hold = (held: boolean) => call(ppic.token, "patch", `/api/purchase-orders/${po.body.id}/items/${itemId}/material-hold`, { held });
  const heldList = async () => ((await call(production.token, "get", "/api/production-batches/held-products")).body as { itemId: string; productHeld: boolean; batches: { id: string; held: boolean; canHold: boolean }[] }[]).find((r) => r.itemId === itemId);
  const told = async (token: string) => ((await call(token, "get", "/api/notifications")).body.notifications as { title: string }[]).map((n) => n.title);
  return { production: production.token, ppic: ppic.token, rnd: rnd.token, qa: qa.token, poId: po.body.id as string, itemId, b1, b2, b3, hold, heldList, told };
}

describe("Batch-wise Hold: PPIC holds the product, Production holds the batches that are still in preparation", () => {
  it("tells Production, lets it hold and release batch by batch (not once in production), and keeps the held batch at its step", async () => {
    const s = await setup();

    // Nothing to hold yet: the product is not on hold, so it is not on Production's list and its batches cannot be held
    expect(await s.heldList()).toBeUndefined();
    expect((await call(s.production, "patch", `/api/production-batches/${s.b1.id}/hold`, { held: true, reason: "x" })).status).toBe(409);

    // PPIC holds the product although its batches already exist (they are still in preparation): Production is told
    expect((await s.hold(true)).status).toBe(200);
    expect((await s.told(s.production)).some((t) => /put BH Powder .* on hold/.test(t))).toBe(true);
    const listed = await s.heldList();
    expect(listed).toMatchObject({ productHeld: true });
    expect(listed!.batches.map((b) => b.canHold)).toEqual([true, true, true]);

    // Production holds b2 at Batch No (a reason is needed); only Production can; PPIC may only look
    await prisma.productionBatch.update({ where: { id: s.b2.id }, data: { prepStageId: "BATCH_NO" } });
    expect((await call(s.production, "patch", `/api/production-batches/${s.b2.id}/hold`, { held: true })).status).toBe(400);
    expect((await call(s.ppic, "patch", `/api/production-batches/${s.b2.id}/hold`, { held: true, reason: "x" })).status).toBe(403);
    expect((await call(s.ppic, "get", "/api/production-batches/held-products")).status).toBe(200);
    const held = await call(s.production, "patch", `/api/production-batches/${s.b2.id}/hold`, { held: true, reason: "Customer may change the formula" });
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({ held: true, holdReason: "Customer may change the formula" });
    expect((await call(s.production, "patch", `/api/production-batches/${s.b2.id}/hold`, { held: true, reason: "again" })).status).toBe(409);
    expect((await s.told(s.ppic)).some((t) => /Production held/.test(t))).toBe(true);

    // The held batch cannot move on and is not listed at its step; the other batches are not affected by this
    const blocked = await call(s.rnd, "post", `/api/production-batches/${s.b2.id}/batch-no/allocate`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/on hold/i);
    const board = (await call(s.rnd, "get", "/api/production-batches/prep-board?stage=BATCH_NO")).body as { id: string }[];
    expect(board.map((r) => r.id)).not.toContain(s.b2.id);
    expect((await s.heldList())!.batches.find((b) => b.id === s.b2.id)).toMatchObject({ held: true, canHold: false });

    // A batch that is already READY (in production) cannot be held
    await prisma.productionBatch.update({ where: { id: s.b3.id }, data: { prepStageId: "READY" } });
    expect((await call(s.production, "patch", `/api/production-batches/${s.b3.id}/hold`, { held: true, reason: "late" })).status).toBe(409);

    // PPIC releases the product: Production is told, the batch hold stays until Production releases it
    expect((await s.hold(false)).status).toBe(200);
    expect((await s.told(s.production)).some((t) => /released BH Powder/.test(t))).toBe(true);
    expect(await s.heldList()).toMatchObject({ productHeld: false });
    expect((await call(s.rnd, "post", `/api/production-batches/${s.b2.id}/batch-no/allocate`, {})).status).toBe(409);

    // Production releases it: the batch goes on, and the product leaves the list
    expect((await call(s.production, "patch", `/api/production-batches/${s.b2.id}/hold`, { held: false })).status).toBe(200);
    expect((await call(s.production, "patch", `/api/production-batches/${s.b2.id}/hold`, { held: false })).status).toBe(409); // not held any more
    expect(await s.heldList()).toBeUndefined();
    expect((await call(s.rnd, "post", `/api/production-batches/${s.b2.id}/batch-no/allocate`, {})).status).toBe(200);
  }, 60000);

  it("PPIC cannot hold a product once a batch of it is READY (production has started), but can release", async () => {
    const s = await setup();
    await prisma.productionBatch.update({ where: { id: s.b1.id }, data: { prepStageId: "READY" } });
    const refused = await s.hold(true);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/started/i);
    expect((await s.hold(false)).status).toBe(200);
  }, 30000);
});
