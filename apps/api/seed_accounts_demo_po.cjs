// Drives a brand-new PO all the way from BD creation through to the
// Billing & E-Way Bill stage (Accounts' own stage), using the real HTTP
// API against the local dev server (http://localhost:4000) — so every
// business rule/validation runs exactly as it would for a real user.
// Stops right AT Billing & E-Way Bill so the Accounts role can actually
// use it to test that screen.
//
// Run from apps/api, with the dev servers already running:
//   node seed_accounts_demo_po.cjs
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
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function login(email, password = "Demo1234!") {
  const r = await call("POST", "/auth/login", null, { email, password });
  return r.token ?? r.accessToken;
}

async function main() {
  console.log("Logging in as each role...");
  const bd = await login("bd@fls.local");
  const production = await login("production@fls.local");
  const qaQc = await login("qa_qc@fls.local");
  const store = await login("store@fls.local");

  console.log("Finding a customer...");
  const customers = await call("GET", "/customers?limit=1", bd);
  const customerId = customers[0]?.id;
  if (!customerId) throw new Error("No customer found — run the catalog import first.");
  console.log(`Using customer: ${customers[0].companyName}`);

  console.log("BD: creating PO...");
  const po = await call("POST", "/purchase-orders", bd, {
    customerId,
    poNumber: `ACC-DEMO-${Date.now()}`,
    orderDate: new Date().toISOString().slice(0, 10),
    items: [{ productName: "Accounts Demo Product (Test Batch)", quantity: 50, unit: "Kg", productType: "EXISTING" }],
  });
  const poItemId = po.items[0].id;
  console.log(`PO created: ${po.poNumber ?? po.id}, item: ${poItemId}`);

  console.log("BD: approving PO...");
  await call("PATCH", `/purchase-orders/${po.id}/review`, bd, { status: "APPROVED" });

  console.log("Production: opening Pre-Production run...");
  const pp = await call("POST", "/pre-productions", production, { purchaseOrderItemId: poItemId, confirmNotReady: true });
  console.log(`Pre-Production: ${pp.id}`);

  const today = new Date().toISOString().slice(0, 10);

  console.log("Store: Material Received & GRN...");
  await call("PATCH", `/pre-productions/${pp.id}/stage`, store, { action: "FORWARD", grnNo: "ACC-DEMO-GRN-1", grnDate: today });

  console.log("Production: Indent Issue...");
  await call("PATCH", `/pre-productions/${pp.id}/stage`, production, { action: "FORWARD", prodIndentSlipSign: "Signed (demo)", unit: "22" });

  console.log("QA/QC: Line Clearance (Approved)...");
  await call("PATCH", `/pre-productions/${pp.id}/stage`, qaQc, { action: "FORWARD", lineClearanceStatus: "Approved" });

  console.log("Store: Dispensing...");
  await call("PATCH", `/pre-productions/${pp.id}/stage`, store, { action: "FORWARD", rmDispensingDate: today, pmIssuedDate: today });

  console.log("QA/QC: Sample QC Approval (Approved)...");
  await call("PATCH", `/pre-productions/${pp.id}/stage`, qaQc, { action: "FORWARD", sampleQcStatus: "Approved" });

  console.log("Production: creating Production Batch...");
  const batch = await call("POST", `/pre-productions/${pp.id}/production-batches`, production, { plannedQty: 50, batchNo: "ACC-DEMO-B1" });
  console.log(`Production Batch: ${batch.id}`);

  console.log("Production: recording output & completing the run...");
  await call("PATCH", `/production-batches/${batch.id}`, production, {
    manufacturingStartDate: today,
    manufacturingEndDate: today,
    manufacturingStatus: "Completed",
    inputQty: 50,
    outputQty: 48,
  });
  await call("POST", `/production-batches/${batch.id}/complete`, production, {});

  console.log("QA/QC: IPQC (Approved)...");
  await call("PATCH", `/production-batches/${batch.id}/stage`, qaQc, { action: "FORWARD", ipqcStatus: "Approved" });

  console.log("QA/QC: QA Gate - Manufacturing...");
  await call("PATCH", `/production-batches/${batch.id}/stage`, qaQc, { action: "FORWARD", mfgQaStatus: "Approved", mfgQcStatus: "Approved" });

  console.log("QA/QC: Bulk QC (Approved)...");
  await call("PATCH", `/production-batches/${batch.id}/stage`, qaQc, { action: "FORWARD", bulkQcStatus: "Approved" });

  console.log("Production: Packaging (Completed)...");
  await call("PATCH", `/production-batches/${batch.id}/stage`, production, { action: "FORWARD", packagingStatus: "Completed", packagingStartDate: today, packagingEndDate: today });

  console.log("QA/QC: QA Gate - Packaging...");
  await call("PATCH", `/production-batches/${batch.id}/stage`, qaQc, { action: "FORWARD", packQaStatus: "Approved", packQcStatus: "Approved" });

  console.log("Store: FG Store receipt...");
  await call("PATCH", `/production-batches/${batch.id}/stage`, store, { action: "FORWARD", fgStoreReceivedDate: today });

  console.log("QA/QC: FG QC & Release (Approved)...");
  const final = await call("PATCH", `/production-batches/${batch.id}/stage`, qaQc, { action: "FORWARD", fgQaStatus: "Approved", fgQcStatus: "Approved" });

  console.log("\n=== DONE ===");
  console.log(`PO: ${po.poNumber} (id ${po.id})`);
  console.log(`Production Batch: ${batch.id}, now at stage: ${final.currentStageId}`);
  console.log(`Open in the app: http://localhost:5173/production-batches/${batch.id}`);
  console.log(`Log in as accounts@fls.local / Demo1234! to act on Billing & E-Way Bill.`);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
