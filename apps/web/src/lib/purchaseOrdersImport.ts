import * as XLSX from "xlsx";

// Column headers matched loosely (case/spacing variations), same porting
// approach as every other bulk import in this app — BD's own PO system
// export won't use this app's exact header text, so match by intent, not
// literal string.
const PO_NUMBER_COLUMNS = ["PO Number", "PO No", "PO No.", "PO"];
const CUSTOMER_COLUMNS = ["Customer", "Customer Name", "Company"];
const BRAND_COLUMNS = ["Brand", "Brand Name"];
const ORDER_DATE_COLUMNS = ["Order Date", "PO Date", "Date"];
const REGULATORY_BODY_COLUMNS = ["Regulatory Body", "Reg Body", "Body"];
const REGULATORY_STATUS_COLUMNS = ["Regulatory Status", "Reg Status", "Status"];
const PRODUCT_COLUMNS = ["Product Name", "Product", "Item"];
const DOSAGE_FORM_COLUMNS = ["Dosage Form", "Dosage"];
const QUANTITY_COLUMNS = ["Quantity", "Qty", "Count"];
const UNIT_COLUMNS = ["Unit"];
const VOLUME_COLUMNS = ["Volume"];
const PACK_SIZE_COLUMNS = ["Pack Size"];
const PACK_TYPE_COLUMNS = ["Pack Type"];

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

// Same three date-shape handling as every other importer — a JS Date
// (workbook read with cellDates: true) or dd-mm-yyyy/dd/mm/yyyy/yyyy-mm-dd text.
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

const REGULATORY_BODIES = new Set(["FSSAI", "AYUSH"]);
const REGULATORY_STATUSES = new Set(["Applied", "Not Applied", "Issued"]);

function matchEnum(value: string | undefined, allowed: Set<string>): string | undefined {
  if (!value) return undefined;
  const hit = [...allowed].find((a) => a.toLowerCase() === value.toLowerCase());
  return hit;
}

export interface ImportPurchaseOrderRow {
  poNumber: string;
  customerName: string;
  brandName?: string;
  orderDate?: string;
  regulatoryBody?: string;
  regulatoryStatus?: string;
  productName: string;
  dosageForm?: string;
  quantity: number;
  unit: string;
  volume?: number;
  packSize?: string;
  packType?: string;
}

export interface ParsedPurchaseOrderImport {
  rows: ImportPurchaseOrderRow[];
  skipped: number;
  sheetNames: string[];
  detectedHeaders: string[];
}

/**
 * One row per (PO, product) pair, every sheet in the workbook combined —
 * rows sharing the same PO Number become one Purchase Order with several
 * line items, same as filling "Add More" on the manual form once per
 * product instead of typing the header fields over and over.
 */
export function parsePurchaseOrderWorkbook(buffer: ArrayBuffer): ParsedPurchaseOrderImport {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const rows: ImportPurchaseOrderRow[] = [];
  const detectedHeaders = new Set<string>();
  let skipped = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, { defval: "" });
    for (const row of sheetRows) {
      for (const key of Object.keys(row)) detectedHeaders.add(key);
      const poNumber = asText(row, PO_NUMBER_COLUMNS);
      const customerName = asText(row, CUSTOMER_COLUMNS);
      const productName = asText(row, PRODUCT_COLUMNS);
      const unit = asText(row, UNIT_COLUMNS);
      const quantityRaw = firstNonEmpty(row, QUANTITY_COLUMNS);
      const quantity = quantityRaw === undefined ? NaN : Number(quantityRaw);

      if (!poNumber || !customerName || !productName || !unit || !Number.isFinite(quantity) || quantity <= 0) {
        skipped += 1;
        continue;
      }

      const volumeRaw = firstNonEmpty(row, VOLUME_COLUMNS);
      const volume = volumeRaw !== undefined ? Number(volumeRaw) : undefined;

      rows.push({
        poNumber,
        customerName,
        brandName: asText(row, BRAND_COLUMNS),
        orderDate: parseDate(firstNonEmpty(row, ORDER_DATE_COLUMNS)),
        regulatoryBody: matchEnum(asText(row, REGULATORY_BODY_COLUMNS), REGULATORY_BODIES),
        regulatoryStatus: matchEnum(asText(row, REGULATORY_STATUS_COLUMNS), REGULATORY_STATUSES),
        productName,
        dosageForm: asText(row, DOSAGE_FORM_COLUMNS),
        quantity,
        unit,
        volume: Number.isFinite(volume) && volume! > 0 ? volume : undefined,
        packSize: asText(row, PACK_SIZE_COLUMNS),
        packType: asText(row, PACK_TYPE_COLUMNS),
      });
    }
  }

  return { rows, skipped, sheetNames: workbook.SheetNames, detectedHeaders: [...detectedHeaders] };
}

export function downloadPurchaseOrderImportTemplate() {
  const rows = [
    {
      "PO Number": "PO-2026-0500",
      Customer: "Acme Nutrition Pvt. Ltd.",
      Brand: "FLS Wellness",
      "Order Date": "20-08-2026",
      "Regulatory Body": "FSSAI",
      "Regulatory Status": "Applied",
      "Product Name": "Whey Protein Powder",
      "Dosage Form": "Powder",
      Quantity: 500,
      Unit: "KG",
      Volume: "",
      "Pack Size": "1 Kg",
      "Pack Type": "Jar",
    },
    {
      "PO Number": "PO-2026-0500",
      Customer: "Acme Nutrition Pvt. Ltd.",
      Brand: "",
      "Order Date": "",
      "Regulatory Body": "",
      "Regulatory Status": "",
      "Product Name": "Multivitamin Capsules",
      "Dosage Form": "Capsule",
      Quantity: 2000,
      Unit: "SKU",
      Volume: "",
      "Pack Size": "60 Caps",
      "Pack Type": "Bottle",
    },
    { "PO Number": "", Customer: "", Brand: "", "Order Date": "", "Regulatory Body": "", "Regulatory Status": "", "Product Name": "", "Dosage Form": "", Quantity: "", Unit: "", Volume: "", "Pack Size": "", "Pack Type": "" },
  ];
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Purchase Orders");
  XLSX.writeFile(workbook, "FLS_Purchase_Order_Import_Template.xlsx");
}
