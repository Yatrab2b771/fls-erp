import bcrypt from "bcryptjs";
import { RoleName } from "@prisma/client";
import { prisma } from "../src/common/lib/prisma";

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "Demo1234!";
const DEMO_USERS: { email: string; fullName: string; role: RoleName }[] = [
  { email: "bd@fls.local", fullName: "BD Dept. Demo", role: RoleName.BD },
  { email: "ppic@fls.local", fullName: "PPIC Dept. Demo", role: RoleName.PPIC },
  { email: "store@fls.local", fullName: "Store Dept. Demo", role: RoleName.STORE },
  { email: "purchase@fls.local", fullName: "Purchase Dept. Demo", role: RoleName.PURCHASE },
  { email: "accounts@fls.local", fullName: "Accounts Dept. Demo", role: RoleName.ACCOUNTS },
  { email: "production@fls.local", fullName: "Production Dept. Demo", role: RoleName.PRODUCTION },
  { email: "qa_qc@fls.local", fullName: "QA/QC Dept. Demo", role: RoleName.QA_QC },
  { email: "dispatch@fls.local", fullName: "Dispatch Dept. Demo", role: RoleName.DISPATCH },
  { email: "rnd@fls.local", fullName: "R&D Dept. Demo", role: RoleName.RND },
];

async function seedRoles() {
  for (const name of Object.values(RoleName)) {
    await prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  }
  console.log(`Seeded ${Object.values(RoleName).length} roles.`);
}

/** Returns the bootstrap admin's id, creating the account first if it doesn't exist yet — used as the createdById for infra rows (like the two Warehouses) that should exist regardless of whether demo dept. users get seeded. */
async function seedAdmin(): Promise<string> {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@fls.local";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existing) {
    console.log(`Admin ${adminEmail} already exists — skipping.`);
    return existing.id;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const admin = await prisma.user.create({ data: { email: adminEmail, passwordHash, fullName: "System Admin" } });
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.ADMIN } });
  await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });

  console.log(`Created bootstrap admin: ${adminEmail} / ${adminPassword}`);
  console.log("Log in and change this password immediately — it is not safe for anything beyond local dev.");
  return admin.id;
}

/** The two fixed Warehouse rows — one per InventoryCategory, capped by the schema's `category @unique`. Upserted by category so this is safe to re-run and safe to rename later without the seed fighting a rename back. */
async function seedWarehouses(createdById: string) {
  const warehouses: { name: string; category: "RM" | "PM" }[] = [
    { name: "RM Warehouse", category: "RM" },
    { name: "PM Warehouse", category: "PM" },
  ];

  for (const w of warehouses) {
    const existing = await prisma.warehouse.findUnique({ where: { category: w.category } });
    if (existing) continue;
    await prisma.warehouse.create({ data: { name: w.name, category: w.category, createdById } });
    console.log(`Created warehouse: ${w.name} (${w.category})`);
  }
}

/** Returns the BD demo user's id, creating all demo dept. users if they don't exist yet. */
/** Returns a { role: userId } map for every demo department user, creating them if they don't exist yet. */
async function seedDemoUsers(): Promise<Partial<Record<RoleName, string>>> {
  const idsByRole: Partial<Record<RoleName, string>> = {};

  for (const demo of DEMO_USERS) {
    let user = await prisma.user.findUnique({ where: { email: demo.email } });
    if (!user) {
      const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
      user = await prisma.user.create({ data: { email: demo.email, passwordHash, fullName: demo.fullName } });
      const role = await prisma.role.findUniqueOrThrow({ where: { name: demo.role } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
      console.log(`Created demo user: ${demo.email} / ${DEMO_PASSWORD} (${demo.role})`);
    }
    idsByRole[demo.role] = user.id;
  }

  return idsByRole;
}

/** 2 customers, a fresh multi-product PO, and a mid-flight multi-product PO with batches at different stages, one deliberately delayed. */
async function seedCustomersAndOrders(bdUserId: string | null, ppicUserId: string | undefined) {
  if (!bdUserId) {
    console.log("No BD demo user available — skipping demo customers/orders.");
    return;
  }

  const findOrCreateCustomer = async (data: Parameters<typeof prisma.customer.create>[0]["data"] & { companyName: string }) => {
    const existing = await prisma.customer.findFirst({ where: { companyName: data.companyName } });
    if (existing) return existing;
    return prisma.customer.create({ data });
  };

  const acme = await findOrCreateCustomer({
    companyName: "Acme Wellness Retail Pvt. Ltd.",
    contactPerson: "Rohan Mehta",
    contactNo: "+91 98765 43210",
    gstNo: "07AACCA1234F1Z5",
    email: "orders@acmewellness.example",
    deliveryAddress: "Plot 14, Sector 63, Noida, Uttar Pradesh",
    createdById: bdUserId,
  });

  const nova = await findOrCreateCustomer({
    companyName: "Nova Nutraceuticals LLP",
    contactPerson: "Priya Nair",
    contactNo: "+91 90000 11223",
    gstNo: "06AAFCN5678G1Z2",
    email: "procurement@novanutra.example",
    deliveryAddress: "B-22 Industrial Estate, Faridabad, Haryana",
    createdById: bdUserId,
  });

  const freshPo = "PO-2026-0142";
  if (!(await prisma.purchaseOrder.findFirst({ where: { poNumber: freshPo } }))) {
    // Left as DRAFT deliberately — exercises the BD Approve/Reject step
    // before anything downstream can happen.
    const order = await prisma.purchaseOrder.create({
      data: {
        customerId: acme.id,
        createdById: bdUserId,
        poNumber: freshPo,
        orderDate: new Date("2026-08-14"),
        regulatoryBody: "FSSAI",
        regulatoryStatus: "Applied",
        items: {
          create: [
            { productName: "Whey Gold 1kg", dosageForm: "Powders", quantity: 1000, unit: "SKU", packSize: "1kg", packType: "Jar" },
            { productName: "Creatine Monohydrate 500g", dosageForm: "Powders", quantity: 500, unit: "SKU", packSize: "500g", packType: "Jar" },
          ],
        },
      },
    });
    console.log(`Created demo PO "${freshPo}" (${order.id}) — 2 product line items, DRAFT (awaiting BD approval), no batches yet.`);
  } else {
    console.log(`PO "${freshPo}" already exists — skipping.`);
  }

  const midPo = "PO-2026-0098";
  if (await prisma.purchaseOrder.findFirst({ where: { poNumber: midPo } })) {
    console.log(`PO "${midPo}" already exists — skipping.`);
    return;
  }

  const midOrder = await prisma.purchaseOrder.create({
    data: {
      customerId: nova.id,
      createdById: bdUserId,
      poNumber: midPo,
      orderDate: new Date("2026-07-20"),
      regulatoryBody: "FSSAI",
      regulatoryStatus: "Issued",
      // APPROVED — batches can only be released against an approved PO.
      status: "APPROVED",
      reviewedById: bdUserId,
      reviewedAt: new Date("2026-07-21"),
      items: {
        create: [
          { productName: "BCAA 2:1:1 300g", dosageForm: "Powders", quantity: 1500, unit: "SKU", packSize: "300g", packType: "Jar" },
        ],
      },
    },
    include: { items: true },
  });
  const item = midOrder.items[0]!;

  // One batch carried all the way through the manufacturing QA gate,
  // currently sitting at Packaging — every earlier stage's fields filled
  // in, plus a few representative history events.
  const batch1 = await prisma.batch.create({
    data: {
      purchaseOrderItemId: item.id,
      batchNo: "GB-BCAA-0098",
      currentStageId: "PACKAGING",
      prodIndentSlipSign: "PPIC-IND-0098",
      productionPlanDate: new Date("2026-07-28"),
      unit: "41",
      dispatchPlanDate: new Date("2026-08-18"),
      rmPoDate: new Date("2026-07-21"),
      rmExpectedDate: new Date("2026-07-30"),
      rmStatus: "Available",
      pmPoDate: new Date("2026-07-21"),
      pmExpectedDate: new Date("2026-07-29"),
      pmStatus: "Available",
      rmDispensingDate: new Date("2026-07-31"),
      pmIssuedDate: new Date("2026-07-31"),
      manufacturingStartDate: new Date("2026-08-01"),
      manufacturingStatus: "Blending",
      manufacturingEndDate: new Date("2026-08-03"),
      mfgQaStatus: "Approved",
      mfgQcStatus: "Approved",
    },
  });
  if (ppicUserId) {
    await prisma.batchStageEvent.createMany({
      data: [
        { batchId: batch1.id, fromStageId: "PO_RELEASE", toStageId: "MATERIAL_RECEIVED", action: "FORWARD", actorId: ppicUserId, createdAt: new Date("2026-07-22") },
        { batchId: batch1.id, fromStageId: "PRODUCTION_EXECUTION", toStageId: "QA_GATE_MFG", action: "FORWARD", actorId: ppicUserId, createdAt: new Date("2026-08-03") },
        {
          batchId: batch1.id,
          fromStageId: "QA_GATE_MFG",
          toStageId: "PACKAGING",
          action: "FORWARD",
          note: "Bulk approved — transferred to packing area.",
          actorId: ppicUserId,
          createdAt: new Date("2026-08-04"),
        },
      ],
    });
  }

  // A second batch against the same line item, still early (Indent Issue
  // — which now also carries the former Production Plan fields) and
  // overdue on its own dispatch plan date — exercises the delay indicator.
  await prisma.batch.create({
    data: {
      purchaseOrderItemId: item.id,
      batchNo: "GB-BCAA-0098-B",
      currentStageId: "INDENT_ISSUE",
      productionPlanDate: new Date("2026-07-18"),
      unit: "48",
      dispatchPlanDate: new Date("2026-08-05"),
      rmStatus: "Available",
      pmStatus: "Available",
    },
  });

  console.log(`Created demo PO "${midPo}" (${midOrder.id}) — 1 line item, 2 batches (one at Packaging with history, one overdue at Indent Issue).`);
}

// Same fixture bom-engine.test.ts is pinned to, so a real BOM plan
// calculated through the UI behaves identically to the unit test.
const DEMO_SKU = {
  productName: "Whey Gold 1kg",
  jar: "1kg HDPE Jar",
  wadMm: "83mm",
  scoopMl: "30ml",
  silicaGelGms: "2",
  silicaGelQtyNos: "1",
  authenticationSticker: "Yes",
  leaflet: "Yes",
  corrugatedBoxMm: "5-ply",
  packagingSizeNos: "12",
};

/** One Customer's SKU and one calculated BOM plan, so Packaging BOM has something real to look at immediately. */
async function seedPackagingBom(ppicUserId: string | undefined) {
  if (!ppicUserId) {
    console.log("No PPIC demo user available — skipping demo packaging BOM catalog/plan.");
    return;
  }
  if ((await prisma.bomPlan.count()) > 0) {
    console.log("BOM plans already exist — skipping demo catalog/plan.");
    return;
  }

  // Same customer as freshPo's "Whey Gold 1kg" line above (formerly tagged
  // with the separate free-text Brand "AlphaBrand") — the catalog now
  // genuinely matches that PO's product instead of a disconnected demo Brand.
  const acme = await prisma.customer.findFirst({ where: { companyName: "Acme Wellness Retail Pvt. Ltd." } });
  if (!acme) {
    console.log("Acme demo customer not found — skipping demo packaging BOM catalog/plan.");
    return;
  }
  const sku = await prisma.sku.upsert({
    where: { customerId_productName: { customerId: acme.id, productName: DEMO_SKU.productName } },
    create: { customerId: acme.id, ...DEMO_SKU },
    update: {},
  });

  const plan = await prisma.bomPlan.create({ data: { name: "Demo Packaging Run", createdById: ppicUserId } });
  await prisma.bomPlanItem.create({ data: { planId: plan.id, skuId: sku.id, targetYield: 1000, addedById: ppicUserId } });

  console.log(`Created demo catalog (${acme.companyName} / ${DEMO_SKU.productName}) and BOM plan "${plan.name}" (${plan.id}).`);
}

// Same fixture rm-costing-engine.test.ts is pinned to, so a real RM plan
// calculated through the UI behaves identically to the unit test.
const DEMO_RECIPE_INGREDIENTS = [
  { name: "PEA PROTEIN EXTRACT", brand: "YANTAI CO", costPerKg: 360, gPerServing: 7.0, proteinPct: 0.8, sortOrder: 0 },
  { name: "YEAST PROTEIN", brand: "ANGEL", costPerKg: 680, gPerServing: 23.0, proteinPct: 0.8, sortOrder: 1 },
  { name: "SUCRALOSE PURE POWDER", brand: "TECHNO", costPerKg: 1400, gPerServing: 0.12, proteinPct: 0, sortOrder: 2 },
];

/** One recipe and one calculated RM plan — owned by PPIC here, since RND isn't part of this rebuild's role scope. */
async function seedRmCosting(ppicUserId: string | undefined) {
  if (!ppicUserId) {
    console.log("No PPIC demo user available — skipping demo RM costing recipe/plan.");
    return;
  }
  if ((await prisma.rmPlan.count()) > 0) {
    console.log("RM costing plans already exist — skipping demo recipe/plan.");
    return;
  }

  const totalServing = DEMO_RECIPE_INGREDIENTS.reduce((sum, ing) => sum + ing.gPerServing, 0);
  const recipe = await prisma.recipe.upsert({
    where: { name: "CHOCOLATE PLANT NUTRITION" },
    create: { name: "CHOCOLATE PLANT NUTRITION", totalServing, ingredients: { create: DEMO_RECIPE_INGREDIENTS } },
    update: {},
  });

  const plan = await prisma.rmPlan.create({
    data: {
      name: "Demo RM Costing Run",
      costingParams: { mfgLossPct: 3, packSizeG: 400, testCost: 2000, jarCost: 25, scoopCost: 8, labelCost: 23, convCost: 25, ccbCost: 8, profitPct: 10, gstPct: 0 },
      createdById: ppicUserId,
    },
  });
  await prisma.rmPlanItem.create({ data: { planId: plan.id, recipeId: recipe.id, batchSizeKg: 100, addedById: ppicUserId } });

  console.log(`Created demo recipe "${recipe.name}" and RM costing plan "${plan.name}" (${plan.id}).`);
}

// Warehouse-level Inventory — item catalog, a handful of Received/Issued
// log entries (day store and production both), plus a couple of Dispatch
// transfers against the same demo customers seedCustomersAndOrders creates.
// See the Prisma schema comment above InventoryItem for the "Inventory
// tool.xlsx" this reconstructs.
async function seedInventory(storeUserId: string | undefined) {
  if (!storeUserId) {
    console.log("No Store demo user available — skipping demo inventory data.");
    return;
  }
  if ((await prisma.inventoryItem.count()) > 0) {
    console.log("Inventory items already exist — skipping demo inventory data.");
    return;
  }

  const items = await Promise.all([
    prisma.inventoryItem.create({ data: { category: "RM", name: "Whey Protein Isolate", unit: "Kg" } }),
    prisma.inventoryItem.create({ data: { category: "RM", name: "Creatine Monohydrate", unit: "Kg" } }),
    prisma.inventoryItem.create({ data: { category: "PM", name: "1kg HDPE Jar", unit: "Count" } }),
    prisma.inventoryItem.create({ data: { category: "PM", name: "Aluminium Foil Liner", unit: "Count" } }),
  ]);
  const [wheyIsolate, creatine, jar, foilLiner] = items;

  await prisma.inventoryTransaction.createMany({
    data: [
      { itemId: wheyIsolate!.id, type: "RECEIVED", date: new Date("2026-08-05"), unit: "Kg", quantity: 500, vendorName: "Sunrise Ingredients Pvt. Ltd.", createdById: storeUserId },
      { itemId: creatine!.id, type: "RECEIVED", date: new Date("2026-08-06"), unit: "Kg", quantity: 200, vendorName: "PureCreatine Traders", createdById: storeUserId },
      { itemId: jar!.id, type: "RECEIVED", date: new Date("2026-08-07"), unit: "Count", quantity: 2000, size: "1kg HDPE", vendorName: "PolyPack Industries", createdById: storeUserId },
      { itemId: foilLiner!.id, type: "RECEIVED", date: new Date("2026-08-07"), unit: "Count", quantity: 3000, vendorName: "PolyPack Industries", createdById: storeUserId },
      { itemId: wheyIsolate!.id, type: "ISSUED_DAY_STORE", date: new Date("2026-08-10"), unit: "Kg", quantity: 120, createdById: storeUserId },
      { itemId: jar!.id, type: "ISSUED_DAY_STORE", date: new Date("2026-08-11"), unit: "Count", quantity: 500, createdById: storeUserId },
      { itemId: wheyIsolate!.id, type: "ISSUED_PRODUCTION", date: new Date("2026-08-12"), unit: "Kg", quantity: 80, createdById: storeUserId },
      { itemId: creatine!.id, type: "ISSUED_PRODUCTION", date: new Date("2026-08-13"), unit: "Kg", quantity: 40, createdById: storeUserId },
    ],
  });
  console.log(`Created ${items.length} demo inventory items with 8 Received/Issued log entries.`);

  const acme = await prisma.customer.findFirst({ where: { companyName: "Acme Wellness Retail Pvt. Ltd." } });
  const nova = await prisma.customer.findFirst({ where: { companyName: "Nova Nutraceuticals LLP" } });
  if (!acme || !nova) {
    console.log("Demo customers not found — skipping demo dispatch transfers.");
    return;
  }

  await prisma.dispatchTransfer.createMany({
    data: [
      { type: "FG", date: new Date("2026-08-15"), customerId: acme.id, productName: "Whey Gold 1kg", quantity: 400, createdById: storeUserId },
      { type: "BILL", date: new Date("2026-08-16"), customerId: acme.id, productName: "Whey Gold 1kg", quantity: 400, createdById: storeUserId },
      { type: "FG", date: new Date("2026-08-17"), customerId: nova.id, productName: "BCAA 2:1:1 300g", quantity: 300, createdById: storeUserId },
    ],
  });
  console.log("Created 3 demo dispatch transfers (2 FG, 1 Bill) against Acme/Nova.");
}

// The batch-pipeline-v2 feature set in one demo PO: plannedQty, the
// Dispensing 3-way split (Production/Sample/Waste), the QC Sample Store's
// confirm→consume lifecycle (one resolved, one still pending — so both
// the "Awaiting confirmation" and "on hand" panels have something to
// show), the Sample QC Approval hard gate, the QA Gate Mfg
// Approved/Rejected/Wastage split, and the Recycle Store that Wastage
// routes to. Three batches, each demonstrating a different point in that
// flow rather than one batch racing to the end.
async function seedBatchPipelineV2Demo(userIds: Partial<Record<RoleName, string>>) {
  const v2Po = "PO-2026-0210";
  if (await prisma.purchaseOrder.findFirst({ where: { poNumber: v2Po } })) {
    console.log(`PO "${v2Po}" already exists — skipping batch-pipeline-v2 demo data.`);
    return;
  }
  const { BD: bdId, PPIC: ppicId, STORE: storeId, QA_QC: qaId, PRODUCTION: prodId, RND: rndId } = userIds;
  if (!bdId || !ppicId || !storeId || !qaId) {
    console.log("Missing one of BD/PPIC/STORE/QA_QC demo users — skipping batch-pipeline-v2 demo data.");
    return;
  }

  const customer = await prisma.customer.findFirst({ where: { companyName: "Nova Nutraceuticals LLP" } });
  if (!customer) {
    console.log("Demo customer not found — skipping batch-pipeline-v2 demo data.");
    return;
  }

  // Self-contained on purpose — this function doesn't assume
  // seedInventory above actually ran (it skips outright the moment any
  // real InventoryItem exists, which a database already carrying real
  // imported stock data always will), so it finds-or-creates its own item
  // rather than depending on that function's output.
  const wheyIsolate = await prisma.inventoryItem.upsert({
    where: { category_name: { category: "RM", name: "Whey Protein Isolate" } },
    create: { category: "RM", name: "Whey Protein Isolate", unit: "Kg" },
    update: {},
  });
  // receiptStatus/acceptedBy/acceptedAt are normally stamped by the
  // Material Received route (isOpeningStock -> ACCEPTED immediately) —
  // written directly here since this bypasses that route, so it needs
  // setting by hand or the stock math below (which only counts ACCEPTED
  // RECEIVED rows) would read this delivery as still-pending QC.
  await prisma.inventoryTransaction.create({
    data: {
      itemId: wheyIsolate.id,
      type: "RECEIVED",
      date: new Date("2026-08-20"),
      unit: "Kg",
      quantity: 400,
      vendorName: "Sunrise Ingredients Pvt. Ltd.",
      grnNo: "GRN-2026-0455",
      receiptStatus: "ACCEPTED",
      acceptedById: storeId,
      acceptedAt: new Date("2026-08-20"),
      createdById: storeId,
    },
  });

  const plant = await prisma.plant.upsert({ where: { name: "Plant 41" }, create: { name: "Plant 41", createdById: ppicId }, update: {} });
  const dayStore = await prisma.dayStore.upsert({ where: { name: "Day Store 59" }, create: { name: "Day Store 59", createdById: storeId }, update: {} });

  // Real inflow to Plant 41 — a Material Request, approved and issued the
  // normal way, so its own real-time balance (not just the Warehouse
  // total) actually has something for the three batches below to draw on.
  const plantRequest = await prisma.inventoryRequest.create({
    data: { itemId: wheyIsolate.id, category: "RM", requestedQty: 300, purpose: "ISSUED_PRODUCTION", plantId: plant.id, requestedById: ppicId, status: "ISSUED", reviewedById: storeId, reviewedAt: new Date("2026-08-21") },
  });
  // deliveredAt is normally stamped at creation for a non-transit-tracked
  // leg (the route's default) — set here for the same reason
  // receiptStatus is above: getOnHandByPlantAndItem only counts an
  // ISSUED_PRODUCTION row once deliveredAt is set, transit-tracked or not.
  await prisma.inventoryTransaction.create({
    data: {
      itemId: wheyIsolate.id,
      type: "ISSUED_PRODUCTION",
      date: new Date("2026-08-21"),
      unit: "Kg",
      quantity: 300,
      plantId: plant.id,
      fulfillsRequestId: plantRequest.id,
      deliveredAt: new Date("2026-08-21"),
      createdById: storeId,
    },
  });
  // A second Material Request left PENDING, and the Day Store leg's own
  // still-open ask — so the Material Requests tab has more than
  // already-closed rows to look at.
  await prisma.inventoryRequest.create({ data: { itemId: wheyIsolate.id, category: "RM", requestedQty: 60, purpose: "ISSUED_DAY_STORE", requestedById: ppicId } });

  const po = await prisma.purchaseOrder.create({
    data: {
      customerId: customer.id,
      createdById: bdId,
      poNumber: v2Po,
      orderDate: new Date("2026-08-18"),
      regulatoryBody: "FSSAI",
      regulatoryStatus: "Issued",
      status: "APPROVED",
      reviewedById: bdId,
      reviewedAt: new Date("2026-08-19"),
      items: {
        create: [
          { productName: "Whey Gold 1kg", dosageForm: "Powders", quantity: 300, unit: "SKU", packSize: "1kg", packType: "Jar" },
          // A genuinely new product — no Recipe/BOM on file for it yet,
          // demonstrated by the Recipe Request below rather than a batch.
          { productName: "NextGen Longevity Complex 60caps", dosageForm: "Capsules", quantity: 400, unit: "SKU", packSize: "60caps", packType: "Bottle", productType: "NEW" },
        ],
      },
    },
    include: { items: true },
  });
  const wheyItem = po.items.find((i) => i.productName === "Whey Gold 1kg")!;
  const newProductItem = po.items.find((i) => i.productType === "NEW")!;

  await prisma.recipeRequest.create({
    data: { purchaseOrderItemId: newProductItem.id, productName: newProductItem.productName, customerName: customer.companyName, bomNeeded: true, rmNeeded: true, requestedById: ppicId },
  });

  // PO Readiness — one item comfortably covered by live stock, one short,
  // so the readiness view has a real contrast to show instead of an
  // all-green or all-red list.
  await prisma.poMaterialRequirement.create({ data: { purchaseOrderId: po.id, itemId: wheyIsolate.id, category: "RM", requiredQty: 250, unit: "Kg", createdById: ppicId } });
  const jar = await prisma.inventoryItem.upsert({ where: { category_name: { category: "PM", name: "1kg HDPE Jar" } }, create: { category: "PM", name: "1kg HDPE Jar", unit: "Count" }, update: {} });
  await prisma.poMaterialRequirement.create({ data: { purchaseOrderId: po.id, itemId: jar.id, category: "PM", requiredQty: 5000, unit: "Count", createdById: ppicId } });

  // Pre-Inventory — PPIC's own standing requirement, independent of any
  // one PO.
  await prisma.preInventoryRequirement.create({ data: { date: new Date("2026-08-19"), category: "RM", itemId: wheyIsolate.id, unit: "Kg", requiredQty: 500, note: "Q3 running requirement", requestedById: ppicId } });

  /** Batch A — walked all the way to Packaging: the full round trip through Dispensing's 3-way split, a resolved QC Sample, and QA Gate Mfg's Approved/Rejected/Wastage split. */
  const batchA = await prisma.batch.create({
    data: {
      purchaseOrderItemId: wheyItem.id,
      batchNo: "GB-WHEY-0210-A",
      plannedQty: 100,
      plantId: plant.id,
      currentStageId: "PACKAGING",
      grnNo: "GRN-2026-0455",
      grnDate: new Date("2026-08-20"),
      prodIndentSlipSign: "PPIC-IND-0210A",
      productionPlanDate: new Date("2026-08-21"),
      unit: "41",
      dispatchPlanDate: new Date("2026-09-05"),
      rmDispensingDate: new Date("2026-08-22"),
      rmDispensingRemarks: "70 Kg to production, 5 Kg to QC sample, 5 Kg spilled at weighing.",
      sampleQcStatus: "Approved",
      sampleQcRemarks: "Matched spec on assay — cleared for production.",
      manufacturingStartDate: new Date("2026-08-23"),
      manufacturingEndDate: new Date("2026-08-24"),
      manufacturingStatus: "Completed",
      inputQty: 70,
      outputQty: 68.5,
      mfgQaStatus: "Approved",
      mfgQcStatus: "Approved",
      mfgRemarks: "Bulk cleared — released to packing.",
      mfgApprovedQty: 65,
      mfgRejectedQty: 1.5,
      mfgWastageQty: 2,
      packagingStartDate: new Date("2026-08-25"),
      packagingStatus: "In Progress",
    },
  });
  await prisma.batchMaterialConsumption.createMany({
    data: [
      { batchId: batchA.id, itemId: wheyIsolate.id, quantity: 70, unit: "Kg", purpose: "PRODUCTION", createdById: storeId },
      { batchId: batchA.id, itemId: wheyIsolate.id, quantity: 5, unit: "Kg", purpose: "SAMPLE", createdById: storeId },
      { batchId: batchA.id, itemId: wheyIsolate.id, quantity: 5, unit: "Kg", purpose: "WASTE", createdById: storeId },
    ],
  });
  await prisma.inventoryTransaction.create({
    data: { itemId: wheyIsolate.id, type: "ISSUED_RECYCLE", date: new Date("2026-08-22"), unit: "Kg", quantity: 5, plantId: plant.id, batchId: batchA.id, remark: "Dispensing spill — routed to Recycle Store", createdById: storeId },
  });
  const sampleTransferA = await prisma.qcSampleTransfer.create({
    data: { batchId: batchA.id, direction: "TO_QC", itemId: wheyIsolate.id, quantity: 5, unit: "Kg", sentById: storeId, sentAt: new Date("2026-08-22"), confirmedById: qaId, confirmedAt: new Date("2026-08-22") },
  });
  await prisma.qcSampleTransaction.create({ data: { batchId: batchA.id, itemId: wheyIsolate.id, type: "INBOUND", quantity: 5, unit: "Kg", transferId: sampleTransferA.id, createdById: qaId, createdAt: new Date("2026-08-22") } });
  await prisma.qcSampleTransaction.create({
    data: { batchId: batchA.id, itemId: wheyIsolate.id, type: "CONSUMED", quantity: 5, unit: "Kg", consumeReason: "TESTING", note: "Assay + microbial screen, both within spec.", createdById: qaId, createdAt: new Date("2026-08-22") },
  });
  await prisma.batchRecycleLog.create({ data: { batchId: batchA.id, stageId: "QA_GATE_MFG", quantity: 2, unit: "SKU", createdById: qaId } });
  if (ppicId) {
    await prisma.batchStageEvent.createMany({
      data: [
        { batchId: batchA.id, fromStageId: "MATERIAL_RECEIVED", toStageId: "INDENT_ISSUE", action: "FORWARD", actorId: storeId, createdAt: new Date("2026-08-20") },
        { batchId: batchA.id, fromStageId: "DISPENSING", toStageId: "SAMPLE_QC_APPROVAL", action: "FORWARD", actorId: storeId, createdAt: new Date("2026-08-22") },
        { batchId: batchA.id, fromStageId: "SAMPLE_QC_APPROVAL", toStageId: "PRODUCTION_EXECUTION", action: "FORWARD", actorId: qaId, createdAt: new Date("2026-08-22") },
        { batchId: batchA.id, fromStageId: "QA_GATE_MFG", toStageId: "PACKAGING", action: "FORWARD", note: "Bulk cleared — released to packing.", actorId: qaId, createdAt: new Date("2026-08-24") },
      ],
    });
  }

  /** Batch B — parked with a Hold at QA Gate Mfg, so the QC Dashboard's held-batches queue has something real to show. */
  const batchB = await prisma.batch.create({
    data: {
      purchaseOrderItemId: wheyItem.id,
      batchNo: "GB-WHEY-0210-B",
      plannedQty: 100,
      plantId: plant.id,
      currentStageId: "QA_GATE_MFG",
      unit: "41",
      rmDispensingDate: new Date("2026-08-23"),
      sampleQcStatus: "Approved",
      manufacturingStartDate: new Date("2026-08-24"),
      manufacturingEndDate: new Date("2026-08-25"),
      manufacturingStatus: "Completed",
      inputQty: 92,
      outputQty: 90,
      mfgQaStatus: "Hold",
      mfgQcStatus: "Hold",
      mfgRemarks: "Checking a deviation report on Line 2 before releasing.",
    },
  });
  await prisma.batchMaterialConsumption.createMany({
    data: [
      { batchId: batchB.id, itemId: wheyIsolate.id, quantity: 92, unit: "Kg", purpose: "PRODUCTION", createdById: storeId },
      { batchId: batchB.id, itemId: wheyIsolate.id, quantity: 3, unit: "Kg", purpose: "WASTE", createdById: storeId },
    ],
  });
  await prisma.inventoryTransaction.create({
    data: { itemId: wheyIsolate.id, type: "ISSUED_RECYCLE", date: new Date("2026-08-23"), unit: "Kg", quantity: 3, plantId: plant.id, batchId: batchB.id, remark: "Dispensing spill — routed to Recycle Store", createdById: storeId },
  });

  /** Batch C — sitting at Sample QC Approval with its sample still unconfirmed, so the "Awaiting confirmation" queue (QC Dashboard, Transit tab, QC Sample panel) has a live example. */
  const batchC = await prisma.batch.create({
    data: { purchaseOrderItemId: wheyItem.id, batchNo: "GB-WHEY-0210-C", plannedQty: 100, plantId: plant.id, currentStageId: "SAMPLE_QC_APPROVAL", unit: "41", rmDispensingDate: new Date("2026-08-25") },
  });
  await prisma.batchMaterialConsumption.createMany({
    data: [
      { batchId: batchC.id, itemId: wheyIsolate.id, quantity: 70, unit: "Kg", purpose: "PRODUCTION", createdById: storeId },
      { batchId: batchC.id, itemId: wheyIsolate.id, quantity: 8, unit: "Kg", purpose: "SAMPLE", createdById: storeId },
    ],
  });
  await prisma.qcSampleTransfer.create({ data: { batchId: batchC.id, direction: "TO_QC", itemId: wheyIsolate.id, quantity: 8, unit: "Kg", sentById: storeId, sentAt: new Date("2026-08-25") } });

  console.log(`Created batch-pipeline-v2 demo: PO "${v2Po}" (Plant 41, Day Store 59), 3 batches — one through Packaging with a resolved QC sample + QA-gate wastage, one Held at QA Gate Mfg, one awaiting Sample QC confirmation.`);

  // R&D Store — one small, fully-resolved sample lifecycle so that page
  // isn't empty either.
  if (rndId) {
    const rndTransfer = await prisma.rndTransfer.create({
      data: { direction: "TO_RND", itemId: wheyIsolate.id, quantity: 5, unit: "Kg", note: "For the NextGen Longevity Complex formulation trial.", sentById: storeId, sentAt: new Date("2026-08-19"), confirmedById: rndId, confirmedAt: new Date("2026-08-19") },
    });
    // The sending side's own Warehouse-stock effect — created by
    // rnd-store.routes.ts alongside the RndTransfer row for a real
    // request, so it's created by hand here too, not left implicit.
    await prisma.inventoryTransaction.create({
      data: { itemId: wheyIsolate.id, type: "ISSUED_RND", date: new Date("2026-08-19"), unit: "Kg", quantity: 5, remark: "Sent to R&D Store — for the NextGen Longevity Complex formulation trial.", createdById: storeId },
    });
    await prisma.rndStoreTransaction.create({ data: { itemId: wheyIsolate.id, type: "INBOUND", quantity: 5, unit: "Kg", transferId: rndTransfer.id, createdById: rndId, createdAt: new Date("2026-08-19") } });
    await prisma.rndStoreTransaction.create({
      data: { itemId: wheyIsolate.id, type: "CONSUMED", quantity: 5, unit: "Kg", consumeReason: "FORMULATION_TRIAL", date: new Date("2026-08-20"), projectName: "NextGen Longevity Complex", formulationRef: "FR-0210", createdById: rndId },
    });
    console.log("Created R&D Store demo: one Warehouse → R&D sample, confirmed and used in a formulation trial.");
  }
  if (prodId) console.log(`Production demo user available (${prodId}) — Batch B/C are ready for a PRODUCTION login to act on next.`);
}

async function main() {
  await seedRoles();
  const adminId = await seedAdmin();
  await seedWarehouses(adminId);
  const userIds = await seedDemoUsers();
  await seedCustomersAndOrders(userIds.BD ?? null, userIds.PPIC);
  await seedPackagingBom(userIds.PPIC);
  await seedRmCosting(userIds.PPIC);
  await seedInventory(userIds.STORE);
  await seedBatchPipelineV2Demo(userIds);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
