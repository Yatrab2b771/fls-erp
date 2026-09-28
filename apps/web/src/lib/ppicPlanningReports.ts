import * as XLSX from "xlsx";
import type { PurchaseOrder } from "./types";
import { getPpicPlanningRows, hasCalculatedBom, hasCalculatedRm, PPIC_PLANNING_METRIC_LABEL, type PpicPlanningMetric } from "./ppicPlanning";

function download(sheetName: string, rows: Record<string, unknown>[], filename: string) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

// One Excel export per PPIC planning tile — reads the exact same rows
// the tile's own drill-down page shows (see ppicPlanning.ts), so what
// gets downloaded always matches what's on screen.
export function exportPpicPlanningReport(metric: PpicPlanningMetric, orders: PurchaseOrder[]): number {
  const result = getPpicPlanningRows(metric, orders);
  const label = PPIC_PLANNING_METRIC_LABEL[metric];

  const lines =
    result.kind === "po"
      ? result.rows.map((po) => ({
          "PO Number": po.poNumber ?? po.id.slice(0, 8),
          Customer: po.customer.companyName,
          "Order Date": po.orderDate?.slice(0, 10) ?? "",
          Status: po.status,
          "Product Count": po.items.length,
          Completed: po.completion.isCompleted ? "Yes" : "No",
        }))
      : result.rows.map(({ po, item }) => ({
          "PO Number": po.poNumber ?? po.id.slice(0, 8),
          Customer: po.customer.companyName,
          Product: item.productName,
          Quantity: item.quantity,
          Unit: item.unit,
          "Packaging BOM": hasCalculatedBom(item) ? "Yes" : "No",
          "RM BOM": hasCalculatedRm(item) ? "Yes" : "No",
          "Plan Sent to Production": item.planSentToProductionAt ? item.planSentToProductionAt.slice(0, 10) : "No",
        }));

  download(label, lines, `FLS_PPIC_${metric.replace(/-/g, "_")}_${todayStamp()}.xlsx`);
  return lines.length;
}
