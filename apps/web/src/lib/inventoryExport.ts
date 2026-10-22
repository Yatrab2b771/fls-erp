import * as XLSX from "xlsx";
import { formatEmployeeId } from "./format";
import { COMBINED_LOT_STAGE_LABEL } from "./combinedLotStage";
import type {
  CustomerReconciliationRow,
  DayStoreStockLine,
  DispatchTransfer,
  FgStockRow,
  InventoryItem,
  InventoryRequest,
  InventoryStockLine,
  InventoryTransaction,
  ItemStockByLocation,
  MaterialConsumptionRow,
  MaterialReconciliationRow,
  PersonRef,
  PlantStockLine,
  PreInventoryRequirement,
  RndStoreReportRow,
  TransitItem,
} from "./types";
import { customerTypeLabel } from "./customerTags";

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

export function exportFgStockReport(rows: FgStockRow[]) {
  download(
    "FG Stock on Hand",
    rows.map((r) => ({
      Customer: r.customerName,
      "Customer Type": customerTypeLabel(r.customerName),
      Stage: COMBINED_LOT_STAGE_LABEL[r.currentStageId] ?? r.currentStageId,
      Product: r.productName,
      "PO Number": r.poNumber ?? "",
      "Batch / Lot": r.label,
      Unit: r.unit,
      Produced: r.producedQty,
      Dispatched: r.dispatchedQty,
      "On Hand": r.onHandQty,
      "Reached FG Store": r.fgStoreReceivedDate ? new Date(r.fgStoreReceivedDate).toLocaleDateString() : "",
    })),
    `FLS_FG_Stock_${todayStamp()}.xlsx`,
  );
}

export function exportMaterialConsumptionReport(rows: MaterialConsumptionRow[]) {
  download(
    "Material Consumption",
    rows.map((r) => ({
      "PO Number": r.poNumber ?? "",
      Customer: r.customerName,
      "Customer Type": customerTypeLabel(r.customerName),
      Product: r.productName,
      "Batch No": r.batchNo ?? "",
      Item: r.itemName,
      Category: CATEGORY_LABEL[r.category] ?? r.category,
      Unit: r.unit,
      "Required Qty": r.requiredQty ?? "",
      "Used in Production": r.consumedQty,
      "Sent for Testing": r.sampleQty,
      Wasted: r.wastedQty,
      Rejected: r.rejectedQty,
      "% Consumed (Production)": r.requiredQty ? Math.round((r.consumedQty / r.requiredQty) * 1000) / 10 : "",
      "Last Logged": new Date(r.lastLoggedAt).toLocaleDateString(),
    })),
    `FLS_Material_Consumption_${todayStamp()}.xlsx`,
  );
}

// R&D's own Log Consumption — Testing/Formulation Trial/Wastage/Rejected
// against R&D Store's own stock (RndStoreTransaction), item-wise. Kept
// entirely separate from exportMaterialConsumptionReport above — that
// one is Production/Plant's own ledger (BatchMaterialConsumption), a
// different model with a different audience (R&D-only, never shown to
// PPIC/Production or vice versa — see the client's own "sirf RND
// department" instruction).
export function exportRndConsumptionReport(rows: RndStoreReportRow[]) {
  download(
    "R&D Consumption",
    rows.map((r) => ({
      Item: r.itemName,
      Category: CATEGORY_LABEL[r.category] ?? r.category,
      Unit: r.unit,
      "On Hand": r.onHand,
      Testing: r.testingQty,
      "Formulation Trial": r.formulationTrialQty,
      Wastage: r.wastageQty,
      Rejected: r.rejectedQty,
      Dispatched: r.dispatchedQty,
      Returned: r.returnedQty,
    })),
    `FLS_RND_Consumption_${todayStamp()}.xlsx`,
  );
}

// Every open shipment across every leg (Day Store/Plant transit-tracked,
// vendor QC queue, R&D) — see GET /inventory/transit. "In Transit (h)"
// is a decimal snapshot at export time, not a live-updating cell — an
// Excel file can't tick the way the on-screen list does.
export function exportTransitReport(rows: TransitItem[]) {
  download(
    "Transit",
    rows.map((r) => ({
      Item: r.item.name,
      Category: CATEGORY_LABEL[r.item.category] ?? r.item.category,
      Kind: r.kind,
      From: r.from,
      To: r.to,
      Qty: r.quantity,
      Unit: r.unit,
      "Dispatched At": formatTimestamp(r.dispatchedAt),
      "Dispatched By": formatPerson(r.dispatchedBy),
      "In Transit (h)": Math.round(((Date.now() - new Date(r.dispatchedAt).getTime()) / 3_600_000) * 10) / 10,
    })),
    `FLS_Inventory_Transit_${todayStamp()}.xlsx`,
  );
}

// Of everything ever received for each item, where it all actually went
// — see GET /inventory/reconciliation. Same column set the on-screen
// table shows, so the sheet is self-explanatory without this app open
// next to it.
export function exportMaterialReconciliationReport(rows: MaterialReconciliationRow[]) {
  download(
    "Reconciliation",
    rows.map((r) => ({
      Item: r.item.name,
      Category: CATEGORY_LABEL[r.item.category] ?? r.item.category,
      Unit: r.item.unit ?? "",
      Received: r.receivedQty,
      "On Hand — Warehouse": r.onHandWarehouse,
      "On Hand — Stores": r.onHandDayStores,
      "On Hand — Plants": r.onHandPlants,
      "Consumed in Production": r.consumedProduction,
      "Sent as QC Sample": r.consumedSample,
      "Wastage at Dispensing": r.consumedWaste,
      "R&D — Testing": r.rndTesting,
      "R&D — Formulation Trial": r.rndFormulationTrial,
      "R&D — Wastage": r.rndWastage,
      "R&D — Rejected": r.rndRejected,
      "R&D — To Customer": r.rndDispatchedCustomer,
      "R&D — Returned to Warehouse (info)": r.rndReturnedToWarehouse,
      "Accounted For": r.accountedFor,
      Variance: r.variance,
    })),
    `FLS_Inventory_Reconciliation_${todayStamp()}.xlsx`,
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
      Status: r.type === "RECEIVED" ? (r.receiptStatus ?? "") : "",
      Type: TYPE_LABEL[r.type] ?? r.type,
      Quantity: r.quantity,
      Unit: r.unit,
      Location: r.dayStore?.name ?? r.plant?.name ?? "",
      "Vendor / Note": r.vendorName ?? "",
      "Batch No": r.batchNo ?? "",
      "GRN No": r.grnNo ?? "",
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
      Status: r.status,
      Item: r.item.name,
      Category: CATEGORY_LABEL[r.category] ?? r.category,
      Purpose: r.purpose === "ISSUED_PRODUCTION" ? "Issued to Production" : "Issued to Store",
      "Requested Qty": r.requestedQty,
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
      "Customer Type": customerTypeLabel(r.customer.companyName),
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
      "Customer Type": customerTypeLabel(r.customerName),
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
    // One row per PI line - a shortfall split 20 + 40 + 40 Kg is three rows, each with its own PI / vendor / ETA.
    rows.flatMap((r): Record<string, unknown>[] => {
      const common = {
        Date: new Date(r.date).toLocaleDateString(),
        Item: r.item.name,
        Category: CATEGORY_LABEL[r.category] ?? r.category,
        "Required Qty": r.requiredQty,
        Unit: r.unit,
        "Requested By": formatPerson(r.requestedBy),
        "Current Stock": r.currentStock,
        "Short Qty": r.shortQty,
        "Left to Log": r.remainingToLog,
        "Customer PO": r.sourcePo?.poNumber ?? "",
      };
      if (r.purchaseLines.length === 0) {
        return [{ ...common, "PI Qty": "", "PI Number": "", "Vendor Name": "", ETA: "", "PI Status": "", "Ordered By": "", "Ordered At": "", "PI Updated": "No", "PI Updated At": "" }];
      }
      return r.purchaseLines.map((l) => ({
        ...common,
        "PI Status": l.status === "RECEIVED" ? "Received" : l.receivedQty > 0 ? `${l.receivedQty} of ${l.quantity} arrived` : "On order",
        "PI Qty": l.quantity,
        "PI Number": l.piNumber,
        "Vendor Name": l.vendorName,
        ETA: new Date(l.eta).toLocaleDateString(),
        "Ordered By": formatPerson(l.loggedBy),
        "Ordered At": formatTimestamp(l.loggedAt),
        "PI Updated": l.correctedAt ? "Yes" : "No",
        "PI Updated At": formatTimestamp(l.correctedAt),
      }));
    }),
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
  // One row per PI line still on its way (a shortfall can have several).
  const pending = rows.filter((r) => r.shortQty > 0).flatMap((r) => r.purchaseLines.filter((l) => l.status === "OPEN").map((l) => ({ r, l })));
  const now = Date.now();
  const dayMs = 1000 * 60 * 60 * 24;
  download(
    "PO Aging",
    pending
      .map(({ r, l }) => {
        const against = l.eta ?? l.loggedAt;
        const agingDays = against ? Math.round((now - new Date(against).getTime()) / dayMs) : null;
        return {
          Item: r.item.name,
          Category: CATEGORY_LABEL[r.category] ?? r.category,
          "Customer PO": r.sourcePo?.poNumber ?? "",
          "PI Number": l.piNumber,
          "Vendor Name": l.vendorName,
          "PI Qty": l.quantity - l.receivedQty,
          "Required Qty": r.requiredQty,
          "Current Stock": r.currentStock,
          "Still Short": r.shortQty,
          Unit: r.unit,
          ETA: new Date(l.eta).toLocaleDateString(),
          "Ordered At": formatTimestamp(l.loggedAt),
          "Aging (Days)": agingDays !== null ? Math.max(0, agingDays) : "",
          "Overdue?": new Date(l.eta).getTime() < now ? "Yes" : "No",
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
    rows.push({ Location: ds.name, Type: "Store", "Received / In": ds.receivedFromWarehouse, "Issued / Out": ds.issuedToProduction, "On Hand": ds.onHand });
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

// Item Master ("SKU Namkaran") — the naming-reconciliation sheet's own
// shape: real code, plus every name a different department calls this
// item by, resolved down to one standardized name. No Category column —
// derived from the code's own RM.../PM... prefix on import.
export function downloadItemMasterImportTemplate() {
  download(
    "Item Master",
    [
      { "SKU Code": "RM00001", "Store Name": "Zinc Sulphate - Dyanamic", "Name from Lab": "Zinc Sulphate", "Correct Name": "Zinc Sulphate Monohydrate", Make: "Dyanamic" },
      { "SKU Code": "", "Store Name": "", "Name from Lab": "", "Correct Name": "", Make: "" },
    ],
    "FLS_Inventory_Item_Master_Template.xlsx",
  );
}

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

export function downloadRndSampleRequestImportTemplate() {
  download(
    "R&D Sample Requests",
    [
      { Item: "Whey Protein Concentrate", Category: "RM", Quantity: 10, Unit: "Kg", Note: "For new whey-isolate blend trial" },
      { Item: "Jar 250g HDPE", Category: "PM", Quantity: 20, Unit: "Count", Note: "" },
      { Item: "", Category: "", Quantity: "", Unit: "", Note: "" },
    ],
    "FLS_RndStore_Request_Template.xlsx",
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

// Available Stock - every RM / PM on hand across Warehouse, Day Stores, R&D Store and Plants.
export interface AvailableLocation {
  key: string;
  label: string;
  kind: "WAREHOUSE" | "DAY_STORE" | "RND" | "PLANT";
}
export interface ItemDetail {
  earliestExpiry: string | null;
  expiresInDays: number | null;
  lastReceived: string | null;
  batches: number;
  quarantineQty: number;
  onOrderQty: number;
  nextEta: string | null;
}

// One receipt (batch) behind an item.
export interface ItemBatch {
  id: string;
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  batchNo: string | null;
  grnNo: string | null;
  mfgDate: string | null;
  expiryDate: string | null;
  receivedOn: string;
  receivedQty: number;
  vendorName: string | null;
  invoiceNo: string | null;
  rate: number | null;
  status: string;
}

export interface AvailableStockByItem {
  itemCode?: string | null;
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string | null;
  total: number;
  locations: Record<string, number>;
  detail?: ItemDetail;
}
export interface AvailableStockByLocation {
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string | null;
  locationKey: string;
  locationLabel: string;
  quantity: number;
}

export function exportAvailableStockReport(view: "item" | "location", rows: (AvailableStockByItem | AvailableStockByLocation)[], locations: AvailableLocation[], batches: ItemBatch[] = []) {
  if (view === "item") {
    const sheet = XLSX.utils.json_to_sheet(
      (rows as AvailableStockByItem[]).map((r) => ({
        Item: r.itemName,
        Code: r.itemCode ?? "",
        Category: CATEGORY_LABEL[r.category] ?? r.category,
        Unit: r.unit ?? "",
        ...Object.fromEntries(locations.map((l) => [l.label, r.locations[l.key] ?? 0])),
        Total: r.total,
        "Earliest Expiry": r.detail?.earliestExpiry ? day(r.detail.earliestExpiry) : "",
        "Expires In (Days)": r.detail?.expiresInDays ?? "",
        Batches: r.detail?.batches || "",
        "Last Received": r.detail?.lastReceived ? day(r.detail.lastReceived) : "",
        "Quarantine Qty": r.detail?.quarantineQty || "",
        "On Order Qty": r.detail?.onOrderQty || "",
        "Next ETA": r.detail?.nextEta ? day(r.detail.nextEta) : "",
      })),
    );
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Available Stock");
    // One row per item x location - the flat list the old "By location" view gave.
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(
        (rows as AvailableStockByItem[]).flatMap((r) =>
          locations.flatMap((l) => ((r.locations[l.key] ?? 0) > 0 ? [{ Item: r.itemName, Category: CATEGORY_LABEL[r.category] ?? r.category, Location: l.label, Available: r.locations[l.key], Unit: r.unit ?? "" }] : [])),
        ),
      ),
      "By Location",
    );
    if (batches.length) {
      // Received qty per batch, not what is left of it - stock is tracked per item, not per batch.
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet(
          batches.map((b) => ({
            Item: b.itemName,
            Status: b.status,
            Category: CATEGORY_LABEL[b.category] ?? b.category,
            "Batch No": b.batchNo ?? "",
            "GRN No": b.grnNo ?? "",
            "Mfg Date": day(b.mfgDate),
            "Expiry Date": day(b.expiryDate),
            "Received On": day(b.receivedOn),
            "Received Qty": b.receivedQty,
            Unit: b.unit,
            Vendor: b.vendorName ?? "",
            "Invoice No": b.invoiceNo ?? "",
            Rate: b.rate ?? "",
          })),
        ),
        "Batches",
      );
    }
    XLSX.writeFile(workbook, `FLS_Available_Stock_By_Item_${todayStamp()}.xlsx`);
    return;
  }
  download(
    "Available Stock",
    (rows as AvailableStockByLocation[]).map((r) => ({ Item: r.itemName, Category: CATEGORY_LABEL[r.category] ?? r.category, Location: r.locationLabel, Available: r.quantity, Unit: r.unit ?? "" })),
    `FLS_Available_Stock_By_Location_${todayStamp()}.xlsx`,
  );
}

// Incoming Material - one PI line still to arrive.
export interface IncomingRow {
  lineId: string;
  requirementId: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  quantity: number;
  orderedQty: number;
  piNumber: string;
  vendorName: string;
  eta: string;
  overdue: boolean;
  customerPo: { poId: string; poNumber: string | null; customerName: string; productName: string } | null;
}

// Stock Received - one vendor delivery into the Warehouse.
export interface StockReceivedRow {
  id: string;
  date: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  quantity: number;
  rejectedQty: number | null;
  vendorName: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  grnNo: string | null;
  batchNo: string | null;
  mfgDate: string | null;
  expiryDate: string | null;
  rate: number | null;
  qcStatus: string | null;
}

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "");

export function exportStockReceivedReport(rows: StockReceivedRow[]) {
  download(
    "Stock Received",
    rows.map((r) => ({
      Date: day(r.date),
      "QC Status": r.qcStatus ?? "",
      Item: r.itemName,
      Category: CATEGORY_LABEL[r.category] ?? r.category,
      Quantity: r.quantity,
      Unit: r.unit,
      "Rejected Qty": r.rejectedQty ?? "",
      "Vendor Name": r.vendorName ?? "",
      "Invoice No": r.invoiceNo ?? "",
      "Invoice Date": day(r.invoiceDate),
      "GRN No": r.grnNo ?? "",
      "Batch No": r.batchNo ?? "",
      "Mfg Date": day(r.mfgDate),
      "Expiry Date": day(r.expiryDate),
      Rate: r.rate ?? "",
    })),
    `FLS_Stock_Received_${todayStamp()}.xlsx`,
  );
}

// Quarantine - stock held for QC, on hold, or sent for a lab test.
export interface QuarantineListRow {
  id: string;
  reason: "Awaiting QC" | "Testing" | "On Hold" | "Lab Test";
  date: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  quantity: number;
  vendorName: string | null;
  invoiceNo: string | null;
  grnNo: string | null;
  batchNo: string | null;
  mfgDate: string | null;
  expiryDate: string | null;
  sinceAt: string | null;
}

export function exportQuarantineReport(rows: QuarantineListRow[]) {
  const now = Date.now();
  download(
    "Quarantine",
    rows.map((r) => ({
      Reason: r.reason,
      "Received Date": day(r.date),
      Item: r.itemName,
      Category: CATEGORY_LABEL[r.category] ?? r.category,
      Quantity: r.quantity,
      Unit: r.unit,
      "Vendor Name": r.vendorName ?? "",
      "Invoice No": r.invoiceNo ?? "",
      "GRN No": r.grnNo ?? "",
      "Batch No": r.batchNo ?? "",
      "Mfg Date": day(r.mfgDate),
      "Expiry Date": day(r.expiryDate),
      "In Quarantine Since": day(r.sinceAt),
      "Aging (Days)": r.sinceAt ? Math.max(0, Math.floor((now - new Date(r.sinceAt).getTime()) / 86_400_000)) : "",
    })),
    `FLS_Quarantine_${todayStamp()}.xlsx`,
  );
}

// Finished Goods - one batch / lot at or past the FG Store with stock left.
export interface FgListRow {
  id: string;
  itemId: string;
  kind: "BATCH" | "COMBINED_LOT";
  poNumber: string | null;
  productName: string;
  customerName: string;
  plantName: string | null;
  label: string;
  unit: string;
  producedQty: number;
  dispatchedQty: number;
  onHandQty: number;
  fgStoreDate: string | null;
}

// Finished Goods, product-wise - one PO line (product) with all its batches / lots added up.
export interface FgProductRow {
  itemId: string;
  poNumber: string | null;
  productName: string;
  customerName: string;
  plantName: string | null;
  unit: string;
  batchCount: number;
  producedQty: number;
  dispatchedQty: number;
  onHandQty: number;
  fgStoreDate: string | null;
  batches: FgListRow[];
}

export function exportFgProductReport(rows: FgProductRow[]) {
  const now = Date.now();
  download(
    "Finished Goods (product-wise)",
    rows.map((r) => ({
      "PO Number": r.poNumber ?? "",
      Product: r.productName,
      Customer: r.customerName,
      "Customer Type": customerTypeLabel(r.customerName),
      Plant: r.plantName ?? "",
      Batches: r.batchCount,
      "Batch / Lot": r.batches.map((b) => b.label).join(", "),
      Unit: r.unit,
      "Produced Qty": r.producedQty,
      "Dispatched Qty": r.dispatchedQty,
      "On Hand Qty": r.onHandQty,
      "Oldest in FG Store Since": day(r.fgStoreDate),
      "Aging (Days)": r.fgStoreDate ? Math.max(0, Math.floor((now - new Date(r.fgStoreDate).getTime()) / 86_400_000)) : "",
    })),
    `FLS_Finished_Goods_Product_wise_${todayStamp()}.xlsx`,
  );
}

export function exportFgListReport(rows: FgListRow[]) {
  const now = Date.now();
  download(
    "Finished Goods",
    rows.map((r) => ({
      "PO Number": r.poNumber ?? "",
      Product: r.productName,
      Customer: r.customerName,
      "Customer Type": customerTypeLabel(r.customerName),
      Plant: r.plantName ?? "",
      "Batch / Lot": r.label,
      Unit: r.unit,
      "Produced Qty": r.producedQty,
      "Dispatched Qty": r.dispatchedQty,
      "On Hand Qty": r.onHandQty,
      "In FG Store Since": day(r.fgStoreDate),
      "Aging (Days)": r.fgStoreDate ? Math.max(0, Math.floor((now - new Date(r.fgStoreDate).getTime()) / 86_400_000)) : "",
    })),
    `FLS_Finished_Goods_${todayStamp()}.xlsx`,
  );
}

// Stock Issued - one issue out of the Warehouse (to a Day Store, a Plant or the R&D Store).
export interface StockIssuedRow {
  id: string;
  date: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  quantity: number;
  locationType: "Store" | "R&D Store";
  locationName: string | null;
  batchNo: string | null;
  grnNo: string | null;
  viaRequest: boolean;
  status: "Delivered" | "In Transit";
  issuedBy: string;
  remark: string | null;
}

export function exportStockIssuedReport(rows: StockIssuedRow[]) {
  download(
    "Stock Issued",
    rows.map((r) => ({
      Date: day(r.date),
      Status: r.status,
      Item: r.itemName,
      Category: CATEGORY_LABEL[r.category] ?? r.category,
      Quantity: r.quantity,
      Unit: r.unit,
      "Location Type": r.locationType,
      Location: r.locationName ?? "",
      "Batch No": r.batchNo ?? "",
      "GRN No": r.grnNo ?? "",
      "Issued Against": r.viaRequest ? "Material Request" : "Direct issue",
      "Issued By": r.issuedBy,
      Remark: r.remark ?? "",
    })),
    `FLS_Stock_Issued_${todayStamp()}.xlsx`,
  );
}

// A Day Store login's own movements: what came in from the Warehouse, or what went on to its Plant.
export interface MyStoreRow {
  id: string;
  date: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  quantity: number;
  storeName: string | null;
  plantName: string | null;
  batchNo: string | null;
  grnNo: string | null;
  viaRequest: boolean;
  isExtra: boolean;
  status: "Delivered" | "In Transit";
  issuedBy: string;
}

export function exportMyStoreReport(kind: "received" | "issued-to-plant", rows: MyStoreRow[]) {
  const toPlant = kind === "issued-to-plant";
  download(
    toPlant ? "Dispensed to Plant" : "Received from Warehouse",
    rows.map((r) => ({
      Date: day(r.date),
      Status: r.status,
      Item: r.itemName,
      Category: CATEGORY_LABEL[r.category] ?? r.category,
      Quantity: r.quantity,
      Unit: r.unit,
      "Store": r.storeName ?? "",
      ...(toPlant ? { Plant: r.plantName ?? "" } : {}),
      "Batch No": r.batchNo ?? "",
      "GRN No": r.grnNo ?? "",
      Against: r.isExtra ? "Extra material" : r.viaRequest ? "Material Request" : "Direct",
      [toPlant ? "Issued By" : "Issued By (Warehouse)"]: r.issuedBy,
    })),
    `FLS_${toPlant ? "Dispensed_To_Plant" : "Received_From_Warehouse"}_${todayStamp()}.xlsx`,
  );
}

// Material Requests - what Day Stores and the R&D Store asked the Warehouse for.
export interface MaterialRequestRow {
  key: string;
  source: "store" | "rnd";
  id: string;
  requestedAt: string;
  requesterType: "Store" | "R&D Store";
  requesterName: string;
  requesterStoreId: string | null;
  requestedBy: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  requestedQty: number;
  issuedQty: number;
  remainingQty: number;
  neededBy: string | null;
  statusKey: string;
  status: string;
  open: boolean;
  warehouseOnHand: number;
  short: boolean;
  shortBy: number;
  supply: "NONE" | "WITH_PPIC" | "WITH_PURCHASE" | "ON_ORDER" | "RECEIVED";
  supplyLabel: string;
  eta: string | null;
  piNumber: string | null;
  requirementId: string | null;
  note: string | null;
  forPlan: boolean;
  forProductionRequestId: string | null;
  purchaseOrderItemId: string | null;
  productName: string | null;
  poNumber: string | null;
  customerName: string | null;
  plantName: string | null;
  overdue: boolean;
}

export function exportMaterialRequestsReport(rows: MaterialRequestRow[]) {
  download(
    "Material Requests",
    rows.map((r) => ({
      "Requested On": day(r.requestedAt),
      Status: r.status,
      "Requested By": r.requesterName,
      Person: r.requestedBy,
      Item: r.itemName,
      Category: CATEGORY_LABEL[r.category] ?? r.category,
      Unit: r.unit,
      "Requested Qty": r.requestedQty,
      "Issued Qty": r.issuedQty,
      "Remaining Qty": r.remainingQty,
      "Needed By": day(r.neededBy),
      "For Product": r.productName ?? "",
      "PO Number": r.poNumber ?? "",
      Plant: r.plantName ?? "",
      Overdue: r.overdue ? "Yes" : "",
      "Warehouse On Hand": r.warehouseOnHand,
      "Short By": r.shortBy || "",
      "Purchase Trail": r.supply === "NONE" ? "" : r.supplyLabel,
      "PI Number": r.piNumber ?? "",
      ETA: day(r.eta),
      Note: r.note ?? "",
    })),
    `FLS_Material_Requests_${todayStamp()}.xlsx`,
  );
}

export function exportIncomingReport(rows: IncomingRow[]) {
  download(
    "Incoming Material",
    rows.map((r) => ({
      Item: r.itemName,
      Category: CATEGORY_LABEL[r.category] ?? r.category,
      Unit: r.unit,
      "Expected Qty": r.quantity,
      "Ordered Qty": r.orderedQty,
      "PI Number": r.piNumber,
      "Vendor Name": r.vendorName,
      ETA: new Date(r.eta).toLocaleDateString(),
      Overdue: r.overdue ? "Yes" : "",
      "Customer PO": r.customerPo?.poNumber ?? "",
      Customer: r.customerPo?.customerName ?? "",
      "Customer Type": customerTypeLabel(r.customerPo?.customerName ?? ""),
      Product: r.customerPo?.productName ?? "",
    })),
    `FLS_Incoming_Material_${todayStamp()}.xlsx`,
  );
}

export function downloadPurchaseLogImportTemplate() {
  download(
    "PI Log",
    [
      { Item: "Whey Protein Concentrate", Category: "RM", "PI Number": "PI-RM-001", Quantity: 40, "Vendor Name": "Sunrise Ingredients", ETA: "24-08-2026" },
      { Item: "", Category: "", "PI Number": "", Quantity: "", "Vendor Name": "", ETA: "" },
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
