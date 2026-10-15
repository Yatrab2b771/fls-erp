// Demo data for "Add on Plan" (PPIC's PO-independent material search) —
// real standalone catalog plans already exist ("All Natural Plant
// Protein (Chocolate) 1.00 kg" / "2X-Nutrition Creatine Monohydrate"),
// but their real stock mix is whatever it happens to be. This adds one
// clean Sku + one clean Recipe, each with its own standalone CALCULATED
// plan (no PO attached), against DEMO catalog items with controlled
// stock — a guaranteed, readable Complete/Short mix to demo the feature
// with. Search "DEMO Immunity" to find both.
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function upsertItemWithStock(category, name, unit, stockQty, createdById) {
  const item = await prisma.inventoryItem.upsert({ where: { category_name: { category, name } }, create: { category, name, unit }, update: {} });
  if (stockQty > 0) {
    await prisma.inventoryTransaction.create({
      data: {
        itemId: item.id,
        type: "RECEIVED",
        date: new Date(),
        unit,
        quantity: stockQty,
        vendorName: "Demo Vendor",
        createdById,
        receiptStatus: "ACCEPTED",
        acceptedById: createdById,
        acceptedAt: new Date(),
      },
    });
  }
  return item;
}

async function main() {
  const admin = await prisma.user.findUnique({ where: { email: "admin@fls.local" } });
  if (!admin) throw new Error("admin@fls.local not found — is the dev DB seeded?");

  // --- Packaging (PM) side — a standalone Sku + a standalone, already-
  // calculated BomPlan for it (no PO attached).
  let customer = await prisma.customer.findFirst({ where: { companyName: "DEMO Nutraceuticals" } });
  if (!customer) customer = await prisma.customer.create({ data: { companyName: "DEMO Nutraceuticals", createdById: admin.id } });

  const jar = await upsertItemWithStock("PM", "DEMO Immunity Jar 60ct", "Nos", 500, admin.id);
  const box = await upsertItemWithStock("PM", "DEMO Immunity Corrugated Box", "Nos", 20, admin.id);
  const sticker = await upsertItemWithStock("PM", "DEMO Immunity Auth Sticker", "Nos", 0, admin.id);

  const sku = await prisma.sku.upsert({
    where: { id: "00000000-0000-4000-8000-000000000001" },
    create: {
      id: "00000000-0000-4000-8000-000000000001",
      customerId: customer.id,
      productName: "DEMO Immunity Booster Capsules 60 Caps",
      jar: "60cc White Jar",
      corrugatedBoxMm: "400X300X250",
      packagingSizeNos: "48",
      authenticationSticker: "Standard",
    },
    update: {},
  });

  const targetYield = 500;
  const bomSourceKey = `${customer.companyName} (${sku.productName})`;
  const bomPlan = await prisma.bomPlan.create({
    data: {
      name: `${sku.productName} — Add on Plan Demo`,
      status: "CALCULATED",
      calculatedAt: new Date(),
      createdById: admin.id,
      resultSnapshot: {
        totalYield: targetYield,
        brands: [customer.companyName],
        lines: [
          { category: "1-Primary", component: jar.name, spec: "60cc White Jar", baseQty: targetYield, wastageRate: 0.02, bufferQty: 10, totalQty: targetYield, sources: { [bomSourceKey]: targetYield } },
          {
            category: "3-Tertiary",
            component: box.name,
            spec: "Pack of 48",
            baseQty: Math.ceil(targetYield / 48),
            wastageRate: 0,
            bufferQty: 0,
            totalQty: Math.ceil(targetYield / 48),
            sources: { [bomSourceKey]: Math.ceil(targetYield / 48) },
          },
          { category: "2-Secondary", component: sticker.name, spec: "Standard Sticker", baseQty: targetYield, wastageRate: 0.02, bufferQty: 10, totalQty: targetYield, sources: { [bomSourceKey]: targetYield } },
        ],
      },
    },
  });
  await prisma.bomPlanItem.create({ data: { planId: bomPlan.id, skuId: sku.id, targetYield, addedById: admin.id } });
  console.log(`PM ready: Sku "${sku.productName}" -> BomPlan "${bomPlan.name}" (Jar Complete, Box Short, Sticker Short)`);

  // --- RM Formulation side — a standalone Recipe + a standalone,
  // already-calculated RmPlan for it (no PO attached).
  const zinc = await upsertItemWithStock("RM", "DEMO Zinc Citrate", "Kg", 50, admin.id);
  const vitaminD3 = await upsertItemWithStock("RM", "DEMO Vitamin D3 Powder", "Kg", 2, admin.id);
  const elderberry = await upsertItemWithStock("RM", "DEMO Elderberry Extract", "Kg", 0, admin.id);

  const recipe = await prisma.recipe.upsert({
    where: { name: "DEMO Immunity Booster Formula" },
    create: { name: "DEMO Immunity Booster Formula", totalServing: 30 },
    update: {},
  });

  const batchSizeKg = 100;
  const rmPlan = await prisma.rmPlan.create({
    data: {
      name: `${recipe.name} — Add on Plan Demo`,
      status: "CALCULATED",
      calculatedAt: new Date(),
      createdById: admin.id,
      costingParams: { mfgLossPct: 2, packSizeG: 30, testCost: 500, jarCost: 20, scoopCost: 2, labelCost: 3, convCost: 1, ccbCost: 1, profitPct: 30, gstPct: 18 },
      resultSnapshot: {
        batches: [],
        procurement: [
          { name: zinc.name, brand: "DemoBrand", estCostPerKg: 900, totalKg: 40, sources: { [recipe.name]: 40 } },
          { name: vitaminD3.name, brand: "DemoBrand", estCostPerKg: 5000, totalKg: 5, sources: { [recipe.name]: 5 } },
          { name: elderberry.name, brand: "DemoBrand", estCostPerKg: 2500, totalKg: 15, sources: { [recipe.name]: 15 } },
        ],
      },
    },
  });
  await prisma.rmPlanItem.create({ data: { planId: rmPlan.id, recipeId: recipe.id, batchSizeKg, addedById: admin.id } });
  console.log(`RM ready: Recipe "${recipe.name}" -> RmPlan "${rmPlan.name}" (Zinc Complete, Vitamin D3 Short, Elderberry Short)`);

  console.log('\nDone. Go to "Add on Plan" and search "DEMO Immunity".');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
