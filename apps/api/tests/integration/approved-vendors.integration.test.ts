import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";
import { assertVendorAllowed } from "../../src/modules/product-vendors/vendor-rules";

const app = createApp();
const DAY = 86_400_000;
const GOOD = "AV Good Co";
const OTHER = "AV Other Co";

type Lot = { vendor: string; qty: number; days: number };

/**
 * A product (recipe) whose whey may come from "AV Good Co" only, with a batch ready to dispense. The Warehouse holds the given lots of
 * whey; `toStore` Kg of it is issued to the Day Store through the API (oldest expiry first), so the lots it holds are on record.
 */
async function setup(lots: Lot[], toStore: number, release = true) {
  const production = await createUser(["PRODUCTION"]);
  const rnd = await createUser(["RND"]);
  const dayStoreLogin = await createUser(["STORE"]);
  const warehouse = await createUser(["STORE"]);
  const bd = await createUser(["BD"]);
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const dayStore = await prisma.dayStore.create({ data: { name: `AV Store ${stamp}`, createdById: production.user.id } });
  const plant = await prisma.plant.create({ data: { name: `AV Plant ${stamp}`, createdById: production.user.id, dayStoreId: dayStore.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: dayStoreLogin.user.id, dayStoreId: dayStore.id } });

  const whey = await prisma.inventoryItem.create({ data: { category: "RM", name: `AV Whey ${stamp}`, unit: "Kg" } });
  const good = await prisma.vendor.create({ data: { name: GOOD, createdById: warehouse.user.id } });
  const other = await prisma.vendor.create({ data: { name: OTHER, createdById: warehouse.user.id } });
  for (const [i, l] of lots.entries()) {
    await prisma.inventoryTransaction.create({
      data: { itemId: whey.id, createdById: warehouse.user.id, date: new Date(), unit: "Kg", type: "RECEIVED", quantity: l.qty, vendorName: l.vendor, grnNo: `AV-${stamp}-${i}`, batchNo: `AV-B-${i}`, receiptStatus: "ACCEPTED", acceptedById: warehouse.user.id, acceptedAt: new Date(), expiryDate: new Date(Date.now() + l.days * DAY) },
    });
  }
  if (toStore > 0) {
    const res = await request(app).post("/api/inventory/transactions").set(authHeader(warehouse.token)).send({ itemId: whey.id, type: "ISSUED_DAY_STORE", date: new Date().toISOString(), unit: "Kg", quantity: toStore, dayStoreId: dayStore.id });
    expect(res.status).toBe(201);
  }

  const customer = await request(app).post("/api/customers").set(authHeader(bd.token)).send({ companyName: `AV Customer ${stamp}` });
  const recipe = await prisma.recipe.create({ data: { customerId: customer.body.id, name: `AV Powder ${stamp}`, totalServing: 30, ingredients: { create: [{ name: whey.name, brand: "BrandW", gPerServing: 30, costPerKg: 0, sortOrder: 1 }] } } });
  const po = await request(app).post("/api/purchase-orders").set(authHeader(bd.token)).send({ customerId: customer.body.id, poNumber: `AV-PO-${stamp}`, items: [{ productName: "AV Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
  const itemId = po.body.items[0].id as string;
  await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved", planSentToProductionAt: new Date() } });
  await prisma.rmPlan.create({
    data: { name: "AV rm", status: "CALCULATED", calculatedAt: new Date(), costingParams: {}, createdById: production.user.id, purchaseOrderItemId: itemId, resultSnapshot: { procurement: [{ name: whey.name, totalKg: 100 }] }, items: { create: [{ recipeId: recipe.id, batchSizeKg: 100, addedById: production.user.id }] } },
  });
  await prisma.bomPlan.create({ data: { name: "AV bom", status: "CALCULATED", calculatedAt: new Date(), createdById: production.user.id, purchaseOrderItemId: itemId, resultSnapshot: { lines: [], totalYield: 0 } } });

  const call = (token: string, method: "get" | "post" | "put" | "patch" | "delete", path: string, body?: object) => {
    const r = request(app)[method](path).set(authHeader(token));
    return body ? r.send(body) : r;
  };
  // R&D (QA) makes whey a "Good Co only" material for this recipe
  const restrict = await call(rnd.token, "put", `/api/product-vendors/products/RM/${recipe.id}/materials`, { name: whey.name, vendorIds: [good.id] });
  expect(restrict.status).toBe(200);

  // Material Planning lists products that are not released yet; the batch is only needed to dispense
  if (!release) return { call, production, rnd, dayStoreLogin, warehouse, bd, whey, good, other, recipe, dayStore, plant, batch: { id: "" }, itemId, customer: customer.body };
  const run = await call(production.token, "post", "/api/pre-productions", { purchaseOrderItemId: itemId, batchFlow: true, confirmNotReady: true });
  expect(run.status).toBe(201);
  const batch = (await call(production.token, "post", `/api/pre-productions/${run.body.id}/production-batches`, { plannedQty: 40 })).body;
  await call(production.token, "post", `/api/production-batches/${batch.id}/indent`, { prodIndentSlipSign: "AV Head", productionPlanDate: "2026-10-14" });
  await call(rnd.token, "post", `/api/production-batches/${batch.id}/batch-no/allocate`, {});
  return { call, production, rnd, dayStoreLogin, warehouse, bd, whey, good, other, recipe, dayStore, plant, batch, itemId, customer: customer.body };
}

const dispense = { rmDispensingDate: "2026-10-14", pmIssuedDate: "2026-10-14" };
type S = Awaited<ReturnType<typeof setup>>;
const dispenseBatch = (s: S) => s.call(s.dayStoreLogin.token, "post", `/api/production-batches/${s.batch.id}/dispense`, dispense);

describe("Approved vendors - R&D sets the rules", () => {
  it("only R&D can set them; the product then lists the vendors per material", async () => {
    const s = await setup([{ vendor: GOOD, qty: 100, days: 300 }], 60);
    const denied = await s.call(s.production.token, "put", `/api/product-vendors/products/RM/${s.recipe.id}/materials`, { name: s.whey.name, vendorIds: [] });
    expect(denied.status).toBe(403);

    const product = await s.call(s.production.token, "get", `/api/product-vendors/products/RM/${s.recipe.id}`);
    expect(product.status).toBe(200);
    expect(product.body.materials).toHaveLength(1);
    expect(product.body.materials[0]).toMatchObject({ name: s.whey.name, approved: [{ vendorId: s.good.id, name: GOOD }] });

    const list = await s.call(s.production.token, "get", `/api/product-vendors/products?kind=RM&search=AV Powder`);
    expect(list.body.find((p: { id: string }) => p.id === s.recipe.id)).toMatchObject({ materialCount: 1, restrictedCount: 1 });

    const stranger = await s.call(s.rnd.token, "put", `/api/product-vendors/products/RM/${s.recipe.id}/materials`, { name: "Not an ingredient", vendorIds: [s.good.id] });
    expect(stranger.status).toBe(400);

    // Unticking every vendor takes the restriction off
    const cleared = await s.call(s.rnd.token, "put", `/api/product-vendors/products/RM/${s.recipe.id}/materials`, { name: s.whey.name, vendorIds: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.materials[0].approved).toEqual([]);
  });

  it("Purchase can only log a purchase of a restricted material against an approved vendor", async () => {
    const s = await setup([{ vendor: GOOD, qty: 100, days: 300 }], 60);
    const requirement = { itemId: s.whey.id, sourcePoItemId: s.itemId, linkedPoItemId: null, item: { name: s.whey.name } };
    await expect(assertVendorAllowed(requirement, OTHER)).rejects.toMatchObject({ status: 409 });
    await expect(assertVendorAllowed(requirement, `  ${GOOD.toUpperCase()} `)).resolves.toBeUndefined(); // same vendor, however it is typed
    // A requirement not tied to a product is never restricted
    await expect(assertVendorAllowed({ ...requirement, sourcePoItemId: null }, OTHER)).resolves.toBeUndefined();
  });
});

describe("Approved vendors - dispensing", () => {
  it("draws only the approved vendor's lot, skipping an earlier-expiring lot of another vendor", async () => {
    // Other Co's 10 Kg expires first; FEFO would use it, but this product may not
    const s = await setup(
      [
        { vendor: OTHER, qty: 10, days: 30 },
        { vendor: GOOD, qty: 100, days: 300 },
      ],
      60,
    );
    expect((await dispenseBatch(s)).status).toBe(200);
    const pending = await prisma.batchDispensingLine.findMany({ where: { productionBatchId: s.batch.id, deliveryStatus: "PENDING" } });
    const received = await s.call(s.production.token, "post", `/api/production-batches/${s.batch.id}/receive`, { lines: pending.map((l) => ({ lineId: l.id, action: "RECEIVE" })) });
    expect(received.status).toBe(200);
    const trace = await s.call(s.warehouse.token, "get", `/api/inventory/lots/trace/batch/${s.batch.id}`);
    const m = trace.body.materials.find((x: { itemId: string }) => x.itemId === s.whey.id);
    expect(m.lots.map((l: { vendorName: string; usedQty: number }) => [l.vendorName, l.usedQty])).toEqual([[GOOD, 40]]);
  });

  it("is blocked when the Day Store holds only another vendor's material, and goes through once R&D allows it", async () => {
    const s = await setup([{ vendor: OTHER, qty: 100, days: 300 }], 60);
    const blocked = await dispenseBatch(s);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("Approved vendor only");
    expect(blocked.body.error).toContain(GOOD);
    expect(await prisma.batchDispensingLine.count({ where: { productionBatchId: s.batch.id } })).toBe(0);

    // It shows up for R&D with the numbers
    const waiting = await s.call(s.rnd.token, "get", "/api/product-vendors/waiting");
    const row = waiting.body.find((w: { batchId: string }) => w.batchId === s.batch.id);
    expect(row).toMatchObject({ material: s.whey.name, neededQty: 40, approvedQty: 0, otherVendorsQty: 60, approvedVendors: [GOOD] });

    // Only R&D may allow it, and it needs a reason
    expect((await s.call(s.production.token, "post", "/api/product-vendors/deviations", { purchaseOrderItemId: s.itemId, itemId: s.whey.id, reason: "need it now" })).status).toBe(403);
    expect((await s.call(s.rnd.token, "post", "/api/product-vendors/deviations", { purchaseOrderItemId: s.itemId, itemId: s.whey.id, reason: "x" })).status).toBe(400);
    const allowed = await s.call(s.rnd.token, "post", "/api/product-vendors/deviations", { purchaseOrderItemId: s.itemId, itemId: s.whey.id, reason: "Good Co is out of stock; QA checked Other Co's COA" });
    expect(allowed.status).toBe(201);

    expect((await s.call(s.rnd.token, "get", "/api/product-vendors/waiting")).body.find((w: { batchId: string }) => w.batchId === s.batch.id)).toBeUndefined();
    expect((await s.call(s.rnd.token, "get", "/api/product-vendors/deviations")).body[0]).toMatchObject({ material: s.whey.name, approvedVendors: [GOOD], approvedByName: expect.any(String) });
    expect((await dispenseBatch(s)).status).toBe(200);

    // Taking the permission back puts the restriction on again for the next batch
    const dev = await prisma.vendorDeviation.findFirstOrThrow({ where: { purchaseOrderItemId: s.itemId } });
    expect((await s.call(s.rnd.token, "delete", `/api/product-vendors/deviations/${dev.id}`)).status).toBe(204);
    expect(await prisma.vendorDeviation.count()).toBe(0);
  });

  it("a material with no rule is unaffected (any vendor, FEFO as before)", async () => {
    const s = await setup([{ vendor: OTHER, qty: 100, days: 300 }], 60);
    await s.call(s.rnd.token, "put", `/api/product-vendors/products/RM/${s.recipe.id}/materials`, { name: s.whey.name, vendorIds: [] });
    expect((await dispenseBatch(s)).status).toBe(200);
  });
});

describe("Approved vendors - Material Planning", () => {
  type Row = { poNumber: string; material: string; requiredQty: number; coveredQty: number | null; shortQty: number | null; approvedVendors: string[]; approvedOnHand: number | null };
  const planning = async (s: S) => {
    const ppic = await createUser(["PPIC"]);
    const res = await s.call(ppic.token, "get", "/api/purchase-orders/reports/material-planning");
    expect(res.status).toBe(200);
    return (res.body.rows as Row[]).find((r) => r.material === s.whey.name)!;
  };

  it("counts only the approved vendor's stock as available to the product", async () => {
    // 100 Kg in the Warehouse, all Other Co's; the product needs 100 Kg of Good Co's
    const s = await setup([{ vendor: OTHER, qty: 100, days: 300 }], 0, false);
    const row = await planning(s);
    expect(row).toMatchObject({ requiredQty: 100, coveredQty: 0, shortQty: 100, approvedVendors: [GOOD], approvedOnHand: 0 });
  });

  it("is covered when the approved vendor's stock is enough", async () => {
    const s = await setup(
      [
        { vendor: OTHER, qty: 30, days: 300 },
        { vendor: GOOD, qty: 120, days: 300 },
      ],
      0,
      false,
    );
    const row = await planning(s);
    expect(row).toMatchObject({ coveredQty: 100, shortQty: 0, approvedVendors: [GOOD], approvedOnHand: 120 });
  });

  it("R&D allowing another vendor makes all the stock count again", async () => {
    const s = await setup([{ vendor: OTHER, qty: 100, days: 300 }], 0, false);
    expect((await s.call(s.rnd.token, "post", "/api/product-vendors/deviations", { purchaseOrderItemId: s.itemId, itemId: s.whey.id, reason: "Other Co is fine for this one" })).status).toBe(201);
    const row = await planning(s);
    expect(row).toMatchObject({ coveredQty: 100, shortQty: 0, approvedVendors: [] });
  });
});
