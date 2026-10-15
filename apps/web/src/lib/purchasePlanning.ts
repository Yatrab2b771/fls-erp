import type { PreInventoryRequirement } from "./types";

// The single source of truth behind Purchase's Pre-Inventory status
// (used on both PreInventoryPage itself and the Purchase dashboard tiles
// / drill-down list), so a status label and a tile's number can never
// drift apart. currentStock/shortQty come live off the real stock ledger
// on every fetch (see pre-inventory.routes.ts) — a requirement is always
// immediately one of these three, never "waiting on someone."
export type RequirementStatus = "COVERED" | "SHORTFALL" | "PARTIAL" | "ORDERED";

// A shortfall can be split across several PI lines: SHORTFALL = nothing on order, PARTIAL =
// some of it on PI lines and some still to log, ORDERED = all of it on PI lines.
export function requirementStatus(r: PreInventoryRequirement): RequirementStatus {
  if (r.shortQty <= 0) return "COVERED";
  if (r.onOrderQty <= 0) return "SHORTFALL";
  return r.remainingToLog > 0 ? "PARTIAL" : "ORDERED";
}

/** Purchase still has something to log on it (nothing logged yet, or only part of it). */
export const needsPi = (r: PreInventoryRequirement): boolean => r.shortQty > 0 && r.remainingToLog > 0;

/** Part or all of the shortfall is on PI lines that have not arrived yet. */
export const hasPiOnOrder = (r: PreInventoryRequirement): boolean => r.shortQty > 0 && r.onOrderQty > 0;

/** The PI lines still to arrive, earliest ETA first. */
export const openPurchaseLines = (r: PreInventoryRequirement) => r.purchaseLines.filter((l) => l.status === "OPEN");

/**
 * When a requirement entered the list it is shown in - what its Aging counts from:
 *  - Shortfall: when it reached Purchase (PPIC's "Send to Purchase", or when it was raised),
 *  - PI Logged: when its earliest still-open PI line was logged (how long it has been on order),
 *  - Fully Covered: when its last PI line arrived, else when it was raised,
 *  - Total: when it was raised.
 */
export function purchaseSinceAt(metric: PurchasePlanningMetric, r: PreInventoryRequirement): string {
  if (metric === "shortfall") return r.purchaseNotifiedAt ?? r.createdAt;
  if (metric === "ordered") return openPurchaseLines(r).map((l) => l.loggedAt).sort()[0] ?? r.createdAt;
  if (metric === "covered") return r.purchaseLines.map((l) => l.closedAt).filter((d): d is string => !!d).sort().at(-1) ?? r.createdAt;
  return r.createdAt;
}

/** The earliest ETA among the lines still to arrive. */
export function nextEta(r: PreInventoryRequirement): string | null {
  const etas = openPurchaseLines(r).map((l) => l.eta).sort();
  return etas[0] ?? null;
}

export const REQUIREMENT_STATUS_LABEL: Record<RequirementStatus, string> = {
  COVERED: "Fully Covered",
  SHORTFALL: "Shortfall — Awaiting PI",
  PARTIAL: "Part logged — more to log",
  ORDERED: "PI Logged",
};

export type PurchasePlanningMetric = "total" | "covered" | "shortfall" | "ordered";

export const PURCHASE_PLANNING_METRIC_LABEL: Record<PurchasePlanningMetric, string> = {
  total: "Total Requirements",
  covered: "Fully Covered",
  shortfall: "Shortfalls — Awaiting PI",
  ordered: "ETA",
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
      // Any of its PI lines arriving inside the range counts.
      const inRange = r.purchaseLines.some((l) => {
        const eta = l.eta.slice(0, 10);
        return (!filters.etaFrom || eta >= filters.etaFrom) && (!filters.etaTo || eta <= filters.etaTo);
      });
      if (!inRange) return false;
    }
    if (q && !r.item.name.toLowerCase().includes(q) && !(r.sourcePo?.poNumber ?? "").toLowerCase().includes(q) && !r.purchaseLines.some((l) => l.piNumber.toLowerCase().includes(q) || l.vendorName.toLowerCase().includes(q))) return false;
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
      return requirements.filter(needsPi); // nothing logged yet, or only part of it
    case "ordered":
      return requirements.filter(hasPiOnOrder); // at least one PI line on its way
  }
}
