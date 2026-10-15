// Adds the two Dispatch Transfer scenarios not yet covered locally:
// 1. An FG transfer already QC_APPROVED — ready for Dispatch to test
//    "Confirm Dispatch" (PATCH /dispatch-transfers/:id/dispatch).
// 2. A BILL transfer — no QC gate at all, for Dispatch to see that shape.
// (A third FG transfer sitting at PENDING_QC — blocked, can't be
// confirmed yet — already exists from the QA/QC demo seed.)
//
// Run from apps/api, with the dev servers already running:
//   node seed_dispatch_transfer_demo.cjs
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
  const store = await login("store@fls.local");
  const qaQc = await login("qa_qc@fls.local");
  const bd = await login("bd@fls.local");

  const customers = await call("GET", "/customers?limit=1", bd);
  const customerId = customers[0].id;

  console.log("Creating FG transfer, QC-approving it (ready for Dispatch to confirm)...");
  const fg = await call("POST", "/inventory/dispatch-transfers", store, {
    type: "FG",
    date: today(),
    customerId,
    productName: "Dispatch Demo Product - Ready to Ship",
    quantity: 35,
  });
  await call("PATCH", `/inventory/dispatch-transfers/${fg.id}/qc`, qaQc, { action: "APPROVE" });
  console.log(`  FG transfer ${fg.id} — QC_APPROVED, ready for Confirm Dispatch`);

  console.log("Creating BILL transfer (no QC gate)...");
  const bill = await call("POST", "/inventory/dispatch-transfers", store, {
    type: "BILL",
    date: today(),
    customerId,
    productName: "Dispatch Demo Product - Billing Only",
    quantity: 1,
  });
  console.log(`  BILL transfer ${bill.id} — no QC needed`);

  console.log("\n=== DONE ===");
  console.log("Log in as dispatch@fls.local / Demo1234! and go to Inventory > FG Transfer to Dispatch.");
  console.log(`  - Confirm the "Ready to Ship" FG transfer (Confirm Dispatch action).`);
  console.log(`  - "Billing Only" transfer needs no QC/Dispatch action — just visible for reference.`);
  console.log(`  - The earlier "QC Demo Product - Outward" transfer is still PENDING_QC — try confirming it and see it's blocked.`);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
