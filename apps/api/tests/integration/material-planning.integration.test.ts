import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser, ensurePlant } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

type Row = { poNumber: string; material: string; requiredQty: number; coveredQty: number | null; shortQty: number | null; status: string; isPreview: boolean };
type Product = { poNumber: string; state: string; hasShortfall: boolean; purchaseOrderItemId: string };

/** An Approved PO with one product whose RM plan is CALCULATED and needs `needKg` of `material`. */
async function approvedPlannedPo(bdToken: string, adminId: string, poNumber: string, orderDate: string, material: string, needKg: number) {
  const customer = (await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: `${poNumber} Customer` })).body;
  const po = (
    await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber, orderDate, items: [{ productName: `${poNumber} Product`, productCategory: "Powder", quantity: 10, unit: "KG" }] })
  ).body;
  await request(app).patch(`/api/purchase-orders/${po.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
  const itemId = po.items[0].id as string;
  await prisma.rmPlan.create({
    data: {
      name: `${poNumber} RM`,
      createdById: adminId,
      purchaseOrderItemId: itemId,
      status: "CALCULATED",
      calculatedAt: new Date(),
      costingParams: {},
      resultSnapshot: { procurement: [{ name: material, totalKg: needKg }], batches: [] },
    },
  });
  // The packaging (BOM) plan too — a product only shows up once both are calculated.
  await prisma.bomPlan.create({
    data: { name: `${poNumber} BOM`, createdById: adminId, purchaseOrderItemId: itemId, status: "CALCULATED", calculatedAt: new Date(), resultSnapshot: { lines: [], totalYield: 0 } },
  });
  return { poId: po.id as string, itemId };
}

async function stockOf(name: string, qty: number, adminId: string) {
  const item = await prisma.inventoryItem.create({ data: { category: "RM", name, unit: "Kg" } });
  await prisma.inventoryTransaction.create({
    data: { itemId: item.id, type: "RECEIVED", date: new Date(), unit: "Kg", quantity: qty, vendorName: "V", createdById: adminId, receiptStatus: "ACCEPTED", acceptedById: adminId, acceptedAt: new Date() },
  });
}

async function report(token: string) {
  const res = await request(app).get("/api/purchase-orders/reports/material-planning").set(authHeader(token));
  expect(res.status).toBe(200);
  const rows = res.body.rows as Row[];
  const by = (po: string) => rows.find((r) => r.poNumber === po)!;
  return { rows, products: res.body.products as Product[], by };
}

async function setup(stock = 150) {
  const { token: bdToken, user: admin } = await createUser(["BD"]);
  const { token: ppicToken } = await createUser(["PPIC"]);
  await stockOf("MP-COCOA", stock, admin.id);
  // A is the older PO, so FIFO serves it first.
  const a = await approvedPlannedPo(bdToken, admin.id, "PO-MP-A", "2026-09-01", "MP-COCOA", 100);
  const b = await approvedPlannedPo(bdToken, admin.id, "PO-MP-B", "2026-09-05", "MP-COCOA", 100);
  return { bdToken, ppicToken, admin, a, b };
}

describe("Material Planning — FIFO stock allocation", () => {
  it("lists a product only once BOTH its RM plan and its BOM plan are calculated", async () => {
    const { ppicToken, a, b } = await setup(150);
    expect((await report(ppicToken)).products.map((p) => p.poNumber).sort()).toEqual(["PO-MP-A", "PO-MP-B"]);

    // Take A's BOM plan back to Draft: half a plan, so it drops off the list.
    await prisma.bomPlan.updateMany({ where: { purchaseOrderItemId: a.itemId }, data: { status: "DRAFT" } });
    expect((await report(ppicToken)).products.map((p) => p.poNumber)).toEqual(["PO-MP-B"]);

    // Same when only the RM side is missing.
    await prisma.bomPlan.updateMany({ where: { purchaseOrderItemId: a.itemId }, data: { status: "CALCULATED" } });
    await prisma.rmPlan.updateMany({ where: { purchaseOrderItemId: b.itemId }, data: { status: "DRAFT" } });
    expect((await report(ppicToken)).products.map((p) => p.poNumber)).toEqual(["PO-MP-A"]);
  });

  it("is PPIC-only", async () => {
    const { bdToken } = await setup();
    expect((await request(app).get("/api/purchase-orders/reports/material-planning").set(authHeader(bdToken))).status).toBe(403);
  });

  it("gives the older PO the stock first; the newer one is short by what is left over (not both covered)", async () => {
    const { ppicToken } = await setup(150);
    const { by, products } = await report(ppicToken);
    expect(by("PO-MP-A")).toMatchObject({ requiredQty: 100, coveredQty: 100, shortQty: 0, status: "COVERED", isPreview: false });
    expect(by("PO-MP-B")).toMatchObject({ requiredQty: 100, coveredQty: 50, shortQty: 50, status: "SHORT", isPreview: false });
    expect(products.find((p) => p.poNumber === "PO-MP-B")!.hasShortfall).toBe(true);
    expect(products.find((p) => p.poNumber === "PO-MP-A")!.hasShortfall).toBe(false);
  });

  it("Hold frees the stock for the other product, the held one shows an if-released preview, and Release puts it back at its FIFO place", async () => {
    const { ppicToken, a } = await setup(150);
    const held = await request(app).patch(`/api/purchase-orders/${a.poId}/items/${a.itemId}/material-hold`).set(authHeader(ppicToken)).send({ held: true });
    expect(held.status).toBe(200);

    let r = await report(ppicToken);
    expect(r.by("PO-MP-B")).toMatchObject({ coveredQty: 100, shortQty: 0, status: "COVERED", isPreview: false }); // B now gets it all
    expect(r.by("PO-MP-A")).toMatchObject({ coveredQty: 50, shortQty: 50, status: "SHORT", isPreview: true }); // what A would get if released now
    expect(r.products.find((p) => p.poNumber === "PO-MP-A")!.state).toBe("HELD");

    await request(app).patch(`/api/purchase-orders/${a.poId}/items/${a.itemId}/material-hold`).set(authHeader(ppicToken)).send({ held: false });
    r = await report(ppicToken);
    expect(r.by("PO-MP-A")).toMatchObject({ coveredQty: 100, shortQty: 0, isPreview: false });
    expect(r.by("PO-MP-B")).toMatchObject({ coveredQty: 50, shortQty: 50 });
  });

  it("a product whose plan is already sent to Production keeps its claim ahead of an older, unsent one", async () => {
    const { ppicToken, b } = await setup(150);
    await prisma.purchaseOrderItem.update({ where: { id: b.itemId }, data: { planSentToProductionAt: new Date() } });
    const { by, products } = await report(ppicToken);
    expect(by("PO-MP-B")).toMatchObject({ coveredQty: 100, shortQty: 0 });
    expect(by("PO-MP-A")).toMatchObject({ coveredQty: 50, shortQty: 50 });
    expect(products.find((p) => p.poNumber === "PO-MP-B")!.state).toBe("SENT");
  });

  it("a Regulatory Not Approved product does not claim stock either (preview only), while Pending still claims", async () => {
    const { ppicToken, a } = await setup(150);
    await prisma.purchaseOrderItem.update({ where: { id: a.itemId }, data: { regulatoryStatus: "Not Approved" } });
    let r = await report(ppicToken);
    expect(r.products.find((p) => p.poNumber === "PO-MP-A")!.state).toBe("NOT_APPROVED");
    expect(r.by("PO-MP-B")).toMatchObject({ coveredQty: 100, shortQty: 0 });
    expect(r.by("PO-MP-A")).toMatchObject({ coveredQty: 50, isPreview: true });

    await prisma.purchaseOrderItem.update({ where: { id: a.itemId }, data: { regulatoryStatus: null, sentToRegulatoryAt: new Date() } }); // Pending
    r = await report(ppicToken);
    expect(r.products.find((p) => p.poNumber === "PO-MP-A")!.state).toBe("ACTIVE");
    expect(r.by("PO-MP-A")).toMatchObject({ coveredQty: 100, isPreview: false });
  });

  it("a material that is not in the catalog is listed but neither covered nor short", async () => {
    const { bdToken, admin, ppicToken } = await setup(150);
    await approvedPlannedPo(bdToken, admin.id, "PO-MP-C", "2026-09-09", "NOT-A-CATALOG-ITEM", 5);
    const { by } = await report(ppicToken);
    expect(by("PO-MP-C")).toMatchObject({ status: "NOT_IN_CATALOG", coveredQty: null, shortQty: null });
  });

  it("Hold is PPIC-only, possible until Production has made a batch (even after the plan is sent), and can hold a whole PO at once", async () => {
    const { bdToken, ppicToken, admin, a, b } = await setup(150);
    const denied = await request(app).patch(`/api/purchase-orders/${a.poId}/items/${a.itemId}/material-hold`).set(authHeader(bdToken)).send({ held: true });
    expect(denied.status).toBe(403);

    const all = await request(app).patch(`/api/purchase-orders/${a.poId}/material-hold`).set(authHeader(ppicToken)).send({ held: true });
    expect(all.body.updated).toBe(1);
    expect((await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: a.itemId } })).materialHeldAt).not.toBeNull();

    // Sent to Production but no batch yet: still possible
    await prisma.purchaseOrderItem.update({ where: { id: b.itemId }, data: { planSentToProductionAt: new Date() } });
    expect((await request(app).patch(`/api/purchase-orders/${b.poId}/items/${b.itemId}/material-hold`).set(authHeader(ppicToken)).send({ held: true })).status).toBe(200);
    await request(app).patch(`/api/purchase-orders/${b.poId}/items/${b.itemId}/material-hold`).set(authHeader(ppicToken)).send({ held: false });

    // Once a batch exists it is too late; the whole-PO hold skips it instead of erroring
    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: b.itemId, plannedQty: 100, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
    await prisma.productionBatch.create({ data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: admin.id } }, batchNo: "MP-H1", plannedQty: 100 } });
    const tooLate = await request(app).patch(`/api/purchase-orders/${b.poId}/items/${b.itemId}/material-hold`).set(authHeader(ppicToken)).send({ held: true });
    expect(tooLate.status).toBe(409);
    const skipped = await request(app).patch(`/api/purchase-orders/${b.poId}/material-hold`).set(authHeader(ppicToken)).send({ held: true });
    expect(skipped.body.updated).toBe(0); // a batch was made - skipped, not errored
  });
});

// What a Hold does depends on how far the product has got: not fully planned ->
// its plan can't be generated; fully planned (Material Planning) -> it can't go
// on to Production. Regulatory's review is NOT held either way.
describe("Hold - what it stops, by stage", () => {
  const hold = (token: string, poId: string, itemId: string, held: boolean) =>
    request(app).patch(`/api/purchase-orders/${poId}/items/${itemId}/material-hold`).set(authHeader(token)).send({ held });

  async function bareApprovedItem(bdToken: string, poNumber: string) {
    const customer = (await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: `${poNumber} Customer` })).body;
    const po = (
      await request(app)
        .post("/api/purchase-orders")
        .set(authHeader(bdToken))
        .send({ customerId: customer.id, poNumber, items: [{ productName: `${poNumber} Product`, productCategory: "Powder", quantity: 10, unit: "KG" }] })
    ).body;
    await request(app).patch(`/api/purchase-orders/${po.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    return { poId: po.id as string, itemId: po.items[0].id as string };
  }

  it("a held product that is not fully planned can't have its plan generated or calculated, until released", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { poId, itemId } = await bareApprovedItem(bdToken, "PO-HOLD-1");

    // A Draft plan made before the hold, so there is something to Calculate.
    await ensurePlant(itemId);
    const plan = await request(app).post("/api/rm-costing/plans").set(authHeader(ppicToken)).send({ name: "Before hold", purchaseOrderItemId: itemId });
    expect(plan.status).toBe(201);

    expect((await hold(ppicToken, poId, itemId, true)).status).toBe(200);
    await ensurePlant(itemId);
    const blockedCreate = await request(app).post("/api/rm-costing/plans").set(authHeader(ppicToken)).send({ name: "While held", purchaseOrderItemId: itemId });
    expect(blockedCreate.status).toBe(409);
    expect(blockedCreate.body.error).toMatch(/on hold/);
    await ensurePlant(itemId);
    expect((await request(app).post("/api/bom/plans").set(authHeader(ppicToken)).send({ name: "While held", purchaseOrderItemId: itemId })).status).toBe(409);
    expect((await request(app).post(`/api/rm-costing/plans/${plan.body.id}/calculate`).set(authHeader(ppicToken))).status).toBe(409);

    await hold(ppicToken, poId, itemId, false);
    await ensurePlant(itemId);
    expect((await request(app).post("/api/rm-costing/plans").set(authHeader(ppicToken)).send({ name: "After release", purchaseOrderItemId: itemId })).status).toBe(201);
  });

  it("a held, fully planned product can still be recalculated but can't be sent to Production; Regulatory can still review it", async () => {
    const { bdToken, ppicToken, admin, a } = await setup(150);
    const rmPlan = await prisma.rmPlan.findFirstOrThrow({ where: { purchaseOrderItemId: a.itemId } });
    await hold(ppicToken, a.poId, a.itemId, true);

    // Not the 409 hold error (it fails later for its own reasons: the hand-made plan has no queued batches).
    const recalc = await request(app).post(`/api/rm-costing/plans/${rmPlan.id}/calculate`).set(authHeader(ppicToken));
    expect(recalc.status).not.toBe(409);

    const send = await request(app).post(`/api/purchase-orders/${a.poId}/items/${a.itemId}/send-plan-to-production`).set(authHeader(ppicToken));
    expect(send.status).toBe(409);
    expect(send.body.error).toMatch(/on hold/);

    // Regulatory carries on regardless of the hold.
    const { token: regToken } = await createUser(["REGULATORY"]);
    await prisma.purchaseOrderItem.update({ where: { id: a.itemId }, data: { sentToRegulatoryAt: new Date() } });
    const review = await request(app).patch(`/api/purchase-orders/${a.poId}/items/${a.itemId}/regulatory-review`).set(authHeader(regToken)).send({ status: "Approved" });
    expect(review.status).toBe(200);
    void bdToken;
    void admin;
  });
});

// Cancel = the product is dead for good (no undo), and Send to Production is
// refused while any of its material is short.
describe("Cancel and the Send-to-Production material gate", () => {
  const cancel = (token: string, poId: string, itemId: string, reason?: string) =>
    request(app).patch(`/api/purchase-orders/${poId}/items/${itemId}/cancel`).set(authHeader(token)).send(reason === undefined ? {} : { reason });

  it("PPIC cancels with a reason; it leaves Material Planning, BD is told, and nothing more can be done to it", async () => {
    const { bdToken, ppicToken, admin, a, b } = await setup(150);

    expect((await cancel(bdToken, a.poId, a.itemId, "Customer withdrew")).status).toBe(403); // PPIC only
    expect((await cancel(ppicToken, a.poId, a.itemId)).status).toBe(400); // reason required
    expect((await cancel(ppicToken, a.poId, a.itemId, "ok")).status).toBe(400); // and a real one

    const done = await cancel(ppicToken, a.poId, a.itemId, "Customer withdrew the order");
    expect(done.status).toBe(200);
    expect(done.body.cancelReason).toBe("Customer withdrew the order");

    // Gone from Material Planning, so the other product now gets the whole stock.
    const r = await report(ppicToken);
    expect(r.products.map((p) => p.poNumber)).toEqual(["PO-MP-B"]);
    expect(r.by("PO-MP-B")).toMatchObject({ coveredQty: 100, shortQty: 0 });

    // BD (the PO's owner) was told, with the reason.
    const notices = await prisma.notification.findMany({ where: { recipientId: admin.id, title: { contains: "cancelled by PPIC" } } });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toMatch(/Customer withdrew the order/);

    // No undo and no further action: cancel again, hold, plan, send, Regulatory.
    expect((await cancel(ppicToken, a.poId, a.itemId, "again please")).status).toBe(409);
    expect((await request(app).patch(`/api/purchase-orders/${a.poId}/items/${a.itemId}/material-hold`).set(authHeader(ppicToken)).send({ held: true })).status).toBe(409);
    await ensurePlant(a.itemId);
    expect((await request(app).post("/api/rm-costing/plans").set(authHeader(ppicToken)).send({ name: "x", purchaseOrderItemId: a.itemId })).status).toBe(409);
    expect((await request(app).post(`/api/purchase-orders/${a.poId}/items/${a.itemId}/send-plan-to-production`).set(authHeader(ppicToken))).status).toBe(409);
    const { token: regToken } = await createUser(["REGULATORY"]);
    await prisma.purchaseOrderItem.update({ where: { id: a.itemId }, data: { sentToRegulatoryAt: new Date() } });
    expect((await request(app).patch(`/api/purchase-orders/${a.poId}/items/${a.itemId}/regulatory-review`).set(authHeader(regToken)).send({ status: "Approved" })).status).toBe(409);

    // The PO stays readable with the item marked cancelled; with its only product cancelled it is not "completed".
    const po = await request(app).get(`/api/purchase-orders/${a.poId}`).set(authHeader(bdToken));
    expect(po.body.items[0].cancelledAt).not.toBeNull();
    expect(po.body.completion.isCompleted).toBe(false);
  });

  it("a product sent to Production can still be cancelled until a batch is made; after that it cannot", async () => {
    const { ppicToken, admin, a, b } = await setup(150);
    await prisma.purchaseOrderItem.update({ where: { id: a.itemId }, data: { planSentToProductionAt: new Date() } });
    expect((await cancel(ppicToken, a.poId, a.itemId, "changed our mind")).status).toBe(200);

    await prisma.purchaseOrderItem.update({ where: { id: b.itemId }, data: { planSentToProductionAt: new Date() } });
    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: b.itemId, plannedQty: 100, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
    await prisma.productionBatch.create({ data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: admin.id } }, batchNo: "MP-C1", plannedQty: 100 } });
    expect((await cancel(ppicToken, b.poId, b.itemId, "too late now")).status).toBe(409);
  });

  it("Send to Production is refused while a material is short (with the list), and goes through once the product is covered", async () => {
    const { ppicToken, admin, a, b } = await setup(150);
    const plant = await prisma.plant.create({ data: { name: "MP Gate Plant", createdById: admin.id } });
    for (const x of [a, b]) {
      await prisma.purchaseOrderItem.update({ where: { id: x.itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved", sentToRegulatoryAt: new Date() } });
    }

    // B comes second in the FIFO queue, so it is short by 50 Kg.
    const blocked = await request(app).post(`/api/purchase-orders/${b.poId}/items/${b.itemId}/send-plan-to-production`).set(authHeader(ppicToken));
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("MATERIAL_SHORT");
    expect(blocked.body.shortages).toEqual([expect.objectContaining({ material: "MP-COCOA", shortQty: 50 })]);
    expect(blocked.body.error).toMatch(/MP-COCOA/);

    // A is fully covered, so it can go.
    const ok = await request(app).post(`/api/purchase-orders/${a.poId}/items/${a.itemId}/send-plan-to-production`).set(authHeader(ppicToken));
    expect(ok.status).toBe(200);
  });
});

// "Send short material to Purchase" - the SHORT materials of a product become
// Pre-Inventory requirements and Purchase is told once.
describe("Send short material to Purchase", () => {
  const send = (token: string, poId: string, itemId: string) => request(app).post(`/api/purchase-orders/${poId}/items/${itemId}/send-short-to-purchase`).set(authHeader(token));

  it("creates a requirement for the real missing quantity, notifies Purchase once, and doesn't duplicate on a second click", async () => {
    const { bdToken, ppicToken, a, b } = await setup(150);
    const { token: purchaseToken, user: purchaseUser } = await createUser(["PURCHASE"]);

    expect((await send(bdToken, b.poId, b.itemId)).status).toBe(403); // PPIC only
    expect((await send(ppicToken, a.poId, a.itemId)).status).toBe(400); // A is fully covered - nothing to send

    // B is short by 50 Kg (A took 100 of the 150 in stock).
    const first = await send(ppicToken, b.poId, b.itemId);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ sent: 1, updated: 0, skipped: 0 });

    const reqs = await prisma.preInventoryRequirement.findMany({ include: { item: true } });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.item.name).toBe("MP-COCOA");
    // Stored as live stock (150) + shortfall (50), so Pre-Inventory's own "short against live stock" reads exactly 50.
    expect(reqs[0]!.requiredQty).toBe(200);
    expect(reqs[0]!.purchaseNotifiedAt).not.toBeNull();
    expect(reqs[0]!.note).toMatch(/PO-MP-B/);
    expect(await prisma.notification.count({ where: { recipientId: purchaseUser.id, title: { contains: "Shortfall" } } })).toBe(1);
    void purchaseToken;

    const second = await send(ppicToken, b.poId, b.itemId);
    expect(second.body).toEqual({ sent: 0, updated: 0, skipped: 1 });
    expect(await prisma.preInventoryRequirement.count()).toBe(1);
    expect(await prisma.notification.count({ where: { recipientId: purchaseUser.id, title: { contains: "Shortfall" } } })).toBe(1);
  });

  it("is refused for a product that is on hold", async () => {
    const { ppicToken, b } = await setup(150);
    await request(app).patch(`/api/purchase-orders/${b.poId}/items/${b.itemId}/material-hold`).set(authHeader(ppicToken)).send({ held: true });
    expect((await send(ppicToken, b.poId, b.itemId)).status).toBe(409);
  });
});

// Until Purchase logs a PO, the requirement sent from Material Planning follows
// Material Planning (quantity updated, removed once nothing is short), and
// Purchase is told on every change.
describe("Short requirements stay in step with Material Planning until a PO is logged", () => {
  const send = (token: string, poId: string, itemId: string) => request(app).post(`/api/purchase-orders/${poId}/items/${itemId}/send-short-to-purchase`).set(authHeader(token));
  const titles = async (userId: string) => (await prisma.notification.findMany({ where: { recipientId: userId }, orderBy: { createdAt: "asc" } })).map((n) => n.title);

  async function bShortSent() {
    const ctx = await setup(150);
    const { user: purchase } = await createUser(["PURCHASE"]);
    expect((await send(ctx.ppicToken, ctx.b.poId, ctx.b.itemId)).body.sent).toBe(1);
    return { ...ctx, purchase };
  }

  it("re-quantifies the requirement when the shortage grows, and tells Purchase", async () => {
    const { ppicToken, a, purchase } = await bShortSent();
    expect((await prisma.preInventoryRequirement.findFirstOrThrow()).requiredQty).toBe(200); // 150 stock + 50 short

    // A's plan now needs 120 instead of 100 -> B gets only 30, short 70 (required = 150 + 70).
    await prisma.rmPlan.updateMany({ where: { purchaseOrderItemId: a.itemId }, data: { resultSnapshot: { procurement: [{ name: "MP-COCOA", totalKg: 120 }], batches: [] } } });
    await report(ppicToken); // opening Material Planning syncs

    expect((await prisma.preInventoryRequirement.findFirstOrThrow()).requiredQty).toBe(220);
    expect(await titles(purchase.id)).toEqual(["Shortfall: PO-MP-B Product", "Shortfall updated: MP-COCOA"]);
  });

  it("removes the requirement (and says so) once the material is no longer short - e.g. the other product was cancelled", async () => {
    const { ppicToken, a, purchase } = await bShortSent();
    const cancel = await request(app).patch(`/api/purchase-orders/${a.poId}/items/${a.itemId}/cancel`).set(authHeader(ppicToken)).send({ reason: "Customer withdrew the order" });
    expect(cancel.status).toBe(200); // the cancel itself triggers the sync

    expect(await prisma.preInventoryRequirement.count({ where: { deletedAt: null } })).toBe(0);
    expect(await titles(purchase.id)).toEqual(["Shortfall: PO-MP-B Product", "Shortfall cleared: MP-COCOA"]);
  });

  it("stops following Material Planning once Purchase has logged a PO against it", async () => {
    const { ppicToken, a, purchase } = await bShortSent();
    await prisma.preInventoryRequirement.updateMany({ data: { poNumber: "PUR-PO-1", vendorName: "Vendor", purchaseAt: new Date(), purchaseById: purchase.id } });

    await request(app).patch(`/api/purchase-orders/${a.poId}/items/${a.itemId}/cancel`).set(authHeader(ppicToken)).send({ reason: "Customer withdrew the order" });
    await report(ppicToken);

    const req = await prisma.preInventoryRequirement.findFirstOrThrow();
    expect(req.deletedAt).toBeNull();
    expect(req.requiredQty).toBe(200); // untouched
    expect(await titles(purchase.id)).toEqual(["Shortfall: PO-MP-B Product"]); // no further notices
  });

  it("PPIC's Material Planning shows what Purchase has on order for a short material (PI lines still to arrive)", async () => {
    const { ppicToken, purchase } = await bShortSent();
    const requirement = await prisma.preInventoryRequirement.findFirstOrThrow();
    await prisma.requirementPurchaseLine.create({ data: { requirementId: requirement.id, quantity: 50, piNumber: "PI-MP-1", vendorName: "Vendor X", eta: new Date(Date.now() + 5 * 86_400_000), loggedById: purchase.id } });
    await prisma.requirementPurchaseLine.create({ data: { requirementId: requirement.id, quantity: 30, receivedQty: 30, status: "RECEIVED", piNumber: "PI-MP-0", vendorName: "Vendor X", eta: new Date(), loggedById: purchase.id } });

    const res = await request(app).get("/api/ppic/material-planning").set(authHeader(ppicToken));
    const withOrder = res.body.filter((r: { onOrder: unknown }) => r.onOrder);
    expect(withOrder).toHaveLength(1);
    expect(withOrder[0].onOrder).toMatchObject({ quantity: 50, lines: [{ quantity: 50, piNumber: "PI-MP-1", vendorName: "Vendor X" }] }); // the received line is not "on order"
    expect((await request(app).get("/api/ppic/summary").set(authHeader(ppicToken))).body.poLogged).toBe(1);
  });

  it("leaves it alone while the product is on hold, and a second Send click just refreshes the quantity", async () => {
    const { ppicToken, b, a } = await bShortSent();
    await request(app).patch(`/api/purchase-orders/${b.poId}/items/${b.itemId}/material-hold`).set(authHeader(ppicToken)).send({ held: true });
    expect(await prisma.preInventoryRequirement.count({ where: { deletedAt: null } })).toBe(1); // held -> preview only, requirement kept

    await request(app).patch(`/api/purchase-orders/${b.poId}/items/${b.itemId}/material-hold`).set(authHeader(ppicToken)).send({ held: false });
    await prisma.rmPlan.updateMany({ where: { purchaseOrderItemId: a.itemId }, data: { resultSnapshot: { procurement: [{ name: "MP-COCOA", totalKg: 120 }], batches: [] } } });
    const again = await send(ppicToken, b.poId, b.itemId);
    expect(again.body).toEqual({ sent: 0, updated: 1, skipped: 0 }); // A's plan grew meanwhile: 200 -> 220
    expect((await prisma.preInventoryRequirement.findFirstOrThrow()).requiredQty).toBe(220);
    expect((await send(ppicToken, b.poId, b.itemId)).body).toEqual({ sent: 0, updated: 0, skipped: 1 }); // and a click with nothing new changes nothing
  });
});

// No button needed: a product that is short on material is sent to Purchase by
// itself, new shortages are picked up too, and nothing is duplicated.
describe("Short material goes to Purchase automatically", () => {
  async function ctx() {
    const c = await setup(150);
    const { user: purchase } = await createUser(["PURCHASE"]);
    return { ...c, purchase };
  }
  const titles = async (userId: string) => (await prisma.notification.findMany({ where: { recipientId: userId }, orderBy: { createdAt: "asc" } })).map((n) => n.title);

  it("opening Material Planning sends every short product's shortfall to Purchase once - no duplicates on the next look", async () => {
    const { ppicToken, purchase } = await ctx();
    expect(await prisma.preInventoryRequirement.count()).toBe(0);

    await report(ppicToken);
    const reqs = await prisma.preInventoryRequirement.findMany({ include: { item: true } });
    expect(reqs).toHaveLength(1); // only B is short (A is covered)
    expect(reqs[0]!.item.name).toBe("MP-COCOA");
    expect(reqs[0]!.requiredQty).toBe(200); // 150 stock + 50 short
    expect(reqs[0]!.purchaseNotifiedAt).not.toBeNull();
    expect(await titles(purchase.id)).toEqual(["Shortfall: PO-MP-B Product"]);

    await report(ppicToken);
    expect(await prisma.preInventoryRequirement.count()).toBe(1);
    expect(await titles(purchase.id)).toHaveLength(1);
  });

  it("a material that becomes short later is sent as well (a new requirement next to the first)", async () => {
    const { ppicToken, b, purchase } = await ctx();
    await report(ppicToken);

    // B's RM plan now also needs 10 of a material that has no stock.
    await prisma.inventoryItem.create({ data: { category: "RM", name: "MP-SUGAR", unit: "Kg" } });
    await prisma.rmPlan.updateMany({
      where: { purchaseOrderItemId: b.itemId },
      data: { resultSnapshot: { procurement: [{ name: "MP-COCOA", totalKg: 100 }, { name: "MP-SUGAR", totalKg: 10 }], batches: [] } },
    });
    await report(ppicToken);

    const names = (await prisma.preInventoryRequirement.findMany({ include: { item: true } })).map((r) => r.item.name).sort();
    expect(names).toEqual(["MP-COCOA", "MP-SUGAR"]);
    expect(await titles(purchase.id)).toEqual(["Shortfall: PO-MP-B Product", "Shortfall: PO-MP-B Product"]);
  });

  it("does not send for a product that is on hold or that Regulatory marked Not Approved (it takes no stock)", async () => {
    const { ppicToken, a, b } = await ctx();
    await request(app).patch(`/api/purchase-orders/${b.poId}/items/${b.itemId}/material-hold`).set(authHeader(ppicToken)).send({ held: true });
    await report(ppicToken);
    expect(await prisma.preInventoryRequirement.count()).toBe(0);

    await request(app).patch(`/api/purchase-orders/${b.poId}/items/${b.itemId}/material-hold`).set(authHeader(ppicToken)).send({ held: false });
    await prisma.preInventoryRequirement.deleteMany(); // start clean: the release itself synced and sent B
    await prisma.purchaseOrderItem.update({ where: { id: a.itemId }, data: { regulatoryStatus: "Not Approved" } });
    await prisma.purchaseOrderItem.update({ where: { id: b.itemId }, data: { regulatoryStatus: "Not Approved" } });
    await report(ppicToken);
    expect(await prisma.preInventoryRequirement.count()).toBe(0);
  });

  it("never re-sends a material Purchase has already logged a PO for", async () => {
    const { ppicToken, purchase } = await ctx();
    await report(ppicToken);
    await prisma.preInventoryRequirement.updateMany({ data: { poNumber: "PUR-PO-9", vendorName: "Vendor", purchaseAt: new Date(), purchaseById: purchase.id } });

    await report(ppicToken);
    expect(await prisma.preInventoryRequirement.count()).toBe(1);
    expect(await titles(purchase.id)).toHaveLength(1);
  });
});
