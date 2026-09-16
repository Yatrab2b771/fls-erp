import { logger } from "../../common/lib/logger";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { prisma } from "../../common/lib/prisma";
import { productionBatchInclude, type ProductionBatchWithRelations } from "./batch-include";
import { actorCanActOnStage, COMBINED_LOT_STAGE_LABEL, COMBINED_LOT_STAGE_ROLE, getForwardTarget, getRejectTarget, type CombinedLotStageId } from "./combined-lot-stage";
import { PRODUCTION_BATCH_STAGE_FIELD_SCHEMA } from "./batch.schemas";
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

  if (batch.status !== "COMPLETED") {
    return { ok: false, status: 409, error: "This run needs to be completed (output quantity recorded) before it can move through QC/packaging/dispatch." };
  }

  const currentStage = batch.currentStageId;

  if (!actorCanActOnStage(currentStage, actorRoles)) {
    return { ok: false, status: 403, error: `This stage requires sign-off from the ${currentStage} department's role` };
  }

  const target = action === "FORWARD" ? getForwardTarget(currentStage) : getRejectTarget(currentStage);
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

  const isIpqcBlocked = action === "FORWARD" && currentStage === "IPQC" && (fieldData.ipqcStatus ?? batch.ipqcStatus) !== "Approved";
  const isBulkQcBlocked = action === "FORWARD" && currentStage === "BULK_QC" && (fieldData.bulkQcStatus ?? batch.bulkQcStatus) !== "Approved";

  const resolvesToCompleted = (value: unknown) => String(value ?? "").trim().toLowerCase() === "completed";
  const isPackagingIncomplete = action === "FORWARD" && currentStage === "PACKAGING" && !resolvesToCompleted(fieldData.packagingStatus ?? batch.packagingStatus);

  const effectiveTarget = isQaGateHeld || isIpqcBlocked || isBulkQcBlocked || isPackagingIncomplete ? currentStage : target;

  const updated = await prisma.productionBatch.update({
    where: { id: batch.id },
    data: { ...(fieldData as Prisma.ProductionBatchUpdateInput), currentStageId: effectiveTarget },
    include: productionBatchInclude,
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
    await notifyRoles(
      COMBINED_LOT_STAGE_ROLE[effectiveTarget],
      {
        title: `${productName} (batch${updated.batchNo ? ` ${updated.batchNo}` : ""}) is now at ${COMBINED_LOT_STAGE_LABEL[effectiveTarget]}`,
        body: action === "REJECT" ? `Sent back: ${note}` : "Production batch in progress.",
        link: `/production-batches/${updated.id}`,
      },
      actorId,
    ).catch((err) => logger.error({ err }, "notify failed: production_batch.transition"));
  }

  return { ok: true, updated, effectiveTarget };
}
