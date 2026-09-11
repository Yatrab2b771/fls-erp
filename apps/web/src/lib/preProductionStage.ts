import type { FieldDef } from "../components/FieldGrid";
import type { PreProductionStageId, RoleName } from "./types";

// Mirrors apps/api/src/modules/batches/pre-production-stage.ts — Tier 1
// of the three-tier pipeline: Material Received through Sample QC
// Approval, one run per PO line item. SAMPLE_QC_APPROVAL is this tier's
// own terminal stage — it completes in place (ready for Production to
// start ProductionBatch runs), it doesn't hand off to a next stage here.

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

const SAMPLE_QC_STATUSES = ["Approved", "Not Approved", "Hold"] as const;
const LINE_CLEARANCE_STATUSES = ["Approved", "Not Approved", "Hold"] as const;

// The department fields captured at each stage — per Date.docx/
// FLS-MPS.xlsx, mirroring apps/api's PRE_PRODUCTION_STAGE_FIELD_SCHEMA.
export const PRE_PRODUCTION_STAGE_FIELDS: Partial<Record<PreProductionStageId, FieldDef[]>> = {
  MATERIAL_RECEIVED: [
    { name: "grnNo", label: "GRN No.", type: "text" },
    { name: "grnDate", label: "GRN Date", type: "date" },
    { name: "materialReceivedRemarks", label: "Remarks", type: "text" },
  ],
  // Also carries the former Production Plan stage's fields (unit, dispatch
  // plan date) — PPIC already owned both stages.
  INDENT_ISSUE: [
    { name: "prodIndentSlipSign", label: "Prod. Indent Slip Sign", type: "text" },
    { name: "productionPlanDate", label: "Production Plan Date", type: "date" },
    { name: "unit", label: "Unit", type: "text" },
    { name: "dispatchPlanDate", label: "Dispatch Plan Date", type: "date" },
  ],
  LINE_CLEARANCE: [
    { name: "lineClearanceStatus", label: "Line Clearance Status", type: "select", options: LINE_CLEARANCE_STATUSES },
    { name: "lineClearanceRemarks", label: "Remarks", type: "text" },
  ],
  DISPENSING: [
    { name: "rmDispensingDate", label: "RM Dispensing Date", type: "date" },
    { name: "rmDispensingRemarks", label: "RM Dispensing Remarks", type: "text" },
    { name: "pmIssuedDate", label: "PM Issued Date", type: "date" },
    { name: "pmDispensingRemarks", label: "PM Dispensing Remarks", type: "text" },
  ],
  // The gate itself — "status + remarks", same shape as Line Clearance
  // above. FORWARD is blocked unless this reads literally "Approved" —
  // see pre-production-transition.ts's isSampleQcBlocked. Own terminal
  // stage: forwarding again just re-saves in place.
  SAMPLE_QC_APPROVAL: [
    { name: "sampleQcStatus", label: "Sample QC Status", type: "select", options: SAMPLE_QC_STATUSES },
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
