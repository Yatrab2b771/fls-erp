import type { FieldDef } from "../components/FieldGrid";
import type { BatchStageId, RoleName } from "./types";

// Mirrors apps/api/src/modules/batches/batch-stage.ts — the Batch
// pipeline given directly by the business (Customer Order → Draft PO →
// BD Approve/Reject → PO Release → per-line Batch Creation → this
// 9-step per-batch sequence).

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

const RM_PM_STATUSES = ["Available", "Partial Available"] as const;
const MFG_APPROVAL_STATUSES = ["Approved", "Not Approved", "Hold"] as const;
const PACK_APPROVAL_STATUSES = ["Approved", "Not approved"] as const;
const TRANSPORT_TYPES = ["By Land", "By Courier", "By Air"] as const;
const CUSTOMER_CONFIRMATIONS = ["Received", "Not Received"] as const;
// Common process-phase names for the two free-text status fields below —
// offered as a combobox, not a strict enum, since the actual phase varies
// by product and this list can't be exhaustive.
const MANUFACTURING_STATUSES = ["Not Started", "Blending", "Mixing", "Filling", "Capping", "In Progress", "Completed", "On Hold"] as const;
const PACKAGING_STATUSES = ["Not Started", "Labelling", "Cartoning", "Sealing", "Shrink Wrapping", "In Progress", "Completed", "On Hold"] as const;

// The department fields captured at each stage — per Date.docx/
// FLS-MPS.xlsx, mirroring apps/api's BATCH_STAGE_FIELD_SCHEMA exactly.
// Stages not listed here are status-only (the transition itself, plus an
// optional note, is their entire record).
export const BATCH_STAGE_FIELDS: Partial<Record<BatchStageId, FieldDef[]>> = {
  PO_RELEASE: [
    { name: "rmPoDate", label: "RM PO Date", type: "date" },
    { name: "rmExpectedDate", label: "RM Expected Date", type: "date" },
    { name: "rmStatus", label: "RM Status", type: "select", options: RM_PM_STATUSES },
    { name: "rmRemarks", label: "RM Remarks", type: "text" },
    { name: "pmPoDate", label: "PM PO Date", type: "date" },
    { name: "pmExpectedDate", label: "PM Expected Date", type: "date" },
    { name: "pmStatus", label: "PM Status", type: "select", options: RM_PM_STATUSES },
    { name: "pmRemarks", label: "PM Remarks", type: "text" },
  ],
  // Also carries the former Production Plan stage's fields (unit, dispatch
  // plan date) — PPIC already owned both stages.
  INDENT_ISSUE: [
    { name: "batchNo", label: "Batch No.", type: "text" },
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
  PRODUCTION_EXECUTION: [
    { name: "manufacturingStartDate", label: "Start Date", type: "date" },
    { name: "manufacturingStatus", label: "Manufacturing Status", type: "combo", options: MANUFACTURING_STATUSES },
    { name: "manufacturingEndDate", label: "End Date", type: "date" },
    { name: "manufacturingRemarks", label: "Remarks", type: "text" },
    // Wastage — inputQty/outputQty in, wastageQty/wastagePct derived
    // (see computeWastage in batch.engine.ts, mirrored client-side).
    { name: "inputQty", label: "Input Qty", type: "number" },
    { name: "outputQty", label: "Output Qty", type: "number" },
  ],
  QA_GATE_MFG: [
    { name: "mfgQaStatus", label: "QA Status", type: "select", options: MFG_APPROVAL_STATUSES },
    { name: "mfgQcStatus", label: "QC Status", type: "select", options: MFG_APPROVAL_STATUSES },
    { name: "mfgRemarks", label: "Remarks", type: "text" },
    // Quality rejection — independent of Production's wastage above.
    { name: "mfgRejectedQty", label: "Rejected Qty (quality)", type: "number" },
  ],
  PACKAGING: [
    { name: "packagingStartDate", label: "Start Date", type: "date" },
    { name: "packagingStatus", label: "Packaging Status", type: "combo", options: PACKAGING_STATUSES },
    { name: "packagingEndDate", label: "End Date", type: "date" },
    { name: "packagingRemarks", label: "Remarks", type: "text" },
  ],
  QA_GATE_PACKAGING: [
    { name: "packQaStatus", label: "QA Status", type: "select", options: PACK_APPROVAL_STATUSES },
    { name: "packQcStatus", label: "QC Status", type: "select", options: PACK_APPROVAL_STATUSES },
    { name: "packRemarks", label: "Remarks", type: "text" },
  ],
  DISPATCH_PLAN: [
    { name: "dispatchDate", label: "Dispatch Date", type: "date" },
    { name: "dispatchedQty", label: "Dispatched Qty", type: "number" },
    { name: "shipperQty", label: "Shipper Qty", type: "number" },
    { name: "totalShipperWeight", label: "Total Shipper Weight", type: "number" },
    { name: "transportType", label: "Type of Transport", type: "select", options: TRANSPORT_TYPES },
    { name: "remainingQty", label: "Remaining Qty", type: "number" },
    { name: "customerConfirmation", label: "Customer Confirmation", type: "select", options: CUSTOMER_CONFIRMATIONS },
    { name: "anyRemarks", label: "Any Remarks", type: "text" },
  ],
};

// Every stage now sends back to whichever stage precedes it — no override
// table needed (that was Incoming QC → Debit Note Issue, both removed).
export function getForwardTarget(stage: BatchStageId): BatchStageId {
  if (stage === "DISPATCH_PLAN") return "DISPATCH_PLAN"; // terminal — completes in place
  const idx = BATCH_STAGE_ORDER.indexOf(stage);
  return BATCH_STAGE_ORDER[idx + 1] ?? stage;
}

export function getRejectTarget(stage: BatchStageId): BatchStageId | null {
  if (stage === "PO_RELEASE") return null;
  const idx = BATCH_STAGE_ORDER.indexOf(stage);
  return idx > 0 ? BATCH_STAGE_ORDER[idx - 1]! : null;
}
