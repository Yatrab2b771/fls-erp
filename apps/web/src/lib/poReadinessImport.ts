import * as XLSX from "xlsx";
import type { PoReadinessRow } from "./types";

// Column headers matched loosely (case/spacing variations), same porting
// approach as inventoryImport.ts — PPIC's team fills this from their own
// planning sheet, not a form this app controls the exact header text of.
const PO_NUMBER_COLUMNS = ["PO Number", "PO No", "PO No.", "PO"];
const CATEGORY_COLUMNS = ["Category", "RM/PM", "Type"];
const ITEM_COLUMNS = ["Item", "Item Name", "Material", "Material Name"];
const QTY_COLUMNS = ["Required Qty", "Requirement", "Qty", "Quantity"];
const UNIT_COLUMNS = ["Unit"];

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

function normalizeCategory(text: string | undefined): "RM" | "PM" | undefined {
  const t = text?.trim().toUpperCase();
  if (t === "RM" || t === "RAW MATERIAL" || t === "RAW") return "RM";
  if (t === "PM" || t === "PACKAGING MATERIAL" || t === "PACKING MATERIAL" || t === "PACKAGING" || t === "PACKING") return "PM";
  return undefined;
}

export interface ImportPoRequirementRow {
  poNumber: string;
  category: "RM" | "PM";
  itemName: string;
  requiredQty: number;
  unit: string;
}

export interface ParsedPoRequirementImport {
  rows: ImportPoRequirementRow[];
  skipped: number;
  sheetNames: string[];
  detectedHeaders: string[];
}

/**
 * One row per (PO, RM/PM item) pair, every sheet in the workbook
 * combined — a real sheet from PPIC's planning team lists 20-40 rows per
 * PO, hundreds of POs at once. Unlike every other import in this app,
 * category isn't defaulted when missing (a wrong RM/PM guess here would
 * silently check the wrong item's stock) — a row with no recognizable
 * category is skipped, same as a row missing anything else required.
 */
export function parsePoRequirementWorkbook(buffer: ArrayBuffer): ParsedPoRequirementImport {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const rows: ImportPoRequirementRow[] = [];
  const detectedHeaders = new Set<string>();
  let skipped = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, { defval: "" });
    for (const row of sheetRows) {
      for (const key of Object.keys(row)) detectedHeaders.add(key);

      const poNumber = asText(row, PO_NUMBER_COLUMNS);
      const category = normalizeCategory(asText(row, CATEGORY_COLUMNS));
      const itemName = asText(row, ITEM_COLUMNS);
      const unit = asText(row, UNIT_COLUMNS);
      const qtyRaw = firstNonEmpty(row, QTY_COLUMNS);
      const requiredQty = qtyRaw === undefined ? NaN : Number(qtyRaw);

      if (!poNumber || !category || !itemName || !unit || !Number.isFinite(requiredQty) || requiredQty <= 0) {
        skipped += 1;
        continue;
      }

      rows.push({ poNumber, category, itemName, requiredQty, unit });
    }
  }

  return { rows, skipped, sheetNames: workbook.SheetNames, detectedHeaders: [...detectedHeaders] };
}

const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };

// One row per (PO, item) — not just one row per PO — so the download is
// exactly the elaborate list PPIC used to check by hand: every PO, every
// required item, whether it's covered, and by how much. Grouping/
// filtering by PO Number or Status in Excel gets back the summary view
// for free, without losing the detail a pure PO-level export would.
export function exportPoReadinessReport(rows: PoReadinessRow[]) {
  const sheetRows = rows.flatMap((r) =>
    r.items.map((it) => ({
      "PO Number": r.purchaseOrder.poNumber ?? r.purchaseOrder.id.slice(0, 8),
      Customer: r.purchaseOrder.customer.companyName,
      "PO Status": r.isReady ? "Ready to Execute" : "Short",
      Item: it.itemName,
      Category: CATEGORY_LABEL[it.category] ?? it.category,
      "Required Qty": it.requiredQty,
      "On Hand": it.onHand,
      Unit: it.unit,
      Covered: it.covered ? "Yes" : "No",
    })),
  );
  const sheet = XLSX.utils.json_to_sheet(sheetRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "PO Readiness");
  XLSX.writeFile(workbook, `FLS_PO_Readiness_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export function downloadPoRequirementImportTemplate() {
  const sheet = XLSX.utils.json_to_sheet([
    { "PO Number": "PO-2026-0451", Category: "RM", Item: "Whey Protein Concentrate", "Required Qty": 60, Unit: "Kg" },
    { "PO Number": "PO-2026-0451", Category: "PM", Item: "1Kg Jar", "Required Qty": 500, Unit: "Count" },
    { "PO Number": "PO-2026-0452", Category: "RM", Item: "Creatine Monohydrate", "Required Qty": 20, Unit: "Kg" },
    { "PO Number": "", Category: "", Item: "", "Required Qty": "", Unit: "" },
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "PO Requirements");
  XLSX.writeFile(workbook, "FLS_PO_Requirement_Template.xlsx");
}
