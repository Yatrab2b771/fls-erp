import { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { loadOrderConversion } from "./order-conversion";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { calculateMasterBOM, hasBomSpec, type BomPlanLineInput } from "../packaging-bom/bom-engine";
import { calculateMasterRMBOM, type RmBatchLineInput } from "../rm-costing/rm-costing-engine";
import { planningBlockedByHold } from "./hold-guards";
import { sendItemToRegulatoryIfReady } from "./regulatory-handoff";
import { raiseRequestsForPlannedItemSafe } from "../inventory/plan-requests";
import { syncShortToPurchaseSafe } from "./purchase-sync";

/**
 * Called when R&D adds/updates a catalog entry (a packaging SKU or a Recipe):
 * any PO product that was waiting on it — it has a Draft, still-empty BOM / RM
 * plan from Generate — gets that plan calculated automatically, with exactly
 * the same match rules Generate uses (one real match; packaging spec actually
 * filled in; RM needs a Kg line). PPIC doesn't have to press Generate again.
 *
 * BOM and RM update independently: a SKU only calculates the BOM plan, a
 * Recipe only the RM plan, so a product stays "Partially Planned" until R&D has
 * provided both. Once a plan is calculated the usual hand-off to Regulatory
 * fires, and when both are done the product moves on to Material Planning.
 *
 * Skipped on purpose: a product on PPIC's hold that isn't fully planned (hold
 * means its plan can't be generated), a plan already sent to Production, and a
 * product with no Draft plan yet (PPIC never pressed Generate — nothing to
 * finish).
 */

type Logger = { error: (obj: unknown, msg: string) => void };

const itemSelect = {
  id: true,
  productName: true,
  quantity: true,
  unit: true,
  packSize: true,
  planSentToProductionAt: true,
  purchaseOrder: { select: { id: true, poNumber: true, customerId: true } },
  rmPlans: { select: { id: true, status: true, createdAt: true, items: { where: { deletedAt: null }, select: { id: true } } } },
  bomPlans: { select: { id: true, status: true, createdAt: true, items: { where: { deletedAt: null }, select: { id: true } } } },
} satisfies Prisma.PurchaseOrderItemSelect;

type Item = Prisma.PurchaseOrderItemGetPayload<{ select: typeof itemSelect }>;

async function candidateItems(productName: string, customerId?: string): Promise<Item[]> {
  return prisma.purchaseOrderItem.findMany({
    where: {
      deletedAt: null,
      cancelledAt: null,
      productName: { equals: productName, mode: "insensitive" },
      planSentToProductionAt: null,
      purchaseOrder: { status: "APPROVED", ...(customerId ? { customerId } : {}) },
    },
    select: itemSelect,
  });
}

// The plan to finish: the newest one that is still an empty Draft. A product
// that already has a CALCULATED plan of that kind is left alone.
function pickDraft<T extends { status: string; createdAt: Date; items: unknown[] }>(plans: T[]): T | null {
  if (plans.some((p) => p.status === "CALCULATED")) return null;
  const drafts = plans.filter((p) => p.status === "DRAFT" && p.items.length === 0).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return drafts[0] ?? null;
}

async function afterCalculated(item: Item, kind: "RM BOM" | "PM BOM", actorId: string, log?: Logger) {
  await sendItemToRegulatoryIfReady(item.id, actorId, log);
  await raiseRequestsForPlannedItemSafe(item.id, actorId, log);
  await syncShortToPurchaseSafe(actorId, log);
  const now = await prisma.purchaseOrderItem.findUniqueOrThrow({
    where: { id: item.id },
    select: { rmPlans: { where: { status: "CALCULATED" }, take: 1, select: { id: true } }, bomPlans: { where: { status: "CALCULATED" }, take: 1, select: { id: true } } },
  });
  const both = now.rmPlans.length > 0 && now.bomPlans.length > 0;
  const poLabel = item.purchaseOrder.poNumber ?? `PO ${item.purchaseOrder.id.slice(0, 8)}`;
  await notifyRoles(
    ["PPIC"],
    {
      title: `${item.productName}: ${kind} calculated automatically`,
      body: both ? `${poLabel} — both plans are done, it's now in Material Planning.` : `${poLabel} — R&D's update was picked up. Still waiting on the other BOM.`,
      link: `/purchase-orders/${item.purchaseOrder.id}`,
    },
    actorId,
  ).catch((err) => log?.error({ err }, "notify failed: auto_calculate"));
}

/** R&D added / updated a packaging SKU (customerId + productName) — finish the waiting BOM plans. */
export async function autoCalculateBomPlansForSku(customerId: string, productName: string, actorId: string, log?: Logger): Promise<number> {
  const candidates = await prisma.sku.findMany({ where: { customerId, productName: { equals: productName, mode: "insensitive" } }, include: { packagingComponents: true } });
  const sku = candidates.length === 1 ? candidates[0]! : null;
  if (!sku || !hasBomSpec({ spec: sku, packagingComponents: sku.packagingComponents })) return 0;

  let done = 0;
  for (const item of await candidateItems(productName, customerId)) {
    try {
      const plan = pickDraft(item.bomPlans);
      if (!plan || (await planningBlockedByHold(item.id))) continue;

      // The BOM works in packs: a Kg order is turned into packs with the pack size.
      const conv = await loadOrderConversion(item, item.purchaseOrder.customerId);
      if (conv.packs == null) continue;
      await prisma.bomPlanItem.create({ data: { planId: plan.id, skuId: sku.id, targetYield: Math.max(1, conv.packs), addedById: actorId } });
      const withItems = await prisma.bomPlan.findUniqueOrThrow({
        where: { id: plan.id },
        include: { items: { where: { deletedAt: null }, include: { sku: { include: { customer: true, packagingComponents: { include: { pmItem: { select: { name: true } } } } } } } } },
      });
      const inputs: BomPlanLineInput[] = withItems.items.map((i) => ({
        brandName: i.sku.customer.companyName,
        productName: i.sku.productName,
        targetYield: i.targetYield,
        spec: i.sku,
        packagingComponents: i.sku.packagingComponents,
      }));
      const result = calculateMasterBOM(inputs);
      await prisma.bomPlan.update({ where: { id: plan.id }, data: { status: "CALCULATED", calculatedAt: new Date(), resultSnapshot: result as unknown as Prisma.InputJsonValue } });
      await recordAudit({
        actorId,
        action: "bom_plan.calculated",
        entityType: "BomPlan",
        entityId: plan.id,
        metadata: { totalYield: result.totalYield, lineCount: result.lines.length, autoGenerated: true, trigger: "rnd_catalog_update" },
      });
      await afterCalculated(item, "PM BOM", actorId, log);
      done += 1;
    } catch (err) {
      log?.error({ err, itemId: item.id }, "auto-calculate BOM plan failed");
    }
  }
  return done;
}

/**
 * A product's hold was just released: whatever R&D uploaded while it was held
 * was skipped (hold blocks plan generation), so give its waiting Draft plans
 * one go now, the same way an upload would have.
 */
export async function autoCalculateAfterRelease(customerId: string, productName: string, actorId: string, log?: Logger): Promise<number> {
  const bom = await autoCalculateBomPlansForSku(customerId, productName, actorId, log);
  const rm = await autoCalculateRmPlansForRecipe(productName, customerId, actorId, log);
  return bom + rm;
}

/** R&D added / updated a customer's Recipe (customer + product name) — finish that customer's waiting RM plans. */
export async function autoCalculateRmPlansForRecipe(recipeName: string, customerId: string, actorId: string, log?: Logger): Promise<number> {
  const candidates = await prisma.recipe.findMany({ where: { customerId, name: { equals: recipeName, mode: "insensitive" } } });
  const recipe = candidates.length === 1 && candidates[0]!.totalServing > 0 ? candidates[0]! : null;
  if (!recipe) return 0;

  let done = 0;
  for (const item of await candidateItems(recipeName, customerId)) {
    try {
      // Same rule as Generate: the RM BOM works in Kg (a SKU order is turned into Kg with the pack size).
      const conv = await loadOrderConversion(item, item.purchaseOrder.customerId);
      if (conv.kg == null || conv.kg <= 0) continue;
      const batchKg = Math.round(conv.kg * 1000) / 1000;
      const plan = pickDraft(item.rmPlans);
      if (!plan || (await planningBlockedByHold(item.id))) continue;

      await prisma.rmPlanItem.create({ data: { planId: plan.id, recipeId: recipe.id, batchSizeKg: batchKg, addedById: actorId } });
      const ingredients = await prisma.recipeIngredient.findMany({ where: { recipeId: recipe.id }, orderBy: { sortOrder: "asc" } });
      const inputs: RmBatchLineInput[] = [
        {
          batchSizeKg: batchKg,
          recipe: {
            name: recipe.name,
            totalServing: recipe.totalServing,
            ingredients: ingredients.map((ing) => ({ name: ing.name, brand: ing.brand, itemCode: ing.itemCode, gPerServing: ing.gPerServing, proteinPct: ing.proteinPct })),
          },
        },
      ];
      const result = calculateMasterRMBOM(inputs);
      await prisma.rmPlan.update({ where: { id: plan.id }, data: { status: "CALCULATED", calculatedAt: new Date(), resultSnapshot: result as unknown as Prisma.InputJsonValue } });
      await recordAudit({
        actorId,
        action: "rm_plan.calculated",
        entityType: "RmPlan",
        entityId: plan.id,
        metadata: { batchCount: result.batches.length, autoGenerated: true, trigger: "rnd_catalog_update" },
      });
      await afterCalculated(item, "RM BOM", actorId, log);
      done += 1;
    } catch (err) {
      log?.error({ err, itemId: item.id }, "auto-calculate RM plan failed");
    }
  }
  return done;
}
