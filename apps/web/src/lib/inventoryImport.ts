import * as XLSX from "xlsx";

// Column headers as they actually appear on Store's "MATERIAL RECEIVED" /
// "MATERIAL Issued to day store" / "MATERIAL Issued to Production" sheets
// — same porting approach as catalogImport.ts / recipeImport.ts, matched
// loosely so small header variations (case, trailing "." etc.) still work.
const DATE_COLUMNS = ["Date"];
const CATEGORY_COLUMNS = ["Category", "RM/PM", "Type"];
const ITEM_COLUMNS = ["Item", "Item Name", "Material", "Material Name"];
const UNIT_COLUMNS = ["Unit"];
const QUANTITY_COLUMNS = ["Count", "Quantity", "Qty"];
const SIZE_COLUMNS = ["Size"];
// "Vendor / Note" is the literal header on the app's own downloaded
// report (inventoryExport.ts exportTransactionReport) — recognized here
// too so a report round-trips back in as an import.
const VENDOR_COLUMNS = ["Vendor Name", "Vendor", "Supplier", "Vendor / Note"];
const BATCH_COLUMNS = ["Batch No", "Batch No.", "Batch", "Batch Number"];
const GRN_COLUMNS = ["GRN No", "GRN No.", "GRN", "GRN Number"];
const MFG_DATE_COLUMNS = ["Mfg Date", "Mfg. Date", "Manufacturing Date", "MFD"];
const EXPIRY_DATE_COLUMNS = ["Expiry Date", "Exp Date", "Exp. Date", "Expiry"];
const REMARK_COLUMNS = ["Remark", "Remarks", "Note", "Notes"];
// Which Day Store this row belongs to, by name — lets one sheet mix rows
// for several stores (e.g. the app's own downloaded report, which has a
// Day Store column per row) instead of requiring one sheet per store.
const DAY_STORE_COLUMNS = ["Day Store", "Store", "Store Name"];

// Accepts both the short codes the rest of the app uses (RM/PM) and the
// full labels the app's own downloaded report prints (Raw Material /
// Packaging Material) — so that report round-trips back in as an import
// without the category silently falling back to defaultCategory.
function normalizeCategory(text: string | undefined, fallback: "RM" | "PM"): "RM" | "PM" {
  const t = text?.trim().toUpperCase();
  if (t === "RM" || t === "RAW MATERIAL" || t === "RAW") return "RM";
  if (t === "PM" || t === "PACKAGING MATERIAL" || t === "PACKING MATERIAL" || t === "PACKAGING" || t === "PACKING") return "PM";
  return fallback;
}

function firstNonEmpty(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

function asText(row: Record<string, unknown>, keys: string[]): string | undefined {
  const v = firstNonEmpty(row, keys);
  return v === undefined ? undefined : String(v).trim();
}

// Excel date cells arrive either as a JS Date (workbook read with
// cellDates: true, below) or as plain dd-mm-yyyy / dd/mm/yyyy / yyyy-mm-dd
// text when the sheet stores dates as strings — cover all three rather
// than rejecting rows over a formatting difference.
function parseDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value ?? "").trim();
  if (!text) return undefined;

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  const dmy = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

export interface ImportInventoryRow {
  category: "RM" | "PM";
  itemName: string;
  date: string;
  unit: string;
  quantity: number;
  size?: string;
  vendorName?: string;
  batchNo?: string;
  grnNo?: string;
  mfgDate?: string;
  expiryDate?: string;
  remark?: string;
  // Which Day Store this row is for, by name — set when the sheet has its
  // own Day Store column (e.g. the app's downloaded report format).
  // Falls back to whatever's picked in the toolbar dropdown when absent,
  // so a single-store sheet (no Day Store column) still works as before.
  dayStoreName?: string;
}

export interface ParsedInventoryImport {
  rows: ImportInventoryRow[];
  skipped: number; // rows dropped for missing a required field
  // Diagnostics only, for when rows.length is 0 and it's not obvious
  // why — the exact column headers this workbook actually has, so a
  // header mismatch (typo, extra space, wrong sheet) is visible instead
  // of a bare "no usable rows" message.
  sheetNames: string[];
  detectedHeaders: string[];
}

/**
 * One row per material entry, all sheets in the workbook combined — the
 * transaction `type` (Received / Issued to Day Store / Issued to
 * Production) isn't a column; it's picked once for the whole upload, same
 * as which tab you'd log entries into by hand.
 */
export function parseInventoryTransactionWorkbook(buffer: ArrayBuffer, defaultCategory: "RM" | "PM"): ParsedInventoryImport {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const rows: ImportInventoryRow[] = [];
  const detectedHeaders = new Set<string>();
  let skipped = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, { defval: "" });
    for (const row of sheetRows) {
      for (const key of Object.keys(row)) detectedHeaders.add(key);
      const itemName = asText(row, ITEM_COLUMNS);
      const dateRaw = firstNonEmpty(row, DATE_COLUMNS);
      const unit = asText(row, UNIT_COLUMNS);
      const quantityRaw = firstNonEmpty(row, QUANTITY_COLUMNS);
      const date = parseDate(dateRaw);
      const quantity = quantityRaw === undefined ? NaN : Number(quantityRaw);

      if (!itemName || !date || !unit || !Number.isFinite(quantity) || quantity <= 0) {
        skipped += 1;
        continue;
      }

      const category = normalizeCategory(asText(row, CATEGORY_COLUMNS), defaultCategory);

      const mfgDateRaw = firstNonEmpty(row, MFG_DATE_COLUMNS);
      const expiryDateRaw = firstNonEmpty(row, EXPIRY_DATE_COLUMNS);

      rows.push({
        category,
        itemName,
        date,
        unit,
        quantity,
        size: asText(row, SIZE_COLUMNS),
        vendorName: asText(row, VENDOR_COLUMNS),
        batchNo: asText(row, BATCH_COLUMNS),
        grnNo: asText(row, GRN_COLUMNS),
        mfgDate: mfgDateRaw !== undefined ? parseDate(mfgDateRaw) : undefined,
        expiryDate: expiryDateRaw !== undefined ? parseDate(expiryDateRaw) : undefined,
        remark: asText(row, REMARK_COLUMNS),
        dayStoreName: asText(row, DAY_STORE_COLUMNS),
      });
    }
  }

  return { rows, skipped, sheetNames: workbook.SheetNames, detectedHeaders: [...detectedHeaders] };
}

// --- Material Requests (indents) bulk import — a different sheet shape
// than the transaction log: no Date/Unit/Vendor, but Purpose is a
// per-row column since a real indent sheet mixes Production and Day
// Store lines rather than being all one type. ---

const REQUESTED_QTY_COLUMNS = ["Requested Qty", "Qty", "Quantity", "Count"];
const PURPOSE_COLUMNS = ["Purpose", "For", "Issue Type"];
const NEEDED_BY_COLUMNS = ["Needed By", "Required By"];
const NOTE_COLUMNS = ["Note", "Remarks"];

function parsePurpose(value: unknown): "ISSUED_PRODUCTION" | "ISSUED_DAY_STORE" {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  // Matches "Store", "Day Store", "day_store" — every label this column
  // has ever used, old exports and the current "Issued to Store" wording
  // alike, all containing "store" as a substring. "Issued to Production"
  // never does, so this stays unambiguous.
  if (text.includes("store")) return "ISSUED_DAY_STORE";
  return "ISSUED_PRODUCTION"; // default — the common case, and what a blank/unrecognized cell means
}

export interface ImportInventoryRequestRow {
  category: "RM" | "PM";
  itemName: string;
  requestedQty: number;
  purpose: "ISSUED_PRODUCTION" | "ISSUED_DAY_STORE";
  neededBy?: string;
  note?: string;
}

export interface ParsedInventoryRequestImport {
  rows: ImportInventoryRequestRow[];
  skipped: number;
  sheetNames: string[];
  detectedHeaders: string[];
}

export function parseInventoryRequestWorkbook(buffer: ArrayBuffer, defaultCategory: "RM" | "PM"): ParsedInventoryRequestImport {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const rows: ImportInventoryRequestRow[] = [];
  const detectedHeaders = new Set<string>();
  let skipped = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, { defval: "" });
    for (const row of sheetRows) {
      for (const key of Object.keys(row)) detectedHeaders.add(key);
      const itemName = asText(row, ITEM_COLUMNS);
      const quantityRaw = firstNonEmpty(row, REQUESTED_QTY_COLUMNS);
      const quantity = quantityRaw === undefined ? NaN : Number(quantityRaw);

      if (!itemName || !Number.isFinite(quantity) || quantity <= 0) {
        skipped += 1;
        continue;
      }

      const category = normalizeCategory(asText(row, CATEGORY_COLUMNS), defaultCategory);
      const neededByRaw = firstNonEmpty(row, NEEDED_BY_COLUMNS);

      rows.push({
        category,
        itemName,
        requestedQty: quantity,
        purpose: parsePurpose(firstNonEmpty(row, PURPOSE_COLUMNS)),
        neededBy: neededByRaw !== undefined ? parseDate(neededByRaw) : undefined,
        note: asText(row, NOTE_COLUMNS),
      });
    }
  }

  return { rows, skipped, sheetNames: workbook.SheetNames, detectedHeaders: [...detectedHeaders] };
}

// --- Pre-Inventory requirement bulk import (S1) — one row per RM/PM
// requirement, same resolve-or-create-item pattern as the transaction
// log's import. Required Qty is a distinct column from the transaction
// log's "Count" (a requirement isn't a delivery), but the header names
// people actually type overlap, so it's matched loosely too. ---

const REQUIRED_QTY_COLUMNS = ["Required Qty", "Requirement", "Qty", "Quantity", "Count"];

export interface ImportRequirementRow {
  date: string;
  category: "RM" | "PM";
  itemName: string;
  unit: string;
  requiredQty: number;
  size?: string;
  note?: string;
}

export interface ParsedRequirementImport {
  rows: ImportRequirementRow[];
  skipped: number;
  sheetNames: string[];
  detectedHeaders: string[];
}

export function parseRequirementWorkbook(buffer: ArrayBuffer, defaultCategory: "RM" | "PM"): ParsedRequirementImport {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const rows: ImportRequirementRow[] = [];
  const detectedHeaders = new Set<string>();
  let skipped = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, { defval: "" });
    for (const row of sheetRows) {
      for (const key of Object.keys(row)) detectedHeaders.add(key);
      const itemName = asText(row, ITEM_COLUMNS);
      const dateRaw = firstNonEmpty(row, DATE_COLUMNS);
      const unit = asText(row, UNIT_COLUMNS);
      const quantityRaw = firstNonEmpty(row, REQUIRED_QTY_COLUMNS);
      const date = parseDate(dateRaw);
      const requiredQty = quantityRaw === undefined ? NaN : Number(quantityRaw);

      if (!itemName || !date || !unit || !Number.isFinite(requiredQty) || requiredQty <= 0) {
        skipped += 1;
        continue;
      }

      const category = normalizeCategory(asText(row, CATEGORY_COLUMNS), defaultCategory);

      rows.push({ date, category, itemName, unit, requiredQty, size: asText(row, SIZE_COLUMNS), note: asText(row, NOTE_COLUMNS) });
    }
  }

  return { rows, skipped, sheetNames: workbook.SheetNames, detectedHeaders: [...detectedHeaders] };
}

// Pre-Inventory's S2 ("what's already available") is no longer a
// manual Warehouse entry — it's read live off the real stock ledger
// (see pre-inventory.routes.ts) — so there's no availability import to
// parse any more.

// --- Pre-Inventory PO log bulk import (S3) — one row per PO, matched
// server-side to an existing, still-open requirement by item name +
// category. No Date/Unit column here (a PO isn't a delivery), but PO
// Number / Vendor / ETA are all required, same as the single Log PO form. ---

const PO_NUMBER_COLUMNS = ["PO Number", "PO No", "PO"];
const ETA_COLUMNS = ["ETA", "Expected Date", "Delivery Date"];

export interface ImportPurchaseLogRow {
  itemName: string;
  category: "RM" | "PM";
  poNumber: string;
  vendorName: string;
  eta: string;
}

export interface ParsedPurchaseLogImport {
  rows: ImportPurchaseLogRow[];
  skipped: number;
  sheetNames: string[];
  detectedHeaders: string[];
}

export function parsePurchaseLogWorkbook(buffer: ArrayBuffer, defaultCategory: "RM" | "PM"): ParsedPurchaseLogImport {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const rows: ImportPurchaseLogRow[] = [];
  const detectedHeaders = new Set<string>();
  let skipped = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, { defval: "" });
    for (const row of sheetRows) {
      for (const key of Object.keys(row)) detectedHeaders.add(key);
      const itemName = asText(row, ITEM_COLUMNS);
      const poNumber = asText(row, PO_NUMBER_COLUMNS);
      const vendorName = asText(row, VENDOR_COLUMNS);
      const etaRaw = firstNonEmpty(row, ETA_COLUMNS);
      const eta = parseDate(etaRaw);

      if (!itemName || !poNumber || !vendorName || !eta) {
        skipped += 1;
        continue;
      }

      const category = normalizeCategory(asText(row, CATEGORY_COLUMNS), defaultCategory);

      rows.push({ itemName, category, poNumber, vendorName, eta });
    }
  }

  return { rows, skipped, sheetNames: workbook.SheetNames, detectedHeaders: [...detectedHeaders] };
}

// --- Dispatch Transfers (FG / Bill) bulk import — customers are
// matched by exact name against the existing directory, never created
// (customer creation is BD-only, enforced server-side); a row whose
// customer doesn't match is included in the payload anyway and the API
// reports back which names it couldn't match, since only the server
// knows the current customer directory. ---

const CUSTOMER_COLUMNS = ["Customer", "Customer Name", "Company"];
const PRODUCT_NAME_COLUMNS = ["Product Name", "Product", "Item"];

export interface ImportDispatchTransferRow {
  customerName: string;
  date: string;
  productName: string;
  quantity: number;
}

export interface ParsedDispatchTransferImport {
  rows: ImportDispatchTransferRow[];
  skipped: number;
  sheetNames: string[];
  detectedHeaders: string[];
}

export function parseDispatchTransferWorkbook(buffer: ArrayBuffer): ParsedDispatchTransferImport {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const rows: ImportDispatchTransferRow[] = [];
  const detectedHeaders = new Set<string>();
  let skipped = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, { defval: "" });
    for (const row of sheetRows) {
      for (const key of Object.keys(row)) detectedHeaders.add(key);
      const customerName = asText(row, CUSTOMER_COLUMNS);
      const productName = asText(row, PRODUCT_NAME_COLUMNS);
      const dateRaw = firstNonEmpty(row, DATE_COLUMNS);
      const date = parseDate(dateRaw);
      const quantityRaw = firstNonEmpty(row, QUANTITY_COLUMNS);
      const quantity = quantityRaw === undefined ? NaN : Number(quantityRaw);

      if (!customerName || !productName || !date || !Number.isFinite(quantity) || quantity <= 0) {
        skipped += 1;
        continue;
      }

      rows.push({ customerName, date, productName, quantity });
    }
  }

  return { rows, skipped, sheetNames: workbook.SheetNames, detectedHeaders: [...detectedHeaders] };
}
