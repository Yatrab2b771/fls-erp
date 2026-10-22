import request from "supertest";
import type { RoleName } from "@prisma/client";
import { createApp } from "../src/app";
import { prisma } from "../src/common/lib/prisma";
import { signAccessToken } from "../src/common/lib/jwt";

/**
 * One product of a PO, one batch, taken through everything up to the END TIME of its production sheet, so the end time, status, remarks and
 * Mark Completed can be tried by hand: Indent, Batch No, Dispensing, Receive, Line Clearance, the start fields (shift, manpower, start time)
 * and the raw-material Utilization are all done. Runs on one of the real Plants (no extra Day Store is made; name the Plant as the first argument, default Day Store 22).
 * Safe to run again (it adds another product each time).
 *
 *   npx tsx prisma/add-end-time-demo.ts
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
/** The Store receives what the Warehouse issued it (it is in transit until then): Admin acts as the Store. */
const receiveAtStore = (txn: { id: string }) => call("ADMIN", "post", `/api/inventory/transactions/${txn.id}/confirm-delivery`, {});


async function main() {
  for (const role of ["BD", "PRODUCTION", "RND", "STORE", "QA_QC"] as RoleName[]) await tokenFor(role);
  const admin = await tokenFor("ADMIN");
  const customer = await prisma.customer.findFirstOrThrow({ where: { companyName: { startsWith: "DEMO" } }, orderBy: { createdAt: "asc" } });

  // One of the real Plants (no extra Day Store is made). Name another Plant as the first argument; default Day Store 22.
  const plantName = process.argv[2] ?? "Store 22";
  const plant = await prisma.plant.findFirstOrThrow({ where: { name: plantName, dayStoreId: { not: null } } });
  const dayStore = await prisma.dayStore.findUniqueOrThrow({ where: { id: plant.dayStoreId! } });

  const ensureItem = async (category: "RM" | "PM", name: string, unit: string) =>
    (await prisma.inventoryItem.findFirst({ where: { category, name } })) ?? (await prisma.inventoryItem.create({ data: { category, name, unit } }));
  const oats = await ensureItem("RM", "DEMO End Oats", "Kg");
  const honey = await ensureItem("RM", "DEMO End Honey", "Kg");
  const pouch = await ensureItem("PM", "DEMO End Pouch", "Count");

  // Material in the Day Store: received, QC accepted, issued to the Day Store
  for (const [item, qty, unit] of [[oats, 80, "Kg"], [honey, 25, "Kg"], [pouch, 100, "Count"]] as const) {
    await prisma.inventoryTransaction.create({
      data: { itemId: item.id, createdById: admin.id, date: new Date(), unit, type: "RECEIVED", quantity: qty, vendorName: "DEMO Vendor", grnNo: `DEMO-END-${Date.now()}-${item.name.slice(-3)}`, batchNo: "END-LOT", receiptStatus: "ACCEPTED", acceptedById: admin.id, acceptedAt: new Date(), expiryDate: new Date(Date.now() + 365 * 86_400_000) },
    });
    await receiveAtStore(await call<{ id: string }>("STORE", "post", "/api/inventory/transactions", { itemId: item.id, type: "ISSUED_DAY_STORE", date: new Date().toISOString(), unit, quantity: qty, dayStoreId: dayStore.id }));
  }

  // The PO and its product, planned for that Plant and sent to Production
  const stamp = Date.now().toString().slice(-6);
  const productName = `DEMO End Oat Mix ${stamp}`;
  const po = await call("BD", "post", "/api/purchase-orders", { customerId: customer.id, poNumber: `DEMO-END-${stamp}`, items: [{ productName, productCategory: "Powder", quantity: 60, unit: "KG" }] });
  await call("BD", "patch", `/api/purchase-orders/${po.id}/review`, { status: "APPROVED" });
  const itemId = po.items[0].id as string;
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { plannedPlantId: plant.id, regulatoryStatus: "Approved", planSentToProductionAt: new Date() } });
  await prisma.rmPlan.create({
    data: { name: `${productName} RM`, status: "CALCULATED", calculatedAt: new Date(), costingParams: {}, createdById: admin.id, purchaseOrderItemId: itemId, resultSnapshot: { procurement: [{ name: oats.name, totalKg: 60 }, { name: honey.name, totalKg: 18 }], batches: [] } },
  });
  await prisma.bomPlan.create({
    data: { name: `${productName} BOM`, status: "CALCULATED", calculatedAt: new Date(), createdById: admin.id, purchaseOrderItemId: itemId, resultSnapshot: { lines: [{ component: "Pouch", itemName: pouch.name, totalQty: 60 }], totalYield: 60 } },
  });

  // One batch for the whole product, through every step before production
  const run = await call("PRODUCTION", "post", "/api/pre-productions", { purchaseOrderItemId: itemId, batchFlow: true, confirmNotReady: true });
  const batch = await call<{ id: string }>("PRODUCTION", "post", `/api/pre-productions/${run.id}/production-batches`, { plannedQty: 60 });
  await call("PRODUCTION", "post", `/api/production-batches/${batch.id}/indent`, { prodIndentSlipSign: "DEMO Production Head", productionPlanDate: day() });
  const allocated = await call<{ batchNo: string }>("RND", "post", `/api/production-batches/${batch.id}/batch-no/allocate`, {});
  await call("ADMIN", "post", `/api/production-batches/${batch.id}/dispense`, { rmDispensingDate: day(), pmIssuedDate: day(), dispensingRemarks: "DEMO: for trying the end time" });
  const pending = await prisma.batchDispensingLine.findMany({ where: { productionBatchId: batch.id, deliveryStatus: "PENDING" } });
  await call("PRODUCTION", "post", `/api/production-batches/${batch.id}/receive`, { lines: pending.map((l) => ({ lineId: l.id, action: "RECEIVE" })) });

  // Production starts the batch (8 hours ago) ...
  const started = new Date(Date.now() - 8 * 3_600_000).toISOString();
  await call("PRODUCTION", "patch", `/api/production-batches/${batch.id}`, { shift: "Day", manpowerCount: 6, shiftStartAt: started });

  console.log(`${allocated.batchNo} · ${productName} · 60 KG · ${plant.name}`);
  console.log("Cleared, started (Day shift, 6 people) Left for you: End date and time + bulk output -> Mark Completed (Production > Batch).");
}

main().finally(() => prisma.$disconnect());
