import PDFDocument from "pdfkit";
import { drawTable } from "../../common/lib/pdf-table";
import { computeWastage } from "./batch.engine";
import { BATCH_STAGE_LABEL, type BatchStageId } from "./batch-stage";
import type { BatchWithRelations } from "./batches.routes";

/**
 * The admin's "full report" export — every field the batch collected
 * across its whole lifecycle, stage by stage, plus the complete
 * forward/reject/jump history. Available once a batch reaches Dispatch
 * Plan (see the route gate), so it reads as the batch's closing record
 * rather than a snapshot of a still-moving pipeline.
 */

type FieldRow = { key: keyof BatchWithRelations; label: string };

// One group per stage that actually collects data — mirrors
// BATCH_STAGE_FIELD_SCHEMA in batch.schemas.ts, but as display labels
// rather than validators.
const REPORT_SECTIONS: { stage: BatchStageId; fields: FieldRow[] }[] = [
  {
    stage: "PO_RELEASE",
    fields: [
      { key: "rmPoDate", label: "RM PO Date" },
      { key: "rmExpectedDate", label: "RM Expected Date" },
      { key: "rmStatus", label: "RM Status" },
      { key: "rmRemarks", label: "RM Remarks" },
      { key: "pmPoDate", label: "PM PO Date" },
      { key: "pmExpectedDate", label: "PM Expected Date" },
      { key: "pmStatus", label: "PM Status" },
      { key: "pmRemarks", label: "PM Remarks" },
    ],
  },
  {
    stage: "INDENT_ISSUE",
    fields: [
      { key: "batchNo", label: "Batch No." },
      { key: "prodIndentSlipSign", label: "Production Indent Slip Sign" },
      { key: "productionPlanDate", label: "Production Plan Date" },
      { key: "unit", label: "Manufacturing Unit" },
      { key: "dispatchPlanDate", label: "Dispatch Plan Date" },
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
    stage: "PRODUCTION_EXECUTION",
    fields: [
      { key: "manufacturingStartDate", label: "Manufacturing Start" },
      { key: "manufacturingStatus", label: "Manufacturing Status" },
      { key: "manufacturingEndDate", label: "Manufacturing End" },
      { key: "manufacturingRemarks", label: "Manufacturing Remarks" },
      { key: "inputQty", label: "Input Qty" },
      { key: "outputQty", label: "Output Qty" },
    ],
  },
  {
    stage: "QA_GATE_MFG",
    fields: [
      { key: "mfgQaStatus", label: "QA Status" },
      { key: "mfgQcStatus", label: "QC Status" },
      { key: "mfgRemarks", label: "Remarks" },
      { key: "mfgRejectedQty", label: "Rejected Qty (quality)" },
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
    stage: "DISPATCH_PLAN",
    fields: [
      { key: "dispatchDate", label: "Dispatch Date" },
      { key: "dispatchedQty", label: "Dispatched Qty" },
      { key: "shipperQty", label: "Shipper Qty" },
      { key: "totalShipperWeight", label: "Total Shipper Weight" },
      { key: "transportType", label: "Transport Type" },
      { key: "remainingQty", label: "Remaining Qty" },
      { key: "customerConfirmation", label: "Customer Confirmation" },
      { key: "anyRemarks", label: "Any Remarks" },
    ],
  },
];

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export function buildBatchReportPdf(batch: BatchWithRelations): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const po = batch.purchaseOrderItem.purchaseOrder;

  doc.font("Helvetica-Bold").fontSize(18).text("FLS ERP — Batch Report");
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor("#475569")
    .text(`${batch.batchNo ?? batch.id.slice(0, 8)} · ${batch.purchaseOrderItem.productName} · ${po.customer.companyName}${po.poNumber ? ` · PO ${po.poNumber}` : ""}`);
  doc.fillColor("#000000");
  doc.moveDown(1);

  for (const section of REPORT_SECTIONS) {
    // Every field is shown, filled or not ("—") — this is the batch's
    // closing record, not a progress view, so a blank field is itself
    // information (nobody recorded it).
    const rows = section.fields.map((f) => [f.label, formatValue((batch as unknown as Record<string, unknown>)[f.key])]);

    // Wastage is derived (inputQty - outputQty), never a raw field —
    // append it as its own row right after the two numbers it comes from.
    if (section.stage === "PRODUCTION_EXECUTION") {
      const { wastageQty, wastagePct } = computeWastage(batch);
      rows.push(["Wastage", wastageQty === null ? "—" : `${wastageQty} (${wastagePct}%)`]);
    }

    if (doc.y + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor("#334155")
      .text(BATCH_STAGE_LABEL[section.stage], doc.x, doc.y + 8);
    doc.fillColor("#000000");

    const y = drawTable(doc, {
      x: doc.page.margins.left,
      startY: doc.y + 4,
      columns: [
        { header: "Field", width: 220 },
        { header: "Value", width: 300 },
      ],
      rows,
    });
    doc.y = y + 6;
  }

  // History — the full audit trail: every forward, send-back and admin
  // jump this batch went through.
  if (doc.y + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#334155").text("Stage History", doc.x, doc.y + 10);
  doc.fillColor("#000000");

  const historyRows = batch.stageEvents.map((e) => [
    e.action,
    BATCH_STAGE_LABEL[e.fromStageId as BatchStageId] ?? e.fromStageId,
    BATCH_STAGE_LABEL[e.toStageId as BatchStageId] ?? e.toStageId,
    e.actor.fullName || e.actor.email,
    new Date(e.createdAt).toISOString().slice(0, 16).replace("T", " "),
    e.note ?? "—",
  ]);

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
