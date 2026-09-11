import PDFDocument from "pdfkit";
import { drawTable } from "../../common/lib/pdf-table";
import { computeWastage } from "./batch.engine";
import { PRE_PRODUCTION_STAGE_LABEL, type PreProductionStageId } from "./pre-production-stage";
import { COMBINED_LOT_STAGE_LABEL, type CombinedLotStageId } from "./combined-lot-stage";
import type { PreProductionWithRelations } from "./batch-include";
import type { CombinedLotWithRelations } from "./batch-include";

/**
 * The admin's "full report" export — every field the pipeline collected
 * across a PO item's whole run, tier by tier, plus the complete
 * forward/reject/jump history of both the PreProduction run and its
 * CombinedLot. Available once the CombinedLot reaches Dispatch Plan (see
 * the route gate), so it reads as the run's closing record rather than a
 * snapshot of a still-moving pipeline. Individual ProductionBatch runs
 * (Tier 2) get their own short table since there can be several.
 */

type PreProductionFieldRow = { key: keyof PreProductionWithRelations; label: string };
type CombinedLotFieldRow = { key: keyof CombinedLotWithRelations; label: string };

const PRE_PRODUCTION_SECTIONS: { stage: PreProductionStageId; fields: PreProductionFieldRow[] }[] = [
  {
    stage: "MATERIAL_RECEIVED",
    fields: [
      { key: "grnNo", label: "GRN No." },
      { key: "grnDate", label: "GRN Date" },
      { key: "materialReceivedRemarks", label: "Remarks" },
    ],
  },
  {
    stage: "INDENT_ISSUE",
    fields: [
      { key: "prodIndentSlipSign", label: "Production Indent Slip Sign" },
      { key: "productionPlanDate", label: "Production Plan Date" },
      { key: "unit", label: "Manufacturing Unit" },
      { key: "dispatchPlanDate", label: "Dispatch Plan Date" },
    ],
  },
  {
    stage: "LINE_CLEARANCE",
    fields: [
      { key: "lineClearanceStatus", label: "Line Clearance Status" },
      { key: "lineClearanceRemarks", label: "Remarks" },
    ],
  },
  {
    stage: "DISPENSING",
    fields: [
      { key: "rmDispensingDate", label: "RM Dispensing Date" },
      { key: "rmDispensingRemarks", label: "RM Dispensing Remarks" },
      { key: "pmIssuedDate", label: "PM Issued Date" },
      { key: "pmDispensingRemarks", label: "PM Dispensing Remarks" },
    ],
  },
  {
    stage: "SAMPLE_QC_APPROVAL",
    fields: [
      { key: "sampleQcStatus", label: "Sample QC Status" },
      { key: "sampleQcRemarks", label: "Remarks" },
    ],
  },
];

const COMBINED_LOT_SECTIONS: { stage: CombinedLotStageId; fields: CombinedLotFieldRow[] }[] = [
  {
    stage: "IPQC",
    fields: [
      { key: "ipqcStatus", label: "IPQC Status" },
      { key: "ipqcRemarks", label: "Remarks" },
      { key: "bulkTheoreticalWeight", label: "Bulk Theoretical Weight" },
      { key: "bulkActualWeight", label: "Bulk Actual Weight" },
      { key: "bulkQcSampleWeight", label: "Bulk QC Sample Weight" },
      { key: "bulkTransferToPackingQty", label: "Bulk Transfer to Packing Qty" },
    ],
  },
  {
    stage: "QA_GATE_MFG",
    fields: [
      { key: "mfgQaStatus", label: "QA Status" },
      { key: "mfgQcStatus", label: "QC Status" },
      { key: "mfgRemarks", label: "Remarks" },
      { key: "mfgApprovedQty", label: "Approved Qty" },
      { key: "mfgRejectedQty", label: "Rejected Qty (quality)" },
      { key: "mfgWastageQty", label: "Wastage Qty" },
    ],
  },
  {
    stage: "BULK_QC",
    fields: [
      { key: "bulkQcStatus", label: "Bulk QC Status" },
      { key: "bulkQcRemarks", label: "Remarks" },
    ],
  },
  {
    stage: "PACKAGING",
    fields: [
      { key: "packagingStartDate", label: "Packaging Start" },
      { key: "packagingStatus", label: "Packaging Status" },
      { key: "packagingEndDate", label: "Packaging End" },
      { key: "packagingRemarks", label: "Packaging Remarks" },
    ],
  },
  {
    stage: "QA_GATE_PACKAGING",
    fields: [
      { key: "packQaStatus", label: "QA Status" },
      { key: "packQcStatus", label: "QC Status" },
      { key: "packRemarks", label: "Remarks" },
    ],
  },
  {
    stage: "BILLING_EWAY_BILL",
    fields: [
      { key: "invoiceNo", label: "Invoice No." },
      { key: "invoiceDate", label: "Invoice Date" },
      { key: "ewayBillNo", label: "E-Way Bill No." },
      { key: "ewayBillDate", label: "E-Way Bill Date" },
    ],
  },
  {
    stage: "DISPATCH_PLAN",
    fields: [
      { key: "dispatchDate", label: "Dispatch Date" },
      { key: "dispatchedQty", label: "Dispatched Qty" },
      { key: "shipperQty", label: "Shipper Qty" },
      { key: "totalShipperWeight", label: "Total Shipper Weight" },
      { key: "transportType", label: "Transport Type" },
      { key: "remainingQty", label: "Remaining Qty" },
      { key: "anyRemarks", label: "Any Remarks" },
    ],
  },
];

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export function buildBatchReportPdf(preProduction: PreProductionWithRelations, lot: CombinedLotWithRelations): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const po = preProduction.purchaseOrderItem.purchaseOrder;

  doc.font("Helvetica-Bold").fontSize(18).text("FLS Mitr — Production Report");
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor("#475569")
    .text(`${preProduction.purchaseOrderItem.productName} · ${po.customer.companyName}${po.poNumber ? ` · PO ${po.poNumber}` : ""} · Planned ${preProduction.plannedQty} ${preProduction.purchaseOrderItem.unit}`);
  doc.fillColor("#000000");
  doc.moveDown(1);

  for (const section of PRE_PRODUCTION_SECTIONS) {
    const rows = section.fields.map((f) => [f.label, formatValue((preProduction as unknown as Record<string, unknown>)[f.key])]);
    if (doc.y + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#334155").text(PRE_PRODUCTION_STAGE_LABEL[section.stage], doc.x, doc.y + 8);
    doc.fillColor("#000000");
    const y = drawTable(doc, { x: doc.page.margins.left, startY: doc.y + 4, columns: [{ header: "Field", width: 220 }, { header: "Value", width: 300 }], rows });
    doc.y = y + 6;
  }

  // Tier 2 — every small manufacturing run that pooled into this lot.
  if (doc.y + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#334155").text("Production Execution Runs", doc.x, doc.y + 10);
  doc.fillColor("#000000");
  const batchRows = preProduction.productionBatches.map((b) => {
    const { wastageQty } = computeWastage(b);
    return [b.batchNo ?? b.id.slice(0, 8), formatValue(b.manufacturingStartDate), formatValue(b.manufacturingEndDate), formatValue(b.inputQty), formatValue(b.outputQty), formatValue(wastageQty)];
  });
  if (batchRows.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#94a3b8").text("No production runs recorded.", doc.x, doc.y + 2);
    doc.fillColor("#000000");
  } else {
    drawTable(doc, {
      x: doc.page.margins.left,
      startY: doc.y + 4,
      columns: [
        { header: "Batch No.", width: 80 },
        { header: "Start", width: 80 },
        { header: "End", width: 80 },
        { header: "Input", width: 65 },
        { header: "Output", width: 65 },
        { header: "Wastage", width: 65 },
      ],
      rows: batchRows,
    });
  }

  for (const section of COMBINED_LOT_SECTIONS) {
    const rows = section.fields.map((f) => [f.label, formatValue((lot as unknown as Record<string, unknown>)[f.key])]);
    if (doc.y + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#334155").text(COMBINED_LOT_STAGE_LABEL[section.stage], doc.x, doc.y + 8);
    doc.fillColor("#000000");
    const y = drawTable(doc, { x: doc.page.margins.left, startY: doc.y + 4, columns: [{ header: "Field", width: 220 }, { header: "Value", width: 300 }], rows });
    doc.y = y + 6;
  }

  // History — the full audit trail: every forward, send-back and admin
  // jump both the PreProduction run and its CombinedLot went through.
  if (doc.y + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#334155").text("Stage History", doc.x, doc.y + 10);
  doc.fillColor("#000000");

  const historyRows = [
    ...preProduction.stageEvents.map((e) => [
      e.action,
      PRE_PRODUCTION_STAGE_LABEL[e.fromStageId as PreProductionStageId] ?? e.fromStageId,
      PRE_PRODUCTION_STAGE_LABEL[e.toStageId as PreProductionStageId] ?? e.toStageId,
      e.actor.fullName || e.actor.email,
      new Date(e.createdAt).toISOString().slice(0, 16).replace("T", " "),
      e.note ?? "—",
    ]),
    ...lot.stageEvents.map((e) => [
      e.action,
      COMBINED_LOT_STAGE_LABEL[e.fromStageId as CombinedLotStageId] ?? e.fromStageId,
      COMBINED_LOT_STAGE_LABEL[e.toStageId as CombinedLotStageId] ?? e.toStageId,
      e.actor.fullName || e.actor.email,
      new Date(e.createdAt).toISOString().slice(0, 16).replace("T", " "),
      e.note ?? "—",
    ]),
  ];

  if (historyRows.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#94a3b8").text("No stage transitions recorded.", doc.x, doc.y + 2);
    doc.fillColor("#000000");
  } else {
    drawTable(doc, {
      x: doc.page.margins.left,
      startY: doc.y + 4,
      columns: [
        { header: "Action", width: 55 },
        { header: "From", width: 95 },
        { header: "To", width: 95 },
        { header: "By", width: 90 },
        { header: "When", width: 90 },
        { header: "Note", width: 90 },
      ],
      rows: historyRows,
    });
  }

  return doc;
}
