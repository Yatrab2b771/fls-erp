/**
 * Minimal table renderer for pdfkit — it has no built-in table support.
 * Draws one header row (bold, shaded) then data rows, all left-aligned
 * within their column, wrapping to a new page when the table runs off
 * the bottom. Shared by every module's PDF export (packaging-bom,
 * rm-costing) so the table layout stays consistent across them.
 */
export function drawTable(
  doc: PDFKit.PDFDocument,
  opts: { x: number; startY: number; columns: { header: string; width: number; align?: "left" | "right" | "center" }[]; rows: (string | number)[][] },
) {
  const { x, columns } = opts;
  let y = opts.startY;
  const rowHeight = 18;
  const pageBottom = doc.page.height - doc.page.margins.bottom;

  const drawRow = (cells: (string | number)[], bold: boolean, shaded: boolean) => {
    if (y + rowHeight > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    if (shaded) {
      doc.rect(x, y, columns.reduce((s, c) => s + c.width, 0), rowHeight).fill("#f1f5f9");
      doc.fillColor("#000000");
    }
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
    let cx = x;
    columns.forEach((col, i) => {
      doc.text(String(cells[i] ?? ""), cx + 3, y + 4, { width: col.width - 6, align: col.align ?? "left" });
      cx += col.width;
    });
    doc
      .rect(x, y, columns.reduce((s, c) => s + c.width, 0), rowHeight)
      .strokeColor("#cbd5e1")
      .stroke();
    y += rowHeight;
  };

  drawRow(
    columns.map((c) => c.header),
    true,
    true,
  );
  for (const row of opts.rows) drawRow(row, false, false);

  return y;
}
