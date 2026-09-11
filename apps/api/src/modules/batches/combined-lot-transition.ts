import { prisma } from "../../common/lib/prisma";
import { logger } from "../../common/lib/logger";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { combinedLotInclude, type CombinedLotWithRelations } from "./batch-include";
import { actorCanActOnStage, COMBINED_LOT_STAGE_LABEL, COMBINED_LOT_STAGE_ROLE, getForwardTarget, getRejectTarget, type CombinedLotStageId } from "./combined-lot-stage";
import { COMBINED_LOT_STAGE_FIELD_SCHEMA } from "./batch.schemas";
import type { CombinedLot, Prisma, RoleName } from "@prisma/client";

// --- The forward/reject transition for Tier 3 (CombinedLot) —
// everything PATCH /combined-lots/:id/stage does once JUMP has been
// ruled out (JUMP stays inline in combined-lot.routes.ts). Split out of
// the old single transition.ts — this is the back half of the old
// single-Batch pipeline (IPQC through Dispatch Plan), now walked exactly
// once per pooled lot instead of once per small ProductionBatch run. See
// pre-production-transition.ts for the front half. ---

export type TransitionCombinedLotStageResult =
  | { ok: true; updated: CombinedLotWithRelations; effectiveTarget: CombinedLotStageId }
  | { ok: false; status: number; error: string; details?: unknown };

export async function transitionCombinedLotStage(params: {
  lot: CombinedLot;
  action: "FORWARD" | "REJECT";
  note?: string;
  confirmPartialDispatch?: boolean;
  rawBody: Record<string, unknown>;
  actorId: string;
  actorRoles: RoleName[];
}): Promise<TransitionCombinedLotStageResult> {
  const { lot, action, note, confirmPartialDispatch, rawBody, actorId, actorRoles } = params;
  const currentStage = lot.currentStageId;

  if (!actorCanActOnStage(currentStage, actorRoles)) {
    return { ok: false, status: 403, error: `This stage requires sign-off from the ${currentStage} department's role` };
  }

  const target = action === "FORWARD" ? getForwardTarget(currentStage) : getRejectTarget(currentStage);
  if (!target) {
    return {
      ok: false,
      status: 400,
      error: action === "FORWARD" ? "This lot has already reached the end of the pipeline." : "There's nothing before this stage to send back to.",
    };
  }
  if (action === "REJECT" && !note?.trim()) {
    return { ok: false, status: 400, error: "A note is required when sending a lot back." };
  }

  // Real business rule: one PO ships as one combined shipment, not
  // item-by-item. Saving dispatch details is the actual "the truck left"
  // event, so warn (409, not a hard block) when a sibling item's
  // CombinedLot on the same PO hasn't reached Dispatch Plan yet —
  // Dispatch can still explicitly confirm a genuine partial shipment via
  // confirmPartialDispatch.
  if (currentStage === "DISPATCH_PLAN" && action === "FORWARD" && !confirmPartialDispatch) {
    const preProd = await prisma.preProduction.findUnique({ where: { id: lot.preProductionId }, select: { purchaseOrderItem: { select: { purchaseOrderId: true } } } });
    if (preProd) {
      const siblings = await prisma.combinedLot.findMany({
        where: { id: { not: lot.id }, preProduction: { purchaseOrderItem: { purchaseOrderId: preProd.purchaseOrderItem.purchaseOrderId } } },
        select: { id: true, currentStageId: true, preProduction: { select: { purchaseOrderItem: { select: { productName: true } } } } },
      });
      const notReady = siblings.filter((s) => s.currentStageId !== "DISPATCH_PLAN");
      if (notReady.length > 0) {
        return {
          ok: false,
          status: 409,
          error: "Other line items on this PO haven't reached Dispatch Plan yet — this PO normally ships as one combined shipment. Confirm again to dispatch this lot separately anyway.",
          details: {
            siblingsNotReady: notReady.map((s) => ({
              combinedLotId: s.id,
              productName: s.preProduction.purchaseOrderItem.productName,
              currentStageId: s.currentStageId,
              currentStageLabel: COMBINED_LOT_STAGE_LABEL[s.currentStageId],
            })),
          },
        };
      }
    }
  }

  const fieldSchema = COMBINED_LOT_STAGE_FIELD_SCHEMA[currentStage];
  let fieldData: Record<string, unknown> = {};
  if (fieldSchema) {
    const { action: _a, note: _n, ...rest } = rawBody;
    const parsedFields = fieldSchema.safeParse(rest);
    if (!parsedFields.success) return { ok: false, status: 400, error: "Validation failed", details: parsedFields.error.flatten() };
    fieldData = parsedFields.data;
  }

  if (typeof fieldData.dispatchTransferId === "string") {
    const transfer = await prisma.dispatchTransfer.findUnique({ where: { id: fieldData.dispatchTransferId }, select: { id: true, type: true } });
    if (!transfer || transfer.type !== "FG") return { ok: false, status: 400, error: "That shipment reference doesn't match a real FG dispatch transfer." };
  }

  // Genuine hold, not just a status label: if either QA/QC field at a QA
  // gate resolves to "Hold" — this request's own submission, or whatever
  // was already saved if this request doesn't resupply it — FORWARD
  // doesn't advance past it.
  const isQaGateHeld =
    action === "FORWARD" &&
    ((currentStage === "QA_GATE_MFG" && [fieldData.mfgQaStatus ?? lot.mfgQaStatus, fieldData.mfgQcStatus ?? lot.mfgQcStatus].includes("Hold")) ||
      (currentStage === "QA_GATE_PACKAGING" && [fieldData.packQaStatus ?? lot.packQaStatus, fieldData.packQcStatus ?? lot.packQcStatus].includes("Hold")));

  // Same hard-gate shape as PreProduction's own gates — must literally
  // read "Approved".
  const isIpqcBlocked = action === "FORWARD" && currentStage === "IPQC" && (fieldData.ipqcStatus ?? lot.ipqcStatus) !== "Approved";
  const isBulkQcBlocked = action === "FORWARD" && currentStage === "BULK_QC" && (fieldData.bulkQcStatus ?? lot.bulkQcStatus) !== "Approved";

  // Packaging carries a free-text-with-suggestions status combo (see
  // PACKAGING_STATUSES on the web side) that gates the same way Sample
  // QC Approval does: one stage forward requires the status to actually
  // read "Completed" — the whole point of a "status" field on a process
  // step.
  const resolvesToCompleted = (value: unknown) => String(value ?? "").trim().toLowerCase() === "completed";
  const isPackagingIncomplete = action === "FORWARD" && currentStage === "PACKAGING" && !resolvesToCompleted(fieldData.packagingStatus ?? lot.packagingStatus);

  const effectiveTarget = isQaGateHeld || isIpqcBlocked || isBulkQcBlocked || isPackagingIncomplete ? currentStage : target;

  const updated = await prisma.$transaction(async (tx) => {
    // Phase F — Wastage bucket, QA Gate Mfg/Packaging only: a positive
    // wastageQty resolved at the moment this gate actually clears (not on
    // every Hold resubmission — effectiveTarget only differs from
    // currentStage once, when it genuinely moves on) is a real, permanent
    // loss, routed to the Recycle Store's own ledger (see BatchRecycleLog
    // in schema.prisma).
    if (effectiveTarget !== currentStage && (currentStage === "QA_GATE_MFG" || currentStage === "QA_GATE_PACKAGING")) {
      const wastageQty =
        currentStage === "QA_GATE_MFG"
          ? ((fieldData.mfgWastageQty as number | undefined) ?? lot.mfgWastageQty ?? 0)
          : ((fieldData.packWastageQty as number | undefined) ?? lot.packWastageQty ?? 0);
      if (wastageQty > 0) {
        const preProd = await tx.preProduction.findUnique({ where: { id: lot.preProductionId }, select: { purchaseOrderItem: { select: { unit: true } } } });
        await tx.batchRecycleLog.create({
          data: { combinedLotId: lot.id, stageId: currentStage, quantity: wastageQty, unit: preProd?.purchaseOrderItem.unit ?? "", createdById: actorId },
        });
      }
    }

    await tx.combinedLot.update({ where: { id: lot.id }, data: { ...(fieldData as Prisma.CombinedLotUpdateInput), currentStageId: effectiveTarget } });
    await tx.combinedLotStageEvent.create({
      data: { combinedLotId: lot.id, fromStageId: currentStage, toStageId: effectiveTarget, action, note: note ?? null, actorId },
    });
    return tx.combinedLot.findUniqueOrThrow({ where: { id: lot.id }, include: combinedLotInclude });
  });

  await recordAudit({
    actorId,
    action: action === "FORWARD" ? "combined_lot.stage_forwarded" : "combined_lot.stage_rejected",
    entityType: "CombinedLot",
    entityId: lot.id,
    metadata: { from: currentStage, to: effectiveTarget, partialDispatchConfirmed: confirmPartialDispatch || undefined },
  });

  // Only a real stage change is worth a notice — DISPATCH_PLAN forwards
  // to itself (terminal, "completes in place").
  if (effectiveTarget !== currentStage) {
    const productName = updated.preProduction.purchaseOrderItem.productName;
    await notifyRoles(
      COMBINED_LOT_STAGE_ROLE[effectiveTarget],
      {
        title: `${productName} is now at ${COMBINED_LOT_STAGE_LABEL[effectiveTarget]}`,
        body: action === "REJECT" ? `Sent back: ${note}` : "Production run in progress.",
        link: `/combined-lots/${updated.id}`,
      },
      actorId,
    ).catch((err) => logger.error({ err }, "notify failed: combined_lot.transition"));
  }

  return { ok: true, updated, effectiveTarget };
}
