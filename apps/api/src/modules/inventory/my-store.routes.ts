import { Router } from "express";
import { loadProductionRequests } from "./my-store-production.routes";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { parsePagination, parseSearch, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { z } from "zod";
import { validateBody } from "../../common/middleware/validate";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { getScopedDayStoreIds } from "./day-store-access";
import { loadRows } from "./material-requests.routes";

/**
 * A Day Store login's own view - it works like a Warehouse for its own store(s) only.
 *
 *   GET /info                the store(s) this login is limited to, and each store's own Plant
 *   GET /summary             tile counts: entries received from the Warehouse, entries issued to the Plant
 *   GET /received            what the Warehouse issued INTO this store (Stock Received)
 *   GET /issued-to-plant     what this store issued on to its own Plant (Stock Issued)
 *   GET /:kind/options       dropdown values for the filters
 *
 * A login with no store assignment (the Warehouse-side Store seat, ADMIN, PPIC) sees every Day Store.
 */
export const myStoreRouter = Router();
myStoreRouter.use(requireAuth, requireRole("STORE", "PPIC"));

type Kind = "received" | "issued-to-plant";
const TYPE_OF: Record<Kind, "ISSUED_DAY_STORE" | "ISSUED_PRODUCTION"> = { received: "ISSUED_DAY_STORE", "issued-to-plant": "ISSUED_PRODUCTION" };

const many = (raw: unknown): string[] => (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, 500);
const isoDay = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const scopeOf = (req: AuthedRequest) => getScopedDayStoreIds(req.user!.id, req.user!.roles);

function baseWhere(kind: Kind, scope: string[] | null): Prisma.InventoryTransactionWhereInput {
  return { type: TYPE_OF[kind], deletedAt: null, dayStoreId: scope ? { in: scope } : { not: null } };
}

function buildWhere(kind: Kind, scope: string[] | null, req: AuthedRequest): Prisma.InventoryTransactionWhereInput {
  const q = req.query;
  const and: Prisma.InventoryTransactionWhereInput[] = [baseWhere(kind, scope)];
  const from = isoDay(q.dateFrom);
  const to = isoDay(q.dateTo);
  if (from || to) and.push({ date: { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}) } });
  const stores = many(q.store);
  if (stores.length) and.push({ dayStore: { name: { in: stores } } });
  const categories = many(q.category).filter((c): c is "RM" | "PM" => c === "RM" || c === "PM");
  const items = many(q.item);
  if (categories.length || items.length) and.push({ item: { ...(categories.length ? { category: { in: categories } } : {}), ...(items.length ? { name: { in: items } } : {}) } });
  const statuses = many(q.status);
  const inTransit: Prisma.InventoryTransactionWhereInput = { isTransitTracked: true, deliveredAt: null };
  if (statuses.includes("In Transit") && !statuses.includes("Delivered")) and.push(inTransit);
  else if (statuses.includes("Delivered") && !statuses.includes("In Transit")) and.push({ NOT: inTransit });
  for (const [param, col] of [["batchNo", "batchNo"], ["grnNo", "grnNo"], ["unit", "unit"]] as const) {
    const values = many(q[param]);
    if (values.length) and.push({ [col]: { in: values } });
  }
  return { AND: and };
}

myStoreRouter.get("/info", async (req: AuthedRequest, res, next) => {
  try {
    const scope = await scopeOf(req);
    const stores = await prisma.dayStore.findMany({ where: scope ? { id: { in: scope } } : {}, orderBy: { name: "asc" }, select: { id: true, name: true, pairedPlant: { select: { id: true, name: true } } } });
    res.json({ scoped: scope !== null, stores: stores.map((s) => ({ id: s.id, name: s.name, plantId: s.pairedPlant?.id ?? null, plantName: s.pairedPlant?.name ?? null })) });
  } catch (err) {
    next(err);
  }
});

myStoreRouter.get("/summary", async (req: AuthedRequest, res, next) => {
  try {
    const scope = await scopeOf(req);
    const [received, issuedToPlant] = await Promise.all([prisma.inventoryTransaction.count({ where: baseWhere("received", scope) }), prisma.inventoryTransaction.count({ where: baseWhere("issued-to-plant", scope) })]);
    const requests = await prisma.inventoryRequest.count({ where: { deletedAt: null, purpose: "ISSUED_DAY_STORE", status: { in: ["PENDING", "APPROVED", "PARTIALLY_ISSUED"] }, requestingDayStoreId: scope ? { in: scope } : { not: null } } });
    const productionRequests = await prisma.inventoryRequest.count({
      where: { deletedAt: null, purpose: "ISSUED_PRODUCTION", status: { in: ["PENDING", "APPROVED", "PARTIALLY_ISSUED"] }, plant: scope ? { dayStoreId: { in: scope } } : { dayStoreId: { not: null } } },
    });
    // Per product: every open material is covered at this store (nothing short) / at least one is short.
    const open = (await loadProductionRequests(scope)).filter((r) => r.open);
    const byProduct = new Map<string, boolean>();
    for (const r of open) {
      const key = r.purchaseOrderItemId ?? r.id;
      byProduct.set(key, (byProduct.get(key) ?? false) || r.short);
    }
    const productsShort = [...byProduct.values()].filter(Boolean).length;
    const productsCovered = byProduct.size - productsShort;
    res.json({ received, issuedToPlant, requests, productionRequests, productsCovered, productsShort });
  } catch (err) {
    next(err);
  }
});

// --- Asking the Warehouse for material --------------------------------------------------------------

const createRequestSchema = z.object({
  itemId: z.string().uuid(),
  requestedQty: z.coerce.number().positive(),
  neededBy: z.coerce.date().optional(),
  note: z.string().max(500).optional(),
  // Which of the login's stores this is for - only needed when it is assigned to more than one.
  dayStoreId: z.string().uuid().optional(),
});

myStoreRouter.post("/requests", validateBody(createRequestSchema), async (req: AuthedRequest, res, next) => {
  try {
    const data = req.body as z.infer<typeof createRequestSchema>;
    const scope = await scopeOf(req);
    const stores = await prisma.dayStore.findMany({ where: scope ? { id: { in: scope } } : {}, select: { id: true, name: true } });
    const store = data.dayStoreId ? stores.find((s) => s.id === data.dayStoreId) : stores.length === 1 ? stores[0] : undefined;
    if (!store) return res.status(400).json({ error: stores.length > 1 ? "Choose which Store this request is for." : "You are not assigned to that Store." });

    const item = await prisma.inventoryItem.findUnique({ where: { id: data.itemId } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });

    const request = await prisma.inventoryRequest.create({
      data: { itemId: item.id, category: item.category, requestedQty: data.requestedQty, purpose: "ISSUED_DAY_STORE", neededBy: data.neededBy, note: data.note, requestedById: req.user!.id, requestingDayStoreId: store.id },
    });
    await recordAudit({ actorId: req.user!.id, action: "inventory_request.created", entityType: "InventoryRequest", entityId: request.id, metadata: { itemId: item.id, purpose: "ISSUED_DAY_STORE", requestedQty: data.requestedQty, dayStoreId: store.id } });
    await notifyRoles(["STORE"], { title: `${store.name} needs ${item.name}`, body: `${data.requestedQty} ${item.unit ?? ""} requested`, link: "/material-requests" }, req.user!.id).catch(() => {});
    res.status(201).json({ id: request.id });
  } catch (err) {
    next(err);
  }
});

// This login's own requests, with where each one stands (and, when the Warehouse was short, where the purchase is).
myStoreRouter.get("/requests", async (req: AuthedRequest, res, next) => {
  try {
    const scope = await scopeOf(req);
    const pagination = parsePagination(req);
    const rows = (await loadRows()).filter((r) => r.source === "store" && (!scope || (r.requesterStoreId !== null && scope.includes(r.requesterStoreId))));
    setPaginationHeaders(res, rows.length, pagination);
    res.json(rows.slice(pagination.skip, pagination.skip + pagination.take));
  } catch (err) {
    next(err);
  }
});

for (const kind of ["received", "issued-to-plant"] as const) {
  myStoreRouter.get(`/${kind}`, async (req: AuthedRequest, res, next) => {
    try {
      const pagination = parsePagination(req);
      const where = buildWhere(kind, await scopeOf(req), req);
      const [total, rows] = await Promise.all([
        prisma.inventoryTransaction.count({ where }),
        prisma.inventoryTransaction.findMany({
          where,
          select: {
            id: true,
            date: true,
            unit: true,
            quantity: true,
            batchNo: true,
            grnNo: true,
            fulfillsRequestId: true,
            fulfillsRequest: { select: { isExtra: true } },
            isTransitTracked: true,
            deliveredAt: true,
            item: { select: { name: true, category: true } },
            dayStore: { select: { name: true } },
            plant: { select: { name: true } },
            createdBy: { select: { fullName: true } },
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
          storeName: r.dayStore?.name ?? null,
          plantName: r.plant?.name ?? null,
          batchNo: r.batchNo,
          grnNo: r.grnNo,
          viaRequest: !!r.fulfillsRequestId,
          // Extra material asked for a batch outside its plan (or what R&D's BOM change needs), dispensed with its own GRN
          isExtra: !!r.fulfillsRequest?.isExtra,
          status: r.isTransitTracked && !r.deliveredAt ? "In Transit" : "Delivered",
          issuedBy: r.createdBy.fullName,
        })),
      );
    } catch (err) {
      next(err);
    }
  });

  myStoreRouter.get(`/${kind}/options`, async (req: AuthedRequest, res, next) => {
    try {
      const field = String(req.query.field ?? "");
      const q = parseSearch(req, "q");
      const contains = q ? { contains: q, mode: "insensitive" as const } : undefined;
      const base = baseWhere(kind, await scopeOf(req));
      let values: string[];
      if (field === "store") {
        values = (await prisma.dayStore.findMany({ where: { transactions: { some: base }, ...(contains ? { name: contains } : {}) }, select: { name: true }, orderBy: { name: "asc" }, take: 101 })).map((r) => r.name);
      } else if (field === "item") {
        values = (await prisma.inventoryItem.findMany({ where: { transactions: { some: base }, ...(contains ? { name: contains } : {}) }, select: { name: true }, orderBy: { name: "asc" }, take: 101 })).map((r) => r.name);
      } else if (field === "batchNo" || field === "grnNo") {
        const rows = await prisma.inventoryTransaction.findMany({ where: { AND: [base, { [field]: contains ?? { not: null } }] }, select: { batchNo: true, grnNo: true }, distinct: [field], orderBy: { [field]: "asc" }, take: 101 });
        values = rows.map((r) => r[field]).filter((v): v is string => !!v);
      } else {
        return res.status(400).json({ error: "Unknown filter field" });
      }
      res.json({ values: values.slice(0, 100), hasMore: values.length > 100 });
    } catch (err) {
      next(err);
    }
  });
}
