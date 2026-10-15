// Seeds demo Vendors + Vendor Purchase Orders for manual testing —
// localhost only. Also logs one PO against the existing "Whey Protein
// Isolate" Pre-Inventory shortfall, so you can see the full loop:
// Pre-Inventory (shortfall) -> Vendors (who to buy from) -> Vendor POs
// (the order) -> back on Pre-Inventory as "PO Logged".
//
// Run from apps/api, with the dev servers already running:
//   node seed_vendor_demo.cjs
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
const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function main() {
  const purchase = await login("purchase@fls.local");

  console.log("=== 1. Create 3 demo vendors ===");
  const vendors = [];
  for (const v of [
    { name: "Herbo Nutra Ingredients Pvt Ltd", code: "VEN-DEMO-01", contactPerson: "Ramesh Iyer", contactNo: "9876543210", gstNo: "27AAAAA0000A1Z5", email: "ramesh@herbonutra-demo.local", address: "MIDC, Pune" },
    { name: "Sunrise Packaging Solutions", code: "VEN-DEMO-02", contactPerson: "Priya Shah", contactNo: "9876500011", gstNo: "24BBBBB1111B2Z6", email: "priya@sunrisepack-demo.local", address: "GIDC, Vadodara" },
    { name: "Global Nutra Supplies", code: "VEN-DEMO-03", contactPerson: "Arjun Mehta", contactNo: "9988776655", gstNo: "07CCCCC2222C3Z7", email: "arjun@globalnutra-demo.local", address: "Okhla Industrial Area, Delhi" },
  ]) {
    const created = await call("POST", "/vendors", purchase, v);
    vendors.push(created);
    console.log(`  ${created.name} (${created.code})`);
  }
  const [herboNutra, sunrisePack, globalNutra] = vendors;

  console.log("\n=== 2. Whey Protein Isolate item + the existing Pre-Inventory shortfall ===");
  const wheyItemId = "ef2eef99-6571-4e34-a0f3-cfed64cb01b3"; // RM — Whey Protein Isolate
  const requirementId = "a8910f81-f761-416d-a594-a480ae86a867"; // the existing 405 Kg short requirement

  console.log("\n=== 3. Vendor PO #1 — against Herbo Nutra, covers the Whey Protein shortfall ===");
  const poNumber1 = `VPO-DEMO-${Date.now()}`;
  const po1 = await call("POST", "/vendor-purchase-orders", purchase, {
    vendorId: herboNutra.id,
    poNumber: poNumber1,
    orderDate: today(),
    eta: inDays(10),
    items: [{ itemId: wheyItemId, quantity: 420, unit: "Kg", rate: 850, gstPct: 18 }],
  });
  console.log(`  ${po1.poNumber} — ${po1.totalAmount} total`);

  console.log("\n=== 4. Log that PO against the Pre-Inventory shortfall (closes the loop) ===");
  await call("PATCH", `/inventory/requirements/${requirementId}/purchase`, purchase, {
    poNumber: poNumber1,
    vendorName: herboNutra.name,
    eta: inDays(10),
  });
  console.log("  Whey Protein Isolate requirement is now PO Logged");

  console.log("\n=== 5. Vendor PO #2 — packaging material from Sunrise Packaging ===");
  const po2 = await call("POST", "/vendor-purchase-orders", purchase, {
    vendorId: sunrisePack.id,
    poNumber: `VPO-DEMO-${Date.now() + 1}`,
    orderDate: today(),
    eta: inDays(15),
    items: [
      { itemId: "004b1c62-3705-4c82-9f65-13c08a48f1f8", quantity: 5000, unit: "Count", rate: 3.5, gstPct: 12 },
      { itemId: "006aeb88-8583-4354-a749-1f8e05debab3", quantity: 2000, unit: "Count", rate: 1.2, gstPct: 12 },
    ],
  });
  console.log(`  ${po2.poNumber} — ${po2.totalAmount} total, 2 line items`);

  console.log("\n=== 6. Vendor PO #3 — raw material from Global Nutra, still IN_TRANSIT ===");
  const po3 = await call("POST", "/vendor-purchase-orders", purchase, {
    vendorId: globalNutra.id,
    poNumber: `VPO-DEMO-${Date.now() + 2}`,
    orderDate: today(),
    eta: inDays(20),
    items: [{ itemId: "00250a4f-ca45-45ec-ae8a-538ecd5aeab1", quantity: 100, unit: "Kg", rate: 620, gstPct: 18 }],
  });
  console.log(`  ${po3.poNumber} — ${po3.totalAmount} total`);

  console.log("\n=== DONE — log in as purchase@fls.local / Demo1234! ===");
  console.log("Check Vendors (3 new) and Vendor POs (3 new) pages, and Pre-Inventory's Whey Protein Isolate row (now PO Logged).");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
