import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { notifyRoles } from "../../common/lib/notify";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { productionBatchInclude, serializeProductionBatch, combinedLotInclude, serializeCombinedLot, type ProductionBatchWithRelations } from "./batch-include";
import { createProductionBatchSchema, productionBatchExecutionSchema, type CreateProductionBatchInput, type ProductionBatchExecutionInput } from "./batch.schemas";
import { COMBINED_LOT_STAGE_ROLE } from "./combined-lot-stage";
import type { Prisma } from "@prisma/client";

// --- Tier 2 of the three-tier pipeline (see schema.prisma's own comment
// block above ProductionBatch): the small manufacturing runs a
// PreProduction's material actually gets split across, limited by real
// equipment capacity. No stage machine of its own — just IN_PROGRESS ->
// COMPLETED — so this module is plain CRUD, not a transition endpoint.
//
// Completing a run (POST /:id/complete) is the one action with real
// side effects: it adds this run's own outputQty to the parent
// PreProduction's running combinedQty, and — the moment that running
// total actually reaches the parent's plannedQty, i.e. every planned
// run has now pooled in — creates the CombinedLot (Tier 3) that
// everything from IPQC onward happens against exactly once. This is the
// "automatic, incremental combine + running remaining-quantity tracking"
// the client asked for, replacing the old single-Batch model's implicit
// per-batch pipeline. ---

export const productionBatchesRouter = Router();

productionBatchesRouter.use(requireAuth);

async function requirePreProduction(preProductionId: string) {
  return prisma.preProduction.findUnique({
    where: { id: preProductionId },
    select: { id: true, plannedQty: true, combinedQty: true, currentStageId: true, sampleQcStatus: true, combinedLot: { select: { id: true } } },
  });
}

// Every small manufacturing run against one PreProduction — Production
// creates these as capacity allows; read access open to any
// authenticated user, same as the rest of the pipeline.
productionBatchesRouter.get("/pre-productions/:preProductionId/production-batches", async (req: AuthedRequest<{ preProductionId: string }>, res, next) => {
  try {
    const runs = await prisma.productionBatch.findMany({
      where: { preProductionId: req.params.preProductionId },
      include: productionBatchInclude,
      orderBy: { createdAt: "asc" },
    });
    res.json(runs.map(serializeProductionBatch));
  } catch (err) {
    next(err);
  }
});

// Starting a new manufacturing run — Production's call, same as the old
// single-Batch model's creation, just scoped one tier down. Only
// available once the parent PreProduction has actually cleared Sample QC
// Approval (its own terminal stage) — manufacturing can't start on
// material that hasn't been approved yet — and only while there's still
// unplanned quantity left (plannedQty - combinedQty), so the sum of
// every run's own plannedQty can't silently exceed what the parent run
// was ever meant to produce.
productionBatchesRouter.post("/pre-productions/:preProductionId/production-batches", requireRole("PRODUCTION"), async (req: AuthedRequest<{ preProductionId: string }>, res, next) => {
  try {
    const parsed = createProductionBatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { batchNo, plannedQty } = parsed.data as CreateProductionBatchInput;

    const preProduction = await requirePreProduction(req.params.preProductionId);
    if (!preProduction) return res.status(404).json({ error: "Pre-production run not found" });
    // Sample QC Approval completes in place (see pre-production-stage.ts)
    // — currentStageId alone can't tell "sitting here, not yet reviewed"
    // from "actually Approved", so the literal status is what really
    // gates this, same hard-gate rule the stage itself enforces.
    if (preProduction.currentStageId !== "SAMPLE_QC_APPROVAL" || preProduction.sampleQcStatus !== "Approved") {
      return res.status(400).json({ error: "Production can only start once this run's Sample QC Approval has actually been set to Approved." });
    }
    if (preProduction.combinedLot) {
      return res.status(409).json({ error: "This run has already fully combined into a lot — nothing left to plan." });
    }

    // Only IN_PROGRESS runs' plannedQty count as "still outstanding" here —
    // a COMPLETED run's own plannedQty already spent itself into
    // combinedQty above (see POST /:id/complete), so counting it again
    // here would double-subtract it from what's left to plan.
    const existingBatches = await prisma.productionBatch.aggregate({ where: { preProductionId: preProduction.id, status: "IN_PROGRESS" }, _sum: { plannedQty: true } });
    const alreadyPlanned = existingBatches._sum.plannedQty ?? 0;
    const remaining = preProduction.plannedQty - preProduction.combinedQty - alreadyPlanned;
    if (plannedQty > remaining + 1e-6) {
      return res.status(400).json({ error: `Only ${Math.max(0, Math.round(remaining * 1000) / 1000)} left unplanned on this run — reduce the planned quantity.` });
    }

    const batch = await prisma.productionBatch.create({
      data: { preProductionId: preProduction.id, batchNo, plannedQty, createdById: req.user!.id },
      include: productionBatchInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "production_batch.created", entityType: "ProductionBatch", entityId: batch.id });

    res.status(201).json(serializeProductionBatch(batch));
  } catch (err) {
    next(err);
  }
});

async function requireBatch(id: string): Promise<ProductionBatchWithRelations | null> {
  return prisma.productionBatch.findUnique({ where: { id }, include: productionBatchInclude });
}

// Save this run's own execution fields — dates/status/remarks, input and
// output quantities. Doesn't itself complete the run (see POST
// /:id/complete below) — same "save everything, don't force it all at
// once" shape the rest of this pipeline uses, so Production can fill
// this in incrementally as manufacturing actually happens.
productionBatchesRouter.patch("/production-batches/:id", requireRole("PRODUCTION"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const parsed = productionBatchExecutionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const data = parsed.data as ProductionBatchExecutionInput;

    const existing = await requireBatch(req.params.id);
    if (!existing) return res.status(404).json({ error: "Production run not found" });
    if (existing.status === "COMPLETED") return res.status(409).json({ error: "This run has already been completed and can no longer be edited." });

    const updated = await prisma.productionBatch.update({ where: { id: existing.id }, data: data as Prisma.ProductionBatchUpdateInput, include: productionBatchInclude });
    await recordAudit({ actorId: req.user!.id, action: "production_batch.updated", entityType: "ProductionBatch", entityId: updated.id });

    res.json(serializeProductionBatch(updated));
  } catch (err) {
    next(err);
  }
});

// The one action with real side effects: marks this run COMPLETED, adds
// its outputQty to the parent PreProduction's running combinedQty, and —
// only once that running total actually reaches the parent's plannedQty
// — creates the CombinedLot every downstream stage (IPQC onward) happens
// against. Requires outputQty to already be recorded; there's nothing
// meaningful to pool into the parent without it. Runs inside a
// SERIALIZABLE transaction: several small runs can complete around the
// same moment, and only the one that actually pushes combinedQty over
// plannedQty should be the one that creates the lot.
productionBatchesRouter.post("/production-batches/:id/complete", requireRole("PRODUCTION"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await requireBatch(req.params.id);
    if (!existing) return res.status(404).json({ error: "Production run not found" });
    if (existing.status === "COMPLETED") return res.status(409).json({ error: "Already completed." });
    if (existing.outputQty == null) return res.status(400).json({ error: "Record this run's output quantity before completing it." });

    const outputQty = existing.outputQty;
    const result = await runSerializable(async (tx) => {
      await tx.productionBatch.update({ where: { id: existing.id }, data: { status: "COMPLETED", completedById: req.user!.id, completedAt: new Date() } });

      const preProduction = await tx.preProduction.update({
        where: { id: existing.preProductionId },
        data: { combinedQty: { increment: outputQty } },
      });

      let combinedLot = null;
      if (preProduction.combinedQty >= preProduction.plannedQty - 1e-6) {
        const alreadyLot = await tx.combinedLot.findUnique({ where: { preProductionId: preProduction.id } });
        if (!alreadyLot) {
          combinedLot = await tx.combinedLot.create({ data: { preProductionId: preProduction.id }, include: combinedLotInclude });
        }
      }

      const batch = await tx.productionBatch.findUniqueOrThrow({ where: { id: existing.id }, include: productionBatchInclude });
      return { batch, combinedLot };
    });

    await recordAudit({ actorId: req.user!.id, action: "production_batch.completed", entityType: "ProductionBatch", entityId: existing.id, metadata: { outputQty, combinedLotCreated: result.combinedLot != null } });

    if (result.combinedLot) {
      await recordAudit({ actorId: req.user!.id, action: "combined_lot.created", entityType: "CombinedLot", entityId: result.combinedLot.id });
      const productName = result.combinedLot.preProduction.purchaseOrderItem.productName;
      await notifyRoles(
        COMBINED_LOT_STAGE_ROLE.IPQC,
        { title: `${productName} — fully combined`, body: "Every planned production run has pooled in — ready for IPQC.", link: `/combined-lots/${result.combinedLot.id}` },
        req.user!.id,
      ).catch((err) => req.log?.error({ err }, "notify failed: production_batch.completed"));
    }

    res.json({ productionBatch: serializeProductionBatch(result.batch), combinedLot: result.combinedLot ? serializeCombinedLot(result.combinedLot) : null });
  } catch (err) {
    next(err);
  }
});
