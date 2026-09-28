import * as XLSX from "xlsx";
import type { PurchaseOrder } from "./types";
import { getRegulatoryPlanningRows, REGULATORY_PLANNING_METRIC_LABEL, type RegulatoryPlanningMetric } from "./regulatoryPlanning";

function download(sheetName: string, rows: Record<string, unknown>[], filename: string) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function exportRegulatoryPlanningReport(metric: RegulatoryPlanningMetric, orders: PurchaseOrder[]): number {
  const rows = getRegulatoryPlanningRows(metric, orders);
  const label = REGULATORY_PLANNING_METRIC_LABEL[metric];

  const lines = rows.map(({ po, item }) => ({
    "PO Number": po.poNumber ?? po.id.slice(0, 8),
    Customer: po.customer.companyName,
    Product: item.productName,
    Quantity: item.quantity,
    Unit: item.unit,
    "Regulatory Body": po.regulatoryBody ?? "",
    "Regulatory Status": item.regulatoryStatus ?? "Pending Review",
    Remarks: item.regulatoryRemarks ?? "",
    "Reviewed At": item.regulatoryReviewedAt?.slice(0, 10) ?? "",
  }));

  download(label, lines, `FLS_Regulatory_${metric.replace(/-/g, "_")}_${todayStamp()}.xlsx`);
  return lines.length;
}
