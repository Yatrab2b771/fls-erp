// Demo data for the Pre-Inventory / Purchase Planning tiles (Covered,
// Shortfall, PO Logged-with-ETA, and the new "Updated" tag) — dev DB
// only had 1 requirement, already ordered, no corrections, so none of
// the new PPIC-visible states had anything real to show.
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

const dayMs = 1000 * 60 * 60 * 24;
const daysFromNow = (n) => new Date(Date.now() + n * dayMs);

async function main() {
  const ppic = await prisma.user.findUnique({ where: { email: "ppic@fls.local" } });
  const purchase = await prisma.user.findUnique({ where: { email: "purchase@fls.local" } });
  if (!ppic || !purchase) throw new Error("ppic@fls.local / purchase@fls.local not found — is the dev DB seeded?");

  const wheyIsolate = await upsertItemWithStock("RM", "DEMO Whey Isolate", "Kg", 0, ppic.id);
  const capsuleShells = await upsertItemWithStock("PM", "DEMO Capsule Shells", "Nos", 500, ppic.id);
  const vitaminC = await upsertItemWithStock("RM", "DEMO Vitamin C Powder", "Kg", 50, ppic.id);
  const flavourPremix = await upsertItemWithStock("RM", "DEMO Flavour Premix", "Kg", 20, ppic.id);
  const petJar = await upsertItemWithStock("PM", "DEMO PET Jar 500ml", "Nos", 0, ppic.id);

  // 1. COVERED — stock already meets the requirement, nothing for Purchase to do.
  await prisma.preInventoryRequirement.create({
    data: { date: new Date(), category: "PM", itemId: capsuleShells.id, unit: "Nos", requiredQty: 300, requestedById: ppic.id },
  });

  // 2. SHORTFALL — raised, nobody has logged a PO yet.
  await prisma.preInventoryRequirement.create({
    data: { date: new Date(), category: "RM", itemId: wheyIsolate.id, unit: "Kg", requiredQty: 200, requestedById: ppic.id },
  });

  // 3. ORDERED — PO logged once, ETA still in the future, never corrected.
  await prisma.preInventoryRequirement.create({
    data: {
      date: new Date(),
      category: "RM",
      itemId: vitaminC.id,
      unit: "Kg",
      requiredQty: 500,
      requestedById: ppic.id,
      poNumber: "PUR-DEMO-1001",
      vendorName: "NutriChem Suppliers",
      eta: daysFromNow(5),
      purchaseById: purchase.id,
      purchaseAt: new Date(),
    },
  });

  // 4. ORDERED + Updated — PO logged, then Purchase corrected the ETA
  // (pushed it out) — this is the one that should show the "Updated" tag.
  await prisma.preInventoryRequirement.create({
    data: {
      date: new Date(),
      category: "RM",
      itemId: flavourPremix.id,
      unit: "Kg",
      requiredQty: 300,
      requestedById: ppic.id,
      poNumber: "PUR-DEMO-1002",
      vendorName: "AromaFlavours Pvt Ltd",
      eta: daysFromNow(12),
      purchaseById: purchase.id,
      purchaseAt: new Date(),
      purchaseCorrectedAt: new Date(),
    },
  });

  // 5. ORDERED — PO logged, ETA already passed (Overdue), never corrected —
  // shows the "(Overdue)" flag but no "Updated" tag, distinct from #4.
  await prisma.preInventoryRequirement.create({
    data: {
      date: new Date(),
      category: "PM",
      itemId: petJar.id,
      unit: "Nos",
      requiredQty: 1000,
      requestedById: ppic.id,
      poNumber: "PUR-DEMO-1003",
      vendorName: "PolyPack Industries",
      eta: daysFromNow(-3),
      purchaseById: purchase.id,
      purchaseAt: new Date(),
    },
  });

  console.log("Done — 1 Covered, 1 Shortfall, 3 Ordered (1 Updated, 1 Overdue). Refresh Dashboard / Pre-Inventory / Purchase Planning tiles.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
