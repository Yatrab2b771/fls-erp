import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { parsePagination, parseSearch, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, type AuthedRequest } from "../../common/middleware/auth";
import { poVisibilityWhere } from "../purchase-orders/po-visibility";
import { computeCompletion, computeItemDispatch, poInclude } from "../purchase-orders/po-completion";
import { getMaterialPlanning, type MaterialPlanningProduct, type MaterialPlanningResult, type MaterialPlanningRow } from "../purchase-orders/material-planning";
import { getPendingPoMaterials } from "../purchase-orders/pending-materials";
import { getTotalAvailableByItemId } from "../inventory/stock";
import { itemStageOf, ITEM_STAGE_LABEL, type ItemStage } from "./data-integrity";
import { agingRanges, approvalDateWhere, dateRange, inAnyRange, inRange, itemLevelWhere, poLevelWhere, productMatches, readFilters, type TileFilters } from "./ppic-filters";

/**
 * PPIC's dashboard, computed on the server over EVERY purchase order - so the
 * tiles stay right and the lists stay fast however many POs there are, and the
 * browser only ever receives one page at a time.
 *
 *   GET /summary                          every tile's number, in one call
 *   GET /lists/:metric                    a tile's list, product by product (paged, searched)
 *   GET /material-planning                Material Planning's rows (paged, searched, filtered)
 *   GET /material-planning/summary        the header counts of that same filtered view
 *   GET /ready-products                   PO Readiness: products whose material is all covered
 *
 * Visibility is the PO rule everywhere (poVisibilityWhere): non-BD/Admin only
 * ever see Approved POs.
 */
export const ppicRouter = Router();
ppicRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

const METRICS = [
  "total-pos",
  "not-planned-pos",
  "total-products",
  "pending-pos",
  "have-bom",
  "have-rm-bom",
  "missing-both",
  "plan-sent",
  "plan-not-sent",
  "on-hold",
  "cancelled",
] as const;
type Metric = (typeof METRICS)[number];

const SEARCH_FIELDS = ["all", "po", "customer", "product", "category"] as const;
type SearchField = (typeof SEARCH_FIELDS)[number];

const liveItem = { deletedAt: null, cancelledAt: null } satisfies Prisma.PurchaseOrderItemWhereInput;
const calculated = { some: { status: "CALCULATED" as const } };
// "Fully planned" = BOTH the RM plan and the packaging BOM plan are calculated.
// A product on Hold is listed only under On Hold, and one already sent to Production only under In Production - never here.
// "No batch made yet": Hold and Cancel are possible until then, and a held product (sent to Production or not) is listed only under On Hold.
// "No batch yet": Production has not started making any (a batch still at its own Indent / Batch No / Dispensing / Line Clearance does not count).
const noBatchYet: Prisma.PurchaseOrderItemWhereInput = { OR: [{ preProduction: null }, { preProduction: { productionBatches: { none: { prepStageId: "READY" } } } }] };
const notFullyPlanned: Prisma.PurchaseOrderItemWhereInput = { materialHeldAt: null, planSentToProductionAt: null, NOT: { AND: [{ rmPlans: calculated }, { bomPlans: calculated }] } };

function searchField(raw: unknown): SearchField {
  return typeof raw === "string" && (SEARCH_FIELDS as readonly string[]).includes(raw) ? (raw as SearchField) : "all";
}

/** Product-level text search, limited to the field the user picked ("all" = every field). */
function itemSearchWhere(search: string | undefined, field: SearchField): Prisma.PurchaseOrderItemWhereInput | undefined {
  if (!search) return undefined;
  const has = { contains: search, mode: "insensitive" as const };
  const po: Prisma.PurchaseOrderItemWhereInput = { purchaseOrder: { poNumber: has } };
  const customer: Prisma.PurchaseOrderItemWhereInput = { purchaseOrder: { customer: { companyName: has } } };
  const product: Prisma.PurchaseOrderItemWhereInput = { productName: has };
  const category: Prisma.PurchaseOrderItemWhereInput = { productCategory: has };
  switch (field) {
    case "po":
      return po;
    case "customer":
      return customer;
    case "product":
      return product;
    case "category":
      return category;
    default:
      return { OR: [po, customer, product, category] };
  }
}

/** A product's stage from the item rows the PPIC lists load (see itemInclude). */
function stageFor(i: Prisma.PurchaseOrderItemGetPayload<{ include: typeof itemInclude }>, po: { status: string }, shortIds: Set<string>): ItemStage {
  return itemStageOf({
    poApproved: po.status === "APPROVED",
    cancelled: !!i.cancelledAt,
    held: !!i.materialHeldAt,
    rmDone: i.rmPlans.some((p) => p.status === "CALCULATED"),
    bomDone: i.bomPlans.some((p) => p.status === "CALCULATED"),
    planSent: !!i.planSentToProductionAt,
    isShort: shortIds.has(i.id),
    quantity: i.quantity,
    batches: (i.preProduction?.productionBatches ?? []).map((b) => ({ currentStageId: b.currentStageId, prepStageId: b.prepStageId, handedOverToDispatchAt: b.handedOverToDispatchAt, customerShippedQty: b.fgShipments.reduce((a, s) => a + s.quantity, 0) })),
  });
}

/** How many POs / products are finished, out of how many: a PO is complete once every live product of it has gone to the customer. */
async function completionCounts(visible: Prisma.PurchaseOrderWhereInput) {
  const orders = await prisma.purchaseOrder.findMany({ where: { AND: [visible, { status: { not: "REJECTED" } }] }, include: poInclude });
  const completedPos = orders.filter((po) => computeCompletion(po).isCompleted).length;
  let completedProducts = 0;
  let totalProducts = 0;
  for (const po of orders) {
    for (const item of po.items) {
      if (item.cancelledAt) continue;
      totalProducts += 1;
      if (computeItemDispatch(item).isDone) completedProducts += 1;
    }
  }
  return { pendingPos: orders.length - completedPos, completedPos, completedProducts, totalProducts, nonRejectedPos: orders.length };
}

/** POs that are still open: not Rejected and not yet fully shipped (completion is derived, so it's computed here). */
async function pendingPoIds(visible: Prisma.PurchaseOrderWhereInput): Promise<string[]> {
  const orders = await prisma.purchaseOrder.findMany({ where: { AND: [visible, { status: { not: "REJECTED" } }] }, include: poInclude });
  return orders.filter((po) => !computeCompletion(po).isCompleted).map((po) => po.id);
}

const poSelect = {
  id: true,
  poNumber: true,
  status: true,
  orderDate: true,
  expectedDeliveryDate: true,
  createdAt: true,
  reviewedAt: true,
  regulatoryBody: true,
  customer: { select: { id: true, companyName: true } },
} satisfies Prisma.PurchaseOrderSelect;

const itemInclude = {
  purchaseOrder: { select: poSelect },
  plannedPlant: { select: { id: true, name: true } },
  bomPlans: { select: { id: true, name: true, status: true }, orderBy: { createdAt: "desc" as const } },
  rmPlans: { select: { id: true, name: true, status: true }, orderBy: { createdAt: "desc" as const } },
  preProduction: { select: { id: true, currentStageId: true, productionBatches: { select: { currentStageId: true, prepStageId: true, handedOverToDispatchAt: true, fgShipments: { where: { type: "CUSTOMER" as const, status: "DISPATCHED" as const, deletedAt: null }, select: { quantity: true } } } } } },
} satisfies Prisma.PurchaseOrderItemInclude;

// ---------------------------------------------------------------------------
// Summary - every tile's number
// ---------------------------------------------------------------------------

/** "PO Logged by Purchase": requirements with a PO logged that are still short against live stock (same rule as Pre-Inventory's own status). */
async function countPoLogged(isPpicOnly: boolean, userId: string): Promise<number> {
  const rows = await prisma.preInventoryRequirement.findMany({
    // A shortfall counts while at least one of its PI lines is still to arrive.
    where: { deletedAt: null, purchaseLines: { some: { status: "OPEN" } }, ...(isPpicOnly ? { requestedById: userId } : {}) },
    select: { itemId: true, requiredQty: true },
  });
  if (rows.length === 0) return 0;
  const onHand = await getTotalAvailableByItemId([...new Set(rows.map((r) => r.itemId))]);
  return rows.filter((r) => r.requiredQty - (onHand.get(r.itemId) ?? 0) > 0).length;
}

/** Material Planning lists only products still being planned and short of material - the ones already sent to Production live under the In Production tile (their stock claim still counts in the FIFO). */
function pendingPlanning(planning: MaterialPlanningResult): MaterialPlanningResult {
  // Held products are out too: they are listed only under On Hold.
  // And only products with a material short: fully covered ones are listed under PO Readiness instead.
  const sent = new Set(planning.products.filter((p) => p.state === "SENT" || p.state === "HELD" || !p.hasShortfall).map((p) => p.purchaseOrderItemId));
  return { products: planning.products.filter((p) => !sent.has(p.purchaseOrderItemId)), rows: planning.rows.filter((r) => !sent.has(r.purchaseOrderItemId)) };
}

/** The moment a product entered the list `metric` - what Aging counts from. */
function sinceAtFor(
  metric: Metric,
  po: { reviewedAt: Date | null; orderDate: Date | null; createdAt: Date },
  item: { planSentToProductionAt: Date | null; materialHeldAt: Date | null; cancelledAt: Date | null },
): Date {
  const approvedAt = po.reviewedAt ?? po.orderDate ?? po.createdAt;
  if (metric === "plan-sent") return item.planSentToProductionAt ?? approvedAt;
  if (metric === "on-hold") return item.materialHeldAt ?? approvedAt;
  if (metric === "cancelled") return item.cancelledAt ?? approvedAt;
  return approvedAt;
}

// A product Regulatory marked Not Approved is still listed (with its red pill): it is covered, it just cannot be sent.
function isReady(product: MaterialPlanningProduct, rows: MaterialPlanningRow[]): boolean {
  return (product.state === "ACTIVE" || product.state === "NOT_APPROVED") && rows.length > 0 && rows.every((r) => r.status === "COVERED");
}

function readyProducts(planning: MaterialPlanningResult): { product: MaterialPlanningProduct; materials: number }[] {
  const byItem = new Map<string, MaterialPlanningRow[]>();
  for (const r of planning.rows) byItem.set(r.purchaseOrderItemId, [...(byItem.get(r.purchaseOrderItemId) ?? []), r]);
  const out: { product: MaterialPlanningProduct; materials: number }[] = [];
  for (const product of planning.products) {
    const rows = byItem.get(product.purchaseOrderItemId) ?? [];
    if (isReady(product, rows)) out.push({ product, materials: rows.length });
  }
  return out;
}

ppicRouter.get("/summary", async (req: AuthedRequest, res, next) => {
  try {
    const roles = req.user!.roles;
    const visible = poVisibilityWhere(roles);
    const approved: Prisma.PurchaseOrderWhereInput = { AND: [visible, { status: "APPROVED" }] };
    const isPpicOnly = roles.every((r) => r === "PPIC");

    const [totalPos, totalProducts, notPlannedPos, notPlannedProducts, inProduction, onHold, cancelled, pending, planning, qaAwaited, poLogged, bdRequests] = await Promise.all([
      prisma.purchaseOrder.count({ where: visible }),
      prisma.purchaseOrderItem.count({ where: { ...liveItem, purchaseOrder: visible } }),
      prisma.purchaseOrder.count({ where: { AND: [approved, { items: { some: { ...liveItem, ...notFullyPlanned } } }] } }),
      prisma.purchaseOrderItem.count({ where: { ...liveItem, ...notFullyPlanned, purchaseOrder: approved } }),
      prisma.purchaseOrderItem.count({ where: { ...liveItem, materialHeldAt: null, planSentToProductionAt: { not: null }, purchaseOrder: approved } }),
      prisma.purchaseOrderItem.count({ where: { AND: [{ ...liveItem, materialHeldAt: { not: null }, purchaseOrder: approved }, noBatchYet] } }),
      prisma.purchaseOrderItem.count({ where: { deletedAt: null, cancelledAt: { not: null }, purchaseOrder: approved } }),
      completionCounts(visible),
      getMaterialPlanning(),
      // Awaiting Inward QC: not yet sampled, being tested, or on hold (the Inward QC page lists exactly these)
      prisma.inventoryTransaction.count({ where: { type: "RECEIVED", receiptStatus: { in: ["PENDING_QC", "TESTING", "ON_HOLD"] }, deletedAt: null } }),
      countPoLogged(isPpicOnly, req.user!.id),
      prisma.itemChangeRequest.count({ where: { status: "PENDING" } }),
    ]);

    res.json({
      totalPos,
      totalProducts,
      notPlannedPos,
      notPlannedProducts,
      materialPlanning: pendingPlanning(planning).products.length,
      materialShortProducts: pendingPlanning(planning).products.filter((p) => p.hasShortfall && p.state !== "HELD" && p.state !== "NOT_APPROVED").length,
      poReadiness: readyProducts(planning).length,
      inProduction,
      onHold,
      cancelled,
      pendingPos: pending.pendingPos,
      completedPos: pending.completedPos,
      completedProducts: pending.completedProducts,
      poLogged,
      bdRequests,
      qaAwaited,
    });
  } catch (err) {
    next(err);
  }
});

/** What a product-level tile lists: the product filter plus the PO filter it sits behind. */
async function tileScope(metric: Metric, visible: Prisma.PurchaseOrderWhereInput): Promise<{ itemWhere: Prisma.PurchaseOrderItemWhereInput; poFilter: Prisma.PurchaseOrderWhereInput[] }> {
  const poFilter: Prisma.PurchaseOrderWhereInput[] = [visible];
  let itemWhere: Prisma.PurchaseOrderItemWhereInput;
  switch (metric) {
    case "not-planned-pos":
      itemWhere = { ...liveItem, ...notFullyPlanned };
      poFilter.push({ status: "APPROVED" });
      break;
    case "total-products":
      itemWhere = { ...liveItem };
      break;
    case "plan-sent":
      itemWhere = { ...liveItem, materialHeldAt: null, planSentToProductionAt: { not: null } };
      break;
    case "plan-not-sent":
      itemWhere = { ...liveItem, planSentToProductionAt: null };
      break;
    case "on-hold":
      itemWhere = { AND: [{ ...liveItem, materialHeldAt: { not: null } }, noBatchYet] };
      poFilter.push({ status: "APPROVED" });
      break;
    case "cancelled":
      itemWhere = { deletedAt: null, cancelledAt: { not: null } };
      poFilter.push({ status: "APPROVED" });
      break;
    default: {
      // pending-pos / have-bom / have-rm-bom / missing-both: products on POs that are still open.
      const ids = await pendingPoIds(visible);
      poFilter.push({ id: { in: ids } });
      itemWhere =
        metric === "have-bom"
          ? { ...liveItem, materialHeldAt: null, bomPlans: calculated }
          : metric === "have-rm-bom"
            ? { ...liveItem, materialHeldAt: null, rmPlans: calculated }
            : metric === "missing-both"
              ? { ...liveItem, materialHeldAt: null, bomPlans: { none: { status: "CALCULATED" } }, rmPlans: { none: { status: "CALCULATED" } } }
              : { ...liveItem, materialHeldAt: null };
    }
  }
  return { itemWhere, poFilter };
}

/** The date a tile's own "since" lives on a product, when it isn't the PO's approval date. */
function itemDateWhere(metric: Metric, range: ReturnType<typeof dateRange>, aging: ReturnType<typeof agingRanges>): Prisma.PurchaseOrderItemWhereInput[] | undefined {
  const field = metric === "plan-sent" ? "planSentToProductionAt" : metric === "on-hold" ? "materialHeldAt" : metric === "cancelled" ? "cancelledAt" : null;
  if (!field) return undefined;
  return [...(range ? [{ [field]: range }] : []), ...(aging ? [{ OR: aging.map((r) => ({ [field]: r })) }] : [])];
}

/** PO-level date conditions: the picked date range and Aging buckets, both counted from the approval date. */
function approvalConditions(range: ReturnType<typeof dateRange>, aging: ReturnType<typeof agingRanges>): Prisma.PurchaseOrderWhereInput[] {
  return [...(range ? [approvalDateWhere(range)] : []), ...(aging ? [{ OR: aging.map((r) => approvalDateWhere(r)) }] : [])];
}

// ---------------------------------------------------------------------------
// A tile's list - one row per product (or per PO for "total-pos")
// ---------------------------------------------------------------------------

ppicRouter.get("/lists/:metric", async (req: AuthedRequest<{ metric: string }>, res, next) => {
  try {
    const metric = req.params.metric as Metric;
    if (!(METRICS as readonly string[]).includes(metric)) return res.status(404).json({ error: "Unknown list" });

    const pagination = parsePagination(req);
    const search = parseSearch(req);
    const field = searchField(req.query.searchField);
    const filters = readFilters(req);
    const range = dateRange(filters);
    const aging = agingRanges(filters);
    const visible = poVisibilityWhere(req.user!.roles);

    // ---- PO-level list
    if (metric === "total-pos") {
      const has = { contains: search ?? "", mode: "insensitive" as const };
      const where: Prisma.PurchaseOrderWhereInput = {
        AND: [
          visible,
          ...approvalConditions(range, aging),
          ...poLevelWhere(filters),
          ...(search ? [{ OR: [{ poNumber: has }, { customer: { companyName: has } }] }] : []),
        ],
      };
      // Each PO shows its stage, and each of its products' stage (cancelled products are out of the completed count)
      const shortIds = new Set((await getMaterialPlanning()).products.filter((p) => p.hasShortfall).map((p) => p.purchaseOrderItemId));
      const enrich = (po: Prisma.PurchaseOrderGetPayload<{ include: typeof poInclude }>) => {
          const live = po.items.filter((i) => !i.cancelledAt);
          const stageOfItem = (i: (typeof po.items)[number]) =>
            itemStageOf({
              poApproved: po.status === "APPROVED",
              cancelled: !!i.cancelledAt,
              held: !!i.materialHeldAt,
              rmDone: i.rmPlans.some((p) => p.status === "CALCULATED"),
              bomDone: i.bomPlans.some((p) => p.status === "CALCULATED"),
              planSent: !!i.planSentToProductionAt,
              isShort: shortIds.has(i.id),
              quantity: i.quantity,
              batches: (i.preProduction?.productionBatches ?? []).map((b) => ({ currentStageId: b.currentStageId, prepStageId: b.prepStageId, handedOverToDispatchAt: b.handedOverToDispatchAt, customerShippedQty: b.fgShipments.reduce((a, s) => a + s.quantity, 0) })),
            });
          const stages = live.map(stageOfItem);
          // Each product's own stage, for the products dropdown of the row
          const itemStages = Object.fromEntries(po.items.map((i) => [i.id, ITEM_STAGE_LABEL[stageOfItem(i)]]));
          const completed = stages.filter((s) => s === "COMPLETED").length;
          const stage = po.status === "DRAFT" ? "Draft" : po.status === "REJECTED" ? "Rejected" : live.length > 0 && completed === live.length ? "Completed" : completed > 0 ? "In progress" : "Approved";
          return { ...po, completion: computeCompletion(po), sinceAt: po.reviewedAt ?? po.orderDate ?? po.createdAt, stageSummary: { stage, completed, total: live.length }, itemStages };
      };
      const stagePicks = filters.stage;
      let total: number;
      let orders: Prisma.PurchaseOrderGetPayload<{ include: typeof poInclude }>[];
      let rows: ReturnType<typeof enrich>[];
      if (stagePicks.length > 0) {
        // A PO's stage is worked out from its products, so the Stage pick is applied on the whole matching list, then paged.
        const everything = await prisma.purchaseOrder.findMany({ where, include: poInclude, orderBy: { createdAt: "desc" } });
        const keep = everything.map(enrich).filter((r) => stagePicks.includes(r.stageSummary.stage));
        total = keep.length;
        rows = keep.slice(pagination.skip, pagination.skip + pagination.take);
      } else {
        [total, orders] = await Promise.all([
          prisma.purchaseOrder.count({ where }),
          prisma.purchaseOrder.findMany({ where, include: poInclude, orderBy: { createdAt: "desc" }, skip: pagination.skip, take: pagination.take }),
        ]);
        rows = orders.map(enrich);
      }
      setPaginationHeaders(res, total, pagination);
      return res.json(rows);
    }

    // ---- product-level lists
    const { itemWhere, poFilter } = await tileScope(metric, visible);
    // Date: each tile counts from its own moment (see sinceAtFor) - Aging and the date range agree.
    const itemDate = itemDateWhere(metric, range, aging);
    if (!itemDate) poFilter.push(...approvalConditions(range, aging));

    const searchWhere = itemSearchWhere(search, field);
    const where: Prisma.PurchaseOrderItemWhereInput = {
      AND: [itemWhere, ...(itemDate ?? []), ...itemLevelWhere(filters), { purchaseOrder: { AND: poFilter } }, ...(searchWhere ? [searchWhere] : [])],
    };

    // Total Products names each product's stage (the one rule every list uses)
    const shortIds = metric === "total-products" ? new Set((await getMaterialPlanning()).products.filter((p) => p.hasShortfall).map((p) => p.purchaseOrderItemId)) : null;
    const orderBy: Prisma.PurchaseOrderItemOrderByWithRelationInput[] = [{ purchaseOrder: { createdAt: "desc" } }, { createdAt: "asc" }];
    const stagePicks = metric === "total-products" ? (Object.keys(ITEM_STAGE_LABEL) as ItemStage[]).filter((s) => filters.stage.includes(ITEM_STAGE_LABEL[s])) : [];

    let total: number;
    let items: Prisma.PurchaseOrderItemGetPayload<{ include: typeof itemInclude }>[];
    if (stagePicks.length > 0) {
      // A stage is worked out from the product's records (not one column), so the Stage pick is applied on the whole matching list, then paged.
      const everything = await prisma.purchaseOrderItem.findMany({ where, include: itemInclude, orderBy });
      const keep = everything.filter((i) => stagePicks.includes(stageFor(i, i.purchaseOrder, shortIds!)));
      total = keep.length;
      items = keep.slice(pagination.skip, pagination.skip + pagination.take);
    } else {
      [total, items] = await Promise.all([prisma.purchaseOrderItem.count({ where }), prisma.purchaseOrderItem.findMany({ where, include: itemInclude, orderBy, skip: pagination.skip, take: pagination.take })]);
    }
    const stageOf = (i: (typeof items)[number], po: { status: string }): { stage: ItemStage; stageLabel: string } | null => {
      if (!shortIds) return null;
      const stage = itemStageOf({
        poApproved: po.status === "APPROVED",
        cancelled: !!i.cancelledAt,
        held: !!i.materialHeldAt,
        rmDone: i.rmPlans.some((p) => p.status === "CALCULATED"),
        bomDone: i.bomPlans.some((p) => p.status === "CALCULATED"),
        planSent: !!i.planSentToProductionAt,
        isShort: shortIds.has(i.id),
        quantity: i.quantity,
        batches: (i.preProduction?.productionBatches ?? []).map((b) => ({ currentStageId: b.currentStageId, prepStageId: b.prepStageId, handedOverToDispatchAt: b.handedOverToDispatchAt, customerShippedQty: b.fgShipments.reduce((a, s) => a + s.quantity, 0) })),
      });
      return { stage, stageLabel: ITEM_STAGE_LABEL[stage] };
    };

    // Pending POs also shows each product's raw / packaging material coverage.
    const materials = metric === "pending-pos" ? await getPendingPoMaterials(new Set(items.map((i) => i.id))) : [];
    const materialsByItem = new Map(materials.map((m) => [m.purchaseOrderItemId, m]));

    setPaginationHeaders(res, total, pagination);
    res.json(
      items.map(({ purchaseOrder, preProduction, ...item }) => ({
        po: purchaseOrder,
        // When the product entered this list - its Aging counts from here, not from the order date.
        sinceAt: sinceAtFor(metric, purchaseOrder, item),
        item,
        ...(stageOf({ ...item, preProduction } as never, purchaseOrder) ?? {}),
        // What the browser needs to name the product's current stage (see getItemStage).
        preProduction: preProduction ? { id: preProduction.id, currentStageId: preProduction.currentStageId } : null,
        batchStages: preProduction?.productionBatches.map((b) => b.currentStageId) ?? [],
        materials: materialsByItem.get(item.id) ?? null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Material Planning - rows (paged / searched / filtered) + the header counts
// ---------------------------------------------------------------------------

const MATERIAL_FIELDS = ["all", "po", "customer", "product", "material", "type"] as const;
type MaterialField = (typeof MATERIAL_FIELDS)[number];

function typeMatches(row: MaterialPlanningRow, q: string): boolean {
  const words = row.type === "RM" ? ["rm", "raw", "raw material"] : ["pm", "packaging", "packaging material"];
  return words.some((w) => w.includes(q) || q.includes(w));
}

/** The filtered rows, grouped under their product: products with a shortfall first, short materials first inside each. */
function materialView(planning: MaterialPlanningResult, search: string | undefined, field: MaterialField, onlyShort: boolean, filters: TileFilters) {
  const q = search?.toLowerCase();
  const range = dateRange(filters);
  const aging = agingRanges(filters);
  const plannedAt = new Map(planning.products.map((p) => [p.purchaseOrderItemId, p.plannedAt]));
  const rows = planning.rows.filter((row) => {
    if (onlyShort && row.status !== "SHORT") return false;
    if (!productMatches(row, filters) || !inRange(plannedAt.get(row.purchaseOrderItemId), range) || !inAnyRange(plannedAt.get(row.purchaseOrderItemId), aging)) return false;
    if (filters.mat.length && !filters.mat.includes(`${row.status}:${row.type}`)) return false;
    if (!q) return true;
    const po = (row.poNumber ?? "").toLowerCase().includes(q);
    const customer = row.customerName.toLowerCase().includes(q);
    const product = row.productName.toLowerCase().includes(q) || (row.productCategory ?? "").toLowerCase().includes(q);
    const material = row.material.toLowerCase().includes(q);
    const type = typeMatches(row, q);
    switch (field) {
      case "po":
        return po;
      case "customer":
        return customer;
      case "product":
        return product;
      case "material":
        return material;
      case "type":
        return type;
      default:
        return po || customer || product || material || type;
    }
  });

  const rank = { SHORT: 0, NOT_IN_CATALOG: 1, COVERED: 2 } as const;
  const groups = planning.products
    .map((product, index) => ({ product, index, rows: rows.filter((r) => r.purchaseOrderItemId === product.purchaseOrderItemId).sort((a, b) => rank[a.status] - rank[b.status]) }))
    .filter((g) => g.rows.length > 0)
    .sort((a, b) => Number(b.rows.some((r) => r.status === "SHORT")) - Number(a.rows.some((r) => r.status === "SHORT")) || a.index - b.index);

  return { groups, rows: groups.flatMap((g) => g.rows.map((row) => ({ ...row, product: g.product }))) };
}

function materialParams(req: AuthedRequest) {
  const raw = req.query.searchField;
  const field = typeof raw === "string" && (MATERIAL_FIELDS as readonly string[]).includes(raw) ? (raw as MaterialField) : "all";
  return { search: parseSearch(req), field, onlyShort: req.query.onlyShort === "true", filters: readFilters(req) };
}

/**
 * What Purchase has on order for each short material: the PI lines still to arrive on the
 * Pre-Inventory requirement that came from this product + material (null when none).
 */
async function attachOnOrder<T extends { purchaseOrderItemId: string; type: string; material: string }>(rows: T[]) {
  if (rows.length === 0) return [];
  const requirements = await prisma.preInventoryRequirement.findMany({
    where: { deletedAt: null, sourcePoItemId: { in: [...new Set(rows.map((r) => r.purchaseOrderItemId))] }, purchaseLines: { some: { status: "OPEN" } } },
    select: {
      sourcePoItemId: true,
      item: { select: { name: true, category: true } },
      purchaseLines: { where: { status: "OPEN" }, orderBy: [{ eta: "asc" }, { loggedAt: "asc" }], select: { quantity: true, receivedQty: true, piNumber: true, vendorName: true, eta: true } },
    },
  });
  const byKey = new Map(
    requirements.map((r) => {
      const lines = r.purchaseLines.map((l) => ({ quantity: Math.round((l.quantity - l.receivedQty) * 100) / 100, piNumber: l.piNumber, vendorName: l.vendorName, eta: l.eta }));
      return [`${r.sourcePoItemId}::${r.item.category}::${r.item.name}`, { quantity: Math.round(lines.reduce((sum, l) => sum + l.quantity, 0) * 100) / 100, nextEta: lines[0]!.eta, lines }];
    }),
  );
  return rows.map((r) => ({ ...r, onOrder: byKey.get(`${r.purchaseOrderItemId}::${r.type}::${r.material}`) ?? null }));
}

ppicRouter.get("/material-planning", async (req: AuthedRequest, res, next) => {
  try {
    const pagination = parsePagination(req);
    const { search, field, onlyShort, filters } = materialParams(req);
    const view = materialView(pendingPlanning(await getMaterialPlanning()), search, field, onlyShort, filters);
    setPaginationHeaders(res, view.rows.length, pagination);
    res.json(await attachOnOrder(view.rows.slice(pagination.skip, pagination.skip + pagination.take)));
  } catch (err) {
    next(err);
  }
});

ppicRouter.get("/material-planning/summary", async (req: AuthedRequest, res, next) => {
  try {
    const { search, field, onlyShort, filters } = materialParams(req);
    const view = materialView(pendingPlanning(await getMaterialPlanning()), search, field, onlyShort, filters);
    const live = view.rows.filter((r) => !r.isPreview);
    res.json({
      materials: view.rows.length,
      covered: live.filter((r) => r.status === "COVERED").length,
      short: live.filter((r) => r.status === "SHORT").length,
      notInCatalog: live.filter((r) => r.status === "NOT_IN_CATALOG").length,
      onHold: view.rows.length - live.length,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PO Readiness - products whose raw + packaging material is all covered
// ---------------------------------------------------------------------------

ppicRouter.get("/ready-products", async (req: AuthedRequest, res, next) => {
  try {
    const pagination = parsePagination(req);
    const search = parseSearch(req)?.toLowerCase();
    const filters = readFilters(req);
    const range = dateRange(filters);
    const aging = agingRanges(filters);
    const ready = readyProducts(await getMaterialPlanning()).filter(
      ({ product }) =>
        productMatches(product, filters) &&
        inRange(product.plannedAt, range) &&
        inAnyRange(product.plannedAt, aging) &&
        (!search ||
        (product.poNumber ?? "").toLowerCase().includes(search) ||
        product.customerName.toLowerCase().includes(search) ||
        product.productName.toLowerCase().includes(search) ||
        (product.productCategory ?? "").toLowerCase().includes(search)),
    );
    const page = ready.slice(pagination.skip, pagination.skip + pagination.take);

    const poIds = [...new Set(page.map((r) => r.product.purchaseOrderId))];
    const pos = poIds.length ? await prisma.purchaseOrder.findMany({ where: { id: { in: poIds } }, select: { id: true, orderDate: true, expectedDeliveryDate: true } }) : [];
    const poById = new Map(pos.map((p) => [p.id, p]));

    setPaginationHeaders(res, ready.length, pagination);
    res.json(
      page.map(({ product, materials }) => ({
        product,
        materials,
        sinceAt: product.plannedAt,
        orderDate: poById.get(product.purchaseOrderId)?.orderDate ?? null,
        expectedDeliveryDate: poById.get(product.purchaseOrderId)?.expectedDeliveryDate ?? null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Filter dropdown options - the values a tile's own list actually contains
// ---------------------------------------------------------------------------

const OPTION_FIELDS = ["po", "customer", "category", "product", "plant", "regBody"] as const;
type OptionField = (typeof OPTION_FIELDS)[number];
const OPTION_LIMIT = 100;

const uniqueSorted = (values: (string | null | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

/**
 * GET /filter-options?tile=<metric | material-planning | po-readiness>&field=po|customer|category|product&q=
 * The tile's own distinct values (searched by `q`), first 100 - narrow with `q` for the rest.
 */
ppicRouter.get("/filter-options", async (req: AuthedRequest, res, next) => {
  try {
    const tile = String(req.query.tile ?? "");
    const field = String(req.query.field ?? "") as OptionField;
    if (!(OPTION_FIELDS as readonly string[]).includes(field)) return res.status(400).json({ error: "Unknown filter field" });
    const q = parseSearch(req, "q")?.toLowerCase();
    const visible = poVisibilityWhere(req.user!.roles);
    const finish = (all: string[]) => {
      const matched = q ? all.filter((v) => v.toLowerCase().includes(q)) : all;
      res.json({ values: matched.slice(0, OPTION_LIMIT), hasMore: matched.length > OPTION_LIMIT });
    };

    // Material Planning / PO Readiness are computed in memory already.
    if (tile === "material-planning" || tile === "po-readiness") {
      const planning = await getMaterialPlanning();
      const products = tile === "material-planning" ? pendingPlanning(planning).products : readyProducts(planning).map((r) => r.product);
      const pick = ({ po: (p: MaterialPlanningProduct) => p.poNumber, customer: (p: MaterialPlanningProduct) => p.customerName, category: (p: MaterialPlanningProduct) => p.productCategory, product: (p: MaterialPlanningProduct) => p.productName } as Partial<Record<OptionField, (p: MaterialPlanningProduct) => string | null>>)[field];
      return finish(pick ? uniqueSorted(products.map(pick)) : []);
    }

    if (!(METRICS as readonly string[]).includes(tile)) return res.status(404).json({ error: "Unknown tile" });
    const metric = tile as Metric;
    const has = q ? { contains: q, mode: "insensitive" as const } : undefined;

    // PO-level list: only PO number and customer apply.
    if (metric === "total-pos") {
      if (field === "po") return finish(uniqueSorted((await prisma.purchaseOrder.findMany({ where: { AND: [visible, { poNumber: has ?? { not: null } }] }, distinct: ["poNumber"], select: { poNumber: true }, take: 5000 })).map((p) => p.poNumber)));
      if (field === "customer") return finish(uniqueSorted((await prisma.customer.findMany({ where: { purchaseOrders: { some: visible }, ...(has ? { companyName: has } : {}) }, select: { companyName: true }, take: 5000 })).map((c) => c.companyName)));
      return finish([]);
    }

    const { itemWhere, poFilter } = await tileScope(metric, visible);
    if (field === "plant") return finish(uniqueSorted((await prisma.plant.findMany({ where: { plannedForPoItems: { some: { AND: [itemWhere, { purchaseOrder: { AND: poFilter } }] } } }, select: { name: true } })).map((p) => p.name)));
    if (field === "regBody") return finish(uniqueSorted((await prisma.purchaseOrder.findMany({ where: { AND: [...poFilter, { items: { some: itemWhere } }, { regulatoryBody: { not: null } }] }, distinct: ["regulatoryBody"], select: { regulatoryBody: true } })).map((p) => p.regulatoryBody)));
    const base: Prisma.PurchaseOrderItemWhereInput = { AND: [itemWhere, { purchaseOrder: { AND: poFilter } }] };
    if (field === "product") return finish(uniqueSorted((await prisma.purchaseOrderItem.findMany({ where: { AND: [base, ...(has ? [{ productName: has }] : [])] }, distinct: ["productName"], select: { productName: true }, take: 5000 })).map((i) => i.productName)));
    if (field === "category") return finish(uniqueSorted((await prisma.purchaseOrderItem.findMany({ where: { AND: [base, { productCategory: has ?? { not: null } }] }, distinct: ["productCategory"], select: { productCategory: true }, take: 5000 })).map((i) => i.productCategory)));
    const pos = await prisma.purchaseOrder.findMany({
      where: { AND: [...poFilter, { items: { some: itemWhere } }, ...(field === "po" ? [{ poNumber: has ?? { not: null } }] : [])] },
      distinct: field === "po" ? ["poNumber"] : ["customerId"],
      select: { poNumber: true, customer: { select: { companyName: true } } },
      take: 5000,
    });
    return finish(uniqueSorted(pos.map((p) => (field === "po" ? p.poNumber : p.customer.companyName))));
  } catch (err) {
    next(err);
  }
});
