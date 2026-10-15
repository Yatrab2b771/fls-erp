// Seeds real, live pending work at EVERY QA/QC checkpoint in the system,
// via the real HTTP API (http://localhost:4000) — so qa_qc@fls.local has
// something genuine waiting at each stage instead of an empty dashboard.
// Covers: Inbound QC (4 states), Line Clearance, Sample QC Approval,
// IPQC, QA Gate - Manufacturing, Bulk QC, QA Gate - Packaging,
// FG QC & Release, and Outward QC.
//
// Run from apps/api, with the dev servers already running:
//   node seed_qa_qc_demo.cjs
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
    poNumber: `QC-DEMO-${tag}-${Date.now()}`,
    orderDate: today(),
    items: [{ productName, quantity: qty, unit: "Kg", productType: "EXISTING" }],
  });
  await call("PATCH", `/purchase-orders/${po.id}/review`, bd, { status: "APPROVED" });
  return po.items[0].id;
}

// Walks a fresh Pre-Production up to (but not through) a target stage,
// leaving it PENDING right there for QC to act on live.
async function openPreProductionUpTo(roles, poItemId, target) {
  const { production, qaQc, store } = roles;
  const pp = await call("POST", "/pre-productions", production, { purchaseOrderItemId: poItemId, confirmNotReady: true });

  await call("PATCH", `/pre-productions/${pp.id}/stage`, store, { action: "FORWARD", grnNo: `QC-DEMO-GRN`, grnDate: today() });
  await call("PATCH", `/pre-productions/${pp.id}/stage`, production, { action: "FORWARD", prodIndentSlipSign: "Signed (demo)", unit: "22" });
  if (target === "LINE_CLEARANCE_PENDING") return pp; // left pending here

  await call("PATCH", `/pre-productions/${pp.id}/stage`, qaQc, { action: "FORWARD", lineClearanceStatus: "Approved" });
  await call("PATCH", `/pre-productions/${pp.id}/stage`, store, { action: "FORWARD", rmDispensingDate: today(), pmIssuedDate: today() });
  // now sitting at SAMPLE_QC_APPROVAL, pending — this is the second demo target
  return pp;
}

async function buildBatchUpToStage(roles, poItemId, qty, stopBeforeStage) {
  const { production, qaQc, store } = roles;
  const pp = await openPreProductionUpTo(roles, poItemId, "READY_FOR_BATCH");
  await call("PATCH", `/pre-productions/${pp.id}/stage`, qaQc, { action: "FORWARD", sampleQcStatus: "Approved" });

  const batch = await call("POST", `/pre-productions/${pp.id}/production-batches`, production, { plannedQty: qty, batchNo: `QC-DEMO-${stopBeforeStage}` });
  await call("PATCH", `/production-batches/${batch.id}`, production, {
    manufacturingStartDate: today(),
    manufacturingEndDate: today(),
    manufacturingStatus: "Completed",
    inputQty: qty,
    outputQty: qty * 0.97,
  });
  await call("POST", `/production-batches/${batch.id}/complete`, production, {});
  // Batch now sits at IPQC (pending) — the pipeline's first stage.

  const order = ["IPQC", "QA_GATE_MFG", "BULK_QC", "PACKAGING", "QA_GATE_PACKAGING", "FG_STORE", "FG_QC_RELEASE"];
  const idx = order.indexOf(stopBeforeStage);
  for (let i = 0; i < idx; i++) {
    const stage = order[i];
    if (stage === "IPQC") await call("PATCH", `/production-batches/${batch.id}/stage`, qaQc, { action: "FORWARD", ipqcStatus: "Approved" });
    else if (stage === "QA_GATE_MFG") await call("PATCH", `/production-batches/${batch.id}/stage`, qaQc, { action: "FORWARD", mfgQaStatus: "Approved", mfgQcStatus: "Approved" });
    else if (stage === "BULK_QC") await call("PATCH", `/production-batches/${batch.id}/stage`, qaQc, { action: "FORWARD", bulkQcStatus: "Approved" });
    else if (stage === "PACKAGING") await call("PATCH", `/production-batches/${batch.id}/stage`, production, { action: "FORWARD", packagingStatus: "Completed", packagingStartDate: today(), packagingEndDate: today() });
    else if (stage === "QA_GATE_PACKAGING") await call("PATCH", `/production-batches/${batch.id}/stage`, qaQc, { action: "FORWARD", packQaStatus: "Approved", packQcStatus: "Approved" });
    else if (stage === "FG_STORE") await call("PATCH", `/production-batches/${batch.id}/stage`, store, { action: "FORWARD", fgStoreReceivedDate: today() });
  }
  return batch;
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

  const items = await call("GET", "/inventory/items?category=RM&limit=5", store);
  const item = items[0];

  console.log("=== 1. Inbound QC — 4 states ===");
  async function receive(qty, note) {
    const t = await call("POST", "/inventory/transactions", store, {
      itemId: item.id,
      type: "RECEIVED",
      date: today(),
      unit: item.unit ?? "Kg",
      quantity: qty,
      vendorName: "QC Demo Vendor",
    });
    return t;
  }
  const rPending = await receive(10);
  console.log(`  Left PENDING_QC: ${rPending.id}`);
  const rApprove = await receive(12);
  await call("PATCH", `/inventory/transactions/${rApprove.id}/qc`, qaQc, { action: "APPROVE" });
  console.log(`  QC_APPROVED: ${rApprove.id}`);
  const rReject = await receive(8);
  await call("PATCH", `/inventory/transactions/${rReject.id}/qc`, qaQc, { action: "REJECT", note: "Demo — packaging damaged." });
  console.log(`  QC_REJECTED: ${rReject.id}`);
  const rHold = await receive(15);
  await call("PATCH", `/inventory/transactions/${rHold.id}/qc`, qaQc, { action: "HOLD", note: "Demo — awaiting lab confirmation." });
  console.log(`  ON_HOLD: ${rHold.id}`);

  console.log("\n=== 2. Pre-Production — pending at Line Clearance ===");
  const poItem1 = await createApprovedPo(bd, customerId, "QC Demo Product - Line Clearance", 30, "LC");
  const pp1 = await openPreProductionUpTo(roles, poItem1, "LINE_CLEARANCE_PENDING");
  console.log(`  Pre-Production ${pp1.id} — pending Line Clearance`);

  console.log("\n=== 3. Pre-Production — pending at Sample QC Approval ===");
  const poItem2 = await createApprovedPo(bd, customerId, "QC Demo Product - Sample QC", 25, "SQC");
  const pp2 = await openPreProductionUpTo(roles, poItem2, "READY_FOR_BATCH");
  console.log(`  Pre-Production ${pp2.id} — pending Sample QC Approval`);

  console.log("\n=== 4-8. Production Batch — pending at each Tier-3 QC stage ===");
  const stages = ["IPQC", "QA_GATE_MFG", "BULK_QC", "QA_GATE_PACKAGING", "FG_QC_RELEASE"];
  const batches = {};
  for (const stage of stages) {
    const poItem = await createApprovedPo(bd, customerId, `QC Demo Product - ${stage}`, 40, stage);
    const batch = await buildBatchUpToStage(roles, poItem, 40, stage);
    batches[stage] = batch;
    console.log(`  Batch ${batch.id} — pending ${stage}`);
  }

  console.log("\n=== 9. Outward QC — pending FG dispatch transfer ===");
  const dt = await call("POST", "/inventory/dispatch-transfers", store, {
    type: "FG",
    date: today(),
    customerId,
    productName: "QC Demo Product - Outward",
    quantity: 20,
  });
  console.log(`  Dispatch Transfer ${dt.id} — pending outward QC`);

  console.log("\n=== DONE — log in as qa_qc@fls.local / Demo1234! ===");
  console.log("QC Dashboard tab will show all of the above waiting for review.");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
