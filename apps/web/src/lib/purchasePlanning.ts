import type { PreInventoryRequirement } from "./types";

// The single source of truth behind Purchase's Pre-Inventory status
// (used on both PreInventoryPage itself and the Purchase dashboard tiles
// / drill-down list), so a status label and a tile's number can never
// drift apart. currentStock/shortQty come live off the real stock ledger
// on every fetch (see pre-inventory.routes.ts) — a requirement is always
// immediately one of these three, never "waiting on someone."
export type RequirementStatus = "COVERED" | "SHORTFALL" | "ORDERED";

export function requirementStatus(r: PreInventoryRequirement): RequirementStatus {
  if (r.shortQty <= 0) return "COVERED";
  return r.poNumber ? "ORDERED" : "SHORTFALL";
}

export const REQUIREMENT_STATUS_LABEL: Record<RequirementStatus, string> = {
  COVERED: "Fully Covered",
  SHORTFALL: "Shortfall — Awaiting PO",
  ORDERED: "PO Logged",
};

export type PurchasePlanningMetric = "total" | "covered" | "shortfall" | "ordered";

export const PURCHASE_PLANNING_METRIC_LABEL: Record<PurchasePlanningMetric, string> = {
  total: "Total Requirements",
  covered: "Fully Covered",
  shortfall: "Shortfalls — Awaiting PO",
  ordered: "PO Logged",
};

export function getPurchasePlanningRows(metric: PurchasePlanningMetric, requirements: PreInventoryRequirement[]): PreInventoryRequirement[] {
  switch (metric) {
    case "total":
      return requirements;
    case "covered":
      return requirements.filter((r) => requirementStatus(r) === "COVERED");
    case "shortfall":
      return requirements.filter((r) => requirementStatus(r) === "SHORTFALL");
    case "ordered":
      return requirements.filter((r) => requirementStatus(r) === "ORDERED");
  }
}
