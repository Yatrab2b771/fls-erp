import PDFDocument from "pdfkit";
import { drawTable } from "../../common/lib/pdf-table";
import { computeWastage } from "./batch.engine";
import { COMBINED_LOT_STAGE_LABEL, type CombinedLotStageId } from "./combined-lot-stage";
import type { ProductionBatchWithRelations } from "./batch-include";

export interface ChecklistRow {
  itemKey: string;
  label: string;
  deptOk: boolean | null;
  qaOk: boolean | null;
}

export interface RecipeIngredientConsumptionRow {
  itemName: string;
  purpose: string;
  quantity: number;
  unit: string;
  grossWeight: number | null;
  tareWeight: number | null;
  netWeight: number | null;
  arNo: string | null;
}

/**
 * The full Batch Manufacturing Record (BMR) for one Production Batch —
 * everything the client's own paper BMR-1.docx/POWDER BMR.docx captures,
 * pulled from what the system actually recorded for this run: the Line
 * Clearance checklist (BMR 4.0) and Dispensing Sheet (BMR 3.0) from the
 * parent Pre-Production run, then this batch's own Bulk Reconciliation
 * (BMR 8.0) and every stage from IPQC through Dispatch Plan. Available
 * any time — a still-in-progress batch's report just shows blanks for
 * whatever hasn't happened yet, same "print what's there" shape the
 * paper form itself has.
 */

type BatchFieldRow = { key: keyof ProductionBatchWithRelations; label: string };

const BATCH_SECTIONS: { stage: CombinedLotStageId; fields: BatchFieldRow[] }[] = [
  {
    stage: "IPQC",
    fields: [
      { key: "ipqcStatus", label: "IPQC Status" },
      { key: "ipqcRemarks", label: "Remarks" },
      { key: "bulkTheoreticalWeight", label: "Bulk Theoretical Weight (a)" },
      { key: "bulkActualWeight", label: "Bulk Actual Weight (b)" },
      { key: "bulkQcSampleWeight", label: "QC Sample (c)" },
      { key: "bulkTransferToPackingQty", label: "Total Bulk Transfer to Packing" },
    ],
  },
  {
    stage: "QA_GATE_MFG",
    fields: [
      { key: "mfgQaStatus", label: "QA Status" },
      { key: "mfgQcStatus", label: "QC Status" },
      { key: "mfgRemarks", label: "Remarks" },
      { key: "mfgApprovedQty", label: "Approved Qty" },
      { key: "mfgRejectedQty", label: "Rejected Qty" },
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
      { key: "packagingRemarks", label: "Remarks" },
    ],
  },
  {
    stage: "QA_GATE_PACKAGING",
    fields: [
      { key: "packQaStatus", label: "QA Status" },
      { key: "packQcStatus", label: "QC Status" },
      { key: "packRemarks", label: "Remarks" },
      { key: "packApprovedQty", label: "Approved Qty" },
      { key: "packRejectedQty", label: "Rejected Qty" },
      { key: "packWastageQty", label: "Wastage Qty" },
    ],
  },
  {
    stage: "FG_STORE",
    fields: [
      { key: "fgStoreReceivedDate", label: "FG Store Received Date" },
      { key: "fgStoreRemarks", label: "Remarks" },
    ],
  },
  {
    stage: "FG_QC_RELEASE",
    fields: [
      { key: "fgQaStatus", label: "QA Status" },
      { key: "fgQcStatus", label: "QC Status" },
      { key: "fgRemarks", label: "Remarks" },
    ],
  },
  {
    stage: "BILLING_EWAY_BILL",
    fields: [
      { key: "invoiceNo", label: "Invoice No." },
      { key: "invoiceDate", label: "Invoice Date" },
      { key: "ewayBillNo", label: "E-Way Bill No." },
      { key: "ewayBillDate", label: "E-Way Bill Date" },
      { key: "billingRemarks", label: "Remarks" },
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
      { key: "pickedBy", label: "Picked By" },
      { key: "pickingDate", label: "Picking Date" },
      { key: "loadedBy", label: "Loaded By" },
      { key: "loadingDate", label: "Loading Date" },
      { key: "anyRemarks", label: "Any Remarks" },
    ],
  },
];

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function sectionHeading(doc: PDFKit.PDFDocument, text: string) {
  if (doc.y + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#334155").text(text, doc.x, doc.y + 10);
  doc.fillColor("#000000");
}

export function buildBmrReportPdf(
  batch: ProductionBatchWithRelations,
  lineClearanceChecklist: ChecklistRow[],
  lineClearanceStatus: string | null,
  lineClearanceRemarks: string | null,
  dispensingSheet: RecipeIngredientConsumptionRow[],
): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const item = batch.preProduction.purchaseOrderItem;
  const po = item.purchaseOrder;
  const { wastageQty } = computeWastage(batch);

  doc.font("Helvetica-Bold").fontSize(16).text("FERMENTIS LIFE SCIENCES PVT. LTD.", { align: "center" });
  doc.font("Helvetica-Bold").fontSize(13).text("BILL OF MATERIAL / BATCH MANUFACTURING RECORD", { align: "center" });
  doc.moveDown(0.5);
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#475569")
    .text(
      `${item.productName} · ${po.customer.companyName}${po.poNumber ? ` · PO ${po.poNumber}` : ""}\nBatch No. ${batch.batchNo ?? batch.id.slice(0, 8)} · Planned ${batch.plannedQty} ${item.unit} · Output ${formatValue(batch.outputQty)} ${item.unit} · Wastage ${formatValue(wastageQty)} ${item.unit}\nManufacturing ${formatValue(batch.manufacturingStartDate)} — ${formatValue(batch.manufacturingEndDate)}`,
    );
  doc.fillColor("#000000");
  doc.moveDown(1);

  // BMR 4.0 — Line Clearance for Bulk Manufacturing
  sectionHeading(doc, "Line Clearance — Bulk Manufacturing (BMR 4.0)");
  const statusTableY = drawTable(doc, {
    x: doc.page.margins.left,
    startY: doc.y + 4,
    columns: [{ header: "Field", width: 220 }, { header: "Value", width: 300 }],
    rows: [
      ["Status", formatValue(lineClearanceStatus)],
      ["Remarks", formatValue(lineClearanceRemarks)],
    ],
  });
  doc.y = statusTableY + 6;
  if (lineClearanceChecklist.length > 0) {
    const y = drawTable(doc, {
      x: doc.page.margins.left,
      startY: doc.y + 4,
      columns: [{ header: "Checklist Item", width: 320 }, { header: "Production", width: 90 }, { header: "QA", width: 90 }],
      rows: lineClearanceChecklist.map((r) => [r.label, r.deptOk === true ? "OK" : r.deptOk === false ? "Not OK" : "—", r.qaOk === true ? "OK" : r.qaOk === false ? "Not OK" : "—"]),
    });
    doc.y = y + 6;
  }

  // BMR 3.0 — Dispensing Sheet of Raw Material
  sectionHeading(doc, "Dispensing Sheet of Raw Material (BMR 3.0)");
  if (dispensingSheet.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#94a3b8").text("Nothing dispensed against this run yet.", doc.x, doc.y + 2);
    doc.fillColor("#000000");
    doc.y += 20;
  } else {
    const y = drawTable(doc, {
      x: doc.page.margins.left,
      startY: doc.y + 4,
      columns: [
        { header: "Item", width: 130 },
        { header: "Purpose", width: 60 },
        { header: "Qty", width: 45 },
        { header: "Unit", width: 40 },
        { header: "Gross", width: 45 },
        { header: "Tare", width: 45 },
        { header: "Net", width: 45 },
        { header: "A.R. No.", width: 60 },
      ],
      rows: dispensingSheet.map((c) => [c.itemName, c.purpose, formatValue(c.quantity), c.unit, formatValue(c.grossWeight), formatValue(c.tareWeight), formatValue(c.netWeight), formatValue(c.arNo)]),
    });
    doc.y = y + 6;
  }

  for (const section of BATCH_SECTIONS) {
    const rows = section.fields.map((f) => [f.label, formatValue((batch as unknown as Record<string, unknown>)[f.key])]);
    sectionHeading(doc, COMBINED_LOT_STAGE_LABEL[section.stage]);
    const y = drawTable(doc, { x: doc.page.margins.left, startY: doc.y + 4, columns: [{ header: "Field", width: 220 }, { header: "Value", width: 300 }], rows });
    doc.y = y + 6;
  }

  return doc;
}
