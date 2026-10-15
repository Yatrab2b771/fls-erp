import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser, ensurePlant } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

/** An approved product with both plans calculated and Regulatory approved, and its plan sent to Production. */
async function sentProduct() {
  const { token: bd, user } = await createUser(["BD"]);
  const { token: ppic } = await createUser(["PPIC"]);
  const { token: production } = await createUser(["PRODUCTION"]);
  const customer = (await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: `HC Customer ${Date.now()}` })).body;
  const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: customer.id, poNumber: `HC-${Date.now()}`, items: [{ productName: "HC Product", productCategory: "Powder", quantity: 100, unit: "KG", packSize: "1 kg" }] });
  await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bd)).send({ status: "APPROVED" });
  const itemId = po.body.items[0].id as string;
  await ensurePlant(itemId);
  await prisma.rmPlan.create({ data: { name: "rm", createdById: user.id, purchaseOrderItemId: itemId, status: "CALCULATED", calculatedAt: new Date(), costingParams: {}, resultSnapshot: { procurement: [], batches: [] } } });
  await prisma.bomPlan.create({ data: { name: "bom", createdById: user.id, purchaseOrderItemId: itemId, status: "CALCULATED", calculatedAt: new Date(), resultSnapshot: { lines: [], totalYield: 0 } } });
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { sentToRegulatoryAt: new Date(), regulatoryStatus: "Approved" } });
  const sent = await request(app).post(`/api/purchase-orders/${po.body.id}/items/${itemId}/send-plan-to-production`).set(authHeader(ppic)).send({});
  expect(sent.status).toBe(200);
  const ids = async (path: string) => ((await request(app).get(path).set(authHeader(ppic))).body as { item: { id: string } }[]).map((r) => r.item.id);
  return { bd, ppic, production, poId: po.body.id as string, itemId, ids };
}

describe("Hold and Cancel work until Production has made the first batch", () => {
  it("PPIC can hold a product already sent to Production: Production is stopped and the product is listed only under On Hold; releasing lets it go on", async () => {
    const { ppic, production, poId, itemId, ids } = await sentProduct();
    expect(await ids("/api/ppic/lists/plan-sent")).toContain(itemId);

    const hold = await request(app).patch(`/api/purchase-orders/${poId}/items/${itemId}/material-hold`).set(authHeader(ppic)).send({ held: true });
    expect(hold.status).toBe(200);
    expect(await ids("/api/ppic/lists/on-hold")).toContain(itemId);
    expect(await ids("/api/ppic/lists/plan-sent")).not.toContain(itemId);
    const newPlans = await request(app).get("/api/pre-productions/new-plans").set(authHeader(production));
    expect(newPlans.body.map((r: { itemId: string }) => r.itemId)).not.toContain(itemId);

    const run = await request(app).post("/api/pre-productions").set(authHeader(production)).send({ purchaseOrderItemId: itemId, confirmNotReady: true });
    expect(run.status).toBe(409);
    expect(run.body.error).toMatch(/on hold/i);

    await request(app).patch(`/api/purchase-orders/${poId}/items/${itemId}/material-hold`).set(authHeader(ppic)).send({ held: false });
    expect(await ids("/api/ppic/lists/on-hold")).not.toContain(itemId);
    expect((await request(app).post("/api/pre-productions").set(authHeader(production)).send({ purchaseOrderItemId: itemId, confirmNotReady: true })).status).toBe(201);
  });

  it("PPIC can cancel it after the run is opened, but not once a batch exists (hold neither)", async () => {
    const { ppic, production, poId, itemId, ids } = await sentProduct();
    const run = await request(app).post("/api/pre-productions").set(authHeader(production)).send({ purchaseOrderItemId: itemId, confirmNotReady: true });
    expect(run.status).toBe(201);

    // A batch exists on a second product: hold and cancel are refused
    const other = await sentProduct();
    const otherRun = await request(app).post("/api/pre-productions").set(authHeader(other.production)).send({ purchaseOrderItemId: other.itemId, confirmNotReady: true });
    await prisma.preProduction.update({ where: { id: otherRun.body.id }, data: { currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
    const { user } = await createUser(["PRODUCTION"]);
    await prisma.productionBatch.create({ data: { preProduction: { connect: { id: otherRun.body.id } }, createdBy: { connect: { id: user.id } }, batchNo: "HC-1", plannedQty: 100 } });
    expect((await request(app).patch(`/api/purchase-orders/${other.poId}/items/${other.itemId}/cancel`).set(authHeader(other.ppic)).send({ reason: "too late" })).status).toBe(409);
    expect((await request(app).patch(`/api/purchase-orders/${other.poId}/items/${other.itemId}/material-hold`).set(authHeader(other.ppic)).send({ held: true })).status).toBe(409);

    // The first one, no batch yet: cancel works, Production is stopped, and it is listed only under Cancelled
    const cancel = await request(app).patch(`/api/purchase-orders/${poId}/items/${itemId}/cancel`).set(authHeader(ppic)).send({ reason: "customer withdrew it" });
    expect(cancel.status).toBe(200);
    expect(await ids("/api/ppic/lists/cancelled")).toContain(itemId);
    expect(await ids("/api/ppic/lists/plan-sent")).not.toContain(itemId);
    const { token: store } = await createUser(["ADMIN"]);
    const forward = await request(app).patch(`/api/pre-productions/${run.body.id}/stage`).set(authHeader(store)).send({ action: "FORWARD", grnNo: "HC-GRN" });
    expect(forward.status).toBe(409);
    expect(forward.body.error).toMatch(/cancelled/i);
  });
});

describe("BD asks PPIC to hold or cancel a product", () => {
  it("BD raises a request, PPIC accepts (it is done) or rejects with a reason, and BD is told", async () => {
    const { bd, ppic, production, poId, itemId, ids } = await sentProduct();

    // Only BD raises, and a reason is needed
    expect((await request(app).post("/api/item-change-requests").set(authHeader(ppic)).send({ purchaseOrderItemId: itemId, kind: "HOLD", reason: "customer asked" })).status).toBe(403);
    expect((await request(app).post("/api/item-change-requests").set(authHeader(bd)).send({ purchaseOrderItemId: itemId, kind: "HOLD", reason: "" })).status).toBe(400);
    const asked = await request(app).post("/api/item-change-requests").set(authHeader(bd)).send({ purchaseOrderItemId: itemId, kind: "HOLD", reason: "Customer wants to revise the formula" });
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ kind: "HOLD", status: "PENDING", productName: "HC Product" });
    expect((await request(app).post("/api/item-change-requests").set(authHeader(bd)).send({ purchaseOrderItemId: itemId, kind: "CANCEL", reason: "also this" })).status).toBe(409); // one open request

    // The PO shows the open request on the product, PPIC's count shows it
    const detail = await request(app).get(`/api/purchase-orders/${poId}`).set(authHeader(bd));
    expect(detail.body.items[0].changeRequests).toHaveLength(1);
    expect((await request(app).get("/api/ppic/summary").set(authHeader(ppic))).body.bdRequests).toBe(1);
    expect((await request(app).get("/api/item-change-requests").set(authHeader(ppic))).body.map((r: { id: string }) => r.id)).toEqual([asked.body.id]);

    // Reject needs a note and leaves the product alone
    expect((await request(app).patch(`/api/item-change-requests/${asked.body.id}`).set(authHeader(bd)).send({ action: "REJECT", note: "no" })).status).toBe(403);
    expect((await request(app).patch(`/api/item-change-requests/${asked.body.id}`).set(authHeader(ppic)).send({ action: "REJECT" })).status).toBe(400);
    const rejected = await request(app).patch(`/api/item-change-requests/${asked.body.id}`).set(authHeader(ppic)).send({ action: "REJECT", note: "Material is already issued" });
    expect(rejected.body).toMatchObject({ status: "REJECTED", decisionNote: "Material is already issued" });
    expect(await ids("/api/ppic/lists/on-hold")).not.toContain(itemId);
    expect((await request(app).patch(`/api/item-change-requests/${asked.body.id}`).set(authHeader(ppic)).send({ action: "ACCEPT" })).status).toBe(409); // already decided

    // A new request, accepted: the product is on hold and Production is stopped
    const again = await request(app).post("/api/item-change-requests").set(authHeader(bd)).send({ purchaseOrderItemId: itemId, kind: "HOLD", reason: "Customer wants to revise the formula" });
    expect((await request(app).patch(`/api/item-change-requests/${again.body.id}`).set(authHeader(ppic)).send({ action: "ACCEPT" })).body.status).toBe("ACCEPTED");
    expect(await ids("/api/ppic/lists/on-hold")).toContain(itemId);
    expect((await request(app).post("/api/pre-productions").set(authHeader(production)).send({ purchaseOrderItemId: itemId, confirmNotReady: true })).status).toBe(409);
  });

  it("a cancel request, once accepted, cancels the product, and a cancelled product cannot be asked about again", async () => {
    const { bd, ppic, itemId, ids } = await sentProduct();
    const asked = await request(app).post("/api/item-change-requests").set(authHeader(bd)).send({ purchaseOrderItemId: itemId, kind: "CANCEL", reason: "Customer withdrew the order" });
    expect((await request(app).patch(`/api/item-change-requests/${asked.body.id}`).set(authHeader(ppic)).send({ action: "ACCEPT" })).status).toBe(200);
    expect(await ids("/api/ppic/lists/cancelled")).toContain(itemId);
    const item = await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.cancelReason).toBe("Customer withdrew the order");
    expect((await request(app).post("/api/item-change-requests").set(authHeader(bd)).send({ purchaseOrderItemId: itemId, kind: "CANCEL", reason: "again" })).status).toBe(409);
  });
});
