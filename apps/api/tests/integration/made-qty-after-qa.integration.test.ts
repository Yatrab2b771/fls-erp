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

/** An order of 100 Kg: one batch of 100 made, 75 Kg came out, now at QA's manufacturing gate. */
async function setup() {
  const production = await createUser(["PRODUCTION"]);
  const qa = await createUser(["QA_QC"]);
  const bd = await createUser(["BD"]);
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const dayStore = await prisma.dayStore.create({ data: { name: `QM Store ${stamp}`, createdById: production.user.id } });
  const plant = await prisma.plant.create({ data: { name: `QM Plant ${stamp}`, createdById: production.user.id, dayStoreId: dayStore.id } });
  const customer = await call(bd.token, "post", "/api/customers", { companyName: `QM Customer ${stamp}` });
  const po = await call(bd.token, "post", "/api/purchase-orders", { customerId: customer.body.id, poNumber: `QM-PO-${stamp}`, items: [{ productName: "QM Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
  const itemId = po.body.items[0].id as string;
  await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved", planSentToProductionAt: new Date() } });
  const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemId, plannedQty: 100, batchFlow: true, plantId: plant.id, combinedQty: 75, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
  const batch = await prisma.productionBatch.create({
    data: { preProductionId: run.id, createdById: production.user.id, batchNo: `QM-B-${stamp}`, plannedQty: 100, outputQty: 75, inputQty: 100, status: "COMPLETED", currentStageId: "QA_GATE_MFG", prepStageId: "READY" },
  });
  const made = async () => (await prisma.preProduction.findUniqueOrThrow({ where: { id: run.id } })).combinedQty;
  const forward = (body: object) => call(qa.token, "patch", `/api/production-batches/${batch.id}/stage`, { action: "FORWARD", ...body });
  return { production, qa, itemId, runId: run.id, batchId: batch.id, made, forward };
}

describe("What a batch has made after QA's gates", () => {
  it("lowers the run's 'made so far' by what QA rejects, so the shortfall and Close short see the real quantity", async () => {
    const s = await setup();
    expect(await s.made()).toBe(75);

    // QA passes 55 Kg of the 75 and rejects 20 at the manufacturing gate
    const gate = await s.forward({ mfgQaStatus: "Approved", mfgQcStatus: "Approved", mfgApprovedQty: 55, mfgRejectedQty: 20 });
    expect(gate.status).toBe(200);
    expect(await s.made()).toBe(55);

    // The plans board says so, and a batch can be planned for what is missing (100 - 55)
    const board = (await call(s.production.token, "get", "/api/pre-productions/plans-board")).body as { itemId: string; run: { combinedQty: number } }[];
    expect(board.find((r) => r.itemId === s.itemId)?.run.combinedQty).toBe(55);
    const extra = await call(s.production.token, "post", `/api/pre-productions/${s.runId}/production-batches`, { plannedQty: 45, reason: "QA rejected 20 Kg of the first batch" });
    expect(extra.status).toBe(201);
  });

  it("Close short counts the approved quantity, not what was produced", async () => {
    const s = await setup();
    await s.forward({ mfgQaStatus: "Approved", mfgQcStatus: "Approved", mfgApprovedQty: 60, mfgRejectedQty: 10, mfgWastageQty: 5 });
    expect(await s.made()).toBe(60);
    const res = await call(s.production.token, "post", `/api/production-batches/products/${s.itemId}/close-short`, { reason: "Customer agreed to 60 Kg" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ madeQty: 60, orderedQty: 100 });
  });

  it("a gate that passes everything changes nothing", async () => {
    const s = await setup();
    const gate = await s.forward({ mfgQaStatus: "Approved", mfgQcStatus: "Approved" });
    expect(gate.status).toBe(200);
    expect(await s.made()).toBe(75);
  });
});
