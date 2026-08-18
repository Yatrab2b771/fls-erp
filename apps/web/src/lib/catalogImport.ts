import * as XLSX from "xlsx";

// SKU spreadsheet columns, ported verbatim from the pre-rebuild frontend's
// direct row['Jar']/row['Wad (MM)']/... lookups — same exact header
// strings (including the original's "Neck Sleave" typo) so the same
// spreadsheets that worked there work here.
const SKU_COLUMN_MAP: Record<string, string[]> = {
  jar: ["Jar"],
  wadMm: ["Wad (MM)"],
  scoopMl: ["Scoop (ML)"],
  silicaGelGms: ["Silica Gel (Gms.)"],
  silicaGelQtyNos: ["Silica Gel Qty. (Nos.)"],
  authenticationSticker: ["Authentication Sticker"],
  capSticker: ["Cap Sticker"],
  capLockSticker: ["Cap Lock Sticker"],
  neckSleeve: ["Neck Sleave", "Neck Sleeve"],
  shrink: ["Shrink"],
  innerPackaging: ["Inner Packaging"],
  leaflet: ["Leaflet"],
  corrugatedBoxMm: ["Corrugated Box (MM)"],
  packagingSizeNos: ["Packaging Size. (Nos.)"],
};
const PRODUCT_NAME_COLUMNS = ["Product/ Labels", "Product", "Products Name", "Product Name", "SKU", "productName"];

function firstNonEmpty(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return undefined;
}

export interface ImportSkuPayload {
  productName: string;
  [field: string]: unknown;
}

export interface ImportBrandPayload {
  brand: string;
  skus: ImportSkuPayload[];
}

/** One workbook sheet = one brand, one row = one SKU. */
export function parseCatalogWorkbook(buffer: ArrayBuffer): ImportBrandPayload[] {
  const workbook = XLSX.read(buffer, { type: "array" });
  const brandsPayload: ImportBrandPayload[] = [];

  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, { defval: "" });
    const skus: ImportSkuPayload[] = [];
    for (const row of rows) {
      const productName = firstNonEmpty(row, PRODUCT_NAME_COLUMNS);
      if (!productName) continue;
      const sku: ImportSkuPayload = { productName };
      const knownColumns = new Set(PRODUCT_NAME_COLUMNS);
      for (const [field, columns] of Object.entries(SKU_COLUMN_MAP)) {
        const val = firstNonEmpty(row, columns);
        if (val !== undefined) sku[field] = val;
        columns.forEach((c) => knownColumns.add(c));
      }
      const extra: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(row)) {
        if (!knownColumns.has(key) && String(val).trim() !== "") extra[key] = val;
      }
      if (Object.keys(extra).length) sku.extra = extra;
      skus.push(sku);
    }
    if (skus.length) brandsPayload.push({ brand: sheetName, skus });
  }
  return brandsPayload;
}
