import { Router } from "express";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { drawTable } from "../../common/lib/pdf-table";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import type { PmSnapshot } from "./bom-versions";

// Download a product's BOM as Excel or PDF - the same layout as the company's own BOM sheets, so an Excel
// downloaded here can be uploaded again. Active version by default, or ?version=N for an older one.
// Quantities only: there is no cost, rate or GST anywhere.

const BOX_TYPE = /box|carton|shipper/i;
const PRIMARY_TYPE = /jar|pouch|sachet|tin|monocarton|scoop|wad/i;

interface PmDocRow {
  level: string;
  code: string;
  name: string;
  spec: string;
  make: string;
  uom: string;
  qty: number;
  /** The overage actually applied, as a fraction. */
  rate: number;
  base: number | null;
  total: number | null;
}
interface PmDoc {
  kind: "PM";
  customerName: string;
  productName: string;
  productCode: string;
  packSize: string;
  packingConfig: string;
  batchPacks: number | null;
  version: number;
  note: string | null;
  hasLevel: boolean;
  rows: PmDocRow[];
}
interface RmDocRow {
  code: string;
  name: string;
  make: string;
  uom: string;
  qty: number;
  perBatch: number | null;
}
interface RmDoc {
  kind: "RM";
  customerName: string;
  productName: string;
  productCode: string;
  versionLabel: string;
  perUnit: boolean;
  batchSize: number | null;
  avgUnitWeightMg: number | null;
  version: number;
  note: string | null;
  rows: RmDocRow[];
}

async function versionInfo(kind: "PM" | "RM", entityId: string, requested: number | null) {
  const latest = await prisma.bomVersion.findFirst({ where: { kind, entityId }, orderBy: { version: "desc" }, select: { version: true, note: true } });
  if (requested == null || requested === latest?.version) return { version: latest?.version ?? 0, note: latest?.note ?? null, snapshot: null as unknown };
  const row = await prisma.bomVersion.findUnique({ where: { kind_entityId_version: { kind, entityId, version: requested } } });
  if (!row) return null;
  return { version: row.version, note: row.note, snapshot: row.snapshot as unknown };
}

export async function loadPmDoc(skuId: string, requested: number | null): Promise<PmDoc | null> {
  const sku = await prisma.sku.findUnique({ where: { id: skuId }, include: { customer: true, packagingComponents: { include: { pmItem: { select: { name: true, code: true } } }, orderBy: { type: "asc" } } } });
  if (!sku) return null;
  const info = await versionInfo("PM", skuId, requested);
  if (!info) return null;
  let header = { productCode: sku.productCode, packSize: sku.packSize, packingConfig: sku.packingConfig, batchPacks: sku.batchPacks };
  let comps = sku.packagingComponents.map((c) => ({ type: c.type, quantity: c.quantity, unit: c.unit, code: c.pmItem?.code ?? c.pmCode ?? "", overagePct: c.overagePct, spec: c.spec, make: c.make, packingLevel: c.packingLevel }));
  if (info.snapshot) {
    const snap = info.snapshot as PmSnapshot;
    header = { productCode: snap.header.productCode ?? null, packSize: snap.header.packSize ?? null, packingConfig: snap.header.packingConfig ?? null, batchPacks: snap.header.batchPacks ?? null };
    const ids = [...new Set(snap.components.map((c) => c.pmItemId).filter((x): x is string => !!x))];
    const items = new Map((await prisma.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } })).map((i) => [i.id, i.code]));
    comps = snap.components.map((c) => ({ type: c.type, quantity: c.quantity ?? null, unit: c.unit, code: (c.pmItemId ? items.get(c.pmItemId) : null) ?? c.pmCode ?? "", overagePct: c.overagePct ?? null, spec: c.spec ?? null, make: c.make ?? null, packingLevel: c.packingLevel ?? null }));
  }
  const packs = header.batchPacks ?? 0;
  const rows: PmDocRow[] = comps.map((c) => {
    const qty = c.quantity ?? 0;
    const box = BOX_TYPE.test(c.type);
    const cat = /^tertiary/i.test(c.packingLevel ?? "") ? 3 : /^primary/i.test(c.packingLevel ?? "") ? 1 : /^secondary/i.test(c.packingLevel ?? "") ? 2 : box ? 3 : PRIMARY_TYPE.test(c.type) ? 1 : 2;
    const rate = c.overagePct != null ? c.overagePct : cat === 3 ? 0 : 0.02;
    const base = packs > 0 && qty > 0 ? (box ? Math.ceil(packs / qty) : packs * qty) : null;
    return { level: c.packingLevel ?? "", code: c.code, name: c.type, spec: c.spec ?? "", make: c.make ?? "", uom: c.unit, qty, rate, base, total: base == null ? null : base + Math.ceil(base * rate) };
  });
  return {
    kind: "PM",
    customerName: sku.customer.companyName,
    productName: sku.productName,
    productCode: header.productCode ?? "",
    packSize: header.packSize ?? "",
    packingConfig: header.packingConfig ?? "",
    batchPacks: header.batchPacks ?? null,
    version: info.version,
    note: info.note,
    hasLevel: rows.some((r) => r.level),
    rows,
  };
}

export async function loadRmDoc(recipeId: string, customerName: string, requested: number | null): Promise<RmDoc | null> {
  const recipe = await prisma.recipe.findUnique({ where: { id: recipeId }, include: { ingredients: { orderBy: { sortOrder: "asc" } } } });
  if (!recipe) return null;
  const info = await versionInfo("RM", recipeId, requested);
  if (!info) return null;
  let head = { kind: recipe.kind, productCode: recipe.productCode, versionLabel: recipe.versionLabel, batchSize: recipe.batchSize, avgUnitWeightMg: recipe.avgUnitWeightMg };
  let ings = recipe.ingredients.map((i) => ({ name: i.name, brand: i.brand, itemCode: i.itemCode, qty: i.gPerServing, uom: i.uom }));
  if (info.snapshot) {
    const s = info.snapshot as { kind?: string; productCode?: string | null; versionLabel?: string | null; batchSize?: number | null; avgUnitWeightMg?: number | null; ingredients: { name: string; brand: string; itemCode?: string; gPerServing: number; uom?: string }[] };
    head = { kind: s.kind ?? "PER_KG", productCode: s.productCode ?? null, versionLabel: s.versionLabel ?? null, batchSize: s.batchSize ?? null, avgUnitWeightMg: s.avgUnitWeightMg ?? null };
    ings = s.ingredients.map((i) => ({ name: i.name, brand: i.brand, itemCode: i.itemCode ?? null, qty: i.gPerServing, uom: i.uom ?? "Kg" }));
  }
  const perUnit = head.kind === "PER_UNIT";
  const batch = head.batchSize ?? 0;
  return {
    kind: "RM",
    customerName,
    productName: recipe.name,
    productCode: head.productCode ?? "",
    versionLabel: head.versionLabel ?? "",
    perUnit,
    batchSize: head.batchSize ?? null,
    avgUnitWeightMg: head.avgUnitWeightMg ?? null,
    version: info.version,
    note: info.note,
    rows: ings.map((i) => ({ code: i.itemCode ?? "", name: i.name, make: i.brand === "Approved Vendor" ? "" : i.brand, uom: i.uom || (perUnit ? "mg" : "Kg"), qty: i.qty, perBatch: batch > 0 ? (perUnit ? (i.qty * batch) / 1000 : i.qty * batch) : null })),
  };
}

// ---------- Excel ----------

const COMPANY = "FERMENTIS LIFE SCIENCES PVT. LTD.";

function sheetName(wb: ExcelJS.Workbook, wanted: string): string {
  const base = wanted.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 28) || "BOM";
  let name = base;
  let n = 2;
  while (wb.getWorksheet(name)) name = `${base.slice(0, 25)} ${n++}`;
  return name;
}

function boldRow(ws: ExcelJS.Worksheet, r: number) {
  ws.getRow(r).font = { bold: true };
  ws.getRow(r).eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
    c.border = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
  });
}

export function addPmSheet(wb: ExcelJS.Workbook, d: PmDoc) {
  const ws = wb.addWorksheet(sheetName(wb, d.productName));
  ws.addRow([COMPANY]).font = { bold: true, size: 13 };
  ws.addRow(["BILL OF MATERIAL (PM)"]).font = { bold: true };
  ws.addRow([`Customer: ${d.customerName}`, "", "", `Version: v${d.version}${d.note ? ` (${d.note})` : ""}`]);
  if (d.hasLevel) {
    ws.addRow(["", "", "", "Product Name", d.productName, "", "Pack Size", d.packSize]);
    ws.addRow(["", "", "", "Product Code", d.productCode, "", "Batch Size (packs)", d.batchPacks ?? ""]);
  } else {
    ws.addRow([`Product Name: ${d.productName}`, "", "", "", `Product Code: ${d.productCode}`]);
    ws.addRow(["Batch Size:", d.batchPacks ?? "", "Nos"]);
    ws.addRow([`Pack Size: ${d.packSize}`, "", "", "", `Packing Configuration: ${d.packingConfig}`]);
  }
  ws.addRow([]);
  const headRow = d.hasLevel
    ? ["Sr. No.", "Packing Level", "Material Code", "Packaging Material", "Specification / Size", "UOM", "Std. Qty / FG Unit", "Wastage %", "Net Qty / FG Unit", "Batch Qty"]
    : ["S. No.", "Item Code", "Ingredients", "Make", "UOM", "OV%", "Qty./ Pack", "Quantity Req./Batch"];
  ws.addRow(headRow);
  boldRow(ws, ws.rowCount);
  d.rows.forEach((r, i) => {
    const box = BOX_TYPE.test(r.name);
    if (d.hasLevel) {
      // A box is "1 per box" with its own batch quantity, as on the gummies Packing BOM sheet.
      ws.addRow([i + 1, r.level, r.code, r.name, r.spec, r.uom, box ? 1 : r.qty, r.rate, box ? 1 + r.rate : r.qty * (1 + r.rate), r.base ?? ""]);
    } else {
      // A box is a fraction of a pack on the PM BOM sheet (0.0156 = 1 box for 64 packs).
      ws.addRow([i + 1, r.code, r.name, r.make, r.uom, r.rate > 0 ? r.rate : "Nil", box && r.qty > 0 ? Math.round((1 / r.qty) * 10000) / 10000 : r.qty, r.total ?? ""]);
    }
  });
  ws.addRow([]);
  ws.addRow(["Requisition Raised By", "", "Checked By", "", "Verified By", "", "Checked By Production"]);
  ws.columns.forEach((c, i) => { c.width = [8, 16, 18, 32, 22, 12, 18, 14, 16, 14][i] ?? 14; });
}

export function addRmSheet(wb: ExcelJS.Workbook, d: RmDoc) {
  const ws = wb.addWorksheet(sheetName(wb, d.productName));
  ws.addRow([COMPANY]).font = { bold: true, size: 13 };
  ws.addRow(["BILL OF MATERIAL (RM)"]).font = { bold: true };
  ws.addRow([`Customer: ${d.customerName}`, "", "", `Version: v${d.version}${d.note ? ` (${d.note})` : ""}`]);
  if (d.perUnit) {
    ws.addRow([`Product Name - ${d.productName}`]);
    ws.addRow(["Batch Size", d.batchSize ?? "", "NOS"]);
    ws.addRow([]);
    ws.addRow(["S. No.", "Item Code", "Ingredients", "Make", "Qty./Gummy", "UOM", "Quantity Required/Batch", "UOM"]);
    boldRow(ws, ws.rowCount);
    d.rows.forEach((r, i) => ws.addRow([i + 1, r.code, r.name, r.make, r.qty, r.uom, r.perBatch ?? "", "g"]));
    ws.addRow([]);
    ws.addRow(["", "", "AVG WT GUMMIES-", "", d.avgUnitWeightMg ?? "", "mg"]);
  } else {
    ws.addRow([`Product Name: ${d.productName}`, "", "", "", `Product Code: ${d.productCode}`]);
    ws.addRow([`Trial No.: ${d.versionLabel}`]);
    ws.addRow(["Batch Size:", d.batchSize ?? "", "Kg"]);
    ws.addRow([]);
    ws.addRow(["S. No.", "Item Code", "Ingredients", "Make", "UOM", "Qty./Kg", "Quantity Req./Batch"]);
    boldRow(ws, ws.rowCount);
    d.rows.forEach((r, i) => ws.addRow([i + 1, r.code, r.name, r.make, r.uom, r.qty, r.perBatch ?? ""]));
    const tot = ws.addRow(["Total", "", "", "", "Kg", d.rows.reduce((a, r) => a + r.qty, 0), d.rows.reduce((a, r) => a + (r.perBatch ?? 0), 0)]);
    tot.font = { bold: true };
  }
  ws.addRow([]);
  ws.addRow(["Requisition Raised By", "", "Checked By", "", "Checked By Production", "", "Verified By"]);
  ws.columns.forEach((c, i) => { c.width = [8, 14, 34, 20, 14, 14, 20, 10][i] ?? 14; });
}

// ---------- PDF ----------

const fmt = (n: number | null, d = 3) => (n == null ? "" : n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: d }));

function pdfHead(doc: PDFKit.PDFDocument, title: string, d: { customerName: string; productName: string; version: number; note: string | null }, lines: string[]) {
  doc.font("Helvetica-Bold").fontSize(13).text(COMPANY, { align: "center" });
  doc.font("Helvetica-Bold").fontSize(11).text(title, { align: "center" });
  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").fontSize(10).text(`Product: ${d.productName}`);
  doc.font("Helvetica").fontSize(9).text(`Customer: ${d.customerName}    Version: v${d.version}${d.note ? ` (${d.note})` : ""}`);
  for (const l of lines.filter(Boolean)) doc.text(l);
  doc.moveDown(0.5);
}

function pdfSign(doc: PDFKit.PDFDocument, labels: string[]) {
  doc.moveDown(3);
  const y = doc.y;
  const w = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / labels.length;
  labels.forEach((l, i) => {
    const x = doc.page.margins.left + i * w;
    doc.moveTo(x + 6, y).lineTo(x + w - 14, y).strokeColor("#64748b").stroke();
    doc.font("Helvetica").fontSize(8).fillColor("#000000").text(l, x + 6, y + 4, { width: w - 20 });
  });
}

export function buildPmPdf(d: PmDoc): PDFKit.PDFDocument {
  const doc = new PDFDocument({ layout: "landscape", size: "A4", margin: 30 });
  pdfHead(doc, "BILL OF MATERIAL (PM)", d, [[d.productCode && `Product Code: ${d.productCode}`, d.packSize && `Pack Size: ${d.packSize}`, d.packingConfig && `Packing Configuration: ${d.packingConfig}`, d.batchPacks && `Batch: ${fmt(d.batchPacks, 0)} packs`].filter(Boolean).join("    ")]);
  const columns = [
    { header: "S.No", width: 34 },
    ...(d.hasLevel ? [{ header: "Level", width: 62 }] : []),
    { header: "Item Code", width: 70 },
    { header: "Component", width: 170 },
    { header: "Specification", width: 120 },
    { header: "Make", width: 70 },
    { header: "UOM", width: 40 },
    { header: "Qty / Pack", width: 60, align: "right" as const },
    { header: "OV %", width: 40, align: "right" as const },
    { header: "Batch Qty", width: 70, align: "right" as const },
  ];
  const rows = d.rows.map((r, i) => [i + 1, ...(d.hasLevel ? [r.level] : []), r.code, r.name, r.spec, r.make, r.uom, fmt(r.qty, 4) + (BOX_TYPE.test(r.name) ? " /box" : ""), fmt(r.rate * 100, 2), fmt(r.total, 0)]);
  drawTable(doc, { x: doc.page.margins.left, startY: doc.y + 2, columns, rows });
  pdfSign(doc, ["Requisition Raised By", "Checked By", "Verified By", "Checked By Production"]);
  return doc;
}

export function buildRmPdf(d: RmDoc): PDFKit.PDFDocument {
  const doc = new PDFDocument({ layout: "landscape", size: "A4", margin: 30 });
  pdfHead(doc, "BILL OF MATERIAL (RM)", d, [[d.productCode && `Product Code: ${d.productCode}`, d.versionLabel && `Trial No.: ${d.versionLabel}`, d.batchSize && `Batch: ${fmt(d.batchSize, 0)} ${d.perUnit ? "gummies" : "Kg"}`, d.perUnit && d.avgUnitWeightMg && `Avg gummy weight: ${fmt(d.avgUnitWeightMg, 3)} mg`].filter(Boolean).join("    ")]);
  const columns = [
    { header: "S.No", width: 34 },
    { header: "Item Code", width: 80 },
    { header: "Ingredient", width: 250 },
    { header: "Make", width: 120 },
    { header: "UOM", width: 40 },
    { header: d.perUnit ? "Qty / Gummy" : "Qty / Kg", width: 80, align: "right" as const },
    { header: d.perUnit ? "Qty / Batch (g)" : "Qty / Batch (Kg)", width: 110, align: "right" as const },
  ];
  const rows = d.rows.map((r, i) => [i + 1, r.code, r.name, r.make, r.uom, fmt(r.qty, 7), fmt(r.perBatch, 3)]);
  drawTable(doc, { x: doc.page.margins.left, startY: doc.y + 2, columns, rows });
  pdfSign(doc, ["Requisition Raised By", "Checked By", "Checked By Production", "Verified By"]);
  return doc;
}

// ---------- Routes ----------

export const bomDocsRouter = Router();
bomDocsRouter.use(requireAuth, requireRole("RND", "PPIC"));

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const safe = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50) || "BOM";
const versionParam = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

// A recipe is matched by customer + product name, same as the plan does.
async function recipeFor(customerId: string, productName: string) {
  return prisma.recipe.findFirst({ where: { customerId, name: { equals: productName, mode: "insensitive" } }, select: { id: true } });
}

bomDocsRouter.get("/pm/:skuId/export.:ext", async (req: AuthedRequest<{ skuId: string; ext: string }>, res, next) => {
  try {
    const d = await loadPmDoc(req.params.skuId, versionParam(req.query.version));
    if (!d) return res.status(404).json({ error: "BOM or version not found" });
    const base = `FLS_PM_BOM_${safe(d.productName)}_v${d.version}`;
    await recordAudit({ actorId: req.user!.id, action: "bom.exported", entityType: "Sku", entityId: req.params.skuId, metadata: { kind: "PM", format: req.params.ext, version: d.version } });
    if (req.params.ext === "xlsx") {
      const wb = new ExcelJS.Workbook();
      wb.creator = "FLS Mitr";
      addPmSheet(wb, d);
      res.setHeader("Content-Type", XLSX_MIME);
      res.setHeader("Content-Disposition", `attachment; filename="${base}.xlsx"`);
      return res.send(Buffer.from(await wb.xlsx.writeBuffer()));
    }
    if (req.params.ext === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.pdf"`);
      const doc = buildPmPdf(d);
      doc.pipe(res);
      return doc.end();
    }
    return res.status(404).json({ error: "Use xlsx or pdf" });
  } catch (err) {
    next(err);
  }
});

// One recipe by id; the customer name on the sheet comes from the page (a recipe belongs to a product name, not a customer).
bomDocsRouter.get("/rm/:recipeId/export.:ext", async (req: AuthedRequest<{ recipeId: string; ext: string }>, res, next) => {
  try {
    const customerName = typeof req.query.customer === "string" ? req.query.customer : "";
    const d = await loadRmDoc(req.params.recipeId, customerName, versionParam(req.query.version));
    if (!d) return res.status(404).json({ error: "Recipe or version not found" });
    const base = `FLS_RM_BOM_${safe(d.productName)}_v${d.version}`;
    await recordAudit({ actorId: req.user!.id, action: "bom.exported", entityType: "Recipe", entityId: req.params.recipeId, metadata: { kind: "RM", format: req.params.ext, version: d.version } });
    if (req.params.ext === "xlsx") {
      const wb = new ExcelJS.Workbook();
      wb.creator = "FLS Mitr";
      addRmSheet(wb, d);
      res.setHeader("Content-Type", XLSX_MIME);
      res.setHeader("Content-Disposition", `attachment; filename="${base}.xlsx"`);
      return res.send(Buffer.from(await wb.xlsx.writeBuffer()));
    }
    if (req.params.ext === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.pdf"`);
      const doc = buildRmPdf(d);
      doc.pipe(res);
      return doc.end();
    }
    return res.status(404).json({ error: "Use xlsx or pdf" });
  } catch (err) {
    next(err);
  }
});

// Every BOM of one customer in a single workbook, one sheet per product (?kind=pm | rm | all).
bomDocsRouter.get("/customer/:customerId/export.xlsx", async (req: AuthedRequest<{ customerId: string }>, res, next) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.customerId } });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    const kind = req.query.kind === "pm" || req.query.kind === "rm" ? req.query.kind : "all";
    const wb = new ExcelJS.Workbook();
    wb.creator = "FLS Mitr";
    const skus = await prisma.sku.findMany({ where: { customerId: customer.id }, include: { _count: { select: { packagingComponents: true } } }, orderBy: { productName: "asc" } });
    const poNames = (await prisma.purchaseOrderItem.findMany({ where: { deletedAt: null, cancelledAt: null, purchaseOrder: { customerId: customer.id } }, select: { productName: true }, distinct: ["productName"] })).map((p) => p.productName);
    const names = [...new Set([...skus.map((s) => s.productName), ...poNames])];
    let sheets = 0;
    for (const sku of skus) {
      if (kind !== "rm" && sku._count.packagingComponents > 0) {
        const d = await loadPmDoc(sku.id, null);
        if (d) { addPmSheet(wb, d); sheets += 1; }
      }
    }
    if (kind !== "pm") {
      for (const name of names) {
        const r = await recipeFor(customer.id, name);
        if (!r) continue;
        const d = await loadRmDoc(r.id, customer.companyName, null);
        if (d) { addRmSheet(wb, d); sheets += 1; }
      }
    }
    if (sheets === 0) return res.status(404).json({ error: "This customer has no BOM to download yet." });
    await recordAudit({ actorId: req.user!.id, action: "bom.exported", entityType: "Customer", entityId: customer.id, metadata: { kind, sheets } });
    res.setHeader("Content-Type", XLSX_MIME);
    res.setHeader("Content-Disposition", `attachment; filename="FLS_BOM_${safe(customer.companyName)}.xlsx"`);
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  } catch (err) {
    next(err);
  }
});
