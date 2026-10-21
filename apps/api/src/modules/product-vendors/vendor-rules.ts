import { prisma } from "../../common/lib/prisma";
import { RouteError } from "../../common/lib/route-error";
import { getDayStoreLots, getPlantLots, getWarehouseLots, vendorKey, type LotBalance } from "../inventory/lots";

/**
 * Approved vendors (see ProductMaterialVendor in schema.prisma): for a PO product, which vendors its restricted materials may come from.
 * A material with no rule - or one R&D has allowed another vendor for (a VendorDeviation) - is unrestricted.
 */
export interface VendorRule {
  vendorIds: string[];
  vendorNames: string[];
  /** vendorKey of every approved vendor, for matching a delivery's vendor name. */
  keys: Set<string>;
  deviation: { reason: string; at: Date } | null;
}

/** PO item id -> material (InventoryItem id) -> its rule. Only materials that have a rule are present. */
export type RuleMap = Map<string, Map<string, VendorRule>>;

/** The keys a movement of this material must come from, or undefined when anything goes (no rule, or R&D allowed a deviation). */
export const allowedKeysOf = (rule: VendorRule | undefined): Set<string> | undefined => (rule && !rule.deviation ? rule.keys : undefined);

export async function rulesForPoItems(poItemIds: string[], db: Pick<typeof prisma, "rmPlan" | "bomPlan" | "productMaterialVendor" | "vendorDeviation"> = prisma): Promise<RuleMap> {
  const out: RuleMap = new Map();
  if (poItemIds.length === 0) return out;

  // A product's rules belong to its recipe (RM) and its packaging SKU (PM): found through the PO line's latest calculated plans.
  const [rmPlans, bomPlans] = await Promise.all([
    db.rmPlan.findMany({ where: { purchaseOrderItemId: { in: poItemIds }, status: "CALCULATED" }, orderBy: { calculatedAt: "desc" }, select: { purchaseOrderItemId: true, items: { where: { deletedAt: null }, select: { recipeId: true } } } }),
    db.bomPlan.findMany({ where: { purchaseOrderItemId: { in: poItemIds }, status: "CALCULATED" }, orderBy: { calculatedAt: "desc" }, select: { purchaseOrderItemId: true, items: { where: { deletedAt: null }, select: { skuId: true } } } }),
  ]);
  const recipesOf = new Map<string, Set<string>>();
  const skusOf = new Map<string, Set<string>>();
  for (const p of rmPlans) if (p.purchaseOrderItemId && !recipesOf.has(p.purchaseOrderItemId)) recipesOf.set(p.purchaseOrderItemId, new Set(p.items.map((i) => i.recipeId)));
  for (const p of bomPlans) if (p.purchaseOrderItemId && !skusOf.has(p.purchaseOrderItemId)) skusOf.set(p.purchaseOrderItemId, new Set(p.items.map((i) => i.skuId)));

  const recipeIds = [...new Set([...recipesOf.values()].flatMap((s) => [...s]))];
  const skuIds = [...new Set([...skusOf.values()].flatMap((s) => [...s]))];
  if (recipeIds.length === 0 && skuIds.length === 0) return out;

  const [rules, deviations] = await Promise.all([
    db.productMaterialVendor.findMany({
      where: { OR: [...(recipeIds.length ? [{ kind: "RM", scopeId: { in: recipeIds } }] : []), ...(skuIds.length ? [{ kind: "PM", scopeId: { in: skuIds } }] : [])] },
      select: { kind: true, scopeId: true, itemId: true, vendor: { select: { id: true, name: true } } },
    }),
    db.vendorDeviation.findMany({ where: { purchaseOrderItemId: { in: poItemIds } }, select: { purchaseOrderItemId: true, itemId: true, reason: true, createdAt: true } }),
  ]);
  const deviationOf = new Map(deviations.map((d) => [`${d.purchaseOrderItemId}::${d.itemId}`, d]));

  for (const poItemId of poItemIds) {
    const recipes = recipesOf.get(poItemId);
    const skus = skusOf.get(poItemId);
    for (const r of rules) {
      if (!(r.kind === "RM" ? recipes?.has(r.scopeId) : skus?.has(r.scopeId))) continue;
      const items = out.get(poItemId) ?? new Map<string, VendorRule>();
      const cur = items.get(r.itemId) ?? { vendorIds: [], vendorNames: [], keys: new Set<string>(), deviation: null };
      if (!cur.vendorIds.includes(r.vendor.id)) {
        cur.vendorIds.push(r.vendor.id);
        cur.vendorNames.push(r.vendor.name);
        cur.keys.add(vendorKey(r.vendor.name));
      }
      const d = deviationOf.get(`${poItemId}::${r.itemId}`);
      cur.deviation = d ? { reason: d.reason, at: d.createdAt } : null;
      items.set(r.itemId, cur);
      out.set(poItemId, items);
    }
  }
  return out;
}

const usable = (lots: LotBalance[]) => lots.filter((l) => !l.expired && l.remaining > 1e-9);

/**
 * How much of each material is held, per vendor, across the whole company: the Warehouse, every Day Store and every Plant (only stock
 * whose lot is known can be attributed to a vendor; anything else - the R&D Store, material in transit, stock booked before lots existed -
 * is "unverified" and is not counted for a product that is restricted to approved vendors).
 */
export async function vendorStockByItem(itemIds: string[]): Promise<Map<string, Map<string, { name: string; qty: number }>>> {
  const out = new Map<string, Map<string, { name: string; qty: number }>>();
  if (itemIds.length === 0) return out;
  const [dayStores, plants] = await Promise.all([prisma.dayStore.findMany({ select: { id: true } }), prisma.plant.findMany({ select: { id: true } })]);
  for (const itemId of itemIds) {
    const byVendor = new Map<string, { name: string; qty: number }>();
    const add = (lots: LotBalance[]) => {
      for (const l of usable(lots)) {
        const k = vendorKey(l.vendorName);
        const cur = byVendor.get(k) ?? { name: l.vendorName ?? "", qty: 0 };
        cur.qty += l.remaining;
        byVendor.set(k, cur);
      }
    };
    add(await getWarehouseLots(prisma, itemId));
    for (const d of dayStores) add(await getDayStoreLots(prisma, d.id, itemId));
    for (const p of plants) add(await getPlantLots(prisma, p.id, itemId));
    out.set(itemId, byVendor);
  }
  return out;
}

/** How much of a material, from approved vendors only, sits at one Plant and its Day Store (what a batch's Dispensing can draw on). */
export async function approvedStockForDispensing(db: Parameters<typeof getPlantLots>[0], itemId: string, keys: Set<string>, plantId: string, dayStoreId: string | null): Promise<number> {
  const plantLots = usable(await getPlantLots(db, plantId, itemId));
  const storeLots = dayStoreId ? usable(await getDayStoreLots(db, dayStoreId, itemId)) : [];
  return [...plantLots, ...storeLots].filter((l) => keys.has(vendorKey(l.vendorName))).reduce((s, l) => s + l.remaining, 0);
}

/** How much of a material, from approved vendors only, sits at one Plant. */
export async function approvedPlantStock(db: Parameters<typeof getPlantLots>[0], itemId: string, keys: Set<string>, plantId: string): Promise<number> {
  return usable(await getPlantLots(db, plantId, itemId)).filter((l) => keys.has(vendorKey(l.vendorName))).reduce((s, l) => s + l.remaining, 0);
}

/** How much of a material, from approved vendors only, is usable in one Day Store. */
export async function approvedStoreStock(db: Parameters<typeof getDayStoreLots>[0], itemId: string, keys: Set<string>, dayStoreId: string): Promise<number> {
  return usable(await getDayStoreLots(db, dayStoreId, itemId)).filter((l) => keys.has(vendorKey(l.vendorName))).reduce((s, l) => s + l.remaining, 0);
}

/** How much of a material, from approved vendors only, is usable in the Warehouse. */
export async function approvedWarehouseStock(db: Parameters<typeof getWarehouseLots>[0], itemId: string, keys: Set<string>): Promise<number> {
  return usable(await getWarehouseLots(db, itemId)).filter((l) => keys.has(vendorKey(l.vendorName))).reduce((s, l) => s + l.remaining, 0);
}

/**
 * Purchase logging a PI for a shortfall that belongs to a product (the requirement came from Material Planning, or was linked to a PO
 * line): the vendor has to be one of that product's approved vendors for the material, unless R&D has allowed another. Throws a 409.
 */
export async function assertVendorAllowed(requirement: { itemId: string; sourcePoItemId: string | null; linkedPoItemId: string | null; item: { name: string } }, vendorName: string): Promise<void> {
  const poItemId = requirement.sourcePoItemId ?? requirement.linkedPoItemId;
  if (!poItemId) return;
  const rule = (await rulesForPoItems([poItemId])).get(poItemId)?.get(requirement.itemId);
  const keys = allowedKeysOf(rule);
  if (!rule || !keys || keys.has(vendorKey(vendorName))) return;
  throw new RouteError(
    409,
    `${requirement.item.name} for this product may only come from its approved vendor${rule.vendorNames.length === 1 ? "" : "s"}: ${rule.vendorNames.join(", ")}. "${vendorName}" is not one of them - pick an approved vendor, or ask R&D to allow another one for this product.`,
  );
}
