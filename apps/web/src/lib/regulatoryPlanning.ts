import type { PurchaseOrder } from "./types";
import { getPendingPos, toItemRows, type PpicPlanningItemRow } from "./ppicPlanning";

// Regulatory's own queue — same idea as ppicPlanning.ts/bdPlanning.ts,
// single source of truth behind both the Dashboard tiles and the
// drill-down list (RegulatoryPlanningDetailPage). Scoped to pending
// (not Rejected, not yet Completed) orders — same population every
// other department's own planning tiles already use.
export type RegulatoryPlanningMetric = "pending-review" | "approved" | "not-approved";

export const REGULATORY_PLANNING_METRIC_LABEL: Record<RegulatoryPlanningMetric, string> = {
  "pending-review": "Pending Regulatory Review",
  approved: "Approved",
  "not-approved": "Not Approved",
};

export function getRegulatoryPlanningRows(metric: RegulatoryPlanningMetric, orders: PurchaseOrder[]): PpicPlanningItemRow[] {
  const pendingItemRows = toItemRows(getPendingPos(orders));
  switch (metric) {
    case "pending-review":
      return pendingItemRows.filter((r) => !r.item.regulatoryStatus);
    case "approved":
      return pendingItemRows.filter((r) => r.item.regulatoryStatus === "Approved");
    case "not-approved":
      return pendingItemRows.filter((r) => r.item.regulatoryStatus === "Not Approved");
  }
}
