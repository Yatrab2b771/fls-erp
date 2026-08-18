import PDFDocument from "pdfkit";
import { drawTable } from "../../common/lib/pdf-table";
import type { BatchCostingResult, ProcurementLine } from "./rm-costing-engine";

/**
 * The per-batch "Bill of Material (RM)" dispensing sheet, ported from
 * `printIndividualBMR()`. `req` per ingredient is the same qtyInKg the
 * costing engine already computed (identical formula: gPerServing/totalServing * batchSize).
 */
export function buildBatchDispensingPdf(batch: BatchCostingResult): PDFKit.PDFDocument {
  const doc = new PDFDocument({ layout: "landscape", size: "A4", margin: 30 });

  doc.font("Helvetica-Bold").fontSize(16).text("FERMENTIS LIFE SCIENCES PVT. LTD.", { align: "center" });
  doc
    .font("Helvetica-Oblique")
    .fontSize(9)
    .text("Plot No. 41, Sector 8, IMT Manesar, Gurugram", { align: "center" });
  doc.moveDown(0.5);
  doc.font("Helvetica-Bold").fontSize(13).text("BILL OF MATERIAL (RM)", { align: "center", underline: true });
  doc.moveDown(0.5);

  doc.font("Helvetica").fontSize(10);
  doc.text(`Product: ${batch.recipeName}`, { continued: true, width: 400 });
  doc.text(`Batch Size: ${batch.batchSizeKg} Kg`, { align: "right" });
  doc.text("Batch No.: _______________");
  doc.moveDown(0.5);

  const columns = [
    { header: "S.No.", width: 40, align: "center" as const },
    { header: "Ingredients", width: 220 },
    { header: "Make", width: 140 },
    { header: "UOM", width: 50, align: "center" as const },
    { header: "Qty./Kg", width: 80, align: "right" as const },
    { header: "Req./Batch", width: 90, align: "right" as const },
    { header: "Issued", width: 70, align: "center" as const },
    { header: "A.R. No.", width: 90, align: "center" as const },
  ];

  let totalPerKg = 0;
  let totalBatchKg = 0;
  const rows = batch.ingredients.map((ing, idx) => {
    const prop = ing.gPerServing / batch.gmPerServing;
    totalPerKg += prop;
    totalBatchKg += ing.qtyInKg;
    return [idx + 1, ing.name, ing.brand, "Kg", prop.toFixed(4), ing.qtyInKg.toFixed(3), "", ""];
  });
  rows.push(["", "TOTAL", "", "Kg", totalPerKg.toFixed(3), totalBatchKg.toFixed(3), "", ""]);

  const endY = drawTable(doc, { x: doc.page.margins.left, startY: doc.y + 5, columns, rows });

  doc.y = endY + 30;
  doc.font("Helvetica").fontSize(10);
  const signX = doc.page.margins.left;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.text("Raised By:", signX, doc.y);
  doc.text("Checked By:", signX + pageWidth / 3, doc.y - doc.currentLineHeight());
  doc.text("Verified By:", signX + (2 * pageWidth) / 3, doc.y - doc.currentLineHeight());

  return doc;
}

/** The consolidated "Master Procurement Ledger" PDF, ported from `exportMasterPDF()`. */
export function buildMasterProcurementPdf(
  procurement: ProcurementLine[],
  meta: { planName: string; dateFrom?: string | null; dateTo?: string | null },
): PDFKit.PDFDocument {
  const doc = new PDFDocument({ layout: "landscape", size: "A4", margin: 30 });

  doc.font("Helvetica-Bold").fontSize(18).text("FERMENTIS LIFESCIENCES");
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor("#059669")
    .text(`Master Procurement Ledger — ${meta.planName} (Horizon: ${meta.dateFrom ?? "Unset"} to ${meta.dateTo ?? "Unset"})`);
  doc.fillColor("#000000");
  doc.moveDown(0.5);

  const columns = [
    { header: "S.No", width: 50, align: "center" as const },
    { header: "Ingredient", width: 280 },
    { header: "Make", width: 200 },
    { header: "Total Mass (KG)", width: 150, align: "right" as const },
  ];
  const rows = procurement.map((item, i) => [i + 1, item.name, item.brand, item.totalKg.toFixed(3)]);

  drawTable(doc, { x: doc.page.margins.left, startY: doc.y + 5, columns, rows });

  return doc;
}
