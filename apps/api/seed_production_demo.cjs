// Seeds real, live pending work at every Production checkpoint:
// 1. Indent Issue — pending
// 2. Ready to create a Production Batch (Sample QC already Approved)
// 3. A Production Batch created but not yet completed (output qty pending)
// 4. A Production Batch sitting at Packaging (Bulk QC already cleared)
//
// Run from apps/api, with the dev servers already running:
//   node seed_production_demo.cjs
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

async function createApprovedPo(bd, customerId, productName, qty, tag) {
  const po = await call("POST", "/purchase-orders", bd, {
    customerId,
    poNumber: `PROD-DEMO-${tag}-${Date.now()}`,
    orderDate: today(),
    items: [{ productName, quantity: qty, unit: "Kg", productType: "EXISTING" }],
  });
  await call("PATCH", `/purchase-orders/${po.id}/review`, bd, { status: "APPROVED" });
  return po.items[0].id;
}

async function walkToReadyForBatch(roles, poItemId) {
  const { production, qaQc, store } = roles;
  const pp = await call("POST", "/pre-productions", production, { purchaseOrderItemId: poItemId, confirmNotReady: true });
  await call("PATCH", `/pre-productions/${pp.id}/stage`, store, { action: "FORWARD", grnNo: "PROD-DEMO-GRN", grnDate: today() });
  await call("PATCH", `/pre-productions/${pp.id}/stage`, production, { action: "FORWARD", prodIndentSlipSign: "Signed (demo)", unit: "22" });
  await call("PATCH", `/pre-productions/${pp.id}/stage`, qaQc, { action: "FORWARD", lineClearanceStatus: "Approved" });
  await call("PATCH", `/pre-productions/${pp.id}/stage`, store, { action: "FORWARD", rmDispensingDate: today(), pmIssuedDate: today() });
  await call("PATCH", `/pre-productions/${pp.id}/stage`, qaQc, { action: "FORWARD", sampleQcStatus: "Approved" });
  return pp;
}

async function main() {
  console.log("Logging in...");
  const bd = await login("bd@fls.local");
  const production = await login("production@fls.local");
  const qaQc = await login("qa_qc@fls.local");
  const store = await login("store@fls.local");
  const roles = { production, qaQc, store };

  const customers = await call("GET", "/customers?limit=1", bd);
  const customerId = customers[0].id;
  console.log(`Using customer: ${customers[0].companyName}\n`);

  console.log("=== 1. Indent Issue — pending ===");
  const poItem1 = await createApprovedPo(bd, customerId, "Prod Demo - Indent Issue", 30, "IND");
  const pp1 = await call("POST", "/pre-productions", production, { purchaseOrderItemId: poItem1, confirmNotReady: true });
  await call("PATCH", `/pre-productions/${pp1.id}/stage`, store, { action: "FORWARD", grnNo: "PROD-DEMO-GRN-1", grnDate: today() });
  console.log(`  Pre-Production ${pp1.id} — pending Indent Issue`);

  console.log("\n=== 2. Ready to create a Production Batch ===");
  const poItem2 = await createApprovedPo(bd, customerId, "Prod Demo - Ready for Batch", 50, "BATCH");
  const pp2 = await walkToReadyForBatch(roles, poItem2);
  console.log(`  Pre-Production ${pp2.id} — Sample QC Approved, ready for "Create Production Batch"`);

  console.log("\n=== 3. Production Batch created, output qty pending ===");
  const poItem3 = await createApprovedPo(bd, customerId, "Prod Demo - Complete Run", 45, "COMPLETE");
  const pp3 = await walkToReadyForBatch(roles, poItem3);
  const batch3 = await call("POST", `/pre-productions/${pp3.id}/production-batches`, production, { plannedQty: 45, batchNo: "PROD-DEMO-B3" });
  console.log(`  Production Batch ${batch3.id} — created, IN_PROGRESS, needs output qty + Complete`);

  console.log("\n=== 4. Production Batch at Packaging (Bulk QC already cleared) ===");
  const poItem4 = await createApprovedPo(bd, customerId, "Prod Demo - Packaging", 40, "PACK");
  const pp4 = await walkToReadyForBatch(roles, poItem4);
  const batch4 = await call("POST", `/pre-productions/${pp4.id}/production-batches`, production, { plannedQty: 40, batchNo: "PROD-DEMO-B4" });
  await call("PATCH", `/production-batches/${batch4.id}`, production, {
    manufacturingStartDate: today(),
    manufacturingEndDate: today(),
    manufacturingStatus: "Completed",
    inputQty: 40,
    outputQty: 38,
  });
  await call("POST", `/production-batches/${batch4.id}/complete`, production, {});
  await call("PATCH", `/production-batches/${batch4.id}/stage`, qaQc, { action: "FORWARD", ipqcStatus: "Approved" });
  await call("PATCH", `/production-batches/${batch4.id}/stage`, qaQc, { action: "FORWARD", mfgQaStatus: "Approved", mfgQcStatus: "Approved" });
  await call("PATCH", `/production-batches/${batch4.id}/stage`, qaQc, { action: "FORWARD", bulkQcStatus: "Approved" });
  console.log(`  Production Batch ${batch4.id} — pending Packaging`);

  console.log("\n=== DONE — log in as production@fls.local / Demo1234! ===");
  console.log("Check the notification bell, Dashboard 'Your Queue', and Order Tracking for the 4 POs above.");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
