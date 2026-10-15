import { Router } from "express";
import type { InventoryReceiptStatus, Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { parsePagination, parseSearch, setPaginationHeaders } from "../../common/lib/pagination";
import { requireWarehouseSeat } from "./day-store-access";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";

/**
 * "Stock Received" - every delivery the Warehouse took in from a vendor (Material Received log
 * entries), newest first.
 *
 *   GET /summary    the Store dashboard tile: total received entries
 *   GET /           the list, paged and filtered
 *   GET /options    dropdown values for the text filters (item / vendor / invoice / GRN / batch)
 *
 * Only vendor deliveries count: material coming back from R&D or from a Day Store, and the old
 * opening-stock loads, are not "received from a vendor". Deleted entries are left out.
 */
export const stockReceivedRouter = Router();
stockReceivedRouter.use(requireAuth, requireRole("STORE", "PPIC", "ACCOUNTS", "PURCHASE", "QA_QC"), requireWarehouseSeat);

const FROM_VENDOR: Prisma.InventoryTransactionWhereInput = { type: "RECEIVED", deletedAt: null, isRndReturn: false, isStockTransferReceipt: false, isOpeningStock: false };

const QC_LABEL: Record<InventoryReceiptStatus, string> = {
  PENDING_QC: "Pending QC",
  TESTING: "Testing",
  ON_HOLD: "On Hold",
  QC_APPROVED: "QC Approved",
  QC_REJECTED: "QC Rejected",
  ACCEPTED: "Accepted",
};
const QC_BY_LABEL = Object.fromEntries(Object.entries(QC_LABEL).map(([k, v]) => [v, k as InventoryReceiptStatus]));

const many = (raw: unknown): string[] => (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, 500);
const isoDay = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

function buildWhere(req: AuthedRequest): Prisma.InventoryTransactionWhereInput {
  const q = req.query;
  const from = isoDay(q.dateFrom);
  const to = isoDay(q.dateTo);
  const categories = many(q.category).filter((c): c is "RM" | "PM" => c === "RM" || c === "PM");
  const statuses = many(q.qcStatus).flatMap((l) => (QC_BY_LABEL[l] ? [QC_BY_LABEL[l]] : []));
  const items = many(q.item);
  const vendors = many(q.vendor);
  const invoices = many(q.invoiceNo);
  const grns = many(q.grnNo);
  const batches = many(q.batchNo);
  const units = many(q.unit);
  return {
    ...FROM_VENDOR,
    ...(from || to ? { date: { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}) } } : {}),
    ...(categories.length ? { item: { category: { in: categories }, ...(items.length ? { name: { in: items } } : {}) } } : items.length ? { item: { name: { in: items } } } : {}),
    ...(statuses.length ? { receiptStatus: { in: statuses } } : {}),
    ...(vendors.length ? { vendorName: { in: vendors } } : {}),
    ...(invoices.length ? { invoiceNo: { in: invoices } } : {}),
    ...(grns.length ? { grnNo: { in: grns } } : {}),
    ...(batches.length ? { batchNo: { in: batches } } : {}),
    ...(units.length ? { unit: { in: units } } : {}),
  };
}

stockReceivedRouter.get("/summary", async (_req: AuthedRequest, res, next) => {
  try {
    res.json({ total: await prisma.inventoryTransaction.count({ where: FROM_VENDOR }) });
  } catch (err) {
    next(err);
  }
});

stockReceivedRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const pagination = parsePagination(req);
    const where = buildWhere(req);
    const [total, rows] = await Promise.all([
      prisma.inventoryTransaction.count({ where }),
      prisma.inventoryTransaction.findMany({
        where,
        select: {
          id: true,
          date: true,
          unit: true,
          quantity: true,
          rejectedQty: true,
          vendorName: true,
          invoiceNo: true,
          invoiceDate: true,
          grnNo: true,
          batchNo: true,
          mfgDate: true,
          expiryDate: true,
          rate: true,
          receiptStatus: true,
          item: { select: { name: true, category: true } },
        },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        skip: pagination.skip,
        take: pagination.take,
      }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(
      rows.map((r) => ({
        id: r.id,
        date: r.date,
        itemName: r.item.name,
        category: r.item.category,
        unit: r.unit,
        quantity: r.quantity,
        rejectedQty: r.rejectedQty,
        vendorName: r.vendorName,
        invoiceNo: r.invoiceNo,
        invoiceDate: r.invoiceDate,
        grnNo: r.grnNo,
        batchNo: r.batchNo,
        mfgDate: r.mfgDate,
        expiryDate: r.expiryDate,
        rate: r.rate,
        qcStatus: r.receiptStatus ? QC_LABEL[r.receiptStatus] : null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// Distinct values for a text filter, searched with ?q= (first 100).
stockReceivedRouter.get("/options", async (req: AuthedRequest, res, next) => {
  try {
    const field = String(req.query.field ?? "");
    const q = parseSearch(req, "q");
    const contains = q ? { contains: q, mode: "insensitive" as const } : undefined;
    let values: string[];
    if (field === "item") {
      const rows = await prisma.inventoryItem.findMany({ where: { transactions: { some: FROM_VENDOR }, ...(contains ? { name: contains } : {}) }, select: { name: true }, orderBy: { name: "asc" }, take: 101 });
      values = rows.map((r) => r.name);
    } else if (field === "vendor" || field === "invoiceNo" || field === "grnNo" || field === "batchNo") {
      const col = (field === "vendor" ? "vendorName" : field) as "vendorName" | "invoiceNo" | "grnNo" | "batchNo";
      const rows = await prisma.inventoryTransaction.findMany({ where: { ...FROM_VENDOR, [col]: contains ?? { not: null } }, select: { vendorName: true, invoiceNo: true, grnNo: true, batchNo: true }, distinct: [col], orderBy: { [col]: "asc" }, take: 101 });
      values = rows.map((r) => r[col]).filter((v): v is string => !!v);
    } else {
      return res.status(400).json({ error: "Unknown filter field" });
    }
    res.json({ values: values.slice(0, 100), hasMore: values.length > 100 });
  } catch (err) {
    next(err);
  }
});
