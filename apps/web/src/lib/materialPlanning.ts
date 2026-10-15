import type { MaterialPlanningProduct, MaterialPlanningResult, MaterialPlanningRow } from "./types";

// Filtering / grouping for the Material Planning list — kept out of the page
// so the tile's numbers and the list read the same rules.

export type MaterialSearchField = "all" | "po" | "customer" | "product" | "material" | "type";

export const MATERIAL_SEARCH_FIELD_LABEL: Record<MaterialSearchField, string> = {
  all: "All",
  po: "PO Number",
  customer: "Customer",
  product: "Product",
  material: "Material",
  type: "Type (RM / PM)",
};

export interface MaterialPlanningFilters {
  search?: string;
  searchField?: MaterialSearchField;
  // Only materials that are actually short (a preview row counts too — it's
  // what would be short if that held product were released).
  onlyShort?: boolean;
}

// "rm"/"raw" -> RM, "pm"/"packaging" -> PM, so either the code or the word works.
function typeMatches(row: MaterialPlanningRow, q: string): boolean {
  const words = row.type === "RM" ? ["rm", "raw", "raw material"] : ["pm", "packaging", "packaging material"];
  return words.some((w) => w.includes(q) || q.includes(w));
}

export function filterMaterialRows(rows: MaterialPlanningRow[], filters: MaterialPlanningFilters): MaterialPlanningRow[] {
  const q = filters.search?.trim().toLowerCase();
  const field = filters.searchField ?? "all";
  return rows.filter((row) => {
    if (filters.onlyShort && row.status !== "SHORT") return false;
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
}

export interface MaterialProductGroup {
  product: MaterialPlanningProduct;
  rows: MaterialPlanningRow[];
}

// Rows grouped under their product. Products with a shortfall come first
// (that's what PPIC has to act on), otherwise the API's own queue order is
// kept; inside a product, short materials come first, then covered ones.
export function groupByProduct(products: MaterialPlanningProduct[], rows: MaterialPlanningRow[]): MaterialProductGroup[] {
  const statusRank = { SHORT: 0, NOT_IN_CATALOG: 1, COVERED: 2 } as const;
  const groups: MaterialProductGroup[] = [];
  for (const product of products) {
    const own = rows.filter((r) => r.purchaseOrderItemId === product.purchaseOrderItemId).sort((a, b) => statusRank[a.status] - statusRank[b.status]);
    if (own.length) groups.push({ product, rows: own });
  }
  return groups
    .map((g, index) => ({ g, index }))
    .sort((a, b) => Number(b.g.rows.some((r) => r.status === "SHORT")) - Number(a.g.rows.some((r) => r.status === "SHORT")) || a.index - b.index)
    .map(({ g }) => g);
}

export interface MaterialSummary {
  materials: number;
  covered: number;
  short: number;
  notInCatalog: number;
  // Rows of held / not-approved products — an "if released" preview, kept
  // out of the covered/short counts above.
  onHold: number;
}

export function summarize(rows: MaterialPlanningRow[]): MaterialSummary {
  const live = rows.filter((r) => !r.isPreview);
  return {
    materials: rows.length,
    covered: live.filter((r) => r.status === "COVERED").length,
    short: live.filter((r) => r.status === "SHORT").length,
    notInCatalog: live.filter((r) => r.status === "NOT_IN_CATALOG").length,
    onHold: rows.length - live.length,
  };
}

export const PRODUCT_STATE_LABEL: Record<MaterialPlanningProduct["state"], string> = {
  SENT: "Sent to Production",
  ACTIVE: "Planning",
  HELD: "On Hold",
  NOT_APPROVED: "Regulatory: Not Approved",
};

// PO Readiness tile, product by product: a product is "ready" once ALL its raw
// and packaging material is covered - fully planned (it is in Material Planning),
// claiming stock (not held, not Regulatory-Not-Approved, not already sent to
// Production) and every material COVERED: none short, none missing from the
// catalog. The product doesn't wait for the rest of its PO.
export interface ReadyProduct {
  product: MaterialPlanningProduct;
  materials: number;
}

export function getReadyProducts(planning: MaterialPlanningResult | undefined): ReadyProduct[] {
  if (!planning) return [];
  const rowsByItem = new Map<string, MaterialPlanningRow[]>();
  for (const r of planning.rows) rowsByItem.set(r.purchaseOrderItemId, [...(rowsByItem.get(r.purchaseOrderItemId) ?? []), r]);

  const ready: ReadyProduct[] = [];
  for (const product of planning.products) {
    const rows = rowsByItem.get(product.purchaseOrderItemId) ?? [];
    if (product.state !== "ACTIVE" || rows.length === 0 || rows.some((r) => r.status !== "COVERED")) continue;
    ready.push({ product, materials: rows.length });
  }
  return ready;
}
