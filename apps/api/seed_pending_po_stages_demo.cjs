// Demo data for the Pending PO Report's "Current Stage" column — the
// dev DB had zero PreProduction/ProductionBatch rows, so every pending
// product showed only "BOM/RM Planning" or "Plan Not Sent to
// Production". This picks 8 real pending PO products (no existing
// PreProduction) and puts each one at a different real pipeline stage —
// 4 Tier-1 (PreProduction) stages, 4 Tier-3 (ProductionBatch) stages —
// so the report's Stage column has real variety to show. Written
// directly against Prisma (bypassing the stage-transition engine/API),
// same "seed the end state" approach as this repo's other seed_*.cjs
// demo scripts — fine for demo data, not something real stage
// transitions should ever do.
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const production = await prisma.user.findUnique({ where: { email: "production@fls.local" } });
  if (!production) throw new Error("production@fls.local user not found — is the dev DB seeded?");
  const createdById = production.id;

  const pending = await prisma.purchaseOrder.findMany({
    where: { status: { not: "REJECTED" } },
    select: {
      id: true,
      poNumber: true,
      items: { where: { deletedAt: null }, select: { id: true, productName: true, quantity: true, unit: true, preProduction: { select: { id: true } } } },
    },
  });
  const candidates = [];
  for (const po of pending) {
    for (const item of po.items) {
      if (!item.preProduction) candidates.push({ po, item });
    }
  }
  if (candidates.length < 8) throw new Error(`Only found ${candidates.length} products without a PreProduction run yet — need at least 8`);

  // Tier 1 — PreProduction sits mid-pipeline, no ProductionBatch yet.
  const tier1Stages = ["MATERIAL_RECEIVED", "INDENT_ISSUE", "DISPENSING", "SAMPLE_QC_APPROVAL"];
  for (let i = 0; i < tier1Stages.length; i++) {
    const { po, item } = candidates[i];
    const stage = tier1Stages[i];
    await prisma.preProduction.create({
      data: {
        purchaseOrderItemId: item.id,
        currentStageId: stage,
        plannedQty: item.quantity,
        unit: item.unit,
        ...(stage !== "MATERIAL_RECEIVED" ? { grnNo: "DEMO-GRN-001", grnDate: new Date() } : {}),
        ...(stage === "SAMPLE_QC_APPROVAL" ? { sampleQcStatus: "Hold", sampleQcRemarks: "Awaiting QA sign-off (demo)" } : {}),
      },
    });
    console.log(`Tier-1 ${stage}: ${item.productName} (PO ${po.poNumber})`);
  }

  // Tier 3 — PreProduction already forwarded past its own pipeline, one
  // ProductionBatch sitting at a Tier-3 stage.
  const tier3Stages = ["IPQC", "PACKAGING", "FG_STORE", "BILLING_EWAY_BILL"];
  for (let i = 0; i < tier3Stages.length; i++) {
    const { po, item } = candidates[4 + i];
    const stage = tier3Stages[i];
    const pp = await prisma.preProduction.create({
      data: {
        purchaseOrderItemId: item.id,
        currentStageId: "SAMPLE_QC_APPROVAL",
        plannedQty: item.quantity,
        unit: item.unit,
        grnNo: "DEMO-GRN-002",
        grnDate: new Date(),
        sampleQcStatus: "Approved",
        sampleQcRemarks: "Demo data",
      },
    });
    await prisma.productionBatch.create({
      data: {
        preProductionId: pp.id,
        plannedQty: item.quantity,
        status: "COMPLETED",
        currentStageId: stage,
        manufacturingStartDate: new Date(),
        manufacturingEndDate: new Date(),
        inputQty: item.quantity,
        outputQty: item.quantity * 0.97,
        createdById,
      },
    });
    console.log(`Tier-3 ${stage}: ${item.productName} (PO ${po.poNumber})`);
  }

  console.log("\nDone. Refresh Dashboard -> Pending POs (PPIC) to see the Stage column.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
