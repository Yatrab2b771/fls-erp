import * as XLSX from "xlsx";
import { formatEmployeeId } from "./format";
import type { DispatchTransfer, InventoryRequest, InventoryStockLine, InventoryTransaction, PersonRef } from "./types";

// Builds and downloads a single-sheet workbook straight from whatever the
// page already has loaded — no round trip to the server. Each report is
// a plain, well-labeled table so it opens cleanly for whichever
// department it's handed to, without needing this app to read it back.
//
// Every export includes both *who* and *when* for each action — not just
// the entry's business date, but the actual system timestamp it was
// logged/reviewed/accepted at, with the actor's permanent employee ID
// (not just their name, which two people can share) — this is the
// report's real audit trail, not a data dump.

const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };

function download(sheetName: string, rows: Record<string, unknown>[], filename: string) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "Rohit Sharma (FLS-0007)" — unambiguous even when two people share a name. */
function formatPerson(person: PersonRef | null | undefined): string {
  if (!person) return "";
  return `${person.fullName} (${formatEmployeeId(person.employeeId)})`;
}

/** Full date + time, not just the date — this is the log timestamp, distinct from the entry's business date. */
function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

export function exportStockReport(rows: InventoryStockLine[]) {
  download(
    "Stock on Hand",
    rows.map((r) => ({
      Item: r.item.name,
      Category: CATEGORY_LABEL[r.item.category] ?? r.item.category,
      Unit: r.item.unit ?? "",
      Received: r.receivedQty,
      "Issued (Day Store)": r.issuedDayStoreQty,
      "Issued (Production)": r.issuedProductionQty,
      "On Hand": r.onHand,
    })),
    `FLS_Inventory_Stock_${todayStamp()}.xlsx`,
  );
}

export function exportTransactionReport(rows: InventoryTransaction[], sheetName: string, filenamePart: string) {
  const isReceived = rows[0]?.type === "RECEIVED";
  download(
    sheetName,
    rows.map((r) => ({
      Date: new Date(r.date).toLocaleDateString(),
      Item: r.item.name,
      Category: CATEGORY_LABEL[r.item.category] ?? r.item.category,
      Quantity: r.quantity,
      Unit: r.unit,
      Size: r.size ?? "",
      "Vendor / Note": r.vendorName ?? "",
      "Logged By": formatPerson(r.createdBy),
      "Logged At": formatTimestamp(r.createdAt),
      // Inward QC trail — only meaningful for Material Received.
      ...(isReceived
        ? {
            Status: r.receiptStatus ?? "",
            "QC By": formatPerson(r.qcCheckedBy),
            "QC At": formatTimestamp(r.qcCheckedAt),
            "QC Note": r.qcNote ?? "",
            "Accepted By": formatPerson(r.acceptedBy),
            "Accepted At": formatTimestamp(r.acceptedAt),
          }
        : {}),
    })),
    `FLS_Inventory_${filenamePart}_${todayStamp()}.xlsx`,
  );
}

export function exportRequestsReport(rows: InventoryRequest[]) {
  download(
    "Material Requests",
    rows.map((r) => ({
      Date: new Date(r.createdAt).toLocaleDateString(),
      Item: r.item.name,
      Category: CATEGORY_LABEL[r.category] ?? r.category,
      Purpose: r.purpose === "ISSUED_PRODUCTION" ? "Issued to Production" : "Issued to Day Store",
      "Requested Qty": r.requestedQty,
      Status: r.status,
      "Requested By": formatPerson(r.requestedBy),
      "Requested At": formatTimestamp(r.createdAt),
      "Reviewed By": formatPerson(r.reviewedBy),
      "Reviewed At": formatTimestamp(r.reviewedAt),
      "Rejection Reason": r.rejectionReason ?? "",
      "Needed By": r.neededBy ? new Date(r.neededBy).toLocaleDateString() : "",
      Note: r.note ?? "",
    })),
    `FLS_Inventory_Material_Requests_${todayStamp()}.xlsx`,
  );
}

export function exportDispatchReport(rows: DispatchTransfer[], sheetName: string, filenamePart: string) {
  const isFg = rows[0]?.type === "FG";
  download(
    sheetName,
    rows.map((r) => ({
      Date: new Date(r.date).toLocaleDateString(),
      Customer: r.customer.companyName,
      "Product Name": r.productName,
      Quantity: r.quantity,
      "Logged By": formatPerson(r.createdBy),
      "Logged At": formatTimestamp(r.createdAt),
      // Outward QC trail — only meaningful for FG (goods); BILL never has one.
      ...(isFg
        ? {
            "QC Status": r.qcStatus ?? "",
            "QC By": formatPerson(r.qcCheckedBy),
            "QC At": formatTimestamp(r.qcCheckedAt),
            "QC Note": r.qcNote ?? "",
          }
        : {}),
    })),
    `FLS_Inventory_${filenamePart}_${todayStamp()}.xlsx`,
  );
}

// --- Bulk-import sample template — the exact column headers
// inventoryImport.ts looks for, plus one worked example, so a real sheet
// built from this always parses cleanly on upload. ---

export function downloadInventoryImportTemplate() {
  download(
    "Material Entries",
    [
      { Date: "01-08-2026", Item: "Whey Protein Concentrate", Category: "RM", Unit: "Kg", Count: 100, Size: "25 Kg bag", "Vendor Name": "Acme Ingredients Pvt. Ltd." },
      { Date: "", Item: "", Category: "", Unit: "", Count: "", Size: "", "Vendor Name": "" },
    ],
    "FLS_Inventory_Import_Template.xlsx",
  );
}
