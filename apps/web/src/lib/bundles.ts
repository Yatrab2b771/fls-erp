/**
 * A bundle is one product's materials: the plan-driven requests that share a customer PO product (and, for the
 * Warehouse, the Day Store asking). A request with no product stands alone as its own one-line bundle.
 */
export interface BundleLine {
  id: string;
  purchaseOrderItemId: string | null;
  productName: string | null;
  poNumber: string | null;
  plantName: string | null;
  neededBy: string | null;
  overdue: boolean;
  open: boolean;
  requestedAt: string;
  // Title for a request that belongs to no product (Production's extra material).
  bundleTitle?: string | null;
}

export interface Bundle<T extends BundleLine> {
  key: string;
  title: string;
  subtitle: string;
  neededBy: string | null;
  overdue: boolean;
  open: boolean;
  lines: T[];
}

export function groupBundles<T extends BundleLine>(rows: T[], groupKey: (r: T) => string = () => ""): Bundle<T>[] {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const key = r.purchaseOrderItemId ? `${groupKey(r)}::${r.purchaseOrderItemId}` : `single::${r.id}`;
    map.set(key, [...(map.get(key) ?? []), r]);
  }
  const bundles: Bundle<T>[] = [...map.entries()].map(([key, lines]) => {
    const first = lines[0]!;
    const dates = lines.map((l) => l.neededBy).filter((d): d is string => !!d).sort();
    return {
      key,
      title: first.bundleTitle ?? first.productName ?? "Material request",
      subtitle: [first.poNumber, first.plantName].filter(Boolean).join(" · "),
      neededBy: dates[0] ?? null,
      overdue: lines.some((l) => l.overdue),
      open: lines.some((l) => l.open),
      lines,
    };
  });
  // Open first; late ones first, then the soonest needed-by.
  return bundles.sort((a, b) => Number(b.open) - Number(a.open) || Number(b.overdue) - Number(a.overdue) || (a.neededBy ?? "9").localeCompare(b.neededBy ?? "9"));
}
