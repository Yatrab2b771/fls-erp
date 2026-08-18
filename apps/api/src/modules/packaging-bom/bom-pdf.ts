import PDFDocument from "pdfkit";
import { drawTable } from "../../common/lib/pdf-table";
import type { BomResult } from "./bom-engine";

/**
 * The consolidated "Master Procurement" ledger PDF, ported from the
 * prototype's `exportPDF()` (workplace/index (2).html) — there it rendered
 * the on-screen table to canvas via html2pdf; here it's built server-side
 * with pdfkit so the file is identical no matter who downloads it, same
 * rationale as the Excel export.
 */
export function buildMasterBomPdf(
  result: BomResult,
  meta: { planName: string; dateFrom?: string | null; dateTo?: string | null },
): PDFKit.PDFDocument {
  const doc = new PDFDocument({ layout: "landscape", size: "A3", margin: 30 });

  doc.font("Helvetica-Bold").fontSize(18).text("FLS ERP — Master Packaging BOM");
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor("#059669")
    .text(`${meta.planName} (Horizon: ${meta.dateFrom ?? "Unset"} to ${meta.dateTo ?? "Unset"}) — Total Yield: ${result.totalYield}`);
  doc.fillColor("#000000");
  doc.moveDown(0.5);

  const columns = [
    { header: "Category", width: 90 },
    { header: "Component", width: 180 },
    { header: "Specification", width: 220 },
    { header: "Base Requirement", width: 120, align: "right" as const },
    { header: "Wastage Buffer", width: 110, align: "right" as const },
    { header: "Total To Procure", width: 120, align: "right" as const },
    { header: "Allocation Sources", width: 300 },
  ];

  const rows = result.lines.map((line) => [
    line.category.split("-")[1] ?? line.category,
    line.component,
    line.spec,
    line.baseQty,
    line.bufferQty,
    line.totalQty,
    Object.entries(line.sources)
      .map(([src, qty]) => `${src}: ${qty}`)
      .join(" | "),
  ]);

  drawTable(doc, { x: doc.page.margins.left, startY: doc.y + 5, columns, rows });

  return doc;
}
