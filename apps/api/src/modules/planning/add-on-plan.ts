import { prisma } from "../../common/lib/prisma";
import { getTotalAvailableByItemId } from "../inventory/stock";
import type { RmMasterResult } from "../rm-costing/rm-costing-engine";
import type { BomResult } from "../packaging-bom/bom-engine";

/**
 * "Add on Plan" — PPIC's PO-independent material check. BD sometimes
 * gets an urgent order for a product that's an EXISTING catalog match
 * (Sku/Recipe already known, its BOM/RM Plan already calculated at some
 * point, whether or not that calculation was ever tied to a real PO) —
 * before BD even raises the PO, PPIC wants a fast "is the RM/PM already
 * in Store" answer for that product, without generating anything new.
 *
 * Reads the LATEST CALCULATED plan that already includes this Sku/Recipe
 * and pulls out just this product's own share via the plan's `sources`
 * map (see bom-engine.ts/rm-costing-engine.ts — a pooled plan can cover
 * several products at once; sources[key] is exactly "how much of this
 * line's total this one product itself contributed"). Nothing is
 * recalculated — this is a read of what PPIC/R&D already planned.
 */

export interface AddOnPlanMaterialLine {
  name: string;
  requiredQty: number;
  unit: string;
  // null when the plan's material name doesn't match any real catalog
  // item (InventoryItem, matched by category+name) — same limitation
  // pending-materials.ts has for legacy fixed-spec-field BOM lines.
  onHand: number | null;
  short: boolean;
  shortfallQty: number;
}

export interface AddOnPlanCandidate {
  type: "SKU" | "RECIPE";
  id: string;
  name: string;
  customerName: string | null;
}

export async function searchAddOnPlanCandidates(query: string): Promise<AddOnPlanCandidate[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const [skus, recipes] = await Promise.all([
    prisma.sku.findMany({
      where: { productName: { contains: q, mode: "insensitive" } },
      include: { customer: { select: { companyName: true } } },
      orderBy: { productName: "asc" },
      take: 20,
    }),
    prisma.recipe.findMany({ where: { name: { contains: q, mode: "insensitive" } }, orderBy: { name: "asc" }, take: 20 }),
  ]);

  return [
    ...skus.map((s) => ({ type: "SKU" as const, id: s.id, name: s.productName, customerName: s.customer.companyName })),
    ...recipes.map((r) => ({ type: "RECIPE" as const, id: r.id, name: r.name, customerName: null })),
  ];
}

type Need = { category: "RM" | "PM"; name: string; qty: number };

async function resolveLines(needs: Need[]): Promise<AddOnPlanMaterialLine[]> {
  if (needs.length === 0) return [];

  // Same qty merge every other bulk material report in this app does —
  // two lines for the same material (rare, but possible) fold into one.
  const merged = new Map<string, Need>();
  for (const n of needs) {
    const key = `${n.category}::${n.name}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, qty: existing.qty + n.qty } : n);
  }
  const list = [...merged.values()];

  const catalogItems = await prisma.inventoryItem.findMany({
    where: {
      OR: [
        { category: "RM", name: { in: list.filter((n) => n.category === "RM").map((n) => n.name) } },
        { category: "PM", name: { in: list.filter((n) => n.category === "PM").map((n) => n.name) } },
      ],
    },
    select: { id: true, category: true, name: true, unit: true },
  });
  const catalogByKey = new Map(catalogItems.map((c) => [`${c.category}::${c.name}`, c]));
  const stockById = await getTotalAvailableByItemId(catalogItems.map((c) => c.id));

  return list.map((n) => {
    const catalogItem = catalogByKey.get(`${n.category}::${n.name}`);
    const onHand = catalogItem ? stockById.get(catalogItem.id) ?? 0 : null;
    const short = onHand !== null && onHand < n.qty;
    return {
      name: n.name,
      requiredQty: Math.round(n.qty * 100) / 100,
      unit: catalogItem?.unit ?? (n.category === "RM" ? "Kg" : "Nos"),
      onHand: onHand !== null ? Math.round(onHand * 100) / 100 : null,
      short,
      shortfallQty: short ? Math.round((n.qty - onHand!) * 100) / 100 : 0,
    };
  });
}

export interface AddOnPlanDetail {
  productName: string;
  customerName: string | null;
  category: "PM" | "RM";
  planName: string;
  planCalculatedAt: string;
  materials: AddOnPlanMaterialLine[];
}

export async function getSkuMaterialAvailability(skuId: string): Promise<AddOnPlanDetail | null> {
  const sku = await prisma.sku.findUnique({ where: { id: skuId }, include: { customer: { select: { companyName: true } } } });
  if (!sku) return null;

  const item = await prisma.bomPlanItem.findFirst({
    where: { skuId, deletedAt: null, plan: { status: "CALCULATED" } },
    include: { plan: true },
    orderBy: { plan: { calculatedAt: "desc" } },
  });
  if (!item?.plan.resultSnapshot) return null;

  // Same "Brand (Product)" key bom-engine.ts's calculateMasterBOM builds
  // its sources map with — see bom-plan.routes.ts's own construction of
  // brandName from sku.customer.companyName.
  const sourceKey = `${sku.customer.companyName} (${sku.productName})`;
  const snapshot = item.plan.resultSnapshot as unknown as BomResult;
  const needs: Need[] = snapshot.lines
    .map((l) => ({ category: "PM" as const, name: l.component.trim(), qty: l.sources[sourceKey] ?? 0 }))
    .filter((n) => n.qty > 0);

  return {
    productName: sku.productName,
    customerName: sku.customer.companyName,
    category: "PM",
    planName: item.plan.name,
    planCalculatedAt: item.plan.calculatedAt!.toISOString(),
    materials: await resolveLines(needs),
  };
}

export async function getRecipeMaterialAvailability(recipeId: string): Promise<AddOnPlanDetail | null> {
  const recipe = await prisma.recipe.findUnique({ where: { id: recipeId } });
  if (!recipe) return null;

  const item = await prisma.rmPlanItem.findFirst({
    where: { recipeId, deletedAt: null, plan: { status: "CALCULATED" } },
    include: { plan: true },
    orderBy: { plan: { calculatedAt: "desc" } },
  });
  if (!item?.plan.resultSnapshot) return null;

  // rm-costing-engine.ts's calculateMasterRMBOM keys its procurement
  // sources map by the Recipe's own name directly (no brand prefix,
  // unlike the BOM side — see its own comment).
  const snapshot = item.plan.resultSnapshot as unknown as RmMasterResult;
  const needs: Need[] = snapshot.procurement
    .map((p) => ({ category: "RM" as const, name: p.name.trim(), qty: p.sources[recipe.name] ?? 0 }))
    .filter((n) => n.qty > 0);

  return {
    productName: recipe.name,
    customerName: null,
    category: "RM",
    planName: item.plan.name,
    planCalculatedAt: item.plan.calculatedAt!.toISOString(),
    materials: await resolveLines(needs),
  };
}
