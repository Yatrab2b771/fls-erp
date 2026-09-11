import * as XLSX from "xlsx";
import { PRE_PRODUCTION_STAGE_FIELDS, PRE_PRODUCTION_STAGE_LABEL, PRE_PRODUCTION_STAGE_ORDER } from "./preProductionStage";
import { COMBINED_LOT_STAGE_FIELDS, COMBINED_LOT_STAGE_LABEL, COMBINED_LOT_STAGE_ORDER } from "./combinedLotStage";

// --- Bulk "forward the current stage" import — one row per (PO Number,
// Product Name) pair, touching only whatever stage that item's run is
// currently sitting at (the same single-step action the manual Forward
// button already performs). PreProduction and CombinedLot are both 1:1
// with a PO item now, so — unlike the old per-Batch version of this — no
// Batch No. column is needed to disambiguate. Column list is built from
// both tiers' field maps so it can never drift from the real field set —
// every stage's fields as columns, a row only needs the ones for its
// *current* stage, the rest stay blank. RM/PM consumption lines and
// Indent Issue's request lines are array-shaped and don't fit a flat
// row — out of scope here, same as the header-building loop below only
// ever sees flat FieldDef entries. ---

const PO_NUMBER_COLUMNS = ["PO Number", "PO No", "PO No."];
const PRODUCT_NAME_COLUMNS = ["Product Name", "Product"];
const NOTE_COLUMNS = ["Note", "Notes", "Remark", "Remarks"];

// Every stage's fields across both tiers, deduped by field name.
const STAGE_FIELD_ENTRIES = (() => {
  const seen = new Map<string, { name: string; label: string }>();
  for (const stage of PRE_PRODUCTION_STAGE_ORDER) {
    for (const field of PRE_PRODUCTION_STAGE_FIELDS[stage] ?? []) {
      if (!seen.has(field.name)) seen.set(field.name, { name: field.name, label: field.label });
    }
  }
  for (const stage of COMBINED_LOT_STAGE_ORDER) {
    for (const field of COMBINED_LOT_STAGE_FIELDS[stage] ?? []) {
      if (!seen.has(field.name)) seen.set(field.name, { name: field.name, label: field.label });
    }
  }
  return [...seen.values()];
})();

export interface BatchImportRow {
  poNumber: string;
  productName: string;
  note?: string;
  fields: Record<string, unknown>;
}

export interface ParsedBatchImport {
  rows: BatchImportRow[];
  skipped: number;
  sheetNames: string[];
  detectedHeaders: string[];
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

export function parseBatchStageWorkbook(buffer: ArrayBuffer): ParsedBatchImport {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const rows: BatchImportRow[] = [];
  const detectedHeaders = new Set<string>();
  let skipped = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, { defval: "" });
    for (const row of sheetRows) {
      for (const key of Object.keys(row)) detectedHeaders.add(key);

      const poNumber = asText(row, PO_NUMBER_COLUMNS);
      const productName = asText(row, PRODUCT_NAME_COLUMNS);
      if (!poNumber || !productName) {
        skipped += 1;
        continue;
      }
      const note = asText(row, NOTE_COLUMNS);

      // Only columns a recognized stage field's label actually matched
      // make it into `fields` — an unrelated/extra column in the sheet
      // is ignored, not an error, so the one wide template tolerates
      // reordering and columns the user doesn't happen to need this time.
      const fields: Record<string, unknown> = {};
      for (const { name, label } of STAGE_FIELD_ENTRIES) {
        const v = firstNonEmpty(row, [label]);
        if (v !== undefined) fields[name] = v;
      }

      rows.push({ poNumber, productName, note, fields });
    }
  }

  return { rows, skipped, sheetNames: workbook.SheetNames, detectedHeaders: [...detectedHeaders] };
}

export function downloadBatchStageImportTemplate() {
  const headers = ["PO Number", "Product Name", "Note", ...STAGE_FIELD_ENTRIES.map((f) => f.label)];
  const blankRow = Object.fromEntries(headers.map((h) => [h, ""]));
  const sampleRows = [
    { ...blankRow, "PO Number": "PO-2026-0451", "Product Name": "Whey Protein 1Kg Jar", "GRN No.": "GRN-9001", "GRN Date": "2026-08-01" },
    { ...blankRow, "PO Number": "PO-2026-0452", "Product Name": "Creatine Monohydrate 500g", "Packaging Status": "Filling" },
    blankRow,
  ];
  const sheet = XLSX.utils.json_to_sheet(sampleRows, { header: headers });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Batch Updates");

  // A short guidance sheet — the template alone (40+ columns) doesn't
  // explain the "only your run's current stage matters" rule on its own,
  // and this is the one bulk import in the app where getting that wrong
  // (filling in a stage the run isn't actually at) just means those
  // columns are silently ignored, not an error.
  const guide = XLSX.utils.aoa_to_sheet([
    ["How this import works"],
    ["One row = one PO line item's production run. PO Number + Product Name find it — no Batch No. needed, there's one run per item."],
    ["Only fill in the columns for whatever stage that run is CURRENTLY at — everything else is ignored, not an error."],
    ["Each row forwards that run by exactly one stage, same as clicking Forward on its own page."],
    ["Stage owner (department) still applies — you can only forward stages your own role is allowed to act on."],
    [`Pre-production stages, in order: ${PRE_PRODUCTION_STAGE_ORDER.map((s) => PRE_PRODUCTION_STAGE_LABEL[s]).join(" → ")}`],
    [`Once combined into a lot, combined-lot stages, in order: ${COMBINED_LOT_STAGE_ORDER.map((s) => COMBINED_LOT_STAGE_LABEL[s]).join(" → ")}`],
  ]);
  XLSX.utils.book_append_sheet(workbook, guide, "Read Me");

  XLSX.writeFile(workbook, "FLS_Batch_Update_Template.xlsx");
}
