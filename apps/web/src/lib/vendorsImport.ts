import * as XLSX from "xlsx";

// Column headers matched loosely (case/spacing variations), same porting
// approach as every other bulk import in this app.
const NAME_COLUMNS = ["Vendor Name", "Vendor", "Name", "Company Name"];
const CODE_COLUMNS = ["Vendor Code", "Code"];
const CONTACT_PERSON_COLUMNS = ["Contact Person"];
const CONTACT_NO_COLUMNS = ["Contact No.", "Contact No", "Phone"];
const GST_COLUMNS = ["GST No.", "GST No", "GST"];
const EMAIL_COLUMNS = ["Email"];
const ADDRESS_COLUMNS = ["Address"];

function firstNonEmpty(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

// Returns undefined for a blank cell, never "" — an omitted key leaves
// the field unchanged on an update rather than wiping it, same reasoning
// as customersImport.ts.
function asText(row: Record<string, unknown>, keys: string[]): string | undefined {
  const v = firstNonEmpty(row, keys);
  return v === undefined ? undefined : String(v).trim();
}

export interface ImportVendorRow {
  name: string;
  code?: string;
  contactPerson?: string;
  contactNo?: string;
  gstNo?: string;
  email?: string;
  address?: string;
}

export interface ParsedVendorImport {
  rows: ImportVendorRow[];
  skipped: number;
  sheetNames: string[];
  detectedHeaders: string[];
}

/**
 * One row per vendor, matched by Name — creates a new vendor the first
 * time a name is seen server-side, updates it on a later row/sheet with
 * the same name. A row with no Name at all is skipped.
 */
export function parseVendorWorkbook(buffer: ArrayBuffer): ParsedVendorImport {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const rows: ImportVendorRow[] = [];
  const detectedHeaders = new Set<string>();
  let skipped = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, { defval: "" });
    for (const row of sheetRows) {
      for (const key of Object.keys(row)) detectedHeaders.add(key);
      const name = asText(row, NAME_COLUMNS);

      if (!name) {
        skipped += 1;
        continue;
      }

      rows.push({
        name,
        code: asText(row, CODE_COLUMNS),
        contactPerson: asText(row, CONTACT_PERSON_COLUMNS),
        contactNo: asText(row, CONTACT_NO_COLUMNS),
        gstNo: asText(row, GST_COLUMNS),
        email: asText(row, EMAIL_COLUMNS),
        address: asText(row, ADDRESS_COLUMNS),
      });
    }
  }

  return { rows, skipped, sheetNames: workbook.SheetNames, detectedHeaders: [...detectedHeaders] };
}

export function downloadVendorImportTemplate() {
  const rows = [
    {
      "Vendor Name": "Shree Packaging Industries",
      "Vendor Code": "V-0142",
      "Contact Person": "Suresh Patel",
      "Contact No.": "9876543210",
      "GST No.": "27AAAAA0000A1Z5",
      Email: "suresh@shreepackaging.com",
      Address: "Plot 8, GIDC, Vapi",
    },
    { "Vendor Name": "", "Vendor Code": "", "Contact Person": "", "Contact No.": "", "GST No.": "", Email: "", Address: "" },
  ];
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Vendors");
  XLSX.writeFile(workbook, "FLS_Vendor_Import_Template.xlsx");
}
