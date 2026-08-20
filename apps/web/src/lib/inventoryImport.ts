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
const VENDOR_COLUMNS = ["Vendor Name", "Vendor", "Supplier"];

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

      const categoryText = asText(row, CATEGORY_COLUMNS)?.toUpperCase();
      const category: "RM" | "PM" = categoryText === "RM" || categoryText === "PM" ? categoryText : defaultCategory;

      rows.push({
        category,
        itemName,
        date,
        unit,
        quantity,
        size: asText(row, SIZE_COLUMNS),
        vendorName: asText(row, VENDOR_COLUMNS),
      });
    }
  }

  return { rows, skipped, sheetNames: workbook.SheetNames, detectedHeaders: [...detectedHeaders] };
}
