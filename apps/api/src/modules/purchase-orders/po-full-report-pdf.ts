import PDFDocument from "pdfkit";
import { drawTable } from "../../common/lib/pdf-table";
import type { PoFullReport, StageHistoryRow } from "./po-full-report";

const TIER1_LABELS: Record<string, string> = {
  grnNo: "GRN No.",
  grnDate: "GRN Date",
  materialReceivedRemarks: "Material Received Remarks",
  prodIndentSlipSign: "Production Indent Slip Sign",
  productionPlanDate: "Production Plan Date",
  unit: "Manufacturing Unit",
  dispatchPlanDate: "Dispatch Plan Date",
  lineClearanceStatus: "Line Clearance Status",
  lineClearanceRemarks: "Line Clearance Remarks",
  rmDispensingDate: "RM Dispensing Date",
  rmDispensingRemarks: "RM Dispensing Remarks",
  pmIssuedDate: "PM Issued Date",
  pmDispensingRemarks: "PM Dispensing Remarks",
  sampleQcStatus: "Sample QC Status",
  sampleQcRemarks: "Sample QC Remarks",
};

const TIER3_LABELS: Record<string, string> = {
  ipqcStatus: "IPQC Status",
  ipqcRemarks: "IPQC Remarks",
  bulkTheoreticalWeight: "Bulk Theoretical Weight",
  bulkActualWeight: "Bulk Actual Weight",
  bulkQcSampleWeight: "Bulk QC Sample Weight",
  bulkTransferToPackingQty: "Bulk Transfer to Packing Qty",
  mfgQaStatus: "QA Gate (Mfg) — QA Status",
  mfgQcStatus: "QA Gate (Mfg) — QC Status",
  mfgRemarks: "QA Gate (Mfg) Remarks",
  mfgApprovedQty: "Mfg Approved Qty",
  mfgRejectedQty: "Mfg Rejected Qty",
  mfgWastageQty: "Mfg Wastage Qty",
  bulkQcStatus: "Bulk QC Status",
  bulkQcRemarks: "Bulk QC Remarks",
  packagingStartDate: "Packaging Start",
  packagingStatus: "Packaging Status",
  packagingEndDate: "Packaging End",
  packagingRemarks: "Packaging Remarks",
  packQaStatus: "QA Gate (Packaging) — QA Status",
  packQcStatus: "QA Gate (Packaging) — QC Status",
  packRemarks: "QA Gate (Packaging) Remarks",
  packApprovedQty: "Pack Approved Qty",
  packRejectedQty: "Pack Rejected Qty",
  packWastageQty: "Pack Wastage Qty",
  fgStoreReceivedDate: "FG Store Received Date",
  fgStoreRemarks: "FG Store Remarks",
  fgQaStatus: "FG QC & Release — QA Status",
  fgQcStatus: "FG QC & Release — QC Status",
  fgRemarks: "FG QC & Release Remarks",
  invoiceNo: "Invoice No.",
  invoiceDate: "Invoice Date",
  ewayBillNo: "E-Way Bill No.",
  ewayBillDate: "E-Way Bill Date",
  billingRemarks: "Billing Remarks",
  dispatchDate: "Dispatch Date",
  dispatchedQty: "Dispatched Qty",
  shipperQty: "Shipper Qty",
  totalShipperWeight: "Total Shipper Weight",
  transportType: "Transport Type",
  remainingQty: "Remaining Qty",
  anyRemarks: "Any Remarks",
  pickedBy: "Picked By",
  pickingDate: "Picking Date",
  loadedBy: "Loaded By",
  loadingDate: "Loading Date",
};

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function drawFieldTable(doc: PDFKit.PDFDocument, fields: Record<string, unknown>, labels: Record<string, string>) {
  const rows = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [labels[k] ?? k, formatValue(v)]);
  if (rows.length === 0) return;
  ensureSpace(doc, 30);
  const y = drawTable(doc, { x: doc.page.margins.left, startY: doc.y + 2, columns: [{ header: "Field", width: 220 }, { header: "Value", width: 280 }], rows });
  doc.y = y + 4;
}

function drawHistoryTable(doc: PDFKit.PDFDocument, history: StageHistoryRow[]) {
  if (history.length === 0) return;
  ensureSpace(doc, 30);
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#64748b").text("History", doc.x, doc.y + 2);
  doc.fillColor("#000000");
  const rows = history.map((h) => [h.action, h.fromLabel, h.toLabel, h.actorName, h.createdAt.toISOString().slice(0, 16).replace("T", " "), h.note ?? "—"]);
  const y = drawTable(doc, {
    x: doc.page.margins.left,
    startY: doc.y + 2,
    columns: [
      { header: "Action", width: 55 },
      { header: "From", width: 100 },
      { header: "To", width: 100 },
      { header: "By", width: 90 },
      { header: "When", width: 90 },
      { header: "Note", width: 65 },
    ],
    rows,
  });
  doc.y = y + 6;
}

/**
 * The full, step-by-step story of one PO — every product line, its
 * PreProduction run, and every ProductionBatch under it, each with its
 * own field values and stage history. Shares its data shape with the
 * on-screen report (GET /:id/full-report) via po-full-report.ts's own
 * assembler, so this file is presentation only.
 */
export function buildPoFullReportPdf(report: PoFullReport): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const { po, items, totals } = report;

  doc.font("Helvetica-Bold").fontSize(18).text("FLS Mitr — Purchase Order Full Report");
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor("#475569")
    .text(`${po.customerName}${po.poNumber ? ` · PO ${po.poNumber}` : ""} · Status ${po.status}`);
  doc
    .fontSize(9)
    .text(
      `Order Date ${formatValue(po.orderDate)} · Expected Delivery ${formatValue(po.expectedDeliveryDate)} · ${totals.itemCount} product(s), ${totals.batchCount} batch(es) total · Planned ${totals.plannedTotal} · Dispatched ${totals.dispatchedTotal}`,
    );
  doc.fillColor("#000000");
  doc.moveDown(1);

  items.forEach((item, idx) => {
    ensureSpace(doc, 60);
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#0f172a")
      .text(`${idx + 1}. ${item.productName}`, doc.x, doc.y + 6);
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#475569")
      .text(`Ordered ${item.quantity} ${item.unit} · ${item.productType} · ${item.batchCount} batch(es) · Dispatched ${item.dispatchedTotal} ${item.unit}`);
    doc.fillColor("#000000");
    doc.moveDown(0.3);

    if (!item.preProduction) {
      doc.font("Helvetica-Oblique").fontSize(9).fillColor("#94a3b8").text("Production hasn't started on this line item yet.", doc.x, doc.y + 2);
      doc.fillColor("#000000");
      doc.moveDown(0.5);
      return;
    }

    const pp = item.preProduction;
    ensureSpace(doc, 24);
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#334155")
      .text(`Pre-Production — currently at ${pp.currentStageId} (${pp.combinedQty} / ${pp.plannedQty} produced)`, doc.x, doc.y + 4);
    doc.fillColor("#000000");
    drawFieldTable(doc, pp.tier1Fields, TIER1_LABELS);
    drawHistoryTable(doc, pp.history);

    if (item.batches.length === 0) {
      doc.font("Helvetica-Oblique").fontSize(9).fillColor("#94a3b8").text("No production batches created yet.", doc.x, doc.y + 2);
      doc.fillColor("#000000");
    } else {
      item.batches.forEach((b, bIdx) => {
        ensureSpace(doc, 40);
        doc
          .font("Helvetica-Bold")
          .fontSize(10)
          .fillColor("#334155")
          .text(`Batch ${bIdx + 1}${b.batchNo ? ` — ${b.batchNo}` : ""} — ${b.status}, Tier-3 stage: ${b.currentStageId}`, doc.x, doc.y + 8);
        doc.fillColor("#000000");
        const summaryRows = [
          ["Planned Qty", formatValue(b.plannedQty)],
          ["Manufacturing Start", formatValue(b.manufacturingStartDate)],
          ["Manufacturing End", formatValue(b.manufacturingEndDate)],
          ["Input Qty", formatValue(b.inputQty)],
          ["Output Qty", formatValue(b.outputQty)],
          ["Wastage Qty", formatValue(b.wastageQty)],
        ];
        ensureSpace(doc, 30);
        const y = drawTable(doc, { x: doc.page.margins.left, startY: doc.y + 2, columns: [{ header: "Field", width: 220 }, { header: "Value", width: 280 }], rows: summaryRows });
        doc.y = y + 4;
        drawFieldTable(doc, b.tier3Fields, TIER3_LABELS);
        drawHistoryTable(doc, b.history);
      });
    }
    doc.moveDown(0.5);
  });

  return doc;
}
