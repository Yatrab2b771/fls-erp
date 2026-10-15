import type { PreProduction, ProductionBatch, PurchaseOrder, PurchaseOrderItem } from "./types";
import { PRE_PRODUCTION_STAGE_LABEL } from "./preProductionStage";
import { COMBINED_LOT_STAGE_LABEL, COMBINED_LOT_STAGE_ORDER } from "./combinedLotStage";

// The single source of truth behind every PPIC planning dashboard tile
// AND its drill-down list (PpicPlanningDetailPage) — both read through
// this file instead of each recomputing the same filter, so a tile's
// number and its "click to see the list" page can never drift apart.
export type PpicPlanningMetric = "total-pos" | "not-planned-pos" | "total-products" | "pending-pos" | "have-bom" | "have-rm-bom" | "missing-both" | "plan-sent" | "plan-not-sent" | "on-hold" | "cancelled";

export const PPIC_PLANNING_METRIC_LABEL: Record<PpicPlanningMetric, string> = {
  "total-pos": "Total Purchase Orders",
  "not-planned-pos": "Not Planned",
  "total-products": "Total Products",
  "pending-pos": "Pending Purchase Orders",
  "have-bom": "Products with Packaging BOM",
  "have-rm-bom": "Products with RM BOM",
  "missing-both": "Products Missing Packaging BOM & RM BOM",
  "plan-sent": "In Production",
  "on-hold": "Hold",
  cancelled: "Cancelled",
  "plan-not-sent": "Not Sent to Production",
};

// Same "pending" definition as the old Pending PO Aging report — not
// REJECTED, not yet completed.
export function getPendingPos(orders: PurchaseOrder[]): PurchaseOrder[] {
  return orders.filter((po) => po.status !== "REJECTED" && !po.completion.isCompleted);
}

// A product is fully planned once BOTH its RM plan and its Packaging (BOM)
// plan are calculated — the same bar Material Planning uses to list it.
export function isFullyPlanned(item: PurchaseOrderItem): boolean {
  return hasCalculatedBom(item) && hasCalculatedRm(item);
}

// PPIC's "Not Planned" inbox, product by product: every product of a
// BD-approved PO that isn't fully planned yet — nothing planned, or only one
// of RM / Packaging BOM done (a Draft plan doesn't count). Once both are
// calculated the product moves on to Material Planning. The row's Status
// shows which of the two is done.
export function getNotPlannedItemRows(orders: PurchaseOrder[]): PpicPlanningItemRow[] {
  return toItemRows(orders.filter((po) => po.status === "APPROVED")).filter(({ item }) => !isFullyPlanned(item) && !item.materialHeldAt && !item.planSentToProductionAt); // a product on Hold is listed only under On Hold
}

// The dashboard tile counts POs: an approved PO with at least one product
// that isn't fully planned yet.
export function getNotPlannedPos(orders: PurchaseOrder[]): PurchaseOrder[] {
  return orders.filter((po) => po.status === "APPROVED" && po.items.some((item) => !item.cancelledAt && !item.materialHeldAt && !item.planSentToProductionAt && !isFullyPlanned(item)));
}

// Same aging formula the old Pending PO Aging report used — from
// orderDate, falling back to createdAt when BD never filled one in.
export function getPoAgingDays(po: PurchaseOrder): number {
  const dayMs = 1000 * 60 * 60 * 24;
  const startDate = po.orderDate ?? po.createdAt;
  return Math.max(0, Math.round((Date.now() - new Date(startDate).getTime()) / dayMs));
}

// Where one product currently sits in the pipeline — used by the
// Pending POs report to show each product's bottleneck at a glance.
// Mirrors apps/api's PreProductionStageId/CombinedLotStageId order:
// planning (BOM/RM plan, plan-sent gate) comes before any PreProduction
// run exists; once one does, its own Tier-1 stage applies until
// Production opens one or more ProductionBatch runs against it, at
// which point the LEAST advanced still-open batch's Tier-3 stage
// becomes the product's stage — a bottleneck, not an average, so a
// product with 3 batches where 1 is stuck at IPQC and 2 are at
// Packaging correctly reads as "stuck at IPQC."
export function getItemStage(item: PurchaseOrderItem, preRuns: PreProduction[], batches: ProductionBatch[]): string {
  const pp = preRuns.find((r) => r.purchaseOrderItemId === item.id);
  if (!pp) {
    if (!hasCalculatedBom(item) && !hasCalculatedRm(item)) return "BOM/RM Planning";
    if (!item.planSentToProductionAt) return "Plan Not Sent to Production";
    return "Awaiting Production Start";
  }

  const itemBatches = batches.filter((b) => b.preProductionId === pp.id);
  if (itemBatches.length === 0) return PRE_PRODUCTION_STAGE_LABEL[pp.currentStageId];

  const openBatches = itemBatches.filter((b) => b.currentStageId !== "DISPATCH_PLAN");
  if (openBatches.length === 0) return "Dispatched";

  const stageRank = (id: (typeof openBatches)[number]["currentStageId"]) => COMBINED_LOT_STAGE_ORDER.indexOf(id);
  const leastAdvanced = openBatches.reduce((a, b) => (stageRank(a.currentStageId) <= stageRank(b.currentStageId) ? a : b));
  return COMBINED_LOT_STAGE_LABEL[leastAdvanced.currentStageId];
}

export function hasCalculatedBom(item: PurchaseOrderItem): boolean {
  return item.bomPlans?.some((p) => p.status === "CALCULATED") ?? false;
}

export function hasCalculatedRm(item: PurchaseOrderItem): boolean {
  return item.rmPlans?.some((p) => p.status === "CALCULATED") ?? false;
}

export interface PpicPlanningItemRow {
  po: PurchaseOrder;
  item: PurchaseOrderItem;
  // When the product entered the list it is shown in (server-side) - its Aging.
  sinceAt?: string | null;
}

export type PpicPlanningResult = { kind: "po"; rows: PurchaseOrder[] } | { kind: "item"; rows: PpicPlanningItemRow[] };

// Shared with bdPlanning.ts — both modules read the same PurchaseOrder[]
// data and flatten it to (po, item) pairs the same way.
export function toItemRows(orders: PurchaseOrder[]): PpicPlanningItemRow[] {
  // Cancelled products are dead - they never appear in any planning list.
  return orders.flatMap((po) => po.items.filter((item) => !item.cancelledAt).map((item) => ({ po, item })));
}

// Which field the search box looks in — "all" is the original behaviour
// (PO Number, Customer, and Product where the tile lists products).
export type PpicSearchField = "all" | "po" | "customer" | "product" | "category";

export const PPIC_SEARCH_FIELD_LABEL: Record<PpicSearchField, string> = {
  all: "All",
  po: "PO Number",
  customer: "Customer",
  product: "Product",
  category: "Category",
};

// Tiles that show the "Search by" dropdown next to the search box. Rolled
// out tile by tile — to give another tile the same dropdown, just add its
// metric here; the filter below and the page already handle it.
export const PPIC_SEARCH_FIELD_METRICS: ReadonlySet<PpicPlanningMetric> = new Set<PpicPlanningMetric>(["not-planned-pos", "plan-sent", "on-hold", "cancelled"]);

export interface PpicPlanningFilters {
  search?: string;
  // Defaults to "all". Choosing "customer" also groups the list by
  // customer name (all of one customer's POs together, A→Z).
  searchField?: PpicSearchField;
  // Both inclusive, matched against the PO's own orderDate (falling back
  // to createdAt, same as getPoAgingDays) — a calendar-date pick, not a
  // timestamp, so a PO placed at any time on dateTo still matches it.
  dateFrom?: string;
  dateTo?: string;
}

function dateMatches(po: PurchaseOrder, filters: PpicPlanningFilters): boolean {
  if (!filters.dateFrom && !filters.dateTo) return true;
  const orderDate = (po.orderDate ?? po.createdAt).slice(0, 10);
  if (filters.dateFrom && orderDate < filters.dateFrom) return false;
  if (filters.dateTo && orderDate > filters.dateTo) return false;
  return true;
}

// One search box + calendar date range, shared by every tile's
// drill-down table AND its Excel export (see PpicPlanningDetailPage.tsx
// / ppicPlanningReports.ts) — search matches PO Number or Customer
// always, plus Product name for the product-level ("item") tiles; the
// date range matches the PO's own Order Date and applies on top of
// (AND, not instead of) the search. No filters set returns the result
// untouched (same reference, no unnecessary re-render).
export function filterPpicPlanningResult(result: PpicPlanningResult, filters: PpicPlanningFilters): PpicPlanningResult {
  const q = filters.search?.trim().toLowerCase();
  const field = filters.searchField ?? "all";
  const groupByCustomer = field === "customer";
  if (!q && !filters.dateFrom && !filters.dateTo && !groupByCustomer) return result;

  const poMatches = (po: PurchaseOrder) => (po.poNumber ?? "").toLowerCase().includes(q!);
  const customerMatches = (po: PurchaseOrder) => po.customer.companyName.toLowerCase().includes(q!);
  const byCustomer = (a: PurchaseOrder, b: PurchaseOrder) => a.customer.companyName.localeCompare(b.customer.companyName);

  if (result.kind === "po") {
    // A PO-level tile has no single product per row — a product search
    // (the "Product" field, and "All") matches if any of the PO's products
    // does. (Before this, PO-level tiles ignored the product part of the
    // search entirely, even though the placeholder promised it.)
    const productMatches = (po: PurchaseOrder) => po.items.some((item) => item.productName.toLowerCase().includes(q!));
    const categoryMatches = (po: PurchaseOrder) => po.items.some((item) => (item.productCategory ?? "").toLowerCase().includes(q!));
    const searchMatches = (po: PurchaseOrder) => {
      if (!q) return true;
      if (field === "po") return poMatches(po);
      if (field === "customer") return customerMatches(po);
      if (field === "product") return productMatches(po);
      if (field === "category") return categoryMatches(po);
      return poMatches(po) || customerMatches(po) || productMatches(po) || categoryMatches(po);
    };
    const rows = result.rows.filter((po) => dateMatches(po, filters) && searchMatches(po));
    return { kind: "po", rows: groupByCustomer ? [...rows].sort(byCustomer) : rows };
  }

  const searchMatches = ({ po, item }: PpicPlanningItemRow) => {
    if (!q) return true;
    const productMatches = item.productName.toLowerCase().includes(q);
    const categoryMatches = (item.productCategory ?? "").toLowerCase().includes(q);
    if (field === "po") return poMatches(po);
    if (field === "customer") return customerMatches(po);
    if (field === "product") return productMatches;
    if (field === "category") return categoryMatches;
    return poMatches(po) || customerMatches(po) || productMatches || categoryMatches;
  };
  const rows = result.rows.filter((row) => dateMatches(row.po, filters) && searchMatches(row));
  return { kind: "item", rows: groupByCustomer ? [...rows].sort((a, b) => byCustomer(a.po, b.po)) : rows };
}

export function getPpicPlanningRows(metric: PpicPlanningMetric, orders: PurchaseOrder[]): PpicPlanningResult {
  const pendingOrders = getPendingPos(orders);
  const pendingItemRows = toItemRows(pendingOrders).filter((r) => !r.item.materialHeldAt); // held products are listed only under On Hold
  // Plan Sent / Not Sent look at EVERY product, not just pending ones —
  // a completed, already-dispatched PO's item necessarily had its plan
  // sent to Production at some point (that's how it got made), so
  // scoping this to "pending only" would silently drop it from both
  // buckets. This is the one pair of tiles that has to foot back to
  // Total Products exactly; the BOM/RM-BOM readiness tiles stay
  // pending-only since that's a still-open-orders paperwork check.
  const allItemRows = toItemRows(orders);

  switch (metric) {
    case "total-pos":
      return { kind: "po", rows: orders };
    // One row per product (a PO with 2 products is 2 rows) so a product
    // search lands on the exact row. The dashboard tile still counts POs.
    case "not-planned-pos":
      return { kind: "item", rows: getNotPlannedItemRows(orders) };
    // Product-level — see PpicPlanningDetailPage's dedicated table for
    // this metric: each pending PO's own products, one row per product,
    // with stage + RM/PM material coverage (the "Pending PO Report").
    case "pending-pos":
      return { kind: "item", rows: pendingItemRows };
    case "total-products":
      return { kind: "item", rows: allItemRows };
    case "have-bom":
      return { kind: "item", rows: pendingItemRows.filter((r) => hasCalculatedBom(r.item)) };
    case "have-rm-bom":
      return { kind: "item", rows: pendingItemRows.filter((r) => hasCalculatedRm(r.item)) };
    case "missing-both":
      return { kind: "item", rows: pendingItemRows.filter((r) => !hasCalculatedBom(r.item) && !hasCalculatedRm(r.item)) };
    // Products PPIC has on Hold (not yet sent to Production) - wherever they
    // are: still Not Planned, or fully planned in Material Planning.
    case "on-hold":
      return { kind: "item", rows: allItemRows.filter((r) => r.po.status === "APPROVED" && !!r.item.materialHeldAt && !r.item.planSentToProductionAt) };
    // Products PPIC cancelled for good (the only list that still shows them).
    case "cancelled":
      return { kind: "item", rows: orders.filter((po) => po.status === "APPROVED").flatMap((po) => po.items.filter((item) => !!item.cancelledAt).map((item) => ({ po, item }))) };
    case "plan-sent":
      return { kind: "item", rows: allItemRows.filter((r) => !!r.item.planSentToProductionAt) };
    case "plan-not-sent":
      return { kind: "item", rows: allItemRows.filter((r) => !r.item.planSentToProductionAt) };
  }
}
