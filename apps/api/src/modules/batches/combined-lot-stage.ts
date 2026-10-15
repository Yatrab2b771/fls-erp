/**
 * The CombinedLot pipeline definition — Tier 3 of the three-tier pipeline
 * (see schema.prisma's own comment block above the CombinedLot model for
 * the full picture). This is the old single-Batch pipeline's back half —
 * IPQC through Dispatch Plan — now done exactly once per pooled lot
 * instead of once per small ProductionBatch manufacturing run.
 *
 * This is process definition, not data: fixed and not user-editable, same
 * rationale as the category constants in packaging-bom/bom-engine.ts.
 */

import type { RoleName } from "@prisma/client";

export type CombinedLotStageId =
  | "IPQC"
  | "QA_GATE_MFG"
  | "BULK_QC"
  | "PACKAGING"
  | "QA_GATE_PACKAGING"
  | "FG_STORE"
  | "FG_QC_RELEASE"
  | "BILLING_EWAY_BILL"
  | "DISPATCH_PLAN"
  // ProductionBatch only: finished goods approved by QA, with the Day Store, ready to hand over to Dispatch.
  | "FG_HANDOVER";

export const COMBINED_LOT_STAGE_ORDER: CombinedLotStageId[] = [
  "IPQC",
  "QA_GATE_MFG",
  "BULK_QC",
  "PACKAGING",
  "QA_GATE_PACKAGING",
  "FG_STORE",
  "FG_QC_RELEASE",
  "BILLING_EWAY_BILL",
  "DISPATCH_PLAN",
];

// Production Process Flow.docx tags "Bulk QC Sampling & Testing" as
// R&D's own work, not QA's — per the client's 2026-09-28 call, this is
// now RND-only (previously QA_QC + RND together).
export const COMBINED_LOT_STAGE_ROLE: Record<CombinedLotStageId, RoleName[]> = {
  IPQC: ["QA_QC"],
  QA_GATE_MFG: ["QA_QC"],
  BULK_QC: ["RND"],
  PACKAGING: ["PRODUCTION"],
  QA_GATE_PACKAGING: ["QA_QC"],
  FG_STORE: ["STORE"],
  FG_QC_RELEASE: ["QA_QC"],
  BILLING_EWAY_BILL: ["ACCOUNTS"],
  DISPATCH_PLAN: ["DISPATCH"],
  FG_HANDOVER: ["STORE"],
};

export const COMBINED_LOT_STAGE_LABEL: Record<CombinedLotStageId, string> = {
  IPQC: "In-Process QA (IPQC)",
  QA_GATE_MFG: "QA Gate — Manufacturing",
  BULK_QC: "Bulk QC",
  PACKAGING: "Packaging",
  QA_GATE_PACKAGING: "QA Gate — Packaging",
  FG_STORE: "FG Store",
  FG_QC_RELEASE: "Finished Goods QC & Release",
  BILLING_EWAY_BILL: "Billing & E-Way Bill",
  DISPATCH_PLAN: "Dispatch Plan",
  FG_HANDOVER: "Hand over to Dispatch",
};

export function getForwardTarget(stage: CombinedLotStageId): CombinedLotStageId {
  // DISPATCH_PLAN is the last stage, but Dispatch still needs to record
  // its own fields (dispatch date/qty/transport) once the lot reaches
  // it — "forward" here completes the lot in place rather than erroring
  // with nowhere left to go.
  if (stage === "DISPATCH_PLAN") return "DISPATCH_PLAN";
  const idx = COMBINED_LOT_STAGE_ORDER.indexOf(stage);
  return COMBINED_LOT_STAGE_ORDER[idx + 1] ?? stage;
}

export function getRejectTarget(stage: CombinedLotStageId): CombinedLotStageId | null {
  const idx = COMBINED_LOT_STAGE_ORDER.indexOf(stage);
  return idx > 0 ? COMBINED_LOT_STAGE_ORDER[idx - 1]! : null;
}

export function stageIndex(stage: CombinedLotStageId): number {
  return COMBINED_LOT_STAGE_ORDER.indexOf(stage);
}

export const ALL_COMBINED_LOT_STAGE_IDS: CombinedLotStageId[] = COMBINED_LOT_STAGE_ORDER;

/** ADMIN always passes, matching requireRole()'s override elsewhere in the app. */
export function actorCanActOnStage(stage: CombinedLotStageId, actorRoles: RoleName[]): boolean {
  if (actorRoles.includes("ADMIN" as RoleName)) return true;
  return COMBINED_LOT_STAGE_ROLE[stage].some((r) => actorRoles.includes(r));
}

// --- ProductionBatch's own order. A batch no longer walks Billing and Dispatch Plan as stages: after QA approves the finished goods
// (held by the Day Store of its Plant) the Day Store hands them to Dispatch, and what Dispatch does next is a list of shipments (to the
// customer or the Warehouse, see FgShipment). Batches that were already past FG QC & Release (Billing, Dispatch Plan) finish the old way. ---
export const PRODUCTION_BATCH_STAGE_ORDER: CombinedLotStageId[] = ["IPQC", "QA_GATE_MFG", "BULK_QC", "PACKAGING", "QA_GATE_PACKAGING", "FG_STORE", "FG_QC_RELEASE", "FG_HANDOVER"];

export function getBatchForwardTarget(stage: CombinedLotStageId): CombinedLotStageId {
  if (stage === "BILLING_EWAY_BILL" || stage === "DISPATCH_PLAN") return getForwardTarget(stage); // older batches finish the old way
  if (stage === "FG_HANDOVER") return stage; // the end of the pipeline: forward means "handed over"
  const idx = PRODUCTION_BATCH_STAGE_ORDER.indexOf(stage);
  return PRODUCTION_BATCH_STAGE_ORDER[idx + 1] ?? stage;
}

export function getBatchRejectTarget(stage: CombinedLotStageId): CombinedLotStageId | null {
  if (stage === "BILLING_EWAY_BILL" || stage === "DISPATCH_PLAN") return getRejectTarget(stage);
  const idx = PRODUCTION_BATCH_STAGE_ORDER.indexOf(stage);
  return idx > 0 ? PRODUCTION_BATCH_STAGE_ORDER[idx - 1]! : null;
}
