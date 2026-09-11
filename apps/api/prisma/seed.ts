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
  const existingMidOrder = await prisma.purchaseOrder.findFirst({ where: { poNumber: midPo }, include: { items: true } });
  // Re-run safety: the PO+item creation and the pre-production pipeline
  // below used to be guarded by one "does the PO exist" check, but a run
  // that creates the PO and then dies partway through the pipeline (e.g.
  // a since-fixed bug) would otherwise be stuck permanently skipping this
  // PO on every future run, with no pipeline ever getting attached to it.
  // So: skip only once this PO's item actually has a PreProduction.
  if (existingMidOrder?.items[0] && (await prisma.preProduction.findUnique({ where: { purchaseOrderItemId: existingMidOrder.items[0].id } }))) {
    console.log(`PO "${midPo}" already exists with its pre-production pipeline — skipping.`);
    return;
  }

  const midOrder =
    existingMidOrder ??
    (await prisma.purchaseOrder.create({
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
          create: [{ productName: "BCAA 2:1:1 300g", dosageForm: "Powders", quantity: 1500, unit: "SKU", packSize: "300g", packType: "Jar" }],
        },
      },
      include: { items: true },
    }));
  const item = midOrder.items[0]!;

  // One pre-production run carried through Sample QC Approval, with one
  // completed production batch that pushed combinedQty up to plannedQty —
  // so its CombinedLot exists and sits at Packaging, approved with a small
  // reject/wastage split (routed to Recycle), plus a bit of representative
  // history on both the pre-production and combined-lot timelines.
  const pp1 = await prisma.preProduction.create({
    data: {
      purchaseOrderItemId: item.id,
      plannedQty: item.quantity,
      combinedQty: item.quantity,
      currentStageId: "SAMPLE_QC_APPROVAL",
      prodIndentSlipSign: "PPIC-IND-0098",
      productionPlanDate: new Date("2026-07-28"),
      unit: "41",
      dispatchPlanDate: new Date("2026-08-18"),
      rmDispensingDate: new Date("2026-07-31"),
      pmIssuedDate: new Date("2026-07-31"),
      lineClearanceStatus: "Approved",
      sampleQcStatus: "Approved",
      sampleQcRemarks: "Matched spec — cleared for production.",
    },
  });

  if (ppicUserId) {
    await prisma.productionBatch.create({
      data: {
        preProductionId: pp1.id,
        batchNo: "GB-BCAA-0098",
        plannedQty: item.quantity,
        status: "COMPLETED",
        manufacturingStartDate: new Date("2026-08-01"),
        manufacturingStatus: "Completed",
        manufacturingEndDate: new Date("2026-08-03"),
        inputQty: item.quantity + 20,
        outputQty: item.quantity,
        createdById: ppicUserId,
        completedById: ppicUserId,
        completedAt: new Date("2026-08-03"),
      },
    });

    const cl1 = await prisma.combinedLot.create({
      data: {
        preProductionId: pp1.id,
        currentStageId: "PACKAGING",
        ipqcStatus: "Approved",
        mfgQaStatus: "Approved",
        mfgQcStatus: "Approved",
        mfgRemarks: "Bulk approved — transferred to packing area.",
        mfgApprovedQty: item.quantity - 15,
        mfgRejectedQty: 5,
        mfgWastageQty: 10,
        packagingStartDate: new Date("2026-08-05"),
        packagingStatus: "In Progress",
      },
    });
    await prisma.batchRecycleLog.create({
      data: { combinedLotId: cl1.id, stageId: "QA_GATE_MFG", quantity: 10, unit: "SKU", createdById: ppicUserId },
    });

    await prisma.preProductionStageEvent.createMany({
      data: [
        { preProductionId: pp1.id, fromStageId: "MATERIAL_RECEIVED", toStageId: "INDENT_ISSUE", action: "FORWARD", actorId: ppicUserId, createdAt: new Date("2026-07-22") },
        { preProductionId: pp1.id, fromStageId: "DISPENSING", toStageId: "SAMPLE_QC_APPROVAL", action: "FORWARD", actorId: ppicUserId, createdAt: new Date("2026-08-01") },
      ],
    });
    await prisma.combinedLotStageEvent.createMany({
      data: [
        {
          combinedLotId: cl1.id,
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

  console.log(`Created demo PO "${midPo}" (${midOrder.id}) — 1 line item, 1 pre-production run through Sample QC Approval with a completed production batch combined into a CombinedLot at Packaging.`);
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

  /** Pre-production run — the full Dispensing 3-way split (Production/
   * Sample/Waste) and a resolved QC Sample lifecycle, Sample QC Approval
   * cleared — then TWO completed production batches whose combined
   * output crossed plannedQty, so a CombinedLot exists and is currently
   * Held at QA Gate Mfg (so the QC Dashboard's held-lot queue has
   * something real to show). */
  const ppWhey = await prisma.preProduction.create({
    data: {
      purchaseOrderItemId: wheyItem.id,
      plannedQty: 100,
      combinedQty: 100.5,
      plantId: plant.id,
      currentStageId: "SAMPLE_QC_APPROVAL",
      grnNo: "GRN-2026-0455",
      grnDate: new Date("2026-08-20"),
      prodIndentSlipSign: "PPIC-IND-0210A",
      productionPlanDate: new Date("2026-08-21"),
      unit: "41",
      dispatchPlanDate: new Date("2026-09-05"),
      lineClearanceStatus: "Approved",
      rmDispensingDate: new Date("2026-08-22"),
      rmDispensingRemarks: "70 Kg to production, 5 Kg to QC sample, 5 Kg spilled at weighing.",
      sampleQcStatus: "Approved",
      sampleQcRemarks: "Matched spec on assay — cleared for production.",
    },
  });
  await prisma.batchMaterialConsumption.createMany({
    data: [
      { preProductionId: ppWhey.id, itemId: wheyIsolate.id, quantity: 70, unit: "Kg", purpose: "PRODUCTION", createdById: storeId },
      { preProductionId: ppWhey.id, itemId: wheyIsolate.id, quantity: 5, unit: "Kg", purpose: "SAMPLE", createdById: storeId },
      { preProductionId: ppWhey.id, itemId: wheyIsolate.id, quantity: 5, unit: "Kg", purpose: "WASTE", createdById: storeId },
    ],
  });
  await prisma.inventoryTransaction.create({
    data: {
      itemId: wheyIsolate.id,
      type: "ISSUED_RECYCLE",
      date: new Date("2026-08-22"),
      unit: "Kg",
      quantity: 5,
      plantId: plant.id,
      preProductionId: ppWhey.id,
      remark: "Dispensing spill — routed to Recycle Store",
      createdById: storeId,
    },
  });
  const sampleTransferWhey = await prisma.qcSampleTransfer.create({
    data: { preProductionId: ppWhey.id, direction: "TO_QC", itemId: wheyIsolate.id, quantity: 5, unit: "Kg", sentById: storeId, sentAt: new Date("2026-08-22"), confirmedById: qaId, confirmedAt: new Date("2026-08-22") },
  });
  await prisma.qcSampleTransaction.create({
    data: { preProductionId: ppWhey.id, itemId: wheyIsolate.id, type: "INBOUND", quantity: 5, unit: "Kg", transferId: sampleTransferWhey.id, createdById: qaId, createdAt: new Date("2026-08-22") },
  });
  await prisma.qcSampleTransaction.create({
    data: { preProductionId: ppWhey.id, itemId: wheyIsolate.id, type: "CONSUMED", quantity: 5, unit: "Kg", consumeReason: "TESTING", note: "Assay + microbial screen, both within spec.", createdById: qaId, createdAt: new Date("2026-08-22") },
  });
  if (ppicId) {
    await prisma.preProductionStageEvent.createMany({
      data: [
        { preProductionId: ppWhey.id, fromStageId: "MATERIAL_RECEIVED", toStageId: "INDENT_ISSUE", action: "FORWARD", actorId: storeId, createdAt: new Date("2026-08-20") },
        { preProductionId: ppWhey.id, fromStageId: "DISPENSING", toStageId: "SAMPLE_QC_APPROVAL", action: "FORWARD", actorId: storeId, createdAt: new Date("2026-08-22") },
      ],
    });
  }

  await prisma.productionBatch.create({
    data: {
      preProductionId: ppWhey.id,
      batchNo: "GB-WHEY-0210-A",
      plannedQty: 70,
      status: "COMPLETED",
      manufacturingStartDate: new Date("2026-08-23"),
      manufacturingEndDate: new Date("2026-08-24"),
      manufacturingStatus: "Completed",
      inputQty: 70,
      outputQty: 68.5,
      createdById: storeId,
      completedById: qaId,
      completedAt: new Date("2026-08-24"),
    },
  });
  await prisma.productionBatch.create({
    data: {
      preProductionId: ppWhey.id,
      batchNo: "GB-WHEY-0210-A2",
      plannedQty: 30,
      status: "COMPLETED",
      manufacturingStartDate: new Date("2026-08-24"),
      manufacturingEndDate: new Date("2026-08-25"),
      manufacturingStatus: "Completed",
      inputQty: 33,
      outputQty: 32,
      createdById: storeId,
      completedById: qaId,
      completedAt: new Date("2026-08-25"),
    },
  });

  const clWhey = await prisma.combinedLot.create({
    data: {
      preProductionId: ppWhey.id,
      currentStageId: "QA_GATE_MFG",
      ipqcStatus: "Approved",
      mfgQaStatus: "Hold",
      mfgQcStatus: "Hold",
      mfgRemarks: "Checking a deviation report on Line 2 before releasing.",
    },
  });
  await prisma.combinedLotStageEvent.createMany({
    data: [{ combinedLotId: clWhey.id, fromStageId: "IPQC", toStageId: "QA_GATE_MFG", action: "FORWARD", actorId: qaId, createdAt: new Date("2026-08-25") }],
  });

  /** A second, smaller demo PO — a pre-production run still sitting at
   * Sample QC Approval with its sample sent to QC but not yet confirmed,
   * so the "Awaiting confirmation" queue (QC Dashboard, Transit tab, QC
   * Sample panel) has a live example, and no production batch exists yet
   * since the Sample QC Approval hard gate hasn't cleared. */
  const v2PoB = "PO-2026-0225";
  if (await prisma.purchaseOrder.findFirst({ where: { poNumber: v2PoB } })) {
    console.log(`PO "${v2PoB}" already exists — skipping.`);
  } else {
    const poB = await prisma.purchaseOrder.create({
      data: {
        customerId: customer.id,
        createdById: bdId,
        poNumber: v2PoB,
        orderDate: new Date("2026-08-24"),
        regulatoryBody: "FSSAI",
        regulatoryStatus: "Issued",
        status: "APPROVED",
        reviewedById: bdId,
        reviewedAt: new Date("2026-08-25"),
        items: { create: [{ productName: "Creatine Monohydrate 500g", dosageForm: "Powders", quantity: 200, unit: "SKU", packSize: "500g", packType: "Jar" }] },
      },
      include: { items: true },
    });
    const creatineItem = poB.items[0]!;
    const ppCreatine = await prisma.preProduction.create({
      data: {
        purchaseOrderItemId: creatineItem.id,
        plannedQty: creatineItem.quantity,
        plantId: plant.id,
        currentStageId: "SAMPLE_QC_APPROVAL",
        unit: "41",
        lineClearanceStatus: "Approved",
        rmDispensingDate: new Date("2026-08-25"),
      },
    });
    await prisma.qcSampleTransfer.create({
      data: { preProductionId: ppCreatine.id, direction: "TO_QC", itemId: wheyIsolate.id, quantity: 8, unit: "Kg", sentById: storeId, sentAt: new Date("2026-08-25") },
    });
    console.log(`Created PO "${v2PoB}" (${poB.id}) — 1 pre-production run at Sample QC Approval, sample sent but not yet confirmed by QC.`);
  }

  console.log(
    `Created batch-pipeline-v2 demo: PO "${v2Po}" (Plant 41, Day Store 59) — 1 pre-production run through Sample QC Approval with 2 completed production batches combined into a CombinedLot Held at QA Gate Mfg.`,
  );

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
  if (prodId) console.log(`Production demo user available (${prodId}) — the CombinedLot Held at QA Gate Mfg is ready for a PRODUCTION login to act on next.`);
}

/** Purchase & Accounts — pricing on a couple of catalog items (Purchase/
 * Accounts-only fields, invisible to every other role — see
 * inventory.routes.ts) plus a debit note against a real vendor delivery,
 * so those two departments have something of their own to look at
 * instead of just downstream visibility into the production pipeline. */
async function seedPurchaseAccountsDemo(userIds: Partial<Record<RoleName, string>>) {
  const purchaseId = userIds.PURCHASE;
  if (!purchaseId) {
    console.log("No Purchase demo user available — skipping demo pricing/debit note data.");
    return;
  }

  const wheyIsolate = await prisma.inventoryItem.findUnique({ where: { category_name: { category: "RM", name: "Whey Protein Isolate" } } });
  if (wheyIsolate && wheyIsolate.costPrice === null) {
    await prisma.inventoryItem.update({ where: { id: wheyIsolate.id }, data: { costPrice: 620, purchasePrice: 640, mrp: 950, salesPrice: 880 } });
  }
  const creatine = await prisma.inventoryItem.findUnique({ where: { category_name: { category: "RM", name: "Creatine Monohydrate" } } });
  if (creatine && creatine.costPrice === null) {
    await prisma.inventoryItem.update({ where: { id: creatine.id }, data: { costPrice: 810, purchasePrice: 830, mrp: 1200, salesPrice: 1100 } });
  }
  console.log("Set demo Cost/Purchase/MRP/Sales pricing on 2 catalog items for Purchase/Accounts.");

  if (wheyIsolate) {
    const receipt = await prisma.inventoryTransaction.findFirst({ where: { itemId: wheyIsolate.id, type: "RECEIVED" }, orderBy: { date: "asc" } });
    if (receipt && (await prisma.debitNote.count({ where: { transactionId: receipt.id } })) === 0) {
      await prisma.debitNote.create({
        data: {
          transactionId: receipt.id,
          debitNoteNo: "DN-2026-0031",
          date: new Date("2026-08-06"),
          vendorName: receipt.vendorName,
          itemId: wheyIsolate.id,
          quantity: 5,
          unit: "Kg",
          amount: 3100,
          reason: "5 Kg short-delivered against the GRN quantity.",
          createdById: purchaseId,
        },
      });
      console.log("Created demo debit note (short-delivery) against the first Whey Protein Isolate receipt.");
    }
  }
}

/** One more pre-production run — walked all the way through IPQC, QA Gate
 * Mfg, Bulk QC, a signed-off COA, Packaging, QA Gate Packaging, Billing &
 * E-Way Bill, and Dispatch Plan, linked to a real FG DispatchTransfer —
 * so Accounts and Dispatch each have one genuinely completed example to
 * look at, instead of only the in-flight runs seeded above. */
async function seedFullPipelineDispatchDemo(userIds: Partial<Record<RoleName, string>>) {
  const { BD: bdId, STORE: storeId, QA_QC: qaId, ACCOUNTS: accountsId, DISPATCH: dispatchId } = userIds;
  if (!bdId || !storeId || !qaId || !accountsId || !dispatchId) {
    console.log("Missing a demo department user — skipping the full-pipeline Dispatch demo.");
    return;
  }

  const v3Po = "PO-2026-0260";
  if (await prisma.purchaseOrder.findFirst({ where: { poNumber: v3Po } })) {
    console.log(`PO "${v3Po}" already exists — skipping the full-pipeline Dispatch demo.`);
    return;
  }

  const customer = await prisma.customer.findFirst({ where: { companyName: "Acme Wellness Retail Pvt. Ltd." } });
  if (!customer) {
    console.log("Demo customer not found — skipping the full-pipeline Dispatch demo.");
    return;
  }

  const po = await prisma.purchaseOrder.create({
    data: {
      customerId: customer.id,
      createdById: bdId,
      poNumber: v3Po,
      orderDate: new Date("2026-08-01"),
      regulatoryBody: "FSSAI",
      regulatoryStatus: "Issued",
      status: "APPROVED",
      reviewedById: bdId,
      reviewedAt: new Date("2026-08-02"),
      items: { create: [{ productName: "Whey Gold 1kg", dosageForm: "Powders", quantity: 400, unit: "SKU", packSize: "1kg", packType: "Jar" }] },
    },
    include: { items: true },
  });
  const item = po.items[0]!;

  const pp = await prisma.preProduction.create({
    data: {
      purchaseOrderItemId: item.id,
      plannedQty: item.quantity,
      combinedQty: item.quantity,
      currentStageId: "SAMPLE_QC_APPROVAL",
      prodIndentSlipSign: "PPIC-IND-0260",
      productionPlanDate: new Date("2026-08-03"),
      unit: "41",
      dispatchPlanDate: new Date("2026-08-20"),
      lineClearanceStatus: "Approved",
      rmDispensingDate: new Date("2026-08-05"),
      sampleQcStatus: "Approved",
    },
  });
  await prisma.productionBatch.create({
    data: {
      preProductionId: pp.id,
      batchNo: "GB-WHEYGOLD-0260",
      plannedQty: item.quantity,
      status: "COMPLETED",
      manufacturingStartDate: new Date("2026-08-06"),
      manufacturingEndDate: new Date("2026-08-07"),
      manufacturingStatus: "Completed",
      inputQty: item.quantity + 15,
      outputQty: item.quantity,
      createdById: storeId,
      completedById: qaId,
      completedAt: new Date("2026-08-07"),
    },
  });

  const dispatchTransfer = await prisma.dispatchTransfer.create({
    data: { type: "FG", date: new Date("2026-08-20"), customerId: customer.id, productName: item.productName, quantity: item.quantity, createdById: dispatchId },
  });

  const cl = await prisma.combinedLot.create({
    data: {
      preProductionId: pp.id,
      currentStageId: "DISPATCH_PLAN",
      ipqcStatus: "Approved",
      mfgQaStatus: "Approved",
      mfgQcStatus: "Approved",
      mfgApprovedQty: item.quantity - 5,
      mfgRejectedQty: 2,
      mfgWastageQty: 3,
      bulkQcStatus: "Approved",
      coaResult: "Complies",
      coaAnalyzedById: qaId,
      coaAnalyzedAt: new Date("2026-08-10"),
      coaReviewedById: qaId,
      coaReviewedAt: new Date("2026-08-11"),
      coaApprovedById: qaId,
      coaApprovedAt: new Date("2026-08-12"),
      packagingStartDate: new Date("2026-08-13"),
      packagingEndDate: new Date("2026-08-14"),
      packagingStatus: "Completed",
      packQaStatus: "Approved",
      packQcStatus: "Approved",
      packApprovedQty: item.quantity - 5,
      invoiceNo: "INV-2026-0451",
      invoiceDate: new Date("2026-08-18"),
      ewayBillNo: "EWB-2026-0451",
      ewayBillDate: new Date("2026-08-18"),
      billingRemarks: "Invoice + E-Way Bill raised for the full dispatch quantity.",
      dispatchDate: new Date("2026-08-20"),
      dispatchedQty: item.quantity - 5,
      shipperQty: 40,
      totalShipperWeight: 410,
      transportType: "By Land",
      remainingQty: 0,
      dispatchTransferId: dispatchTransfer.id,
    },
  });
  await prisma.combinedLotStageEvent.createMany({
    data: [
      { combinedLotId: cl.id, fromStageId: "IPQC", toStageId: "QA_GATE_MFG", action: "FORWARD", actorId: qaId, createdAt: new Date("2026-08-09") },
      { combinedLotId: cl.id, fromStageId: "QA_GATE_MFG", toStageId: "BULK_QC", action: "FORWARD", actorId: qaId, createdAt: new Date("2026-08-10") },
      { combinedLotId: cl.id, fromStageId: "BULK_QC", toStageId: "PACKAGING", action: "FORWARD", actorId: qaId, createdAt: new Date("2026-08-12") },
      { combinedLotId: cl.id, fromStageId: "PACKAGING", toStageId: "QA_GATE_PACKAGING", action: "FORWARD", actorId: qaId, createdAt: new Date("2026-08-14") },
      { combinedLotId: cl.id, fromStageId: "QA_GATE_PACKAGING", toStageId: "BILLING_EWAY_BILL", action: "FORWARD", actorId: accountsId, createdAt: new Date("2026-08-18") },
      { combinedLotId: cl.id, fromStageId: "BILLING_EWAY_BILL", toStageId: "DISPATCH_PLAN", action: "FORWARD", actorId: dispatchId, createdAt: new Date("2026-08-20") },
    ],
  });

  console.log(
    `Created PO "${v3Po}" (${po.id}) — one pre-production run walked all the way through to Dispatch Plan, with billing/e-way bill and a linked FG dispatch transfer, so Accounts and Dispatch have a completed example each.`,
  );
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
  await seedPurchaseAccountsDemo(userIds);
  await seedFullPipelineDispatchDemo(userIds);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
