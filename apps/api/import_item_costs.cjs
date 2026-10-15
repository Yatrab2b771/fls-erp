// Imports Cost Price / M.R.P. / Purchase Price / Sales Price from the
// client's own "RM PM Status" stock report into InventoryItem, matched
// by item Code — localhost only. Source file has 4 header/label rows
// before the real data starts (row index 4 onward), columns:
//   0 Code | 1 Product Name | 2 Unit | 3 Current Stock | 4-7 Sales/Purc
//   Scheme Deal/Free | 8 Cost Price | 9 Value | 10 M.R.P. | 11 Purchase
//   Price | 12 Sales Price | 13 Company | 14 Manufacturer | 15 Rack No.
//
// A 0 in any of the 4 price columns is treated as "not entered" (blank
// in the source sheet, not a genuine zero cost) — skipped, not written.
//
// Run from apps/api:
//   node import_item_costs.cjs
const { PrismaClient } = require("@prisma/client");
const xlsx = require("xlsx");
const prisma = new PrismaClient();

const SOURCE_FILE = "../../../Workplace/New folder/fls stock/RMPM 190926.xlsx";
const SHEETS = ["RM", "PM"];

function parseSheet(wb, sheetName) {
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" });
  const out = [];
  for (let i = 4; i < rows.length; i++) {
    const r = rows[i];
    const code = String(r[0] ?? "").trim();
    if (!code) continue;
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    out.push({
      code,
      costPrice: num(r[8]),
      mrp: num(r[10]),
      purchasePrice: num(r[11]),
      salesPrice: num(r[12]),
    });
  }
  return out;
}

async function main() {
  const wb = xlsx.readFile(SOURCE_FILE);
  const rows = SHEETS.flatMap((s) => parseSheet(wb, s));
  console.log(`Parsed ${rows.length} rows with a Code across ${SHEETS.join(", ")}.`);

  let matched = 0;
  let updated = 0;
  const unmatchedCodes = [];

  for (const row of rows) {
    const item = await prisma.inventoryItem.findUnique({ where: { code: row.code }, select: { id: true } });
    if (!item) {
      unmatchedCodes.push(row.code);
      continue;
    }
    matched += 1;
    const data = {};
    if (row.costPrice !== null) data.costPrice = row.costPrice;
    if (row.mrp !== null) data.mrp = row.mrp;
    if (row.purchasePrice !== null) data.purchasePrice = row.purchasePrice;
    if (row.salesPrice !== null) data.salesPrice = row.salesPrice;
    if (Object.keys(data).length === 0) continue;
    await prisma.inventoryItem.update({ where: { id: item.id }, data });
    updated += 1;
  }

  console.log(`\nMatched by code: ${matched} / ${rows.length}`);
  console.log(`Updated with at least one price field: ${updated}`);
  console.log(`Unmatched codes (in sheet, not found in system): ${unmatchedCodes.length}`);
  if (unmatchedCodes.length > 0) {
    console.log(unmatchedCodes.slice(0, 30).join(", ") + (unmatchedCodes.length > 30 ? ", ..." : ""));
  }

  const withCost = await prisma.inventoryItem.count({ where: { costPrice: { not: null } } });
  const total = await prisma.inventoryItem.count();
  console.log(`\nTotal items with costPrice set now: ${withCost} / ${total}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
