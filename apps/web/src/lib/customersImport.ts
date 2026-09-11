import * as XLSX from "xlsx";

// Column headers matched loosely (case/spacing variations), same porting
// approach as every other bulk import in this app.
const COMPANY_COLUMNS = ["Company Name", "Company", "Customer"];
const CONTACT_PERSON_COLUMNS = ["Contact Person"];
const CONTACT_NO_COLUMNS = ["Contact No.", "Contact No", "Phone"];
const GST_COLUMNS = ["GST No.", "GST No", "GST"];
const EMAIL_COLUMNS = ["Email"];
const ADDRESS_COLUMNS = ["Delivery Address", "Address"];

function firstNonEmpty(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

// Returns undefined for a blank cell, never "" — this is what makes a
// blank cell mean "leave this field unchanged" on the server (an omitted
// key never reaches the update), not "clear it out". Getting this
// backwards would silently wipe every field a row's author didn't mean to
// touch — a landmine that would only show up on a real edit sheet with
// genuinely blank cells, not in a quick test.
function asText(row: Record<string, unknown>, keys: string[]): string | undefined {
  const v = firstNonEmpty(row, keys);
  return v === undefined ? undefined : String(v).trim();
}

export interface ImportCustomerUpdateRow {
  companyName: string;
  contactPerson?: string;
  contactNo?: string;
  gstNo?: string;
  email?: string;
  deliveryAddress?: string;
}

export interface ParsedCustomerUpdateImport {
  rows: ImportCustomerUpdateRow[];
  skipped: number;
  sheetNames: string[];
  detectedHeaders: string[];
}

/**
 * One row per existing customer, matched by Company Name against the
 * directory server-side — this never creates a new customer, only
 * updates whichever fields a row supplies. A row with no Company Name at
 * all is skipped (there's nothing to match against).
 */
export function parseCustomerUpdateWorkbook(buffer: ArrayBuffer): ParsedCustomerUpdateImport {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const rows: ImportCustomerUpdateRow[] = [];
  const detectedHeaders = new Set<string>();
  let skipped = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, { defval: "" });
    for (const row of sheetRows) {
      for (const key of Object.keys(row)) detectedHeaders.add(key);
      const companyName = asText(row, COMPANY_COLUMNS);

      if (!companyName) {
        skipped += 1;
        continue;
      }

      rows.push({
        companyName,
        contactPerson: asText(row, CONTACT_PERSON_COLUMNS),
        contactNo: asText(row, CONTACT_NO_COLUMNS),
        gstNo: asText(row, GST_COLUMNS),
        email: asText(row, EMAIL_COLUMNS),
        deliveryAddress: asText(row, ADDRESS_COLUMNS),
      });
    }
  }

  return { rows, skipped, sheetNames: workbook.SheetNames, detectedHeaders: [...detectedHeaders] };
}

export function downloadCustomerUpdateImportTemplate() {
  const rows = [
    {
      "Company Name": "Acme Nutrition Pvt. Ltd.",
      "Contact Person": "Rohit Sharma",
      "Contact No.": "9876543210",
      "GST No.": "27AAAAA0000A1Z5",
      Email: "rohit@acmenutrition.com",
      "Delivery Address": "Plot 12, MIDC, Pune",
    },
    { "Company Name": "", "Contact Person": "", "Contact No.": "", "GST No.": "", Email: "", "Delivery Address": "" },
  ];
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Customers");
  XLSX.writeFile(workbook, "FLS_Customer_Update_Template.xlsx");
}
