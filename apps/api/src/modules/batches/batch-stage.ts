/**
 * The Batch pipeline definition — the flow given directly by the business
 * (Customer Order → Draft PO → BD Approve/Reject → PO Release → per-line
 * Batch Creation → this 9-step per-batch sequence). Simplified down from
 * an earlier reconstruction off FLS's ERP diagram, which additionally had
 * Bill Updates, Incoming QC (+ its Debit Note Issue reject branch), and
 * Production Plan as separate stages — deliberately dropped here; see the
 * schema.prisma comment on BatchStageId for the tradeoff.
 *
 * This is process definition, not data: fixed and not user-editable, same
 * rationale as the category constants in packaging-bom/bom-engine.ts.
 */

import type { RoleName } from "@prisma/client";

export type BatchStageId =
  | "PO_RELEASE"
  | "MATERIAL_RECEIVED"
  | "INDENT_ISSUE"
  | "DISPENSING"
  | "PRODUCTION_EXECUTION"
  | "QA_GATE_MFG"
  | "PACKAGING"
  | "QA_GATE_PACKAGING"
  | "BILLING_EWAY_BILL"
  | "DISPATCH_PLAN";

export const BATCH_STAGE_ORDER: BatchStageId[] = [
  "PO_RELEASE",
  "MATERIAL_RECEIVED",
  "INDENT_ISSUE",
  "DISPENSING",
  "PRODUCTION_EXECUTION",
  "QA_GATE_MFG",
  "PACKAGING",
  "QA_GATE_PACKAGING",
  "BILLING_EWAY_BILL",
  "DISPATCH_PLAN",
];

export const BATCH_STAGE_ROLE: Record<BatchStageId, RoleName> = {
  PO_RELEASE: "PURCHASE",
  MATERIAL_RECEIVED: "STORE",
  INDENT_ISSUE: "PPIC",
  DISPENSING: "STORE",
  PRODUCTION_EXECUTION: "PRODUCTION",
  QA_GATE_MFG: "QA_QC",
  PACKAGING: "PRODUCTION",
  QA_GATE_PACKAGING: "QA_QC",
  BILLING_EWAY_BILL: "ACCOUNTS",
  DISPATCH_PLAN: "DISPATCH",
};

export const BATCH_STAGE_LABEL: Record<BatchStageId, string> = {
  PO_RELEASE: "PO Release",
  MATERIAL_RECEIVED: "Material Received & GRN",
  INDENT_ISSUE: "Indent Issue",
  DISPENSING: "Dispensing / RM-PM Issue",
  PRODUCTION_EXECUTION: "Production Execution",
  QA_GATE_MFG: "QA Gate — Manufacturing",
  PACKAGING: "Packaging",
  QA_GATE_PACKAGING: "QA Gate — Packaging",
  BILLING_EWAY_BILL: "Billing & E-Way Bill",
  DISPATCH_PLAN: "Dispatch Plan",
};

// No reject-destination exceptions anymore (that was Incoming QC → Debit
// Note Issue, both removed) — every stage now sends back to whichever
// stage precedes it, no override table needed.
export function getForwardTarget(stage: BatchStageId): BatchStageId | null {
  // DISPATCH_PLAN is the last stage, but Dispatch still needs to record
  // its own fields (dispatch date/qty/transport/customer confirmation)
  // once the batch reaches them — "forward" here completes the batch in
  // place rather than erroring with nowhere left to go.
  if (stage === "DISPATCH_PLAN") return "DISPATCH_PLAN";
  const idx = BATCH_STAGE_ORDER.indexOf(stage);
  return idx === -1 ? null : (BATCH_STAGE_ORDER[idx + 1] ?? null);
}

export function getRejectTarget(stage: BatchStageId): BatchStageId | null {
  if (stage === "PO_RELEASE") return null; // nothing before this
  const idx = BATCH_STAGE_ORDER.indexOf(stage);
  return idx > 0 ? BATCH_STAGE_ORDER[idx - 1]! : null;
}

export function stageIndex(stage: BatchStageId): number {
  return BATCH_STAGE_ORDER.indexOf(stage);
}

// Every stage a batch can sit at — used to validate an admin's jump
// target.
export const ALL_BATCH_STAGE_IDS: BatchStageId[] = BATCH_STAGE_ORDER;

/** ADMIN always passes, matching requireRole()'s override elsewhere in the app. */
export function actorCanActOnStage(stage: BatchStageId, actorRoles: RoleName[]): boolean {
  if (actorRoles.includes("ADMIN" as RoleName)) return true;
  return actorRoles.includes(BATCH_STAGE_ROLE[stage]);
}
