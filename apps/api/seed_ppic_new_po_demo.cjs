// Demo data for PPIC's "New POs — Not Planned Yet" dashboard tile.
//
// Five DEMO POs under customer "DEMO Nutraceuticals" (all poNumbers start
// with "DEMO-PO-", so cleanup is `deleteMany({ where: { poNumber: { startsWith: "DEMO-PO-" } } })`):
//   1001 / 1002 / 1003 — Approved, no plan yet   -> shows in PPIC's tile
//   1004               — Approved, has a Draft BOM plan on one product -> planning started, NOT in the tile
//   1005               — Draft (BD hasn't approved) -> invisible to PPIC, visible to BD/Admin
// It also adds demo RM / BOM plans + stock (seedPlanning below): 1001/Whey, 1002/Bar, 1004/Creatine
// are Partially Planned; 1003 Capsules + Tablets are fully planned (Material Planning: covered / short).
// Idempotent: a PO number that already exists is skipped. Real POs are untouched.
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DAY = 24 * 60 * 60 * 1000;

const DEMO_POS = [
  { poNumber: "DEMO-PO-1001", status: "APPROVED", items: [["DEMO Whey Protein Chocolate 1kg", "Powder", 500, "KG"], ["DEMO Ashwagandha Gummies 60ct", "Gummies", 2000, "SKU"]] },
  { poNumber: "DEMO-PO-1002", status: "APPROVED", items: [["DEMO Protein Bar Peanut Butter 50g", "Bars", 5000, "SKU"]] },
  { poNumber: "DEMO-PO-1003", status: "APPROVED", items: [["DEMO Multivitamin Capsules 60ct", "Capsule", 3000, "SKU"], ["DEMO Zinc Tablets 30ct", "Tablet", 4000, "SKU"]] },
  { poNumber: "DEMO-PO-1004", status: "APPROVED", withDraftBomPlan: true, items: [["DEMO Creatine Monohydrate 250g", "Powder", 300, "KG"]] },
  { poNumber: "DEMO-PO-1005", status: "DRAFT", items: [["DEMO L-Carnitine Liquid 200ml", "Liquid", 1000, "SKU"]] },
  // 1006 - fully planned + covered products at different points of "ready":
  //   Mass Gainer / BCAA  -> already sent to Production (In Production tile)
  //   Omega-3             -> ready, Regulatory Approved + Plant     (PO Readiness: Send to Production works)
  //   Vitamin D3          -> ready, Regulatory still Pending         (Send disabled: waiting on Regulatory)
  //   Collagen            -> ready, Approved but no Plant            (Send disabled: assign a Plant)
  {
    poNumber: "DEMO-PO-1006",
    status: "APPROVED",
    items: [
      ["DEMO Mass Gainer 3kg", "Powder", 200, "KG"],
      ["DEMO BCAA Powder 400g", "Powder", 150, "KG"],
      ["DEMO Omega-3 Softgels 60ct", "Capsule", 800, "SKU"],
      ["DEMO Vitamin D3 Drops 30ml", "Liquid", 500, "SKU"],
      ["DEMO Collagen Powder 250g", "Powder", 100, "KG"],
    ],
  },
  // 1007 - the "other" states, so every list and badge has something in it:
  //   Green Tea Caps -> fully planned, ON HOLD       (Material Planning: On Hold + if-released preview)
  //   Pre-Workout    -> fully planned, Regulatory NOT APPROVED (Material Planning preview, doesn't claim stock)
  //   Sleep Gummies  -> fully planned, material SHORT (Material Planning: Short, goes to Purchase by itself)
  //   Electrolyte    -> not planned at all, on hold  (Not Planned: On Hold)
  //   Biotin Gummies -> CANCELLED                    (PO page: Cancelled banner)
  {
    poNumber: "DEMO-PO-1007",
    status: "APPROVED",
    items: [
      ["DEMO Green Tea Extract Caps 60ct", "Capsule", 600, "SKU"],
      ["DEMO Pre-Workout Powder 300g", "Powder", 120, "KG"],
      ["DEMO Sleep Gummies 30ct", "Gummies", 900, "SKU"],
      ["DEMO Electrolyte Mix 200g", "Powder", 80, "KG"],
      ["DEMO Biotin Gummies 60ct", "Gummies", 700, "SKU"],
    ],
  },
];

// --- Planning demo: RM / BOM plans on the demo POs, so the "Not Planned" list
// has Partially Planned rows and Material Planning has Covered + Short rows.
// Plans are written straight to the DB (already CALCULATED, with a small
// hand-made snapshot) — no catalog needed. Idempotent: a plan / stock item
// that already exists is left alone.
async function ensureStockItem(category, name, unit, qty, adminId) {
  const existing = await prisma.inventoryItem.findUnique({ where: { category_name: { category, name } } });
  if (existing) return existing;
  const item = await prisma.inventoryItem.create({ data: { category, name, unit } });
  if (qty > 0) {
    await prisma.inventoryTransaction.create({
      data: { itemId: item.id, type: "RECEIVED", date: new Date(), unit, quantity: qty, vendorName: "Demo Vendor", createdById: adminId, receiptStatus: "ACCEPTED", acceptedById: adminId, acceptedAt: new Date() },
    });
  }
  return item;
}

async function ensureCalculatedPlan(kind, item, needs, adminId) {
  const name = `${item.productName} — ${kind === "rm" ? "RM" : "BOM"}`;
  const model = kind === "rm" ? prisma.rmPlan : prisma.bomPlan;
  if (await model.findFirst({ where: { purchaseOrderItemId: item.id, status: "CALCULATED" } })) return false;
  const base = { name, createdById: adminId, purchaseOrderItemId: item.id, status: "CALCULATED", calculatedAt: new Date() };
  if (kind === "rm") {
    await prisma.rmPlan.create({
      data: {
        ...base,
        costingParams: {},
        resultSnapshot: { batches: [], procurement: needs.map(([n, qty]) => ({ name: n, brand: "DEMO", estCostPerKg: 0, totalKg: qty, sources: { [item.productName]: qty } })) },
      },
    });
  } else {
    await prisma.bomPlan.create({
      data: {
        ...base,
        resultSnapshot: {
          totalYield: item.quantity,
          brands: ["DEMO Nutraceuticals"],
          lines: needs.map(([n, qty]) => ({ category: "1-Primary", component: n, spec: "DEMO", baseQty: qty, wastageRate: 0, bufferQty: 0, totalQty: qty, sources: { [item.productName]: qty } })),
        },
      },
    });
  }
  return true;
}

async function seedPlanning(admin) {
  // Live stock the demo plans compete for. Cocoa / Amber Jar are shared by the
  // two 1003 products, so the second one comes up short (FIFO).
  const stock = [
    ["RM", "DEMO Whey Isolate", "Kg", 1000],
    ["RM", "DEMO Cocoa Extract", "Kg", 120],
    ["RM", "DEMO Creatine Base", "Kg", 500],
    ["PM", "DEMO Amber Jar 60ct", "Nos", 5000],
    ["PM", "DEMO Shipper Carton", "Nos", 200],
    ["PM", "DEMO Bar Wrapper", "Nos", 5000],
    // plenty of these, so every 1006 product is fully covered
    ["RM", "DEMO Protein Base", "Kg", 2000],
    ["PM", "DEMO Tub 1kg", "Nos", 10000],
    ["PM", "DEMO Tub Lid", "Nos", 10000],
    ["RM", "DEMO Melatonin Blend", "Kg", 10], // far less than Sleep Gummies needs -> short
  ];
  // The Plant PPIC assigns for production (Send to Production needs one).
  let plant = await prisma.plant.findFirst({ where: { name: "DEMO Plant 1" } });
  if (!plant) plant = await prisma.plant.create({ data: { name: "DEMO Plant 1", createdById: admin.id } });
  for (const [category, name, unit, qty] of stock) await ensureStockItem(category, name, unit, qty, admin.id);

  const find = (poNumber, productName) => prisma.purchaseOrderItem.findFirst({ where: { productName, purchaseOrder: { poNumber } } });
  const plans = [
    // [PO, product, rm needs | null, bom needs | null]
    ["DEMO-PO-1001", "DEMO Whey Protein Chocolate 1kg", [["DEMO Whey Isolate", 450], ["DEMO Cocoa Extract", 30]], null], // RM only -> Partially Planned
    ["DEMO-PO-1002", "DEMO Protein Bar Peanut Butter 50g", null, [["DEMO Bar Wrapper", 5000]]], // BOM only -> Partially Planned
    ["DEMO-PO-1004", "DEMO Creatine Monohydrate 250g", [["DEMO Creatine Base", 300]], null], // RM only (its BOM is still a Draft) -> Partially Planned
    ["DEMO-PO-1003", "DEMO Multivitamin Capsules 60ct", [["DEMO Cocoa Extract", 100]], [["DEMO Amber Jar 60ct", 3000], ["DEMO Shipper Carton", 60]]], // both -> Material Planning, covered
    ["DEMO-PO-1003", "DEMO Zinc Tablets 30ct", [["DEMO Cocoa Extract", 60]], [["DEMO Amber Jar 60ct", 4000], ["DEMO Shipper Carton", 80]]], // both -> Material Planning, short
    // PO 1006 - 5th element: what else is set on the product
    ["DEMO-PO-1006", "DEMO Mass Gainer 3kg", [["DEMO Protein Base", 200]], [["DEMO Tub 1kg", 200], ["DEMO Tub Lid", 200]], { reg: "Approved", plant: true, sent: true }], // sent -> In Production
    ["DEMO-PO-1006", "DEMO BCAA Powder 400g", [["DEMO Protein Base", 150]], [["DEMO Tub 1kg", 150]], { reg: "Approved", plant: true, sent: true }], // sent -> In Production
    ["DEMO-PO-1006", "DEMO Omega-3 Softgels 60ct", [["DEMO Protein Base", 80]], [["DEMO Tub Lid", 800]], { reg: "Approved", plant: true }], // ready, can be sent
    ["DEMO-PO-1006", "DEMO Vitamin D3 Drops 30ml", [["DEMO Protein Base", 50]], [["DEMO Tub 1kg", 500]], { plant: true }], // ready, Regulatory Pending
    ["DEMO-PO-1006", "DEMO Collagen Powder 250g", [["DEMO Protein Base", 100]], [["DEMO Tub 1kg", 100]], { reg: "Approved" }], // ready, no Plant yet
    // PO 1007
    ["DEMO-PO-1007", "DEMO Green Tea Extract Caps 60ct", [["DEMO Protein Base", 40]], [["DEMO Tub Lid", 100]], { reg: "Approved", held: true }], // on hold
    ["DEMO-PO-1007", "DEMO Pre-Workout Powder 300g", [["DEMO Protein Base", 60]], [["DEMO Tub 1kg", 60]], { notApproved: true }], // Regulatory Not Approved
    ["DEMO-PO-1007", "DEMO Sleep Gummies 30ct", [["DEMO Melatonin Blend", 60]], [["DEMO Tub Lid", 50]], { reg: "Approved" }], // short on Melatonin
  ];
  for (const [poNumber, productName, rmNeeds, bomNeeds, opts = {}] of plans) {
    const item = await find(poNumber, productName);
    if (!item) {
      console.log(`skip plans for ${productName} (PO ${poNumber} not found)`);
      continue;
    }
    const rm = rmNeeds ? await ensureCalculatedPlan("rm", item, rmNeeds, admin.id) : false;
    const bom = bomNeeds ? await ensureCalculatedPlan("bom", item, bomNeeds, admin.id) : false;
    // What the app does automatically once a plan is calculated: hand the
    // product to Regulatory (Capsules already Approved, the rest Pending).
    const approved = productName.includes("Capsules") || opts.reg === "Approved";
    await prisma.purchaseOrderItem.update({
      where: { id: item.id },
      data: {
        sentToRegulatoryAt: item.sentToRegulatoryAt ?? new Date(),
        ...(approved && !item.regulatoryStatus ? { regulatoryStatus: "Approved", regulatoryReviewedById: admin.id, regulatoryReviewedAt: new Date() } : {}),
        ...(opts.plant ? { plannedPlantId: plant.id } : {}),
        ...(opts.held ? { materialHeldAt: item.materialHeldAt ?? new Date(), materialHeldById: admin.id } : {}),
        ...(opts.notApproved && !item.regulatoryStatus
          ? { regulatoryStatus: "Not Approved", regulatoryRemarks: "Dose above the permitted limit - revise the formulation and recalculate.", regulatoryReviewedById: admin.id, regulatoryReviewedAt: new Date() }
          : {}),
        ...(opts.sent ? { planSentToProductionAt: item.planSentToProductionAt ?? new Date() } : {}),
      },
    });
    console.log(`${productName}: ${rm ? "RM plan added" : rmNeeds ? "RM plan exists" : "no RM plan"}, ${bom ? "BOM plan added" : bomNeeds ? "BOM plan exists" : "no calculated BOM plan"}`);
  }

  // --- States with no plan: Electrolyte is held while still Not Planned, Biotin is cancelled.
  const electrolyte = await find("DEMO-PO-1007", "DEMO Electrolyte Mix 200g");
  if (electrolyte && !electrolyte.materialHeldAt) {
    await prisma.purchaseOrderItem.update({ where: { id: electrolyte.id }, data: { materialHeldAt: new Date(), materialHeldById: admin.id } });
    console.log("DEMO Electrolyte Mix: put on hold (still Not Planned)");
  }
  const biotin = await find("DEMO-PO-1007", "DEMO Biotin Gummies 60ct");
  if (biotin && !biotin.cancelledAt) {
    await prisma.purchaseOrderItem.update({ where: { id: biotin.id }, data: { cancelledAt: new Date(), cancelledById: admin.id, cancelReason: "Customer dropped this SKU from the order" } });
    console.log("DEMO Biotin Gummies: cancelled");
  }

  // --- Purchase: log a PO (with vendor + ETA) against one shortfall that Material Planning sent
  // over, so "PO Logged by Purchase" has a row from this flow; the other stays open.
  const purchaseUser = (await prisma.user.findFirst({ where: { isActive: true, roles: { some: { role: { name: "PURCHASE" } } } }, select: { id: true } })) ?? admin;
  const openFromPlanning = await prisma.preInventoryRequirement.findFirst({ where: { sourcePoItemId: { not: null }, purchaseAt: null, deletedAt: null }, orderBy: { createdAt: "asc" } });
  if (openFromPlanning) {
    await prisma.preInventoryRequirement.update({
      where: { id: openFromPlanning.id },
      data: { poNumber: "DEMO-PUR-7001", vendorName: "DEMO Supplier Pvt Ltd", eta: new Date(Date.now() + 10 * DAY), purchaseAt: new Date(), purchaseById: purchaseUser.id },
    });
    console.log("Purchase logged a PO (DEMO-PUR-7001, ETA +10 days) against a Material Planning shortfall");
  }

  // --- Warehouse: two more deliveries waiting for Inward QC ("Material Received (Awaiting QC)").
  const qcItems = [
    ["RM", "DEMO Protein Base", "Kg", 500],
    ["PM", "DEMO Tub 1kg", "Nos", 2000],
  ];
  for (const [category, name, unit, qty] of qcItems) {
    const inv = await prisma.inventoryItem.findUnique({ where: { category_name: { category, name } } });
    if (!inv) continue;
    const exists = await prisma.inventoryTransaction.findFirst({ where: { itemId: inv.id, type: "RECEIVED", receiptStatus: "PENDING_QC", vendorName: "DEMO Supplier Pvt Ltd" } });
    if (exists) continue;
    await prisma.inventoryTransaction.create({
      data: { itemId: inv.id, type: "RECEIVED", date: new Date(), unit, quantity: qty, vendorName: "DEMO Supplier Pvt Ltd", createdById: admin.id, receiptStatus: "PENDING_QC" },
    });
    console.log(`Received ${qty} ${unit} of ${name} - awaiting Inward QC`);
  }
}

async function main() {
  const admin = await prisma.user.findUnique({ where: { email: "admin@fls.local" } });
  if (!admin) throw new Error("admin@fls.local not found — is the dev DB seeded?");

  let customer = await prisma.customer.findFirst({ where: { companyName: "DEMO Nutraceuticals" } });
  if (!customer) customer = await prisma.customer.create({ data: { companyName: "DEMO Nutraceuticals", createdById: admin.id } });

  // Product Category must exist in the master list (seeded by the migration).
  const categories = new Set((await prisma.productCategory.findMany({ select: { name: true } })).map((c) => c.name));

  let created = 0;
  for (const [i, def] of DEMO_POS.entries()) {
    if (await prisma.purchaseOrder.findFirst({ where: { poNumber: def.poNumber }, select: { id: true } })) {
      console.log(`skip ${def.poNumber} (already exists)`);
      continue;
    }
    for (const [, category] of def.items) if (!categories.has(category)) throw new Error(`Product Category "${category}" missing from the master list`);

    const now = Date.now();
    const approved = def.status === "APPROVED";
    const po = await prisma.purchaseOrder.create({
      data: {
        customerId: customer.id,
        poNumber: def.poNumber,
        orderDate: new Date(now - (5 - i) * DAY),
        expectedDeliveryDate: new Date(now + (30 + i * 7) * DAY),
        status: def.status,
        reviewedById: approved ? admin.id : null,
        reviewedAt: approved ? new Date() : null,
        createdById: admin.id,
        items: {
          // 1ms-apart createdAt keeps the item order stable (same reason as the real create route).
          create: def.items.map(([productName, productCategory, quantity, unit], idx) => ({ productName, productCategory, quantity, unit, createdAt: new Date(now + idx) })),
        },
      },
      include: { items: true },
    });

    if (def.withDraftBomPlan) {
      await prisma.bomPlan.create({ data: { name: `${po.items[0].productName} — BOM`, createdById: admin.id, purchaseOrderItemId: po.items[0].id } });
    }
    created += 1;
    console.log(`created ${def.poNumber} (${def.status}, ${po.items.length} product${po.items.length === 1 ? "" : "s"}${def.withDraftBomPlan ? ", Draft BOM plan" : ""})`);
  }
  console.log(`done — ${created} PO(s) created`);

  await seedPlanning(admin);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
