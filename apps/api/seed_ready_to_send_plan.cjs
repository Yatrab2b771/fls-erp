// Seeds a PO product line right up to the edge of "Send Plan to
// Production" — PO created+approved, Plant assigned, BOM plan
// CALCULATED, Regulatory Approved — but deliberately stops there so you
// can click "Send Plan to Production" yourself in the browser to test it.
//
// Run from apps/api, with the dev servers already running:
//   node seed_ready_to_send_plan.cjs
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
  if (!sku) throw new Error("No SKU with a real packaging spec found in the catalog.");
  console.log(`Using product: "${sku.productName}" for customer "${sku.customer.companyName}"\n`);

  const bd = await login("bd@fls.local");
  const ppic = await login("ppic@fls.local");
  const regulatory = await login("regulatory@fls.local");

  const plant = await prisma.plant.findFirstOrThrow({ select: { id: true, name: true } });

  console.log("=== 1. BD creates + approves the PO ===");
  const po = await call("POST", "/purchase-orders", bd, {
    customerId: sku.customerId,
    poNumber: `SENDPLAN-DEMO-${Date.now()}`,
    orderDate: today(),
    items: [{ productName: sku.productName, quantity: 40, unit: "Kg", productType: "EXISTING" }],
  });
  await call("PATCH", `/purchase-orders/${po.id}/review`, bd, { status: "APPROVED" });
  const poItem = po.items[0];
  console.log(`  PO ${po.poNumber} approved`);

  console.log("\n=== 2. PPIC assigns Plant + Generates the BOM plan ===");
  await call("PATCH", `/purchase-orders/${po.id}/items/${poItem.id}/planned-plant`, ppic, { plantId: plant.id });
  const plan = await call("POST", "/bom/plans", ppic, { name: `${sku.productName} — send-plan test`, purchaseOrderItemId: poItem.id });
  if (plan.status !== "CALCULATED") throw new Error(`Expected the BOM plan to auto-calculate, got status=${plan.status}.`);
  console.log(`  BOM plan CALCULATED (Plant: ${plant.name})`);

  console.log("\n=== 3. Regulatory approves this product line ===");
  await call("PATCH", `/purchase-orders/${po.id}/items/${poItem.id}/regulatory-review`, regulatory, { status: "Approved", remarks: "Demo — approved for testing" });
  console.log("  Regulatory: Approved");

  console.log("\n=== READY — everything is in place EXCEPT 'Send Plan to Production' ===");
  console.log(`Open this PO as ppic@fls.local and click "Send Plan to Production" yourself:`);
  console.log(`  /purchase-orders/${po.id}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
