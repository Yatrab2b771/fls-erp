import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// Customer tags: New (joined in the last 90 days, worked out by the server) and Top 10 (picked by BD). A customer can be both; neither = Others.
// Every list shows the pill next to the customer name and can filter by customer type. See apps/api/src/modules/customers/customers.routes.ts.

export interface CustomerTag {
  id: string;
  companyName: string;
  isTop10: boolean;
  isNew: boolean;
}

export const CUSTOMER_TYPES = ["New", "Top 10", "Others"] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

// The latest tags by company name, kept outside React so Excel exports (plain functions) can read them too.
const byName = new Map<string, CustomerTag>();

export function useCustomerTags() {
  return useQuery({
    queryKey: ["customers", "tags"],
    queryFn: async () => {
      const rows = await api<CustomerTag[]>("/api/customers/tags");
      byName.clear();
      for (const r of rows) byName.set(r.companyName, r);
      return rows;
    },
    staleTime: 60_000,
  });
}

export const tagOf = (name: string | null | undefined): CustomerTag | undefined => (name ? byName.get(name) : undefined);

/** "New, Top 10", "New", "Top 10" or "Others" - for Excel reports and filters. */
export function customerTypeLabel(name: string | null | undefined): string {
  const t = tagOf(name);
  const parts = [t?.isNew ? "New" : null, t?.isTop10 ? "Top 10" : null].filter(Boolean);
  return parts.length ? parts.join(", ") : "Others";
}

export function matchesCustomerType(tag: CustomerTag | undefined, types: readonly string[]): boolean {
  if (types.length === 0) return true;
  const others = !tag?.isNew && !tag?.isTop10;
  return (types.includes("New") && !!tag?.isNew) || (types.includes("Top 10") && !!tag?.isTop10) || (types.includes("Others") && others);
}

/** The PO form's "Customer type" dropdown: tag one customer as New, Top 10 or Others in one pick (BD). */
export function useSetCustomerType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, type }: { id: string; type: CustomerType }) => api<{ id: string }>(`/api/customers/${id}/type`, { method: "PATCH", body: { type } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function useSetTop10() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isTop10 }: { id: string; isTop10: boolean }) => api(`/api/customers/${id}/top10`, { method: "PATCH", body: { isTop10 } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}
