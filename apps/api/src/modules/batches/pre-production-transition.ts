import { prisma } from "../../common/lib/prisma";
import { logger } from "../../common/lib/logger";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { RouteError } from "../../common/lib/route-error";
import { getOnHandByPlantAndItem } from "../inventory/stock";
import { getScaledRequiredDispensingItems, type DispensingRequirementStatus } from "./dispensing-requirements";
import { preProductionInclude, type PreProductionWithRelations } from "./batch-include";
import { actorCanActOnStage, PRE_PRODUCTION_STAGE_LABEL, PRE_PRODUCTION_STAGE_ROLE, getForwardTarget, getRejectTarget, type PreProductionStageId } from "./pre-production-stage";
import { PRE_PRODUCTION_STAGE_FIELD_SCHEMA, dispensingConsumptionSchema, indentRequestLinesSchema } from "./batch.schemas";
import type { PreProduction, Prisma, RoleName } from "@prisma/client";

// --- The forward/reject transition for Tier 1 (PreProduction) —
// everything PATCH /pre-productions/:id/stage does once JUMP has been
// ruled out (JUMP stays inline in pre-production.routes.ts, it's
// admin-only and doesn't share any of this gating). Pulled out into its
// own module so the bulk import route (batch-import.ts) can run the
// exact same gated logic per row instead of a second implementation that
// could quietly drift from it. Split out of the old single transition.ts
// — this is the material-readiness half only (Material Received through
// Sample QC Approval); see combined-lot-transition.ts for the back half.
// ---

export type TransitionPreProductionStageResult =
  | { ok: true; updated: PreProductionWithRelations; effectiveTarget: PreProductionStageId; dispensingShortfall: DispensingRequirementStatus[] }
  | { ok: false; status: number; error: string; details?: unknown };

export async function transitionPreProductionStage(params: {
  run: PreProduction;
  action: "FORWARD" | "REJECT";
  note?: string;
  // The full untyped request body (or bulk-import row payload) — which
  // keys apply depends on the run's *current* stage, worked out below
  // the same way the single-run route always has.
  rawBody: Record<string, unknown>;
  actorId: string;
  actorRoles: RoleName[];
}): Promise<TransitionPreProductionStageResult> {
  const { run, action, note, rawBody, actorId, actorRoles } = params;
  const currentStage = run.currentStageId;

  if (!actorCanActOnStage(currentStage, actorRoles)) {
    return { ok: false, status: 403, error: `This stage requires sign-off from the ${currentStage} department's role` };
  }

  const target = action === "FORWARD" ? getForwardTarget(currentStage) : getRejectTarget(currentStage);
  if (!target) {
    return {
      ok: false,
      status: 400,
      error: action === "FORWARD" ? "This run has already reached the end of the pre-production pipeline." : "There's nothing before this stage to send back to.",
    };
  }
  if (action === "REJECT" && !note?.trim()) {
    return { ok: false, status: 400, error: "A note is required when sending a run back." };
  }

  // Field validation is separate from the envelope because which fields
  // are allowed depends on the *current* stage.
  const fieldSchema = PRE_PRODUCTION_STAGE_FIELD_SCHEMA[currentStage];
  let fieldData: Record<string, unknown> = {};
  if (fieldSchema) {
    const { action: _a, note: _n, ...rest } = rawBody;
    const parsedFields = fieldSchema.safeParse(rest);
    if (!parsedFields.success) return { ok: false, status: 400, error: "Validation failed", details: parsedFields.error.flatten() };
    fieldData = parsedFields.data;
  }

  // Optional cross-module traceability link (Material Received's
  // sourceReceiptId) — a string value means "link to this row," so it
  // has to actually be one of the right type; null clears an existing
  // link and needs no check; absent (undefined) leaves the current link
  // untouched.
  if (typeof fieldData.sourceReceiptId === "string") {
    const receipt = await prisma.inventoryTransaction.findUnique({ where: { id: fieldData.sourceReceiptId }, select: { id: true, type: true } });
    if (!receipt || receipt.type !== "RECEIVED") return { ok: false, status: 400, error: "That GRN reference doesn't match a real Warehouse receipt." };
  }

  // Same hard-gate shape as Sample QC Approval below, for Line Clearance
  // — see the client's Production Process Flow doc and
  // pre-production-stage.ts's own comment on why it was added.
  const isLineClearanceBlocked =
    action === "FORWARD" && currentStage === "LINE_CLEARANCE" && (fieldData.lineClearanceStatus ?? run.lineClearanceStatus) !== "Approved";

  // The pre-production hard gate — Production simply cannot start on a
  // sample QC hasn't actually Approved, so this blocks on anything other
  // than a literal "Approved".
  const isSampleQcBlocked = action === "FORWARD" && currentStage === "SAMPLE_QC_APPROVAL" && (fieldData.sampleQcStatus ?? run.sampleQcStatus) !== "Approved";

  // Real material-indent lines — Indent Issue only, optional (a run can
  // still move through Indent Issue with just prodIndentSlipSign, same
  // carve-out as Dispensing's consumption below). Creates real
  // InventoryRequest rows tagged to this run — Store's actual "what
  // leaves the shelf for Production" gate — instead of leaving the
  // free-text sign-off as the only record of the ask.
  const parsedIndentLines = indentRequestLinesSchema.safeParse(rawBody.indentLines);
  if (!parsedIndentLines.success) return { ok: false, status: 400, error: "Validation failed", details: parsedIndentLines.error.flatten() };
  const indentLines = currentStage === "INDENT_ISSUE" ? (parsedIndentLines.data ?? []) : [];
  if (indentLines.length > 0) {
    const indentItemIds = [...new Set(indentLines.map((l) => l.itemId))];
    const foundIndentItems = await prisma.inventoryItem.findMany({ where: { id: { in: indentItemIds } }, select: { id: true, category: true } });
    if (foundIndentItems.length !== indentItemIds.length) {
      return { ok: false, status: 400, error: "One or more indent lines reference an unknown item." };
    }
    const categoryById = new Map(foundIndentItems.map((i) => [i.id, i.category]));
    if (indentLines.some((l) => categoryById.get(l.itemId) !== l.category)) {
      return { ok: false, status: 400, error: "One or more indent lines have a category that doesn't match the selected item." };
    }
  }

  // Real RM/PM consumption lines — Dispensing only, optional (a run can
  // still move through Dispensing with just the date/remark fields, same
  // as before this existed). Reduces the run's Plant's real-time
  // balance (see stock.ts getOnHandByPlantAndItem), so it needs a Plant
  // assigned first — there's no sane default to charge material against.
  const parsedConsumption = dispensingConsumptionSchema.safeParse(rawBody.consumption);
  if (!parsedConsumption.success) return { ok: false, status: 400, error: "Validation failed", details: parsedConsumption.error.flatten() };
  const consumption = currentStage === "DISPENSING" ? (parsedConsumption.data ?? []) : [];
  if (consumption.length > 0) {
    if (!run.plantId) {
      return { ok: false, status: 400, error: "Assign a Plant to this run before logging RM/PM consumption — see the Plant field above." };
    }
    const itemIds = [...new Set(consumption.map((c) => c.itemId))];
    const foundItems = await prisma.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true } });
    if (foundItems.length !== itemIds.length) {
      return { ok: false, status: 400, error: "One or more consumption lines reference an unknown item." };
    }
  }

  // Hard gate on leaving Dispensing: this run's product needs several
  // RM/PM items (per its linked, calculated RmPlan/BomPlan — see
  // dispensing-requirements.ts), and logging just one of them used to be
  // enough to forward anyway. No plan linked = nothing to check against
  // (same "no data, no gate" rule as PO Readiness). Computed before the
  // transaction — it only reads the PO item's plans, which this request
  // never writes to.
  const requiredDispensingItems = currentStage === "DISPENSING" && action === "FORWARD" ? await getScaledRequiredDispensingItems(run.id, run.purchaseOrderItemId) : [];

  let plantShortfallError: TransitionPreProductionStageResult | null = null;
  // Set inside txFn (if any SAMPLE-purpose lines were logged) so the
  // post-commit notify block below knows whether to tell QA/QC — same
  // "compute inside the transaction, act on it after" shape as
  // dispensingShortfall.
  let sampleLinesForNotify: { itemId: string; quantity: number; unit: string }[] = [];

  // Same shape as every other stock-consuming write in this app (see
  // inventory.routes.ts): the check against what's actually on the
  // Plant's shelf and the write that depends on it run inside one
  // SERIALIZABLE transaction, not two separate round-trips — otherwise
  // two Dispensing submissions against the same Plant/item at once could
  // each read a stale balance and jointly consume more than was ever
  // issued there. Only worth the extra isolation when there's actually a
  // balance to protect; a stage move with no consumption lines uses the
  // plain transaction as before.
  const txFn = async (tx: Prisma.TransactionClient) => {
    if (consumption.length > 0) {
      const requestedByItem = new Map<string, number>();
      for (const c of consumption) requestedByItem.set(c.itemId, (requestedByItem.get(c.itemId) ?? 0) + c.quantity);
      const onHand = await getOnHandByPlantAndItem(run.plantId!, [...requestedByItem.keys()], tx);
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

    if (consumption.length > 0) {
      await tx.batchMaterialConsumption.createMany({
        data: consumption.map((c) => ({
          preProductionId: run.id,
          itemId: c.itemId,
          quantity: c.quantity,
          unit: c.unit,
          purpose: c.purpose,
          grossWeight: c.grossWeight,
          tareWeight: c.tareWeight,
          arNo: c.arNo,
          createdById: actorId,
        })),
      });

      // WASTE purpose is a real, immediate spill — routed straight to the
      // Recycle Store's own one-way ledger (see schema.prisma's
      // InventoryTxnType.ISSUED_RECYCLE comment). No confirm step, unlike
      // the sample leg below: Recycle Store is a sink, nothing ever
      // leaves it.
      const wasteLines = consumption.filter((c) => c.purpose === "WASTE");
      if (wasteLines.length > 0) {
        await tx.inventoryTransaction.createMany({
          data: wasteLines.map((c) => ({
            itemId: c.itemId,
            type: "ISSUED_RECYCLE" as const,
            date: new Date(),
            unit: c.unit,
            quantity: c.quantity,
            plantId: run.plantId,
            preProductionId: run.id,
            remark: "Dispensing spill — routed to Recycle Store",
            createdById: actorId,
          })),
        });
      }

      // SAMPLE purpose is what's about to go through the SAMPLE_QC_APPROVAL
      // gate below — logging it here is the actual "send" (see
      // qc-sample.routes.ts's own comment on why there's no separate send
      // action): the material already left the Plant the instant Store
      // measured it out as sample, same moment as everything else
      // dispensed. QC confirms/tests it from here on.
      sampleLinesForNotify = consumption.filter((c) => c.purpose === "SAMPLE");
      if (sampleLinesForNotify.length > 0) {
        await tx.qcSampleTransfer.createMany({
          data: sampleLinesForNotify.map((c) => ({ preProductionId: run.id, direction: "TO_QC" as const, itemId: c.itemId, quantity: c.quantity, unit: c.unit, sentById: actorId })),
        });
      }
    }

    // The Dispensing gate itself: with this request's consumption now
    // written, does every required item's running total actually cover
    // it? Short (or missing entirely) -> save everything above as normal
    // but don't advance the stage, so nothing just submitted is lost —
    // top the rest up in a follow-up save instead of re-entering from
    // scratch. Read inside the same transaction so the totals reflect
    // what was just written. Only PRODUCTION-purpose rows count — a
    // sample pulled aside for QC or a spill lost at dispensing was never
    // really "used in the batch" against this requirement (see
    // BatchConsumptionPurpose's own comment).
    let dispensingShortfall: (DispensingRequirementStatus & { covered: false })[] = [];
    let effectiveTarget = isLineClearanceBlocked || isSampleQcBlocked ? currentStage : target;
    if (requiredDispensingItems.length > 0) {
      const consumedRows = await tx.batchMaterialConsumption.groupBy({ by: ["itemId"], where: { preProductionId: run.id, purpose: "PRODUCTION" }, _sum: { quantity: true } });
      const consumedByItem = new Map(consumedRows.map((c) => [c.itemId, c._sum.quantity ?? 0]));
      dispensingShortfall = requiredDispensingItems
        .map((item) => ({ ...item, consumedQty: consumedByItem.get(item.itemId) ?? 0, covered: false as const }))
        .filter((item) => item.consumedQty < item.requiredQty);
      if (dispensingShortfall.length > 0) effectiveTarget = currentStage;
    }

    await tx.preProduction.update({ where: { id: run.id }, data: { ...(fieldData as Prisma.PreProductionUpdateInput), currentStageId: effectiveTarget } });
    if (indentLines.length > 0) {
      await tx.inventoryRequest.createMany({
        data: indentLines.map((l) => ({
          itemId: l.itemId,
          category: l.category,
          requestedQty: l.requestedQty,
          purpose: "ISSUED_PRODUCTION",
          plantId: run.plantId ?? undefined,
          preProductionId: run.id,
          requestedById: actorId,
          neededBy: l.neededBy,
          note: l.note,
        })),
      });
    }
    await tx.preProductionStageEvent.create({
      data: { preProductionId: run.id, fromStageId: currentStage, toStageId: effectiveTarget, action, note: note ?? null, actorId },
    });
    const savedRun = await tx.preProduction.findUniqueOrThrow({ where: { id: run.id }, include: preProductionInclude });
    return { run: savedRun, effectiveTarget, dispensingShortfall, indentLinesCount: indentLines.length };
  };

  let txResult;
  try {
    txResult = consumption.length > 0 ? await runSerializable(txFn) : await prisma.$transaction(txFn);
  } catch (err) {
    // The Plant-balance shortfall is the one failure that can only throw
    // (a transaction callback can only return or throw) — convert it
    // back to the same discriminated result every other failure above
    // already uses, so callers never need to know this one path is
    // implemented differently.
    if (err instanceof RouteError) {
      plantShortfallError = { ok: false, status: err.status, error: err.message };
    } else {
      throw err;
    }
  }
  if (plantShortfallError) return plantShortfallError;
  const { run: updated, effectiveTarget, dispensingShortfall } = txResult!;

  await recordAudit({
    actorId,
    action: action === "FORWARD" ? "pre_production.stage_forwarded" : "pre_production.stage_rejected",
    entityType: "PreProduction",
    entityId: run.id,
    metadata: {
      from: currentStage,
      to: effectiveTarget,
      consumptionLines: consumption.length || undefined,
      indentLines: indentLines.length || undefined,
      dispensingShortfallCount: dispensingShortfall.length || undefined,
      sampleLines: sampleLinesForNotify.length || undefined,
    },
  });

  // Real indent lines just created a batch's worth of PENDING
  // InventoryRequest rows — Store needs to know, same as any other new
  // material request (see inventory.routes.ts POST /requests).
  if (indentLines.length > 0) {
    await notifyRoles(
      ["STORE"],
      { title: `New material indent: ${updated.purchaseOrderItem.productName}`, body: `${indentLines.length} item${indentLines.length > 1 ? "s" : ""} requested`, link: "/inventory" },
      actorId,
    ).catch((err) => logger.error({ err }, "notify failed: pre_production.transition"));
  }

  // A sample just left the Plant for QC — same "new thing needs sign-off"
  // notice as the indent lines above; QC can't confirm receipt of
  // something it doesn't know was sent.
  if (sampleLinesForNotify.length > 0) {
    await notifyRoles(
      ["QA_QC", "RND"],
      { title: `Sample sent for ${updated.purchaseOrderItem.productName}`, body: "Confirm receipt before Sample QC Approval.", link: `/pre-productions/${updated.id}` },
      actorId,
    ).catch((err) => logger.error({ err }, "notify failed: pre_production.transition"));
  }

  // Only a real stage change is worth a notice — a Dispensing forward
  // blocked by the requirement gate above doesn't move, so effectiveTarget
  // (not the originally-requested target) decides whether anything
  // actually changed.
  if (effectiveTarget !== currentStage) {
    const productName = updated.purchaseOrderItem.productName;
    await notifyRoles(
      PRE_PRODUCTION_STAGE_ROLE[effectiveTarget],
      {
        title: `${productName} is now at ${PRE_PRODUCTION_STAGE_LABEL[effectiveTarget]}`,
        body: action === "REJECT" ? `Sent back: ${note}` : "Pre-production in progress.",
        link: `/pre-productions/${updated.id}`,
      },
      actorId,
    ).catch((err) => logger.error({ err }, "notify failed: pre_production.transition"));
  }

  return { ok: true, updated, effectiveTarget, dispensingShortfall };
}
