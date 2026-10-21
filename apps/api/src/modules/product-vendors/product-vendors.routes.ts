import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { RouteError } from "../../common/lib/route-error";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { getDayStoreLots, getPlantLots, vendorKey } from "../inventory/lots";
import { requirementsOf } from "../batches/batch-prep.routes";
import { allowedKeysOf, rulesForPoItems } from "./vendor-rules";

/**
 * Approved vendors (see ProductMaterialVendor in schema.prisma): R&D sets, per PRODUCT and MATERIAL, which vendors it may come from.
 *
 *   GET    /vendors                                the vendor master, for the pickers
 *   GET    /products?kind=RM|PM&search=            the recipes (RM) / packaging SKUs (PM), with how many materials are restricted
 *   GET    /products/:kind/:id                     one product's materials and their approved vendors
 *   PUT    /products/:kind/:id/materials           set the approved vendors of one material (R&D); none = unrestricted again
 *   GET    /waiting                                batches at Dispensing that are blocked because the approved vendors' stock is not enough
 *   GET    /deviations                             vendors R&D has allowed for one product and material
 *   POST   /deviations                             allow another vendor for one product and material, with a reason (R&D)
 *   DELETE /deviations/:id                         take that back (R&D)
 */
export const productVendorsRouter = Router();
productVendorsRouter.use(requireAuth);

const READ_ROLES = ["RND", "PPIC", "PURCHASE", "STORE", "PRODUCTION", "QA_QC"] as const;
const kindOf = (raw: string) => (raw === "RM" || raw === "PM" ? raw : null);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

productVendorsRouter.get("/vendors", requireRole(...READ_ROLES), async (_req, res, next) => {
  try {
    res.json(await prisma.vendor.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }));
  } catch (err) {
    next(err);
  }
});

productVendorsRouter.get("/products", requireRole(...READ_ROLES), async (req: AuthedRequest, res, next) => {
  try {
    const kind = kindOf(String(req.query.kind ?? "RM"));
    if (!kind) return res.status(400).json({ error: "kind is RM or PM" });
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const contains = search ? { contains: search, mode: "insensitive" as const } : undefined;
    const rows =
      kind === "RM"
        ? (await prisma.recipe.findMany({ where: contains ? { OR: [{ name: contains }, { customer: { companyName: contains } }] } : undefined, select: { id: true, name: true, customer: { select: { companyName: true } }, _count: { select: { ingredients: true } } }, orderBy: { name: "asc" }, take: 200 })).map((r) => ({
            id: r.id,
            name: r.name,
            customerName: r.customer?.companyName ?? null,
            materialCount: r._count.ingredients,
          }))
        : (await prisma.sku.findMany({ where: contains ? { OR: [{ productName: contains }, { customer: { companyName: contains } }] } : undefined, select: { id: true, productName: true, customer: { select: { companyName: true } }, packagingComponents: { select: { pmItemId: true } } }, orderBy: { productName: "asc" }, take: 200 })).map((s) => ({
            id: s.id,
            name: s.productName,
            customerName: s.customer.companyName,
            materialCount: s.packagingComponents.filter((c) => c.pmItemId).length,
          }));
    const rules = await prisma.productMaterialVendor.findMany({ where: { kind, scopeId: { in: rows.map((r) => r.id) } }, select: { scopeId: true, itemId: true } });
    const restricted = new Map<string, Set<string>>();
    for (const r of rules) restricted.set(r.scopeId, (restricted.get(r.scopeId) ?? new Set()).add(r.itemId));
    res.json(rows.map((r) => ({ ...r, restrictedCount: restricted.get(r.id)?.size ?? 0 })));
  } catch (err) {
    next(err);
  }
});

async function loadProduct(kind: "RM" | "PM", id: string) {
  const items: { key: string; itemId: string | null; name: string; detail: string }[] = [];
  let name: string;
  let customerName: string | null;
  if (kind === "RM") {
    const recipe = await prisma.recipe.findUnique({ where: { id }, include: { customer: { select: { companyName: true } }, ingredients: { orderBy: { sortOrder: "asc" } } } });
    if (!recipe) return null;
    name = recipe.name;
    customerName = recipe.customer?.companyName ?? null;
    const names = [...new Set(recipe.ingredients.map((i) => i.name.trim()))];
    const catalog = await prisma.inventoryItem.findMany({ where: { category: "RM", name: { in: names } }, select: { id: true, name: true } });
    const idOf = new Map(catalog.map((c) => [c.name, c.id]));
    for (const ing of recipe.ingredients) items.push({ key: ing.name.trim(), itemId: idOf.get(ing.name.trim()) ?? null, name: ing.name.trim(), detail: ing.brand });
  } else {
    const sku = await prisma.sku.findUnique({ where: { id }, include: { customer: { select: { companyName: true } }, packagingComponents: { include: { pmItem: { select: { id: true, name: true } } }, orderBy: { type: "asc" } } } });
    if (!sku) return null;
    name = sku.productName;
    customerName = sku.customer.companyName;
    for (const c of sku.packagingComponents) items.push({ key: c.id, itemId: c.pmItem?.id ?? null, name: c.pmItem?.name ?? c.type, detail: [c.type, c.spec, c.make].filter(Boolean).join(" · ") });
  }
  const rules = await prisma.productMaterialVendor.findMany({ where: { kind, scopeId: id }, include: { vendor: { select: { id: true, name: true } } } });
  const approvedOf = new Map<string, { vendorId: string; name: string }[]>();
  for (const r of rules) approvedOf.set(r.itemId, [...(approvedOf.get(r.itemId) ?? []), { vendorId: r.vendor.id, name: r.vendor.name }]);
  return { kind, id, name, customerName, materials: items.map((m) => ({ ...m, approved: m.itemId ? (approvedOf.get(m.itemId) ?? []) : [] })) };
}

productVendorsRouter.get("/products/:kind/:id", requireRole(...READ_ROLES), async (req: AuthedRequest<{ kind: string; id: string }>, res, next) => {
  try {
    const kind = kindOf(req.params.kind);
    if (!kind) return res.status(400).json({ error: "kind is RM or PM" });
    const product = await loadProduct(kind, req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    next(err);
  }
});

const setMaterialSchema = z.object({
  /** RM: the ingredient's name (the item is found, or created, from it). PM: the packaging item's id. */
  name: z.string().trim().min(1).max(200).optional(),
  itemId: z.string().uuid().optional(),
  vendorIds: z.array(z.string().uuid()).max(30),
});

productVendorsRouter.put("/products/:kind/:id/materials", requireRole("RND"), validateBody(setMaterialSchema), async (req: AuthedRequest<{ kind: string; id: string }>, res, next) => {
  try {
    const kind = kindOf(req.params.kind);
    if (!kind) return res.status(400).json({ error: "kind is RM or PM" });
    const product = await loadProduct(kind, req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });
    const { name, itemId: givenItemId, vendorIds } = req.body as z.infer<typeof setMaterialSchema>;

    let itemId = givenItemId ?? null;
    if (kind === "RM") {
      const material = product.materials.find((m) => m.name === name?.trim());
      if (!material) return res.status(400).json({ error: "That material is not an ingredient of this recipe." });
      // The item the recipe's ingredient stands for; made if the catalog does not have it yet (as everywhere a plan names a material).
      itemId = material.itemId ?? (await prisma.inventoryItem.upsert({ where: { category_name: { category: "RM", name: material.name } }, create: { category: "RM", name: material.name, unit: "Kg" }, update: {} })).id;
    } else if (!itemId || !product.materials.some((m) => m.itemId === itemId)) {
      return res.status(400).json({ error: "Pick one of this SKU's packaging materials (the component needs a packaging item linked to it first)." });
    }
    const vendors = await prisma.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true } });
    if (vendors.length !== new Set(vendorIds).size) return res.status(400).json({ error: "Unknown vendor" });

    await prisma.$transaction(async (tx) => {
      await tx.productMaterialVendor.deleteMany({ where: { kind, scopeId: product.id, itemId: itemId!, vendorId: { notIn: vendorIds } } });
      const have = new Set((await tx.productMaterialVendor.findMany({ where: { kind, scopeId: product.id, itemId: itemId! }, select: { vendorId: true } })).map((r) => r.vendorId));
      for (const vendorId of new Set(vendorIds)) if (!have.has(vendorId)) await tx.productMaterialVendor.create({ data: { kind, scopeId: product.id, itemId: itemId!, vendorId, createdById: req.user!.id } });
    });
    await recordAudit({ actorId: req.user!.id, action: "product_vendors.set", entityType: kind === "RM" ? "Recipe" : "Sku", entityId: product.id, metadata: { itemId, vendorIds } });
    res.json(await loadProduct(kind, product.id));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- deviations

const poItemSelect = { id: true, productName: true, purchaseOrder: { select: { poNumber: true, customer: { select: { companyName: true } } } } } as const;

productVendorsRouter.get("/deviations", requireRole(...READ_ROLES), async (_req, res, next) => {
  try {
    const rows = await prisma.vendorDeviation.findMany({ orderBy: { createdAt: "desc" }, take: 300 });
    const [poItems, items, users] = await Promise.all([
      prisma.purchaseOrderItem.findMany({ where: { id: { in: rows.map((r) => r.purchaseOrderItemId) } }, select: poItemSelect }),
      prisma.inventoryItem.findMany({ where: { id: { in: rows.map((r) => r.itemId) } }, select: { id: true, name: true } }),
      prisma.user.findMany({ where: { id: { in: rows.map((r) => r.approvedById) } }, select: { id: true, fullName: true } }),
    ]);
    const po = new Map(poItems.map((p) => [p.id, p]));
    const item = new Map(items.map((i) => [i.id, i.name]));
    const user = new Map(users.map((u) => [u.id, u.fullName]));
    const rules = await rulesForPoItems(rows.map((r) => r.purchaseOrderItemId));
    res.json(
      rows.map((r) => ({
        id: r.id,
        purchaseOrderItemId: r.purchaseOrderItemId,
        productName: po.get(r.purchaseOrderItemId)?.productName ?? "—",
        poNumber: po.get(r.purchaseOrderItemId)?.purchaseOrder.poNumber ?? null,
        customerName: po.get(r.purchaseOrderItemId)?.purchaseOrder.customer.companyName ?? "",
        itemId: r.itemId,
        material: item.get(r.itemId) ?? "—",
        approvedVendors: rules.get(r.purchaseOrderItemId)?.get(r.itemId)?.vendorNames ?? [],
        reason: r.reason,
        approvedByName: user.get(r.approvedById) ?? "—",
        createdAt: r.createdAt,
      })),
    );
  } catch (err) {
    next(err);
  }
});

const deviationSchema = z.object({ purchaseOrderItemId: z.string().uuid(), itemId: z.string().uuid(), reason: z.string().trim().min(5, "Say why another vendor is being allowed.").max(500) });

productVendorsRouter.post("/deviations", requireRole("RND"), validateBody(deviationSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { purchaseOrderItemId, itemId, reason } = req.body as z.infer<typeof deviationSchema>;
    const rule = (await rulesForPoItems([purchaseOrderItemId])).get(purchaseOrderItemId)?.get(itemId);
    if (!rule) return res.status(400).json({ error: "This product has no approved-vendor rule for that material - nothing to allow." });
    const row = await prisma.vendorDeviation.upsert({
      where: { purchaseOrderItemId_itemId: { purchaseOrderItemId, itemId } },
      create: { purchaseOrderItemId, itemId, reason, approvedById: req.user!.id },
      update: { reason, approvedById: req.user!.id },
    });
    await recordAudit({ actorId: req.user!.id, action: "product_vendors.deviation_allowed", entityType: "PurchaseOrderItem", entityId: purchaseOrderItemId, metadata: { itemId, reason, approvedVendors: rule.vendorNames } });
    await notifyRoles(["STORE", "PURCHASE", "PRODUCTION"], { title: "Another vendor allowed for a product", body: reason, link: "/approved-vendors" }, req.user!.id).catch((err) => req.log?.error({ err }, "notify failed: vendor deviation"));
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

productVendorsRouter.delete("/deviations/:id", requireRole("RND"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const row = await prisma.vendorDeviation.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: "Not found" });
    await prisma.vendorDeviation.delete({ where: { id: row.id } });
    await recordAudit({ actorId: req.user!.id, action: "product_vendors.deviation_withdrawn", entityType: "PurchaseOrderItem", entityId: row.purchaseOrderItemId, metadata: { itemId: row.itemId } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- blocked batches

/**
 * Batches at Dispensing that cannot be dispensed because a restricted material is not held, in enough quantity, by its approved vendors at
 * the Plant and its Day Store. R&D decides here: wait for the approved vendor's material, or allow another vendor for that product.
 */
productVendorsRouter.get("/waiting", requireRole(...READ_ROLES), async (_req, res, next) => {
  try {
    const batches = await prisma.productionBatch.findMany({
      where: { status: "IN_PROGRESS", prepStageId: "DISPENSING", heldAt: null, preProduction: { batchFlow: true, plantId: { not: null }, purchaseOrderItem: { cancelledAt: null, deletedAt: null } } },
      select: {
        id: true,
        batchNo: true,
        plannedQty: true,
        preProduction: { select: { plant: { select: { id: true, name: true, dayStoreId: true } }, purchaseOrderItem: { select: { id: true, productName: true, quantity: true, unit: true, purchaseOrder: { select: { poNumber: true, customer: { select: { companyName: true } } } } } } } },
      },
      orderBy: { createdAt: "asc" },
    });
    if (batches.length === 0) return res.json([]);
    const rules = await rulesForPoItems([...new Set(batches.map((b) => b.preProduction.purchaseOrderItem.id))]);
    const out: object[] = [];
    for (const b of batches) {
      const po = b.preProduction.purchaseOrderItem;
      const plant = b.preProduction.plant!;
      const itemRules = rules.get(po.id);
      if (!itemRules?.size) continue;
      const needs = await requirementsOf({ plannedQty: b.plannedQty, preProduction: { purchaseOrderItem: { id: po.id, quantity: po.quantity } } });
      const names = new Map((await prisma.inventoryItem.findMany({ where: { id: { in: needs.map((n) => n.itemId) } }, select: { id: true, name: true } })).map((i) => [i.id, i.name]));
      for (const need of needs) {
        const rule = itemRules.get(need.itemId);
        const keys = allowedKeysOf(rule);
        if (!rule || !keys) continue;
        const lots = [...(await getPlantLots(prisma, plant.id, need.itemId)), ...(plant.dayStoreId ? await getDayStoreLots(prisma, plant.dayStoreId, need.itemId) : [])].filter((l) => !l.expired && l.remaining > 1e-9);
        const approved = lots.filter((l) => keys.has(vendorKey(l.vendorName))).reduce((s, l) => s + l.remaining, 0);
        if (approved >= need.requiredQty - 1e-9) continue;
        const other = lots.reduce((s, l) => s + l.remaining, 0) - approved;
        out.push({
          batchId: b.id,
          batchNo: b.batchNo,
          purchaseOrderItemId: po.id,
          poNumber: po.purchaseOrder.poNumber,
          customerName: po.purchaseOrder.customer.companyName,
          productName: po.productName,
          plantName: plant.name,
          itemId: need.itemId,
          material: names.get(need.itemId) ?? need.itemName,
          unit: need.unit,
          neededQty: round3(need.requiredQty),
          approvedQty: round3(approved),
          otherVendorsQty: round3(Math.max(0, other)),
          approvedVendors: rule.vendorNames,
        });
      }
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
});

void RouteError;
