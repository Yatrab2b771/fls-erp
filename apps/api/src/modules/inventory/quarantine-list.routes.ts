import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { parsePagination, parseSearch, setPaginationHeaders } from "../../common/lib/pagination";
import { requireWarehouseSeat } from "./day-store-access";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { agingRanges, type TileFilters } from "../ppic/ppic-filters";
import { getExpiredReceipts } from "./stock";

/**
 * The Quarantine list (Store dashboard tile) - paged and filterable. Same stock the Inventory
 * "Quarantine Store" tab shows, held for one of three reasons:
 *
 *   Awaiting QC   a Material Received entry still waiting for its first inward QC
 *   On Hold       QC put it on hold
 *   Lab Test      accepted, but past its expiry date and not yet released by QA/QC
 *
 *   GET /           the list (?reason, ?dateFrom/?dateTo = received, ?expiryFrom/?expiryTo, ?category, ?item,
 *                   ?vendor, ?invoiceNo, ?grnNo, ?batchNo, ?unit, ?aging)
 *   GET /options    dropdown values for the text filters
 *
 * Aging = whole days in quarantine: since it was received (Awaiting QC / On Hold) or since it
 * passed its expiry (Lab Test).
 */
export const quarantineListRouter = Router();
quarantineListRouter.use(requireAuth, requireRole("STORE", "QA_QC", "ACCOUNTS", "RND", "PPIC"), requireWarehouseSeat);

type Reason = "PENDING_QC" | "TESTING" | "ON_HOLD" | "EXPIRED";
const REASON_LABEL: Record<Reason, string> = { PENDING_QC: "Awaiting QC", TESTING: "Testing", ON_HOLD: "On Hold", EXPIRED: "Lab Test" };
const REASON_BY_LABEL = Object.fromEntries(Object.entries(REASON_LABEL).map(([k, v]) => [v, k as Reason])) as Record<string, Reason>;

const many = (raw: unknown): string[] => (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, 500);
const isoDay = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const range = (from?: string, to?: string) => (from || to ? { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}) } : undefined);

const BASE: Prisma.InventoryTransactionWhereInput = { deletedAt: null, type: "RECEIVED" };

function buildWhere(req: AuthedRequest, expiredIds: string[]): Prisma.InventoryTransactionWhereInput {
  const q = req.query;
  const now = new Date();
  const reasons = many(q.reason).flatMap((l) => (REASON_BY_LABEL[l] ? [REASON_BY_LABEL[l]] : []));
  const wanted = new Set<Reason>(reasons.length ? reasons : ["PENDING_QC", "TESTING", "ON_HOLD", "EXPIRED"]);
  const aging = agingRanges({ aging: many(q.aging) } as TileFilters, now);

  // One clause per reason; "aged" is measured from a different date for each.
  const branch = (reason: Reason): Prisma.InventoryTransactionWhereInput => {
    const cond: Prisma.InventoryTransactionWhereInput = reason === "EXPIRED" ? { receiptStatus: "ACCEPTED", expiryDate: { lt: now }, expiryReleasedAt: null, id: { in: expiredIds } } : { receiptStatus: reason };
    if (!aging) return cond;
    const field = reason === "EXPIRED" ? "expiryDate" : "date";
    return { AND: [cond, { OR: aging.map((r) => ({ [field]: r })) }] };
  };

  const and: Prisma.InventoryTransactionWhereInput[] = [{ OR: [...wanted].map(branch) }];
  const received = range(isoDay(q.dateFrom), isoDay(q.dateTo));
  if (received) and.push({ date: received });
  const expiry = range(isoDay(q.expiryFrom), isoDay(q.expiryTo));
  if (expiry) and.push({ expiryDate: expiry });

  const categories = many(q.category).filter((c): c is "RM" | "PM" => c === "RM" || c === "PM");
  const items = many(q.item);
  if (categories.length || items.length) and.push({ item: { ...(categories.length ? { category: { in: categories } } : {}), ...(items.length ? { name: { in: items } } : {}) } });
  for (const [param, col] of [["vendor", "vendorName"], ["invoiceNo", "invoiceNo"], ["grnNo", "grnNo"], ["batchNo", "batchNo"], ["unit", "unit"]] as const) {
    const values = many(q[param]);
    if (values.length) and.push({ [col]: { in: values } });
  }
  return { ...BASE, AND: and };
}

const reasonOf = (r: { receiptStatus: string | null }): Reason => (r.receiptStatus === "PENDING_QC" ? "PENDING_QC" : r.receiptStatus === "TESTING" ? "TESTING" : r.receiptStatus === "ON_HOLD" ? "ON_HOLD" : "EXPIRED");

quarantineListRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const pagination = parsePagination(req);
    // Expired lots count only while material from them is still here (stock issued out before it expired is not in Quarantine).
    const expiredLeft = await getExpiredReceipts();
    const remainingById = new Map(expiredLeft.map((e) => [e.id, e.remaining]));
    const where = buildWhere(req, [...remainingById.keys()]);
    const [total, rows] = await Promise.all([
      prisma.inventoryTransaction.count({ where }),
      prisma.inventoryTransaction.findMany({
        where,
        select: {
          id: true,
          date: true,
          unit: true,
          quantity: true,
          vendorName: true,
          invoiceNo: true,
          grnNo: true,
          batchNo: true,
          mfgDate: true,
          expiryDate: true,
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
      rows.map((r) => {
        const reason = reasonOf(r);
        return {
          id: r.id,
          reason: REASON_LABEL[reason],
          date: r.date,
          itemName: r.item.name,
          category: r.item.category,
          unit: r.unit,
          quantity: reason === "EXPIRED" ? (remainingById.get(r.id) ?? r.quantity) : r.quantity,
          vendorName: r.vendorName,
          invoiceNo: r.invoiceNo,
          grnNo: r.grnNo,
          batchNo: r.batchNo,
          mfgDate: r.mfgDate,
          expiryDate: r.expiryDate,
          sinceAt: reason === "EXPIRED" ? r.expiryDate : r.date,
        };
      }),
    );
  } catch (err) {
    next(err);
  }
});

// Distinct values for a text filter among the quarantined entries, searched with ?q= (first 100).
quarantineListRouter.get("/options", async (req: AuthedRequest, res, next) => {
  try {
    const field = String(req.query.field ?? "");
    const q = parseSearch(req, "q");
    const contains = q ? { contains: q, mode: "insensitive" as const } : undefined;
    const now = new Date();
    const held: Prisma.InventoryTransactionWhereInput = {
      ...BASE,
      OR: [{ receiptStatus: { in: ["PENDING_QC", "TESTING", "ON_HOLD"] } }, { receiptStatus: "ACCEPTED", expiryDate: { lt: now }, expiryReleasedAt: null, id: { in: (await getExpiredReceipts()).map((e) => e.id) } }],
    };
    let values: string[];
    if (field === "item") {
      const rows = await prisma.inventoryItem.findMany({ where: { transactions: { some: held }, ...(contains ? { name: contains } : {}) }, select: { name: true }, orderBy: { name: "asc" }, take: 101 });
      values = rows.map((r) => r.name);
    } else if (field === "vendor" || field === "invoiceNo" || field === "grnNo" || field === "batchNo") {
      const col = (field === "vendor" ? "vendorName" : field) as "vendorName" | "invoiceNo" | "grnNo" | "batchNo";
      const rows = await prisma.inventoryTransaction.findMany({ where: { AND: [held, { [col]: contains ?? { not: null } }] }, select: { vendorName: true, invoiceNo: true, grnNo: true, batchNo: true }, distinct: [col], orderBy: { [col]: "asc" }, take: 101 });
      values = rows.map((r) => r[col]).filter((v): v is string => !!v);
    } else {
      return res.status(400).json({ error: "Unknown filter field" });
    }
    res.json({ values: values.slice(0, 100), hasMore: values.length > 100 });
  } catch (err) {
    next(err);
  }
});
