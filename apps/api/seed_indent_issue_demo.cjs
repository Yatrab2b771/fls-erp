// Creates a fresh PO and walks it through Material Received & GRN, then
// STOPS right at Indent Issue — Production's own turn, pending, with the
// notification and dashboard queue live for them to see.
//
// Run from apps/api, with the dev servers already running:
//   node seed_indent_issue_demo.cjs
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
  const bd = await login("bd@fls.local");
  const production = await login("production@fls.local");
  const store = await login("store@fls.local");

  const customers = await call("GET", "/customers?limit=1", bd);
  const customerId = customers[0].id;
  console.log(`Using customer: ${customers[0].companyName}`);

  console.log("BD: creating PO...");
  const po = await call("POST", "/purchase-orders", bd, {
    customerId,
    poNumber: `INDENT-DEMO-${Date.now()}`,
    orderDate: today(),
    items: [{ productName: "Indent Issue Demo Product", quantity: 60, unit: "Kg", productType: "EXISTING" }],
  });
  const poItemId = po.items[0].id;
  console.log(`PO created: ${po.poNumber}`);

  console.log("BD: approving PO...");
  await call("PATCH", `/purchase-orders/${po.id}/review`, bd, { status: "APPROVED" });

  console.log("Production: opening Pre-Production run...");
  const pp = await call("POST", "/pre-productions", production, { purchaseOrderItemId: poItemId, confirmNotReady: true });

  console.log("Store: Material Received & GRN...");
  const updated = await call("PATCH", `/pre-productions/${pp.id}/stage`, store, { action: "FORWARD", grnNo: "INDENT-DEMO-GRN-1", grnDate: today() });

  console.log("\n=== DONE ===");
  console.log(`PO: ${po.poNumber}`);
  console.log(`Pre-Production: ${pp.id}, now at stage: ${updated.currentStageId} — pending Production's action`);
  console.log(`Open in the app: http://localhost:5173/pre-productions/${pp.id}`);
  console.log(`Log in as production@fls.local / Demo1234! — check the notification bell and Dashboard "Your Queue".`);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
