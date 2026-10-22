import bcrypt from "bcryptjs";
import request from "supertest";
import type { RoleName } from "@prisma/client";
import { createApp } from "../src/app";
import { prisma } from "../src/common/lib/prisma";
import { signAccessToken } from "../src/common/lib/jwt";
import { savePmBom } from "../src/modules/packaging-bom/bom-versions";
import { saveRecipe } from "../src/modules/rm-costing/recipe-catalog.routes";

/**
 * A clean demo of the whole order-to-dispatch flow: one product at EVERY stage, from BD to Dispatch, each one taken there through the
 * real API (the same calls the screens make), so no product is ever somewhere its records do not allow.
 *
 *   Run reset-flow-data.ts first, then:  npx tsx prisma/seed-clean-flow.ts
 *
 * Everything it creates is named "DEMO ...". It needs the users (one per department), Plants and Day Stores that the system already has;
 * on an empty database it creates a minimal set of them.
 */
const app = createApp();

// ---------------------------------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------------------------------

type Tokens = Record<string, string>;
const tokens: Tokens = {};

async function userFor(role: RoleName): Promise<{ id: string; token: string }> {
  const email = `${role.toLowerCase()}@fls.local`;
  let user = await prisma.user.findUnique({ where: { email }, include: { roles: { include: { role: true } } } });
  if (!user) {
    const created = await prisma.user.create({ data: { email, fullName: `${role} Dept.`, passwordHash: await bcrypt.hash("Password123!", 10) } });
    const r = await prisma.role.upsert({ where: { name: role }, create: { name: role }, update: {} });
    await prisma.userRole.create({ data: { userId: created.id, roleId: r.id } });
    user = await prisma.user.findUniqueOrThrow({ where: { id: created.id }, include: { roles: { include: { role: true } } } });
  }
  const roles = user.roles.map((x) => x.role.name);
  const token = signAccessToken({ sub: user.id, roles, tokenVersion: user.tokenVersion });
  tokens[role] = token;
  return { id: user.id, token };
}

class ApiFailure extends Error {}
async function call<T = any>(role: RoleName, method: "get" | "post" | "patch" | "put" | "delete", path: string, body?: unknown, ok: number[] = [200, 201, 204]): Promise<T> {
  const req = request(app)[method](path).set("Authorization", `Bearer ${tokens[role]}`);
  const res = await (body === undefined ? req : req.send(body as object));
  if (!ok.includes(res.status)) throw new ApiFailure(`${role} ${method.toUpperCase()} ${path} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T;
}

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** The Store receives what the Warehouse issued it (it is in transit until then): Admin acts as the Store. */
const receiveAtStore = (txn: { id: string }) => call("ADMIN", "post", `/api/inventory/transactions/${txn.id}/confirm-delivery`, {});


// ---------------------------------------------------------------------------------------------------------------------
// masters: items, stock, recipes, packaging BOMs
// ---------------------------------------------------------------------------------------------------------------------

const RM_POWDER: [string, number][] = [["DEMO Whey Isolate", 0.7], ["DEMO Cocoa Powder", 0.2], ["DEMO Sweetener", 0.1]];
const RM_GUMMY: [string, number][] = [["DEMO Gelatin Base", 0.6], ["DEMO Fruit Concentrate", 0.4]]; // Gelatin Base is never stocked: products using it are short
const PM_POWDER: [string, number][] = [["DEMO Tub 1kg", 1], ["DEMO Front Label", 1], ["DEMO Shipper Carton", 12]];

async function ensureItem(category: "RM" | "PM", name: string, unit: string): Promise<string> {
  const found = await prisma.inventoryItem.findUnique({ where: { category_name: { category, name } } });
  if (found) return found.id;
  return (await call<{ id: string }>("STORE", "post", "/api/inventory/items", { category, name, unit })).id;
}

/** Warehouse receipt, passed by R&D's inward QC (which puts it into stock): the real way stock comes in. */
async function receiveStock(itemId: string, unit: string, quantity: number) {
  const txn = await call<{ id: string }>("STORE", "post", "/api/inventory/transactions", { itemId, type: "RECEIVED", date: day(-30), unit, quantity, vendorName: "DEMO Vendor", grnNo: `DEMO-GRN-${Date.now() % 100000}`, batchNo: "DEMO-LOT" });
  await call("RND", "patch", `/api/inventory/transactions/${txn.id}/qc`, { action: "APPROVE", samplingDate: day(-29) }); // Approve puts it into stock
}

type Product = { name: string; category: string; kind: "powder" | "gummy" };

async function ensureCatalog(customerId: string, product: Product, userId: string, itemIds: Map<string, string>) {
  const rm = product.kind === "powder" ? RM_POWDER : RM_GUMMY;
  if (!(await prisma.recipe.findFirst({ where: { customerId, name: product.name } }))) {
    await saveRecipe({ name: product.name, customerId, kind: "PER_KG", batchSize: 100, ingredients: rm.map(([name, q]) => ({ name, brand: "DEMO", itemCode: undefined, gPerServing: q, proteinPct: 0 })) }, "DEMO: first version", userId);
  }
  let sku = await prisma.sku.findFirst({ where: { customerId, productName: product.name } });
  if (!sku) sku = await prisma.sku.create({ data: { customerId, productName: product.name } });
  if (!(await prisma.skuPackagingComponent.findFirst({ where: { skuId: sku.id } }))) {
    await savePmBom(sku.id, { header: { packSize: "1 kg", batchPacks: 100 }, components: PM_POWDER.map(([type, q]) => ({ type, quantity: q, unit: "Nos", pmItemId: itemIds.get(type)!, pmCode: null, overagePct: type.includes("Carton") ? 0 : 0.02 })) }, "DEMO: first version", userId);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the story
// ---------------------------------------------------------------------------------------------------------------------

async function main() {
  const admin = await userFor("ADMIN");
  for (const r of ["BD", "PPIC", "RND", "REGULATORY", "STORE", "PRODUCTION", "QA_QC", "DISPATCH", "PURCHASE", "ACCOUNTS"] as RoleName[]) await userFor(r);

  // Plants (each paired with a Day Store): use what exists, else make two
  let plants = await prisma.plant.findMany({ where: { dayStoreId: { not: null } }, orderBy: { name: "asc" }, take: 2, select: { id: true, name: true, dayStoreId: true } });
  if (plants.length < 2) {
    for (const n of [1, 2]) {
      const ds = await prisma.dayStore.create({ data: { name: `DEMO Store ${n}`, createdById: admin.id } });
      await prisma.plant.create({ data: { name: `DEMO Plant ${n}`, createdById: admin.id, dayStoreId: ds.id } });
    }
    plants = await prisma.plant.findMany({ where: { dayStoreId: { not: null } }, orderBy: { name: "asc" }, take: 2, select: { id: true, name: true, dayStoreId: true } });
  }
  console.log(`Plants: ${plants.map((p) => p.name).join(", ")}`);
  // Each Day Store needs a login of its own (it sees only its own plant's work)
  for (const p of plants) {
    if (await prisma.dayStoreAssignment.findFirst({ where: { dayStoreId: p.dayStoreId! } })) continue;
    const store = await prisma.dayStore.findUniqueOrThrow({ where: { id: p.dayStoreId! }, select: { name: true } });
    const role = await prisma.role.upsert({ where: { name: "STORE" }, create: { name: "STORE" }, update: {} });
    const u = await prisma.user.create({ data: { email: `daystore-${p.dayStoreId!.slice(0, 6)}@fls.local`, fullName: `${store.name} (Store login)`, passwordHash: await bcrypt.hash("Password123!", 10) } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
    await prisma.dayStoreAssignment.create({ data: { userId: u.id, dayStoreId: p.dayStoreId! } });
  }

  // Items and stock (Gelatin Base and Fruit Concentrate get none: the gummy products are short)
  const itemIds = new Map<string, string>();
  for (const [n] of [...RM_POWDER, ...RM_GUMMY]) itemIds.set(n, await ensureItem("RM", n, "Kg"));
  for (const [n] of PM_POWDER) itemIds.set(n, await ensureItem("PM", n, "Nos"));
  for (const [n] of RM_POWDER) if (!(await prisma.inventoryTransaction.findFirst({ where: { itemId: itemIds.get(n)!, type: "RECEIVED" } }))) await receiveStock(itemIds.get(n)!, "Kg", 100000);
  for (const [n] of RM_GUMMY.filter(([n]) => n === "DEMO Fruit Concentrate")) if (!(await prisma.inventoryTransaction.findFirst({ where: { itemId: itemIds.get(n)!, type: "RECEIVED" } }))) await receiveStock(itemIds.get(n)!, "Kg", 100000);
  for (const [n] of PM_POWDER) if (!(await prisma.inventoryTransaction.findFirst({ where: { itemId: itemIds.get(n)!, type: "RECEIVED" } }))) await receiveStock(itemIds.get(n)!, "Nos", 10_000_000);
  console.log("Items and stock ready.");

  // Customers
  const customer = async (companyName: string) =>
    (await prisma.customer.findFirst({ where: { companyName } })) ?? (await call<{ id: string }>("BD", "post", "/api/customers", { companyName, contactPerson: "Demo Contact", contactNo: "9876543210" }));
  const alpha = await customer("DEMO Alpha Nutrition");
  const beta = await customer("DEMO Beta Wellness");

  const powder = (name: string): Product => ({ name, category: "Powder", kind: "powder" });
  const gummy = (name: string): Product => ({ name, category: "Gummies", kind: "gummy" });

  type Line = { product: Product; qty: number; noCatalog?: boolean }; // noCatalog: R&D has not made the recipe / packaging BOM yet
  const makePo = async (customerId: string, poNumber: string, lines: Line[], approve: "APPROVED" | "REJECTED" | null, expectedInDays = 30) => {
    for (const l of lines.filter((x) => !x.noCatalog)) await ensureCatalog(customerId, l.product, admin.id, itemIds);
    const po = await call<{ id: string; items: { id: string; productName: string }[] }>("BD", "post", "/api/purchase-orders", {
      customerId,
      poNumber,
      orderDate: day(-12),
      expectedDeliveryDate: day(expectedInDays),
      regulatoryBody: "FSSAI",
      regulatoryStatus: "Issued",
      items: lines.map((l) => ({ productName: l.product.name, productCategory: l.product.category, quantity: l.qty, unit: "KG", packSize: "1 kg" })),
    });
    if (approve === "APPROVED") await call("BD", "patch", `/api/purchase-orders/${po.id}/review`, { status: "APPROVED" });
    if (approve === "REJECTED") await call("BD", "patch", `/api/purchase-orders/${po.id}/review`, { status: "REJECTED", rejectionReason: "DEMO: customer withdrew the order" });
    const itemOf = (name: string) => po.items.find((i) => i.productName === name)!.id;
    return { id: po.id, itemOf };
  };

  // Steps a product goes through, each the real call
  const setPlant = (poId: string, itemId: string, plantId: string) => call("PPIC", "patch", `/api/purchase-orders/${poId}/items/${itemId}/planned-plant`, { plantId });
  const generateRm = (itemId: string, name: string) => call("PPIC", "post", "/api/rm-costing/plans", { name: `${name} — RM Costing`, purchaseOrderItemId: itemId });
  const generateBom = (itemId: string, name: string) => call("PPIC", "post", "/api/bom/plans", { name: `${name} — BOM`, purchaseOrderItemId: itemId });
  const bothPlans = async (poId: string, itemId: string, name: string, plantId: string) => {
    await setPlant(poId, itemId, plantId);
    await generateRm(itemId, name);
    await generateBom(itemId, name);
  };
  const approveRegulatory = (poId: string, itemId: string) => call("REGULATORY", "patch", `/api/purchase-orders/${poId}/items/${itemId}/regulatory-review`, { status: "Approved", remarks: "DEMO: approved" });
  const sendToProduction = (poId: string, itemId: string) => call("PPIC", "post", `/api/purchase-orders/${poId}/items/${itemId}/send-plan-to-production`, {});

  // ---- Warehouse and R&D: deliveries waiting for Inward QC (some against a Vendor PO, one direct), each at a different QC step
  const vendor = (await prisma.vendor.findFirst({ where: { name: "DEMO Gelatin Traders" } })) ?? (await prisma.vendor.create({ data: { name: "DEMO Gelatin Traders", createdById: admin.id } }));
  const vpoLine = (name: string, quantity: number, unit: string, rate: number) => ({ itemId: itemIds.get(name)!, quantity, unit, rate, gstPct: 5 });
  const vpo = await call<{ id: string; items: { id: string; itemId: string }[] }>("PURCHASE", "post", "/api/vendor-purchase-orders", {
    vendorId: vendor.id,
    poNumber: "DEMO-VPO-001",
    orderDate: day(-6),
    eta: day(2),
    items: [vpoLine("DEMO Gelatin Base", 60, "Kg", 450), vpoLine("DEMO Whey Isolate", 500, "Kg", 900), vpoLine("DEMO Tub 1kg", 2000, "Nos", 12)],
  });
  const lineOf = (name: string) => vpo.items.find((l) => l.itemId === itemIds.get(name))!.id;
  const receive = (name: string, quantity: number, grnNo: string) => call<{ id: string }>("STORE", "post", `/api/vendor-purchase-orders/${vpo.id}/items/${lineOf(name)}/receive`, { quantity, grnNo, batchNo: `${grnNo}-LOT`, remark: "DEMO: delivery counted at the gate" });
  await receive("DEMO Gelatin Base", 40, "DEMO-GRN-VPO-1"); // part of the order: waiting for R&D to sample it
  const whey = await receive("DEMO Whey Isolate", 500, "DEMO-GRN-VPO-2");
  await call("RND", "patch", `/api/inventory/transactions/${whey.id}/qc`, { action: "TEST", samplingDate: day(-1) }); // being tested
  const tubs = await receive("DEMO Tub 1kg", 2000, "DEMO-GRN-VPO-3");
  await call("RND", "patch", `/api/inventory/transactions/${tubs.id}/qc`, { action: "HOLD", samplingDate: day(-1), note: "DEMO: print on the tub is smudged, waiting for the vendor's reply" }); // on hold
  await call("STORE", "post", "/api/inventory/transactions", { itemId: itemIds.get("DEMO Cocoa Powder")!, type: "RECEIVED", date: day(-1), unit: "Kg", quantity: 200, vendorName: "DEMO Vendor", grnNo: "DEMO-GRN-DIRECT", batchNo: "DEMO-LOT-D", remark: "DEMO: direct delivery, no vendor PO" }); // direct, waiting

  // ---- BD: a draft and a rejected PO
  await makePo(alpha.id, "DEMO-PO-DRAFT", [{ product: powder("DEMO Draft Whey 1kg"), qty: 50 }], null);
  await makePo(beta.id, "DEMO-PO-REJECTED", [{ product: powder("DEMO Rejected Whey 1kg"), qty: 50 }], "REJECTED");

  // ---- PPIC: one approved PO with a product at every stage before Production
  const A = powder("DEMO Cocoa Whey 1kg");
  const B = powder("DEMO Vanilla Whey 1kg");
  const C = gummy("DEMO Gummy Mix 60ct");
  const D = powder("DEMO Whey Isolate 1kg");
  const E = powder("DEMO Creatine 1kg");
  const F = powder("DEMO BCAA 1kg");
  const G = powder("DEMO Casein 1kg");
  const H = powder("DEMO Mass Gainer 1kg");
  const NEW1 = powder("DEMO New Formula 1kg");
  const NEW2 = gummy("DEMO New Gummy 30ct");
  const poA = await makePo(alpha.id, "DEMO-PO-A", [...[A, B, C, D, E, F, G, H].map((product) => ({ product, qty: 100 })), ...[NEW1, NEW2].map((product) => ({ product, qty: 100, noCatalog: true }))], "APPROVED");
  const [pA, pB] = [plants[0]!, plants[1]!];

  // A: nothing done            -> Not Planned
  // B: plant + RM plan only    -> Not Planned (half a plan is no plan)
  await setPlant(poA.id, poA.itemOf(B.name), pA.id);
  await generateRm(poA.itemOf(B.name), B.name);
  // C: both plans, a material has no stock -> Material Planning (short)
  await bothPlans(poA.id, poA.itemOf(C.name), C.name, pA.id);
  // D: both plans, covered, Regulatory still to review -> PO Readiness, waiting for Regulatory
  await bothPlans(poA.id, poA.itemOf(D.name), D.name, pA.id);
  // E: both plans, covered, Regulatory approved -> PO Readiness, ready to send
  await bothPlans(poA.id, poA.itemOf(E.name), E.name, pB.id);
  await approveRegulatory(poA.id, poA.itemOf(E.name));
  // F: both plans, then PPIC puts it on Hold -> On Hold only
  await bothPlans(poA.id, poA.itemOf(F.name), F.name, pB.id);
  await call("PPIC", "patch", `/api/purchase-orders/${poA.id}/items/${poA.itemOf(F.name)}/material-hold`, { held: true });
  // G: cancelled by PPIC -> Cancelled
  await call("PPIC", "patch", `/api/purchase-orders/${poA.id}/items/${poA.itemOf(G.name)}/cancel`, { reason: "DEMO: customer dropped this product" });
  // H: both plans, covered, Regulatory refuses it -> PO Readiness (not ready), Regulatory "Not Approved"
  await bothPlans(poA.id, poA.itemOf(H.name), H.name, pA.id);
  await call("REGULATORY", "patch", `/api/purchase-orders/${poA.id}/items/${poA.itemOf(H.name)}/regulatory-review`, { status: "Not Approved", remarks: "DEMO: label claim not allowed, resubmit with a corrected claim" });
  console.log("PPIC stages done.");

  // Purchase: the short gummy product's missing material goes to Purchase, which orders part of it (a PI Number, Vendor and ETA), so the
  // Purchase tiles have a requirement still to order and one on order.
  await call("PPIC", "post", `/api/purchase-orders/${poA.id}/items/${poA.itemOf(C.name)}/send-short-to-purchase`, {});
  const gelatin = await prisma.preInventoryRequirement.findFirstOrThrow({ where: { item: { name: "DEMO Gelatin Base" }, deletedAt: null }, select: { id: true, requiredQty: true } });
  await call("PURCHASE", "patch", `/api/inventory/requirements/${gelatin.id}/purchase`, { poNumber: "DEMO-PI-001", vendorName: "DEMO Gelatin Traders", eta: day(14), quantity: Math.round(gelatin.requiredQty * 0.6) });

  // ---- Production and after: a second PO whose products each go one step further
  const names = ["Run: waiting for Production to open the run", "Run: material at the Store", "Run: indent", "Run: dispensing", "Run: line clearance with QA", "Run: line clearance done", "Batch: IPQC", "Batch: QA gate (manufacturing)", "Batch: bulk QC", "Batch: packaging", "Batch: QA gate (packaging)", "Batch: FG store", "Batch: FG QC release", "Batch: handover", "Dispatch: with Dispatch", "Dispatch: part sent", "Completed", "Held by PPIC after it was sent", "Cancelled after the run was opened", "Batch: QA gate (manufacturing) on QA hold", "More: Material Received", "More: IPQC", "More: Dispensing", "More: QA gate (packaging)", "More: FG store", "More: FG QC release", "More: FG handover", "More: material covered at the Store (1)", "More: material covered at the Store (2)", "More: FG store (handed over to the store)"];
  const prodProducts = names.map((n, i) => powder(`DEMO ${String(i + 1).padStart(2, "0")} ${n}`));
  const poB = await makePo(beta.id, "DEMO-PO-B", prodProducts.map((product) => ({ product, qty: 100 })), "APPROVED");
  for (const [i, product] of prodProducts.entries()) {
    const itemId = poB.itemOf(product.name);
    const plant = plants[i % 2]!;
    await bothPlans(poB.id, itemId, product.name, plant.id);
    await approveRegulatory(poB.id, itemId);
    await sendToProduction(poB.id, itemId);
  }
  console.log(`Sent ${prodProducts.length} products to Production.`);

  const made = await runProduction(poB, prodProducts, PO_B_GOALS);
  const madeOf = (suffix: string) => made.get(prodProducts.find((p) => p.name.endsWith(suffix))!.name)!;

  // PPIC can hold or cancel a product until Production has made its first batch
  const byName = (suffix: string) => poB.itemOf(prodProducts.find((p) => p.name.endsWith(suffix))!.name);
  await call("PPIC", "patch", `/api/purchase-orders/${poB.id}/items/${byName("Held by PPIC after it was sent")}/material-hold`, { held: true });
  await call("PPIC", "patch", `/api/purchase-orders/${poB.id}/items/${byName("Cancelled after the run was opened")}/cancel`, { reason: "DEMO: customer dropped it after the run was opened" });
  // BD asks PPIC to hold a product: waiting for PPIC's answer
  await call("BD", "post", "/api/item-change-requests", { purchaseOrderItemId: byName("Run: material at the Store"), kind: "HOLD", reason: "DEMO: customer may change the formula" });
  // ---- Dispatch -> Warehouse finished goods: one request at every step, so the Warehouse Finished Goods list and FG tiles have stock.
  // The batch "with Dispatch, nothing shipped" (100) sends 25 requested, 25 accepted, 20 sent and 20 received; the "part sent" one (70 left)
  // sends 20 that the Warehouse has received, and one it refused.
  const withDispatch = madeOf("Dispatch: with Dispatch").batchId!;
  const partSent = madeOf("Dispatch: part sent").batchId!;
  const whRequest = (batchId: string, quantity: number, note: string) => call<{ id: string }>("DISPATCH", "post", `/api/fg/batches/${batchId}/warehouse-requests`, { quantity, note });
  const whAccept = (id: string) => call("STORE", "patch", `/api/fg/shipments/${id}/decision`, { action: "ACCEPT" });
  const whSend = (id: string, lr: string) => call("DISPATCH", "post", `/api/fg/shipments/${id}/send`, { transportType: "Road", pickedBy: "DEMO Driver", loadedBy: "DEMO Loader", lrNo: lr });
  const whReceive = (id: string) => call("STORE", "post", `/api/fg/shipments/${id}/receive`, {});
  await whRequest(withDispatch, 25, "DEMO: needed for walk-in orders");
  await whAccept((await whRequest(withDispatch, 25, "DEMO: stock for the next fortnight")).id);
  const sent = await whRequest(withDispatch, 20, "DEMO: top up the Warehouse");
  await whAccept(sent.id);
  await whSend(sent.id, "DEMO-LR-WH-1");
  const received = await whRequest(withDispatch, 20, "DEMO: first lot to the Warehouse");
  await whAccept(received.id);
  await whSend(received.id, "DEMO-LR-WH-2");
  await whReceive(received.id);
  const received2 = await whRequest(partSent, 20, "DEMO: second product to the Warehouse");
  await whAccept(received2.id);
  await whSend(received2.id, "DEMO-LR-WH-3");
  await whReceive(received2.id);
  const refused = await whRequest(partSent, 10, "DEMO: more than the shelf can take");
  await call("STORE", "patch", `/api/fg/shipments/${refused.id}/decision`, { action: "REJECT", reason: "DEMO: no space on the shelf this week" });
  // Dispatch asks the Warehouse for some of that stock back, to send to a customer: one waiting, one on the way, one received, one refused
  const askStock = (batchId: string, quantity: number, note: string) => call<{ id: string }>("DISPATCH", "post", `/api/fg/batches/${batchId}/stock-requests`, { quantity, note });
  await askStock(withDispatch, 4, "DEMO: customer order due Friday");
  const onTheWay = await askStock(withDispatch, 4, "DEMO: second customer order");
  await call("STORE", "post", `/api/fg/shipments/${onTheWay.id}/send-to-dispatch`, {});
  const withIt = await askStock(withDispatch, 4, "DEMO: urgent order");
  await call("STORE", "post", `/api/fg/shipments/${withIt.id}/send-to-dispatch`, {});
  await call("DISPATCH", "post", `/api/fg/shipments/${withIt.id}/receive-from-warehouse`, {});
  const noStock = await askStock(partSent, 6, "DEMO: sample for a customer");
  await call("STORE", "post", `/api/fg/shipments/${noStock.id}/refuse-stock-request`, { reason: "DEMO: held for quality re-check" });
  // Customer shipments at each step of the Accounts gate: waiting for Accounts, approved and ready to send, sent back to Dispatch
  const customerShipment = (quantity: number, lr: string) =>
    call<{ id: string }>("DISPATCH", "post", `/api/fg/batches/${withDispatch}/customer-shipments`, { quantity, transportType: "By Land", transportName: "DEMO Transport Co.", vehicleNo: "RJ14 CD 7788", lrNo: lr, weightKg: quantity * 1.05, cartonCount: Math.ceil(quantity / 12), goodsValue: quantity * 500, freightCharge: 600 });
  await customerShipment(3, "DEMO-LR-ACC-1"); // waiting for Accounts
  const readyShipment = await customerShipment(3, "DEMO-LR-ACC-2");
  await call("ACCOUNTS", "post", `/api/fg/shipments/${readyShipment.id}/accounts-approve`, { invoiceNo: "DEMO-INV-ACC-2", invoiceDate: day(0), invoiceAmount: 1500, ewayBillNo: "DEMO-EWB-ACC-2", ewayBillDate: day(0) }); // ready to send
  const backAgain = await customerShipment(3, "DEMO-LR-ACC-3");
  await call("ACCOUNTS", "post", `/api/fg/shipments/${backAgain.id}/accounts-return`, { reason: "DEMO: goods value does not match the PO rate" }); // sent back
  console.log("Finished goods sent to the Warehouse.");

  // ---- Production: extra material (outside any plan), and what the Plant did with it (used / wasted / rejected / sample)
  const cocoa = itemIds.get("DEMO Cocoa Powder")!;
  // Extra material is asked for one batch: the one at In-Process QA, at Plant A
  const extraBatch = madeOf("Batch: IPQC").batchId!;
  const extraOf = (quantity: number, reason: string) => call<{ id: string }>("PRODUCTION", "post", "/api/inventory/extra-requests", { itemId: cocoa, requestedQty: quantity, reason, productionBatchId: extraBatch, neededBy: day(3) });
  const issued = await extraOf(60, "DEMO: the dispensed batch ran short, more cocoa needed");
  await receiveAtStore(await call<{ id: string }>("STORE", "post", "/api/inventory/transactions", { itemId: cocoa, type: "ISSUED_DAY_STORE", date: day(-2), unit: "Kg", quantity: 60, dayStoreId: pA.dayStoreId }));
  await call("ADMIN", "patch", `/api/inventory/requests/${issued.id}/review`, { action: "APPROVE" });
  await call("ADMIN", "post", `/api/inventory/requests/${issued.id}/issue`, { date: day(-1), unit: "Kg", quantity: 60, dayStoreId: pA.dayStoreId });
  await extraOf(25, "DEMO: sample runs for the customer"); // still open
  await call("PRODUCTION", "post", `/api/plant-consumption/${madeOf("Dispatch: with Dispatch").runId}/entries`, {
    itemId: cocoa,
    unit: "Kg",
    consumedQty: 30,
    wastedQty: 6,
    rejectedQty: 4,
    sampleQty: 3,
    productionBatchId: withDispatch,
    note: "DEMO: extra cocoa used on the batch",
  });
  console.log("Extra material and plant consumption logged.");

  // ---- R&D: samples it asked the Warehouse for, what it did with them, direct purchase, dispatch to a customer, return, quarantine
  const rndItem = (name: string) => itemIds.get(name)!;
  const askSample = (name: string, quantity: number, note: string) => call<{ id: string }>("RND", "post", "/api/rnd-store/requests", { itemId: rndItem(name), quantity, unit: "Kg", note });
  const fulfil = async (name: string, quantity: number, confirm: boolean) => {
    const req = await askSample(name, quantity, `DEMO: ${name} for formulation trials`);
    const res = await call<{ transferId?: string | null; transfer?: { id: string } | null }>("STORE", "post", `/api/rnd-store/requests/${req.id}/fulfill`, {});
    const transferId = res.transferId ?? res.transfer?.id;
    if (confirm && transferId) await call("RND", "post", `/api/rnd-store/transfers/${transferId}/confirm`, {});
  };
  await fulfil("DEMO Whey Isolate", 40, true);
  await fulfil("DEMO Sweetener", 12, true);
  await fulfil("DEMO Cocoa Powder", 8, false); // issued, R&D has not confirmed receiving it yet
  await askSample("DEMO Fruit Concentrate", 5, "DEMO: still waiting for the Warehouse"); // pending
  const consume = (name: string, quantity: number, reason: string, project: string) => call("RND", "post", "/api/rnd-store/consume", { itemId: rndItem(name), quantity, unit: "Kg", reason, projectName: project, formulationRef: "DEMO-F-01" });
  await consume("DEMO Whey Isolate", 5, "TESTING", "DEMO Protein Bar");
  await consume("DEMO Whey Isolate", 3, "FORMULATION_TRIAL", "DEMO Protein Bar");
  await consume("DEMO Sweetener", 2, "WASTAGE", "DEMO Protein Bar");
  await consume("DEMO Sweetener", 1, "REJECTED", "DEMO Protein Bar");
  await call("RND", "post", "/api/rnd-store/dispatch", { itemId: rndItem("DEMO Whey Isolate"), quantity: 4, unit: "Kg", customerId: alpha.id, brandName: "DEMO Brand", courierDetails: "DEMO Courier AWB 1234" });
  const back = await call<{ id: string }>("RND", "post", "/api/rnd-store/transfers", { direction: "TO_WAREHOUSE", itemId: rndItem("DEMO Sweetener"), quantity: 3, unit: "Kg", note: "DEMO: leftover" });
  await call("STORE", "post", `/api/rnd-store/transfers/${back.id}/confirm`, {}); // the Warehouse took it back
  await call("RND", "post", "/api/rnd-store/transfers", { direction: "TO_WAREHOUSE", itemId: rndItem("DEMO Whey Isolate"), quantity: 6, unit: "Kg", note: "DEMO: leftover, not confirmed yet" });
  // a delivery that R&D Inward QC rejects: it sits in Quarantine
  const bad = await call<{ id: string }>("STORE", "post", "/api/inventory/transactions", { itemId: cocoa, type: "RECEIVED", date: day(-1), unit: "Kg", quantity: 15, vendorName: "DEMO Vendor", grnNo: "DEMO-GRN-BAD", batchNo: "DEMO-LOT-BAD", remark: "DEMO: delivery with damaged bags" });
  await call("RND", "patch", `/api/inventory/transactions/${bad.id}/qc`, { action: "REJECT", samplingDate: day(-1), note: "DEMO: moisture too high, bags torn" });
  // customer sample requests, at different steps
  const sampleRequest = (customerId: string, productName: string, quantity: string) => call<{ id: string }>("RND", "post", "/api/sample-requests", { customerId, productName, quantity, neededBy: day(10), remarks: "DEMO: customer wants to taste it first" });
  await sampleRequest(alpha.id, "DEMO Choco Protein Sample", "2 kg");
  const inProcess = await sampleRequest(beta.id, "DEMO Vanilla Protein Sample", "1 kg");
  await call("RND", "patch", `/api/sample-requests/${inProcess.id}`, { status: "IN_PROCESS" });
  const dispatched = await sampleRequest(alpha.id, "DEMO Gummy Sample", "500 g");
  await call("RND", "patch", `/api/sample-requests/${dispatched.id}`, { status: "DISPATCHED", sampleCode: "DEMO-SMP-01", clientFeedback: "DEMO: tastes good" });
  const ready = await sampleRequest(beta.id, "DEMO Mango Gummy Sample", "300 g");
  await call("RND", "patch", `/api/sample-requests/${ready.id}`, { status: "READY", sampleCode: "DEMO-SMP-02" });
  const onHold = await sampleRequest(alpha.id, "DEMO Strawberry Protein Sample", "1 kg");
  await call("RND", "patch", `/api/sample-requests/${onHold.id}`, { status: "ON_HOLD", remarks: "DEMO: customer has not confirmed the flavour yet" });
  console.log("R&D flow done.");

  // ---- BD: a PO that is fully through (Completed) and one that is past its promised delivery date (Delayed)
  const done = powder("DEMO Done Whey 1kg");
  const poDone = await makePo(alpha.id, "DEMO-PO-DONE", [{ product: done, qty: 100 }], "APPROVED", 20);
  await bothPlans(poDone.id, poDone.itemOf(done.name), done.name, pA.id);
  await approveRegulatory(poDone.id, poDone.itemOf(done.name));
  await sendToProduction(poDone.id, poDone.itemOf(done.name));
  await runProduction(poDone, [done], [{ run: 4, batch: true, batchSteps: 8, handover: true, ship: 100 }], "D");
  const late = powder("DEMO Late Whey 1kg");
  const poLate = await makePo(beta.id, "DEMO-PO-LATE", [{ product: late, qty: 100 }], "APPROVED", -5); // promised 5 days ago
  await bothPlans(poLate.id, poLate.itemOf(late.name), late.name, pB.id);
  console.log("BD completed and delayed POs done.");

  // ---- Day Stores asking the Warehouse: urgent plan requests (a production request the store cannot cover) and ordinary material requests
  for (const [n, p] of plants.entries()) {
    const assignment = await prisma.dayStoreAssignment.findFirstOrThrow({ where: { dayStoreId: p.dayStoreId! }, select: { user: { include: { roles: { include: { role: true } } } } } });
    const u = assignment.user;
    const key = `DS${n}` as RoleName;
    tokens[key] = signAccessToken({ sub: u.id, roles: u.roles.map((r) => r.role.name), tokenVersion: u.tokenVersion });
    const open = (await call<{ id: string; open: boolean; toAsk: number; askedFromWarehouse: number }[]>(key, "get", "/api/inventory/my-store/production-requests?pageSize=200")).filter((r) => r.open && r.toAsk > 1e-6 && r.askedFromWarehouse === 0);
    for (const r of open.slice(0, 3)) await call(key, "post", `/api/inventory/my-store/production-requests/${r.id}/request-from-warehouse`, {});
    await call(key, "post", "/api/inventory/my-store/requests", { itemId: itemIds.get("DEMO Sweetener")!, requestedQty: 50 + n * 25, neededBy: day(5), note: "DEMO: store stock is running low" });
  }
  // ---- Finance: short RM / PM that Purchase has logged a vendor, PO number and ETA for, each at a different step of Finance's decision
  const financeItems: { name: string; category: "RM" | "PM"; unit: string; qty: number; vendor: string; pi: string; eta: number }[] = [
    { name: "DEMO Pectin", category: "RM", unit: "Kg", qty: 200, vendor: "DEMO Hydrocolloids Ltd", pi: "DEMO-PI-002", eta: 10 },
    { name: "DEMO Citric Acid", category: "RM", unit: "Kg", qty: 80, vendor: "DEMO Chem Supplies", pi: "DEMO-PI-003", eta: 6 },
    { name: "DEMO Gummy Pouch", category: "PM", unit: "Nos", qty: 5000, vendor: "DEMO Flexi Packs", pi: "DEMO-PI-004", eta: -2 },
    { name: "DEMO Glucose Syrup", category: "RM", unit: "Kg", qty: 150, vendor: "DEMO Sweet Traders", pi: "DEMO-PI-005", eta: 12 },
    { name: "DEMO Sorbitol", category: "RM", unit: "Kg", qty: 60, vendor: "DEMO Chem Supplies", pi: "DEMO-PI-006", eta: 9 },
  ];
  for (const f of financeItems) {
    const itemId = await ensureItem(f.category, f.name, f.unit);
    const requirement = await call<{ id: string }>("PPIC", "post", "/api/inventory/requirements", { date: day(0), category: f.category, itemId, unit: f.unit, requiredQty: f.qty, note: "DEMO: needed for the gummy range" });
    await call("PURCHASE", "patch", `/api/inventory/requirements/${requirement.id}/purchase`, { poNumber: f.pi, vendorName: f.vendor, eta: day(f.eta), quantity: f.qty });
  }
  const piLineId = async (pi: string) => (await prisma.requirementPurchaseLine.findFirstOrThrow({ where: { piNumber: pi }, select: { id: true } })).id;
  await call("ACCOUNTS", "post", `/api/finance/lines/${await piLineId("DEMO-PI-002")}/payment`, { kind: "PARTIAL", amount: 40000, poAmount: 90000, remark: "DEMO: 40k now, the rest after the vendor ledger is reconciled" });
  await call("ACCOUNTS", "post", `/api/finance/lines/${await piLineId("DEMO-PI-003")}/payment`, { kind: "FULL", amount: 30000, poAmount: 30000, remark: "DEMO: paid in full" });
  await call("ACCOUNTS", "post", `/api/finance/lines/${await piLineId("DEMO-PI-004")}/hold`, { remark: "DEMO: earlier invoices of this vendor are still unpaid" });
  await call("ACCOUNTS", "post", `/api/finance/lines/${await piLineId("DEMO-PI-005")}/reject`, { remark: "DEMO: rate is above the agreed rate, Purchase to renegotiate" });
  // PI-001 has waited a while for Finance; the partial payment's remark is also getting old
  await prisma.requirementPurchaseLine.updateMany({ where: { piNumber: "DEMO-PI-001" }, data: { loggedAt: new Date(Date.now() - 5 * 86_400_000) } });
  await prisma.financeDecision.updateMany({ where: { purchaseLine: { piNumber: "DEMO-PI-002" } }, data: { remarksAt: new Date(Date.now() - 4 * 86_400_000) } });
  console.log("Finance vendor payments done.");
  console.log("Store requests to the Warehouse done.");

  // Some waiting items have been waiting a while (the Admin Alerts list flags anything waiting more than 3 days)
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
  await prisma.inventoryTransaction.updateMany({ where: { grnNo: "DEMO-GRN-DIRECT" }, data: { date: ago(6) } });
  const oldRequest = await prisma.inventoryRequest.findFirst({ where: { purpose: "ISSUED_DAY_STORE", forRequestId: null, status: "PENDING", deletedAt: null }, orderBy: { createdAt: "asc" } });
  if (oldRequest) await prisma.inventoryRequest.update({ where: { id: oldRequest.id }, data: { createdAt: ago(5) } });
  await prisma.fgShipment.updateMany({ where: { type: "WAREHOUSE", status: "REQUESTED", deletedAt: null }, data: { requestedAt: ago(5) } });
  await prisma.fgShipment.updateMany({ where: { type: "CUSTOMER", status: "WITH_ACCOUNTS", deletedAt: null }, data: { requestedAt: ago(4) } });
  await prisma.itemChangeRequest.updateMany({ where: { status: "PENDING" }, data: { requestedAt: ago(4) } });
  await prisma.purchaseOrderItem.updateMany({ where: { regulatoryStatus: null, sentToRegulatoryAt: { not: null }, deletedAt: null }, data: { sentToRegulatoryAt: ago(5) } });
  // Customer tags: Alpha joined just now (New) and BD put it in the Top 10; Beta joined long ago and is in neither (Others); Gamma is brand new with no PO yet
  await prisma.customer.update({ where: { id: alpha.id }, data: { isTop10: true, top10SetAt: new Date() } });
  await prisma.customer.update({ where: { id: beta.id }, data: { createdAt: new Date(Date.now() - 200 * 86_400_000) } });
  if (!(await prisma.customer.findFirst({ where: { companyName: "DEMO Gamma Foods" } }))) await call("BD", "post", "/api/customers", { companyName: "DEMO Gamma Foods", contactPerson: "Demo Contact", contactNo: "9876543211" });
  console.log("Done. Run: npx tsx prisma/check-data.ts");
}

// ---------------------------------------------------------------------------------------------------------------------
// Production, QC, finished goods, Dispatch
// ---------------------------------------------------------------------------------------------------------------------

type PoRef = { id: string; itemOf: (name: string) => string };

/**
 * The plan's material reaches the plant: the Warehouse issues it to the plant's Day Store, then the Day Store approves each production
 * request and issues it to its Plant (as on the Material Requests screens; Admin acts as the Day Store here).
 */
async function materialToDayStore(purchaseOrderItemId: string, issueToPlant = true) {
  const requests = await prisma.inventoryRequest.findMany({ where: { purchaseOrderItemId, deletedAt: null, status: { in: ["PENDING", "APPROVED"] } }, include: { item: { select: { unit: true } } } });
  for (const r of requests) {
    const unit = r.item.unit ?? (r.category === "RM" ? "Kg" : "Nos");
    const plant = r.plantId ? await prisma.plant.findUnique({ where: { id: r.plantId }, select: { dayStoreId: true } }) : null;
    const dayStoreId = r.requestingDayStoreId ?? plant?.dayStoreId;
    if (!dayStoreId) throw new Error(`Request ${r.id} has no Store to send the material to.`);
    await receiveAtStore(await call<{ id: string }>("STORE", "post", "/api/inventory/transactions", { itemId: r.itemId, type: "ISSUED_DAY_STORE", date: day(-9), unit, quantity: r.requestedQty, dayStoreId }));
    if (!issueToPlant) continue; // the Store holds it all but has not sent it to the Plant yet: the product is "covered" at the store
    if (r.status === "PENDING") await call("ADMIN", "patch", `/api/inventory/requests/${r.id}/review`, { action: "APPROVE" });
    await call("ADMIN", "post", `/api/inventory/requests/${r.id}/issue`, { date: day(-8), unit, quantity: r.requestedQty, dayStoreId });
  }
}

type Goal = { run: -1 | 0 | 1 | 2 | 3 | 4; batch: boolean; batchSteps: number; handover: boolean; ship: number; qaHold?: boolean; coverStore?: boolean; storeHandover?: boolean };
type Made = { runId?: string; batchId?: string };

const BATCH_STEPS = ["IPQC", "QA_GATE_MFG", "BULK_QC", "PACKAGING", "QA_GATE_PACKAGING", "FG_STORE", "FG_QC_RELEASE", "FG_HANDOVER"] as const;

/** How far each of PO-B's products goes. -1 = sent to Production only; then a run at each pre-production step; then a batch through the QC /
 *  packaging / finished-goods / Dispatch steps. */
const PO_B_GOALS: Goal[] = [
  { run: -1, batch: false, batchSteps: 0, handover: false, ship: 0 }, // sent only: Production has not opened the run
  { run: 0, batch: false, batchSteps: 0, handover: false, ship: 0 }, // run opened, waiting at Material Received
  { run: 1, batch: false, batchSteps: 0, handover: false, ship: 0 }, // run at Indent Issue
  { run: 2, batch: false, batchSteps: 0, handover: false, ship: 0 }, // run at Dispensing
  { run: 3, batch: false, batchSteps: 0, handover: false, ship: 0 }, // dispensing done: READY, production not started
  { run: 4, batch: false, batchSteps: 0, handover: false, ship: 0 }, // Line Clearance approved, no batch
  ...BATCH_STEPS.map((_s, i) => ({ run: 4 as const, batch: true, batchSteps: i, handover: false, ship: 0 })), // batch waiting at each of the 8 steps
  { run: 4, batch: true, batchSteps: 8, handover: true, ship: 0 }, // with Dispatch, nothing shipped
  { run: 4, batch: true, batchSteps: 8, handover: true, ship: 30 }, // part shipped
  { run: 4, batch: true, batchSteps: 8, handover: true, ship: 100 }, // all shipped
  { run: -1, batch: false, batchSteps: 0, handover: false, ship: 0 }, // sent only; PPIC then puts it on Hold
  { run: 0, batch: false, batchSteps: 0, handover: false, ship: 0 }, // run opened; PPIC then cancels it
  { run: 4, batch: true, batchSteps: 1, handover: false, ship: 0, qaHold: true }, // QA puts the manufacturing gate on Hold
  // The same steps again so BOTH plants (and so both Day Stores) have work at each of their steps (a product goes to plant number i % 2)
  { run: 0, batch: false, batchSteps: 0, handover: false, ship: 0 }, // Material Received
  { run: 4, batch: true, batchSteps: 0, handover: false, ship: 0 }, // IPQC
  { run: 2, batch: false, batchSteps: 0, handover: false, ship: 0 }, // Dispensing
  { run: 4, batch: true, batchSteps: 4, handover: false, ship: 0 }, // QA gate (packaging)
  { run: 4, batch: true, batchSteps: 5, handover: false, ship: 0, storeHandover: true }, // FG store: Production has handed the approved goods over to the store
  { run: 4, batch: true, batchSteps: 6, handover: false, ship: 0 }, // FG QC release
  { run: 4, batch: true, batchSteps: 7, handover: false, ship: 0 }, // FG handover
  { run: -1, batch: false, batchSteps: 0, handover: false, ship: 0, coverStore: true }, // all its material is at the Store, not yet sent to the Plant
  { run: -1, batch: false, batchSteps: 0, handover: false, ship: 0, coverStore: true }, // (the other Store)
  { run: 4, batch: true, batchSteps: 5, handover: false, ship: 0, storeHandover: true }, // FG store handed over (the other Plant, so both Stores have goods to receive)
];

async function runProduction(po: PoRef, products: Product[], goals: Goal[], tag = "B"): Promise<Map<string, Made>> {
  const made = new Map<string, Made>();
  for (const [i, product] of products.entries()) {
    const goal = goals[i]!;
    const itemId = po.itemOf(product.name);
    if (goal.run === -1) {
      if (goal.coverStore) await materialToDayStore(itemId, false);
      continue;
    }
    await materialToDayStore(itemId);
    // The per-batch flow: the run has no stages of its own. goal.run says how far its (single) batch has got:
    //   0 run started, no batch yet   1 batch at Indent Issue   2 batch at Dispensing (or, on every other product, at Batch No)
    //   3 batch dispensed, waiting for QA's Line Clearance   4 line cleared: the batch is ready for production
    // (Dispensing is the plant's Day Store's step: Admin acts as the Day Store.)
    const run = await call<{ id: string }>("PRODUCTION", "post", "/api/pre-productions", { purchaseOrderItemId: itemId, batchFlow: true });
    made.set(product.name, { runId: run.id });
    if (goal.run === 0) continue;

    const batch = await call<{ id: string }>("PRODUCTION", "post", `/api/pre-productions/${run.id}/production-batches`, { plannedQty: 100 });
    made.set(product.name, { runId: run.id, batchId: batch.id });
    if (goal.run === 1) continue;
    await call("PRODUCTION", "post", `/api/production-batches/${batch.id}/indent`, { prodIndentSlipSign: "DEMO Production Head", productionPlanDate: day(-5) });
    if (goal.run === 2 && i % 2 === 1) continue; // waits at Batch No (R&D)
    await call("RND", "post", `/api/production-batches/${batch.id}/batch-no/allocate`, { batchNo: `DEMO-${tag}${String(i + 1).padStart(2, "0")}` });
    if (goal.run === 2) continue; // waits at Dispensing
    await call("ADMIN", "post", `/api/production-batches/${batch.id}/dispense`, { rmDispensingDate: day(-4), pmIssuedDate: day(-4), dispensingRemarks: "DEMO: batch material dispensed" });
    await receiveAll(batch.id); // Production confirms what the Store sent
    if (!goal.batch) continue; // ready, production not started

    // Production starts the batch (the start fields): it is then at In-Process QA, still in production, and QA and R&D take it through the QA Gate and
    // Bulk QC. Once Bulk QC has passed it comes back to Production: the RM Utilization of the whole batch (what it produced, and each plan material
    // used as it was given), the end time and Send to Packaging. The PM Utilization comes later, at Packaging.
    const start = new Date(Date.now() - 4 * 86_400_000);
    await call("PRODUCTION", "patch", `/api/production-batches/${batch.id}`, { shift: "Day", manpowerCount: 8, shiftStartAt: start.toISOString() });
    const util = (await call<{ utilization: { items: { itemId: string; category: string; unit: string; givenQty: number }[] } }[]>("PRODUCTION", "get", `/api/pre-productions/${run.id}/production-batches`)).find((b: any) => b.id === batch.id)!.utilization.items;
    // The Utilization of the whole batch: what was produced, and each material of the plan used as it was given.
    const saveUtilization = async (category: "RM" | "PM") =>
      call("PRODUCTION", "put", `/api/production-batches/${batch.id}/utilization/${category}`, { producedQty: 100, wasteQty: 0, rejectQty: 0, sampleQty: 0, lines: util.filter((x) => x.category === category).map((n) => ({ itemId: n.itemId, consumedQty: n.givenQty })) });
    let sent = false;
    const sendToPackaging = async () => {
      await saveUtilization("RM");
      await call("PRODUCTION", "patch", `/api/production-batches/${batch.id}`, { shiftEndAt: new Date(start.getTime() + 9 * 3_600_000).toISOString(), manufacturingStatus: "Completed" });
      await call("PRODUCTION", "post", `/api/production-batches/${batch.id}/complete`, {});
      sent = true;
    };

    const step = (role: RoleName, body: Record<string, unknown>) => call(role, "patch", `/api/production-batches/${batch.id}/stage`, { action: "FORWARD", ...body });
    const bodies: [RoleName, Record<string, unknown>][] = [
      ["QA_QC", { ipqcStatus: "Approved", ipqcRemarks: "DEMO: checks fine" }],
      ["QA_QC", { mfgQaStatus: "Approved", mfgQcStatus: "Approved", mfgApprovedQty: 100, mfgRejectedQty: 0, mfgWastageQty: 0 }],
      ["RND", { bulkQcStatus: "Approved", bulkQcRemarks: "DEMO: bulk passed" }],
      ["PRODUCTION", { packagingStatus: "Completed", packagingStartDate: day(-3), packagingEndDate: day(-2) }],
      ["QA_QC", { packQaStatus: "Approved", packQcStatus: "Approved", packApprovedQty: 100, packRejectedQty: 0, packWastageQty: 0 }],
      ["ADMIN", { fgStoreReceivedDate: day(-1), fgStoreRemarks: "DEMO: 100 tubs counted" }],
      ["QA_QC", { fgQaStatus: "Approved", fgQcStatus: "Approved", fgRemarks: "DEMO: released" }],
      ["ADMIN", {}],
    ];
    // goal.batchSteps = how many steps are already DONE (the batch then waits at the next one)
    for (let s = 0; s < Math.min(goal.batchSteps, bodies.length); s++) {
      if (s === 3) {
        if (!sent) await sendToPackaging();
        // Packaging: the PM Utilization and the packaging sheet (shift, manpower, start and end); saving the finished sheet sends the batch to QA's packaging gate
        await saveUtilization("PM");
        await call("PRODUCTION", "patch", `/api/production-batches/${batch.id}/packaging`, { packagingShift: "Day", packagingManpowerCount: 6, packagingStartAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), packagingEndAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), packagingStatus: "Completed", packagingRemarks: "DEMO: packed" });
      } else {
        // QA approved the packed goods (step 4): Production hands them over to the store, which makes them the Day Store's finished goods to receive
        if (s === 5) await call("PRODUCTION", "post", `/api/production-batches/${batch.id}/handover-to-store`, {});
        await step(bodies[s]![0], bodies[s]![1]);
      }
    }
    if (goal.batchSteps >= 3 && !sent) await sendToPackaging(); // Bulk QC has passed and the batch was sent to Packaging: it waits there
    // QA approved the packed goods and Production handed them over to the store: they are the Day Store's finished goods to receive (without this flag they wait for Production)
    if (goal.storeHandover) await call("PRODUCTION", "post", `/api/production-batches/${batch.id}/handover-to-store`, {});
    made.set(product.name, { runId: run.id, batchId: batch.id });
    // QA holds the manufacturing gate: the batch stays there, marked On Hold
    if (goal.qaHold) await step("QA_QC", { mfgQaStatus: "Hold", mfgQcStatus: "Approved", mfgApprovedQty: 0, mfgRejectedQty: 0, mfgWastageQty: 0 }).catch(() => step("QA_QC", { mfgQaStatus: "Hold", mfgQcStatus: "Hold" }));
    if (goal.ship > 0) {
      const shipment = await call<{ id: string }>("DISPATCH", "post", `/api/fg/batches/${batch.id}/customer-shipments`, { quantity: goal.ship, transportType: "By Land", transportName: "DEMO Roadways", vehicleNo: "RJ14 GB 4521", lrNo: `DEMO-LR-${tag}${i + 1}`, weightKg: goal.ship * 1.05, cartonCount: Math.ceil(goal.ship / 12), goodsValue: goal.ship * 500, freightCharge: 900 });
      await call("ACCOUNTS", "post", `/api/fg/shipments/${shipment.id}/accounts-approve`, { invoiceNo: `DEMO-INV-${tag}${i + 1}`, invoiceDate: day(-1), invoiceAmount: goal.ship * 500, ewayBillNo: `DEMO-EWB-${tag}${i + 1}`, ewayBillDate: day(-1) });
      await call("DISPATCH", "post", `/api/fg/shipments/${shipment.id}/send-to-customer`, {});
    }
  }
  return made;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());


/** Production's Receive step: confirms everything the Day Store sent for the batch (Admin acts as Production). */
async function receiveAll(batchId: string) {
  const board = await call<{ id: string; receiveLines?: { lineId: string }[] }[]>("ADMIN", "get", "/api/production-batches/prep-board?stage=RECEIVE");
  const row = board.find((r) => r.id === batchId);
  if (row?.receiveLines?.length) await call("ADMIN", "post", `/api/production-batches/${batchId}/receive`, { lines: row.receiveLines.map((l) => ({ lineId: l.lineId, action: "RECEIVE" })) });
}
