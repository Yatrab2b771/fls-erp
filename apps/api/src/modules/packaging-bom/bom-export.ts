import ExcelJS from "exceljs";
import type { BomResult } from "./bom-engine";

/**
 * Builds the same "Master BOM" workbook the prototype produced client-side
 * with `XLSX.utils.json_to_sheet`, but generated server-side so the export
 * is identical no matter who downloads it.
 */
export async function buildMasterBomWorkbook(
  result: BomResult,
  meta: { planName: string; dateFrom?: string | null; dateTo?: string | null },
): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "FLS ERP";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Master BOM");

  sheet.columns = [
    { header: "Plan", key: "plan", width: 24 },
    { header: "Plan Start", key: "planStart", width: 14 },
    { header: "Plan End", key: "planEnd", width: 14 },
    { header: "Category", key: "category", width: 12 },
    { header: "Component", key: "component", width: 24 },
    { header: "Specification", key: "spec", width: 28 },
    { header: "Base Requirement", key: "base", width: 16 },
    { header: "Wastage Buffer", key: "buffer", width: 14 },
    { header: "Total To Procure", key: "total", width: 16 },
    { header: "Allocation Sources (Brand - SKU: Qty)", key: "sources", width: 50 },
  ];
  sheet.getRow(1).font = { bold: true };

  const planStart = meta.dateFrom ?? "Unset";
  const planEnd = meta.dateTo ?? "Unset";

  for (const line of result.lines) {
    sheet.addRow({
      plan: meta.planName,
      planStart,
      planEnd,
      category: line.category.split("-")[1] ?? line.category,
      component: line.component,
      spec: line.spec,
      base: line.baseQty,
      buffer: line.bufferQty,
      total: line.totalQty,
      sources: Object.entries(line.sources)
        .map(([src, qty]) => `${src}: ${qty}`)
        .join(" | "),
    });
  }

  sheet.getColumn("base").numFmt = "#,##0";
  sheet.getColumn("buffer").numFmt = "#,##0";
  sheet.getColumn("total").numFmt = "#,##0";

  return workbook.xlsx.writeBuffer();
}
