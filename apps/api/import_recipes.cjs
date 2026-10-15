// One-time import: Recipes + RecipeIngredients for 2X Nutrition's 6
// products from "PRODUCT WISE BOM.xlsx" (RM SHEET) — the only sheet in
// the workspace with ingredient-level (RM) formulation data.
//
// IMPORTANT — placeholder values: the source sheet only has an
// "Ingredients", "Make" and "BOM" (fraction of formulation) column, no
// cost or serving-size data. costPerKg is set to 0 and gPerServing is
// estimated as BOM% x 100g (an assumed 100g total serving) — both are
// placeholders, not real figures. R&D must correct costPerKg and
// totalServing/gPerServing with real values before RM Costing is
// trusted for these products.
//
// Run from apps/api: node import_recipes.cjs
const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const SOURCE_FILE =
  "C:/Users/DELL/OneDrive - TechiesGuru/Workplace/Vaibhav/FLS/Workplace/New folder/fls stock/PRODUCT WISE BOM.xlsx";
const ASSUMED_TOTAL_SERVING_G = 100;

function cellToString(v) {
  if (v === "" || v === null || v === undefined) return undefined;
  return String(v).trim() || undefined;
}

async function main() {
  const wb = XLSX.readFile(SOURCE_FILE);
  const sheet = wb.Sheets["RM SHEET"];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const header = rows[0].map((c) => String(c).trim().toLowerCase());
  const custCol = header.indexOf("customer");
  const prodCol = header.indexOf("product name");
  const codeCol = header.indexOf("rm code");
  const ingCol = header.indexOf("ingredients");
  const makeCol = header.indexOf("make");
  const bomCol = header.indexOf("bom");

  const byProduct = new Map(); // productName -> ingredient rows

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const productName = cellToString(row[prodCol]);
    const ingredient = cellToString(row[ingCol]);
    if (!productName || !ingredient) continue;
    const bomFraction = typeof row[bomCol] === "number" ? row[bomCol] : parseFloat(row[bomCol]) || 0;
    if (!byProduct.has(productName)) byProduct.set(productName, []);
    byProduct.get(productName).push({
      name: ingredient,
      brand: cellToString(row[makeCol]) ?? "Unknown",
      itemCode: cellToString(row[codeCol]),
      gPerServing: bomFraction * ASSUMED_TOTAL_SERVING_G,
    });
  }

  let recipesCreated = 0;
  let recipesSkipped = 0;
  let ingredientsCreated = 0;

  for (const [productName, ingredients] of byProduct) {
    const existing = await prisma.recipe.findUnique({ where: { name: productName } });
    if (existing) {
      console.log(`SKIP (already exists): ${productName}`);
      recipesSkipped++;
      continue;
    }

    const recipe = await prisma.recipe.create({
      data: {
        name: productName,
        totalServing: ASSUMED_TOTAL_SERVING_G,
        ingredients: {
          create: ingredients.map((ing, idx) => ({
            name: ing.name,
            brand: ing.brand,
            itemCode: ing.itemCode,
            costPerKg: 0,
            gPerServing: ing.gPerServing,
            sortOrder: idx,
          })),
        },
      },
      include: { ingredients: true },
    });
    recipesCreated++;
    ingredientsCreated += recipe.ingredients.length;
    console.log(`Created: ${productName} (${recipe.ingredients.length} ingredients)`);
  }

  console.log("\n=== DONE ===");
  console.log(`Recipes created: ${recipesCreated}, skipped (already existed): ${recipesSkipped}`);
  console.log(`Ingredients created: ${ingredientsCreated}`);
  console.log(`NOTE: costPerKg=0 and gPerServing is estimated off a ${ASSUMED_TOTAL_SERVING_G}g assumed serving — both are placeholders. Correct with real values in RM Costing before trusting cost output.`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
