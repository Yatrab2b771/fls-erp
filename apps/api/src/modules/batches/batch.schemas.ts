import { z } from "zod";
import { ALL_BATCH_STAGE_IDS, type BatchStageId } from "./batch-stage";

const dateField = z.coerce.date().optional();
const RM_PM_STATUSES = ["Available", "Partial Available"] as const;
const MFG_APPROVAL_STATUSES = ["Approved", "Not Approved", "Hold"] as const;
const PACK_APPROVAL_STATUSES = ["Approved", "Not approved"] as const;
const TRANSPORT_TYPES = ["By Land", "By Courier", "By Air"] as const;
const CUSTOMER_CONFIRMATIONS = ["Received", "Not Received"] as const;

export const createBatchSchema = z.object({
  purchaseOrderItemId: z.string().uuid(),
  batchNo: z.string().max(120).optional(),
});

// One schema per stage that actually has data-entry fields (per
// Date.docx/FLS-MPS.xlsx) — status-only stages (Material Received, GRN
// Done, Billing & E-Way Bill) have no entry here; the transition itself
// (forward/reject + a note) is their entire record.
export const poReleaseFieldsSchema = z.object({
  rmPoDate: dateField,
  rmExpectedDate: dateField,
  rmStatus: z.enum(RM_PM_STATUSES).optional(),
  rmRemarks: z.string().max(1000).optional(),
  pmPoDate: dateField,
  pmExpectedDate: dateField,
  pmStatus: z.enum(RM_PM_STATUSES).optional(),
  pmRemarks: z.string().max(1000).optional(),
});

// Also carries the former Production Plan stage's fields (unit, dispatch
// plan date) — PPIC already owned both stages, so they're merged onto the
// one PPIC checkpoint that's left in the simplified pipeline.
export const indentIssueFieldsSchema = z.object({
  batchNo: z.string().max(120).optional(),
  prodIndentSlipSign: z.string().max(200).optional(),
  productionPlanDate: dateField,
  unit: z.string().max(40).optional(),
  dispatchPlanDate: dateField,
});

export const dispensingFieldsSchema = z.object({
  rmDispensingDate: dateField,
  rmDispensingRemarks: z.string().max(1000).optional(),
  pmIssuedDate: dateField,
  pmDispensingRemarks: z.string().max(1000).optional(),
});

export const productionExecutionFieldsSchema = z.object({
  manufacturingStartDate: dateField,
  manufacturingStatus: z.string().max(120).optional(),
  manufacturingEndDate: dateField,
  manufacturingRemarks: z.string().max(1000).optional(),
});

export const qaGateMfgFieldsSchema = z.object({
  mfgQaStatus: z.enum(MFG_APPROVAL_STATUSES).optional(),
  mfgQcStatus: z.enum(MFG_APPROVAL_STATUSES).optional(),
  mfgRemarks: z.string().max(1000).optional(),
});

export const packagingFieldsSchema = z.object({
  packagingStartDate: dateField,
  packagingStatus: z.string().max(120).optional(),
  packagingEndDate: dateField,
  packagingRemarks: z.string().max(1000).optional(),
});

export const qaGatePackagingFieldsSchema = z.object({
  packQaStatus: z.enum(PACK_APPROVAL_STATUSES).optional(),
  packQcStatus: z.enum(PACK_APPROVAL_STATUSES).optional(),
  packRemarks: z.string().max(1000).optional(),
});

export const dispatchPlanFieldsSchema = z.object({
  dispatchDate: dateField,
  dispatchedQty: z.coerce.number().nonnegative().optional(),
  shipperQty: z.coerce.number().nonnegative().optional(),
  totalShipperWeight: z.coerce.number().nonnegative().optional(),
  transportType: z.enum(TRANSPORT_TYPES).optional(),
  remainingQty: z.coerce.number().nonnegative().optional(),
  customerConfirmation: z.enum(CUSTOMER_CONFIRMATIONS).optional(),
  anyRemarks: z.string().max(1000).optional(),
});

export const BATCH_STAGE_FIELD_SCHEMA: Partial<Record<BatchStageId, z.AnyZodObject>> = {
  PO_RELEASE: poReleaseFieldsSchema,
  INDENT_ISSUE: indentIssueFieldsSchema,
  DISPENSING: dispensingFieldsSchema,
  PRODUCTION_EXECUTION: productionExecutionFieldsSchema,
  QA_GATE_MFG: qaGateMfgFieldsSchema,
  PACKAGING: packagingFieldsSchema,
  QA_GATE_PACKAGING: qaGatePackagingFieldsSchema,
  DISPATCH_PLAN: dispatchPlanFieldsSchema,
};

// The transition envelope — action + optional note, validated up front;
// the stage-specific fields (if any) are validated separately against
// BATCH_STAGE_FIELD_SCHEMA in the route, since which fields are allowed
// depends on which stage the batch is currently sitting at. JUMP is the
// admin-only override (see batches.routes.ts) — it needs a targetStageId
// since, unlike forward/reject, there's no single implied destination.
export const transitionEnvelopeSchema = z.object({
  action: z.enum(["FORWARD", "REJECT", "JUMP"]),
  // Required on reject — "send it back" needs a reason, matching the real
  // business rule (a batch doesn't bounce back silently).
  note: z.string().max(1000).optional(),
  targetStageId: z.enum(ALL_BATCH_STAGE_IDS as [BatchStageId, ...BatchStageId[]]).optional(),
});

export type CreateBatchInput = z.infer<typeof createBatchSchema>;
export type TransitionEnvelopeInput = z.infer<typeof transitionEnvelopeSchema>;
