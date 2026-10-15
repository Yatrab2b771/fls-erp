// Seeds ONE full end-to-end run through the new Regulatory + Line
// Clearance + BMR Report pipeline, so it can be manually checked in the
// browser:
//   PO created -> BD approves -> PPIC assigns Plant + Generates BOM plan
//   (auto-CALCULATED, matches an existing catalog SKU) -> Regulatory
//   approves the product line -> PPIC sends the plan to Production ->
//   Production opens the run -> Store/Production/QA walk it through
//   Material Received -> Indent Issue -> Dispensing -> Line Clearance
//   (Bulk Mfg) -> Production Batch created, completed -> IPQC -> QA Gate
//   Mfg -> Bulk QC -> ready for Packaging.
//
// Run from apps/api, with the dev servers already running:
//   node seed_regulatory_bmr_demo.cjs
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const BASE = "http://localhost:4000/api";

async function call(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function login(email, password = "Demo1234!") {
  const r = await call("POST", "/auth/login", null, { email, password });
  return r.token;
}

const today = () => new Date().toISOString().slice(0, 10);

async function main() {
  console.log("Picking a catalog SKU that already has a real BOM spec...");
  const sku = await prisma.sku.findFirst({
    where: { OR: [{ jar: { not: null } }, { corrugatedBoxMm: { not: null } }, { packagingComponents: { some: {} } }] },
    include: { customer: true },
  });
  if (!sku) throw new Error("No SKU with a real packaging spec found in the catalog — can't auto-generate a BOM plan.");
  console.log(`Using product: "${sku.productName}" for customer "${sku.customer.companyName}"\n`);

  console.log("Logging in as every role involved...");
  const bd = await login("bd@fls.local");
  const ppic = await login("ppic@fls.local");
  const regulatory = await login("regulatory@fls.local");
  const production = await login("production@fls.local");
  const store = await login("store@fls.local");
  const qaQc = await login("qa_qc@fls.local");

  const plants = await prisma.plant.findMany({ select: { id: true, name: true }, take: 1 });
  if (plants.length === 0) throw new Error("No Plant found — create one first.");
  const plant = plants[0];

  console.log("=== 1. BD creates + approves the PO ===");
  const po = await call("POST", "/purchase-orders", bd, {
    customerId: sku.customerId,
    poNumber: `BMR-DEMO-${Date.now()}`,
    orderDate: today(),
    items: [{ productName: sku.productName, quantity: 40, unit: "Kg", productType: "EXISTING" }],
  });
  await call("PATCH", `/purchase-orders/${po.id}/review`, bd, { status: "APPROVED" });
  const poItem = po.items[0];
  console.log(`  PO ${po.poNumber} approved — item ${poItem.id}`);

  console.log("\n=== 2. PPIC assigns Plant + Generates the BOM plan ===");
  await call("PATCH", `/purchase-orders/${po.id}/items/${poItem.id}/planned-plant`, ppic, { plantId: plant.id });
  const plan = await call("POST", "/bom/plans", ppic, { name: `${sku.productName} — BMR demo`, purchaseOrderItemId: poItem.id });
  if (plan.status !== "CALCULATED") throw new Error(`Expected the BOM plan to auto-calculate, got status=${plan.status}. Try a different SKU.`);
  console.log(`  BOM plan ${plan.id} — CALCULATED (${plan.result?.totalYield ?? "?"} total yield)`);

  console.log("\n=== 3. Regulatory approves this product line ===");
  await call("PATCH", `/purchase-orders/${po.id}/items/${poItem.id}/regulatory-review`, regulatory, { status: "Approved", remarks: "Demo — approved for testing" });
  console.log("  Regulatory: Approved");

  console.log("\n=== 4. PPIC sends the plan to Production ===");
  await call("POST", `/purchase-orders/${po.id}/items/${poItem.id}/send-plan-to-production`, ppic, {});
  console.log("  Plan sent to Production");

  console.log("\n=== 5. Production opens the run and walks it toward Dispensing ===");
  const pp = await call("POST", "/pre-productions", production, { purchaseOrderItemId: poItem.id, confirmNotReady: true });
  await call("PATCH", `/pre-productions/${pp.id}/stage`, store, { action: "FORWARD", grnNo: "BMR-DEMO-GRN", grnDate: today() });
  await call("PATCH", `/pre-productions/${pp.id}/stage`, production, { action: "FORWARD", prodIndentSlipSign: "Signed (demo)", unit: "22" });
  console.log(`  Pre-Production ${pp.id} — now at Dispensing`);

  console.log("\n=== 5b. Fund the Plant's stock for whatever this run's BOM actually requires ===");
  const { items: requirements } = await call("GET", `/pre-productions/${pp.id}/dispensing-requirements`, store);
  if (requirements.length > 0) {
    const storeUser = await prisma.user.findUniqueOrThrow({ where: { email: "store@fls.local" }, select: { id: true } });
    await prisma.inventoryTransaction.createMany({
      data: requirements.map((r) => ({
        itemId: r.itemId,
        type: "ISSUED_PRODUCTION",
        date: new Date(),
        unit: r.unit,
        quantity: r.requiredQty * 2,
        plantId: plant.id,
        deliveredAt: new Date(),
        remark: "Demo stock funding — BMR seed script",
        createdById: storeUser.id,
      })),
    });
    console.log(`  Funded ${requirements.length} item(s) at ${plant.name}`);
  }

  console.log("\n=== 5c. Store logs Dispensing consumption, run moves to Line Clearance (Bulk Mfg) ===");
  const consumption = requirements.map((r) => ({ itemId: r.itemId, quantity: r.requiredQty, unit: r.unit, purpose: "PRODUCTION" }));
  await call("PATCH", `/pre-productions/${pp.id}/stage`, store, { action: "FORWARD", rmDispensingDate: today(), pmIssuedDate: today(), consumption });
  console.log(`  Pre-Production ${pp.id} — now at Line Clearance (Bulk Manufacturing)`);

  console.log("\n=== 6. Production fills the Line Clearance checklist, QA approves ===");
  const ppFull = await call("GET", `/pre-productions/${pp.id}`, qaQc);
  const bulkKeys = (ppFull.bulkMfgLineClearanceChecklist || []).map((r) => r.itemKey);
  if (bulkKeys.length > 0) {
    const items = bulkKeys.map((itemKey) => ({ itemKey, ok: true }));
    await call("PATCH", `/pre-productions/${pp.id}/checklist`, production, { column: "DEPT", items });
    await call("PATCH", `/pre-productions/${pp.id}/checklist`, qaQc, { column: "QA", items });
  }
  await call("PATCH", `/pre-productions/${pp.id}/stage`, qaQc, { action: "FORWARD", sampleQcStatus: "Approved" });
  console.log("  Line Clearance — Approved. Ready for 'Create Production Batch'.");

  console.log("\n=== 7. Production creates + completes the batch ===");
  const batch = await call("POST", `/pre-productions/${pp.id}/production-batches`, production, { plannedQty: 40, batchNo: "BMR-DEMO-B1" });
  await call("PATCH", `/production-batches/${batch.id}`, production, {
    manufacturingStartDate: today(),
    manufacturingEndDate: today(),
    manufacturingStatus: "Completed",
    inputQty: 40,
    outputQty: 38,
  });
  await call("POST", `/production-batches/${batch.id}/complete`, production, {});
  console.log(`  Production Batch ${batch.id} — COMPLETED`);

  console.log("\n=== 8. QA walks it through IPQC -> QA Gate Mfg -> Bulk QC ===");
  await call("PATCH", `/production-batches/${batch.id}/stage`, qaQc, { action: "FORWARD", ipqcStatus: "Approved" });
  await call("PATCH", `/production-batches/${batch.id}/stage`, qaQc, { action: "FORWARD", mfgQaStatus: "Approved", mfgQcStatus: "Approved" });
  await call("PATCH", `/production-batches/${batch.id}/stage`, qaQc, { action: "FORWARD", bulkQcStatus: "Approved" });
  console.log("  Now sitting at Packaging — ready.");

  console.log("\n=== DONE ===");
  console.log(`Purchase Order: /purchase-orders/${po.id}`);
  console.log(`Pre-Production run: /pre-productions/${pp.id}`);
  console.log(`Production Batch (download BMR Report here): /production-batches/${batch.id}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
