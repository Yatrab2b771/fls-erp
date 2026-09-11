import * as XLSX from "xlsx";

export interface ImportIngredientPayload {
  name: string;
  brand: string;
  gPerServing: number;
  costPerKg: number;
  proteinPct: number;
}

export interface ImportRecipePayload {
  name: string;
  ingredients: ImportIngredientPayload[];
}

// Fuzzy column matching, ported verbatim from the pre-rebuild frontend's
// header-detection logic: scan the first 30 rows of each sheet for one
// containing both an ingredient-ish column and a quantity-ish column,
// then match columns by substring on their lowercased header — not exact
// names, since every formulation sheet this was designed for names these
// slightly differently.
function findHeaderRowIndex(rawRows: unknown[][]): number {
  for (let i = 0; i < Math.min(30, rawRows.length); i++) {
    const rowStr = JSON.stringify(rawRows[i]).toLowerCase();
    if ((rowStr.includes("ingredient") || rowStr.includes("material")) && (rowStr.includes("serving") || rowStr.includes("qty"))) return i;
  }
  return -1;
}

export function parseRecipeWorkbook(buffer: ArrayBuffer): ImportRecipePayload[] {
  const workbook = XLSX.read(buffer, { type: "array" });
  const recipesPayload: ImportRecipePayload[] = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName]!;
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1 });
    const headerRowIndex = findHeaderRowIndex(rawRows);
    if (headerRowIndex === -1) continue;

    const parsedRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { range: headerRowIndex, defval: "" });
    const ingredients: ImportIngredientPayload[] = [];
    for (const row of parsedRows) {
      let name = "";
      let brand = "";
      let gPerServing = 0;
      let costPerKg = 0;
      let proteinPct = 0;
      for (const [key, val] of Object.entries(row)) {
        const k = key.toLowerCase().trim();
        if (k.includes("ingredient") || k.includes("material") || k === "item") name = String(val).trim();
        if (k.includes("brand") || k.includes("make")) brand = String(val).trim();
        if (k.includes("g/serving") || k.includes("quantity")) gPerServing = parseFloat(String(val)) || 0;
        if (k.includes("cost") || k.includes("rate") || k.includes("price")) costPerKg = parseFloat(String(val)) || 0;
        if (k.includes("protein")) {
          const pVal = parseFloat(String(val)) || 0;
          proteinPct = pVal > 1 ? pVal / 100 : pVal;
        }
      }
      if (name && gPerServing > 0) ingredients.push({ name, brand: brand || "Approved Vendor", gPerServing, costPerKg, proteinPct });
    }
    if (ingredients.length) recipesPayload.push({ name: sheetName, ingredients });
  }
  return recipesPayload;
}

// A ready-to-fill starter workbook, same shape parseRecipeWorkbook() above
// expects — one sheet per recipe (matched globally by Product Name, not
// per customer — see Recipe.name's own schema comment), one row per
// ingredient. Exists so R&D doesn't have to reverse-engineer the expected
// columns from scratch for a brand-new formulation.
export function downloadRecipeImportTemplate() {
  const headers = ["Ingredient", "Brand/Make", "g/Serving", "Cost (per Kg)", "Protein %"];
  const sampleRows = [
    { Ingredient: "Whey Protein Concentrate 80%", "Brand/Make": "Approved Vendor", "g/Serving": 25, "Cost (per Kg)": 650, "Protein %": 80 },
    { Ingredient: "Cocoa Powder", "Brand/Make": "Approved Vendor", "g/Serving": 3, "Cost (per Kg)": 320, "Protein %": 0 },
    { Ingredient: "Stevia Extract", "Brand/Make": "Approved Vendor", "g/Serving": 0.2, "Cost (per Kg)": 4500, "Protein %": 0 },
    { Ingredient: "", "Brand/Make": "", "g/Serving": "", "Cost (per Kg)": "", "Protein %": "" },
  ];

  const recipeSheet = XLSX.utils.json_to_sheet(sampleRows, { header: headers });
  const instructionsSheet = XLSX.utils.aoa_to_sheet([
    ["How to use this template"],
    [""],
    ["1. One sheet = one Recipe. This workbook has one example sheet, named \"New Product Name\" below."],
    ["2. Rename that sheet's tab (double-click it) to the exact Product Name the PO/catalog uses — a Recipe is matched by product name only, across every customer, not per customer."],
    ["3. Fill in one row per ingredient: Ingredient name, Brand/Make, how many grams go into one serving, cost per Kg, and protein % (leave 0 if not protein-bearing)."],
    ["4. Need more than one recipe? Right-click the sheet tab -> Move or Copy -> Create a copy, then rename each copy to its own Product Name."],
    ["5. Upload the finished file via \"Import Recipes (RM Costing)\" on this page. Column names just need to contain the right word (e.g. any header with \"ingredient\", \"g/serving\", \"cost\", \"protein\") — exact header text isn't required."],
  ]);
  instructionsSheet["!cols"] = [{ wch: 100 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, "Instructions");
  XLSX.utils.book_append_sheet(workbook, recipeSheet, "New Product Name");
  XLSX.writeFile(workbook, "FLS_RM_Recipe_Import_Template.xlsx");
}
