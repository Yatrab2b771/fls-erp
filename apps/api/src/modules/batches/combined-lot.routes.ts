import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { notifyRoles } from "../../common/lib/notify";
import { combinedLotInclude, serializeCombinedLot, preProductionInclude, type CombinedLotWithRelations } from "./batch-include";
import { transitionCombinedLotStage } from "./combined-lot-transition";
import { COMBINED_LOT_STAGE_LABEL, COMBINED_LOT_STAGE_ROLE } from "./combined-lot-stage";
import {
  checklistUpdateSchema,
  coaResultsReplaceSchema,
  coaSignSchema,
  combinedLotTransitionEnvelopeSchema,
  type ChecklistUpdateInput,
  type CoaResultsReplaceInput,
  type CoaSignInput,
} from "./batch.schemas";
import { combinedLotChecklistKeys } from "./batch-checklists";
import { buildBatchReportPdf } from "./batch-report-pdf";

// --- Tier 3 of the three-tier pipeline (see schema.prisma's own comment
// block above CombinedLot): IPQC through Dispatch Plan, walked exactly
// once per pooled lot — created automatically once every planned
// ProductionBatch has completed and combined (see
// production-batches.routes.ts POST /:id/complete). This module is the
// back half of what batches.routes.ts used to be, before the split. ---

export const combinedLotRouter = Router();

combinedLotRouter.use(requireAuth);

export { combinedLotInclude, serializeCombinedLot, type CombinedLotWithRelations };

// Every pooled lot, across every PO item — the Dashboard's own
// "everything currently in the back half of the pipeline" view, same
// "read access is open to any authenticated user" rule as PreProduction's
// own GET /. Not paginated — the whole company's active lot count is
// small enough that a client-side scan (delay, stage counts, "my queue")
// is simpler than adding a second pagination contract here.
combinedLotRouter.get("/", async (_req, res, next) => {
  try {
    const lots = await prisma.combinedLot.findMany({ include: combinedLotInclude, orderBy: { createdAt: "desc" } });
    res.json(lots.map(serializeCombinedLot));
  } catch (err) {
    next(err);
  }
});

combinedLotRouter.get("/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const lot = await prisma.combinedLot.findUnique({ where: { id: req.params.id }, include: combinedLotInclude });
    if (!lot) return res.status(404).json({ error: "Combined lot not found" });
    res.json(serializeCombinedLot(lot));
  } catch (err) {
    next(err);
  }
});

// The bulk-mfg-area Line Clearance checklist — matches BMR-1.docx's real
// paper form item for item (see batch-checklists.ts), Production's
// column instead of Store's. Not itself the gate
// (CombinedLot.ipqcStatus, set via PATCH /:id/stage, still is).
combinedLotRouter.patch("/:id/checklist", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const parsed = checklistUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { column, items } = parsed.data as ChecklistUpdateInput;

    const isAdmin = req.user!.roles.includes("ADMIN");
    if (column === "DEPT" && !req.user!.roles.includes("PRODUCTION") && !isAdmin) return res.status(403).json({ error: "Only Production can fill in this column." });
    if (column === "QA" && !req.user!.roles.includes("QA_QC") && !isAdmin) return res.status(403).json({ error: "Only QA/QC can fill in the QA column." });

    const existing = await prisma.combinedLot.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Combined lot not found" });

    const validKeys = combinedLotChecklistKeys();
    const unknownKeys = items.map((i) => i.itemKey).filter((k) => !validKeys.has(k));
    if (unknownKeys.length > 0) return res.status(400).json({ error: `Unknown checklist item(s): ${unknownKeys.join(", ")}` });

    await prisma.$transaction(
      items.map((i) =>
        prisma.combinedLotChecklistItem.upsert({
          where: { combinedLotId_itemKey: { combinedLotId: existing.id, itemKey: i.itemKey } },
          create: { combinedLotId: existing.id, itemKey: i.itemKey, ...(column === "DEPT" ? { deptOk: i.ok } : { qaOk: i.ok }) },
          update: column === "DEPT" ? { deptOk: i.ok } : { qaOk: i.ok },
        }),
      ),
    );

    await recordAudit({ actorId: req.user!.id, action: "combined_lot.checklist_updated", entityType: "CombinedLot", entityId: existing.id, metadata: { column, itemCount: items.length } });

    const updated = await prisma.combinedLot.findUniqueOrThrow({ where: { id: existing.id }, include: combinedLotInclude });
    res.json(serializeCombinedLot(updated));
  } catch (err) {
    next(err);
  }
});

// Certificate of Analysis — matches "COA format.docx". A full replace
// each save, not an upsert-by-key like the checklists. RND alongside
// QA_QC — Bulk QC Sampling & Testing, which COA is part of, is R&D's own
// work per Production Process Flow.docx.
combinedLotRouter.put("/:id/coa/results", requireRole("QA_QC", "RND"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const parsed = coaResultsReplaceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { results } = parsed.data as CoaResultsReplaceInput;

    const existing = await prisma.combinedLot.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Combined lot not found" });

    await prisma.$transaction([
      prisma.batchCoaTestResult.deleteMany({ where: { combinedLotId: existing.id } }),
      prisma.batchCoaTestResult.createMany({
        data: results.map((r, i) => ({ combinedLotId: existing.id, testName: r.testName, specification: r.specification, observation: r.observation, sortOrder: i })),
      }),
    ]);

    await recordAudit({ actorId: req.user!.id, action: "combined_lot.coa_results_updated", entityType: "CombinedLot", entityId: existing.id, metadata: { rowCount: results.length } });

    const updated = await prisma.combinedLot.findUniqueOrThrow({ where: { id: existing.id }, include: combinedLotInclude });
    res.json(serializeCombinedLot(updated));
  } catch (err) {
    next(err);
  }
});

// The doc's three sequential sign-offs (Analyzed By -> Reviewed By ->
// Approved By) — each settable once, in that order.
const COA_SIGN_ORDER: CoaSignInput["step"][] = ["ANALYZED", "REVIEWED", "APPROVED"];
const COA_SIGN_FIELD: Record<CoaSignInput["step"], { byField: "coaAnalyzedById" | "coaReviewedById" | "coaApprovedById"; atField: "coaAnalyzedAt" | "coaReviewedAt" | "coaApprovedAt" }> = {
  ANALYZED: { byField: "coaAnalyzedById", atField: "coaAnalyzedAt" },
  REVIEWED: { byField: "coaReviewedById", atField: "coaReviewedAt" },
  APPROVED: { byField: "coaApprovedById", atField: "coaApprovedAt" },
};
combinedLotRouter.post("/:id/coa/sign", requireRole("QA_QC", "RND"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const parsed = coaSignSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { step } = parsed.data as CoaSignInput;

    const existing = await prisma.combinedLot.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Combined lot not found" });

    const { byField } = COA_SIGN_FIELD[step];
    if (existing[byField]) return res.status(409).json({ error: `Already ${step.toLowerCase()}.` });

    const stepIndex = COA_SIGN_ORDER.indexOf(step);
    const priorStep = COA_SIGN_ORDER[stepIndex - 1];
    if (priorStep && !existing[COA_SIGN_FIELD[priorStep].byField]) {
      return res.status(409).json({ error: `This COA hasn't been ${priorStep.toLowerCase()} yet.` });
    }

    const { atField } = COA_SIGN_FIELD[step];
    await prisma.combinedLot.update({ where: { id: existing.id }, data: { [byField]: req.user!.id, [atField]: new Date() } });
    await recordAudit({ actorId: req.user!.id, action: "combined_lot.coa_signed", entityType: "CombinedLot", entityId: existing.id, metadata: { step } });

    const updated = await prisma.combinedLot.findUniqueOrThrow({ where: { id: existing.id }, include: combinedLotInclude });
    res.json(serializeCombinedLot(updated));
  } catch (err) {
    next(err);
  }
});

// The one transition endpoint for this tier's pipeline: fill in the
// current stage's fields (if it has any), then either forward it to the
// next stage or send it back.
combinedLotRouter.patch("/:id/stage", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const lot = await prisma.combinedLot.findUnique({ where: { id: req.params.id } });
    if (!lot) return res.status(404).json({ error: "Combined lot not found" });

    const currentStage = lot.currentStageId;

    const envelope = combinedLotTransitionEnvelopeSchema.safeParse(req.body);
    if (!envelope.success) return res.status(400).json({ error: "Validation failed", details: envelope.error.flatten() });
    const { action, note, targetStageId, confirmPartialDispatch } = envelope.data;

    if (action === "JUMP") {
      if (!req.user!.roles.includes("ADMIN")) {
        return res.status(403).json({ error: "Only an admin can move a lot directly to another stage." });
      }
      if (!targetStageId) {
        return res.status(400).json({ error: "targetStageId is required for a jump." });
      }
      const updated = await prisma.$transaction(async (tx) => {
        await tx.combinedLot.update({ where: { id: lot.id }, data: { currentStageId: targetStageId } });
        await tx.combinedLotStageEvent.create({
          data: { combinedLotId: lot.id, fromStageId: currentStage, toStageId: targetStageId, action: "JUMP", note: note ?? null, actorId: req.user!.id },
        });
        return tx.combinedLot.findUniqueOrThrow({ where: { id: lot.id }, include: combinedLotInclude });
      });
      await recordAudit({ actorId: req.user!.id, action: "combined_lot.stage_jumped", entityType: "CombinedLot", entityId: lot.id, metadata: { from: currentStage, to: targetStageId } });
      if (targetStageId !== currentStage) {
        await notifyRoles(
          COMBINED_LOT_STAGE_ROLE[targetStageId],
          { title: `${updated.preProduction.purchaseOrderItem.productName} moved to ${COMBINED_LOT_STAGE_LABEL[targetStageId]}`, body: "Moved by an admin.", link: `/combined-lots/${updated.id}` },
          req.user!.id,
        ).catch((err) => req.log?.error({ err }, "notify failed: combined_lot.stage_jumped"));
      }
      return res.json(serializeCombinedLot(updated));
    }

    const result = await transitionCombinedLotStage({
      lot,
      action: action as "FORWARD" | "REJECT",
      note,
      confirmPartialDispatch,
      rawBody: req.body as Record<string, unknown>,
      actorId: req.user!.id,
      actorRoles: req.user!.roles,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, ...(result.details !== undefined ? { details: result.details } : {}) });
    }
    res.json(serializeCombinedLot(result.updated));
  } catch (err) {
    next(err);
  }
});

// The admin-only "full report" — every field the pipeline collected
// across both this lot and its parent PreProduction run, plus the
// complete stage history of both, as one PDF. Only makes sense once the
// lot has actually finished the pipeline, so it's gated to Dispatch Plan
// rather than exportable mid-flight.
combinedLotRouter.get("/:id/export.pdf", requireRole("ADMIN"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const lot = await prisma.combinedLot.findUnique({ where: { id: req.params.id }, include: combinedLotInclude });
    if (!lot) return res.status(404).json({ error: "Combined lot not found" });
    if (lot.currentStageId !== "DISPATCH_PLAN") {
      return res.status(400).json({ error: "The full report is available once a lot reaches Dispatch Plan." });
    }
    const preProduction = await prisma.preProduction.findUniqueOrThrow({ where: { id: lot.preProductionId }, include: preProductionInclude });

    const doc = buildBatchReportPdf(preProduction, lot);
    await recordAudit({ actorId: req.user!.id, action: "combined_lot.exported_report_pdf", entityType: "CombinedLot", entityId: lot.id });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="FLS_Production_Report_${lot.id}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    next(err);
  }
});
