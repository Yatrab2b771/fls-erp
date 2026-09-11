/**
 * The PreProduction pipeline definition — Tier 1 of the three-tier
 * pipeline (see schema.prisma's own comment block above the PreProduction
 * model for the full picture). This is the material-readiness half:
 * Material Received through Sample QC Approval, done once per PO line
 * item regardless of how many smaller ProductionBatch runs manufacturing
 * itself gets split into.
 *
 * This is process definition, not data: fixed and not user-editable, same
 * rationale as the category constants in packaging-bom/bom-engine.ts.
 */

import type { RoleName } from "@prisma/client";

export type PreProductionStageId = "MATERIAL_RECEIVED" | "INDENT_ISSUE" | "LINE_CLEARANCE" | "DISPENSING" | "SAMPLE_QC_APPROVAL";

export const PRE_PRODUCTION_STAGE_ORDER: PreProductionStageId[] = ["MATERIAL_RECEIVED", "INDENT_ISSUE", "LINE_CLEARANCE", "DISPENSING", "SAMPLE_QC_APPROVAL"];

export const PRE_PRODUCTION_STAGE_ROLE: Record<PreProductionStageId, RoleName[]> = {
  MATERIAL_RECEIVED: ["STORE"],
  INDENT_ISSUE: ["PPIC"],
  LINE_CLEARANCE: ["QA_QC"],
  DISPENSING: ["STORE"],
  SAMPLE_QC_APPROVAL: ["QA_QC"],
};

export const PRE_PRODUCTION_STAGE_LABEL: Record<PreProductionStageId, string> = {
  MATERIAL_RECEIVED: "Material Received & GRN",
  INDENT_ISSUE: "Indent Issue",
  LINE_CLEARANCE: "Line Clearance",
  DISPENSING: "Dispensing / RM-PM Issue",
  SAMPLE_QC_APPROVAL: "Sample QC Approval",
};

// SAMPLE_QC_APPROVAL is this pipeline's own terminal stage — "forward"
// here just means the run is ready (Approved); what happens next is a
// different action entirely (Production creating one or more
// ProductionBatch rows against it, see production-batches.routes.ts),
// not another PreProduction stage to walk into. Same "completes in
// place" shape CombinedLot's own DISPATCH_PLAN uses.
export function getForwardTarget(stage: PreProductionStageId): PreProductionStageId {
  if (stage === "SAMPLE_QC_APPROVAL") return "SAMPLE_QC_APPROVAL";
  const idx = PRE_PRODUCTION_STAGE_ORDER.indexOf(stage);
  return PRE_PRODUCTION_STAGE_ORDER[idx + 1] ?? stage;
}

export function getRejectTarget(stage: PreProductionStageId): PreProductionStageId | null {
  const idx = PRE_PRODUCTION_STAGE_ORDER.indexOf(stage);
  return idx > 0 ? PRE_PRODUCTION_STAGE_ORDER[idx - 1]! : null;
}

export function stageIndex(stage: PreProductionStageId): number {
  return PRE_PRODUCTION_STAGE_ORDER.indexOf(stage);
}

export const ALL_PRE_PRODUCTION_STAGE_IDS: PreProductionStageId[] = PRE_PRODUCTION_STAGE_ORDER;

/** ADMIN always passes, matching requireRole()'s override elsewhere in the app. */
export function actorCanActOnStage(stage: PreProductionStageId, actorRoles: RoleName[]): boolean {
  if (actorRoles.includes("ADMIN" as RoleName)) return true;
  return PRE_PRODUCTION_STAGE_ROLE[stage].some((r) => actorRoles.includes(r));
}
