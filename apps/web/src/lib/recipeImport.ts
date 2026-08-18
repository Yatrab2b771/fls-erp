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
