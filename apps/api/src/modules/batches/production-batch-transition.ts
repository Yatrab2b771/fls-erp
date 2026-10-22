import { logger } from "../../common/lib/logger";
import { goodQtyOf } from "./good-qty";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { prisma } from "../../common/lib/prisma";
import { productionBatchInclude, type ProductionBatchWithRelations } from "./batch-include";
import { actorCanActOnStage, COMBINED_LOT_STAGE_LABEL, COMBINED_LOT_STAGE_ROLE, getBatchForwardTarget, getBatchRejectTarget, type CombinedLotStageId } from "./combined-lot-stage";
import { notifyPlantDayStore } from "../inventory/plan-requests";
import { PRODUCTION_BATCH_STAGE_FIELD_SCHEMA } from "./batch.schemas";
import { checkMassBalance } from "./mass-balance";
import { backWithProduction, EARLY_QA_STAGES } from "./batch-pipeline";
import type { Prisma, ProductionBatch, RoleName } from "@prisma/client";

// --- The forward/reject transition for a ProductionBatch's OWN Tier-3
// pipeline — same shape as combined-lot-transition.ts (same stage enum,
// same role map, same field schemas trimmed of Bulk Reconciliation/COA/
// dispatchTransferId), just walked once per small run instead of once
// per pooled lot. See schema.prisma's ProductionBatch comment for why
// this exists: a batch doesn't have to wait for its siblings to finish
// before it can be packaged and shipped on its own. No
// confirmPartialDispatch cross-check here — unlike CombinedLot, a
// ProductionBatch dispatching on its own IS the normal case now, not an
// exception that needs confirming. ---

export type TransitionProductionBatchStageResult =
  | { ok: true; updated: ProductionBatchWithRelations; effectiveTarget: CombinedLotStageId }
  | { ok: false; status: number; error: string; details?: unknown };

export async function transitionProductionBatchStage(params: {
  batch: ProductionBatch;
  action: "FORWARD" | "REJECT";
  note?: string;
  rawBody: Record<string, unknown>;
  actorId: string;
  actorRoles: RoleName[];
}): Promise<TransitionProductionBatchStageResult> {
  const { batch, action, note, rawBody, actorId, actorRoles } = params;

  // A per-batch-flow batch goes through In-Process QA, the QA Gate and Bulk QC as soon as it has started (it is still in production then);
  // from Packaging on it must have been sent to Packaging (completed). A batch of an older run is completed before it enters any of them.
  const run = await prisma.preProduction.findUnique({ where: { id: batch.preProductionId }, select: { batchFlow: true } });
  if (run?.batchFlow) {
    if (batch.status !== "COMPLETED") {
      if (!batch.shift || !batch.manpowerCount || !batch.shiftStartAt) {
        return { ok: false, status: 409, error: "This batch has not started yet: Production fills its start fields (shift, manpower, start date and time) first." };
      }
      if (!(EARLY_QA_STAGES as readonly string[]).includes(batch.currentStageId)) {
        return { ok: false, status: 409, error: "Production has to send this batch to Packaging first (fill its RM Utilization and end time)." };
      }
    }
  } else if (batch.status !== "COMPLETED") {
    return { ok: false, status: 409, error: "This run needs to be completed (output quantity recorded) before it can move through QC/packaging/dispatch." };
  }

  const currentStage = batch.currentStageId;

  if (!actorCanActOnStage(currentStage, actorRoles)) {
    return { ok: false, status: 403, error: `This stage requires sign-off from the ${currentStage} department's role` };
  }

  const target = action === "FORWARD" ? getBatchForwardTarget(currentStage) : getBatchRejectTarget(currentStage);
  if (!target) {
    return {
      ok: false,
      status: 400,
      error: action === "FORWARD" ? "This batch has already reached the end of the pipeline." : "There's nothing before this stage to send back to.",
    };
  }
  if (action === "REJECT" && !note?.trim()) {
    return { ok: false, status: 400, error: "A note is required when sending a batch back." };
  }

  const fieldSchema = PRODUCTION_BATCH_STAGE_FIELD_SCHEMA[currentStage];
  let fieldData: Record<string, unknown> = {};
  if (fieldSchema) {
    const { action: _a, note: _n, ...rest } = rawBody;
    const parsedFields = fieldSchema.safeParse(rest);
    if (!parsedFields.success) return { ok: false, status: 400, error: "Validation failed", details: parsedFields.error.flatten() };
    fieldData = parsedFields.data;
  }

  // Same hard-gate shapes as CombinedLot's own transition — see that
  // file's comments for the full reasoning behind each.
  const isQaGateHeld =
    action === "FORWARD" &&
    ((currentStage === "QA_GATE_MFG" && [fieldData.mfgQaStatus ?? batch.mfgQaStatus, fieldData.mfgQcStatus ?? batch.mfgQcStatus].includes("Hold")) ||
      (currentStage === "QA_GATE_PACKAGING" && [fieldData.packQaStatus ?? batch.packQaStatus, fieldData.packQcStatus ?? batch.packQcStatus].includes("Hold")) ||
      (currentStage === "FG_QC_RELEASE" && [fieldData.fgQaStatus ?? batch.fgQaStatus, fieldData.fgQcStatus ?? batch.fgQcStatus].includes("Hold")));

  // QA approves the finished goods (held by the Day Store): only a real Approved releases them to be handed over to Dispatch.
  const isFgNotApproved = action === "FORWARD" && currentStage === "FG_QC_RELEASE" && (fieldData.fgQaStatus ?? batch.fgQaStatus) !== "Approved";

  // The Day Store receives the finished goods only once Production has handed them over to the store.
  if (action === "FORWARD" && currentStage === "FG_STORE" && !batch.handedToStoreAt) {
    return { ok: false, status: 409, error: "Production has not handed these finished goods over to the store yet." };
  }

  const isIpqcBlocked = action === "FORWARD" && currentStage === "IPQC" && (fieldData.ipqcStatus ?? batch.ipqcStatus) !== "Approved";
  const isBulkQcBlocked = action === "FORWARD" && currentStage === "BULK_QC" && (fieldData.bulkQcStatus ?? batch.bulkQcStatus) !== "Approved";

  const resolvesToCompleted = (value: unknown) => String(value ?? "").trim().toLowerCase() === "completed";
  const isPackagingIncomplete = action === "FORWARD" && currentStage === "PACKAGING" && !resolvesToCompleted(fieldData.packagingStatus ?? batch.packagingStatus);

  // The end of the pipeline: the Day Store hands the approved finished goods to Dispatch (the batch stays at this stage; the
  // hand-over is recorded and Dispatch takes over with shipments).
  if (action === "FORWARD" && currentStage === "FG_HANDOVER") {
    if (batch.handedOverToDispatchAt) return { ok: false, status: 409, error: "These finished goods have already been handed over to Dispatch." };
    const handedOver = await prisma.productionBatch.update({ where: { id: batch.id }, data: { handedOverToDispatchAt: new Date(), handedOverById: actorId }, include: productionBatchInclude });
    await recordAudit({ actorId, action: "production_batch.fg_handed_over_to_dispatch", entityType: "ProductionBatch", entityId: batch.id });
    await notifyRoles(
      ["DISPATCH"],
      {
        title: `${handedOver.preProduction.purchaseOrderItem.productName} (batch${handedOver.batchNo ? ` ${handedOver.batchNo}` : ""}) finished goods handed over`,
        body: "Approved finished goods are with you: send them to the customer or to the Warehouse.",
        link: "/finished-goods-dispatch",
      },
      actorId,
    ).catch((err) => logger.error({ err }, "notify failed: production_batch.fg_handover"));
    return { ok: true, updated: handedOver, effectiveTarget: "FG_HANDOVER" };
  }

  const effectiveTarget = isQaGateHeld || isFgNotApproved || isIpqcBlocked || isBulkQcBlocked || isPackagingIncomplete ? currentStage : target;

  // Quantities may not appear out of nowhere between stages: when a gate actually clears, what it approves, rejects and wastes has to
  // add up to what the stage before gave it (blank fields are worked out from it). A gate on Hold may still be saved half-filled.
  const clearsGate = action === "FORWARD" && effectiveTarget !== currentStage;
  const massBalanceStage = currentStage === "IPQC" || currentStage === "QA_GATE_MFG" || currentStage === "QA_GATE_PACKAGING" ? currentStage : null;
  let orderUnit = "";
  if (clearsGate && massBalanceStage) {
    const po = await prisma.productionBatch.findUnique({ where: { id: batch.id }, select: { preProduction: { select: { purchaseOrderItem: { select: { unit: true } } } } } });
    orderUnit = po?.preProduction.purchaseOrderItem.unit ?? "";
    const merged = {
      bulkTransferToPackingQty: batch.bulkTransferToPackingQty,
      mfgApprovedQty: batch.mfgApprovedQty,
      mfgRejectedQty: batch.mfgRejectedQty,
      mfgWastageQty: batch.mfgWastageQty,
      packApprovedQty: batch.packApprovedQty,
      packRejectedQty: batch.packRejectedQty,
      packWastageQty: batch.packWastageQty,
      ...(fieldData as Record<string, number | null | undefined>),
    };
    const balance = checkMassBalance({ stage: massBalanceStage, outputQty: batch.outputQty, unit: orderUnit, values: merged });
    if (!balance.ok) return { ok: false, status: 400, error: balance.error };
    fieldData = { ...fieldData, ...balance.defaults };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.productionBatch.update({
      where: { id: batch.id },
      // (QA approving the packaging gate puts the goods at FG Store but not yet in the Day Store's hands: that is Production's hand-over)
      data: { ...(fieldData as Prisma.ProductionBatchUpdateInput), currentStageId: effectiveTarget, ...(effectiveTarget === "FG_STORE" && currentStage === "QA_GATE_PACKAGING" ? { handedToStoreAt: null } : {}) },
      include: productionBatchInclude,
    });
    // A QA gate's rejected and wasted quantities go to the Recycle Store (waste gone for good; rejected held for a decision), so
    // they are on the books instead of being two numbers on the batch. Replaced each time the gate clears, so a batch sent back and
    // forwarded again does not count twice.
    if (clearsGate && (currentStage === "QA_GATE_MFG" || currentStage === "QA_GATE_PACKAGING")) {
      const f = fieldData as Record<string, number | null | undefined>;
      const rejected = (currentStage === "QA_GATE_MFG" ? f.mfgRejectedQty ?? batch.mfgRejectedQty : f.packRejectedQty ?? batch.packRejectedQty) ?? 0;
      const wasted = (currentStage === "QA_GATE_MFG" ? f.mfgWastageQty ?? batch.mfgWastageQty : f.packWastageQty ?? batch.packWastageQty) ?? 0;
      const note = `Batch ${batch.batchNo ?? batch.id.slice(0, 8)}`;
      await tx.batchRecycleLog.deleteMany({ where: { productionBatchId: batch.id, stageId: currentStage } });
      const rows = [
        ...(wasted > 0 ? [{ kind: "WASTAGE", quantity: wasted }] : []),
        ...(rejected > 0 ? [{ kind: "REJECTED", quantity: rejected }] : []),
      ];
      if (rows.length > 0) {
        await tx.batchRecycleLog.createMany({ data: rows.map((r) => ({ productionBatchId: batch.id, stageId: currentStage, kind: r.kind, quantity: r.quantity, unit: orderUnit || "Kg", note, createdById: actorId })) });
      }
    }
    // A QA gate that takes quantity out (rejected, wasted) lowers what the batch counts for in the run's "made so far": the run's
    // shortfall, and Close short, then see what QA actually passed. Worked out from the batch before and after, so a gate that is cleared
    // again, or a batch sent back, never counts twice.
    // (A batch still in production adds to "made so far" when it is sent to Packaging, by what is good then: nothing to adjust before.)
    const delta = batch.status === "COMPLETED" ? goodQtyOf(row) - goodQtyOf(batch) : 0;
    if (Math.abs(delta) > 1e-9) {
      const run = await tx.preProduction.findUnique({ where: { id: row.preProductionId }, select: { combinedQty: true, batchFlow: true } });
      if (run?.batchFlow) await tx.preProduction.update({ where: { id: row.preProductionId }, data: { combinedQty: Math.max(0, Math.round((run.combinedQty + delta) * 1000) / 1000) } });
    }
    return row;
  });

  await recordAudit({
    actorId,
    action: action === "FORWARD" ? "production_batch.stage_forwarded" : "production_batch.stage_rejected",
    entityType: "ProductionBatch",
    entityId: batch.id,
    metadata: { from: currentStage, to: effectiveTarget, note: note || undefined },
  });

  if (effectiveTarget !== currentStage) {
    const productName = updated.preProduction.purchaseOrderItem.productName;
    const content = {
      title: `${productName} (batch${updated.batchNo ? ` ${updated.batchNo}` : ""}) is now at ${COMBINED_LOT_STAGE_LABEL[effectiveTarget]}`,
      body: action === "REJECT" ? `Sent back: ${note}` : backWithProduction(updated) ? "Bulk QC has passed: fill the RM Utilization and the end time, then send it to Packaging." : "Production batch in progress.",
      link: effectiveTarget === "FG_STORE" || effectiveTarget === "FG_HANDOVER" ? "/my-store/finished-goods" : backWithProduction(updated) ? "/batches" : `/production-batches/${updated.id}`,
    };
    // QA approved the packed goods: Production is told to hand them over to the store.
    if (effectiveTarget === "FG_STORE" && currentStage === "QA_GATE_PACKAGING") {
      await notifyRoles(["PRODUCTION"], { title: `${productName} (batch${updated.batchNo ? ` ${updated.batchNo}` : ""}): QA approved the packed goods`, body: "Hand them over to the store.", link: "/handover" }, actorId).catch((err) => logger.error({ err }, "notify failed: production_batch.qa_approved"));
    } else if (effectiveTarget === "FG_STORE" || effectiveTarget === "FG_HANDOVER") {
      // The finished goods sit with the Day Store of the batch's Plant, so it (not every Store seat) is told.
      const plant = updated.preProduction.plantId ? await prisma.plant.findUnique({ where: { id: updated.preProduction.plantId }, select: { dayStoreId: true } }) : null;
      await notifyPlantDayStore(plant?.dayStoreId, content, actorId).catch((err) => logger.error({ err }, "notify failed: production_batch.transition.day_store"));
    } else {
      await notifyRoles(COMBINED_LOT_STAGE_ROLE[effectiveTarget], content, actorId).catch((err) => logger.error({ err }, "notify failed: production_batch.transition"));
    }
  }

  return { ok: true, updated, effectiveTarget };
}
