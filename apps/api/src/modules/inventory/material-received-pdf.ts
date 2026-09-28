import PDFDocument from "pdfkit";
import { drawTable } from "../../common/lib/pdf-table";

// Matches txnInclude in inventory.routes.ts.
export interface MaterialReceivedForPdf {
  id: string;
  date: Date;
  item: { name: string; category: string; unit: string | null };
  quantity: number;
  unit: string;
  size: string | null;
  vendorName: string | null;
  batchNo: string | null;
  grnNo: string | null;
  mfgDate: Date | null;
  expiryDate: Date | null;
  remark: string | null;
  isOpeningStock: boolean;
  receiptStatus: string | null;
  rejectedQty: number | null;
  qcCheckedBy: { fullName: string } | null;
  qcCheckedAt: Date | null;
  qcNote: string | null;
  acceptedBy: { fullName: string } | null;
  acceptedAt: Date | null;
  createdBy: { fullName: string };
  createdAt: Date;
  debitNotes: { debitNoteNo: string | null; quantity: number; amount: number | null }[];
}

const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };
const STATUS_LABEL: Record<string, string> = {
  PENDING_QC: "Pending QC",
  ON_HOLD: "On Hold",
  QC_APPROVED: "QC Approved",
  QC_REJECTED: "QC Rejected",
  ACCEPTED: "Accepted",
};

function fmtDate(d: Date | null): string {
  return d ? new Date(d).toISOString().slice(0, 10) : "—";
}
function fmtDateTime(d: Date | null): string {
  return d ? new Date(d).toLocaleString() : "—";
}

/**
 * A printable copy of one Material Received log entry — header fields
 * plus its inward QC trail — for Store/R&D to hand along with a
 * physical delivery or file alongside a GRN. Same field set as the
 * per-row Excel export (see exportTransactionReport on the frontend),
 * just as a single-page PDF instead of a spreadsheet row.
 */
export function buildMaterialReceivedPdf(txn: MaterialReceivedForPdf): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: 40 });

  doc.font("Helvetica-Bold").fontSize(18).text("FLS Mitr — Material Received");
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor("#475569")
    .text(`${txn.item.name} · ${fmtDate(txn.date)}`);
  doc.fillColor("#000000");
  doc.moveDown(1);

  const rows: [string, string][] = [
    ["Item", txn.item.name],
    ["Category", CATEGORY_LABEL[txn.item.category] ?? txn.item.category],
    ["Quantity", `${txn.quantity} ${txn.unit}`],
    ["Size", txn.size ?? "—"],
    ["Date", fmtDate(txn.date)],
    ["Vendor", txn.vendorName ?? "—"],
    ["Batch No", txn.batchNo ?? "—"],
    ["GRN No", txn.grnNo ?? "—"],
    ["Mfg Date", fmtDate(txn.mfgDate)],
    ["Expiry Date", fmtDate(txn.expiryDate)],
    ["Opening Stock", txn.isOpeningStock ? "Yes" : "No"],
    ["Status", (txn.receiptStatus && STATUS_LABEL[txn.receiptStatus]) ?? txn.receiptStatus ?? "—"],
    ["Rejected Qty", txn.rejectedQty ? `${txn.rejectedQty} ${txn.unit}` : "—"],
    ["QC By", txn.qcCheckedBy ? `${txn.qcCheckedBy.fullName} (${fmtDateTime(txn.qcCheckedAt)})` : "—"],
    ["QC Note", txn.qcNote ?? "—"],
    ["Accepted By", txn.acceptedBy ? `${txn.acceptedBy.fullName} (${fmtDateTime(txn.acceptedAt)})` : "—"],
    ["Remark", txn.remark ?? "—"],
    ["Logged By", `${txn.createdBy.fullName} (${fmtDateTime(txn.createdAt)})`],
  ];

  const y = drawTable(doc, {
    x: doc.page.margins.left,
    startY: doc.y + 4,
    columns: [
      { header: "Field", width: 160 },
      { header: "Value", width: 360 },
    ],
    rows,
  });
  doc.y = y + 14;

  if (txn.debitNotes.length > 0) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#334155").text("Debit Notes", doc.x, doc.y);
    doc.fillColor("#000000");
    drawTable(doc, {
      x: doc.page.margins.left,
      startY: doc.y + 8,
      columns: [
        { header: "Debit Note No.", width: 160 },
        { header: "Quantity", width: 120, align: "right" },
        { header: "Amount", width: 120, align: "right" },
      ],
      rows: txn.debitNotes.map((d) => [d.debitNoteNo ?? "—", `${d.quantity} ${txn.unit}`, d.amount != null ? d.amount.toFixed(2) : "—"]),
    });
  }

  return doc;
}
