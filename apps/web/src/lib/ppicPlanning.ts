import type { PurchaseOrder, PurchaseOrderItem } from "./types";

// The single source of truth behind every PPIC planning dashboard tile
// AND its drill-down list (PpicPlanningDetailPage) — both read through
// this file instead of each recomputing the same filter, so a tile's
// number and its "click to see the list" page can never drift apart.
export type PpicPlanningMetric = "total-pos" | "total-products" | "pending-pos" | "have-bom" | "have-rm-bom" | "missing-both" | "plan-sent" | "plan-not-sent";

export const PPIC_PLANNING_METRIC_LABEL: Record<PpicPlanningMetric, string> = {
  "total-pos": "Total Purchase Orders",
  "total-products": "Total Products",
  "pending-pos": "Pending Purchase Orders",
  "have-bom": "Products with Packaging BOM",
  "have-rm-bom": "Products with RM BOM",
  "missing-both": "Products Missing Packaging BOM & RM BOM",
  "plan-sent": "Plan Sent to Production",
  "plan-not-sent": "Not Sent to Production",
};

// Same "pending" definition as the old Pending PO Aging report — not
// REJECTED, not yet completed.
export function getPendingPos(orders: PurchaseOrder[]): PurchaseOrder[] {
  return orders.filter((po) => po.status !== "REJECTED" && !po.completion.isCompleted);
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
}

export type PpicPlanningResult = { kind: "po"; rows: PurchaseOrder[] } | { kind: "item"; rows: PpicPlanningItemRow[] };

// Shared with bdPlanning.ts — both modules read the same PurchaseOrder[]
// data and flatten it to (po, item) pairs the same way.
export function toItemRows(orders: PurchaseOrder[]): PpicPlanningItemRow[] {
  return orders.flatMap((po) => po.items.map((item) => ({ po, item })));
}

export function getPpicPlanningRows(metric: PpicPlanningMetric, orders: PurchaseOrder[]): PpicPlanningResult {
  const pendingOrders = getPendingPos(orders);
  const pendingItemRows = toItemRows(pendingOrders);
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
    case "pending-pos":
      return { kind: "po", rows: pendingOrders };
    case "total-products":
      return { kind: "item", rows: allItemRows };
    case "have-bom":
      return { kind: "item", rows: pendingItemRows.filter((r) => hasCalculatedBom(r.item)) };
    case "have-rm-bom":
      return { kind: "item", rows: pendingItemRows.filter((r) => hasCalculatedRm(r.item)) };
    case "missing-both":
      return { kind: "item", rows: pendingItemRows.filter((r) => !hasCalculatedBom(r.item) && !hasCalculatedRm(r.item)) };
    case "plan-sent":
      return { kind: "item", rows: allItemRows.filter((r) => !!r.item.planSentToProductionAt) };
    case "plan-not-sent":
      return { kind: "item", rows: allItemRows.filter((r) => !r.item.planSentToProductionAt) };
  }
}
