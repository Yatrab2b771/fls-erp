import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { RouteError } from "../../common/lib/route-error";
import { parsePagination, parseSearch, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { notifyRoles } from "../../common/lib/notify";
import { agingRanges, inAnyRange, inRange, type TileFilters } from "../ppic/ppic-filters";
import { requireWarehouseSeat } from "./day-store-access";
import { getOnHandByItemId, getTotalAvailableByItemId } from "./stock";

/**
 * "Material Requests" (Store dashboard tile) - what Day Stores and the R&D Store have asked the
 * Warehouse for, in one list.
 *
 *   GET /summary             tile count: requests still open (Pending / Approved / Partly issued)
 *   GET /                    the list (?requester ?category ?item ?status ?supply ?short ?dateFrom/?dateTo ?needFrom/?needTo ?aging)
 *   GET /options             dropdown values
 *   POST /:source/:id/escalate   the Warehouse is short: raise the need to PPIC (source = store | rnd)
 *
 * A request that the Warehouse cannot fill is escalated to PPIC as a Pre-Inventory requirement tagged with
 * where it came from; PPIC sends it to Purchase, Purchase logs a PI, Store receives it. The row's "Supply"
 * column follows that trail: With PPIC -> With Purchase -> On order -> Received.
 */
export const materialRequestsRouter = Router();
materialRequestsRouter.use(requireAuth, requireRole("STORE", "PPIC"));

const EPS = 1e-6;
const round2 = (n: number) => Math.round(n * 100) / 100;
const many = (raw: unknown): string[] => (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, 500);
const isoDay = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const dayRange = (from?: string, to?: string) => (from || to ? { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}) } : undefined);

export type SupplyStage = "NONE" | "WITH_PPIC" | "WITH_PURCHASE" | "ON_ORDER" | "RECEIVED";
export const SUPPLY_LABEL: Record<SupplyStage, string> = {
  NONE: "—",
  WITH_PPIC: "With PPIC",
  WITH_PURCHASE: "With Purchase",
  ON_ORDER: "On order",
  RECEIVED: "Received",
};
const STATUS_LABEL = { PENDING: "Pending", APPROVED: "Approved", PARTIALLY_ISSUED: "Partly issued", ISSUED: "Issued", REJECTED: "Rejected", FULFILLED: "Issued", CANCELLED: "Cancelled" } as const;
const OPEN_STORE = ["PENDING", "APPROVED", "PARTIALLY_ISSUED"] as const;

export const requirementSelect = {
  id: true,
  sourceRequestId: true,
  sourceRndRequestId: true,
  purchaseNotifiedAt: true,
  purchaseLines: { select: { status: true, eta: true, piNumber: true, vendorName: true } },
} satisfies Prisma.PreInventoryRequirementSelect;

/** Where a request's purchase need stands, from its linked requirement (if any). */
export function supplyOf(req: Prisma.PreInventoryRequirementGetPayload<{ select: typeof requirementSelect }> | undefined): { stage: SupplyStage; eta: string | null; piNumber: string | null; requirementId: string | null } {
  if (!req) return { stage: "NONE", eta: null, piNumber: null, requirementId: null };
  const open = req.purchaseLines.filter((l) => l.status === "OPEN").sort((a, b) => a.eta.getTime() - b.eta.getTime());
  if (open.length) return { stage: "ON_ORDER", eta: open[0]!.eta.toISOString(), piNumber: open[0]!.piNumber, requirementId: req.id };
  if (req.purchaseLines.length) return { stage: "RECEIVED", eta: null, piNumber: null, requirementId: req.id };
  return { stage: req.purchaseNotifiedAt ? "WITH_PURCHASE" : "WITH_PPIC", eta: null, piNumber: null, requirementId: req.id };
}

export interface MaterialRequestRow {
  key: string;
  source: "store" | "rnd";
  id: string;
  requestedAt: string;
  requesterType: "Day Store" | "R&D Store";
  requesterName: string;
  requesterStoreId: string | null;
  requestedBy: string;
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  requestedQty: number;
  issuedQty: number;
  remainingQty: number;
  neededBy: string | null;
  statusKey: string;
  status: string;
  open: boolean;
  warehouseOnHand: number;
  short: boolean;
  shortBy: number;
  supply: SupplyStage;
  supplyLabel: string;
  eta: string | null;
  piNumber: string | null;
  requirementId: string | null;
  note: string | null;
  // Plan-driven: this request exists to fill a production request, for this product / PO (urgent).
  forPlan: boolean;
  // The production request behind it is Production's "extra material" (not part of any plan).
  forExtra: boolean;
  forProductionRequestId: string | null;
  purchaseOrderItemId: string | null;
  productName: string | null;
  poNumber: string | null;
  customerName: string | null;
  plantName: string | null;
  overdue: boolean;
}

export async function loadRows(): Promise<MaterialRequestRow[]> {
  const [storeRequests, rndRequests] = await Promise.all([
    prisma.inventoryRequest.findMany({
      where: { deletedAt: null, purpose: "ISSUED_DAY_STORE", requestingDayStoreId: { not: null } },
      select: {
        id: true,
        createdAt: true,
        itemId: true,
        category: true,
        requestedQty: true,
        neededBy: true,
        note: true,
        status: true,
        forRequestId: true,
        purchaseOrderItemId: true,
        item: { select: { name: true, unit: true } },
        requestedBy: { select: { fullName: true } },
        requestingDayStoreId: true,
        requestingDayStore: { select: { name: true } },
        fulfillments: { where: { deletedAt: null }, select: { quantity: true, unit: true } },
      },
    }),
    prisma.rndSampleRequest.findMany({
      select: { id: true, requestedAt: true, itemId: true, quantity: true, unit: true, note: true, status: true, item: { select: { name: true, category: true } }, requestedBy: { select: { fullName: true } } },
    }),
  ]);

  // The product / PO (and Plant) behind the plan-driven requests.
  const poItemIds = [...new Set(storeRequests.map((r) => r.purchaseOrderItemId).filter((id): id is string => !!id))];
  const forIds = [...new Set(storeRequests.map((r) => r.forRequestId).filter((id): id is string => !!id))];
  const [poItems, productionRequests] = await Promise.all([
    poItemIds.length ? prisma.purchaseOrderItem.findMany({ where: { id: { in: poItemIds } }, select: { id: true, productName: true, purchaseOrder: { select: { poNumber: true, customer: { select: { companyName: true } } } } } }) : [],
    forIds.length ? prisma.inventoryRequest.findMany({ where: { id: { in: forIds } }, select: { id: true, isExtra: true, plant: { select: { name: true } } } }) : [],
  ]);
  const poItemById = new Map(poItems.map((p) => [p.id, p]));
  const plantByProductionRequest = new Map(productionRequests.map((p) => [p.id, p.plant?.name ?? null]));
  const extraProductionRequests = new Set(productionRequests.filter((p) => p.isExtra).map((p) => p.id));
  const startOfToday = new Date(new Date().toDateString()).getTime();

  const requirements = await prisma.preInventoryRequirement.findMany({
    where: { deletedAt: null, OR: [{ sourceRequestId: { in: storeRequests.map((r) => r.id) } }, { sourceRndRequestId: { in: rndRequests.map((r) => r.id) } }] },
    select: requirementSelect,
  });
  const reqByStore = new Map(requirements.filter((r) => r.sourceRequestId).map((r) => [r.sourceRequestId!, r]));
  const reqByRnd = new Map(requirements.filter((r) => r.sourceRndRequestId).map((r) => [r.sourceRndRequestId!, r]));

  const onHand = await getOnHandByItemId([...new Set([...storeRequests.map((r) => r.itemId), ...rndRequests.map((r) => r.itemId)])]);

  const rows: MaterialRequestRow[] = [];
  for (const r of storeRequests) {
    const issuedQty = round2(r.fulfillments.reduce((sum, f) => sum + f.quantity, 0));
    const remainingQty = round2(Math.max(0, r.requestedQty - issuedQty));
    const open = (OPEN_STORE as readonly string[]).includes(r.status);
    const stock = Math.max(0, onHand.get(r.itemId) ?? 0);
    const supply = supplyOf(reqByStore.get(r.id));
    rows.push({
      key: `store:${r.id}`,
      source: "store",
      id: r.id,
      requestedAt: r.createdAt.toISOString(),
      requesterType: "Day Store",
      requesterName: r.requestingDayStore?.name ?? "—",
      requesterStoreId: r.requestingDayStoreId,
      requestedBy: r.requestedBy.fullName,
      itemId: r.itemId,
      itemName: r.item.name,
      category: r.category,
      unit: r.item.unit ?? "",
      requestedQty: r.requestedQty,
      issuedQty,
      remainingQty,
      neededBy: r.neededBy?.toISOString() ?? null,
      statusKey: r.status,
      status: STATUS_LABEL[r.status],
      open,
      warehouseOnHand: round2(stock),
      short: open && remainingQty - stock > EPS,
      shortBy: open ? round2(Math.max(0, remainingQty - stock)) : 0,
      supply: supply.stage,
      supplyLabel: SUPPLY_LABEL[supply.stage],
      eta: supply.eta,
      piNumber: supply.piNumber,
      requirementId: supply.requirementId,
      note: r.note,
      forPlan: !!r.forRequestId,
      forExtra: !!r.forRequestId && extraProductionRequests.has(r.forRequestId),
      forProductionRequestId: r.forRequestId,
      purchaseOrderItemId: r.purchaseOrderItemId,
      productName: r.purchaseOrderItemId ? (poItemById.get(r.purchaseOrderItemId)?.productName ?? null) : null,
      poNumber: r.purchaseOrderItemId ? (poItemById.get(r.purchaseOrderItemId)?.purchaseOrder.poNumber ?? null) : null,
      customerName: r.purchaseOrderItemId ? (poItemById.get(r.purchaseOrderItemId)?.purchaseOrder.customer.companyName ?? null) : null,
      plantName: r.forRequestId ? (plantByProductionRequest.get(r.forRequestId) ?? null) : null,
      overdue: open && !!r.neededBy && r.neededBy.getTime() < startOfToday,
    });
  }
  for (const r of rndRequests) {
    const open = r.status === "PENDING";
    const fulfilled = r.status === "FULFILLED";
    const stock = Math.max(0, onHand.get(r.itemId) ?? 0);
    const supply = supplyOf(reqByRnd.get(r.id));
    rows.push({
      key: `rnd:${r.id}`,
      source: "rnd",
      id: r.id,
      requestedAt: r.requestedAt.toISOString(),
      requesterType: "R&D Store",
      requesterName: "R&D Store",
      requesterStoreId: null,
      requestedBy: r.requestedBy.fullName,
      itemId: r.itemId,
      itemName: r.item.name,
      category: r.item.category,
      unit: r.unit,
      requestedQty: r.quantity,
      issuedQty: fulfilled ? r.quantity : 0,
      remainingQty: fulfilled ? 0 : r.quantity,
      neededBy: null,
      statusKey: r.status,
      status: STATUS_LABEL[r.status],
      open,
      warehouseOnHand: round2(stock),
      short: open && r.quantity - stock > EPS,
      shortBy: open ? round2(Math.max(0, r.quantity - stock)) : 0,
      supply: supply.stage,
      supplyLabel: SUPPLY_LABEL[supply.stage],
      eta: supply.eta,
      piNumber: supply.piNumber,
      requirementId: supply.requirementId,
      note: r.note,
      forPlan: false,
      forExtra: false,
      forProductionRequestId: null,
      purchaseOrderItemId: null,
      productName: null,
      poNumber: null,
      customerName: null,
      plantName: null,
      overdue: false,
    });
  }
  return rows;
}

materialRequestsRouter.get("/summary", requireWarehouseSeat, async (_req: AuthedRequest, res, next) => {
  try {
    const openStore = { deletedAt: null, purpose: "ISSUED_DAY_STORE" as const, requestingDayStoreId: { not: null }, status: { in: [...OPEN_STORE] } };
    const [store, plan, planOverdue, rnd] = await Promise.all([
      prisma.inventoryRequest.count({ where: { ...openStore, forRequestId: null } }),
      prisma.inventoryRequest.count({ where: { ...openStore, forRequestId: { not: null } } }),
      prisma.inventoryRequest.count({ where: { ...openStore, forRequestId: { not: null }, neededBy: { lt: new Date(new Date().toDateString()) } } }),
      prisma.rndSampleRequest.count({ where: { status: "PENDING" } }),
    ]);
    // "open" is the regular Day Store / R&D requests; the plan-driven ones are counted apart (their own, urgent, tile).
    res.json({ open: store + rnd, dayStore: store, rnd, plan, planOverdue });
  } catch (err) {
    next(err);
  }
});

materialRequestsRouter.get("/", requireWarehouseSeat, async (req: AuthedRequest, res, next) => {
  try {
    // Extra material the Warehouse cannot cover goes to PPIC by itself (also catches stock that dropped since the ask was made).
    await autoEscalateExtraAsks().catch((err) => req.log?.error({ err }, "autoEscalateExtraAsks failed"));
    const pagination = parsePagination(req);
    const q = req.query;
    const set = (key: string) => new Set(many(q[key]));
    const [requesters, categories, itemNames, statuses, supplies, products, pos] = [set("requester"), set("category"), set("item"), set("status"), set("supply"), set("product"), set("po")];
    const planOnly = q.kind === "plan";
    const shortOnly = many(q.short);
    const requested = dayRange(isoDay(q.dateFrom), isoDay(q.dateTo));
    const needed = dayRange(isoDay(q.needFrom), isoDay(q.needTo));
    const aging = agingRanges({ aging: many(q.aging) } as TileFilters);

    const rows = (await loadRows())
      .filter(
        (r) =>
          r.forPlan === planOnly &&
          (!products.size || products.has(r.productName ?? "")) &&
          (!pos.size || pos.has(r.poNumber ?? "")) &&
          (!requesters.size || requesters.has(r.requesterName)) &&
          (!categories.size || categories.has(r.category)) &&
          (!itemNames.size || itemNames.has(r.itemName)) &&
          (!statuses.size || statuses.has(r.status)) &&
          (!supplies.size || supplies.has(r.supplyLabel)) &&
          (!shortOnly.length || shortOnly.includes(r.short ? "Yes" : "No")) &&
          inRange(r.requestedAt, requested) &&
          inRange(r.neededBy, needed) &&
          inAnyRange(r.requestedAt, aging),
      )
      // Open ones first. The plan-driven list is urgent work: late ones first, then the soonest needed-by.
      .sort((a, b) =>
        planOnly
          ? Number(b.open) - Number(a.open) || Number(b.overdue) - Number(a.overdue) || (a.neededBy ?? "9").localeCompare(b.neededBy ?? "9") || a.requestedAt.localeCompare(b.requestedAt)
          : Number(b.open) - Number(a.open) || b.requestedAt.localeCompare(a.requestedAt),
      );

    setPaginationHeaders(res, rows.length, pagination);
    res.json(rows.slice(pagination.skip, pagination.skip + pagination.take));
  } catch (err) {
    next(err);
  }
});

materialRequestsRouter.get("/options", requireWarehouseSeat, async (req: AuthedRequest, res, next) => {
  try {
    const field = String(req.query.field ?? "");
    const needle = parseSearch(req, "q")?.toLowerCase();
    const rows = await loadRows();
    const pick: Record<string, (r: MaterialRequestRow) => string | null> = { requester: (r) => r.requesterName, item: (r) => r.itemName, product: (r) => r.productName, po: (r) => r.poNumber };
    const get = pick[field];
    if (!get) return res.status(400).json({ error: "Unknown filter field" });
    const planOnly = req.query.kind === "plan";
    const values = [...new Set(rows.filter((r) => r.forPlan === planOnly).map(get).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b)).filter((v) => !needle || v.toLowerCase().includes(needle));
    res.json({ values: values.slice(0, 100), hasMore: values.length > 100 });
  } catch (err) {
    next(err);
  }
});

// Raises a short request's need to PPIC as a Pre-Inventory requirement tagged with where it came from. Pre-Inventory measures a shortfall
// against everything the company holds (Warehouse + stores + Plants + R&D), so the need is stated as "what we hold now, plus what is
// still missing" - that way its shortfall is exactly what the Warehouse is short by (only the missing part goes to Purchase).
async function escalateRow(row: MaterialRequestRow, actorId: string, requesterNote: string, auto: boolean): Promise<string> {
  const held = (await getTotalAvailableByItemId([row.itemId])).get(row.itemId) ?? 0;
  const requirement = await prisma.preInventoryRequirement.create({
    data: {
      date: new Date(),
      category: row.category,
      itemId: row.itemId,
      unit: row.unit,
      requiredQty: round2(Math.max(0, held) + row.shortBy),
      note: `${requesterNote} - Warehouse short by ${row.shortBy} ${row.unit}`,
      requestedById: actorId,
      ...(row.source === "store" ? { sourceRequestId: row.id } : { sourceRndRequestId: row.id }),
    },
  });
  await recordAudit({ actorId, action: "material_request.escalated", entityType: "PreInventoryRequirement", entityId: requirement.id, metadata: { source: row.source, requestId: row.id, shortBy: row.shortBy, automatic: auto || undefined } });
  await notifyRoles(
    ["PPIC"],
    { title: `${row.requesterName} needs ${row.itemName}${row.forExtra ? " (extra material)" : ""}`, body: `${row.shortBy} ${row.unit} short at the Warehouse - review and send to Purchase.`, link: "/pre-inventory" },
    actorId,
  ).catch(() => {});
  return requirement.id;
}

/**
 * Extra material (Production's requests outside any plan): when the Day Store has asked the Warehouse and the Warehouse cannot cover it, the
 * need goes to PPIC by itself - nobody has to press anything. PPIC then sends it to Purchase from Pre-Inventory. Plan-driven requests do not
 * use this: their shortage already reaches Purchase from Material Planning. Safe to call often; a request is escalated once.
 */
export async function autoEscalateExtraAsks(): Promise<number> {
  const rows = (await loadRows()).filter((r) => r.source === "store" && r.open && r.short && !r.requirementId && r.forExtra);
  if (rows.length === 0) return 0;
  const askers = new Map((await prisma.inventoryRequest.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, requestedById: true } })).map((a) => [a.id, a.requestedById]));
  let done = 0;
  for (const row of rows) {
    const actorId = askers.get(row.id);
    if (!actorId) continue;
    await escalateRow(row, actorId, `Extra material for ${row.plantName ?? row.requesterName}`, true);
    done += 1;
  }
  return done;
}

// The Warehouse cannot fill this request: raise the need to PPIC (a Pre-Inventory requirement tagged with its source).
materialRequestsRouter.post("/:source/:id/escalate", requireRole("STORE"), requireWarehouseSeat, async (req: AuthedRequest<{ source: string; id: string }>, res, next) => {
  try {
    const { source, id } = req.params;
    if (source !== "store" && source !== "rnd") return res.status(400).json({ error: "Unknown request source" });
    const row = (await loadRows()).find((r) => r.source === source && r.id === id);
    if (!row) return res.status(404).json({ error: "Request not found" });
    if (!row.open) return res.status(409).json({ error: "This request is already closed." });
    if (!row.short) return res.status(409).json({ error: "The Warehouse has enough stock for this - issue it instead." });
    if (row.requirementId) return res.status(409).json({ error: "This request has already been sent to PPIC." });

    const requirementId = await escalateRow(row, req.user!.id, `For ${row.requesterName} material request`, false);

    res.status(201).json({ requirementId });
  } catch (err) {
    if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});
