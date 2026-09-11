import PDFDocument from "pdfkit";
import { drawTable } from "../../common/lib/pdf-table";

// Matches the poInclude shape in purchase-orders.routes.ts — id/companyName
// only on the customer, full rows on items.
type PoForPdf = {
  id: string;
  poNumber: string | null;
  orderDate: Date | null;
  expectedDeliveryDate: Date | null;
  regulatoryBody: string | null;
  regulatoryStatus: string | null;
  status: string;
  reviewedAt: Date | null;
  createdAt: Date;
  customer: { companyName: string };
  reviewedBy: { fullName: string } | null;
  items: {
    productName: string;
    dosageForm: string | null;
    quantity: number;
    unit: string;
    volume: number | null;
    packSize: string | null;
    packType: string | null;
  }[];
};

function fmtDate(d: Date | null): string {
  return d ? new Date(d).toISOString().slice(0, 10) : "—";
}

/**
 * A printable copy of the PO as entered in the system — header fields plus
 * the product line items — for BD to hand to a customer or file alongside
 * the uploaded scan. Available at any status (Draft/Approved/Rejected),
 * unlike Batch's closing report which only makes sense once finished.
 */
export function buildPurchaseOrderPdf(po: PoForPdf): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: 40 });

  doc.font("Helvetica-Bold").fontSize(18).text("FLS Mitr — Purchase Order");
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor("#475569")
    .text(`${po.poNumber ?? po.id.slice(0, 8)} · ${po.customer.companyName}`);
  doc.fillColor("#000000");
  doc.moveDown(1);

  const headerRows: [string, string][] = [
    ["PO Number", po.poNumber ?? "—"],
    ["Customer", po.customer.companyName],
    ["Order Date", fmtDate(po.orderDate)],
    ["Expected Delivery Date", fmtDate(po.expectedDeliveryDate)],
    ["Regulatory Body", po.regulatoryBody ?? "—"],
    ["Regulatory Status", po.regulatoryStatus ?? "—"],
    ["Status", po.status.charAt(0) + po.status.slice(1).toLowerCase()],
    ["Reviewed By", po.reviewedBy ? `${po.reviewedBy.fullName} (${fmtDate(po.reviewedAt)})` : "—"],
    ["Created", fmtDate(po.createdAt)],
  ];

  const y = drawTable(doc, {
    x: doc.page.margins.left,
    startY: doc.y + 4,
    columns: [
      { header: "Field", width: 180 },
      { header: "Value", width: 340 },
    ],
    rows: headerRows,
  });
  doc.y = y + 14;

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#334155").text("Products", doc.x, doc.y);
  doc.fillColor("#000000");

  const itemRows = po.items.map((i) => [
    i.productName,
    i.dosageForm ?? "—",
    `${i.quantity} ${i.unit}`,
    i.volume != null ? String(i.volume) : "—",
    i.packSize ?? "—",
    i.packType ?? "—",
  ]);

  if (itemRows.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#94a3b8").text("No products on this PO.", doc.x, doc.y + 6);
    doc.fillColor("#000000");
  } else {
    drawTable(doc, {
      x: doc.page.margins.left,
      startY: doc.y + 8,
      columns: [
        { header: "Product", width: 150 },
        { header: "Dosage Form", width: 80 },
        { header: "Quantity", width: 80, align: "right" },
        { header: "Volume", width: 60, align: "right" },
        { header: "Pack Size", width: 60 },
        { header: "Pack Type", width: 90 },
      ],
      rows: itemRows,
    });
  }

  return doc;
}
