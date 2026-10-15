// Creates a Material Received entry, QC-rejects it, and confirms it's
// ready for Accounts to raise a Debit Note against — via the real HTTP
// API against the local dev server (http://localhost:4000), same
// approach as seed_accounts_demo_po.cjs. Stops right before the Debit
// Note itself so Accounts can raise it live and see the screen.
//
// Run from apps/api, with the dev servers already running:
//   node seed_debit_note_demo.cjs
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

async function main() {
  console.log("Logging in as Store and QA/QC...");
  const store = await login("store@fls.local");
  const qaQc = await login("qa_qc@fls.local");

  console.log("Finding an RM item...");
  const items = await call("GET", "/inventory/items?category=RM&limit=1", store);
  const item = items[0];
  if (!item) throw new Error("No RM item found — run the stock import first.");
  console.log(`Using item: ${item.name} (${item.id})`);

  console.log("Store: logging a Material Received entry...");
  const txn = await call("POST", "/inventory/transactions", store, {
    itemId: item.id,
    type: "RECEIVED",
    date: new Date().toISOString().slice(0, 10),
    unit: item.unit ?? "Kg",
    quantity: 25,
    vendorName: "Demo Vendor Pvt Ltd",
    invoiceNo: "DEMO-INV-001",
  });
  console.log(`Transaction created: ${txn.id} (status: ${txn.receiptStatus})`);

  console.log("QA/QC: rejecting it (damaged on inspection)...");
  const rejected = await call("PATCH", `/inventory/transactions/${txn.id}/qc`, qaQc, {
    action: "REJECT",
    note: "Demo rejection — packaging damaged on inspection.",
  });

  console.log("\n=== DONE ===");
  console.log(`Transaction: ${rejected.id}, status: ${rejected.receiptStatus}`);
  console.log(`Item: ${item.name}, Vendor: Demo Vendor Pvt Ltd, Qty: 25 ${item.unit ?? "Kg"}`);
  console.log(`Open in the app: http://localhost:5173/inventory`);
  console.log(`Log in as accounts@fls.local / Demo1234! and raise a Debit Note against this QC_REJECTED entry.`);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
