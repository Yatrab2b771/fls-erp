import type { PurchaseOrder } from "./types";
import { getPendingPos, toItemRows, type PpicPlanningItemRow } from "./ppicPlanning";

// Same idea as ppicPlanning.ts, one level up — the single source of
// truth behind every BD dashboard tile AND its drill-down list
// (BdPlanningDetailPage), so a tile's number and its "click to see the
// list" page can never drift apart.
export type BdPlanningMetric =
  | "total-pos"
  | "pending-pos"
  | "completed-pos"
  | "delayed-pos"
  | "total-products"
  | "pending-products"
  | "completed-products"
  | "active-products";

export const BD_PLANNING_METRIC_LABEL: Record<BdPlanningMetric, string> = {
  "total-pos": "Total Purchase Orders",
  "pending-pos": "Pending Purchase Orders",
  "completed-pos": "Completed Purchase Orders",
  "delayed-pos": "Pending POs — Delayed (Past Expected Delivery)",
  "total-products": "Total Products",
  "pending-products": "Pending Products",
  "completed-products": "Completed Products",
  "active-products": "Active Products in Production",
};

// A product is complete on its own as soon as its whole ordered quantity has been dispatched, even if another product of the PO is still pending.
export function isItemDispatched(item: PurchaseOrder["items"][number]): boolean {
  return item.dispatch?.isCompleted === true;
}

export function getCompletedPos(orders: PurchaseOrder[]): PurchaseOrder[] {
  return orders.filter((po) => po.completion.isCompleted);
}

// A Pending PO counts as delayed once its own promised Expected Delivery
// Date has passed — BD's customer-facing commitment, deliberately not
// the internal production/dispatch-plan-date delay the "Needs Attention"
// panel already tracks (that's an internal planning signal; this is
// "did we miss what we told the customer").
export function isPoDelayed(po: PurchaseOrder): boolean {
  return !!po.expectedDeliveryDate && new Date(po.expectedDeliveryDate) < new Date();
}

export interface ActiveProductionRow {
  id: string;
  to: string;
  productName: string;
  poNumber: string | null;
  customerName: string;
  stage: string;
}

const ACTIVE_STAGE_LABEL = { PRE_PRODUCTION: "Pre-production", IN_PRODUCTION: "In production", FINISHED_GOODS: "Finished goods" } as const;

// Active Products in Production: one row per PRODUCT that PPIC has sent to Production and that Production is still working on (preparing,
// making, or the finished goods still at the Day Store). Once it is handed to Dispatch it is no longer in production, and once all of it
// has gone to the customer it is Completed. The stage comes from the server's one rule (item.productionStage).
export function getActiveProductionRows(orders: PurchaseOrder[]): ActiveProductionRow[] {
  return toItemRows(orders.filter((po) => po.status === "APPROVED"))
    .filter(({ item }) => item.productionStage === "PRE_PRODUCTION" || item.productionStage === "IN_PRODUCTION" || item.productionStage === "FINISHED_GOODS")
    .map(({ po, item }) => ({
      id: item.id,
      to: `/purchase-orders/${po.id}`,
      productName: item.productName,
      poNumber: po.poNumber,
      customerName: po.customer.companyName,
      stage: ACTIVE_STAGE_LABEL[item.productionStage as keyof typeof ACTIVE_STAGE_LABEL],
    }));
}

export type BdPlanningResult = { kind: "po"; rows: PurchaseOrder[] } | { kind: "item"; rows: PpicPlanningItemRow[] } | { kind: "run"; rows: ActiveProductionRow[] };

export function getBdPlanningRows(metric: BdPlanningMetric, orders: PurchaseOrder[]): BdPlanningResult {
  const pendingOrders = getPendingPos(orders);
  const completedOrders = getCompletedPos(orders);

  switch (metric) {
    case "total-pos":
      return { kind: "po", rows: orders };
    case "pending-pos":
      return { kind: "po", rows: pendingOrders };
    case "completed-pos":
      return { kind: "po", rows: completedOrders };
    case "delayed-pos":
      return { kind: "po", rows: pendingOrders.filter(isPoDelayed) };
    case "total-products":
      return { kind: "item", rows: toItemRows(orders) };
    case "pending-products":
      return { kind: "item", rows: toItemRows(pendingOrders).filter((r) => !isItemDispatched(r.item)) };
    case "completed-products":
      return { kind: "item", rows: toItemRows(orders.filter((po) => po.status !== "REJECTED")).filter((r) => isItemDispatched(r.item)) };
    case "active-products":
      return { kind: "run", rows: getActiveProductionRows(orders) };
  }
}
