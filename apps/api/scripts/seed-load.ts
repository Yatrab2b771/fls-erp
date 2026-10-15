/**
 * Bulk "LOAD-" data for checking how the paged lists and dashboard tiles hold up
 * at thousands of rows: customers, vendors, approved POs with products, RM/PM
 * items and stock receipts.
 *
 *   npx tsx scripts/seed-load.ts            add the rows (default 3000 POs)
 *   npx tsx scripts/seed-load.ts --clean    delete every LOAD- row again
 *
 * Everything it creates is prefixed LOAD-, so --clean never touches real data.
 * Point DATABASE_URL at a throwaway DB (e.g. the one in .env.test).
 */
import { PrismaClient } from "@prisma/client";

export interface LoadSizes {
  pos: number;
  customers: number;
  vendors: number;
  items: number;
  receipts: number;
}

export const DEFAULT_SIZES: LoadSizes = { pos: 3000, customers: 300, vendors: 400, items: 3000, receipts: 5000 };

const CHUNK = 1000;

async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK));
}

export async function seedLoad(prisma: PrismaClient, createdById: string, sizes: LoadSizes = DEFAULT_SIZES) {
  const customers = Array.from({ length: sizes.customers }, (_, i) => ({ id: crypto.randomUUID(), companyName: `LOAD-Customer ${String(i + 1).padStart(4, "0")}`, createdById }));
  await insertChunked(customers, (data) => prisma.customer.createMany({ data }));

  await insertChunked(
    Array.from({ length: sizes.vendors }, (_, i) => ({ name: `LOAD-Vendor ${String(i + 1).padStart(4, "0")}`, code: `LOAD-V${i + 1}`, createdById })),
    (data) => prisma.vendor.createMany({ data }),
  );

  const items = Array.from({ length: sizes.items }, (_, i) => ({ id: crypto.randomUUID(), category: i % 3 === 0 ? ("PM" as const) : ("RM" as const), name: `LOAD-Material ${String(i + 1).padStart(4, "0")}`, unit: "Kg" }));
  await insertChunked(items, (data) => prisma.inventoryItem.createMany({ data }));

  const now = Date.now();
  await insertChunked(
    Array.from({ length: sizes.receipts }, (_, i) => ({
      itemId: items[i % items.length].id,
      type: "RECEIVED" as const,
      date: new Date(now - (i % 365) * 86_400_000),
      unit: "Kg",
      quantity: 50 + (i % 200),
      vendorName: `LOAD-Vendor ${String((i % sizes.vendors) + 1).padStart(4, "0")}`,
      createdById,
      receiptStatus: "ACCEPTED" as const,
      acceptedById: createdById,
      acceptedAt: new Date(now),
    })),
    (data) => prisma.inventoryTransaction.createMany({ data }),
  );

  const pos = Array.from({ length: sizes.pos }, (_, i) => ({
    id: crypto.randomUUID(),
    customerId: customers[i % customers.length].id,
    poNumber: `LOAD-PO-${String(i + 1).padStart(5, "0")}`,
    orderDate: new Date(now - (i % 400) * 86_400_000),
    status: "APPROVED" as const,
    createdById,
    reviewedById: createdById,
    reviewedAt: new Date(now),
  }));
  await insertChunked(pos, (data) => prisma.purchaseOrder.createMany({ data }));
  await insertChunked(
    pos.flatMap((po, i) =>
      Array.from({ length: 1 + (i % 3) }, (_, k) => ({ purchaseOrderId: po.id, productName: `LOAD-Product ${(i % 800) + 1}-${k + 1}`, productCategory: ["Powder", "Gummies", "Bars"][(i + k) % 3], quantity: 10 + k, unit: "KG" })),
    ),
    (data) => prisma.purchaseOrderItem.createMany({ data }),
  );
}

export async function cleanLoad(prisma: PrismaClient) {
  const poIds = (await prisma.purchaseOrder.findMany({ where: { poNumber: { startsWith: "LOAD-" } }, select: { id: true } })).map((p) => p.id);
  await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: { in: poIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
  await prisma.inventoryTransaction.deleteMany({ where: { item: { name: { startsWith: "LOAD-" } } } });
  await prisma.inventoryItem.deleteMany({ where: { name: { startsWith: "LOAD-" } } });
  await prisma.vendor.deleteMany({ where: { name: { startsWith: "LOAD-" } } });
  await prisma.customer.deleteMany({ where: { companyName: { startsWith: "LOAD-" } } });
}

async function main() {
  const prisma = new PrismaClient();
  try {
    if (process.argv.includes("--clean")) {
      await cleanLoad(prisma);
      console.log("LOAD- rows removed.");
      return;
    }
    const user = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
    if (!user) throw new Error("No user in this database to own the rows.");
    const t = Date.now();
    await seedLoad(prisma, user.id);
    console.log(`Seeded ${DEFAULT_SIZES.pos} POs, ${DEFAULT_SIZES.items} items, ${DEFAULT_SIZES.receipts} receipts in ${Date.now() - t} ms.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith("seed-load.ts")) void main();
