import * as XLSX from "xlsx";
import type { PoWastageRejectionRow, PurchaseOrder } from "./types";

function download(sheetName: string, rows: Record<string, unknown>[], filename: string) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

// One row per PO — Order Date, Status, and (once every batch on every
// line item has shipped and been customer-confirmed — see
// PurchaseOrder.completion, computed server-side) Completion Date and
// Days Taken. Rows for a PO that isn't complete yet just show blanks
// for those last two columns, not zero — there's nothing to report
// until it's actually done.
export function exportPurchaseOrdersReport(orders: PurchaseOrder[]) {
  download(
    "Purchase Orders",
    orders.map((po) => ({
      "PO Number": po.poNumber ?? po.id.slice(0, 8),
      Customer: po.customer.companyName,
      Brand: po.brandName ?? "",
      "Order Date": po.orderDate ? new Date(po.orderDate).toLocaleDateString() : "",
      Status: po.status,
      Products: po.items.length,
      Completed: po.completion.isCompleted ? "Yes" : "No",
      "Completion Date": po.completion.completionDate ? new Date(po.completion.completionDate).toLocaleDateString() : "",
      "Days Taken": po.completion.daysTaken ?? "",
    })),
    `FLS_Purchase_Orders_${todayStamp()}.xlsx`,
  );
}

// Report #1 — customer-wise pending PO list, with aging. "Pending" =
// not yet Completed (see PurchaseOrder.completion) and not Rejected —
// a rejected PO isn't waiting on anything, it's simply closed out.
// Aging is measured the same way completion's own daysTaken is: from
// orderDate, falling back to createdAt when BD never filled one in —
// so a PO's aging figure and its eventual "days taken" land on the same
// scale once it finishes.
export function exportPendingPoAgingReport(orders: PurchaseOrder[]) {
  const now = Date.now();
  const dayMs = 1000 * 60 * 60 * 24;
  const pending = orders
    .filter((po) => po.status !== "REJECTED" && !po.completion.isCompleted)
    .map((po) => {
      const startDate = po.orderDate ?? po.createdAt;
      const agingDays = Math.max(0, Math.round((now - new Date(startDate).getTime()) / dayMs));
      return { po, agingDays };
    })
    .sort((a, b) => b.agingDays - a.agingDays);

  download(
    "Pending PO Aging",
    pending.map(({ po, agingDays }) => ({
      Customer: po.customer.companyName,
      "PO Number": po.poNumber ?? po.id.slice(0, 8),
      Brand: po.brandName ?? "",
      "Order Date": po.orderDate ? new Date(po.orderDate).toLocaleDateString() : "",
      Status: po.status,
      Products: po.items.length,
      "Aging (Days)": agingDays,
    })),
    `FLS_Pending_PO_Aging_${todayStamp()}.xlsx`,
  );
}

// Report #6 — customer-wise, PO-wise wastage & rejection. Scoped to what
// Production/QC have actually recorded on a Batch (mechanical/process
// wastage, and QC's own rejection figure at the manufacturing gate) —
// inward-QC material rejections and outward-QC shipment rejections
// aren't tied to one specific PO in the data model the way a Batch is,
// so they're covered by the existing Material Received / Dispatch
// Transfer reports instead, not duplicated here.
export function exportWastageRejectionReport(rows: PoWastageRejectionRow[]) {
  download(
    "Wastage & Rejection",
    rows.map((r) => ({
      Customer: r.customerName,
      "PO Number": r.poNumber,
      Product: r.productName,
      "Batch No": r.batchNo ?? "",
      Unit: r.unit ?? "",
      "Input Qty": r.inputQty ?? "",
      "Output Qty": r.outputQty ?? "",
      "Wastage Qty": r.wastageQty ?? "",
      "QC Rejected Qty": r.mfgRejectedQty ?? "",
    })),
    `FLS_PO_Wastage_Rejection_${todayStamp()}.xlsx`,
  );
}
