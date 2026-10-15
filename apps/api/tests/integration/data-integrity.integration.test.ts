import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser, ensurePlant } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";
import { checkDataIntegrity } from "../../src/modules/ppic/data-integrity";

const app = createApp();

async function approvedItem() {
  const { token: bd, user } = await createUser(["BD"]);
  const { token: ppic } = await createUser(["PPIC"]);
  const customer = (await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: `DI Customer ${Date.now()}` })).body;
  const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: customer.id, poNumber: `DI-${Date.now()}`, items: [{ productName: "DI Product", productCategory: "Powder", quantity: 100, unit: "KG", packSize: "1 kg" }] });
  await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bd)).send({ status: "APPROVED" });
  const itemId = po.body.items[0].id as string;
  return { bd, ppic, user, poId: po.body.id as string, itemId };
}

const calculated = (itemId: string, userId: string, which: "rm" | "bom") =>
  which === "rm"
    ? prisma.rmPlan.create({ data: { name: "rm", createdById: userId, purchaseOrderItemId: itemId, status: "CALCULATED", calculatedAt: new Date(), costingParams: {}, resultSnapshot: { procurement: [], batches: [] } } })
    : prisma.bomPlan.create({ data: { name: "bom", createdById: userId, purchaseOrderItemId: itemId, status: "CALCULATED", calculatedAt: new Date(), resultSnapshot: { lines: [], totalYield: 0 } } });

describe("Product stage rules: no product is ever somewhere its records do not allow", () => {
  it("a normal approved product with no plan is Not Planned and breaks no rule", async () => {
    const { itemId } = await approvedItem();
    const report = await checkDataIntegrity();
    expect(report.violations).toEqual([]);
    expect(report.stages.get(itemId)).toBe("NOT_PLANNED");
  });

  it("PPIC cannot send a product to Production with only one of the two plans", async () => {
    const { ppic, user, poId, itemId } = await approvedItem();
    await ensurePlant(itemId);
    await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { sentToRegulatoryAt: new Date(), regulatoryStatus: "Approved" } });

    const none = await request(app).post(`/api/purchase-orders/${poId}/items/${itemId}/send-plan-to-production`).set(authHeader(ppic)).send({});
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/RM plan and the Packaging BOM plan/);

    await calculated(itemId, user.id, "rm");
    const onlyRm = await request(app).post(`/api/purchase-orders/${poId}/items/${itemId}/send-plan-to-production`).set(authHeader(ppic)).send({});
    expect(onlyRm.status).toBe(400);
    expect(onlyRm.body.error).toMatch(/Packaging BOM plan/);
    expect((await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemId } })).planSentToProductionAt).toBeNull();

    await calculated(itemId, user.id, "bom");
    expect((await request(app).post(`/api/purchase-orders/${poId}/items/${itemId}/send-plan-to-production`).set(authHeader(ppic)).send({})).status).toBe(200);
    const report = await checkDataIntegrity();
    expect(report.violations).toEqual([]);
    expect(report.stages.get(itemId)).toBe("PRE_PRODUCTION");
  });

  it("the data check catches a product that was pushed into Production without its plans or Regulatory's approval, and keeps it out of Not Planned", async () => {
    const { ppic, itemId } = await approvedItem();
    await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { planSentToProductionAt: new Date() } }); // the shortcut the old demo data took
    const report = await checkDataIntegrity();
    const rules = report.violations.map((v) => v.rule);
    expect(rules).toEqual(expect.arrayContaining(["sent-without-plant", "sent-without-rm-plan", "sent-without-bom-plan", "sent-without-regulatory"]));

    // It is In Production by its records, so it is not listed as Not Planned
    const notPlanned = await request(app).get("/api/ppic/lists/not-planned-pos").set(authHeader(ppic));
    expect(notPlanned.body.map((r: { item: { id: string } }) => r.item.id)).not.toContain(itemId);
  });

  it("a Hold product, sent to Production or not, is fine until a batch exists; then the records disagree and it is flagged", async () => {
    const { itemId, user } = await approvedItem();
    await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { materialHeldAt: new Date() } });
    const held = await checkDataIntegrity();
    expect(held.violations).toEqual([]);
    expect(held.stages.get(itemId)).toBe("ON_HOLD");

    // Held after it was sent (the plans and Regulatory are in place): still just On Hold
    await calculated(itemId, user.id, "rm");
    await calculated(itemId, user.id, "bom");
    await ensurePlant(itemId);
    await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { planSentToProductionAt: new Date(), sentToRegulatoryAt: new Date(), regulatoryStatus: "Approved" } });
    const heldAfterSent = await checkDataIntegrity();
    expect(heldAfterSent.violations).toEqual([]);
    expect(heldAfterSent.stages.get(itemId)).toBe("ON_HOLD");

    // A batch under a held product: the records disagree
    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemId, plannedQty: 100, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
    await prisma.productionBatch.create({ data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: user.id } }, batchNo: "DI-1", plannedQty: 100 } });
    expect((await checkDataIntegrity()).violations.map((v) => v.rule)).toContain("hold-with-batch");
  });

  it("the Total POs list gives each PO a stage with completed / total products, and Total Products names each product's stage", async () => {
    const { ppic, poId, itemId } = await approvedItem();
    const pos = await request(app).get("/api/ppic/lists/total-pos").set(authHeader(ppic));
    const po = pos.body.find((p: { id: string }) => p.id === poId);
    expect(po.stageSummary).toEqual({ stage: "Approved", completed: 0, total: 1 });

    const products = await request(app).get("/api/ppic/lists/total-products").set(authHeader(ppic));
    const row = products.body.find((r: { item: { id: string } }) => r.item.id === itemId);
    expect(row).toMatchObject({ stage: "NOT_PLANNED", stageLabel: "Not planned" });

    // The Stage filter on Total POs
    const approvedPos = await request(app).get("/api/ppic/lists/total-pos?stage=Approved").set(authHeader(ppic));
    expect(approvedPos.body.map((p: { id: string }) => p.id)).toContain(poId);
    expect(approvedPos.headers["x-total-count"]).toBe(String(approvedPos.body.length));
    const doneOrProgress = await request(app).get("/api/ppic/lists/total-pos?stage=Completed&stage=In%20progress").set(authHeader(ppic));
    expect(doneOrProgress.body.map((p: { id: string }) => p.id)).not.toContain(poId);

    // The Stage filter on Total Products
    const notPlanned = await request(app).get("/api/ppic/lists/total-products?stage=Not%20planned").set(authHeader(ppic));
    expect(notPlanned.body.map((r: { item: { id: string } }) => r.item.id)).toContain(itemId);
    expect(notPlanned.headers["x-total-count"]).toBe(String(notPlanned.body.length));
    const completed = await request(app).get("/api/ppic/lists/total-products?stage=Completed&stage=In%20production").set(authHeader(ppic));
    expect(completed.body.map((r: { item: { id: string } }) => r.item.id)).not.toContain(itemId);

    const summary = (await request(app).get("/api/ppic/summary").set(authHeader(ppic))).body;
    expect(summary).toMatchObject({ completedPos: 0, completedProducts: 0 });
  });
});
