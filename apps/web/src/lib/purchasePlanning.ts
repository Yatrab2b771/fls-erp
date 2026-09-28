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

export interface PurchasePlanningFilters {
  search?: string;
  category?: "RM" | "PM";
  // Both inclusive, matched against the requirement's own ETA (blank ETA
  // never matches a date range — there's nothing to compare).
  etaFrom?: string;
  etaTo?: string;
}

// One search box + category + ETA date range, shared by the drill-down
// table AND its Excel export (see PurchasePlanningDetailPage.tsx /
// inventoryExport.ts) — search matches Item name, PO Number or Vendor.
// No filters set returns the rows untouched (same reference).
export function filterPurchasePlanningRows(rows: PreInventoryRequirement[], filters: PurchasePlanningFilters): PreInventoryRequirement[] {
  const q = filters.search?.trim().toLowerCase();
  if (!q && !filters.category && !filters.etaFrom && !filters.etaTo) return rows;

  return rows.filter((r) => {
    if (filters.category && r.category !== filters.category) return false;
    if (filters.etaFrom || filters.etaTo) {
      if (!r.eta) return false;
      const eta = r.eta.slice(0, 10);
      if (filters.etaFrom && eta < filters.etaFrom) return false;
      if (filters.etaTo && eta > filters.etaTo) return false;
    }
    if (q && !r.item.name.toLowerCase().includes(q) && !(r.poNumber ?? "").toLowerCase().includes(q) && !(r.vendorName ?? "").toLowerCase().includes(q)) return false;
    return true;
  });
}

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
