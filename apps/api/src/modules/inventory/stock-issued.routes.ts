import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { parsePagination, parseSearch, setPaginationHeaders } from "../../common/lib/pagination";
import { requireWarehouseSeat } from "./day-store-access";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";

/**
 * "Stock Issued" - everything the Warehouse has issued out: to a Day Store or to the R&D Store,
 * newest first. (The Warehouse never issues to a Plant - only a Day Store does, to its own Plant.)
 *
 *   GET /summary    the Store dashboard tile: total issue entries
 *   GET /           the list, paged and filtered
 *   GET /options    dropdown values for the filters
 *
 * Deleted entries are left out. A Day Store / Plant issue that Store opted to track in transit is
 * "In Transit" until the receiving side confirms it; every other issue counts as "Delivered" (the
 * R&D hand-over is confirmed on R&D's own side and is not linked back to this ledger row).
 */
export const stockIssuedRouter = Router();
stockIssuedRouter.use(requireAuth, requireRole("STORE", "PPIC", "ACCOUNTS", "PURCHASE", "QA_QC"), requireWarehouseSeat);

const ISSUE_TYPES = ["ISSUED_DAY_STORE", "ISSUED_RND"] as const;
const ISSUED: Prisma.InventoryTransactionWhereInput = { type: { in: [...ISSUE_TYPES] }, deletedAt: null };
const RND_LABEL = "R&D Store";
const DAY_PREFIX = "Day Store: ";

const many = (raw: unknown): string[] => (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, 500);
const isoDay = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

function buildWhere(req: AuthedRequest): Prisma.InventoryTransactionWhereInput {
  const q = req.query;
  const from = isoDay(q.dateFrom);
  const to = isoDay(q.dateTo);
  const and: Prisma.InventoryTransactionWhereInput[] = [ISSUED];
  if (from || to) and.push({ date: { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}) } });

  // Location labels: "Day Store: <name>", "R&D Store".
  const locations = many(q.location);
  if (locations.length) {
    const dayStores = locations.filter((l) => l.startsWith(DAY_PREFIX)).map((l) => l.slice(DAY_PREFIX.length));
    and.push({
      OR: [
        ...(dayStores.length ? [{ type: "ISSUED_DAY_STORE" as const, dayStore: { name: { in: dayStores } } }] : []),
        ...(locations.includes(RND_LABEL) ? [{ type: "ISSUED_RND" as const }] : []),
      ],
    });
  }

  const categories = many(q.category).filter((c): c is "RM" | "PM" => c === "RM" || c === "PM");
  const items = many(q.item);
  if (categories.length || items.length) and.push({ item: { ...(categories.length ? { category: { in: categories } } : {}), ...(items.length ? { name: { in: items } } : {}) } });

  const statuses = many(q.status);
  const wantTransit = statuses.includes("In Transit");
  const wantDelivered = statuses.includes("Delivered");
  const inTransit: Prisma.InventoryTransactionWhereInput = { isTransitTracked: true, deliveredAt: null, type: "ISSUED_DAY_STORE" };
  if (wantTransit && !wantDelivered) and.push(inTransit);
  else if (wantDelivered && !wantTransit) and.push({ NOT: inTransit });

  for (const [param, col] of [["batchNo", "batchNo"], ["grnNo", "grnNo"], ["unit", "unit"]] as const) {
    const values = many(q[param]);
    if (values.length) and.push({ [col]: { in: values } });
  }
  const issuers = many(q.issuedBy);
  if (issuers.length) and.push({ createdBy: { fullName: { in: issuers } } });
  return { AND: and };
}

stockIssuedRouter.get("/summary", async (_req: AuthedRequest, res, next) => {
  try {
    res.json({ total: await prisma.inventoryTransaction.count({ where: ISSUED }) });
  } catch (err) {
    next(err);
  }
});

stockIssuedRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const pagination = parsePagination(req);
    const where = buildWhere(req);
    const [total, rows] = await Promise.all([
      prisma.inventoryTransaction.count({ where }),
      prisma.inventoryTransaction.findMany({
        where,
        select: {
          id: true,
          type: true,
          date: true,
          unit: true,
          quantity: true,
          batchNo: true,
          grnNo: true,
          remark: true,
          fulfillsRequestId: true,
          isTransitTracked: true,
          deliveredAt: true,
          item: { select: { name: true, category: true } },
          dayStore: { select: { name: true } },
          createdBy: { select: { fullName: true } },
        },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        skip: pagination.skip,
        take: pagination.take,
      }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(
      rows.map((r) => {
        const rnd = r.type === "ISSUED_RND";
        return {
          id: r.id,
          date: r.date,
          itemName: r.item.name,
          category: r.item.category,
          unit: r.unit,
          quantity: r.quantity,
          locationType: rnd ? "R&D Store" : "Day Store",
          locationName: rnd ? RND_LABEL : r.dayStore?.name ?? null,
          batchNo: r.batchNo,
          grnNo: r.grnNo,
          viaRequest: !!r.fulfillsRequestId,
          status: !rnd && r.isTransitTracked && !r.deliveredAt ? "In Transit" : "Delivered",
          issuedBy: r.createdBy.fullName,
          remark: r.remark,
        };
      }),
    );
  } catch (err) {
    next(err);
  }
});

// Values for the filter dropdowns (first 100), searched with ?q=.
stockIssuedRouter.get("/options", async (req: AuthedRequest, res, next) => {
  try {
    const field = String(req.query.field ?? "");
    const q = parseSearch(req, "q");
    const contains = q ? { contains: q, mode: "insensitive" as const } : undefined;
    let values: string[];
    if (field === "location") {
      const dayStores = await prisma.dayStore.findMany({ orderBy: { name: "asc" }, select: { name: true } });
      const all = [...dayStores.map((d) => `${DAY_PREFIX}${d.name}`), RND_LABEL];
      values = all.filter((v) => !q || v.toLowerCase().includes(q.toLowerCase()));
    } else if (field === "item") {
      values = (await prisma.inventoryItem.findMany({ where: { transactions: { some: ISSUED }, ...(contains ? { name: contains } : {}) }, select: { name: true }, orderBy: { name: "asc" }, take: 101 })).map((r) => r.name);
    } else if (field === "batchNo" || field === "grnNo") {
      const rows = await prisma.inventoryTransaction.findMany({ where: { AND: [ISSUED, { [field]: contains ?? { not: null } }] }, select: { batchNo: true, grnNo: true }, distinct: [field], orderBy: { [field]: "asc" }, take: 101 });
      values = rows.map((r) => r[field]).filter((v): v is string => !!v);
    } else if (field === "issuedBy") {
      const rows = await prisma.user.findMany({ where: { inventoryTxns: { some: ISSUED }, ...(contains ? { fullName: contains } : {}) }, select: { fullName: true }, orderBy: { fullName: "asc" }, take: 101 });
      values = rows.map((r) => r.fullName);
    } else {
      return res.status(400).json({ error: "Unknown filter field" });
    }
    res.json({ values: values.slice(0, 100), hasMore: values.length > 100 });
  } catch (err) {
    next(err);
  }
});
