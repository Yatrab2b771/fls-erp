// One-time import: Customers + SKUs (packaging spec) from
// "Packaging Material (1).xlsx" (78 sheets, one per customer).
// Run from apps/api: node import_catalog.cjs
const path = require("path");
const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const SOURCE_FILE =
  "C:/Users/DELL/OneDrive - TechiesGuru/Workplace/Vaibhav/FLS/Workplace/New folder/fls stock/Packaging Material (1).xlsx";

// Sku model fields <- possible header aliases (normalized: lowercased,
// whitespace collapsed to single space, trimmed).
const COL_MAP = {
  jar: ["jar"],
  wadMm: ["wad (mm)"],
  scoopMl: ["scoop (ml)"],
  silicaGelGms: ["silica gel (gms.)"],
  silicaGelQtyNos: ["silica gel qty. (nos.)"],
  authenticationSticker: ["authentication sticker"],
  capSticker: ["cap sticker", "wholemrk ("],
  capLockSticker: ["cap lock sticker"],
  neckSleeve: ["neck sleave", "neck sleeve"],
  corrugatedBoxMm: ["corrugated box (mm)"],
  innerPackaging: ["inner packaging"],
  packagingSizeNos: ["packaging size. (nos.)", "packaging size"],
};

function norm(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cellToString(v) {
  if (v === "" || v === null || v === undefined) return undefined;
  return String(v).trim() || undefined;
}

async function main() {
  const bd = await prisma.user.findUnique({ where: { email: "bd@fls.local" } });
  if (!bd) throw new Error("bd@fls.local user not found — is the local DB seeded?");

  const wb = XLSX.readFile(SOURCE_FILE);

  let customersCreated = 0;
  let customersReused = 0;
  let skusUpserted = 0;
  const skippedSheets = [];

  for (const sheetName of wb.SheetNames) {
    const companyName = sheetName.trim();
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      if (rows[i].map(norm).some((c) => c.startsWith("product"))) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) {
      skippedSheets.push(sheetName);
      continue;
    }

    const header = rows[headerIdx].map(norm);
    const nameCol = header.findIndex((c) => c.startsWith("product"));
    const colIdx = {};
    for (const [field, aliases] of Object.entries(COL_MAP)) {
      colIdx[field] = header.findIndex((h) => aliases.includes(h));
    }

    const productRows = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      const productName = cellToString(row[nameCol]);
      if (!productName) continue;
      const spec = {};
      for (const [field, idx] of Object.entries(colIdx)) {
        if (idx === -1) continue;
        const val = cellToString(row[idx]);
        if (val !== undefined) spec[field] = val;
      }
      productRows.push({ productName, spec });
    }
    if (productRows.length === 0) {
      skippedSheets.push(sheetName);
      continue;
    }

    let customer = await prisma.customer.findFirst({ where: { companyName } });
    if (customer) {
      customersReused++;
    } else {
      customer = await prisma.customer.create({ data: { companyName, createdById: bd.id } });
      customersCreated++;
    }

    for (const { productName, spec } of productRows) {
      await prisma.sku.upsert({
        where: { customerId_productName: { customerId: customer.id, productName } },
        create: { customerId: customer.id, productName, ...spec },
        update: spec,
      });
      skusUpserted++;
    }
    console.log(`${companyName}: ${productRows.length} products`);
  }

  console.log("\n=== DONE ===");
  console.log(`Customers created: ${customersCreated}, reused: ${customersReused}`);
  console.log(`SKUs upserted: ${skusUpserted}`);
  if (skippedSheets.length) console.log(`Skipped sheets (no products found): ${skippedSheets.join(", ")}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
