// Demo data for the new Pending PO Report (per-product RM/PM material
// breakdown) — picks 3 real pending PO products that have no RM/BOM
// plan yet and gives them one each, with resultSnapshot JSON shaped
// exactly like RmMasterResult/BomResult (see rm-costing-engine.ts /
// bom-engine.ts), so the report's Complete/Short comparison has
// something real to show. Demo catalog items are prefixed "DEMO " so
// they're obviously not real stock and easy to clean up later.
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function upsertItemWithStock(category, name, unit, stockQty, createdById) {
  const item = await prisma.inventoryItem.upsert({
    where: { category_name: { category, name } },
    create: { category, name, unit },
    update: {},
  });
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

function rmBatch(recipeName, packSizeG, pricePerPouch, ingredients) {
  return {
    recipeName,
    gmPerServing: 30,
    batchSizeKg: 100,
    servingsPerBatch: 3333,
    proteinPctInBatch: 24,
    costPerKgWithoutPkg: 450,
    totalRmCost: 45000,
    testCost: 500,
    powderCostPlusTesting: 45500,
    mfgLossPct: 2,
    mfgLossAmount: 910,
    powderCostAdjusted: 46410,
    packSizeG,
    costPerPouchPowder: 14,
    jarCost: 20,
    scoopCost: 2,
    labelCost: 3,
    convCost: 1,
    ccbCost: 1,
    packagingTotal: 27,
    cogsPerPouch: 41,
    profitPct: 30,
    profitAmount: 12.3,
    gstPct: 18,
    gstAmount: 9.6,
    pricePerPouch,
    ingredients,
  };
}

function rmIngredient(name, brand, gPerServing, costPerKg) {
  return { name, brand, proteinPct: 80, costPerKg, ratePerGm: costPerKg / 1000, gPerServing, perBatchGrams: gPerServing * 3333, qtyInKg: (gPerServing * 3333) / 1000, amount: (gPerServing * 3333 * costPerKg) / 1000 };
}

async function main() {
  const ppic = await prisma.user.findUnique({ where: { email: "ppic@fls.local" } });
  if (!ppic) throw new Error("ppic@fls.local user not found — is the dev DB seeded?");
  const createdById = ppic.id;

  // Demo catalog + live stock — deliberately mixed: some Complete, some
  // Short, one item (Whey Protein Concentrate) shared across two
  // products to show the "same material, two products" case.
  const whey = await upsertItemWithStock("RM", "DEMO Whey Protein Concentrate", "Kg", 500, createdById);
  const cocoa = await upsertItemWithStock("RM", "DEMO Cocoa Powder", "Kg", 20, createdById);
  const creatine = await upsertItemWithStock("RM", "DEMO Creatine Monohydrate", "Kg", 0, createdById);
  const jar = await upsertItemWithStock("PM", "DEMO Jar 1000ml", "Nos", 200, createdById);
  const box = await upsertItemWithStock("PM", "DEMO Corrugated Box", "Nos", 10, createdById);
  const scoop = await upsertItemWithStock("PM", "DEMO Scoop", "Nos", 0, createdById);
  console.log("Catalog ready:", [whey, cocoa, creatine, jar, box, scoop].map((i) => i.name));

  // Three real pending PO products with no RM/BOM plan yet.
  const pending = await prisma.purchaseOrder.findMany({
    where: { status: { not: "REJECTED" } },
    select: {
      id: true,
      poNumber: true,
      items: { where: { deletedAt: null }, select: { id: true, productName: true, rmPlans: { select: { id: true } }, bomPlans: { select: { id: true } } } },
    },
  });
  const candidates = [];
  for (const po of pending) {
    for (const item of po.items) {
      if (item.rmPlans.length === 0 && item.bomPlans.length === 0) candidates.push({ po, item });
    }
  }
  if (candidates.length < 3) throw new Error(`Only found ${candidates.length} unplanned pending products — need at least 3`);
  const [a, b, c] = candidates;

  // Product A — mixed: one RM Complete, one RM Short; one PM Complete, one PM Short.
  await prisma.rmPlan.create({
    data: {
      name: `${a.item.productName} — RM Plan (Demo)`,
      status: "CALCULATED",
      calculatedAt: new Date(),
      createdById,
      costingParams: { mfgLossPct: 2, packSizeG: 30, testCost: 500, jarCost: 20, scoopCost: 2, labelCost: 3, convCost: 1, ccbCost: 1, profitPct: 30, gstPct: 18 },
      purchaseOrderItemId: a.item.id,
      resultSnapshot: {
        batches: [rmBatch(a.item.productName, 30, 65, [rmIngredient(whey.name, "DemoBrand", 90, 450), rmIngredient(cocoa.name, "DemoBrand", 12, 380)])],
        procurement: [
          { name: whey.name, brand: "DemoBrand", estCostPerKg: 450, totalKg: 400, sources: { [a.item.productName]: 400 } },
          { name: cocoa.name, brand: "DemoBrand", estCostPerKg: 380, totalKg: 50, sources: { [a.item.productName]: 50 } },
        ],
      },
    },
  });
  await prisma.bomPlan.create({
    data: {
      name: `${a.item.productName} — BOM Plan (Demo)`,
      status: "CALCULATED",
      calculatedAt: new Date(),
      createdById,
      purchaseOrderItemId: a.item.id,
      resultSnapshot: {
        totalYield: 200,
        brands: ["DemoBrand"],
        lines: [
          { category: "1-Primary", component: jar.name, spec: "1000ml", baseQty: 200, wastageRate: 0.02, bufferQty: 4, totalQty: 200, sources: { [a.item.productName]: 200 } },
          { category: "3-Tertiary", component: box.name, spec: "Pack of 20", baseQty: 50, wastageRate: 0, bufferQty: 0, totalQty: 50, sources: { [a.item.productName]: 50 } },
        ],
      },
    },
  });
  console.log(`Product A ready: ${a.item.productName} (PO ${a.po.poNumber})`);

  // Product B — RM only (fully short), no BOM Plan at all -> PM column shows "Not Planned Yet".
  await prisma.rmPlan.create({
    data: {
      name: `${b.item.productName} — RM Plan (Demo)`,
      status: "CALCULATED",
      calculatedAt: new Date(),
      createdById,
      costingParams: { mfgLossPct: 2, packSizeG: 30, testCost: 500, jarCost: 20, scoopCost: 2, labelCost: 3, convCost: 1, ccbCost: 1, profitPct: 30, gstPct: 18 },
      purchaseOrderItemId: b.item.id,
      resultSnapshot: {
        batches: [rmBatch(b.item.productName, 30, 55, [rmIngredient(creatine.name, "DemoBrand", 25, 900)])],
        procurement: [{ name: creatine.name, brand: "DemoBrand", estCostPerKg: 900, totalKg: 100, sources: { [b.item.productName]: 100 } }],
      },
    },
  });
  console.log(`Product B ready: ${b.item.productName} (PO ${b.po.poNumber})`);

  // Product C — shares Whey Protein Concentrate with Product A (well
  // covered), PM fully short.
  await prisma.rmPlan.create({
    data: {
      name: `${c.item.productName} — RM Plan (Demo)`,
      status: "CALCULATED",
      calculatedAt: new Date(),
      createdById,
      costingParams: { mfgLossPct: 2, packSizeG: 30, testCost: 500, jarCost: 20, scoopCost: 2, labelCost: 3, convCost: 1, ccbCost: 1, profitPct: 30, gstPct: 18 },
      purchaseOrderItemId: c.item.id,
      resultSnapshot: {
        batches: [rmBatch(c.item.productName, 30, 60, [rmIngredient(whey.name, "DemoBrand", 80, 450)])],
        procurement: [{ name: whey.name, brand: "DemoBrand", estCostPerKg: 450, totalKg: 50, sources: { [c.item.productName]: 50 } }],
      },
    },
  });
  await prisma.bomPlan.create({
    data: {
      name: `${c.item.productName} — BOM Plan (Demo)`,
      status: "CALCULATED",
      calculatedAt: new Date(),
      createdById,
      purchaseOrderItemId: c.item.id,
      resultSnapshot: {
        totalYield: 300,
        brands: ["DemoBrand"],
        lines: [{ category: "1-Primary", component: scoop.name, spec: "Standard", baseQty: 300, wastageRate: 0.02, bufferQty: 6, totalQty: 300, sources: { [c.item.productName]: 300 } }],
      },
    },
  });
  console.log(`Product C ready: ${c.item.productName} (PO ${c.po.poNumber})`);

  console.log("\nDone. Open Dashboard -> Pending POs (PPIC) to see the report.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
