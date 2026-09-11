import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { notifyRoles } from "../../common/lib/notify";
import { getPoReadinessForOne } from "../po-readiness/readiness-engine";
import { getDispensingRequirementStatus } from "./dispensing-requirements";
import { preProductionInclude, serializePreProduction, type PreProductionWithRelations } from "./batch-include";
import { transitionPreProductionStage } from "./pre-production-transition";
import { importBatchStages } from "./batch-import";
import { PRE_PRODUCTION_STAGE_LABEL, PRE_PRODUCTION_STAGE_ROLE } from "./pre-production-stage";
import {
  createPreProductionSchema,
  importBatchStagesSchema,
  checklistUpdateSchema,
  preProductionTransitionEnvelopeSchema,
  updatePreProductionPlantSchema,
  type CreatePreProductionInput,
  type ImportBatchStagesInput,
  type ChecklistUpdateInput,
  type UpdatePreProductionPlantInput,
} from "./batch.schemas";
import { preProductionChecklistKeys } from "./batch-checklists";
import type { Prisma } from "@prisma/client";

// --- Tier 1 of the three-tier pipeline (see schema.prisma's own comment
// block above PreProduction): Material Received through Sample QC
// Approval, one run per PO line item. See production-batches.routes.ts
// for Tier 2 (the small manufacturing runs against this) and
// combined-lot.routes.ts for Tier 3 (the pooled lot they combine into).
// This module is what batches.routes.ts used to be, before the split. ---

export const preProductionRouter = Router();

preProductionRouter.use(requireAuth);

export { preProductionInclude, serializePreProduction, type PreProductionWithRelations };

// Every department needs to see the pipeline board and every run's
// current status — read access is open to any authenticated user; only
// acting on the current stage is role-gated below.
preProductionRouter.get("/", async (req, res, next) => {
  try {
    const pagination = parsePagination(req);
    const where: Prisma.PreProductionWhereInput = {};
    if (typeof req.query.purchaseOrderItemId === "string") where.purchaseOrderItemId = req.query.purchaseOrderItemId;

    const [total, runs] = await Promise.all([
      prisma.preProduction.count({ where }),
      prisma.preProduction.findMany({ where, include: preProductionInclude, orderBy: { createdAt: "desc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(runs.map(serializePreProduction));
  } catch (err) {
    next(err);
  }
});

// PreProduction creation is Production's call, full stop — the client
// was explicit that PPIC should have no part in it, not even a disabled
// button's worth of visibility (see the PO detail page's ProductLineItem,
// which gates the whole "Start Production" section the same way). PPIC
// still owns production scheduling upstream of this (RM/BOM plans, PO
// review) and can see runs once they exist; it just doesn't start one.
// The run then starts life at MATERIAL_RECEIVED. plannedQty is always
// the item's own full ordered quantity — one PreProduction run per item,
// no more per-batch splitting at this tier (see schema.prisma's comment
// on PreProduction.plannedQty for the ProductionBatch-level split that
// replaces it).
preProductionRouter.post("/", requireRole("PRODUCTION"), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = createPreProductionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { purchaseOrderItemId, plantId, confirmNotReady } = parsed.data as CreatePreProductionInput;

    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: purchaseOrderItemId }, include: { purchaseOrder: { select: { id: true, status: true } }, preProduction: true } });
    if (!item) return res.status(400).json({ error: "Unknown purchase order item" });
    if (item.preProduction) return res.status(409).json({ error: "Production has already started on this line item." });
    if (item.purchaseOrder.status !== "APPROVED") {
      return res.status(400).json({ error: "This purchase order hasn't been approved yet — BD must approve it before production can start against it." });
    }
    if (plantId && !(await prisma.plant.findUnique({ where: { id: plantId } }))) {
      return res.status(400).json({ error: "Unknown Plant" });
    }

    // Recipe/BOM hard-block — no override, unlike the PO Readiness check
    // below. A production run can't start without knowing what it's
    // making: if PPIC's own request to R&D for this product's missing
    // Recipe/SKU is still open, the run simply can't be created yet. See
    // recipe-request.routes.ts.
    const openRequest = await prisma.recipeRequest.findFirst({ where: { purchaseOrderItemId, status: { in: ["PENDING", "ETA_GIVEN"] } } });
    if (openRequest) {
      return res.status(400).json({
        error:
          openRequest.status === "ETA_GIVEN" && openRequest.etaDate
            ? `Waiting on R&D for "${openRequest.productName}" — ETA ${new Date(openRequest.etaDate).toLocaleDateString()}. Production can't start until the Recipe/BOM is ready.`
            : `Waiting on R&D for "${openRequest.productName}" — no ETA given yet. Production can't start until the Recipe/BOM is ready.`,
      });
    }

    // PO Readiness soft-block — only when PPIC has actually tracked
    // material requirements for this PO (no rows = nothing to check,
    // same "no data = unrestricted" convention as the rest of this app).
    // A 409 here isn't final: the caller can resend with
    // confirmNotReady: true once they've seen and accepted the shortfall.
    if (!confirmNotReady) {
      const readiness = await getPoReadinessForOne(item.purchaseOrder.id);
      if (readiness && !readiness.isReady) {
        return res.status(409).json({
          error: "This PO isn't showing as material-ready yet — some tracked RM/PM items are short of stock. Confirm again to start production anyway.",
          details: { items: readiness.items.filter((i) => !i.covered) },
        });
      }
    }

    const run = await prisma.preProduction.create({
      data: { purchaseOrderItemId, plantId, plannedQty: item.quantity },
      include: preProductionInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "pre_production.created", entityType: "PreProduction", entityId: run.id });

    res.status(201).json(serializePreProduction(run));
  } catch (err) {
    next(err);
  }
});

// Bulk "forward the current stage" — one row per (PO Number, Product
// Name), each run through the exact same gating a manual Forward uses
// (see batch-import.ts). Open to any authenticated user, same as the
// single endpoint — per-row department RBAC is what actually decides
// whether a given row succeeds.
preProductionRouter.post("/import", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = importBatchStagesSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { rows } = parsed.data as ImportBatchStagesInput;

    const summary = await importBatchStages(rows, req.user!.id, req.user!.roles);
    res.status(201).json(summary);
  } catch (err) {
    next(err);
  }
});

preProductionRouter.get("/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const run = await prisma.preProduction.findUnique({ where: { id: req.params.id }, include: preProductionInclude });
    if (!run) return res.status(404).json({ error: "Pre-production run not found" });
    res.json(serializePreProduction(run));
  } catch (err) {
    next(err);
  }
});

// What this run's product actually needs (per its linked, calculated
// RmPlan/BomPlan) versus what's been logged so far — read access open to
// any authenticated user, same as the run itself, so the Dispensing
// checklist can show Store what's still short *before* they attempt to
// forward, not just after the PATCH /:id/stage gate blocks it.
preProductionRouter.get("/:id/dispensing-requirements", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const run = await prisma.preProduction.findUnique({ where: { id: req.params.id }, select: { id: true, purchaseOrderItemId: true } });
    if (!run) return res.status(404).json({ error: "Pre-production run not found" });
    const items = await getDispensingRequirementStatus(run.id, run.purchaseOrderItemId);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// Assign/change which Plant a run runs at — not a stage transition, just
// metadata PPIC can fix any time (e.g. the run was created before a
// Plant was picked, or it turns out wrong). PPIC owns run scheduling the
// same way it owns assigning a Plant in the first place.
preProductionRouter.patch("/:id/plant", requireRole("PPIC"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const parsed = updatePreProductionPlantSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { plantId } = parsed.data as UpdatePreProductionPlantInput;

    const existing = await prisma.preProduction.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Pre-production run not found" });
    if (plantId && !(await prisma.plant.findUnique({ where: { id: plantId } }))) {
      return res.status(400).json({ error: "Unknown Plant" });
    }

    // BatchMaterialConsumption rows don't record their own plant — they're
    // joined to one through this very field (see stock.ts
    // getOnHandByPlantAndItem's `preProduction: { plantId }` filter).
    // Changing it after real consumption has already been logged would
    // silently rewrite which Plant's balance that consumption counts
    // against, so once Dispensing has logged real usage, the Plant is
    // locked in.
    if (existing.plantId !== plantId) {
      const consumptionCount = await prisma.batchMaterialConsumption.count({ where: { preProductionId: existing.id } });
      if (consumptionCount > 0) {
        return res.status(409).json({ error: "This run already has RM/PM consumption logged against its current Plant — the Plant can't be changed once Dispensing has recorded real usage." });
      }
    }

    const run = await prisma.preProduction.update({ where: { id: existing.id }, data: { plantId }, include: preProductionInclude });
    await recordAudit({ actorId: req.user!.id, action: "pre_production.plant_assigned", entityType: "PreProduction", entityId: run.id, metadata: { plantId } });

    res.json(serializePreProduction(run));
  } catch (err) {
    next(err);
  }
});

// The dispensing-area Line Clearance checklist — matches BMR-1.docx's
// real paper form item for item (see batch-checklists.ts). Not itself
// the gate (PreProduction.lineClearanceStatus, set via PATCH /:id/stage,
// still is) — this is the itemized Store/QA detail behind that one
// sign-off. Each call only ever writes the one column the caller's role
// owns.
preProductionRouter.patch("/:id/checklist", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const parsed = checklistUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { column, items } = parsed.data as ChecklistUpdateInput;

    const isAdmin = req.user!.roles.includes("ADMIN");
    if (column === "DEPT" && !req.user!.roles.includes("STORE") && !isAdmin) return res.status(403).json({ error: "Only Store can fill in this column." });
    if (column === "QA" && !req.user!.roles.includes("QA_QC") && !isAdmin) return res.status(403).json({ error: "Only QA/QC can fill in the QA column." });

    const existing = await prisma.preProduction.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Pre-production run not found" });

    const validKeys = preProductionChecklistKeys();
    const unknownKeys = items.map((i) => i.itemKey).filter((k) => !validKeys.has(k));
    if (unknownKeys.length > 0) return res.status(400).json({ error: `Unknown checklist item(s): ${unknownKeys.join(", ")}` });

    await prisma.$transaction(
      items.map((i) =>
        prisma.preProductionChecklistItem.upsert({
          where: { preProductionId_itemKey: { preProductionId: existing.id, itemKey: i.itemKey } },
          create: { preProductionId: existing.id, itemKey: i.itemKey, ...(column === "DEPT" ? { deptOk: i.ok } : { qaOk: i.ok }) },
          update: column === "DEPT" ? { deptOk: i.ok } : { qaOk: i.ok },
        }),
      ),
    );

    await recordAudit({ actorId: req.user!.id, action: "pre_production.checklist_updated", entityType: "PreProduction", entityId: existing.id, metadata: { column, itemCount: items.length } });

    const updated = await prisma.preProduction.findUniqueOrThrow({ where: { id: existing.id }, include: preProductionInclude });
    res.json(serializePreProduction(updated));
  } catch (err) {
    next(err);
  }
});

// QA's own sign-off on one Dispensing Sheet line ("Verified By (QA)" on
// the paper form) — separate from Sample QC Approval further down the
// pipeline, this is QC confirming the weighing itself (gross/tare/net,
// A.R. No.) was done correctly. Append-only: once verified, this can't
// be un-set.
preProductionRouter.post("/:id/consumptions/:consumptionId/verify", requireRole("QA_QC", "RND"), async (req: AuthedRequest<{ id: string; consumptionId: string }>, res, next) => {
  try {
    const line = await prisma.batchMaterialConsumption.findUnique({ where: { id: req.params.consumptionId } });
    if (!line || line.preProductionId !== req.params.id) return res.status(404).json({ error: "Consumption line not found on this run" });
    if (line.qaVerifiedById) return res.status(409).json({ error: "Already verified." });

    await prisma.batchMaterialConsumption.update({ where: { id: line.id }, data: { qaVerifiedById: req.user!.id, qaVerifiedAt: new Date() } });
    await recordAudit({ actorId: req.user!.id, action: "pre_production.consumption_qa_verified", entityType: "PreProduction", entityId: req.params.id, metadata: { consumptionId: line.id } });

    const updated = await prisma.preProduction.findUniqueOrThrow({ where: { id: req.params.id }, include: preProductionInclude });
    res.json(serializePreProduction(updated));
  } catch (err) {
    next(err);
  }
});

// The one transition endpoint for this tier's pipeline: fill in the
// current stage's fields (if it has any), then either forward it to the
// next stage or send it back.
preProductionRouter.patch("/:id/stage", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const run = await prisma.preProduction.findUnique({ where: { id: req.params.id } });
    if (!run) return res.status(404).json({ error: "Pre-production run not found" });

    const currentStage = run.currentStageId;

    const envelope = preProductionTransitionEnvelopeSchema.safeParse(req.body);
    if (!envelope.success) return res.status(400).json({ error: "Validation failed", details: envelope.error.flatten() });
    const { action, note, targetStageId } = envelope.data;

    // Admin override — move the run straight to any stage, bypassing the
    // normal forward/reject sequence and skipping field validation.
    if (action === "JUMP") {
      if (!req.user!.roles.includes("ADMIN")) {
        return res.status(403).json({ error: "Only an admin can move a run directly to another stage." });
      }
      if (!targetStageId) {
        return res.status(400).json({ error: "targetStageId is required for a jump." });
      }
      const updated = await prisma.$transaction(async (tx) => {
        await tx.preProduction.update({ where: { id: run.id }, data: { currentStageId: targetStageId } });
        await tx.preProductionStageEvent.create({
          data: { preProductionId: run.id, fromStageId: currentStage, toStageId: targetStageId, action: "JUMP", note: note ?? null, actorId: req.user!.id },
        });
        return tx.preProduction.findUniqueOrThrow({ where: { id: run.id }, include: preProductionInclude });
      });
      await recordAudit({ actorId: req.user!.id, action: "pre_production.stage_jumped", entityType: "PreProduction", entityId: run.id, metadata: { from: currentStage, to: targetStageId } });
      if (targetStageId !== currentStage) {
        await notifyRoles(
          PRE_PRODUCTION_STAGE_ROLE[targetStageId],
          { title: `${updated.purchaseOrderItem.productName} moved to ${PRE_PRODUCTION_STAGE_LABEL[targetStageId]}`, body: "Moved by an admin.", link: `/pre-productions/${updated.id}` },
          req.user!.id,
        ).catch((err) => req.log?.error({ err }, "notify failed: pre_production.stage_jumped"));
      }
      return res.json(serializePreProduction(updated));
    }

    const result = await transitionPreProductionStage({
      run,
      action: action as "FORWARD" | "REJECT",
      note,
      rawBody: req.body as Record<string, unknown>,
      actorId: req.user!.id,
      actorRoles: req.user!.roles,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, ...(result.details !== undefined ? { details: result.details } : {}) });
    }
    res.json({ ...serializePreProduction(result.updated), ...(result.dispensingShortfall.length > 0 ? { dispensingShortfall: result.dispensingShortfall } : {}) });
  } catch (err) {
    next(err);
  }
});
