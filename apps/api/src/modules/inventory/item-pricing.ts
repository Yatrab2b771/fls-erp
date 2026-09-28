import type { RoleName } from "@prisma/client";

// Who gets to see costPrice/mrp/purchasePrice/salesPrice on an
// InventoryItem — Purchase/Accounts own this data and can edit it (see
// PATCH /items/:id/pricing's own role gate); Store can see it too (read
// only — Store's own write access stays gated to PURCHASE/ACCOUNTS,
// unrelated to this list) since they're the ones physically handling
// stock and want the value visible on the ledger. ADMIN as always
// bypasses via the caller's own role check. Every other role reading the
// catalog (PPIC, RND, ...) gets the item with these fields stripped
// rather than nulled, so "never priced" and "not allowed to see the
// price" don't look the same on the wire.
const PRICING_VISIBLE_ROLES: RoleName[] = ["PURCHASE", "ACCOUNTS", "STORE", "ADMIN"];

export function canViewPricing(roles: RoleName[]): boolean {
  return roles.some((r) => PRICING_VISIBLE_ROLES.includes(r));
}

const PRICING_FIELDS = ["costPrice", "mrp", "purchasePrice", "salesPrice"] as const;

export function stripPricing<T extends Record<string, unknown>>(item: T, roles: RoleName[]): T {
  if (canViewPricing(roles)) return item;
  const clone = { ...item };
  for (const field of PRICING_FIELDS) delete clone[field];
  return clone;
}

export function stripPricingFromAll<T extends Record<string, unknown>>(items: T[], roles: RoleName[]): T[] {
  if (canViewPricing(roles)) return items;
  return items.map((item) => stripPricing(item, roles));
}
