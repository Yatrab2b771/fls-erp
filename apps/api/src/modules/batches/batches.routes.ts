import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { RouteError } from "../../common/lib/route-error";
import { getOnHandByPlantAndItem } from "../inventory/stock";
import { computeDelay, computeWastage } from "./batch.engine";
import { actorCanActOnStage, BATCH_STAGE_LABEL, BATCH_STAGE_ROLE, getForwardTarget, getRejectTarget } from "./batch-stage";
import { notifyRoles } from "../../common/lib/notify";
import {
  BATCH_STAGE_FIELD_SCHEMA,
  createBatchSchema,
  dispensingConsumptionSchema,
  transitionEnvelopeSchema,
  updateBatchPlantSchema,
  type CreateBatchInput,
  type UpdateBatchPlantInput,
} from "./batch.schemas";
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
  plant: true,
  consumptions: {
    include: { item: true, createdBy: { select: { fullName: true, email: true } } },
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
  plant: { id: string; name: string } | null;
  consumptions: {
    id: string;
    itemId: string;
    quantity: number;
    unit: string;
    createdAt: Date;
    item: { id: string; category: string; name: string; unit: string | null };
    createdBy: { fullName: string; email: string };
  }[];
};

export function serializeBatch(batch: BatchWithRelations) {
  return {
    ...batch,
    delay: computeDelay(batch),
    wastage: computeWastage(batch),
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
    const { purchaseOrderItemId, batchNo, plantId } = parsed.data as CreateBatchInput;

    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: purchaseOrderItemId }, include: { purchaseOrder: { select: { status: true } } } });
    if (!item) return res.status(400).json({ error: "Unknown purchase order item" });
    if (item.purchaseOrder.status !== "APPROVED") {
      return res.status(400).json({ error: "This purchase order hasn't been approved yet — BD must approve it before a batch can be released against it." });
    }
    if (plantId && !(await prisma.plant.findUnique({ where: { id: plantId } }))) {
      return res.status(400).json({ error: "Unknown Plant" });
    }

    const batch = await prisma.batch.create({
      data: { purchaseOrderItemId, batchNo, plantId },
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

// Assign/change which Plant a batch runs at — not a stage transition,
// just metadata PPIC can fix any time (e.g. the batch was created before
// a Plant was picked, or it turns out wrong). PPIC owns batch scheduling
// the same way it owns creating the batch in the first place.
batchesRouter.patch("/:id/plant", requireRole("PPIC"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const parsed = updateBatchPlantSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { plantId } = parsed.data as UpdateBatchPlantInput;

    const existing = await prisma.batch.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Batch not found" });
    if (plantId && !(await prisma.plant.findUnique({ where: { id: plantId } }))) {
      return res.status(400).json({ error: "Unknown Plant" });
    }

    // BatchMaterialConsumption rows don't record their own plant — they're
    // joined to one through this very field (see stock.ts
    // getOnHandByPlantAndItem's `batch: { plantId }` filter). Changing it
    // after real consumption has already been logged would silently
    // rewrite which Plant's balance that consumption counts against:
    // the old Plant's balance would jump back up (usage that really
    // happened there no longer counted), and the new Plant's balance
    // would drop by the same amount for material it never actually
    // issued — or, if cleared to null, the consumption would stop
    // counting against any Plant at all. None of that reflects anything
    // that happened physically, so once Dispensing has logged real
    // usage, the Plant is locked in.
    if (existing.plantId !== plantId) {
      const consumptionCount = await prisma.batchMaterialConsumption.count({ where: { batchId: existing.id } });
      if (consumptionCount > 0) {
        return res.status(409).json({ error: "This batch already has RM/PM consumption logged against its current Plant — the Plant can't be changed once Dispensing has recorded real usage." });
      }
    }

    const batch = await prisma.batch.update({ where: { id: existing.id }, data: { plantId }, include: batchInclude });
    await recordAudit({ actorId: req.user!.id, action: "batch.plant_assigned", entityType: "Batch", entityId: batch.id, metadata: { plantId } });

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
      if (targetStageId !== currentStage) {
        const label = updated.batchNo ?? `Batch ${updated.id.slice(0, 8)}`;
        await notifyRoles(
          [BATCH_STAGE_ROLE[targetStageId]],
          { title: `${label} moved to ${BATCH_STAGE_LABEL[targetStageId]}`, body: `${updated.purchaseOrderItem.productName} — moved by an admin.`, link: `/batches/${updated.id}` },
          req.user!.id,
        ).catch((err) => req.log?.error({ err }, "notify failed: batch.stage_jumped"));
      }
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

    // Real RM/PM consumption lines — Dispensing only, optional (a batch
    // can still move through Dispensing with just the date/remark
    // fields, same as before this existed). Reduces the batch's Plant's
    // real-time balance (see stock.ts getOnHandByPlantAndItem), so it
    // needs a Plant assigned first — there's no sane default to charge
    // material against.
    const parsedConsumption = dispensingConsumptionSchema.safeParse((req.body as Record<string, unknown>).consumption);
    if (!parsedConsumption.success) return res.status(400).json({ error: "Validation failed", details: parsedConsumption.error.flatten() });
    const consumption = currentStage === "DISPENSING" ? (parsedConsumption.data ?? []) : [];
    if (consumption.length > 0) {
      if (!batch.plantId) {
        return res.status(400).json({ error: "Assign a Plant to this batch before logging RM/PM consumption — see the Plant field above." });
      }
      const itemIds = [...new Set(consumption.map((c) => c.itemId))];
      const foundItems = await prisma.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true } });
      if (foundItems.length !== itemIds.length) {
        return res.status(400).json({ error: "One or more consumption lines reference an unknown item." });
      }
    }

    // Same shape as every other stock-consuming write in this app (see
    // inventory.routes.ts): the check against what's actually on the
    // Plant's shelf and the write that depends on it run inside one
    // SERIALIZABLE transaction, not two separate round-trips — otherwise
    // two Dispensing submissions against the same Plant/item at once
    // could each read a stale balance and jointly consume more than was
    // ever issued there. Only worth the extra isolation when there's
    // actually a balance to protect; a stage move with no consumption
    // lines uses the plain transaction as before.
    const txFn = async (tx: Prisma.TransactionClient) => {
      if (consumption.length > 0) {
        // The per-department consumption gate: logging more RM/PM usage
        // than this Plant has actually received would silently send its
        // real-time balance negative — the same class of bug as issuing
        // more stock than a Warehouse/Store has on hand, just reached
        // through the Batch pipeline instead of the Inventory ledger.
        const requestedByItem = new Map<string, number>();
        for (const c of consumption) requestedByItem.set(c.itemId, (requestedByItem.get(c.itemId) ?? 0) + c.quantity);
        const onHand = await getOnHandByPlantAndItem(batch.plantId!, [...requestedByItem.keys()], tx);
        const shortfalls = [...requestedByItem.entries()]
          .map(([itemId, requestedQty]) => ({ itemId, requestedQty, available: onHand.get(itemId) ?? 0 }))
          .filter((s) => s.requestedQty > s.available);
        if (shortfalls.length > 0) {
          const items = await tx.inventoryItem.findMany({ where: { id: { in: shortfalls.map((s) => s.itemId) } }, select: { id: true, name: true } });
          const nameById = new Map(items.map((i) => [i.id, i.name]));
          throw new RouteError(
            409,
            `This Plant hasn't received enough to cover that: ${shortfalls.map((s) => `${nameById.get(s.itemId)} (needs ${s.requestedQty}, only ${s.available} on hand)`).join("; ")}`,
          );
        }
      }

      await tx.batch.update({ where: { id: batch.id }, data: { ...(fieldData as Prisma.BatchUpdateInput), currentStageId: target } });
      if (consumption.length > 0) {
        await tx.batchMaterialConsumption.createMany({
          data: consumption.map((c) => ({ batchId: batch.id, itemId: c.itemId, quantity: c.quantity, unit: c.unit, createdById: req.user!.id })),
        });
      }
      await tx.batchStageEvent.create({
        data: { batchId: batch.id, fromStageId: currentStage, toStageId: target, action, note: note ?? null, actorId: req.user!.id },
      });
      return tx.batch.findUniqueOrThrow({ where: { id: batch.id }, include: batchInclude });
    };
    const updated = consumption.length > 0 ? await runSerializable(txFn) : await prisma.$transaction(txFn);

    await recordAudit({
      actorId: req.user!.id,
      action: action === "FORWARD" ? "batch.stage_forwarded" : "batch.stage_rejected",
      entityType: "Batch",
      entityId: batch.id,
      metadata: { from: currentStage, to: target, consumptionLines: consumption.length || undefined },
    });

    // Only a real stage change is worth a notice — DISPATCH_PLAN forwards
    // to itself (terminal, "completes in place"), so repeated saves there
    // would otherwise re-notify Dispatch on every edit.
    if (target !== currentStage) {
      const label = updated.batchNo ?? `Batch ${updated.id.slice(0, 8)}`;
      const productName = updated.purchaseOrderItem.productName;
      await notifyRoles(
        [BATCH_STAGE_ROLE[target]],
        {
          title: `${label} is now at ${BATCH_STAGE_LABEL[target]}`,
          body: `${productName}${action === "REJECT" ? ` — sent back: ${note}` : ""}`,
          link: `/batches/${updated.id}`,
        },
        req.user!.id,
      ).catch((err) => req.log?.error({ err }, "notify failed: batch.stage_changed"));
    }

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
