import { Router } from "express";
import { z } from "zod";
import { Prisma as PrismaNs, type Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { calculateMasterBOM, type BomResult, type PackagingComponentInput } from "./bom-engine";
import { calculateMasterRMBOM, type RmMasterResult } from "../rm-costing/rm-costing-engine";

/**
 * A product's BOM versions. The catalog's own Recipe (RM) and packaging BOM (PM) are the DISPLAY BOM: the default, always the active one and
 * what the customer is shown. R&D can keep two more, V1 and V2 (three in all, never more), each with an RM recipe and/or a PM component list
 * of its own. This module only keeps and edits those slots; using one for a plan (urgent production, a change during manufacturing) is built
 * on top of the calculations below.
 *
 *   GET    /products?search=                  the catalog's products and which slots each has
 *   GET    /?customerId=&productName=         one product: Display + V1 + V2
 *   PUT    /:slot                             R&D saves V1 / V2 (RM and / or PM), replacing what was there
 *   POST   /:slot/copy-from-display           V1 / V2 starts as a copy of the Display BOM
 *   DELETE /:slot?customerId=&productName=    empties V1 / V2
 *   POST   /preview                           what a version would need for a given Kg / number of packs
 */
export const bomSlotsRouter = Router();
bomSlotsRouter.use(requireAuth);

export const SLOTS = ["V1", "V2"] as const;
export type Slot = (typeof SLOTS)[number];
export type PlanSlot = "DISPLAY" | Slot;

const ingredientSchema = z.object({
  name: z.string().trim().min(1, "Every ingredient needs a name."),
  brand: z.string().trim().min(1, "Every ingredient needs a brand."),
  itemCode: z.string().trim().max(60).nullable().optional(),
  gPerServing: z.coerce.number().positive("Every ingredient needs a quantity above zero."),
  uom: z.string().trim().max(20).optional(),
  // A 0-1 fraction or a 0-100 percentage, as the recipe catalog accepts
  proteinPct: z.coerce.number().min(0).default(0),
});
const rmSnapshotSchema = z.object({
  kind: z.enum(["PER_KG", "PER_UNIT"]).optional(),
  // The recipe sheet's own header (informational: a plan's batch size comes from the plan itself)
  productCode: z.string().trim().max(60).nullable().optional(),
  versionLabel: z.string().trim().max(80).nullable().optional(),
  batchSize: z.coerce.number().positive().nullable().optional(),
  avgUnitWeightMg: z.coerce.number().positive().nullable().optional(),
  ingredients: z.array(ingredientSchema).min(1, "An RM recipe needs at least one ingredient.").max(300),
});
const componentSchema = z.object({
  type: z.string().trim().min(1, "Every component needs a name."),
  quantity: z.coerce.number().min(0).nullable().optional(),
  unit: z.string().trim().max(20).optional(),
  pmCode: z.string().trim().max(60).nullable().optional(),
  pmItemId: z.string().nullable().optional(),
  overagePct: z.coerce.number().min(0).max(1).nullable().optional(),
  spec: z.string().trim().max(200).nullable().optional(),
  make: z.string().trim().max(200).nullable().optional(),
  packingLevel: z.string().trim().max(40).nullable().optional(),
});
const pmHeaderSchema = z.object({
  productCode: z.string().trim().max(60).nullable().optional(),
  packSize: z.string().trim().max(60).nullable().optional(),
  packingConfig: z.string().trim().max(120).nullable().optional(),
  batchPacks: z.coerce.number().int().positive().nullable().optional(),
});
const pmSnapshotSchema = z.object({ header: pmHeaderSchema.optional(), components: z.array(componentSchema).min(1, "A PM BOM needs at least one component.").max(100) });

export type RmSlotSnapshot = z.infer<typeof rmSnapshotSchema>;
export type PmSlotSnapshot = z.infer<typeof pmSnapshotSchema>;

const productRef = z.object({ customerId: z.string().min(1), productName: z.string().trim().min(1) });
const saveSchema = productRef.extend({
  rm: rmSnapshotSchema.nullable().optional(),
  pm: pmSnapshotSchema.nullable().optional(),
  note: z.string().trim().max(300).optional(),
});
const previewSchema = productRef.extend({
  slot: z.enum(["DISPLAY", ...SLOTS]),
  kg: z.coerce.number().positive().optional(),
  packs: z.coerce.number().int().positive().optional(),
});

const keyOf = (productName: string) => productName.trim().toLowerCase();
const parseSlot = (v: string): Slot | null => ((SLOTS as readonly string[]).includes(v.toUpperCase()) ? (v.toUpperCase() as Slot) : null);

// --- The Display BOM: what the catalog holds today for the product.
export async function loadDisplay(customerId: string, productName: string) {
  const [recipe, sku] = await Promise.all([
    prisma.recipe.findFirst({ where: { customerId, name: { equals: productName, mode: "insensitive" } }, include: { ingredients: { orderBy: { sortOrder: "asc" } } } }),
    prisma.sku.findFirst({
      where: { customerId, productName: { equals: productName, mode: "insensitive" } },
      include: { customer: { select: { companyName: true } }, packagingComponents: { include: { pmItem: { select: { name: true } } } } },
    }),
  ]);
  const rm: RmSlotSnapshot | null = recipe
    ? { kind: recipe.kind === "PER_UNIT" ? "PER_UNIT" : "PER_KG", productCode: recipe.productCode, versionLabel: recipe.versionLabel, batchSize: recipe.batchSize, avgUnitWeightMg: recipe.avgUnitWeightMg, ingredients: recipe.ingredients.map((i) => ({ name: i.name, brand: i.brand, itemCode: i.itemCode, gPerServing: i.gPerServing, uom: i.uom, proteinPct: i.proteinPct })) }
    : null;
  const pm: PmSlotSnapshot | null =
    sku && sku.packagingComponents.length > 0
      ? { header: { productCode: sku.productCode, packSize: sku.packSize, packingConfig: sku.packingConfig, batchPacks: sku.batchPacks }, components: sku.packagingComponents.map((c) => ({ type: c.type, quantity: c.quantity, unit: c.unit, pmCode: c.pmCode, pmItemId: c.pmItemId, overagePct: c.overagePct, spec: c.spec, make: c.make, packingLevel: c.packingLevel })) }
      : null;
  return { recipe, sku, rm, pm };
}

// --- The calculations a version feeds (the same engines the catalog plans use).
type RmEngineLine = Parameters<typeof calculateMasterRMBOM>[0][number];

/** One recipe line for the RM engine from a version's ingredients. */
function rmLineOf(name: string, snap: RmSlotSnapshot, batchKg: number): RmEngineLine {
  const ingredients = snap.ingredients.map((i) => ({ name: i.name, brand: i.brand, itemCode: i.itemCode ?? null, gPerServing: i.gPerServing, proteinPct: i.proteinPct > 1 ? i.proteinPct / 100 : i.proteinPct }));
  return { batchSizeKg: batchKg, recipe: { name, totalServing: ingredients.reduce((t, i) => t + i.gPerServing, 0), ingredients } };
}

export function computeRm(name: string, snap: RmSlotSnapshot, batchKg: number): RmMasterResult {
  return calculateMasterRMBOM([rmLineOf(name, snap, batchKg)]);
}

/** The packaging components of a version as the BOM engine reads them (a linked Store item gives the line its name). */
async function pmComponentsOf(snap: PmSlotSnapshot): Promise<PackagingComponentInput[]> {
  const ids = [...new Set(snap.components.map((c) => c.pmItemId).filter((x): x is string => !!x))];
  const names = new Map((ids.length ? await prisma.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((i) => [i.id, i.name]));
  return snap.components.map((c) => ({
    type: c.type,
    quantity: c.quantity ?? null,
    unit: c.unit || "Nos",
    pmCode: c.pmCode ?? null,
    overagePct: c.overagePct ?? null,
    packingLevel: c.packingLevel ?? null,
    pmItemName: c.pmItemId ? names.get(c.pmItemId) ?? null : null,
  }));
}

export async function computePm(customerId: string, productName: string, snap: PmSlotSnapshot, packs: number): Promise<BomResult | null> {
  const { sku } = await loadDisplay(customerId, productName);
  if (!sku) return null;
  return calculateMasterBOM([{ brandName: sku.customer.companyName, productName: sku.productName, targetYield: packs, spec: sku, packagingComponents: await pmComponentsOf(snap) }]);
}

export type SlotResults = { ok: true; rm: RmMasterResult; pm: BomResult } | { ok: false; status: number; error: string };

/**
 * What a product's RM and Packaging plans would be if made from `slot`, worked out from the plans already calculated (their batch size and
 * packs). A version holds an RM recipe and / or a PM list; a half it does not have is taken from the Display BOM.
 */
export async function resultsForSlot(itemId: string, slot: PlanSlot): Promise<SlotResults> {
  const item = await prisma.purchaseOrderItem.findUnique({
    where: { id: itemId },
    select: {
      productName: true,
      purchaseOrder: { select: { customerId: true } },
      rmPlans: {
        where: { status: "CALCULATED" },
        orderBy: { calculatedAt: "desc" },
        take: 1,
        select: { items: { where: { deletedAt: null }, select: { batchSizeKg: true, recipe: { select: { name: true, customerId: true, totalServing: true, ingredients: { orderBy: { sortOrder: "asc" } } } } } } },
      },
      bomPlans: {
        where: { status: "CALCULATED" },
        orderBy: { calculatedAt: "desc" },
        take: 1,
        select: { items: { where: { deletedAt: null }, select: { targetYield: true, sku: { include: { customer: true, packagingComponents: { include: { pmItem: { select: { name: true } } } } } } } } },
      },
    },
  });
  if (!item) return { ok: false, status: 404, error: "Product not found." };
  const rmPlan = item.rmPlans[0];
  const bomPlan = item.bomPlans[0];
  if (!rmPlan || !bomPlan) return { ok: false, status: 409, error: "Both plans (RM and Packaging) have to be calculated first." };
  if (rmPlan.items.length === 0 || bomPlan.items.length === 0) return { ok: false, status: 409, error: "The plan has no recipe or SKU in it." };
  const customerId = item.purchaseOrder.customerId;
  const display = await loadDisplay(customerId, item.productName);
  const row = slot === "DISPLAY" ? null : await prisma.productBomVersion.findUnique({ where: { customerId_productKey_slot: { customerId, productKey: keyOf(item.productName), slot } } });
  if (slot !== "DISPLAY" && !row) return { ok: false, status: 409, error: `${slot} is empty for this product: make it in the RM BOM and Packaging BOM first.` };
  const rmSnap = (row?.rmSnapshot as unknown as RmSlotSnapshot | null) ?? display.rm;
  const pmSnap = (row?.pmSnapshot as unknown as PmSlotSnapshot | null) ?? display.pm;
  if (!rmSnap) return { ok: false, status: 409, error: "There is no RM recipe to make the plan from." };
  if (!pmSnap) return { ok: false, status: 409, error: "There are no PM components to make the plan from." };
  // A plan may hold several recipes / SKUs: only this product's own is made from the version, the others stay as they are in the catalog.
  const isOwn = (name: string, owner: string | null) => owner === customerId && keyOf(name) === keyOf(item.productName);
  const ownRm = rmPlan.items.length === 1 ? rmPlan.items[0]! : rmPlan.items.find((i) => isOwn(i.recipe.name, i.recipe.customerId));
  const ownPm = bomPlan.items.length === 1 ? bomPlan.items[0]! : bomPlan.items.find((i) => isOwn(i.sku.productName, i.sku.customerId));
  if (!ownRm) return { ok: false, status: 409, error: "This plan has several recipes and none of them is this product's." };
  if (!ownPm) return { ok: false, status: 409, error: "This plan has several packaging SKUs and none of them is this product's." };

  const rmLines: RmEngineLine[] = rmPlan.items.map((i) =>
    i === ownRm
      ? rmLineOf(display.recipe?.name ?? item.productName, rmSnap, i.batchSizeKg)
      : { batchSizeKg: i.batchSizeKg, recipe: { name: i.recipe.name, totalServing: i.recipe.totalServing, ingredients: i.recipe.ingredients.map((g) => ({ name: g.name, brand: g.brand, itemCode: g.itemCode, gPerServing: g.gPerServing, proteinPct: g.proteinPct })) } },
  );
  const ownComponents = await pmComponentsOf(pmSnap);
  const pm = calculateMasterBOM(
    bomPlan.items.map((i) => ({
      brandName: i.sku.customer.companyName,
      productName: i.sku.productName,
      targetYield: i.targetYield,
      spec: i.sku,
      packagingComponents: i === ownPm ? ownComponents : i.sku.packagingComponents,
    })),
  );
  return { ok: true, rm: calculateMasterRMBOM(rmLines), pm };
}

const toSnap = <T>(v: Prisma.JsonValue | null): T | null => (v ? (v as unknown as T) : null);

async function detail(customerId: string, productName: string) {
  const [display, rows, customer] = await Promise.all([
    loadDisplay(customerId, productName),
    prisma.productBomVersion.findMany({ where: { customerId, productKey: keyOf(productName) } }),
    prisma.customer.findUnique({ where: { id: customerId }, select: { companyName: true } }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.createdById, r.updatedById]).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } });
  const nameOf = new Map(users.map((u) => [u.id, u.fullName]));
  const slotOf = (slot: Slot) => {
    const r = rows.find((x) => x.slot === slot);
    if (!r) return null;
    return { slot, rm: toSnap<RmSlotSnapshot>(r.rmSnapshot), pm: toSnap<PmSlotSnapshot>(r.pmSnapshot), note: r.note, updatedAt: r.updatedAt, updatedByName: nameOf.get(r.updatedById ?? r.createdById) ?? null };
  };
  return {
    customerId,
    customerName: customer?.companyName ?? null,
    productName: display.recipe?.name ?? display.sku?.productName ?? productName,
    display: { rm: display.rm, pm: display.pm },
    slots: { V1: slotOf("V1"), V2: slotOf("V2") },
  };
}

export const slotsOf = detail;

bomSlotsRouter.get("/products", async (req, res, next) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const textFilter = search ? { contains: search, mode: "insensitive" as const } : undefined;
    const [recipes, skus, slots] = await Promise.all([
      prisma.recipe.findMany({ where: { customerId: { not: null }, ...(textFilter ? { OR: [{ name: textFilter }, { customer: { companyName: textFilter } }] } : {}) }, select: { customerId: true, name: true, customer: { select: { companyName: true } } }, take: 400 }),
      prisma.sku.findMany({ where: textFilter ? { OR: [{ productName: textFilter }, { customer: { companyName: textFilter } }] } : {}, select: { customerId: true, productName: true, customer: { select: { companyName: true } }, _count: { select: { packagingComponents: true } } }, take: 400 }),
      prisma.productBomVersion.findMany({ select: { customerId: true, productKey: true, slot: true, rmSnapshot: true, pmSnapshot: true, updatedAt: true } }),
    ]);
    type Row = { customerId: string; customerName: string; productName: string; hasRm: boolean; hasPm: boolean; slots: Record<Slot, { rm: boolean; pm: boolean; updatedAt: Date } | null> };
    const map = new Map<string, Row>();
    const row = (customerId: string, customerName: string, productName: string) => {
      const k = `${customerId}::${keyOf(productName)}`;
      let r = map.get(k);
      if (!r) {
        r = { customerId, customerName, productName, hasRm: false, hasPm: false, slots: { V1: null, V2: null } };
        map.set(k, r);
      }
      return r;
    };
    for (const r of recipes) row(r.customerId!, r.customer?.companyName ?? "", r.name).hasRm = true;
    for (const s of skus) {
      const r = row(s.customerId, s.customer.companyName, s.productName);
      if (s._count.packagingComponents > 0) r.hasPm = true;
    }
    for (const v of slots) {
      const r = [...map.values()].find((x) => x.customerId === v.customerId && keyOf(x.productName) === v.productKey);
      if (r && (v.slot === "V1" || v.slot === "V2")) r.slots[v.slot] = { rm: !!v.rmSnapshot, pm: !!v.pmSnapshot, updatedAt: v.updatedAt };
    }
    res.json([...map.values()].sort((a, b) => a.customerName.localeCompare(b.customerName) || a.productName.localeCompare(b.productName)));
  } catch (err) {
    next(err);
  }
});

bomSlotsRouter.get("/", async (req, res, next) => {
  try {
    const parsed = productRef.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Give the customer and the product name." });
    res.json(await detail(parsed.data.customerId, parsed.data.productName));
  } catch (err) {
    next(err);
  }
});

bomSlotsRouter.put("/:slot", requireRole("RND"), validateBody(saveSchema), async (req: AuthedRequest<{ slot: string }>, res, next) => {
  try {
    const slot = parseSlot(req.params.slot);
    if (!slot) return res.status(400).json({ error: "Only V1 and V2 can be saved: the Display BOM is the catalog's own." });
    const input = req.body as z.infer<typeof saveSchema>;
    if (input.rm === undefined && input.pm === undefined) return res.status(400).json({ error: "Send the RM recipe, the PM components, or both." });
    const types = (input.pm?.components ?? []).map((c) => c.type.toLowerCase());
    if (new Set(types).size !== types.length) return res.status(400).json({ error: "A component is listed twice." });
    const display = await loadDisplay(input.customerId, input.productName);
    if (!display.recipe && !display.sku) return res.status(404).json({ error: "This product is not in the catalog: add its recipe or packaging BOM first." });
    const productKey = keyOf(display.recipe?.name ?? display.sku?.productName ?? input.productName);
    const productName = display.recipe?.name ?? display.sku?.productName ?? input.productName;

    const json = (v: unknown) => v as Prisma.InputJsonValue;
    // Only what was sent changes; null empties that half (a JSON column is cleared with Prisma.DbNull)
    const clean = {
      ...(input.rm !== undefined ? { rmSnapshot: input.rm === null ? PrismaNs.DbNull : json(input.rm) } : {}),
      ...(input.pm !== undefined ? { pmSnapshot: input.pm === null ? PrismaNs.DbNull : json(input.pm) } : {}),
      note: input.note ?? null,
    };
    const saved = await prisma.productBomVersion.upsert({
      where: { customerId_productKey_slot: { customerId: input.customerId, productKey, slot } },
      create: { customerId: input.customerId, productKey, productName, slot, createdById: req.user!.id, ...clean },
      update: { ...clean, updatedById: req.user!.id },
    });
    await recordAudit({ actorId: req.user!.id, action: "bom_slot.saved", entityType: "ProductBomVersion", entityId: saved.id, metadata: { slot, productName, rm: input.rm !== undefined, pm: input.pm !== undefined } });
    res.json(await detail(input.customerId, productName));
  } catch (err) {
    next(err);
  }
});

bomSlotsRouter.post("/:slot/copy-from-display", requireRole("RND"), validateBody(productRef), async (req: AuthedRequest<{ slot: string }>, res, next) => {
  try {
    const slot = parseSlot(req.params.slot);
    if (!slot) return res.status(400).json({ error: "Only V1 and V2 can be saved." });
    const { customerId, productName } = req.body as z.infer<typeof productRef>;
    const display = await loadDisplay(customerId, productName);
    if (!display.rm && !display.pm) return res.status(404).json({ error: "The Display BOM has no recipe or packaging BOM to copy." });
    const name = display.recipe?.name ?? display.sku?.productName ?? productName;
    const json = (v: unknown) => v as Prisma.InputJsonValue;
    const values = { ...(display.rm ? { rmSnapshot: json(display.rm) } : {}), ...(display.pm ? { pmSnapshot: json(display.pm) } : {}), note: "Copy of the Display BOM" };
    const saved = await prisma.productBomVersion.upsert({
      where: { customerId_productKey_slot: { customerId, productKey: keyOf(name), slot } },
      create: { customerId, productKey: keyOf(name), productName: name, slot, createdById: req.user!.id, ...values },
      update: { ...values, updatedById: req.user!.id },
    });
    await recordAudit({ actorId: req.user!.id, action: "bom_slot.copied_from_display", entityType: "ProductBomVersion", entityId: saved.id, metadata: { slot, productName: name } });
    res.json(await detail(customerId, name));
  } catch (err) {
    next(err);
  }
});

bomSlotsRouter.delete("/:slot", requireRole("RND"), async (req: AuthedRequest<{ slot: string }>, res, next) => {
  try {
    const slot = parseSlot(req.params.slot);
    if (!slot) return res.status(400).json({ error: "Only V1 and V2 can be emptied." });
    const parsed = productRef.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Give the customer and the product name." });
    const { customerId, productName } = parsed.data;
    const res2 = await prisma.productBomVersion.deleteMany({ where: { customerId, productKey: keyOf(productName), slot } });
    if (res2.count > 0) await recordAudit({ actorId: req.user!.id, action: "bom_slot.deleted", entityType: "ProductBomVersion", entityId: `${customerId}:${keyOf(productName)}:${slot}`, metadata: { slot, productName } });
    res.json(await detail(customerId, productName));
  } catch (err) {
    next(err);
  }
});

bomSlotsRouter.post("/preview", validateBody(previewSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof previewSchema>;
    const view = await detail(input.customerId, input.productName);
    const pick = input.slot === "DISPLAY" ? view.display : view.slots[input.slot];
    if (!pick) return res.status(404).json({ error: `${input.slot} is empty for this product.` });
    const rm = pick.rm && input.kg ? computeRm(view.productName, pick.rm, input.kg) : null;
    const pm = pick.pm && input.packs ? await computePm(input.customerId, view.productName, pick.pm, input.packs) : null;
    res.json({ slot: input.slot, rm: rm ? { procurement: rm.procurement } : null, pm: pm ? { lines: pm.lines } : null });
  } catch (err) {
    next(err);
  }
});
