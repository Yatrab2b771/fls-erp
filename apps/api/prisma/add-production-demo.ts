import request from "supertest";
import type { RoleName } from "@prisma/client";
import { createApp } from "../src/app";
import { prisma } from "../src/common/lib/prisma";
import { signAccessToken } from "../src/common/lib/jwt";
import { savePmBom } from "../src/modules/packaging-bom/bom-versions";
import { saveRecipe } from "../src/modules/rm-costing/recipe-catalog.routes";

/**
 * Fresh work for every Production tile, on every Plant that has a Production login (Day Store 22, 41, 48, 59), so each action can be tried by
 * hand: a plan whose run Production has not started (New Plan), a batch waiting at Indent Issue, one at Material Received (the Day Store has
 * sent it, Production has not confirmed), one READY to start (Batch), one waiting at Packaging, one whose packaging is saved and now waits for QA's
 * approval (Waiting For QA), one QA has approved and Production hands over to the store (Approved By QA), a product on hold (Held Products), an open Extra Material request, and a customer return waiting for rework (Rework).
 * Plant Stock and the Production Report fill from the batches. Everything goes through the real API; nothing is deleted. Adds a new set each run.
 *
 *   npx tsx prisma/add-production-demo.ts                      (every scenario)
 *   npx tsx prisma/add-production-demo.ts "Material Received"  (only the named scenarios, no Extra Material or Rework)
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
  if (![200, 201, 204].includes(res.status)) throw new Error(`${role} ${method.toUpperCase()} ${path} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body as T;
}

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** The Store receives what the Warehouse issued it (it is in transit until then): Admin acts as the Store. */
const receiveAtStore = (txn: { id: string }) => call("ADMIN", "post", `/api/inventory/transactions/${txn.id}/confirm-delivery`, {});

const RM: [string, number][] = [["DEMO Whey Isolate", 0.7], ["DEMO Cocoa Powder", 0.2], ["DEMO Sweetener", 0.1]];
const PM: [string, number][] = [["DEMO Tub 1kg", 1], ["DEMO Front Label", 1], ["DEMO Shipper Carton", 12]];

/** How far each product goes. `prep` is the step the batch has reached; `done` is how many of the 8 QC / packaging steps are finished. */
type Scenario = { label: string; run: "none" | "started" | "batch"; prep?: "indent" | "dispensed" | "received"; done?: number; packed?: boolean; approved?: boolean; fgApproved?: boolean; hold?: boolean; atDayStore?: boolean; started?: boolean; unsent?: boolean };
const only = process.argv.slice(2);
const ALL_SCENARIOS: Scenario[] = [
  { label: "New Plan", run: "none" },
  { label: "New Plan Two", run: "none" },
  { label: "Held", run: "started", hold: true },
  { label: "Indent Issue", run: "batch", prep: "indent" },
  { label: "Material Received", run: "batch", prep: "dispensed", atDayStore: true }, // the Plant holds none: dispensing sends the Store's material, which Production must confirm
  { label: "Batch Ready", run: "batch", prep: "received" },
  { label: "In Process QA", run: "batch", prep: "received", started: true }, // started: at In-Process QA, still in production
  { label: "Back With Production", run: "batch", prep: "received", done: 3, unsent: true }, // Bulk QC passed: Utilization, end time and Send to Packaging are Production's
  { label: "Packaging", run: "batch", prep: "received", done: 3 },
  { label: "Waiting For QA", run: "batch", prep: "received", done: 3, packed: true }, // the Packaging save sent it to QA's packaging gate
  { label: "Approved By QA", run: "batch", prep: "received", done: 3, packed: true, approved: true }, // QA approved: Production's "Handover to Store" is the next action
  { label: "FG Approved", run: "batch", prep: "received", done: 3, packed: true, approved: true, fgApproved: true }, // handed to the Store, received, and QA approved the finished goods: the Store's "Hand over to Dispatch" is next
];
const SCENARIOS = only.length ? ALL_SCENARIOS.filter((s) => only.includes(s.label)) : ALL_SCENARIOS;

async function itemIdOf(category: "RM" | "PM", name: string) {
  const item = await prisma.inventoryItem.findUnique({ where: { category_name: { category, name } } });
  if (!item) throw new Error(`${name} is missing: run prisma/seed-clean-flow.ts first`);
  return item.id;
}

/** A material this Plant has never held: the Warehouse receives it (R&D passes it into stock) so a batch using it must have it sent from the Day Store. */
async function newMaterial(name: string): Promise<string> {
  const item = await call<{ id: string }>("STORE", "post", "/api/inventory/items", { category: "RM", name, unit: "Kg" });
  const txn = await call<{ id: string }>("STORE", "post", "/api/inventory/transactions", { itemId: item.id, type: "RECEIVED", date: day(-3), unit: "Kg", quantity: 1000, vendorName: "DEMO Vendor", grnNo: `DEMO-GRN-${name.slice(-9)}`, batchNo: "DEMO-LOT" });
  await call("RND", "patch", `/api/inventory/transactions/${txn.id}/qc`, { action: "APPROVE", samplingDate: day(-2) });
  return item.id;
}

async function ensureCatalog(customerId: string, productName: string, userId: string, pmIds: Map<string, string>, extraRm?: string) {
  if (!(await prisma.recipe.findFirst({ where: { customerId, name: productName } }))) {
    const rm: [string, number][] = extraRm ? [...RM, [extraRm, 0.1]] : RM;
    await saveRecipe({ name: productName, customerId, kind: "PER_KG", batchSize: 100, ingredients: rm.map(([name, q]) => ({ name, brand: "DEMO", itemCode: undefined, gPerServing: q, proteinPct: 0 })) }, "DEMO: first version", userId);
  }
  let sku = await prisma.sku.findFirst({ where: { customerId, productName } });
  if (!sku) sku = await prisma.sku.create({ data: { customerId, productName } });
  if (!(await prisma.skuPackagingComponent.findFirst({ where: { skuId: sku.id } }))) {
    await savePmBom(sku.id, { header: { packSize: "1 kg", batchPacks: 100 }, components: PM.map(([type, q]) => ({ type, quantity: q, unit: "Nos", pmItemId: pmIds.get(type)!, pmCode: null, overagePct: type.includes("Carton") ? 0 : 0.02 })) }, "DEMO: first version", userId);
  }
}

/** The plan's material reaches the Plant: the Warehouse issues it to the Day Store, which approves each request and issues it on (Admin acts as the Day Store). */
async function materialToPlant(purchaseOrderItemId: string, issueToPlant = true) {
  const requests = await prisma.inventoryRequest.findMany({ where: { purchaseOrderItemId, deletedAt: null, status: { in: ["PENDING", "APPROVED"] } }, include: { item: { select: { unit: true } } } });
  for (const r of requests) {
    const unit = r.item.unit ?? (r.category === "RM" ? "Kg" : "Nos");
    const plant = r.plantId ? await prisma.plant.findUnique({ where: { id: r.plantId }, select: { dayStoreId: true } }) : null;
    const dayStoreId = r.requestingDayStoreId ?? plant?.dayStoreId;
    if (!dayStoreId) throw new Error(`Request ${r.id} has no Store to send the material to.`);
    await receiveAtStore(await call<{ id: string }>("STORE", "post", "/api/inventory/transactions", { itemId: r.itemId, type: "ISSUED_DAY_STORE", date: day(-3), unit, quantity: r.requestedQty, dayStoreId }));
    if (!issueToPlant) continue; // the Store holds it all but has not sent it to the Plant yet
    if (r.status === "PENDING") await call("ADMIN", "patch", `/api/inventory/requests/${r.id}/review`, { action: "APPROVE" });
    await call("ADMIN", "post", `/api/inventory/requests/${r.id}/issue`, { date: day(-2), unit, quantity: r.requestedQty, dayStoreId });
  }
}

async function receiveAll(batchId: string) {
  const board = await call<{ id: string; receiveLines?: { lineId: string }[] }[]>("ADMIN", "get", "/api/production-batches/prep-board?stage=RECEIVE");
  const row = board.find((r) => r.id === batchId);
  if (row?.receiveLines?.length) await call("ADMIN", "post", `/api/production-batches/${batchId}/receive`, { lines: row.receiveLines.map((l) => ({ lineId: l.lineId, action: "RECEIVE" })) });
}

async function runBatch(runId: string, s: Scenario) {
  const batch = await call<{ id: string }>("PRODUCTION", "post", `/api/pre-productions/${runId}/production-batches`, { plannedQty: 100 });
  if (s.prep === "indent") return batch.id;
  await call("PRODUCTION", "post", `/api/production-batches/${batch.id}/indent`, { prodIndentSlipSign: "DEMO Production Head", productionPlanDate: day(-1) });
  await call("RND", "post", `/api/production-batches/${batch.id}/batch-no/allocate`, {});
  await call("ADMIN", "post", `/api/production-batches/${batch.id}/dispense`, { rmDispensingDate: day(-1), pmIssuedDate: day(-1), dispensingRemarks: "DEMO: batch material dispensed" });
  if (s.prep === "dispensed") return batch.id;
  await receiveAll(batch.id);
  if (!s.done && !s.started) return batch.id;

  // Production starts the batch (the start fields): it is then at In-Process QA, still in production. QA / R&D take it through the QA Gate and Bulk QC;
  // it then comes back to Production for the RM Utilization of the whole batch, the end time and Send to Packaging, and Packaging if asked. (The
  // packed scenarios use 90% of the RM it was given, so the Plant has leftover.)
  const start = new Date(Date.now() - 2 * 86_400_000);
  await call("PRODUCTION", "patch", `/api/production-batches/${batch.id}`, { shift: "Day", manpowerCount: 8, shiftStartAt: start.toISOString() });
  if (!s.done) return batch.id; // "In Process QA": started, waiting at In-Process QA
  const util = (await call<{ id: string; utilization: { items: { itemId: string; category: string; givenQty: number }[] } }[]>("PRODUCTION", "get", `/api/pre-productions/${runId}/production-batches`)).find((b) => b.id === batch.id)!.utilization.items;
  const saveUtilization = (category: "RM" | "PM") =>
    call("PRODUCTION", "put", `/api/production-batches/${batch.id}/utilization/${category}`, { producedQty: 100, wasteQty: 0, rejectQty: 0, sampleQty: 0, lines: util.filter((x) => x.category === category).map((n) => ({ itemId: n.itemId, consumedQty: category === "RM" && s.packed ? Math.round(n.givenQty * 0.9 * 1000) / 1000 : n.givenQty })) });
  const step = (role: RoleName, body: Record<string, unknown>) => call(role, "patch", `/api/production-batches/${batch.id}/stage`, { action: "FORWARD", ...body });
  await step("QA_QC", { ipqcStatus: "Approved", ipqcRemarks: "DEMO: checks fine" });
  await step("QA_QC", { mfgQaStatus: "Approved", mfgQcStatus: "Approved", mfgApprovedQty: 100, mfgRejectedQty: 0, mfgWastageQty: 0 });
  await step("RND", { bulkQcStatus: "Approved", bulkQcRemarks: "DEMO: bulk passed" });
  if (s.unsent) return batch.id; // Bulk QC has passed: the Utilization, end time and Send to Packaging are still Production's
  await saveUtilization("RM");
  await call("PRODUCTION", "patch", `/api/production-batches/${batch.id}`, { shiftEndAt: new Date(start.getTime() + 9 * 3_600_000).toISOString(), manufacturingStatus: "Completed" });
  await call("PRODUCTION", "post", `/api/production-batches/${batch.id}/complete`, {});
  if (s.packed) {
    // The PM Utilization and the packaging sheet are filled: saving the finished sheet sends the batch to QA's packaging gate by itself
    await saveUtilization("PM");
    await call("PRODUCTION", "patch", `/api/production-batches/${batch.id}/packaging`, { packagingShift: "Day", packagingManpowerCount: 6, packagingStartAt: new Date(Date.now() - 86_400_000).toISOString(), packagingEndAt: new Date().toISOString(), packagingStatus: "Completed", packagingRemarks: "DEMO: packed" });
    // QA approves the packaging gate: the goods wait at FG Store for Production to hand them over to the store
    if (s.approved) await step("QA_QC", { packQaStatus: "Approved", packQcStatus: "Approved", packApprovedQty: 100, packRejectedQty: 0, packWastageQty: 0 });
    if (s.fgApproved) {
      // Production hands the approved packed goods to the Store, the Store receives them, and QA approves the finished goods: they now wait for the Store to hand them to Dispatch
      await call("PRODUCTION", "post", `/api/production-batches/${batch.id}/handover-to-store`, {});
      await step("ADMIN", { fgStoreReceivedDate: day(0), fgStoreRemarks: "DEMO: 100 tubs counted" });
      await step("QA_QC", { fgQaStatus: "Approved", fgQcStatus: "Approved", fgRemarks: "DEMO: released by QA" });
    }
  }
  return batch.id;
}

async function main() {
  const admin = await tokenFor("ADMIN");
  for (const role of ["BD", "PPIC", "RND", "REGULATORY", "STORE", "PRODUCTION", "QA_QC", "DISPATCH", "ACCOUNTS"] as RoleName[]) await tokenFor(role);

  const customer = (await prisma.customer.findFirst({ where: { companyName: "DEMO Beta Wellness" } })) ?? (await prisma.customer.findFirstOrThrow({ where: { companyName: { startsWith: "DEMO" } } }));
  const pmIds = new Map<string, string>();
  for (const [n] of PM) pmIds.set(n, await itemIdOf("PM", n));
  const cocoa = await itemIdOf("RM", "DEMO Cocoa Powder");

  // PLANT="Store 22" limits the run to one Plant (a single demo entry instead of one per Plant)
  const onlyPlant = process.env.PLANT?.trim();
  const plants = await prisma.plant.findMany({ where: { name: { in: onlyPlant ? [onlyPlant] : ["Store 22", "Store 41", "Store 48", "Store 59"] }, dayStoreId: { not: null } }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  if (plants.length === 0) throw new Error("No Plant named Store 22/41/48/59 with a Store");
  const stamp = Date.now().toString().slice(-6);

  for (const plant of plants) {
    const tag = plant.name.replace("Store ", "");
    const names = SCENARIOS.map((s) => `DEMO P${tag} ${s.label} ${stamp}`);
    for (const [i, name] of names.entries()) {
      const extraRm = SCENARIOS[i]!.atDayStore ? `DEMO Rx Mix P${tag} ${stamp}` : undefined;
      if (extraRm) await newMaterial(extraRm);
      await ensureCatalog(customer.id, name, admin.id, pmIds, extraRm);
    }
    const po = await call<{ id: string; items: { id: string; productName: string }[] }>("BD", "post", "/api/purchase-orders", {
      customerId: customer.id,
      poNumber: `DEMO-PROD-${tag}-${stamp}`,
      orderDate: day(-5),
      expectedDeliveryDate: day(30),
      regulatoryBody: "FSSAI",
      regulatoryStatus: "Issued",
      items: names.map((productName) => ({ productName, productCategory: "Powder", quantity: 100, unit: "KG", packSize: "1 kg" })),
    });
    await call("BD", "patch", `/api/purchase-orders/${po.id}/review`, { status: "APPROVED" });

    let extraBatchId: string | null = null; // a numbered batch of this Plant, for the Extra Material request
    for (const [i, s] of SCENARIOS.entries()) {
      const item = po.items.find((x) => x.productName === names[i])!;
      try {
        await call("PPIC", "patch", `/api/purchase-orders/${po.id}/items/${item.id}/planned-plant`, { plantId: plant.id });
        await call("PPIC", "post", "/api/rm-costing/plans", { name: `${item.productName} — RM Costing`, purchaseOrderItemId: item.id });
        await call("PPIC", "post", "/api/bom/plans", { name: `${item.productName} — BOM`, purchaseOrderItemId: item.id });
        await call("REGULATORY", "patch", `/api/purchase-orders/${po.id}/items/${item.id}/regulatory-review`, { status: "Approved", remarks: "DEMO: approved" });
        await call("PPIC", "post", `/api/purchase-orders/${po.id}/items/${item.id}/send-plan-to-production`, {});
        if (s.run === "none") {
          console.log(`OK    ${plant.name} · ${s.label}: sent to Production, run not started`);
          continue;
        }
        await materialToPlant(item.id, !s.atDayStore);
        const run = await call<{ id: string }>("PRODUCTION", "post", "/api/pre-productions", { purchaseOrderItemId: item.id, batchFlow: true });
        if (s.run === "batch") {
          const batchId = await runBatch(run.id, s);
          if (s.label === "Batch Ready") extraBatchId = batchId;
        }
        if (s.hold) await call("PRODUCTION", "patch", `/api/production-batches/products/${item.id}/hold`, { held: true, reason: "DEMO: waiting for the customer's artwork approval" });
        console.log(`OK    ${plant.name} · ${s.label}`);
      } catch (err) {
        console.log(`SKIP  ${plant.name} · ${s.label}: ${err instanceof Error ? err.message.slice(0, 300) : err}`);
      }
    }

    // Extra Material: a request outside the plan for one batch (the numbered one waiting to start), still open
    if (only.length) continue;
    try {
      if (!extraBatchId) throw new Error("no numbered batch to ask the material for");
      await call("PRODUCTION", "post", "/api/inventory/extra-requests", { itemId: cocoa, requestedQty: 20, reason: `DEMO: extra cocoa for ${plant.name}`, productionBatchId: extraBatchId, neededBy: day(3) });
      console.log(`OK    ${plant.name} · Extra Material: request open`);
    } catch (err) {
      console.log(`SKIP  ${plant.name} · Extra Material: ${err instanceof Error ? err.message.slice(0, 300) : err}`);
    }
  }

  if (only.length) return;
  // Rework: a shipped batch comes back from the customer and QA sends it for rework (Production's Rework tile)
  try {
    const returnable = await call<{ batchId: string; batchNo: string | null; withCustomerQty: number; productName: string }[]>("STORE", "get", "/api/customer-returns/returnable");
    const pick = returnable.find((r) => r.withCustomerQty >= 4);
    if (!pick) throw new Error("no shipped batch to take a return from");
    const rec = await call<{ id: string }>("STORE", "post", "/api/customer-returns", { batchId: pick.batchId, quantity: Math.min(5, Math.floor(pick.withCustomerQty / 2)), reason: "Tubs dented, powder caked", condition: "Cartons dented", returnedAt: day(-1) });
    await call("QA_QC", "post", `/api/customer-returns/${rec.id}/qa`, { decision: "REWORK", note: "Re-sieve and re-pack" });
    console.log(`OK    Rework: ${pick.productName} ${pick.batchNo ?? ""} is waiting for rework`);
  } catch (err) {
    console.log(`SKIP  Rework: ${err instanceof Error ? err.message.slice(0, 300) : err}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
