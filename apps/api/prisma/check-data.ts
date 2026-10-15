import { prisma } from "../src/common/lib/prisma";
import { checkDataIntegrity } from "../src/modules/ppic/data-integrity";

/**
 * Data check: is every product's record consistent with the stage it is in?
 *
 *   npx tsx prisma/check-data.ts
 *
 * Prints how many products are at each stage (BD to Dispatch) and every rule that is broken. Exit code 1 if anything is broken.
 */
async function main() {
  const { violations, counts } = await checkDataIntegrity();
  console.log("Products per stage:");
  for (const [stage, n] of Object.entries(counts)) console.log(`  ${stage.padEnd(22)} ${n}`);
  if (violations.length === 0) return console.log("\nAll records are consistent.");
  console.log(`\n${violations.length} problem(s):`);
  for (const v of violations) console.log(`  [${v.rule}] ${v.po} / ${v.product}: ${v.detail}`);
  process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
