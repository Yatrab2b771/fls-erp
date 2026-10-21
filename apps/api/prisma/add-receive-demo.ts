import request from "supertest";
import type { RoleName } from "@prisma/client";
import { createApp } from "../src/app";
import { prisma } from "../src/common/lib/prisma";
import { signAccessToken } from "../src/common/lib/jwt";

/**
 * Batches left waiting at Production's Receive step, to try Material Received by hand. Its own small scenario, so nothing existing is touched:
 * a "DEMO Rx" Plant with its own Day Store (the Plant holds NO material, so the Day Store has to send everything), three new materials,
 * and one product whose plan is split into three batches. Each batch goes through Indent Issue, Batch No and Dispensing; the Day Store
 * sends its material to the Plant and the batch waits there for Production to confirm it on Material Received. Safe to run again (it adds
 * another product each time).
 *
 *   npx tsx prisma/add-receive-demo.ts
 */
const app = createApp();
const tokens: Record<string, string> = {};

async function tokenFor(role: RoleName) {
  const user = await prisma.user.findFirstOrThrow({ where: { email: `${role.toLowerCase()}@fls.local` }, include: { roles: { include: { role: true } } } });
  tokens[role] = signAccessToken({ sub: user.id, roles: user.roles.map((r) => r.role.name), tokenVersion: user.tokenVersion });
  return user;
}

async function call<T = any>(role: RoleName, method: "get" | "post" | "patch", path: string, body?: unknown): Promise<T> {
  const req = request(app)[method](path).set("Authorization", `Bearer ${tokens[role]}`);
  const res = await (body === undefined ? req : req.send(body as object));
  if (![200, 201, 204].includes(res.status)) throw new Error(`${role} ${method.toUpperCase()} ${path} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T;
}

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function main() {
  for (const role of ["BD", "PRODUCTION", "RND", "STORE"] as RoleName[]) await tokenFor(role);
  const admin = await tokenFor("ADMIN");
  const customer = await prisma.customer.findFirstOrThrow({ where: { companyName: { startsWith: "DEMO" } }, orderBy: { createdAt: "asc" } });

  // Its own Plant and Day Store, with nothing in the Plant
  const dayStore = (await prisma.dayStore.findFirst({ where: { name: "DEMO Rx Day Store" } })) ?? (await prisma.dayStore.create({ data: { name: "DEMO Rx Day Store", createdById: admin.id } }));
  const plant = (await prisma.plant.findFirst({ where: { name: "DEMO Rx Plant" } })) ?? (await prisma.plant.create({ data: { name: "DEMO Rx Plant", createdById: admin.id, dayStoreId: dayStore.id } }));

  const ensureItem = async (category: "RM" | "PM", name: string, unit: string) =>
    (await prisma.inventoryItem.findFirst({ where: { category, name } })) ?? (await prisma.inventoryItem.create({ data: { category, name, unit } }));
  const whey = await ensureItem("RM", "DEMO Rx Whey", "Kg");
  const cocoa = await ensureItem("RM", "DEMO Rx Cocoa", "Kg");
  const tub = await ensureItem("PM", "DEMO Rx Tub", "Count");

  // The Warehouse receives them (QC accepted) and issues them to the Day Store, so the lots are on record
  for (const [item, qty, unit] of [[whey, 100, "Kg"], [cocoa, 30, "Kg"], [tub, 100, "Count"]] as const) {
    await prisma.inventoryTransaction.create({
      data: { itemId: item.id, createdById: admin.id, date: new Date(), unit, type: "RECEIVED", quantity: qty, vendorName: "DEMO Vendor", grnNo: `DEMO-RX-${Date.now()}-${item.name.slice(-3)}`, batchNo: "RX-LOT", receiptStatus: "ACCEPTED", acceptedById: admin.id, acceptedAt: new Date(), expiryDate: new Date(Date.now() + 365 * 86_400_000) },
    });
    await call("STORE", "post", "/api/inventory/transactions", { itemId: item.id, type: "ISSUED_DAY_STORE", date: new Date().toISOString(), unit, quantity: qty, dayStoreId: dayStore.id });
  }

  // A product ordered by the customer, planned for that Plant and sent to Production (both plans calculated)
  const stamp = Date.now().toString().slice(-6);
  const productName = `DEMO Rx Powder ${stamp}`;
  const po = await call("BD", "post", "/api/purchase-orders", { customerId: customer.id, poNumber: `DEMO-RX-${stamp}`, items: [{ productName, productCategory: "Powder", quantity: 100, unit: "KG" }] });
  await call("BD", "patch", `/api/purchase-orders/${po.id}/review`, { status: "APPROVED" });
  const itemId = po.items[0].id as string;
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved", planSentToProductionAt: new Date() } });
  await prisma.rmPlan.create({
    data: { name: `${productName} RM`, status: "CALCULATED", calculatedAt: new Date(), costingParams: {}, createdById: admin.id, purchaseOrderItemId: itemId, resultSnapshot: { procurement: [{ name: whey.name, totalKg: 100 }, { name: cocoa.name, totalKg: 30 }], batches: [] } },
  });
  await prisma.bomPlan.create({
    data: { name: `${productName} BOM`, status: "CALCULATED", calculatedAt: new Date(), createdById: admin.id, purchaseOrderItemId: itemId, resultSnapshot: { lines: [{ component: "Tub", itemName: tub.name, totalQty: 100 }], totalYield: 100 } },
  });

  const run = await call("PRODUCTION", "post", "/api/pre-productions", { purchaseOrderItemId: itemId, batchFlow: true, confirmNotReady: true });
  for (const qty of [30, 30, 30]) {
    const batch = await call<{ id: string }>("PRODUCTION", "post", `/api/pre-productions/${run.id}/production-batches`, { plannedQty: qty });
    await call("PRODUCTION", "post", `/api/production-batches/${batch.id}/indent`, { prodIndentSlipSign: "DEMO Production Head", productionPlanDate: day() });
    const allocated = await call<{ batchNo: string }>("RND", "post", `/api/production-batches/${batch.id}/batch-no/allocate`, {});
    await call("ADMIN", "post", `/api/production-batches/${batch.id}/dispense`, { rmDispensingDate: day(), pmIssuedDate: day(), dispensingRemarks: "DEMO: for trying Material Received" });
    console.log(`${allocated.batchNo} · ${productName} · ${qty} KG · ${plant.name} -> waiting at Receive`);
  }
  console.log("3 batches wait for Production on Material Received (Receive button).");
}

main().finally(() => prisma.$disconnect());
