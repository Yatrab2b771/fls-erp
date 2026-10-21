// One-off: the per-batch Line Clearance step was removed. Batches that were waiting at it are READY for production now.
// Run: npx tsx prisma/skip-batch-line-clearance.ts        (shows how many; changes nothing)
//      npx tsx prisma/skip-batch-line-clearance.ts --yes  (moves them to READY)
import { prisma } from "../src/common/lib/prisma";

async function main() {
  const waiting = await prisma.productionBatch.count({ where: { prepStageId: "LINE_CLEARANCE" } });
  console.log(`${waiting} batch(es) are at Line Clearance.`);
  if (waiting > 0 && process.argv.includes("--yes")) {
    const res = await prisma.productionBatch.updateMany({ where: { prepStageId: "LINE_CLEARANCE" }, data: { prepStageId: "READY" } });
    console.log(`Moved ${res.count} batch(es) to READY.`);
  }
}

main().finally(() => prisma.$disconnect());
