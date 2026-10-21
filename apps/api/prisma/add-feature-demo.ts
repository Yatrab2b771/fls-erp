import request from "supertest";
import type { RoleName } from "@prisma/client";
import { createApp } from "../src/app";
import { prisma } from "../src/common/lib/prisma";
import { signAccessToken } from "../src/common/lib/jwt";

/**
 * Demo data for screens that were empty after the newer features: the Batch tile (batches cleared for production, one started), customer
 * returns at every step (Warehouse, QA, Rework, Dispatch, Credit Notes), a product Production put on hold (Held Products), Warehouse material
 * entries at each QC step (Quarantine, Accept, Rejected Stock), stock corrections, and an approved-vendor rule. Everything goes through the API;
 * nothing is deleted. Each part is separate: one that cannot be done is reported and the rest carry on.
 *
 *   npx tsx prisma/add-feature-demo.ts
 */
const app = createApp();
const tokens: Record<string, string> = {};

async function tokenFor(role: RoleName) {
  const user = await prisma.user.findFirstOrThrow({ where: { email: `${role.toLowerCase()}@fls.local` }, include: { roles: { include: { role: true } } } });
  tokens[role] = signAccessToken({ sub: user.id, roles: user.roles.map((r) => r.role.name), tokenVersion: user.tokenVersion });
  return user;
}

async function call<T = any>(role: RoleName, method: "get" | "post" | "patch" | "put", path: string, body?: unknown): Promise<T> {
  const req = request(app)[method](path).set("Authorization", `Bearer ${tokens[role]}`);
  const res = await (body === undefined ? req : req.send(body as object));
  if (![200, 201, 204].includes(res.status)) throw new Error(`${role} ${method.toUpperCase()} ${path} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body as T;
}

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function part(name: string, fn: () => Promise<string>) {
  try {
    console.log(`OK    ${name}: ${await fn()}`);
  } catch (err) {
    console.log(`SKIP  ${name}: ${err instanceof Error ? err.message.slice(0, 260) : err}`);
  }
}

async function main() {
  for (const role of ["ADMIN", "STORE", "QA_QC", "PRODUCTION", "DISPATCH", "ACCOUNTS", "RND"] as RoleName[]) await tokenFor(role);

  // ---- 1. The Batch tile: some batches are READY (material in); one of them is started
  await part("Batch tile", async () => {
    const waiting = await prisma.productionBatch.findMany({ where: { prepStageId: "READY", status: "IN_PROGRESS", heldAt: null, shiftStartAt: null }, select: { id: true, batchNo: true }, orderBy: { createdAt: "asc" }, take: 3 });
    if (waiting.length > 0) {
      const first = waiting[0]!;
      await call("PRODUCTION", "patch", `/api/production-batches/${first.id}`, { shift: "Day", manpowerCount: 6, shiftStartAt: new Date().toISOString() }).catch(() => undefined);
    }
    return waiting.length ? `${waiting.map((b) => b.batchNo ?? b.id.slice(0, 8)).join(", ")} ready for production (the first one is started)` : "no batch was ready to start";
  });

  // ---- 2. Customer returns at every step
  await part("Customer returns", async () => {
    const scenarios = ["WITH_QA", "REWORK", "PASS_PARTIAL", "PASS_STORE_CREDIT", "SCRAP"] as const;
    const made: string[] = [];
    for (const sc of scenarios) {
      const returnable = await call<{ batchId: string; batchNo: string | null; withCustomerQty: number; productName: string }[]>("STORE", "get", "/api/customer-returns/returnable");
      const pick = returnable.find((r) => r.withCustomerQty >= 4);
      if (!pick) {
        made.push(`${sc}: no batch with enough shipped quantity`);
        continue;
      }
      const qty = Math.min(5, Math.floor(pick.withCustomerQty / 2));
      const rec = await call<{ id: string }>("STORE", "post", "/api/customer-returns", { batchId: pick.batchId, quantity: qty, reason: { WITH_QA: "Seal broken on arrival", REWORK: "Tubs dented, powder caked", PASS_PARTIAL: "Wrong product ordered by customer", PASS_STORE_CREDIT: "Customer changed the order", SCRAP: "Quality complaint: bad smell" }[sc], condition: sc === "SCRAP" ? "Opened and contaminated" : "Cartons dented", returnedAt: day(-1) });
      if (sc === "REWORK") await call("QA_QC", "post", `/api/customer-returns/${rec.id}/qa`, { decision: "REWORK", note: "Re-sieve and re-pack" });
      if (sc === "PASS_PARTIAL") await call("QA_QC", "post", `/api/customer-returns/${rec.id}/qa`, { decision: "PASS", passedQty: Math.max(1, qty - 1), note: "1 tub damaged" });
      if (sc === "PASS_STORE_CREDIT") {
        await call("QA_QC", "post", `/api/customer-returns/${rec.id}/qa`, { decision: "PASS" });
        await call("DISPATCH", "post", `/api/customer-returns/${rec.id}/dispatch`, { choice: "STORE", note: "Keep it in the Warehouse" });
        await call("ACCOUNTS", "post", `/api/customer-returns/${rec.id}/credit-note`, { creditNoteNo: "CN-DEMO-001", note: "Credit for the returned goods" });
      }
      if (sc === "SCRAP") await call("QA_QC", "post", `/api/customer-returns/${rec.id}/qa`, { decision: "SCRAP", note: "Contaminated, cannot be used" });
      made.push(`${sc} (${qty} of ${pick.productName} ${pick.batchNo ?? ""})`);
    }
    return made.join("; ");
  });

  // ---- 3. Held Products: a product with a started run and no batch yet, held by Production
  await part("Held Products", async () => {
    const item = await prisma.purchaseOrderItem.findFirst({
      where: { deletedAt: null, cancelledAt: null, materialHeldAt: null, productionHeldAt: null, planSentToProductionAt: { not: null }, preProduction: { is: { batchFlow: true, productionBatches: { none: {} } } } },
      select: { id: true, productName: true },
    });
    if (!item) return "no product with a started run and no batch to hold";
    await call("PRODUCTION", "patch", `/api/production-batches/products/${item.id}/hold`, { held: true, reason: "DEMO: waiting for the customer's artwork approval" });
    return `${item.productName} is on hold (release it from Held Products)`;
  });

  // ---- 4. Warehouse material entries at each QC step
  await part("Warehouse entries", async () => {
    const items = await prisma.inventoryItem.findMany({ where: { name: { in: ["DEMO Sweetener", "DEMO Cocoa Powder", "DEMO Whey Isolate"] } }, select: { id: true, name: true, unit: true } });
    if (items.length < 3) return "the DEMO items are missing";
    const log = (itemId: string, unit: string, qty: number, grn: string) =>
      call<{ id: string }>("STORE", "post", "/api/inventory/transactions", { itemId, type: "RECEIVED", date: new Date().toISOString(), unit, quantity: qty, vendorName: "DEMO Vendor", invoiceNo: `INV-${grn}`, grnNo: grn, batchNo: `B-${grn}`, expiryDate: new Date(Date.now() + 300 * 86_400_000).toISOString(), remark: "DEMO entry" });
    const [a, b, c] = items;
    const pending = await log(a!.id, a!.unit ?? "Kg", 10, `GRN-D1-${Date.now() % 10000}`);
    const approved = await log(b!.id, b!.unit ?? "Kg", 20, `GRN-D2-${Date.now() % 10000}`);
    const rejected = await log(c!.id, c!.unit ?? "Kg", 15, `GRN-D3-${Date.now() % 10000}`);
    await call("RND", "patch", `/api/inventory/transactions/${approved.id}/qc`, { action: "APPROVE", samplingDate: day(-1) });
    await call("RND", "patch", `/api/inventory/transactions/${rejected.id}/qc`, { action: "REJECT", samplingDate: day(-1), note: "Moisture above the limit" });
    void pending;
    return `${a!.name} waits for QC (Quarantine), ${b!.name} is QC approved (press Accept into Stock), ${c!.name} was rejected (Rejected Stock)`;
  });

  // ---- 5. Stock corrections: one waits for approval, one is approved
  await part("Stock corrections", async () => {
    const item = await prisma.inventoryItem.findFirst({ where: { name: "DEMO Cocoa Powder" }, select: { id: true, unit: true } });
    if (!item) return "DEMO Cocoa Powder is missing";
    await call("STORE", "post", "/api/stock-adjustments", { itemId: item.id, locationType: "WAREHOUSE", mode: "DELTA", quantityDelta: -1, reason: "DAMAGED", note: "DEMO: 2 bags torn while stacking" });
    const found = await call<{ id: string }>("STORE", "post", "/api/stock-adjustments", { itemId: item.id, locationType: "WAREHOUSE", mode: "DELTA", quantityDelta: 2, reason: "FOUND_EXTRA", note: "DEMO: found behind the racks during the count" });
    await call("ACCOUNTS", "post", `/api/stock-adjustments/${found.id}/review`, { action: "APPROVE", note: "Checked on the shelf" });
    return "one correction is pending approval, one is approved";
  });

  // ---- 6. An approved-vendor rule (on the DEMO Rx product, whose lots are all from "DEMO Vendor")
  await part("Approved vendor", async () => {
    const po = await prisma.purchaseOrderItem.findFirst({ where: { productName: { startsWith: "DEMO Rx Powder" } }, orderBy: { createdAt: "desc" }, select: { id: true, purchaseOrder: { select: { customerId: true } } } });
    if (!po) return "run prisma/add-receive-demo.ts first (it makes the DEMO Rx product)";
    const vendor = (await prisma.vendor.findFirst({ where: { name: "DEMO Vendor" } })) ?? (await prisma.vendor.create({ data: { name: "DEMO Vendor", createdById: (await prisma.user.findFirstOrThrow({ where: { email: "admin@fls.local" } })).id } }));
    const plan = await prisma.rmPlan.findFirst({ where: { purchaseOrderItemId: po.id, status: "CALCULATED" }, select: { id: true, createdById: true } });
    if (!plan) return "the DEMO Rx product has no RM plan";
    let recipe = await prisma.recipe.findFirst({ where: { name: "DEMO Rx Powder Recipe", customerId: po.purchaseOrder.customerId } });
    if (!recipe) recipe = await prisma.recipe.create({ data: { name: "DEMO Rx Powder Recipe", customerId: po.purchaseOrder.customerId, totalServing: 30, ingredients: { create: [{ name: "DEMO Rx Whey", brand: "DEMO", gPerServing: 21, costPerKg: 0, sortOrder: 1 }, { name: "DEMO Rx Cocoa", brand: "DEMO", gPerServing: 9, costPerKg: 0, sortOrder: 2 }] } } });
    if (!(await prisma.rmPlanItem.findFirst({ where: { planId: plan.id, recipeId: recipe.id } }))) await prisma.rmPlanItem.create({ data: { planId: plan.id, recipeId: recipe.id, batchSizeKg: 100, addedById: plan.createdById } });
    await call("RND", "put", `/api/product-vendors/products/RM/${recipe.id}/materials`, { name: "DEMO Rx Whey", vendorIds: [vendor.id] });
    return "DEMO Rx Powder Recipe: whey may come only from DEMO Vendor (see Approved Vendors)";
  });
}

main().finally(() => prisma.$disconnect());
