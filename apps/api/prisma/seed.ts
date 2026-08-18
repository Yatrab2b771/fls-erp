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
];

async function seedRoles() {
  for (const name of Object.values(RoleName)) {
    await prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  }
  console.log(`Seeded ${Object.values(RoleName).length} roles.`);
}

async function seedAdmin() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@fls.local";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existing) {
    console.log(`Admin ${adminEmail} already exists — skipping.`);
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const admin = await prisma.user.create({ data: { email: adminEmail, passwordHash, fullName: "System Admin" } });
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.ADMIN } });
  await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });

  console.log(`Created bootstrap admin: ${adminEmail} / ${adminPassword}`);
  console.log("Log in and change this password immediately — it is not safe for anything beyond local dev.");
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
        brandName: "AlphaBrand",
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
      brandName: "GammaBrand",
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

/** One brand/SKU and one calculated BOM plan, so Packaging BOM has something real to look at immediately. */
async function seedPackagingBom(ppicUserId: string | undefined) {
  if (!ppicUserId) {
    console.log("No PPIC demo user available — skipping demo packaging BOM catalog/plan.");
    return;
  }
  if ((await prisma.bomPlan.count()) > 0) {
    console.log("BOM plans already exist — skipping demo catalog/plan.");
    return;
  }

  const brand = await prisma.brand.upsert({ where: { name: "AlphaBrand" }, create: { name: "AlphaBrand" }, update: {} });
  const sku = await prisma.sku.upsert({
    where: { brandId_productName: { brandId: brand.id, productName: DEMO_SKU.productName } },
    create: { brandId: brand.id, ...DEMO_SKU },
    update: {},
  });

  const plan = await prisma.bomPlan.create({ data: { name: "Demo Packaging Run", createdById: ppicUserId } });
  await prisma.bomPlanItem.create({ data: { planId: plan.id, skuId: sku.id, targetYield: 1000, addedById: ppicUserId } });

  console.log(`Created demo catalog (AlphaBrand / ${DEMO_SKU.productName}) and BOM plan "${plan.name}" (${plan.id}).`);
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

async function main() {
  await seedRoles();
  await seedAdmin();
  const userIds = await seedDemoUsers();
  await seedCustomersAndOrders(userIds.BD ?? null, userIds.PPIC);
  await seedPackagingBom(userIds.PPIC);
  await seedRmCosting(userIds.PPIC);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
