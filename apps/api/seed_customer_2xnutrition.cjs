const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const PRODUCTS = [
  "2X-Nutrition Isomagic Whey Protein Isolate (Pineapple)",
  "2X-Nutrition Isomagic Whey Protein Isolate (Belgian Chocolate)",
  "2X-Nutrition Creatine Monohydrate (Unflavoured)",
  "2X-Nutrition Real Gainz (Kulfi)",
  "2X-Nutrition Real Gainz (Chocolate)",
  "2X-Nutrition Pre Workout Power House (Mango)",
];

async function main() {
  const bd = await prisma.user.findUnique({ where: { email: "bd@fls.local" } });
  if (!bd) throw new Error("bd@fls.local user not found");

  let customer = await prisma.customer.findFirst({ where: { companyName: "2X NUTRITION" } });
  if (!customer) {
    customer = await prisma.customer.create({ data: { companyName: "2X NUTRITION", createdById: bd.id } });
  }

  console.log("Customer:", customer.id, customer.companyName);

  for (const productName of PRODUCTS) {
    const sku = await prisma.sku.upsert({
      where: { customerId_productName: { customerId: customer.id, productName } },
      create: { customerId: customer.id, productName },
      update: {},
    });
    console.log("  SKU:", sku.id, sku.productName);
  }

  const total = await prisma.sku.count({ where: { customerId: customer.id } });
  console.log(`Done. ${total} SKUs under ${customer.companyName}.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
