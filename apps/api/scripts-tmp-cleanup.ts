import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const badItemIds = [
  "3cdaf567-4a10-487f-8f38-56c8e1372000", // RM00001 (mangled dash)
  "c8cf895e-f34c-4a2b-bef8-c58f70adaa1d", // RM00002 (mangled dash)
  "46db1a3f-dc15-4193-bfd9-ec8caa007dd9", // RM00004 (mangled dash)
];

async function main() {
  const [{ current_database: dbName }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
  if (dbName !== "fls_erp_v2_dev") {
    throw new Error(`Refusing to touch this data — connected to "${dbName}", not "fls_erp_v2_dev".`);
  }

  const requests = await prisma.rndSampleRequest.deleteMany({ where: { itemId: { in: badItemIds } } });
  console.log(`Deleted ${requests.count} RndSampleRequest row(s) referencing the bad items.`);

  const items = await prisma.inventoryItem.deleteMany({ where: { id: { in: badItemIds } } });
  console.log(`Deleted ${items.count} duplicate InventoryItem row(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
