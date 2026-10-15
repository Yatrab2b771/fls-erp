import * as XLSX from "xlsx";
import type { PurchaseOrder } from "./types";
import { BD_PLANNING_METRIC_LABEL, getBdPlanningRows, isPoDelayed, type BdPlanningMetric, type BdPlanningResult } from "./bdPlanning";
import { customerTypeLabel } from "./customerTags";

function download(sheetName: string, rows: Record<string, unknown>[], filename: string) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

// One Excel export per BD dashboard tile — reads the exact same rows the
// tile's own drill-down page shows (see bdPlanning.ts), so what gets
// downloaded always matches what's on screen.
export function exportBdPlanningReport(
  metric: BdPlanningMetric,
  orders: PurchaseOrder[],
  // The rows as filtered on the tile's page; without it the tile's full list is exported.
  filtered?: BdPlanningResult,
  typeOfRun?: (poNumber: string | null, productName: string) => string,
): number {
  const result = filtered ?? getBdPlanningRows(metric, orders);
  const label = BD_PLANNING_METRIC_LABEL[metric];

  let lines: Record<string, unknown>[];
  if (result.kind === "po") {
    lines = result.rows.map((po) => ({
      "PO Number": po.poNumber ?? po.id.slice(0, 8),
      Status: po.status,
      Customer: po.customer.companyName,
      "Customer Type": customerTypeLabel(po.customer.companyName),
      "Order Date": po.orderDate?.slice(0, 10) ?? "",
      "Expected Delivery": po.expectedDeliveryDate?.slice(0, 10) ?? "",
      "Product Count": po.items.length,
      "Product Types": [...new Set(po.items.filter((i) => !i.cancelledAt).map((i) => i.productCategory).filter(Boolean))].join(", "),
      Completed: po.completion.isCompleted ? "Yes" : "No",
      Delayed: isPoDelayed(po) ? "Yes" : "No",
    }));
  } else if (result.kind === "item") {
    lines = result.rows.map(({ po, item }) => ({
      "PO Number": po.poNumber ?? po.id.slice(0, 8),
      "PO Status": po.status,
      Customer: po.customer.companyName,
      "Customer Type": customerTypeLabel(po.customer.companyName),
      Product: item.productName,
      "Product Type": item.productCategory ?? "",
      Quantity: item.quantity,
      Unit: item.unit,
      Completed: po.completion.isCompleted ? "Yes" : "No",
    }));
  } else {
    lines = result.rows.map((r) => ({
      "PO Number": r.poNumber ?? "",
      "Current Stage": r.stage,
      Customer: r.customerName,
      "Customer Type": customerTypeLabel(r.customerName),
      Product: r.productName,
      "Product Type": typeOfRun?.(r.poNumber, r.productName) ?? "",
    }));
  }

  download(label, lines, `FLS_BD_${metric.replace(/-/g, "_")}_${todayStamp()}.xlsx`);
  return lines.length;
}
