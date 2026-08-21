import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { addRmPlanItemSchema, costingParamsSchema, createRmPlanSchema, updateCostingParamsSchema } from "./rm-plan.schemas";
import { calculateMasterRMBOM, type CostingParams, type RmBatchLineInput, type RmMasterResult } from "./rm-costing-engine";
import { buildRmMasterWorkbook } from "./rm-export";
import { buildBatchDispensingPdf, buildMasterProcurementPdf } from "./rm-pdf";
import { bulkCreateRequirements, type RequirementSourceRow } from "../inventory/pre-inventory.routes";
import { Prisma } from "@prisma/client";

export const rmPlanRouter = Router();

rmPlanRouter.use(requireAuth);

// Defaults for every field of the costing profile, same values as the
// prototype's costing panel inputs (cost-mfg-loss=3, cost-pack-size=400, ...).
const defaultCostingParams: CostingParams = costingParamsSchema.parse({});

function serializePlan(plan: {
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
  items: { id: string; batchSizeKg: number; recipe: { id: string; name: string; totalServing: number } }[];
  purchaseOrderItemId: string | null;
  purchaseOrderItem: { id: string; productName: string; purchaseOrder: { id: string; poNumber: string | null } } | null;
}) {
  return {
    id: plan.id,
    name: plan.name,
    dateFrom: plan.dateFrom,
    dateTo: plan.dateTo,
    status: plan.status,
    costingParams: plan.costingParams,
    calculatedAt: plan.calculatedAt,
    createdAt: plan.createdAt,
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
  };
}

const planInclude = {
  items: { include: { recipe: true } },
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
    res.json(plans.map(serializePlan));
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

    if (purchaseOrderItemId) {
      const item = await prisma.purchaseOrderItem.findUnique({ where: { id: purchaseOrderItemId } });
      if (!item) return res.status(400).json({ error: "Unknown purchase order item" });
    }

    const plan = await prisma.rmPlan.create({
      data: {
        name,
        dateFrom: dateFrom ? new Date(dateFrom) : null,
        dateTo: dateTo ? new Date(dateTo) : null,
        costingParams: (costingParams ?? defaultCostingParams) as unknown as Prisma.InputJsonValue,
        createdById: req.user!.id,
        purchaseOrderItemId: purchaseOrderItemId ?? null,
      },
      include: planInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "rm_plan.created", entityType: "RmPlan", entityId: plan.id });

    res.status(201).json(serializePlan(plan));
  } catch (err) {
    next(err);
  }
});

rmPlanRouter.get("/plans/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const plan = await prisma.rmPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    res.json(serializePlan(plan));
  } catch (err) {
    next(err);
  }
});

// Updating the shared costing profile invalidates any prior calculation,
// same as adding/removing a queued batch.
rmPlanRouter.patch(
  "/plans/:id/costing",
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
      await prisma.rmPlanItem.deleteMany({ where: { id: req.params.itemId, planId: req.params.id } });
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
      data: { status: "CALCULATED", calculatedAt: new Date(), resultSnapshot: result as unknown as Prisma.InputJsonValue },
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

    await recordAudit({ actorId: req.user!.id, action: "rm_plan.sent_to_pre_inventory", entityType: "RmPlan", entityId: plan.id, metadata: outcome });

    res.status(201).json(outcome);
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
