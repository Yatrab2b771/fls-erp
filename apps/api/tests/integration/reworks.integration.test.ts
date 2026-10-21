import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";
import { getOnHandByPlantAndItem } from "../../src/modules/inventory/stock";

const app = createApp();
const call = (token: string, method: "get" | "post" | "patch" | "delete", path: string, body?: object) => {
  const r = request(app)[method](path).set(authHeader(token));
  return body ? r.send(body) : r;
};

/** 75 Kg shipped to a customer, 10 Kg of it returned and QA has chosen Rework; the Plant holds 50 Kg of Resin. */
async function setup() {
  const bd = await createUser(["BD"]);
  const warehouse = await createUser(["STORE"]);
  const qa = await createUser(["QA_QC"]);
  const production = await createUser(["PRODUCTION"]);
  const dispatch = await createUser(["DISPATCH"]);
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const plant = await prisma.plant.create({ data: { name: `RW Plant ${stamp}`, createdById: production.user.id } });
  const resin = await prisma.inventoryItem.create({ data: { category: "RM", name: `RW Resin ${stamp}`, unit: "Kg" } });
  await prisma.stockAdjustment.create({ data: { itemId: resin.id, locationType: "PLANT", plantId: plant.id, quantityDelta: 50, unit: "Kg", reason: "OTHER", note: "test stock", status: "APPROVED", requestedById: production.user.id, reviewedById: production.user.id } });
  const customer = await call(bd.token, "post", "/api/customers", { companyName: `RW Customer ${stamp}` });
  const po = await call(bd.token, "post", "/api/purchase-orders", { customerId: customer.body.id, poNumber: `RW-PO-${stamp}`, items: [{ productName: "RW Powder", productCategory: "Powder", quantity: 75, unit: "KG" }] });
  const itemId = po.body.items[0].id as string;
  await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
  const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemId, plannedQty: 75, batchFlow: true, plantId: plant.id } });
  const batch = await prisma.productionBatch.create({
    data: { preProductionId: run.id, createdById: production.user.id, batchNo: `FLS-RW-${stamp}`, plannedQty: 75, outputQty: 75, packApprovedQty: 75, status: "COMPLETED", currentStageId: "FG_HANDOVER", prepStageId: "READY", handedOverToDispatchAt: new Date() },
  });
  await prisma.fgShipment.create({ data: { productionBatchId: batch.id, type: "CUSTOMER", status: "DISPATCHED", quantity: 75, requestedById: dispatch.user.id, dispatchDate: new Date() } });
  const ret = await call(warehouse.token, "post", "/api/customer-returns", { batchId: batch.id, quantity: 10, reason: "Caked in transit" });
  await call(qa.token, "post", `/api/customer-returns/${ret.body.id}/qa`, { decision: "REWORK", note: "Re-sieve and re-pack" });
  const onHand = async () => (await getOnHandByPlantAndItem(plant.id, [resin.id])).get(resin.id) ?? 0;
  return { production, qa, warehouse, plant, resin, batch, returnId: ret.body.id as string, onHand, batchNo: batch.batchNo! };
}

describe("Rework: a job in New Plan with a sub-number of the original batch", () => {
  it("numbers it -R1, -R2 from the original batch, up to what came back", async () => {
    const s = await setup();
    expect((await call(s.qa.token, "post", "/api/reworks", { customerReturnId: s.returnId })).status).toBe(403); // Production sends it
    const first = await call(s.production.token, "post", "/api/reworks", { customerReturnId: s.returnId, quantity: 6 });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ reworkNo: `${s.batchNo}-R1`, status: "PLANNED", quantity: 6, batchNo: s.batchNo, productName: "RW Powder", qaNote: "Re-sieve and re-pack" });
    expect((await call(s.production.token, "post", "/api/reworks", { customerReturnId: s.returnId, quantity: 5 })).status).toBe(409); // only 4 left
    const second = await call(s.production.token, "post", "/api/reworks", { customerReturnId: s.returnId });
    expect(second.body).toMatchObject({ reworkNo: `${s.batchNo}-R2`, quantity: 4 });
    expect((await call(s.production.token, "post", "/api/reworks", { customerReturnId: s.returnId })).status).toBe(409); // all of it is in New Plan

    // The old one-click "rework done" no longer applies once it is in New Plan
    expect((await call(s.production.token, "post", `/api/customer-returns/${s.returnId}/rework-done`, { reworkedQty: 5 })).status).toBe(409);
    const list = (await call(s.production.token, "get", "/api/customer-returns")).body as { id: string; reworks: { reworkNo: string }[]; reworkLeft: number }[];
    expect(list.find((r) => r.id === s.returnId)).toMatchObject({ reworkLeft: 0 });
    expect(list.find((r) => r.id === s.returnId)!.reworks.map((w) => w.reworkNo)).toEqual([`${s.batchNo}-R1`, `${s.batchNo}-R2`]);
  });

  it("the sheet, material from the Plant's free stock, and completing; then the return goes back to QA", async () => {
    const s = await setup();
    const r1 = (await call(s.production.token, "post", "/api/reworks", { customerReturnId: s.returnId, quantity: 6 })).body.id as string;
    const r2 = (await call(s.production.token, "post", "/api/reworks", { customerReturnId: s.returnId, quantity: 4 })).body.id as string;

    // Start fields
    const started = await call(s.production.token, "patch", `/api/reworks/${r1}`, { shift: "Day", manpowerCount: 4, startAt: "2026-10-16T09:00:00.000Z" });
    expect(started.body).toMatchObject({ status: "IN_PROGRESS", shift: "Day", manpowerCount: 4 });
    expect((await call(s.production.token, "patch", `/api/reworks/${r1}`, { endAt: "2026-10-16T08:00:00.000Z" })).status).toBe(400); // before the start

    // Material comes out of the Plant's free stock (50 Kg); more than that is refused
    expect(await s.onHand()).toBe(50);
    const tooMuch = await call(s.production.token, "post", `/api/reworks/${r1}/materials`, { itemId: s.resin.id, quantity: 80 });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toContain("Only 50");
    const used = await call(s.production.token, "post", `/api/reworks/${r1}/materials`, { itemId: s.resin.id, quantity: 20 });
    expect(used.status).toBe(201);
    expect(used.body.materials).toHaveLength(1);
    expect(await s.onHand()).toBe(30);
    const lineId = used.body.materials[0].id as string;
    expect((await call(s.production.token, "delete", `/api/reworks/${r1}/materials/${lineId}`)).status).toBe(200);
    expect(await s.onHand()).toBe(50); // taken back

    // Completing: end time, and no more than the quantity can come out
    expect((await call(s.production.token, "post", `/api/reworks/${r2}/complete`, { endAt: "2026-10-16T12:00:00.000Z", outputQty: 4 })).status).toBe(409); // no start fields on R2
    expect((await call(s.production.token, "post", `/api/reworks/${r1}/complete`, { endAt: "2026-10-16T12:00:00.000Z", outputQty: 7 })).status).toBe(400);
    const done = await call(s.production.token, "post", `/api/reworks/${r1}/complete`, { endAt: "2026-10-16T12:00:00.000Z", outputQty: 5, note: "1 Kg lost in sieving" });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "COMPLETED", outputQty: 5, sentToQa: false }); // R2 is still open
    expect((await call(s.production.token, "get", "/api/customer-returns")).body.find((r: { id: string }) => r.id === s.returnId).status).toBe("IN_REWORK");

    // R2 is not needed: take it out, then send back what is done
    expect((await call(s.production.token, "post", `/api/reworks/for-return/${s.returnId}/send-to-qa`)).status).toBe(409); // R2 still open
    expect((await call(s.production.token, "delete", `/api/reworks/${r2}`)).status).toBe(204);
    expect((await call(s.production.token, "post", `/api/reworks/for-return/${s.returnId}/send-to-qa`)).status).toBe(200);
    const back = (await call(s.qa.token, "get", "/api/customer-returns")).body.find((r: { id: string }) => r.id === s.returnId);
    expect(back).toMatchObject({ status: "WITH_QA", reworked: true, rework: { reworkedQty: 5 } });
    const titles = ((await call(s.qa.token, "get", "/api/notifications")).body.notifications as { title: string }[]).map((n) => n.title);
    expect(titles.some((t) => /Reworked goods wait for QA/.test(t))).toBe(true);
  });

  it("when the reworks cover the whole return and all are done, it goes back to QA by itself", async () => {
    const s = await setup();
    const r1 = (await call(s.production.token, "post", "/api/reworks", { customerReturnId: s.returnId })).body.id as string; // all 10 Kg
    await call(s.production.token, "patch", `/api/reworks/${r1}`, { shift: "Night", manpowerCount: 3, startAt: "2026-10-16T20:00:00.000Z" });
    const done = await call(s.production.token, "post", `/api/reworks/${r1}/complete`, { endAt: "2026-10-16T23:00:00.000Z", outputQty: 9 });
    expect(done.body.sentToQa).toBe(true);
    expect((await call(s.qa.token, "get", "/api/customer-returns")).body.find((r: { id: string }) => r.id === s.returnId)).toMatchObject({ status: "WITH_QA", reworked: true });
    // QA's second look: pass 9 and no more
    expect((await call(s.qa.token, "post", `/api/customer-returns/${s.returnId}/qa`, { decision: "PASS", passedQty: 10 })).status).toBe(400);
    expect((await call(s.qa.token, "post", `/api/customer-returns/${s.returnId}/qa`, { decision: "PASS", passedQty: 9 })).status).toBe(200);
  });
});
