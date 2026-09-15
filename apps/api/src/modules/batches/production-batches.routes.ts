import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { productionBatchInclude, serializeProductionBatch, type ProductionBatchWithRelations } from "./batch-include";
import {
  assignBatchNoSchema,
  createProductionBatchSchema,
  productionBatchExecutionSchema,
  productionBatchTransitionEnvelopeSchema,
  type AssignBatchNoInput,
  type CreateProductionBatchInput,
  type ProductionBatchExecutionInput,
} from "./batch.schemas";
import { transitionProductionBatchStage } from "./production-batch-transition";
import type { Prisma } from "@prisma/client";

// --- Tier 2 of the three-tier pipeline (see schema.prisma's own comment
// block above ProductionBatch): the small manufacturing runs a
// PreProduction's material actually gets split across, limited by real
// equipment capacity. Creation/execution here is plain CRUD (just
// IN_PROGRESS -> COMPLETED) — the real pipeline (IPQC through Dispatch
// Plan) is each batch's OWN, handled by production-batch-transition.ts
// once a batch is COMPLETED, not a pooled CombinedLot any more (see that
// model's own comment: "combine" stopped being the model per the
// client — every batch packages, gets QC'd, and dispatches on its own).
// Completing a run (POST /:id/complete) just adds its outputQty to the
// parent PreProduction's running combinedQty — a "how much has this item
// produced so far" figure the remaining-quantity rollup still uses,
// nothing more. ---

export const productionBatchesRouter = Router();

productionBatchesRouter.use(requireAuth);

// Every batch, across every PreProduction, COMPLETED ones only — the
// Dashboard's own "everything currently in a batch's own IPQC-through-
// Dispatch pipeline" queue, same "read access open to any authenticated
// user, not paginated" shape as GET /combined-lots. A still-IN_PROGRESS
// batch has nothing here yet (see transitionProductionBatchStage), so
// it's excluded rather than shown sitting at a stage nobody can act on.
productionBatchesRouter.get("/production-batches", async (_req, res, next) => {
  try {
    const batches = await prisma.productionBatch.findMany({ where: { status: "COMPLETED" }, include: productionBatchInclude, orderBy: { completedAt: "desc" } });
    res.json(batches.map(serializeProductionBatch));
  } catch (err) {
    next(err);
  }
});

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

// Single-run detail fetch — its own Tier-3 pipeline detail page needs a
// clean GET /:id the same shape every other tier in this module has,
// rather than making the frontend dig a batch out of its parent's list.
productionBatchesRouter.get("/production-batches/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await requireBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: "Production run not found" });
    res.json(serializeProductionBatch(batch));
  } catch (err) {
    next(err);
  }
});

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
// meaningful to add to the parent's running total without it.
//
// No longer auto-creates a CombinedLot — per the client, "combine" isn't
// the model any more: every batch packages, gets QC'd, and dispatches on
// its own (see production-batch-transition.ts), so there's nothing left
// to pool into once this batch is done. combinedQty on the parent
// PreProduction keeps incrementing as a running "how much has this item
// produced so far" figure (still used for the remaining-quantity
// rollup), it just never triggers a CombinedLot any more.
// CombinedLot itself is untouched for any lot that already exists from
// before this change — old data still reads and works exactly as it did.
productionBatchesRouter.post("/production-batches/:id/complete", requireRole("PRODUCTION"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await requireBatch(req.params.id);
    if (!existing) return res.status(404).json({ error: "Production run not found" });
    if (existing.status === "COMPLETED") return res.status(409).json({ error: "Already completed." });
    if (existing.outputQty == null) return res.status(400).json({ error: "Record this run's output quantity before completing it." });

    const outputQty = existing.outputQty;
    const batch = await prisma.$transaction(async (tx) => {
      await tx.productionBatch.update({ where: { id: existing.id }, data: { status: "COMPLETED", completedById: req.user!.id, completedAt: new Date() } });
      await tx.preProduction.update({ where: { id: existing.preProductionId }, data: { combinedQty: { increment: outputQty } } });
      return tx.productionBatch.findUniqueOrThrow({ where: { id: existing.id }, include: productionBatchInclude });
    });

    await recordAudit({ actorId: req.user!.id, action: "production_batch.completed", entityType: "ProductionBatch", entityId: existing.id, metadata: { outputQty } });

    res.json({ productionBatch: serializeProductionBatch(batch) });
  } catch (err) {
    next(err);
  }
});

// QC assigns the real batch number — deliberately not Production's call
// any more (see schema.prisma's own comment on ProductionBatch.batchNo).
// Settable any time this run exists, not just once at IPQC — a genuine
// correction later shouldn't be locked out.
productionBatchesRouter.patch("/production-batches/:id/batch-no", requireRole("QA_QC", "RND"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const parsed = assignBatchNoSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { batchNo } = parsed.data as AssignBatchNoInput;

    const existing = await requireBatch(req.params.id);
    if (!existing) return res.status(404).json({ error: "Production run not found" });

    const updated = await prisma.productionBatch.update({ where: { id: existing.id }, data: { batchNo }, include: productionBatchInclude });
    await recordAudit({ actorId: req.user!.id, action: "production_batch.batch_no_assigned", entityType: "ProductionBatch", entityId: updated.id, metadata: { batchNo } });

    res.json(serializeProductionBatch(updated));
  } catch (err) {
    next(err);
  }
});

// This batch's OWN Tier-3 pipeline — IPQC through Dispatch Plan, same
// FORWARD/REJECT shape as CombinedLot's own PATCH /:id/stage (see
// combined-lot.routes.ts), just walked once per batch. Only reachable
// once the run is COMPLETED (see transitionProductionBatchStage) — a
// still-in-progress batch has nothing for QC to check yet.
productionBatchesRouter.patch("/production-batches/:id/stage", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await prisma.productionBatch.findUnique({ where: { id: req.params.id } });
    if (!batch) return res.status(404).json({ error: "Production run not found" });

    const envelope = productionBatchTransitionEnvelopeSchema.safeParse(req.body);
    if (!envelope.success) return res.status(400).json({ error: "Validation failed", details: envelope.error.flatten() });
    const { action, note } = envelope.data;

    const result = await transitionProductionBatchStage({
      batch,
      action,
      note,
      rawBody: req.body as Record<string, unknown>,
      actorId: req.user!.id,
      actorRoles: req.user!.roles,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, ...(result.details !== undefined ? { details: result.details } : {}) });
    }
    res.json(serializeProductionBatch(result.updated));
  } catch (err) {
    next(err);
  }
});
