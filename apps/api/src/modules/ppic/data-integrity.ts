import { prisma } from "../../common/lib/prisma";
import { getMaterialPlanning } from "../purchase-orders/material-planning";
import { batchPast, productionStageOf } from "./production-stage";

/**
 * "Is every product where it should be?": the rules a product's records must always satisfy, and the ONE stage each product is in.
 *
 * The lists on every dashboard tile are meant to show a product only at its own stage, step by step from BD to Dispatch. That only holds
 * if the records themselves are consistent (a product cannot be in Production without both plans, without Regulatory's approval...).
 * This module checks exactly that, and is used by the data-check script and by the tests.
 */

export type ItemStage =
  | "PO_NOT_APPROVED"
  | "CANCELLED"
  | "ON_HOLD" // PPIC's Hold, until the first batch is made (the plan may or may not have been sent to Production)
  | "NOT_PLANNED" // PO approved; the RM plan and/or the Packaging BOM plan not calculated yet
  | "MATERIAL_SHORT" // both plans calculated, not sent to Production, some material short
  | "READY_FOR_PRODUCTION" // both plans calculated, not sent, all material covered
  | "PRE_PRODUCTION" // sent to Production; the run is at Material Received / Indent / Dispensing / Line Clearance
  | "IN_PRODUCTION" // a batch exists, before packaging QA
  | "FINISHED_GOODS" // past the packaging QA gate, not yet handed to Dispatch
  | "DISPATCH" // handed to Dispatch (some may be shipped)
  | "COMPLETED"; // the whole quantity went to the customer

export interface Violation {
  rule: string;
  po: string;
  product: string;
  detail: string;
}

export interface StageRow {
  id: string;
  po: string;
  product: string;
  stage: ItemStage;
  /** PPIC has sent the plan to Production (a held product can be sent or not). */
  planSent: boolean;
  /** Where each batch of the product waits (batch stage ids). */
  batchStages: string[];
  /** Run stage while there is no batch yet (older runs; a per-batch-flow run has no stages of its own). */
  runStage: string | null;
  /** Production has started the run (opened it). */
  runStarted: boolean;
  /** The run is at Line Clearance and QA has not approved it yet. */
  pendingLineClearance: boolean;
  handedOver: boolean;
  /** The Day Store of the run's Plant (where Material Received, Dispensing and the finished goods are handled). */
  dayStoreId: string | null;
  remainingWithDispatch: number;
}

export interface IntegrityReport {
  rows: StageRow[];
  violations: Violation[];
  stages: Map<string, ItemStage>; // purchaseOrderItemId -> stage
  counts: Record<ItemStage, number>;
}

const past = batchPast;

export const ITEM_STAGE_LABEL: Record<ItemStage, string> = {
  PO_NOT_APPROVED: "PO not approved",
  CANCELLED: "Cancelled",
  ON_HOLD: "On hold",
  NOT_PLANNED: "Not planned",
  MATERIAL_SHORT: "Material short",
  READY_FOR_PRODUCTION: "Ready for Production",
  PRE_PRODUCTION: "Pre-production",
  IN_PRODUCTION: "In production",
  FINISHED_GOODS: "Finished goods",
  DISPATCH: "With Dispatch",
  COMPLETED: "Completed",
};

export interface StageFacts {
  poApproved: boolean;
  cancelled: boolean;
  held: boolean;
  rmDone: boolean;
  bomDone: boolean;
  planSent: boolean;
  /** Both plans calculated and some material is short (from Material Planning). */
  isShort: boolean;
  quantity: number;
  batches: { currentStageId: string; prepStageId?: string; handedOverToDispatchAt: Date | null; customerShippedQty: number }[];
}

/** The ONE stage a product is in, from its facts. Everything that names a product's stage (lists, the data check) uses this. */
export function itemStageOf(f: StageFacts): ItemStage {
  if (!f.poApproved) return "PO_NOT_APPROVED";
  if (f.cancelled) return "CANCELLED";
  // On Hold until Production has started making it: batches still in preparation (Indent to Line Clearance) do not count; Production holds those one by one
  if (f.held && !f.batches.some((b) => b.prepStageId === undefined || b.prepStageId === "READY")) return "ON_HOLD";
  if (!f.planSent) return !(f.rmDone && f.bomDone) ? "NOT_PLANNED" : f.isShort ? "MATERIAL_SHORT" : "READY_FOR_PRODUCTION";
  return productionStageOf({ planSentToProductionAt: new Date(0), quantity: f.quantity, batches: f.batches })!;
}

export async function checkDataIntegrity(): Promise<IntegrityReport> {
  const items = await prisma.purchaseOrderItem.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      productName: true,
      quantity: true,
      cancelledAt: true,
      materialHeldAt: true,
      plannedPlantId: true,
      sentToRegulatoryAt: true,
      regulatoryStatus: true,
      planSentToProductionAt: true,
      releasedQty: true,
      purchaseOrder: { select: { poNumber: true, status: true } },
      rmPlans: { where: { status: "CALCULATED" }, select: { id: true } },
      bomPlans: { where: { status: "CALCULATED" }, select: { id: true } },
      preProduction: {
        select: {
          id: true,
          plantId: true,
          batchFlow: true,
          plant: { select: { dayStoreId: true } },
          currentStageId: true,
          sampleQcStatus: true,
          productionBatches: {
            select: {
              id: true,
              batchNo: true,
              status: true,
              prepStageId: true,
              currentStageId: true,
              outputQty: true,
              packApprovedQty: true,
              packQaStatus: true,
              fgQaStatus: true,
              handedOverToDispatchAt: true,
              fgShipments: { select: { type: true, status: true, quantity: true } },
            },
          },
        },
      },
    },
  });

  const planning = await getMaterialPlanning();
  const shortItemIds = new Set(planning.products.filter((p) => p.hasShortfall).map((p) => p.purchaseOrderItemId));

  const rows: StageRow[] = [];
  const violations: Violation[] = [];
  const stages = new Map<string, ItemStage>();
  const counts = Object.fromEntries(
    (["PO_NOT_APPROVED", "CANCELLED", "ON_HOLD", "NOT_PLANNED", "MATERIAL_SHORT", "READY_FOR_PRODUCTION", "PRE_PRODUCTION", "IN_PRODUCTION", "FINISHED_GOODS", "DISPATCH", "COMPLETED"] as ItemStage[]).map((s) => [s, 0]),
  ) as Record<ItemStage, number>;

  for (const item of items) {
    const po = item.purchaseOrder.poNumber ?? "(no number)";
    const bad = (rule: string, detail: string) => violations.push({ rule, po, product: item.productName, detail });
    const rmDone = item.rmPlans.length > 0;
    const bomDone = item.bomPlans.length > 0;
    const run = item.preProduction;
    const batches = run?.productionBatches ?? [];

    if (!(item.quantity > 0)) bad("quantity", "The ordered quantity is not above zero.");

    if (item.purchaseOrder.status !== "APPROVED" && (rmDone || bomDone || item.sentToRegulatoryAt || item.planSentToProductionAt || run)) {
      bad("po-not-approved", "The PO is not approved, yet this product already has a plan, a Regulatory hand-off or a Production run.");
    }
    if (item.sentToRegulatoryAt && !rmDone && !bomDone) bad("regulatory-without-plan", "Sent to Regulatory but no plan is calculated.");
    if (item.regulatoryStatus && !item.sentToRegulatoryAt) bad("regulatory-status-without-hand-off", `Regulatory status is "${item.regulatoryStatus}" but it was never sent to Regulatory.`);
    if (item.materialHeldAt && batches.some((b) => b.prepStageId === "READY")) bad("hold-with-batch", "On Hold, yet Production has already started making a batch.");
    if (item.materialHeldAt && item.cancelledAt) bad("hold-and-cancelled", "On Hold and cancelled at the same time.");

    if (item.planSentToProductionAt) {
      if (!item.plannedPlantId) bad("sent-without-plant", "Sent to Production without a Plant.");
      if (!rmDone) bad("sent-without-rm-plan", "Sent to Production without a calculated RM plan.");
      if (!bomDone) bad("sent-without-bom-plan", "Sent to Production without a calculated Packaging BOM plan.");
      if (item.regulatoryStatus !== "Approved") bad("sent-without-regulatory", `Sent to Production but Regulatory status is "${item.regulatoryStatus ?? "pending"}".`);
    }
    if (run && !item.planSentToProductionAt) bad("run-without-release", "A Production run exists but the plan was never sent to Production.");
    if (run && run.plantId && item.plannedPlantId && run.plantId !== item.plannedPlantId) bad("run-plant-differs", "The Production run is at a different Plant than PPIC assigned.");

    for (const b of batches) {
      const label = `batch ${b.batchNo ?? b.id.slice(0, 6)}`;
      if (b.currentStageId !== "IPQC" && b.status !== "COMPLETED") bad("batch-stage-without-completion", `${label} is at ${b.currentStageId} but was never completed.`);
      if (past(b.currentStageId, "QA_GATE_PACKAGING") && !(b.packApprovedQty && b.packApprovedQty > 0 && b.packQaStatus === "Approved")) {
        bad("batch-fg-without-packaging-approval", `${label} is at ${b.currentStageId} without an approved packed quantity.`);
      }
      if (b.handedOverToDispatchAt && b.fgQaStatus !== "Approved") bad("handed-over-without-fg-approval", `${label} was handed to Dispatch without the finished-goods approval.`);
      if (b.fgShipments.length > 0 && !b.handedOverToDispatchAt) bad("shipment-without-hand-over", `${label} has shipments but was never handed to Dispatch.`);
      const shipped = b.fgShipments.filter((s) => s.type === "CUSTOMER" && s.status === "DISPATCHED").reduce((a, s) => a + s.quantity, 0);
      if (b.packApprovedQty != null && shipped > b.packApprovedQty + 1e-6) bad("shipped-more-than-approved", `${label} shipped ${shipped} but only ${b.packApprovedQty} was approved.`);
    }

    // The one stage this product is in
    const stage = itemStageOf({
      poApproved: item.purchaseOrder.status === "APPROVED",
      cancelled: !!item.cancelledAt,
      held: !!item.materialHeldAt,
      rmDone,
      bomDone,
      planSent: !!item.planSentToProductionAt,
      isShort: shortItemIds.has(item.id),
      quantity: item.quantity,
      batches: batches.map((b) => ({ currentStageId: b.currentStageId, prepStageId: b.prepStageId, handedOverToDispatchAt: b.handedOverToDispatchAt, customerShippedQty: b.fgShipments.filter((s) => s.type === "CUSTOMER" && s.status === "DISPATCHED").reduce((a, s) => a + s.quantity, 0) })),
    });
    stages.set(item.id, stage);
    // What Dispatch has sent on (to the customer or the Warehouse), less what the Warehouse sent back: the same sum as the Dispatch board.
    const sentOutOf = (b: (typeof batches)[number]) =>
      b.fgShipments.filter((s) => s.type !== "FROM_WAREHOUSE" && ["REQUESTED", "ACCEPTED", "SENT", "RECEIVED", "DISPATCHED", "WITH_ACCOUNTS", "READY_TO_SEND", "SENT_BACK"].includes(s.status)).reduce((a, s) => a + s.quantity, 0) -
      b.fgShipments.filter((s) => s.type === "FROM_WAREHOUSE" && s.status === "RECEIVED").reduce((a, s) => a + s.quantity, 0);
    const shippedOf = (b: (typeof batches)[number]) => b.fgShipments.filter((s) => s.type === "CUSTOMER" && s.status === "DISPATCHED").reduce((a, s) => a + s.quantity, 0);
    rows.push({
      id: item.id,
      po,
      product: item.productName,
      stage,
      planSent: !!item.planSentToProductionAt,
      batchStages: batches.filter((b) => b.status === "COMPLETED").map((b) => b.currentStageId), // a batch still in production has no pipeline stage yet
      // a held or cancelled product's run is not Production's or the Day Store's to work on, so it is not "at" a run stage
      runStarted: !!run,
      runStage: run && !run.batchFlow && batches.length === 0 && stage === "PRE_PRODUCTION" ? run.currentStageId : null,
      pendingLineClearance: !!run && !run.batchFlow && batches.length === 0 && stage === "PRE_PRODUCTION" && run.currentStageId === "SAMPLE_QC_APPROVAL" && run.sampleQcStatus !== "Approved",
      handedOver: batches.some((b) => b.handedOverToDispatchAt),
      dayStoreId: run?.plant?.dayStoreId ?? null,
      remainingWithDispatch: batches.filter((b) => b.handedOverToDispatchAt).reduce((a, b) => a + Math.max(0, (b.packApprovedQty ?? 0) - sentOutOf(b)), 0),
    });
    counts[stage] += 1;
  }

  return { rows, violations, stages, counts };
}
