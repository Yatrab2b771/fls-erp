import type { CombinedLot, PreProduction, ProductionBatch, PurchaseOrder } from "./types";
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

// One row per still-running PreProduction/CombinedLot/ProductionBatch —
// same "not yet at Dispatch Plan" definition the Dashboard's own
// activeCount already uses elsewhere on this page.
export function getActiveProductionRows(preRuns: PreProduction[], lots: CombinedLot[], batches: ProductionBatch[]): ActiveProductionRow[] {
  const rows: ActiveProductionRow[] = [];
  for (const r of preRuns) {
    if (r.currentStageId === "SAMPLE_QC_APPROVAL" && r.sampleQcStatus === "Approved") continue; // reached its own terminal gate
    rows.push({
      id: `pre-${r.id}`,
      to: `/pre-productions/${r.id}`,
      productName: r.purchaseOrderItem.productName,
      poNumber: r.purchaseOrderItem.purchaseOrder.poNumber,
      customerName: r.purchaseOrderItem.purchaseOrder.customer.companyName,
      stage: r.currentStageId,
    });
  }
  for (const l of lots) {
    if (l.currentStageId === "DISPATCH_PLAN") continue;
    rows.push({
      id: `lot-${l.id}`,
      to: `/combined-lots/${l.id}`,
      productName: l.preProduction.purchaseOrderItem.productName,
      poNumber: l.preProduction.purchaseOrderItem.purchaseOrder.poNumber,
      customerName: l.preProduction.purchaseOrderItem.purchaseOrder.customer.companyName,
      stage: l.currentStageId,
    });
  }
  for (const b of batches) {
    if (b.currentStageId === "DISPATCH_PLAN") continue;
    rows.push({
      id: `batch-${b.id}`,
      to: `/production-batches/${b.id}`,
      productName: b.preProduction.purchaseOrderItem.productName,
      poNumber: b.preProduction.purchaseOrderItem.purchaseOrder.poNumber,
      customerName: b.preProduction.purchaseOrderItem.purchaseOrder.customer.companyName,
      stage: b.currentStageId,
    });
  }
  return rows;
}

export type BdPlanningResult = { kind: "po"; rows: PurchaseOrder[] } | { kind: "item"; rows: PpicPlanningItemRow[] } | { kind: "run"; rows: ActiveProductionRow[] };

export function getBdPlanningRows(
  metric: BdPlanningMetric,
  orders: PurchaseOrder[],
  activeProduction: { preRuns: PreProduction[]; lots: CombinedLot[]; batches: ProductionBatch[] },
): BdPlanningResult {
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
      return { kind: "item", rows: toItemRows(pendingOrders) };
    case "completed-products":
      return { kind: "item", rows: toItemRows(completedOrders) };
    case "active-products":
      return { kind: "run", rows: getActiveProductionRows(activeProduction.preRuns, activeProduction.lots, activeProduction.batches) };
  }
}
