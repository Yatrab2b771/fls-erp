import * as XLSX from "xlsx";
import type { CombinedLot, PreProduction, ProductionBatch, PurchaseOrder } from "./types";
import { BD_PLANNING_METRIC_LABEL, getBdPlanningRows, isPoDelayed, type BdPlanningMetric } from "./bdPlanning";

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
  activeProduction: { preRuns: PreProduction[]; lots: CombinedLot[]; batches: ProductionBatch[] },
): number {
  const result = getBdPlanningRows(metric, orders, activeProduction);
  const label = BD_PLANNING_METRIC_LABEL[metric];

  let lines: Record<string, unknown>[];
  if (result.kind === "po") {
    lines = result.rows.map((po) => ({
      "PO Number": po.poNumber ?? po.id.slice(0, 8),
      Customer: po.customer.companyName,
      "Order Date": po.orderDate?.slice(0, 10) ?? "",
      "Expected Delivery": po.expectedDeliveryDate?.slice(0, 10) ?? "",
      Status: po.status,
      "Product Count": po.items.length,
      Completed: po.completion.isCompleted ? "Yes" : "No",
      Delayed: isPoDelayed(po) ? "Yes" : "No",
    }));
  } else if (result.kind === "item") {
    lines = result.rows.map(({ po, item }) => ({
      "PO Number": po.poNumber ?? po.id.slice(0, 8),
      Customer: po.customer.companyName,
      Product: item.productName,
      Quantity: item.quantity,
      Unit: item.unit,
      "PO Status": po.status,
      Completed: po.completion.isCompleted ? "Yes" : "No",
    }));
  } else {
    lines = result.rows.map((r) => ({
      "PO Number": r.poNumber ?? "",
      Customer: r.customerName,
      Product: r.productName,
      "Current Stage": r.stage,
    }));
  }

  download(label, lines, `FLS_BD_${metric.replace(/-/g, "_")}_${todayStamp()}.xlsx`);
  return lines.length;
}
