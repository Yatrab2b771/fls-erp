import { prisma } from "../src/common/lib/prisma";
import { goodQtyOf } from "../src/modules/batches/good-qty";

/**
 * One-off: a run's "made so far" (combinedQty) is now what its finished batches count for after QA's gates (see good-qty.ts). Runs whose
 * batches cleared a gate before that change still carry the gross output. This recomputes combinedQty for per-batch-flow runs.
 *
 *   npx tsx prisma/recompute-made-qty.ts          (shows what would change)
 *   npx tsx prisma/recompute-made-qty.ts --apply  (does it)
 */
async function main() {
  const apply = process.argv.includes("--apply");
  const runs = await prisma.preProduction.findMany({
    where: { batchFlow: true },
    select: { id: true, combinedQty: true, plannedQty: true, purchaseOrderItem: { select: { productName: true } }, productionBatches: { where: { status: "COMPLETED" }, select: { batchNo: true, currentStageId: true, outputQty: true, mfgApprovedQty: true, packApprovedQty: true } } },
  });
  let changed = 0;
  for (const r of runs) {
    const should = Math.round(r.productionBatches.reduce((s, b) => s + goodQtyOf(b), 0) * 1000) / 1000;
    if (Math.abs(should - r.combinedQty) < 1e-6) continue;
    changed++;
    console.log(`${r.purchaseOrderItem.productName}: made ${r.combinedQty} -> ${should} (planned ${r.plannedQty})`);
    if (apply) await prisma.preProduction.update({ where: { id: r.id }, data: { combinedQty: should } });
  }
  console.log(changed ? `${changed} run(s) ${apply ? "updated" : "would change; add --apply to do it"}.` : "Every run is already in step.");
}

main().finally(() => prisma.$disconnect());
