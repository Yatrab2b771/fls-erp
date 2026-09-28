import type { FieldDef } from "../components/FieldGrid";
import type { PreProductionStageId, RoleName } from "./types";

// Mirrors apps/api/src/modules/batches/pre-production-stage.ts — Tier 1
// of the three-tier pipeline: Material Received through Line Clearance
// (Bulk Mfg), one run per PO line item. SAMPLE_QC_APPROVAL is this
// tier's own terminal stage — it completes in place (ready for
// Production to start ProductionBatch runs), it doesn't hand off to a
// next stage here. Field/enum name predates a rename from "Sample QC
// Approval" to "Line Clearance — Bulk Manufacturing" (BMR-1.docx 4.0) —
// see pre-production-stage.ts's own comment. The earlier, separate
// pre-Dispensing Line Clearance stage (BMR 1.0) was removed — only this
// one check belongs in this tier.

export const PRE_PRODUCTION_STAGE_ORDER: PreProductionStageId[] = ["MATERIAL_RECEIVED", "INDENT_ISSUE", "DISPENSING", "SAMPLE_QC_APPROVAL"];

// INDENT_ISSUE is owned by PRODUCTION, per Production Process Flow.docx
// ("Batch Indent/Requisition (By Production)").
export const PRE_PRODUCTION_STAGE_ROLE: Record<PreProductionStageId, RoleName[]> = {
  MATERIAL_RECEIVED: ["STORE"],
  INDENT_ISSUE: ["PRODUCTION"],
  DISPENSING: ["STORE"],
  SAMPLE_QC_APPROVAL: ["QA_QC"],
};

export const PRE_PRODUCTION_STAGE_LABEL: Record<PreProductionStageId, string> = {
  MATERIAL_RECEIVED: "Material Received & GRN",
  INDENT_ISSUE: "Indent Issue",
  DISPENSING: "Dispensing / RM-PM Issue",
  SAMPLE_QC_APPROVAL: "Line Clearance — Bulk Manufacturing",
};

const SAMPLE_QC_STATUSES = ["Approved", "Not Approved", "Hold"] as const;

// The department fields captured at each stage — per Date.docx/
// FLS-MPS.xlsx, mirroring apps/api's PRE_PRODUCTION_STAGE_FIELD_SCHEMA.
export const PRE_PRODUCTION_STAGE_FIELDS: Partial<Record<PreProductionStageId, FieldDef[]>> = {
  MATERIAL_RECEIVED: [
    { name: "grnNo", label: "GRN No.", type: "text" },
    { name: "grnDate", label: "GRN Date", type: "date" },
    { name: "materialReceivedRemarks", label: "Remarks", type: "text" },
  ],
  // Also carries the former Production Plan stage's fields (unit, dispatch
  // plan date), merged onto this one checkpoint.
  INDENT_ISSUE: [
    { name: "prodIndentSlipSign", label: "Prod. Indent Slip Sign", type: "text" },
    { name: "productionPlanDate", label: "Production Plan Date", type: "date" },
    { name: "unit", label: "Unit", type: "text" },
    { name: "dispatchPlanDate", label: "Dispatch Plan Date", type: "date" },
  ],
  DISPENSING: [
    { name: "rmDispensingDate", label: "RM Dispensing Date", type: "date" },
    { name: "rmDispensingRemarks", label: "RM Dispensing Remarks", type: "text" },
    { name: "pmIssuedDate", label: "PM Issued Date", type: "date" },
    { name: "pmDispensingRemarks", label: "PM Dispensing Remarks", type: "text" },
  ],
  // The gate itself — "status + remarks". FORWARD is blocked unless this
  // reads literally "Approved" — see pre-production-transition.ts's
  // isSampleQcBlocked. Own terminal stage: forwarding again just re-saves
  // in place. The itemized checklist behind this sign-off (BMR 4.0) is
  // rendered separately — see PreProductionDetailPage.tsx.
  SAMPLE_QC_APPROVAL: [
    { name: "sampleQcStatus", label: "Line Clearance Status", type: "select", options: SAMPLE_QC_STATUSES },
    { name: "sampleQcRemarks", label: "Remarks", type: "text" },
  ],
};

export function getForwardTarget(stage: PreProductionStageId): PreProductionStageId {
  if (stage === "SAMPLE_QC_APPROVAL") return "SAMPLE_QC_APPROVAL"; // terminal — completes in place
  const idx = PRE_PRODUCTION_STAGE_ORDER.indexOf(stage);
  return PRE_PRODUCTION_STAGE_ORDER[idx + 1] ?? stage;
}

export function getRejectTarget(stage: PreProductionStageId): PreProductionStageId | null {
  const idx = PRE_PRODUCTION_STAGE_ORDER.indexOf(stage);
  return idx > 0 ? PRE_PRODUCTION_STAGE_ORDER[idx - 1]! : null;
}
