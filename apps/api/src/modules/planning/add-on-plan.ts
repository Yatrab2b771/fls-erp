import { prisma } from "../../common/lib/prisma";
import { getTotalAvailableByItemId } from "../inventory/stock";
import type { RmMasterResult } from "../rm-costing/rm-costing-engine";
import { calculateMasterBOM, hasBomSpec, pmLineName, type BomResult } from "../packaging-bom/bom-engine";
import { calculateMasterRMBOM } from "../rm-costing/rm-costing-engine";
import { convertOrder } from "../purchase-orders/order-conversion";

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
  /** Add on Plan only: the packaging level, and the spec / brand shown under the name. */
  group?: string;
  detail?: string;
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

const PM_LEVEL_LABEL: Record<string, string> = { "1-Primary": "Primary", "2-Secondary": "Secondary", "3-Tertiary": "Tertiary" };

type Need = { category: "RM" | "PM"; name: string; qty: number; /** Primary / Secondary / Tertiary for packaging */ group?: string; /** The spec (packaging) or the brand (raw material) */ detail?: string };

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
      ...(n.group ? { group: n.group } : {}),
      ...(n.detail ? { detail: n.detail } : {}),
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
    .map((l) => ({ category: "PM" as const, name: pmLineName(l), qty: l.sources[sourceKey] ?? 0, group: PM_LEVEL_LABEL[l.category] ?? l.category, detail: l.spec }))
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

// PPIC's plan-sent list -> "View" drill-down: given a specific PO line
// item, resolve the same Sku/Recipe match Generate already uses (exact
// productName match, scoped to the PO's customer for the Sku side) and
// reuse the two lookups above as-is — no new material-resolution logic,
// just a different way to arrive at a skuId/recipeId. Either or both can
// come back null (no catalog match, or no CALCULATED plan yet).
export async function getPoItemPlanAvailability(purchaseOrderItemId: string): Promise<{ bom: AddOnPlanDetail | null; rm: AddOnPlanDetail | null }> {
  const item = await prisma.purchaseOrderItem.findUnique({
    where: { id: purchaseOrderItemId },
    include: { purchaseOrder: { select: { customerId: true } } },
  });
  if (!item) return { bom: null, rm: null };

  // The plan PPIC calculated for THIS line item names its own Sku / Recipe, which is the surest match; only when the item has no
  // plan of its own do we fall back to matching the product name.
  const [ownBom, ownRm] = await Promise.all([
    prisma.bomPlan.findFirst({
      where: { purchaseOrderItemId, status: "CALCULATED" },
      orderBy: { calculatedAt: "desc" },
      select: { items: { where: { deletedAt: null }, take: 1, select: { skuId: true } } },
    }),
    prisma.rmPlan.findFirst({
      where: { purchaseOrderItemId, status: "CALCULATED" },
      orderBy: { calculatedAt: "desc" },
      select: { items: { where: { deletedAt: null }, take: 1, select: { recipeId: true } } },
    }),
  ]);
  const [sku, recipe] = await Promise.all([
    ownBom?.items[0] ? { id: ownBom.items[0].skuId } : prisma.sku.findFirst({ where: { productName: { equals: item.productName, mode: "insensitive" }, customerId: item.purchaseOrder.customerId } }),
    ownRm?.items[0] ? { id: ownRm.items[0].recipeId } : prisma.recipe.findFirst({ where: { customerId: item.purchaseOrder.customerId, name: { equals: item.productName, mode: "insensitive" } } }),
  ]);

  const [bom, rm] = await Promise.all([
    sku ? getSkuMaterialAvailability(sku.id) : Promise.resolve(null),
    recipe ? getRecipeMaterialAvailability(recipe.id) : Promise.resolve(null),
  ]);

  return { bom, rm };
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
    .map((p) => ({ category: "RM" as const, name: p.name.trim(), qty: p.sources[recipe.name] ?? 0, ...(p.brand ? { detail: p.brand } : {}) }))
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

// ---------------------------------------------------------------------------------------------------------------- any product, any quantity
// BD gets a call: "can we get this product urgently?". PPIC picks the product, types the quantity, and sees the RM and PM it needs against
// stock. Worked out fresh for that quantity with the same engines and the same Kg <-> packs conversion a PO line uses; nothing is saved.

export interface AddOnProduct {
  /** customerId|lower-case product name: what the calculation is asked with */
  key: string;
  customerId: string;
  customerName: string;
  name: string;
  hasPm: boolean;
  hasRm: boolean;
}

/** The products the check lists: only those with BOTH a Packaging BOM (with packaging data) and an RM formulation, so the whole answer can be given. */
export async function listAddOnProducts(): Promise<AddOnProduct[]> {
  const [skus, recipes] = await Promise.all([
    prisma.sku.findMany({ include: { customer: { select: { companyName: true } }, packagingComponents: { select: { id: true } } }, take: 5000 }),
    prisma.recipe.findMany({ where: { customerId: { not: null }, totalServing: { gt: 0 }, ingredients: { some: {} } }, include: { customer: { select: { companyName: true } } }, take: 5000 }),
  ]);
  const byKey = new Map<string, AddOnProduct>();
  const put = (customerId: string, customerName: string, name: string, side: "hasPm" | "hasRm") => {
    const key = `${customerId}|${name.trim().toLowerCase()}`;
    const entry = byKey.get(key) ?? { key, customerId, customerName, name: name.trim(), hasPm: false, hasRm: false };
    entry[side] = true;
    byKey.set(key, entry);
  };
  for (const s of skus) if (hasBomSpec({ spec: s, packagingComponents: s.packagingComponents as never })) put(s.customerId, s.customer.companyName, s.productName, "hasPm");
  for (const r of recipes) put(r.customerId!, r.customer!.companyName, r.name, "hasRm");
  return [...byKey.values()].filter((p) => p.hasPm && p.hasRm).sort((a, b) => a.name.localeCompare(b.name) || a.customerName.localeCompare(b.customerName));
}

export interface AddOnSection {
  /** false when this side cannot be worked out (no BOM / formulation, pack size missing, ...): `problem` says why */
  available: boolean;
  problem: string | null;
  lines: AddOnPlanMaterialLine[];
}

export interface AddOnResult {
  productName: string;
  customerName: string;
  quantity: number;
  unit: "KG" | "PACKS";
  kg: number | null;
  packs: number | null;
  /** The working of the Kg <-> packs conversion, e.g. "500 Kg / 1 Kg = 500 packs" */
  note: string | null;
  rm: AddOnSection;
  pm: AddOnSection;
  summary: { total: number; short: number; notInCatalog: number };
  calculatedAt: string;
}

const LEVEL_LABEL = PM_LEVEL_LABEL;

export async function calculateAddOn(input: { customerId: string; name: string; quantity: number; unit: "KG" | "PACKS" }): Promise<AddOnResult | null> {
  const customer = await prisma.customer.findUnique({ where: { id: input.customerId }, select: { companyName: true } });
  if (!customer) return null;
  const nameMatch = { equals: input.name.trim(), mode: "insensitive" as const };
  const [skus, recipes] = await Promise.all([
    prisma.sku.findMany({ where: { customerId: input.customerId, productName: nameMatch }, include: { packagingComponents: { include: { pmItem: { select: { name: true } } } } } }),
    prisma.recipe.findMany({ where: { customerId: input.customerId, name: nameMatch }, include: { ingredients: { orderBy: { sortOrder: "asc" } } } }),
  ]);
  const sku = skus.length === 1 ? skus[0]! : null;
  const recipe = recipes.length === 1 ? recipes[0]! : null;

  const conv = convertOrder({ quantity: input.quantity, unit: input.unit === "KG" ? "KG" : "SKU", poPackSize: null, bomPackSize: sku?.packSize, gummyMg: recipe?.avgUnitWeightMg });

  const none = (problem: string): AddOnSection => ({ available: false, problem, lines: [] });

  let pm: AddOnSection;
  if (skus.length === 0) pm = none("This product has no Packaging BOM yet (R&D adds it).");
  else if (!sku) pm = none("More than one Packaging BOM matches this product name: R&D has to keep one.");
  else if (!hasBomSpec({ spec: sku, packagingComponents: sku.packagingComponents })) pm = none("Its Packaging BOM has no packaging data yet (R&D fills it in).");
  else if (conv.packs == null) pm = none(conv.packsProblem ?? "Packs cannot be worked out.");
  else {
    const result = calculateMasterBOM([{ brandName: customer.companyName, productName: sku.productName, targetYield: Math.max(1, conv.packs), spec: sku, packagingComponents: sku.packagingComponents }]);
    const needs: Need[] = result.lines.map((l) => ({ category: "PM" as const, name: pmLineName(l), qty: l.totalQty, group: LEVEL_LABEL[l.category] ?? l.category, detail: l.spec }));
    pm = { available: true, problem: null, lines: await resolveLines(needs) };
  }

  let rm: AddOnSection;
  if (recipes.length === 0) rm = none("This product has no RM formulation yet (R&D adds it).");
  else if (!recipe) rm = none("More than one RM formulation matches this product name: R&D has to keep one.");
  else if (!(recipe.totalServing > 0) || recipe.ingredients.length === 0) rm = none("Its RM formulation has no ingredients yet (R&D fills it in).");
  else if (conv.kg == null || conv.kg <= 0) rm = none(conv.kgProblem ?? "Kg cannot be worked out.");
  else {
    const result = calculateMasterRMBOM([
      {
        batchSizeKg: Math.round(conv.kg * 1000) / 1000,
        recipe: { name: recipe.name, totalServing: recipe.totalServing, ingredients: recipe.ingredients.map((i) => ({ name: i.name, brand: i.brand, itemCode: i.itemCode, gPerServing: i.gPerServing, proteinPct: i.proteinPct })) },
      },
    ]);
    const needs: Need[] = result.procurement.map((p) => ({ category: "RM" as const, name: p.name.trim(), qty: p.totalKg, ...(p.brand ? { detail: p.brand } : {}) }));
    rm = { available: true, problem: null, lines: await resolveLines(needs) };
  }

  const all = [...rm.lines, ...pm.lines];
  return {
    productName: sku?.productName ?? recipe?.name ?? input.name.trim(),
    customerName: customer.companyName,
    quantity: input.quantity,
    unit: input.unit,
    kg: conv.kg,
    packs: conv.packs,
    note: conv.note,
    rm,
    pm,
    summary: { total: all.length, short: all.filter((l) => l.short).length, notInCatalog: all.filter((l) => l.onHand === null).length },
    calculatedAt: new Date().toISOString(),
  };
}
