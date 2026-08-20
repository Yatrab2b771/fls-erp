import * as XLSX from "xlsx";
import type { DispatchTransfer, InventoryStockLine, InventoryTransaction } from "./types";

// Builds and downloads a single-sheet workbook straight from whatever the
// page already has loaded — no round trip to the server. Each report is
// a plain, well-labeled table so it opens cleanly for whichever
// department it's handed to, without needing this app to read it back.

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
      "Logged By": r.createdBy.fullName,
    })),
    `FLS_Inventory_${filenamePart}_${todayStamp()}.xlsx`,
  );
}

export function exportDispatchReport(rows: DispatchTransfer[], sheetName: string, filenamePart: string) {
  download(
    sheetName,
    rows.map((r) => ({
      Date: new Date(r.date).toLocaleDateString(),
      Customer: r.customer.companyName,
      "Product Name": r.productName,
      Quantity: r.quantity,
      "Logged By": r.createdBy.fullName,
    })),
    `FLS_Inventory_${filenamePart}_${todayStamp()}.xlsx`,
  );
}
