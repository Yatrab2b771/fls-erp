import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { findSimilar } from "../../common/lib/fuzzy-match";
import { ensureRecipeRequest } from "../recipe-requests/recipe-request.routes";
import { addRmPlanItemSchema, costingParamsSchema, createRmPlanSchema, updateCostingParamsSchema } from "./rm-plan.schemas";
import { calculateMasterRMBOM, type CostingParams, type RmBatchLineInput, type RmMasterResult } from "./rm-costing-engine";
import { buildRmMasterWorkbook } from "./rm-export";
import { buildBatchDispensingPdf, buildMasterProcurementPdf } from "./rm-pdf";
import { bulkCreateRequirements, type RequirementSourceRow } from "../inventory/pre-inventory.routes";
import { createPoMaterialRequirements } from "../po-readiness/po-readiness.routes";
import { createMaterialRequestsFromPlan } from "../inventory/inventory.routes";
import { Prisma } from "@prisma/client";

export const rmPlanRouter = Router();

rmPlanRouter.use(requireAuth);

// Defaults for every field of the costing profile, same values as the
// prototype's costing panel inputs (cost-mfg-loss=3, cost-pack-size=400, ...).
const defaultCostingParams: CostingParams = costingParamsSchema.parse({});

function serializePlan(
  plan: {
    id: string;
    name: string;
    dateFrom: Date | null;
    dateTo: Date | null;
    status: string;
    costingParams: unknown;
    calculatedAt: Date | null;
    createdAt: Date;
    // Included so reopening an already-calculated plan can render its last
    // result immediately, instead of showing an empty table until Calculate
    // is clicked again — same snapshot POST /calculate and the export
    // endpoints already read, just also exposed on GET.
    resultSnapshot: unknown;
    // Set once Send to Pre-Inventory succeeds — see BomPlan's identical
    // field for why (no unique constraint on PreInventoryRequirement to
    // fall back on, so a second send must be blocked explicitly).
    sentToPreInventoryAt: Date | null;
    items: { id: string; batchSizeKg: number; recipe: { id: string; name: string; totalServing: number } }[];
    purchaseOrderItemId: string | null;
    purchaseOrderItem: { id: string; productName: string; purchaseOrder: { id: string; poNumber: string | null } } | null;
  },
  // Populated only when this plan is linked to a PO item, still has no
  // queued Recipe, and a near-name-match exists — see
  // findRecipeSuggestions. Same "did you mean X?" idea as BomPlan's own
  // suggestedSkus.
  suggestions?: { recipeId: string; recipeName: string; score: number; defaultBatchSizeKg: number }[],
) {
  return {
    id: plan.id,
    name: plan.name,
    dateFrom: plan.dateFrom,
    dateTo: plan.dateTo,
    status: plan.status,
    costingParams: plan.costingParams,
    calculatedAt: plan.calculatedAt,
    createdAt: plan.createdAt,
    sentToPreInventoryAt: plan.sentToPreInventoryAt,
    result: plan.resultSnapshot ?? null,
    items: plan.items.map((i) => ({
      id: i.id,
      recipeId: i.recipe.id,
      recipeName: i.recipe.name,
      batchSizeKg: i.batchSizeKg,
    })),
    purchaseOrderItemId: plan.purchaseOrderItemId,
    linkedOrder: plan.purchaseOrderItem
      ? { productName: plan.purchaseOrderItem.productName, poNumber: plan.purchaseOrderItem.purchaseOrder.poNumber, purchaseOrderId: plan.purchaseOrderItem.purchaseOrder.id }
      : null,
    suggestedRecipes: suggestions && suggestions.length > 0 ? suggestions : undefined,
  };
}

// Mirrors bom-plan.routes.ts's findSkuSuggestions. defaultBatchSizeKg is
// always the PO line's raw quantity — even when its unit isn't Kg (so
// the exact-match auto-calc above skips it), since fixing a typo is
// still useful there; the frontend just needs to let the batch size be
// edited before adding rather than treating it as a guaranteed-correct
// number the way the Kg-unit case is.
async function findRecipeSuggestions(poItem: { productName: string; quantity: number } | null) {
  if (!poItem) return undefined;
  const catalog = await prisma.recipe.findMany();
  return findSimilar(poItem.productName, catalog, (r) => r.name).map((c) => ({
    recipeId: c.item.id,
    recipeName: c.item.name,
    score: c.score,
    defaultBatchSizeKg: poItem.quantity,
  }));
}

const planInclude = {
  // deletedAt: null — same reasoning as Packaging BOM's own planInclude.
  items: { where: { deletedAt: null }, include: { recipe: true } },
  purchaseOrderItem: { include: { purchaseOrder: { select: { id: true, poNumber: true } } } },
} satisfies Prisma.RmPlanInclude;

// Shared across the team, not scoped per-user — the persistent replacement
// for a browser-local "Batch Queue", same pattern as bom_plans.
rmPlanRouter.get("/plans", async (req, res, next) => {
  try {
    const pagination = parsePagination(req);
    const [total, plans] = await Promise.all([
      prisma.rmPlan.count(),
      prisma.rmPlan.findMany({
        include: planInclude,
        orderBy: { createdAt: "desc" },
        skip: pagination.skip,
        take: pagination.take,
      }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(plans.map((p) => serializePlan(p)));
  } catch (err) {
    next(err);
  }
});

rmPlanRouter.post("/plans", validateBody(createRmPlanSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { name, dateFrom, dateTo, costingParams, purchaseOrderItemId } = req.body as {
      name: string;
      dateFrom?: string;
      dateTo?: string;
      costingParams?: CostingParams;
      purchaseOrderItemId?: string;
    };

    let poItem: { productName: string; quantity: number; unit: string; productType: "EXISTING" | "NEW" } | null = null;
    if (purchaseOrderItemId) {
      poItem = await prisma.purchaseOrderItem.findUnique({ where: { id: purchaseOrderItemId }, select: { productName: true, quantity: true, unit: true, productType: true } });
      if (!poItem) return res.status(400).json({ error: "Unknown purchase order item" });
    }

    const resolvedCostingParams = (costingParams ?? defaultCostingParams) as CostingParams;
    const plan = await prisma.rmPlan.create({
      data: {
        name,
        dateFrom: dateFrom ? new Date(dateFrom) : null,
        dateTo: dateTo ? new Date(dateTo) : null,
        costingParams: resolvedCostingParams as unknown as Prisma.InputJsonValue,
        createdById: req.user!.id,
        purchaseOrderItemId: purchaseOrderItemId ?? null,
      },
      include: planInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "rm_plan.created", entityType: "RmPlan", entityId: plan.id });

    // "Generate" on the PO detail page — one click, both engines. Same
    // auto-match reasoning as bom-plan.routes.ts's POST /plans: if the
    // PO product's name matches exactly one Recipe, queue it (batch size
    // = the PO line's own quantity, in Kg) and calculate immediately so
    // this comes back already CALCULATED. No/ambiguous match falls back
    // to today's empty-Draft behavior. Also requires the PO line's unit
    // to actually be Kg — a batch size only makes sense in Kg, and a PO
    // quantity recorded in "SKU" (pack count) or anything else isn't a
    // batch size at all; auto-calculating against it would silently
    // produce a nonsense number (a "500-SKU" line treated as a 500 Kg
    // batch). Safer to leave those as an empty Draft for a human to size
    // correctly than to hand back a confidently wrong total.
    // productType NEW — same short-circuit as bom-plan.routes.ts's own:
    // the gap is already known, so raise (or hand back the already-open)
    // RecipeRequest immediately instead of attempting a match that can't
    // succeed.
    if (poItem && poItem.productType === "NEW") {
      await ensureRecipeRequest(purchaseOrderItemId!, req.user!.id);
    }

    const isKgUnit = poItem ? /^kgs?$/i.test(poItem.unit.trim()) : false;
    if (poItem && poItem.productType !== "NEW" && isKgUnit) {
      const candidates = await prisma.recipe.findMany({ where: { name: { equals: poItem.productName, mode: "insensitive" } } });
      const realMatch = candidates.length === 1 && poItem.quantity > 0 && candidates[0]!.totalServing > 0 ? candidates[0]! : null;
      if (realMatch) {
        const recipe = realMatch;
        await prisma.rmPlanItem.create({ data: { planId: plan.id, recipeId: recipe.id, batchSizeKg: poItem.quantity, addedById: req.user!.id } });

        const ingredients = await prisma.recipeIngredient.findMany({ where: { recipeId: recipe.id }, orderBy: { sortOrder: "asc" } });
        const inputs: RmBatchLineInput[] = [
          {
            batchSizeKg: poItem.quantity,
            recipe: {
              name: recipe.name,
              totalServing: recipe.totalServing,
              ingredients: ingredients.map((ing) => ({ name: ing.name, brand: ing.brand, costPerKg: ing.costPerKg, gPerServing: ing.gPerServing, proteinPct: ing.proteinPct })),
            },
          },
        ];
        const result = calculateMasterRMBOM(inputs, resolvedCostingParams);

        await prisma.rmPlan.update({
          where: { id: plan.id },
          data: { status: "CALCULATED", calculatedAt: new Date(), resultSnapshot: result as unknown as Prisma.InputJsonValue },
        });
        await recordAudit({
          actorId: req.user!.id,
          action: "rm_plan.calculated",
          entityType: "RmPlan",
          entityId: plan.id,
          metadata: { batchCount: result.batches.length, autoGenerated: true },
        });
      } else {
        // No real match — auto-raise the request instead of waiting on
        // PPIC's own manual "Request from R&D" click, same as BOM's own
        // Generate now does. Not fired at all when the unit isn't Kg —
        // RM Costing was never going to apply here regardless of the
        // catalog, so there's nothing for R&D to be asked for.
        await ensureRecipeRequest(purchaseOrderItemId!, req.user!.id);
      }
    }

    const finalPlan = await prisma.rmPlan.findUniqueOrThrow({ where: { id: plan.id }, include: planInclude });
    const suggestions = finalPlan.items.length === 0 && poItem?.productType !== "NEW" ? await findRecipeSuggestions(poItem) : undefined;
    res.status(201).json(serializePlan(finalPlan, suggestions));
  } catch (err) {
    next(err);
  }
});

rmPlanRouter.get("/plans/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const plan = await prisma.rmPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    const poItem = plan.purchaseOrderItemId
      ? await prisma.purchaseOrderItem.findUnique({ where: { id: plan.purchaseOrderItemId }, select: { productName: true, quantity: true, productType: true } })
      : null;
    const suggestions = plan.items.length === 0 && poItem?.productType !== "NEW" ? await findRecipeSuggestions(poItem) : undefined;
    res.json(serializePlan(plan, suggestions));
  } catch (err) {
    next(err);
  }
});

// Updating the shared costing profile invalidates any prior calculation,
// same as adding/removing a queued batch. R&D-only — the costing profile
// (mfg loss %, jar/scoop/label/testing costs, ...) reflects the real
// manufacturing/packaging costs the same way a Recipe's formulation does,
// so it's R&D's call, not PPIC's — same split as catalog/recipe import.
rmPlanRouter.patch(
  "/plans/:id/costing",
  requireRole("RND"),
  validateBody(updateCostingParamsSchema),
  async (req: AuthedRequest<{ id: string }>, res, next) => {
    try {
      const plan = await prisma.rmPlan.findUnique({ where: { id: req.params.id } });
      if (!plan) return res.status(404).json({ error: "Plan not found" });

      const { costingParams } = req.body as { costingParams: CostingParams };
      const updated = await prisma.rmPlan.update({
        where: { id: plan.id },
        data: { costingParams: costingParams as unknown as Prisma.InputJsonValue, status: "DRAFT", resultSnapshot: Prisma.JsonNull },
        include: planInclude,
      });
      res.json(serializePlan(updated));
    } catch (err) {
      next(err);
    }
  },
);

rmPlanRouter.post(
  "/plans/:id/items",
  validateBody(addRmPlanItemSchema),
  async (req: AuthedRequest<{ id: string }>, res, next) => {
    try {
      const plan = await prisma.rmPlan.findUnique({ where: { id: req.params.id } });
      if (!plan) return res.status(404).json({ error: "Plan not found" });

      const { recipeId, batchSizeKg } = req.body as { recipeId: string; batchSizeKg: number };
      const recipe = await prisma.recipe.findUnique({ where: { id: recipeId } });
      if (!recipe) return res.status(400).json({ error: "Unknown recipe" });

      await prisma.rmPlanItem.create({
        data: { planId: plan.id, recipeId, batchSizeKg, addedById: req.user!.id },
      });

      // Adding to the queue invalidates any prior calculation for this plan.
      await prisma.rmPlan.update({ where: { id: plan.id }, data: { status: "DRAFT", resultSnapshot: Prisma.JsonNull } });

      const updated = await prisma.rmPlan.findUniqueOrThrow({ where: { id: plan.id }, include: planInclude });
      res.status(201).json(serializePlan(updated));
    } catch (err) {
      next(err);
    }
  },
);

rmPlanRouter.delete(
  "/plans/:id/items/:itemId",
  async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
    try {
      await prisma.rmPlanItem.updateMany({
        where: { id: req.params.itemId, planId: req.params.id, deletedAt: null },
        data: { deletedAt: new Date(), deletedById: req.user!.id },
      });
      // Removing a batch invalidates any prior calculation for this plan —
      // same rule POST /items already applies, previously missing here,
      // which left a stale resultSnapshot (for batches no longer queued)
      // sitting under a still-"CALCULATED" status.
      await prisma.rmPlan.updateMany({ where: { id: req.params.id }, data: { status: "DRAFT", resultSnapshot: Prisma.JsonNull } });
      const updated = await prisma.rmPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
      if (!updated) return res.status(404).json({ error: "Plan not found" });
      res.json(serializePlan(updated));
    } catch (err) {
      next(err);
    }
  },
);

// The server-side equivalent of the prototype's "Run Micro-Level
// Aggregation" button — runs the same pure engine, but persists the result
// instead of holding it only in one browser tab's memory.
rmPlanRouter.post("/plans/:id/calculate", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const plan = await prisma.rmPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    if (plan.items.length === 0) return res.status(400).json({ error: "Plan has no queued batches" });

    for (const item of plan.items) {
      if (item.recipe.totalServing <= 0) {
        return res.status(400).json({ error: `Recipe "${item.recipe.name}" has no ingredients to scale` });
      }
    }

    const recipeIngredients = await prisma.recipeIngredient.findMany({
      where: { recipeId: { in: plan.items.map((i) => i.recipe.id) } },
      orderBy: { sortOrder: "asc" },
    });
    const ingredientsByRecipe = new Map<string, typeof recipeIngredients>();
    for (const ing of recipeIngredients) {
      const list = ingredientsByRecipe.get(ing.recipeId) ?? [];
      list.push(ing);
      ingredientsByRecipe.set(ing.recipeId, list);
    }

    const inputs: RmBatchLineInput[] = plan.items.map((item) => ({
      batchSizeKg: item.batchSizeKg,
      recipe: {
        name: item.recipe.name,
        totalServing: item.recipe.totalServing,
        ingredients: (ingredientsByRecipe.get(item.recipe.id) ?? []).map((ing) => ({
          name: ing.name,
          brand: ing.brand,
          costPerKg: ing.costPerKg,
          gPerServing: ing.gPerServing,
          proteinPct: ing.proteinPct,
        })),
      },
    }));

    const result = calculateMasterRMBOM(inputs, plan.costingParams as unknown as CostingParams);

    const updated = await prisma.rmPlan.update({
      where: { id: plan.id },
      // sentToPreInventoryAt cleared — a recalculation re-opens Send to
      // Pre-Inventory, same reasoning as BomPlan's own calculate route.
      data: { status: "CALCULATED", calculatedAt: new Date(), resultSnapshot: result as unknown as Prisma.InputJsonValue, sentToPreInventoryAt: null },
      include: planInclude,
    });

    await recordAudit({
      actorId: req.user!.id,
      action: "rm_plan.calculated",
      entityType: "RmPlan",
      entityId: plan.id,
      metadata: { batchCount: result.batches.length, procurementLineCount: result.procurement.length },
    });

    res.json({ plan: serializePlan(updated), result });
  } catch (err) {
    next(err);
  }
});

// Turns a calculated RM plan's procurement rollup into Pre-Inventory
// requirements (S1) in one click — one RM requirement per ingredient,
// summed across every batch queued in this plan. PPIC-only, matching
// who's allowed to raise a Pre-Inventory requirement by hand. Every
// procurement line here is already in Kg.
rmPlanRouter.post("/plans/:id/send-to-pre-inventory", requireRole("PPIC"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const plan = await prisma.rmPlan.findUnique({ where: { id: req.params.id } });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    if (!plan.resultSnapshot) return res.status(400).json({ error: "Plan has not been calculated yet — POST /plans/:id/calculate first" });
    // Server-side guard — see BomPlan's identical check for why this
    // can't just be a disabled button on the frontend.
    if (plan.sentToPreInventoryAt) {
      return res.status(400).json({ error: "This plan's result was already sent to Pre-Inventory. Recalculate it first if you need to send an updated result." });
    }

    const result = plan.resultSnapshot as unknown as RmMasterResult;
    const rows: RequirementSourceRow[] = result.procurement
      .filter((line) => line.totalKg > 0)
      .map((line) => ({
        date: new Date(),
        category: "RM",
        itemName: line.name,
        unit: "Kg",
        requiredQty: line.totalKg,
        note: `From RM Plan "${plan.name}"`,
      }));

    if (rows.length === 0) return res.status(400).json({ error: "This plan's calculated result has nothing to send" });

    const outcome = await bulkCreateRequirements(rows, req.user!.id, req);

    // Also feed PO Readiness, and raise this PO's Material Requests, when
    // this plan is linked to a real PO — see createPoMaterialRequirements'
    // and createMaterialRequestsFromPlan's own comments for why.
    let poReadiness: { rowsCreated: number; itemsCreated: number } | null = null;
    let materialRequests: { rowsCreated: number } | null = null;
    if (plan.purchaseOrderItemId) {
      const poItem = await prisma.purchaseOrderItem.findUnique({
        where: { id: plan.purchaseOrderItemId },
        select: { purchaseOrderId: true, purchaseOrder: { select: { poNumber: true } } },
      });
      if (poItem) {
        poReadiness = await createPoMaterialRequirements(
          poItem.purchaseOrderId,
          rows.map((r) => ({ category: r.category, itemName: r.itemName, unit: r.unit, requiredQty: r.requiredQty })),
          req.user!.id,
        );
        materialRequests = await createMaterialRequestsFromPlan(
          rows.map((r) => ({ category: r.category, itemName: r.itemName, requiredQty: r.requiredQty })),
          req.user!.id,
          `Auto-raised from RM Plan "${plan.name}" for PO ${poItem.purchaseOrder.poNumber ?? poItem.purchaseOrderId.slice(0, 8)}`,
        );
      }
    }

    await prisma.rmPlan.update({ where: { id: plan.id }, data: { sentToPreInventoryAt: new Date() } });

    await recordAudit({
      actorId: req.user!.id,
      action: "rm_plan.sent_to_pre_inventory",
      entityType: "RmPlan",
      entityId: plan.id,
      metadata: { ...outcome, poReadiness, materialRequests },
    });

    res.status(201).json({ ...outcome, poReadiness, materialRequests });
  } catch (err) {
    next(err);
  }
});

rmPlanRouter.get("/plans/:id/export.xlsx", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const plan = await prisma.rmPlan.findUnique({ where: { id: req.params.id } });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    if (!plan.resultSnapshot) {
      return res.status(400).json({ error: "Plan has not been calculated yet — POST /plans/:id/calculate first" });
    }

    const buffer = await buildRmMasterWorkbook(plan.resultSnapshot as never);

    await recordAudit({ actorId: req.user!.id, action: "rm_plan.exported_excel", entityType: "RmPlan", entityId: plan.id });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="FLS_RM_Costing_${plan.id}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
});

rmPlanRouter.get("/plans/:id/export.pdf", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const plan = await prisma.rmPlan.findUnique({ where: { id: req.params.id } });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    if (!plan.resultSnapshot) {
      return res.status(400).json({ error: "Plan has not been calculated yet — POST /plans/:id/calculate first" });
    }

    const { procurement } = plan.resultSnapshot as never as { procurement: unknown[] };
    const doc = buildMasterProcurementPdf(procurement as never, {
      planName: plan.name,
      dateFrom: plan.dateFrom?.toISOString().slice(0, 10),
      dateTo: plan.dateTo?.toISOString().slice(0, 10),
    });

    await recordAudit({ actorId: req.user!.id, action: "rm_plan.exported_pdf", entityType: "RmPlan", entityId: plan.id });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="FLS_RM_Master_Procurement_${plan.id}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    next(err);
  }
});

// Per-batch "Bill of Material (RM)" dispensing sheet, the server-side
// equivalent of the prototype's printIndividualBMR(). Uses the last
// calculated snapshot so the printed sheet matches what was actually
// costed, not a fresh (possibly stale) re-scale.
rmPlanRouter.get(
  "/plans/:id/items/:itemId/dispensing.pdf",
  async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
    try {
      const plan = await prisma.rmPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
      if (!plan) return res.status(404).json({ error: "Plan not found" });
      if (!plan.resultSnapshot) {
        return res.status(400).json({ error: "Plan has not been calculated yet — POST /plans/:id/calculate first" });
      }

      const item = plan.items.find((i) => i.id === req.params.itemId);
      if (!item) return res.status(404).json({ error: "Plan item not found" });

      const { batches } = plan.resultSnapshot as never as { batches: { recipeName: string }[] };
      const batch = batches.find((b) => b.recipeName === item.recipe.name);
      if (!batch) return res.status(404).json({ error: "Batch not found in last calculated result" });

      const doc = buildBatchDispensingPdf(batch as never);

      await recordAudit({
        actorId: req.user!.id,
        action: "rm_plan.exported_dispensing_pdf",
        entityType: "RmPlanItem",
        entityId: item.id,
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="FLS_BMR_${item.recipe.name.replace(/[^a-zA-Z0-9]/g, "_")}.pdf"`);
      doc.pipe(res);
      doc.end();
    } catch (err) {
      next(err);
    }
  },
);
