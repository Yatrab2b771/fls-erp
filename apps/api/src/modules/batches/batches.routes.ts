import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { computeDelay } from "./batch.engine";
import { actorCanActOnStage, getForwardTarget, getRejectTarget } from "./batch-stage";
import { BATCH_STAGE_FIELD_SCHEMA, createBatchSchema, transitionEnvelopeSchema, type CreateBatchInput } from "./batch.schemas";
import { buildBatchReportPdf } from "./batch-report-pdf";
import type { Batch, Prisma } from "@prisma/client";

export const batchesRouter = Router();

batchesRouter.use(requireAuth);

// Exported so other modules that reference a Batch (exports/PDFs, etc.)
// can reuse this include/shape instead of duplicating it.
export const batchInclude = {
  purchaseOrderItem: {
    select: {
      id: true,
      productName: true,
      quantity: true,
      unit: true,
      purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { id: true, companyName: true } } } },
    },
  },
  stageEvents: {
    include: { actor: { select: { fullName: true, email: true } } },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.BatchInclude;

export type BatchWithRelations = Batch & {
  purchaseOrderItem: {
    id: string;
    productName: string;
    quantity: number;
    unit: string;
    purchaseOrder: { id: string; poNumber: string | null; customer: { id: string; companyName: string } };
  };
  stageEvents: {
    id: string;
    fromStageId: string;
    toStageId: string;
    action: string;
    note: string | null;
    actorId: string;
    actor: { fullName: string; email: string };
    createdAt: Date;
  }[];
};

export function serializeBatch(batch: BatchWithRelations) {
  return {
    ...batch,
    delay: computeDelay(batch),
    stageEvents: batch.stageEvents.map((e) => ({
      id: e.id,
      fromStageId: e.fromStageId,
      toStageId: e.toStageId,
      action: e.action,
      note: e.note,
      actorId: e.actorId,
      actorName: e.actor.fullName || e.actor.email,
      createdAt: e.createdAt,
    })),
  };
}

// Every department needs to see the batch board and every batch's current
// status — read access is open to any authenticated user; only acting on
// the current stage is role-gated below.
batchesRouter.get("/", async (req, res, next) => {
  try {
    const pagination = parsePagination(req);
    const where: Prisma.BatchWhereInput = {};
    if (typeof req.query.purchaseOrderItemId === "string") where.purchaseOrderItemId = req.query.purchaseOrderItemId;

    const [total, batches] = await Promise.all([
      prisma.batch.count({ where }),
      prisma.batch.findMany({ where, include: batchInclude, orderBy: { createdAt: "desc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(batches.map(serializeBatch));
  } catch (err) {
    next(err);
  }
});

// PPIC owns production scheduling — deciding a batch needs to run against
// a PO line item is theirs. The batch then starts life at PO_RELEASE for
// Purchase to act on.
batchesRouter.post("/", requireRole("PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = createBatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { purchaseOrderItemId, batchNo } = parsed.data as CreateBatchInput;

    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: purchaseOrderItemId }, include: { purchaseOrder: { select: { status: true } } } });
    if (!item) return res.status(400).json({ error: "Unknown purchase order item" });
    if (item.purchaseOrder.status !== "APPROVED") {
      return res.status(400).json({ error: "This purchase order hasn't been approved yet — BD must approve it before a batch can be released against it." });
    }

    const batch = await prisma.batch.create({
      data: { purchaseOrderItemId, batchNo },
      include: batchInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "batch.created", entityType: "Batch", entityId: batch.id });

    res.status(201).json(serializeBatch(batch));
  } catch (err) {
    next(err);
  }
});

batchesRouter.get("/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await prisma.batch.findUnique({ where: { id: req.params.id }, include: batchInclude });
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    res.json(serializeBatch(batch));
  } catch (err) {
    next(err);
  }
});

// The one transition endpoint for the whole pipeline: fill in the current
// stage's fields (if it has any), then either forward it to the next
// stage or send it back — gated to whichever department owns the
// *current* stage, matching the real "if not correct, send it back to the
// previous department" rule you described.
batchesRouter.patch("/:id/stage", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await prisma.batch.findUnique({ where: { id: req.params.id } });
    if (!batch) return res.status(404).json({ error: "Batch not found" });

    const currentStage = batch.currentStageId;

    const envelope = transitionEnvelopeSchema.safeParse(req.body);
    if (!envelope.success) return res.status(400).json({ error: "Validation failed", details: envelope.error.flatten() });
    const { action, note, targetStageId } = envelope.data;

    // Admin override — move the batch straight to any stage, bypassing the
    // normal forward/reject sequence and skipping field validation (the
    // point is to fix a batch stuck in the wrong place, not to fill in
    // that stage's form). Not gated by actorCanActOnStage — JUMP is only
    // ever ADMIN's call, regardless of which department owns the current
    // or target stage.
    if (action === "JUMP") {
      if (!req.user!.roles.includes("ADMIN")) {
        return res.status(403).json({ error: "Only an admin can move a batch directly to another stage." });
      }
      if (!targetStageId) {
        return res.status(400).json({ error: "targetStageId is required for a jump." });
      }
      const updated = await prisma.$transaction(async (tx) => {
        await tx.batch.update({ where: { id: batch.id }, data: { currentStageId: targetStageId } });
        await tx.batchStageEvent.create({
          data: { batchId: batch.id, fromStageId: currentStage, toStageId: targetStageId, action: "JUMP", note: note ?? null, actorId: req.user!.id },
        });
        return tx.batch.findUniqueOrThrow({ where: { id: batch.id }, include: batchInclude });
      });
      await recordAudit({
        actorId: req.user!.id,
        action: "batch.stage_jumped",
        entityType: "Batch",
        entityId: batch.id,
        metadata: { from: currentStage, to: targetStageId },
      });
      return res.json(serializeBatch(updated));
    }

    if (!actorCanActOnStage(currentStage, req.user!.roles)) {
      return res.status(403).json({ error: `This stage requires sign-off from the ${currentStage} department's role` });
    }

    const target = action === "FORWARD" ? getForwardTarget(currentStage) : getRejectTarget(currentStage);
    if (!target) {
      return res.status(400).json({
        error: action === "FORWARD" ? "This batch has already reached the end of the pipeline." : "There's nothing before this stage to send back to.",
      });
    }
    if (action === "REJECT" && !note?.trim()) {
      return res.status(400).json({ error: "A note is required when sending a batch back." });
    }

    // Field validation is separate from the envelope because which
    // fields are allowed depends on the *current* stage.
    const fieldSchema = BATCH_STAGE_FIELD_SCHEMA[currentStage];
    let fieldData: Record<string, unknown> = {};
    if (fieldSchema) {
      const { action: _a, note: _n, ...rest } = req.body as Record<string, unknown>;
      const parsedFields = fieldSchema.safeParse(rest);
      if (!parsedFields.success) return res.status(400).json({ error: "Validation failed", details: parsedFields.error.flatten() });
      fieldData = parsedFields.data;
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.batch.update({ where: { id: batch.id }, data: { ...(fieldData as Prisma.BatchUpdateInput), currentStageId: target } });
      await tx.batchStageEvent.create({
        data: { batchId: batch.id, fromStageId: currentStage, toStageId: target, action, note: note ?? null, actorId: req.user!.id },
      });
      return tx.batch.findUniqueOrThrow({ where: { id: batch.id }, include: batchInclude });
    });

    await recordAudit({
      actorId: req.user!.id,
      action: action === "FORWARD" ? "batch.stage_forwarded" : "batch.stage_rejected",
      entityType: "Batch",
      entityId: batch.id,
      metadata: { from: currentStage, to: target },
    });

    res.json(serializeBatch(updated));
  } catch (err) {
    next(err);
  }
});

// The admin-only "full report" — every field the batch collected across
// its whole lifecycle plus the complete stage history, as one PDF. Only
// makes sense once the batch has actually finished the pipeline, so it's
// gated to Dispatch Plan rather than exportable mid-flight.
batchesRouter.get("/:id/export.pdf", requireRole("ADMIN"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await prisma.batch.findUnique({ where: { id: req.params.id }, include: batchInclude });
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    if (batch.currentStageId !== "DISPATCH_PLAN") {
      return res.status(400).json({ error: "The full report is available once a batch reaches Dispatch Plan." });
    }

    const doc = buildBatchReportPdf(batch);
    await recordAudit({ actorId: req.user!.id, action: "batch.exported_report_pdf", entityType: "Batch", entityId: batch.id });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="FLS_Batch_Report_${batch.batchNo ?? batch.id}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    next(err);
  }
});
