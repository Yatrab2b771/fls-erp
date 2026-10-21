import * as XLSX from "xlsx";

// Reads the company's own BOM sheets (RM BOM per Kg, RM BOM per gummy, PM BOM per pack, gummies packing BOM).
// Each sheet is recognised from the headings of its table, then the header block above the table (product
// name, code, pack size, batch size ...) and every row are read. Nothing is saved here - the caller shows a
// preview first.

export type BomSheetKind = "RM_KG" | "RM_UNIT" | "PM_PACK" | "PM_LEVEL";

export const BOM_SHEET_LABEL: Record<BomSheetKind, string> = {
  RM_KG: "RM BOM per Kg (powder, bar)",
  RM_UNIT: "RM BOM per gummy (milligrams)",
  PM_PACK: "Packaging BOM per pack",
  PM_LEVEL: "Packing BOM with packing levels",
};

export interface ParsedPmRow {
  level: "Primary" | "Secondary" | "Tertiary" | "";
  code: string;
  name: string;
  spec: string;
  make: string;
  uom: string;
  /** Quantity per pack. For a box / carton row: how many packs go in one box (the app's box rule). */
  qty: number;
  /** Overage as a fraction, 0.02 = 2%; null when the sheet says Nil. */
  overage: number | null;
}

export interface ParsedPmProduct {
  sheet: string;
  kind: "PM_PACK" | "PM_LEVEL";
  productName: string;
  productCode: string;
  packSize: string;
  packingConfig: string;
  batchPacks: number | null;
  rows: ParsedPmRow[];
}

export interface ParsedRmRow {
  code: string;
  name: string;
  make: string;
  uom: string;
  qty: number;
}

export interface ParsedRmRecipe {
  sheet: string;
  kind: "RM_KG" | "RM_UNIT";
  productName: string;
  productCode: string;
  versionLabel: string;
  /** Kg for RM_KG, number of gummies for RM_UNIT. */
  batchSize: number | null;
  avgUnitWeightMg: number | null;
  rows: ParsedRmRow[];
}

export interface ParsedBomWorkbook {
  pm: ParsedPmProduct[];
  rm: ParsedRmRecipe[];
  skippedSheets: string[];
}

type Cell = unknown;
type Grid = Cell[][];

const text = (v: Cell): string => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const num = (v: Cell): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
};

// Cell text after a label such as "Product Name:" - from the same cell, else the next filled cell on the right.
function valueAfter(row: Cell[], idx: number, labelRe: RegExp): string {
  const own = text(row[idx]).replace(labelRe, "").replace(/^[\s:\-.]+/, "").trim();
  if (own) return own;
  for (let j = idx + 1; j < row.length; j++) {
    const t = text(row[j]);
    if (t) return t;
  }
  return "";
}

function findHeaderRow(grid: Grid): number {
  for (let i = 0; i < Math.min(40, grid.length); i++) {
    const joined = grid[i]!.map((c) => text(c).toLowerCase()).join("|");
    if (/ingr[a-z]*nt|ingredient|packaging material|pm material/.test(joined) && /qty|quantity/.test(joined)) return i;
  }
  return -1;
}

function detectKind(headers: string[]): BomSheetKind {
  const j = headers.join("|");
  if (/packing level/.test(j)) return "PM_LEVEL";
  if (/ov\s*%/.test(j) || /qty\.?\s*\/\s*pack/.test(j)) return "PM_PACK";
  if (/qty\.?\s*\/\s*(gummy|gummies|unit|cap|tab|piece|pc)/.test(j)) return "RM_UNIT";
  return "RM_KG";
}

function colIndex(headers: string[], re: RegExp, from = 0): number {
  for (let i = from; i < headers.length; i++) if (re.test(headers[i]!)) return i;
  return -1;
}

const BOX_LIKE = /box|carton|shipper/i;

function readOverage(v: Cell): number | null {
  const n = num(v);
  if (n == null) return null; // "Nil" or blank
  if (n <= 0) return null;
  return n > 1 ? n / 100 : n;
}

function mostCommon(values: number[]): number | null {
  if (!values.length) return null;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
}

interface Header {
  productName: string;
  productCode: string;
  trial: string;
  packSize: string;
  packingConfig: string;
  batchNumber: number | null;
  batchKgAndUnits: { kg: number; units: number } | null;
  avgWeightMg: number | null;
}

function readHeader(grid: Grid, upTo: number): Header {
  const h: Header = { productName: "", productCode: "", trial: "", packSize: "", packingConfig: "", batchNumber: null, batchKgAndUnits: null, avgWeightMg: null };
  for (let i = 0; i < upTo; i++) {
    const row = grid[i] ?? [];
    for (let c = 0; c < row.length; c++) {
      const t = text(row[c]);
      if (!t) continue;
      let m: RegExpMatchArray | null;
      if ((m = t.match(/^(?:product|procuct)\s*name\b/i))) h.productName ||= valueAfter(row, c, /^(?:product|procuct)\s*name/i);
      else if (/^product\s*code\b/i.test(t)) h.productCode ||= valueAfter(row, c, /^product\s*code/i);
      else if ((m = t.match(/trial\s*no\.?\s*[:\-]?\s*(.*)$/i))) h.trial ||= m[1]!.trim();
      else if (/^pack\s*size\b/i.test(t)) h.packSize ||= valueAfter(row, c, /^pack\s*size/i);
      else if (/^packing\s*c[a-z]*/i.test(t)) h.packingConfig ||= valueAfter(row, c, /^packing\s*c[a-z]*/i);
      else if (/batch\s*size/i.test(t) && !/finished/i.test(t)) {
        const own = t.match(/(\d+(?:\.\d+)?)\s*kg\s*\/\s*(\d+)/i);
        if (own) h.batchKgAndUnits = { kg: Number(own[1]), units: Number(own[2]) };
        // The number sits in a cell to the right of the label (J7 = 503 Kg, J7 = 1000 Nos ...).
        for (let j = c + 1; j < row.length; j++) {
          const n = num(row[j]);
          if (n != null && n > 0) { h.batchNumber ??= n; break; }
          const pair = text(row[j]).match(/(\d+(?:\.\d+)?)\s*kg\s*\/\s*(\d+)/i);
          if (pair) { h.batchKgAndUnits = { kg: Number(pair[1]), units: Number(pair[2]) }; break; }
        }
      } else if (/avg\.?\s*w/i.test(t)) {
        for (let j = c + 1; j < row.length; j++) {
          const n = num(row[j]);
          if (n != null && n > 0) { h.avgWeightMg = n; break; }
        }
      }
    }
  }
  return h;
}

export function parseBomWorkbook(buffer: ArrayBuffer): ParsedBomWorkbook {
  const wb = XLSX.read(buffer, { type: "array" });
  const out: ParsedBomWorkbook = { pm: [], rm: [], skippedSheets: [] };

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName]!;
    const grid = XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, defval: "", blankrows: true });
    const hr = findHeaderRow(grid);
    if (hr < 0) { out.skippedSheets.push(sheetName); continue; }
    const headers = (grid[hr] ?? []).map((c) => text(c).toLowerCase());
    const kind = detectKind(headers);
    const head = readHeader(grid, hr);
    // The average gummy weight sits below the table, so look for it on the whole sheet.
    if (head.avgWeightMg == null) head.avgWeightMg = readHeader(grid, grid.length).avgWeightMg;

    const codeC = colIndex(headers, /item code|material code/);
    const nameC = colIndex(headers, /ingr[a-z]*nt|ingredient|packaging material|pm material/);
    const makeC = colIndex(headers, /^make/);
    const uomC = colIndex(headers, /^uom/);
    const ovC = colIndex(headers, /ov\s*%|wastage/);
    const specC = colIndex(headers, /specification/);
    const levelC = colIndex(headers, /packing level/);
    const batchQtyC = colIndex(headers, /^batch qty/);
    const qtyC =
      kind === "RM_KG" ? colIndex(headers, /qty\.?\s*\/?\s*kg/)
      : kind === "RM_UNIT" ? colIndex(headers, /qty\.?\s*\/\s*\w+/)
      : kind === "PM_PACK" ? colIndex(headers, /qty\.?\s*\/\s*pack/)
      : colIndex(headers, /std\.?\s*qty/);
    if (nameC < 0 || qtyC < 0) { out.skippedSheets.push(sheetName); continue; }

    // Data rows run until the serial-number column stops being a number (Total, Requisition Raised By, blank ...).
    const serialC = 0;
    interface Raw { level: string; code: string; name: string; spec: string; make: string; uom: string; qty: number; ov: number | null; batchQty: number | null }
    const raw: Raw[] = [];
    for (let i = hr + 1; i < grid.length; i++) {
      const row = grid[i] ?? [];
      if (num(row[serialC]) == null) { if (raw.length) break; else continue; }
      const name = text(row[nameC]);
      const qty = num(row[qtyC]);
      if (!name || qty == null || !(qty > 0)) continue;
      raw.push({
        level: levelC >= 0 ? text(row[levelC]) : "",
        code: codeC >= 0 ? text(row[codeC]) : "",
        name,
        spec: specC >= 0 ? text(row[specC]) : "",
        make: makeC >= 0 ? text(row[makeC]) : "",
        uom: uomC >= 0 ? text(row[uomC]) : "",
        qty,
        ov: ovC >= 0 ? readOverage(row[ovC]) : null,
        batchQty: batchQtyC >= 0 ? num(row[batchQtyC]) : null,
      });
    }
    if (!raw.length) { out.skippedSheets.push(sheetName); continue; }

    if (kind === "RM_KG" || kind === "RM_UNIT") {
      const unit = kind === "RM_UNIT";
      out.rm.push({
        sheet: sheetName,
        kind,
        productName: head.productName || sheetName,
        productCode: head.productCode,
        versionLabel: head.trial,
        batchSize: unit ? head.batchKgAndUnits?.units ?? head.batchNumber : head.batchNumber ?? head.batchKgAndUnits?.kg ?? null,
        avgUnitWeightMg: head.avgWeightMg,
        rows: raw.map((r) => ({ code: r.code, name: r.name, make: r.make, uom: r.uom || (unit ? "mg" : "Kg"), qty: r.qty })),
      });
      continue;
    }

    // Packaging. The number of packs in a batch is on the sheet (PM BOM) or worked out from the batch quantity column.
    let packs = kind === "PM_PACK" ? head.batchNumber : null;
    if (kind === "PM_LEVEL") packs = mostCommon(raw.filter((r) => r.qty === 1 && /secondary/i.test(r.level) && r.batchQty).map((r) => r.batchQty!));
    const rows: ParsedPmRow[] = raw.map((r) => {
      const level = /^primary/i.test(r.level) ? "Primary" : /^secondary/i.test(r.level) ? "Secondary" : /^tertiary/i.test(r.level) ? "Tertiary" : "";
      let qty = r.qty;
      if (kind === "PM_PACK" && BOX_LIKE.test(r.name) && qty < 1) qty = Math.round(1 / qty);
      if (kind === "PM_LEVEL" && level === "Tertiary" && packs && r.batchQty && r.batchQty < packs) {
        qty = BOX_LIKE.test(r.name) ? Math.round(packs / r.batchQty) : r.batchQty / packs;
      }
      return { level, code: r.code, name: r.name, spec: r.spec, make: r.make, uom: r.uom || "Nos", qty, overage: r.ov };
    });
    const pack = head.packSize;
    const base = head.productName || sheetName;
    out.pm.push({
      sheet: sheetName,
      kind,
      productName: pack && !base.toLowerCase().includes(pack.toLowerCase()) ? `${base} ${pack}` : base,
      productCode: head.productCode,
      packSize: pack,
      packingConfig: head.packingConfig,
      batchPacks: packs && Number.isInteger(packs) ? packs : packs ? Math.round(packs) : null,
      rows,
    });
  }
  return out;
}

export function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// A ready-to-fill sample of each sheet type, in the same layout the company's own BOM sheets use, so the
// upload above can read it straight back. R&D downloads it, replaces the example rows and uploads it.
export function downloadBomSample(kind: BomSheetKind) {
  const company = ["FERMENTIS LIFE SCIENCES PVT. LTD."];
  let rows: unknown[][];
  let sheetName: string;
  let fileName: string;
  if (kind === "RM_KG") {
    sheetName = "RM BOM";
    fileName = "FLS_Sample_RM_BOM_per_Kg.xlsx";
    rows = [
      company,
      ["BILL OF MATERIAL (RM)"],
      ["Product Name: Example Protein Powder", "", "", "", "Product Code: FGC0000"],
      ["Trial No.: TRIAL-001"],
      ["Batch Size:", 100, "Kg"],
      [],
      ["S. No.", "Item Code", "Ingredients", "Make", "UOM", "Qty./Kg"],
      [1, "RM00001", "Whey Protein Concentrate", "Approved Vendor", "Kg", 0.8],
      [2, "RM00002", "Cocoa Powder", "Approved Vendor", "Kg", 0.15],
      [3, "", "Sweetener (item code not known yet)", "Approved Vendor", "Kg", 0.05],
      ["Total", "", "", "", "Kg", 1],
      [],
      ["Notes: one sheet = one product. Qty./Kg is how much goes into 1 Kg of finished product, so the rows add up to 1. Item Code may be left blank; it can be linked on the page."],
    ];
  } else if (kind === "RM_UNIT") {
    sheetName = "RM BOM gummies";
    fileName = "FLS_Sample_RM_BOM_per_Gummy.xlsx";
    rows = [
      company,
      ["BILL OF MATERIAL (RM)"],
      ["Product Name - Example Gummies"],
      ["Batch Size", "30KG/7500", "NOS"],
      [],
      ["S. No.", "Item Code", "Ingredients", "Make", "Qty./Gummy", "UOM", "Quantity Required/Batch", "UOM"],
      [1, "", "Pectin", "Approved Vendor", 120, "mg", 900, "g"],
      [2, "", "Citric Acid", "Approved Vendor", 32, "mg", 240, "g"],
      [3, "", "Vitamin C", "Approved Vendor", 37.5, "mg", 281.25, "g"],
      [],
      ["", "", "AVG WT GUMMIES-", "", 3491.7, "mg"],
      [],
      ["Notes: Qty./Gummy is in milligrams for one gummy. Batch Size is written as Kg/number of gummies (30KG/7500). Item Code may be left blank."],
    ];
  } else if (kind === "PM_PACK") {
    sheetName = "Example 120 g";
    fileName = "FLS_Sample_PM_BOM_per_Pack.xlsx";
    rows = [
      company,
      ["BILL OF MATERIAL (PM)"],
      ["Product Name: Example Protein Powder", "", "", "", "Product Code:"],
      ["Batch Size:", 1000, "Nos"],
      ["Pack Size: 120 g", "", "", "", "Packing Configuration: 1*64 Jars"],
      [],
      ["S. No.", "Item Code", "Ingredients", "Make", "UOM", "OV%", "Qty./ Pack"],
      [1, "PM00001", "Jar", "", "Nos.", "Nil", 1],
      [2, "PM00002", "Wad", "", "Nos.", "Nil", 1],
      [3, "", "Cap sticker", "", "Nos.", 0.02, 1],
      [4, "", "Corrugated Box", "", "Nos.", "Nil", 0.0156],
      [],
      ["Notes: one sheet per pack size. OV% is the extra to keep (0.02 = 2%, Nil = none). Qty./ Pack is what one pack needs; a box is a fraction (0.0156 = 1 box for 64 packs). Make a copy of this sheet for each pack size."],
    ];
  } else {
    sheetName = "Packing BOM";
    fileName = "FLS_Sample_Packing_BOM_with_Levels.xlsx";
    rows = [
      company,
      ["BILL OF MATERIAL (PM)"],
      ["", "", "", "Product Name", "Example Gummies", "", "Pack Size", "60 Gummies"],
      [],
      ["Sr. No.", "Packing Level", "Material Code", "Packaging Material", "Specification / Size", "UOM", "Std. Qty / FG Unit", "Wastage %", "Net Qty / FG Unit", "Batch Qty"],
      [1, "Primary", "PM-001", "Laminate", "55mm*80mm", "Nos", 1, 0.04, "", 120000],
      [2, "Secondary", "PM-002", "Jar", "60 Gummies / 650ml", "Nos", 1, 0.02, "", 2000],
      [3, "Secondary", "PM-003", "Label", "Approved artwork", "Nos", 1, 0.03, "", 2000],
      [4, "Tertiary", "PM-004", "Shipper Carton", "5 Ply", "Nos", 1, 0.01, "", 70],
      [],
      ["Notes: Packing Level is Primary, Secondary or Tertiary. Wastage % is a fraction (0.02 = 2%). Batch Qty lets the page work out how many packs are in the batch and how many go in a box."],
    ];
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 8 }, { wch: 16 }, { wch: 32 }, { wch: 22 }, { wch: 22 }, { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 16 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, fileName);
}
