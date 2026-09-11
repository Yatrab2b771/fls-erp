import * as XLSX from "xlsx";

// SKU spreadsheet columns, ported verbatim from the pre-rebuild frontend's
// direct row['Jar']/row['Wad (MM)']/... lookups — same exact header
// strings (including the original's "Neck Sleave" typo) so the same
// spreadsheets that worked there work here. Headers are matched after
// normalizeHeader() below, so "Silica Gel  (Gms.)" (the real file has two
// spaces) still matches "Silica Gel (Gms.)" here.
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
const PRODUCT_NAME_COLUMNS = ["Product/ Labels", "Product Without Labels", "Product", "Products Name", "Product Name", "SKU", "productName"];

// Collapses "Silica Gel  (Gms.)" (real file, two spaces) and
// "Silica Gel (Gms.)" (this map, one space) to the same key, and treats
// a merged/blank header cell as "" instead of "undefined"/"null" text —
// so header matching survives the spreadsheet's own inconsistent spacing.
function normalizeHeader(cell: unknown): string {
  return String(cell ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// Case-insensitive on top of normalizeHeader — the real file mostly
// spells this column "SHRINK" (all caps) where the map below has
// "Shrink"; case is exactly the kind of inconsistency that varies sheet
// to sheet without meaning anything, so it's never worth chasing with
// more spelling variants.
function canonicalHeader(cell: unknown): string {
  return normalizeHeader(cell).toLowerCase();
}

// `row` here is keyed by canonicalHeader already (see parseCatalogWorkbook).
function firstNonEmpty(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[canonicalHeader(k)];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return undefined;
}

// The real workbook doesn't put column headers on row 1 of every sheet —
// some sheets carry a title/revision line (or a blank row) above the
// real header row, at a different depth per sheet. Scan the first few
// rows for the one that actually looks like the header (has a Product
// Name column, or "Jar") instead of assuming a fixed row number.
function findHeaderRowIndex(rows: unknown[][]): number {
  const markers = new Set([...PRODUCT_NAME_COLUMNS, "Jar"].map(canonicalHeader));
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const cells = (rows[i] ?? []).map(canonicalHeader);
    if (cells.some((c) => markers.has(c))) return i;
  }
  return 0; // fallback — a sheet shaped exactly like before this existed
}

export interface ImportSkuPayload {
  productName: string;
  [field: string]: unknown;
}

// One sheet = one Customer's own catalog — there's no separate "Brand"
// grouping any more (see the Sku model's own schema comment); the sheet
// name is resolved against the real Customer directory server-side
// (exact match reused, no match creates a bare Customer, more than one
// match reported back rather than guessed at).
export interface ImportCustomerCatalogPayload {
  customerName: string;
  skus: ImportSkuPayload[];
}

/** One workbook sheet = one Customer's catalog, one row = one SKU. */
export function parseCatalogWorkbook(buffer: ArrayBuffer): ImportCustomerCatalogPayload[] {
  const workbook = XLSX.read(buffer, { type: "array" });
  const customersPayload: ImportCustomerCatalogPayload[] = [];

  for (const sheetName of workbook.SheetNames) {
    const raw = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName]!, { header: 1, defval: "" });
    const headerRowIndex = findHeaderRowIndex(raw);
    const headers = (raw[headerRowIndex] ?? []).map(normalizeHeader);
    const dataRows = raw.slice(headerRowIndex + 1);

    const skus: ImportSkuPayload[] = [];
    for (const rawRow of dataRows) {
      // Two views of the same row: `row` keyed by the canonical (case-
      // /whitespace-folded) header, for matching against the known
      // columns above; `displayRow` keeps the sheet's own header text,
      // so anything landing in `extra` still reads like the spreadsheet
      // instead of an all-lowercase key.
      const row: Record<string, unknown> = {};
      const displayRow: Record<string, unknown> = {};
      headers.forEach((header, colIndex) => {
        if (!header) return;
        row[canonicalHeader(header)] = rawRow[colIndex] ?? "";
        displayRow[header] = rawRow[colIndex] ?? "";
      });

      const productName = firstNonEmpty(row, PRODUCT_NAME_COLUMNS);
      if (!productName) continue;
      const sku: ImportSkuPayload = { productName };
      const knownColumns = new Set(PRODUCT_NAME_COLUMNS.map(canonicalHeader));
      for (const [field, columns] of Object.entries(SKU_COLUMN_MAP)) {
        const val = firstNonEmpty(row, columns);
        if (val !== undefined) sku[field] = val;
        columns.forEach((c) => knownColumns.add(canonicalHeader(c)));
      }
      // Anything else the sheet had — including a column added after this
      // was written — is never dropped, just kept unmapped here. R&D's
      // own Sku spec view/export can still surface it from `extra`.
      const extra: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(displayRow)) {
        if (!knownColumns.has(canonicalHeader(key)) && String(val).trim() !== "") extra[key] = val;
      }
      if (Object.keys(extra).length) sku.extra = extra;
      skus.push(sku);
    }
    if (skus.length) customersPayload.push({ customerName: sheetName, skus });
  }
  return customersPayload;
}

// A ready-to-fill starter workbook, same shape parseCatalogWorkbook()
// above expects — one sheet per Customer, one row per SKU, real column
// headers. Exists so R&D doesn't have to reverse-engineer the expected
// columns from a real 78-sheet file: for a brand-new customer wanting an
// already-known product (or a genuinely new one), this is the fastest
// path to a correctly-shaped upload.
export function downloadCatalogImportTemplate() {
  const headers = [
    "Product Name",
    "Jar",
    "Wad (MM)",
    "Scoop (ML)",
    "Silica Gel (Gms.)",
    "Silica Gel Qty. (Nos.)",
    "Authentication Sticker",
    "Cap Sticker",
    "Cap Lock Sticker",
    "Neck Sleeve",
    "Shrink",
    "Inner Packaging",
    "Leaflet",
    "Corrugated Box (MM)",
    "Packaging Size. (Nos.)",
  ];
  const sampleRows = [
    {
      "Product Name": "Whey Protein Powder 1kg",
      Jar: "1kg HDPE Jar",
      "Wad (MM)": "83mm",
      "Scoop (ML)": "30ml",
      "Silica Gel (Gms.)": "2",
      "Silica Gel Qty. (Nos.)": "1",
      "Authentication Sticker": "Yes",
      "Cap Sticker": "",
      "Cap Lock Sticker": "",
      "Neck Sleeve": "Yes",
      Shrink: "",
      "Inner Packaging": "",
      Leaflet: "Yes",
      "Corrugated Box (MM)": "5-ply",
      "Packaging Size. (Nos.)": "12",
    },
    Object.fromEntries(headers.map((h) => [h, ""])),
  ];

  const skuSheet = XLSX.utils.json_to_sheet(sampleRows, { header: headers });
  const instructionsSheet = XLSX.utils.aoa_to_sheet([
    ["How to use this template"],
    [""],
    ["1. One sheet = one Customer's catalog. This workbook has one example sheet, named \"New Customer Name\" below."],
    ["2. Rename that sheet's tab (double-click it) to the real Customer name — an existing one to add products to it, or a brand-new one to create it on import."],
    ["3. Fill in one row per product. Only Product Name is required — leave any packaging column blank if it doesn't apply to that product."],
    ["4. Need more than one customer? Right-click the sheet tab -> Move or Copy -> Create a copy, then rename each copy to its own Customer name."],
    ["5. Upload the finished file via \"Import Catalog (BOM)\" on this page. Matching is by exact Customer name (case/spacing-insensitive) — a name that matches more than one existing customer is reported back, not guessed at."],
    [""],
    ["Columns not in this template aren't lost — any extra column in your sheet is still imported and kept (visible in the SKU's \"Custom Fields\")."],
    ["The real per-product packaging BOM checklist (Jar, Cap, Silica 5gm, Silica 2gm, Sachet, ...) is filled in separately, after import, from the SKU editor's \"Packaging BOM\" section on the right."],
  ]);
  instructionsSheet["!cols"] = [{ wch: 100 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, "Instructions");
  XLSX.utils.book_append_sheet(workbook, skuSheet, "New Customer Name");
  XLSX.writeFile(workbook, "FLS_Packaging_Catalog_Import_Template.xlsx");
}
