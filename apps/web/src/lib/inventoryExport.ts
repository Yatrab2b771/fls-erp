import * as XLSX from "xlsx";
import { formatEmployeeId } from "./format";
import type { CustomerReconciliationRow, DayStoreStockLine, DispatchTransfer, InventoryItem, InventoryRequest, InventoryStockLine, InventoryTransaction, ItemStockByLocation, PersonRef, PlantStockLine, PreInventoryRequirement } from "./types";

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
      Rejected: r.rejectedQty,
      "Issued (Store)": r.issuedDayStoreQty,
      "Issued (Production)": r.issuedProductionQty,
      "On Hand": r.onHand,
    })),
    `FLS_Inventory_Stock_${todayStamp()}.xlsx`,
  );
}

// One Store's own real-time balance (see stock.ts getOnHandByDayStoreAndItem)
// — same shape as exportStockReport above, but scoped to a single Store
// instead of the whole Warehouse, and with the store's name in both the
// sheet title and the filename so a downloaded copy is self-identifying
// once it's out of the app (e.g. emailed to that store's supervisor).
export function exportDayStoreStockReport(storeName: string, rows: DayStoreStockLine[]) {
  download(
    `Stock — ${storeName}`,
    rows.map((r) => ({
      Item: r.item.name,
      Category: CATEGORY_LABEL[r.item.category] ?? r.item.category,
      Unit: r.item.unit ?? "",
      "Received (from Warehouse)": r.receivedFromWarehouse,
      "Issued (to Production)": r.issuedToProduction,
      "On Hand": r.onHand,
    })),
    `FLS_Inventory_Stock_${storeName.replace(/\s+/g, "_")}_${todayStamp()}.xlsx`,
  );
}

// Same idea as exportDayStoreStockReport above, for one Plant.
export function exportPlantStockReport(plantName: string, rows: PlantStockLine[]) {
  download(
    `Stock — ${plantName}`,
    rows.map((r) => ({
      Item: r.item.name,
      Category: CATEGORY_LABEL[r.item.category] ?? r.item.category,
      Unit: r.item.unit ?? "",
      "On Hand": r.onHand,
    })),
    `FLS_Inventory_Stock_${plantName.replace(/\s+/g, "_")}_${todayStamp()}.xlsx`,
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
      // Which location this row belongs to — blank for Material Received
      // (Warehouse is implicit, there's only one), populated for the two
      // Issued sheets. Shown on screen already (TransactionTable); this
      // was missing from the downloaded report itself.
      Store: r.dayStore?.name ?? "",
      Plant: r.plant?.name ?? "",
      Quantity: r.quantity,
      Unit: r.unit,
      Size: r.size ?? "",
      "Vendor / Note": r.vendorName ?? "",
      "Batch No": r.batchNo ?? "",
      "GRN No": r.grnNo ?? "",
      "Mfg Date": r.mfgDate ? new Date(r.mfgDate).toLocaleDateString() : "",
      "Expiry Date": r.expiryDate ? new Date(r.expiryDate).toLocaleDateString() : "",
      Remark: r.remark ?? "",
      "Logged By": formatPerson(r.createdBy),
      "Logged At": formatTimestamp(r.createdAt),
      // Inward QC trail — only meaningful for Material Received.
      ...(isReceived
        ? {
            "Opening Stock": r.isOpeningStock ? "Yes" : "No",
            Status: r.receiptStatus ?? "",
            "Rejected Qty": r.rejectedQty ?? "",
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

// One item's complete history — every Received/Issued row, mixed
// together and sorted the same way the item detail page shows them,
// unlike exportTransactionReport above which is always one type at a
// time (this is the "everything about this one item" report, not the
// "everything on this one sheet" report).
export function exportItemHistoryReport(item: InventoryItem, rows: InventoryTransaction[]) {
  const TYPE_LABEL: Record<string, string> = { RECEIVED: "Received", ISSUED_DAY_STORE: "Issued to Store", ISSUED_PRODUCTION: "Issued to Production" };
  download(
    `History — ${item.name}`.slice(0, 31),
    rows.map((r) => ({
      Date: new Date(r.date).toLocaleDateString(),
      Type: TYPE_LABEL[r.type] ?? r.type,
      Quantity: r.quantity,
      Unit: r.unit,
      Location: r.dayStore?.name ?? r.plant?.name ?? "",
      "Vendor / Note": r.vendorName ?? "",
      "Batch No": r.batchNo ?? "",
      "GRN No": r.grnNo ?? "",
      Status: r.type === "RECEIVED" ? (r.receiptStatus ?? "") : "",
      "Rejected Qty": r.rejectedQty ?? "",
      "Logged By": formatPerson(r.createdBy),
      "Logged At": formatTimestamp(r.createdAt),
    })),
    `FLS_Inventory_Item_History_${item.name.replace(/\s+/g, "_")}_${todayStamp()}.xlsx`,
  );
}

export function exportRequestsReport(rows: InventoryRequest[]) {
  download(
    "Material Requests",
    rows.map((r) => ({
      Date: new Date(r.createdAt).toLocaleDateString(),
      Item: r.item.name,
      Category: CATEGORY_LABEL[r.category] ?? r.category,
      Purpose: r.purpose === "ISSUED_PRODUCTION" ? "Issued to Production" : "Issued to Store",
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
      // Outward QC + Dispatch/Invoice trail — only meaningful for FG
      // (goods); BILL never goes through QC, Dispatch confirmation, or
      // invoicing (see inventory.routes.ts — both those routes are
      // FG-only), so none of this applies to a BILL row.
      ...(isFg
        ? {
            "QC Status": r.qcStatus ?? "",
            "QC By": formatPerson(r.qcCheckedBy),
            "QC At": formatTimestamp(r.qcCheckedAt),
            "QC Note": r.qcNote ?? "",
            "Source Request": r.sourceRequest ? `${r.sourceRequest.item.name} (${r.sourceRequest.requestedQty})` : "",
            "Dispatched By": formatPerson(r.dispatchedBy),
            "Dispatched At": formatTimestamp(r.dispatchedAt),
            "Dispatch Note": r.dispatchNote ?? "",
            "Invoice Number": r.invoiceNumber ?? "",
            "Invoiced By": formatPerson(r.invoicedBy),
            "Invoiced At": formatTimestamp(r.invoicedAt),
          }
        : {}),
    })),
    `FLS_Inventory_${filenamePart}_${todayStamp()}.xlsx`,
  );
}

// Customer stock reconciliation — one row per customer: FG dispatched,
// how much of that's actually been invoiced, and what's still
// outstanding. This is the report that closes the "Finance needs no
// data from anyone" cascade item — everything here is already live off
// the dispatch/invoice ledger, nothing to chase by hand.
export function exportCustomerReconciliationReport(rows: CustomerReconciliationRow[]) {
  download(
    "Customer Reconciliation",
    rows.map((r) => ({
      Customer: r.customerName,
      "Dispatched Qty": r.dispatchedQty,
      "Dispatched Shipments": r.dispatchedCount,
      "Invoiced Qty": r.invoicedQty,
      "Invoiced Shipments": r.invoicedCount,
      "Outstanding Qty": r.outstandingQty,
      "Outstanding Shipments": r.outstandingCount,
    })),
    `FLS_Customer_Reconciliation_${todayStamp()}.xlsx`,
  );
}

// S4 — Finance's "download list of vendors to do their financial
// planning": every requirement that has a PO logged against it, so
// Accounts can see exactly what's been committed and when it's due.
export function exportRequirementsReport(rows: PreInventoryRequirement[]) {
  download(
    "Pre-Inventory",
    rows.map((r) => ({
      Date: new Date(r.date).toLocaleDateString(),
      Item: r.item.name,
      Category: CATEGORY_LABEL[r.category] ?? r.category,
      "Required Qty": r.requiredQty,
      Unit: r.unit,
      "Requested By": formatPerson(r.requestedBy),
      "Current Stock": r.currentStock,
      "Short Qty": r.shortQty,
      "PO Number": r.poNumber ?? "",
      "Vendor Name": r.vendorName ?? "",
      ETA: r.eta ? new Date(r.eta).toLocaleDateString() : "",
      "Ordered By": formatPerson(r.purchaseBy),
      "Ordered At": formatTimestamp(r.purchaseAt),
    })),
    `FLS_PreInventory_Vendor_List_${todayStamp()}.xlsx`,
  );
}

// Report #7 — "PO placed with a vendor, material still not in." Takes
// the same rows the Purchase Log tab already has loaded (PPIC/Purchase's
// existing ?short=true fetch), narrowed here to rows where a PO number
// has actually been logged (Purchase has acted) but shortQty is still
// above zero (the goods haven't landed yet) — a plain short list mixes
// those in with requirements nobody's even ordered against yet, which
// isn't what "aging" means. Aging is measured from ETA once one's set
// (the vendor's own promised date, the honest thing to be late against),
// falling back to the PO's log date otherwise.
export function exportPurchaseAgingReport(rows: PreInventoryRequirement[]) {
  const pending = rows.filter((r) => !!r.poNumber && r.shortQty > 0);
  const now = Date.now();
  const dayMs = 1000 * 60 * 60 * 24;
  download(
    "PO Aging",
    pending
      .map((r) => {
        const against = r.eta ?? r.purchaseAt;
        const agingDays = against ? Math.round((now - new Date(against).getTime()) / dayMs) : null;
        return {
          Item: r.item.name,
          Category: CATEGORY_LABEL[r.category] ?? r.category,
          "PO Number": r.poNumber ?? "",
          "Vendor Name": r.vendorName ?? "",
          "Required Qty": r.requiredQty,
          "Current Stock": r.currentStock,
          "Still Short": r.shortQty,
          Unit: r.unit,
          ETA: r.eta ? new Date(r.eta).toLocaleDateString() : "",
          "Ordered At": formatTimestamp(r.purchaseAt),
          "Aging (Days)": agingDays !== null ? Math.max(0, agingDays) : "",
          "Overdue?": r.eta && new Date(r.eta).getTime() < now ? "Yes" : "No",
        };
      })
      .sort((a, b) => (typeof b["Aging (Days)"] === "number" && typeof a["Aging (Days)"] === "number" ? (b["Aging (Days)"] as number) - (a["Aging (Days)"] as number) : 0)),
    `FLS_PreInventory_PO_Aging_${todayStamp()}.xlsx`,
  );
}

// Report #5 — one RM/PM item, its stock split across Warehouse, every
// Day Store, and every Plant, side by side.
export function exportItemStockByLocation(data: ItemStockByLocation) {
  const rows: Record<string, unknown>[] = [{ Location: "Warehouse", Type: "Warehouse", "Received / In": "", "Issued / Out": "", "On Hand": data.warehouse }];
  for (const ds of data.dayStores) {
    rows.push({ Location: ds.name, Type: "Day Store", "Received / In": ds.receivedFromWarehouse, "Issued / Out": ds.issuedToProduction, "On Hand": ds.onHand });
  }
  for (const p of data.plants) {
    rows.push({ Location: p.name, Type: "Plant", "Received / In": "", "Issued / Out": "", "On Hand": p.onHand });
  }
  download(
    `Stock — ${data.item.name}`.slice(0, 31),
    rows,
    `FLS_Inventory_${data.item.name.replace(/\s+/g, "_")}_By_Location_${todayStamp()}.xlsx`,
  );
}

// --- Bulk-import sample template — the exact column headers
// inventoryImport.ts looks for, plus one worked example, so a real sheet
// built from this always parses cleanly on upload. ---

export function downloadInventoryImportTemplate() {
  download(
    "Material Entries",
    [
      {
        Date: "01-08-2026",
        Item: "Whey Protein Concentrate",
        Category: "RM",
        Unit: "Kg",
        Count: 100,
        Size: "25 Kg bag",
        "Vendor Name": "Acme Ingredients Pvt. Ltd.",
        "Batch No": "B-2026-081",
        "GRN No": "GRN-1042",
        "Mfg Date": "15-07-2026",
        "Expiry Date": "15-07-2027",
        Remark: "",
      },
      { Date: "", Item: "", Category: "", Unit: "", Count: "", Size: "", "Vendor Name": "", "Batch No": "", "GRN No": "", "Mfg Date": "", "Expiry Date": "", Remark: "" },
    ],
    "FLS_Inventory_Import_Template.xlsx",
  );
}

export function downloadInventoryRequestImportTemplate() {
  download(
    "Material Requests",
    [
      { Item: "Whey Protein Concentrate", Category: "RM", "Requested Qty": 50, Purpose: "Production", "Needed By": "25-08-2026", Note: "For batch GB-BCAA-0098" },
      { Item: "Jar 1Kg HDPE", Category: "PM", "Requested Qty": 500, Purpose: "Store", "Needed By": "", Note: "" },
      { Item: "", Category: "", "Requested Qty": "", Purpose: "", "Needed By": "", Note: "" },
    ],
    "FLS_Inventory_Request_Template.xlsx",
  );
}

export function downloadRequirementImportTemplate() {
  download(
    "Requirements",
    [
      { Date: "21-08-2026", Item: "Whey Protein Concentrate", Category: "RM", Unit: "Kg", "Required Qty": 200, Size: "", Note: "For next month's production run" },
      { Date: "", Item: "", Category: "", Unit: "", "Required Qty": "", Size: "", Note: "" },
    ],
    "FLS_PreInventory_Requirement_Template.xlsx",
  );
}

export function downloadPurchaseLogImportTemplate() {
  download(
    "PO Log",
    [
      { Item: "Whey Protein Concentrate", Category: "RM", "PO Number": "PO-RM-001", "Vendor Name": "Sunrise Ingredients", ETA: "24-08-2026" },
      { Item: "", Category: "", "PO Number": "", "Vendor Name": "", ETA: "" },
    ],
    "FLS_PreInventory_PO_Log_Template.xlsx",
  );
}

export function downloadDispatchImportTemplate(type: "FG" | "BILL") {
  download(
    type === "FG" ? "FG Transfers" : "Bill Transfers",
    [
      { Customer: "Acme Nutrition Pvt. Ltd.", Date: "20-08-2026", "Product Name": "Whey Gold 1Kg", Qty: 50 },
      { Customer: "", Date: "", "Product Name": "", Qty: "" },
    ],
    `FLS_Inventory_${type === "FG" ? "FG" : "Bill"}_Transfer_Template.xlsx`,
  );
}
