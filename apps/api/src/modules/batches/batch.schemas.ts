import { z } from "zod";
import { ALL_PRE_PRODUCTION_STAGE_IDS, type PreProductionStageId } from "./pre-production-stage";
import { ALL_COMBINED_LOT_STAGE_IDS, type CombinedLotStageId } from "./combined-lot-stage";

const dateField = z.coerce.date().optional();
const MFG_APPROVAL_STATUSES = ["Approved", "Not Approved", "Hold"] as const;
const PACK_APPROVAL_STATUSES = ["Approved", "Not approved", "Hold"] as const;
const SAMPLE_QC_STATUSES = ["Approved", "Not Approved", "Hold"] as const;
const LINE_CLEARANCE_STATUSES = ["Approved", "Not Approved", "Hold"] as const;
const IPQC_STATUSES = ["Approved", "Not Approved", "Hold"] as const;
const BULK_QC_STATUSES = ["Approved", "Not Approved", "Hold"] as const;
const COA_RESULTS = ["Complies", "Does Not Comply"] as const;
const COA_SIGN_STEPS = ["ANALYZED", "REVIEWED", "APPROVED"] as const;
const TRANSPORT_TYPES = ["By Land", "By Courier", "By Air"] as const;
const CONSUMPTION_PURPOSES = ["PRODUCTION", "SAMPLE", "WASTE"] as const;

// ---------------------------------------------------------------------------
// Tier 1 — PreProduction. One row per PO line item — the plannedQty
// carve-out that used to sit on the old single Batch model (letting a PO
// item split across several batches) is gone: a PreProduction run
// covers the item's whole ordered quantity now, so there's nothing left
// to plan-and-split at this creation step.
// ---------------------------------------------------------------------------

// PreProduction rows are created automatically the moment PPIC's own
// planning has cleared for a PO item (see pre-production.routes.ts POST
// /) — there's no separate "batch number" concept to assign up front any
// more, batchNo now belongs to each individual ProductionBatch run.
export const createPreProductionSchema = z.object({
  purchaseOrderItemId: z.string().uuid(),
  // Which Plant this run's material is dispensed at — optional at
  // creation, but needed before Dispensing can log real RM/PM
  // consumption against it. Settable here or later via PATCH.
  plantId: z.string().uuid().optional(),
  // Explicit override for the PO Readiness gate (see
  // pre-production.routes.ts POST /) — set only on a resend after the
  // caller has already seen and accepted the 409 shortfall warning, same
  // shape as confirmPartialDispatch on the CombinedLot side.
  confirmNotReady: z.boolean().optional(),
});

// Assigning/changing a run's Plant after creation — its own tiny schema
// since it's not a stage transition, just metadata PPIC can fix any time
// (e.g. the run was created before a Plant was picked).
export const updatePreProductionPlantSchema = z.object({ plantId: z.string().uuid().nullable() });

export const materialReceivedFieldsSchema = z.object({
  grnNo: z.string().max(120).optional(),
  grnDate: dateField,
  materialReceivedRemarks: z.string().max(1000).optional(),
  // Optional traceability link to the real Warehouse GRN — an
  // InventoryTransaction(type: RECEIVED) — see schema.prisma's comment on
  // PreProduction.sourceReceiptId. null clears an existing link.
  sourceReceiptId: z.string().uuid().optional().nullable(),
});

// Also carries the former Production Plan stage's fields (unit, dispatch
// plan date) — PPIC already owned both stages, so they're merged onto the
// one PPIC checkpoint that's left in the simplified pipeline.
export const indentIssueFieldsSchema = z.object({
  prodIndentSlipSign: z.string().max(200).optional(),
  productionPlanDate: dateField,
  unit: z.string().max(40).optional(),
  dispatchPlanDate: dateField,
});

// Real material-indent lines logged alongside Indent Issue — same shape
// as dispensingConsumptionSchema below, but these create InventoryRequest
// rows (Store's actual "what leaves the shelf for Production" gate)
// tagged to this run, instead of BatchMaterialConsumption. Optional: a
// run can still move through Indent Issue with just prodIndentSlipSign,
// same as before this existed — this only closes the gap for teams that
// want the sign-off backed by a real, trackable request.
export const indentRequestLinesSchema = z
  .array(
    z.object({
      itemId: z.string().uuid(),
      category: z.enum(["RM", "PM"]),
      requestedQty: z.coerce.number().positive(),
      neededBy: z.coerce.date().optional(),
      note: z.string().max(500).optional(),
    }),
  )
  .max(50)
  .optional();

export const dispensingFieldsSchema = z.object({
  rmDispensingDate: dateField,
  rmDispensingRemarks: z.string().max(1000).optional(),
  pmIssuedDate: dateField,
  pmDispensingRemarks: z.string().max(1000).optional(),
});

// Real RM/PM consumption lines logged alongside Dispensing — separate
// from dispensingFieldsSchema (which is flat scalar fields merged
// straight into PreProduction) because this is a repeatable list that
// creates BatchMaterialConsumption rows instead, validated and handled
// on its own in the route. Optional: a run can still move through
// Dispensing with just the date/remark fields, same as before this
// existed. purpose splits each line three ways — PRODUCTION (counts
// toward the formulation's required quantities, see
// getRequiredDispensingItems in dispensing-requirements.ts), SAMPLE
// (routed on to the QC Sample Store ahead of the SAMPLE_QC_APPROVAL
// gate), WASTE (routed straight to the Recycle Store — see the
// ISSUED_RECYCLE handling in pre-production-transition.ts). Defaults to
// PRODUCTION so existing callers that don't send it keep behaving
// exactly as before this split existed.
// grossWeight/tareWeight/arNo are the Dispensing Sheet's own weighing
// fields (BMR-1.docx 3.0) — all optional, same carve-out as everything
// else here: a line still saves with just quantity/unit if that's all
// that's given.
export const dispensingConsumptionSchema = z
  .array(
    z.object({
      itemId: z.string().uuid(),
      quantity: z.coerce.number().positive(),
      unit: z.string().min(1).max(40),
      purpose: z.enum(CONSUMPTION_PURPOSES).default("PRODUCTION"),
      grossWeight: z.coerce.number().nonnegative().optional(),
      tareWeight: z.coerce.number().nonnegative().optional(),
      arNo: z.string().max(120).optional(),
    }),
  )
  .max(200)
  .optional();

// The pre-production hard gate — QC must literally set "Approved" here
// (see isSampleQcBlocked in pre-production-transition.ts) before FORWARD
// can complete this run's own pipeline. "Hold" and "Not Approved" both
// block, same two-tier severity as the QA_GATE_* stages, but unlike
// those this stage blocks on anything other than "Approved" (not just
// "Hold") — the business rule confirmed by the client is that production
// simply cannot start on an unapproved sample.
export const sampleQcApprovalFieldsSchema = z.object({
  sampleQcStatus: z.enum(SAMPLE_QC_STATUSES).optional(),
  sampleQcRemarks: z.string().max(1000).optional(),
});

// Same "must literally read Approved" shape as Sample QC Approval above
// — see the client's Production Process Flow doc and pre-production-
// stage.ts's own comment on why this was added.
export const lineClearanceFieldsSchema = z.object({
  lineClearanceStatus: z.enum(LINE_CLEARANCE_STATUSES).optional(),
  lineClearanceRemarks: z.string().max(1000).optional(),
});

export const PRE_PRODUCTION_STAGE_FIELD_SCHEMA: Partial<Record<PreProductionStageId, z.AnyZodObject>> = {
  MATERIAL_RECEIVED: materialReceivedFieldsSchema,
  INDENT_ISSUE: indentIssueFieldsSchema,
  LINE_CLEARANCE: lineClearanceFieldsSchema,
  DISPENSING: dispensingFieldsSchema,
  SAMPLE_QC_APPROVAL: sampleQcApprovalFieldsSchema,
};

// ---------------------------------------------------------------------------
// Tier 2 — ProductionBatch. No stage machine — just IN_PROGRESS ->
// COMPLETED — so these are plain CRUD schemas, not a stage-field map.
// ---------------------------------------------------------------------------

export const createProductionBatchSchema = z.object({
  batchNo: z.string().max(120).optional(),
  // How much of the parent PreProduction's own remaining quantity
  // (plannedQty - combinedQty) this specific run is meant to cover —
  // required so the frontend can show a running "how much left to plan"
  // rollup the same way the old per-PO-item version of this already did,
  // now scoped to the parent PreProduction instead.
  plannedQty: z.coerce.number().positive(),
});

// Every field this run collects, all optional — a run can be created and
// completed incrementally, same "save everything, don't force it all at
// once" shape the old single-Batch pipeline used stage by stage.
export const productionBatchExecutionSchema = z.object({
  batchNo: z.string().max(120).optional(),
  manufacturingStartDate: dateField,
  manufacturingStatus: z.string().max(120).optional(),
  manufacturingEndDate: dateField,
  manufacturingRemarks: z.string().max(1000).optional(),
  // Wastage — Production's own entry (mechanical/process loss, e.g.
  // sieving). wastageQty is derived from these two, never entered
  // directly — see computeWastage in batch.engine.ts.
  inputQty: z.coerce.number().nonnegative().optional(),
  outputQty: z.coerce.number().nonnegative().optional(),
});

// Marks a run COMPLETED — the one action that actually adds its
// outputQty to the parent PreProduction's running combinedQty (see
// production-batches.routes.ts). Requires outputQty to already be
// recorded (via PATCH, same call or an earlier one) — there's nothing
// meaningful to pool into the parent without it.
export const completeProductionBatchSchema = z.object({});

// ---------------------------------------------------------------------------
// Tier 3 — CombinedLot. Created automatically once a PreProduction's
// combinedQty reaches its plannedQty (see production-batches.routes.ts)
// — never created directly by a caller, so there's no create schema
// here, only the stage-field schemas for its own 7-stage walk.
// ---------------------------------------------------------------------------

export const ipqcFieldsSchema = z.object({
  ipqcStatus: z.enum(IPQC_STATUSES).optional(),
  ipqcRemarks: z.string().max(1000).optional(),
  // Bulk Reconciliation (BMR-1.docx 8.0) — the client's real yield
  // formula, a distinct calculation from ProductionBatch's own simple
  // input/output wastage. yieldPct/processLoss are derived, never
  // entered — see computeBulkReconciliation in batch.engine.ts. Captured
  // here rather than at BULK_QC since it's IPQC that first weighs the
  // pooled bulk, per the doc's own ordering.
  bulkTheoreticalWeight: z.coerce.number().nonnegative().optional(),
  bulkActualWeight: z.coerce.number().nonnegative().optional(),
  bulkQcSampleWeight: z.coerce.number().nonnegative().optional(),
  bulkTransferToPackingQty: z.coerce.number().nonnegative().optional(),
});

// coaResult/coaRemark are the Certificate of Analysis's own final verdict
// (COA format.docx's "Result: ... does not comply/complies") — separate
// from bulkQcStatus above, which is still what actually gates FORWARD.
export const bulkQcFieldsSchema = z.object({
  bulkQcStatus: z.enum(BULK_QC_STATUSES).optional(),
  bulkQcRemarks: z.string().max(1000).optional(),
  coaResult: z.enum(COA_RESULTS).optional(),
  coaRemark: z.string().max(1000).optional(),
});

// The COA's per-test-parameter list — a full replace each save (unlike
// the checklists, which tests apply varies by product, so there's no
// fixed key set to upsert against; QA just retypes the current list).
export const coaResultsReplaceSchema = z.object({
  results: z
    .array(
      z.object({
        testName: z.string().min(1).max(200),
        specification: z.string().max(500).optional(),
        observation: z.string().max(500).optional(),
      }),
    )
    .max(30),
});

// The doc's three sequential sign-offs — each settable once, in order.
export const coaSignSchema = z.object({
  step: z.enum(COA_SIGN_STEPS),
});

// The Approved/Rejected/Wastage split — see schema.prisma's comment on
// CombinedLot.mfgApprovedQty. Wastage is the one bucket that's a real,
// permanent sink: logging a positive mfgWastageQty on the transition
// that actually clears this gate creates a BatchRecycleLog row (see
// combined-lot-transition.ts), same "Wastage never comes back" rule as
// Dispensing's WASTE-purpose consumption.
export const qaGateMfgFieldsSchema = z.object({
  mfgQaStatus: z.enum(MFG_APPROVAL_STATUSES).optional(),
  mfgQcStatus: z.enum(MFG_APPROVAL_STATUSES).optional(),
  mfgRemarks: z.string().max(1000).optional(),
  mfgApprovedQty: z.coerce.number().nonnegative().optional(),
  // Quality rejection — QC's own entry, independent of wastage above.
  mfgRejectedQty: z.coerce.number().nonnegative().optional(),
  mfgWastageQty: z.coerce.number().nonnegative().optional(),
});

export const packagingFieldsSchema = z.object({
  packagingStartDate: dateField,
  packagingStatus: z.string().max(120).optional(),
  packagingEndDate: dateField,
  packagingRemarks: z.string().max(1000).optional(),
});

// Same Approved/Rejected/Wastage split as QA Gate Mfg above.
export const qaGatePackagingFieldsSchema = z.object({
  packQaStatus: z.enum(PACK_APPROVAL_STATUSES).optional(),
  packQcStatus: z.enum(PACK_APPROVAL_STATUSES).optional(),
  packRemarks: z.string().max(1000).optional(),
  packApprovedQty: z.coerce.number().nonnegative().optional(),
  packRejectedQty: z.coerce.number().nonnegative().optional(),
  packWastageQty: z.coerce.number().nonnegative().optional(),
});

// dispatchTransferId is settable from either this stage or Dispatch Plan
// below — one DispatchTransfer(type: FG) row covers both the invoice and
// the shipment, see schema.prisma's comment on CombinedLot.dispatchTransferId.
export const billingEwayBillFieldsSchema = z.object({
  invoiceNo: z.string().max(120).optional(),
  invoiceDate: dateField,
  ewayBillNo: z.string().max(120).optional(),
  ewayBillDate: dateField,
  billingRemarks: z.string().max(1000).optional(),
  dispatchTransferId: z.string().uuid().optional().nullable(),
});

export const dispatchPlanFieldsSchema = z.object({
  dispatchDate: dateField,
  dispatchedQty: z.coerce.number().nonnegative().optional(),
  shipperQty: z.coerce.number().nonnegative().optional(),
  totalShipperWeight: z.coerce.number().nonnegative().optional(),
  transportType: z.enum(TRANSPORT_TYPES).optional(),
  remainingQty: z.coerce.number().nonnegative().optional(),
  anyRemarks: z.string().max(1000).optional(),
  dispatchTransferId: z.string().uuid().optional().nullable(),
});

export const COMBINED_LOT_STAGE_FIELD_SCHEMA: Partial<Record<CombinedLotStageId, z.AnyZodObject>> = {
  IPQC: ipqcFieldsSchema,
  QA_GATE_MFG: qaGateMfgFieldsSchema,
  BULK_QC: bulkQcFieldsSchema,
  PACKAGING: packagingFieldsSchema,
  QA_GATE_PACKAGING: qaGatePackagingFieldsSchema,
  BILLING_EWAY_BILL: billingEwayBillFieldsSchema,
  DISPATCH_PLAN: dispatchPlanFieldsSchema,
};

// ---------------------------------------------------------------------------
// Shared transition envelope — same shape for both PreProduction and
// CombinedLot's own PATCH /:id/stage, since the forward/reject/jump
// mechanics are identical; only the target-stage enum differs, so this
// stays generic over which stage-id union applies.
// ---------------------------------------------------------------------------

export const preProductionTransitionEnvelopeSchema = z.object({
  action: z.enum(["FORWARD", "REJECT", "JUMP"]),
  note: z.string().max(1000).optional(),
  targetStageId: z.enum(ALL_PRE_PRODUCTION_STAGE_IDS as [PreProductionStageId, ...PreProductionStageId[]]).optional(),
});

export const combinedLotTransitionEnvelopeSchema = z.object({
  action: z.enum(["FORWARD", "REJECT", "JUMP"]),
  note: z.string().max(1000).optional(),
  targetStageId: z.enum(ALL_COMBINED_LOT_STAGE_IDS as [CombinedLotStageId, ...CombinedLotStageId[]]).optional(),
  // FORWARD at DISPATCH_PLAN only — the real business rule is one PO
  // ships as one combined shipment, so saving dispatch details there
  // warns (409) when a sibling item's CombinedLot on the same PO hasn't
  // reached Dispatch Plan yet, instead of silently allowing a partial
  // shipment. This flag is the explicit override once someone's
  // confirmed a genuine partial shipment is intended — see
  // combined-lot-transition.ts.
  confirmPartialDispatch: z.boolean().optional(),
});

// Bulk "forward the current stage" import — one row per PreProduction/
// CombinedLot, resolved by (PO Number, Product Name) since both are 1:1
// with a PO line item now (see batch-import.ts). `fields` is validated
// for real only once the row's matched and its *current* stage is known
// — transitionPreProductionStage/transitionCombinedLotStage runs the
// same field-schema check the single-run endpoints do, so there's
// nothing stage-shaped to validate here at the envelope level.
export const importBatchStagesRowSchema = z.object({
  poNumber: z.string().min(1).max(120),
  productName: z.string().min(1).max(200),
  note: z.string().max(1000).optional(),
  confirmPartialDispatch: z.boolean().optional(),
  fields: z.record(z.unknown()).default({}),
});

export const importBatchStagesSchema = z.object({
  rows: z.array(importBatchStagesRowSchema).min(1).max(500),
});

// One save call sets a whole checklist's worth of rows at once. `column`
// picks which of the paper form's two observation columns this caller is
// filling in — "DEPT" for whichever department owns that checklist's
// first column (Store for the PreProduction dispensing-area checklist,
// Production for the CombinedLot bulk-mfg-area checklist) or "QA", same
// role check the route enforces too.
export const checklistUpdateSchema = z.object({
  column: z.enum(["DEPT", "QA"]),
  items: z
    .array(
      z.object({
        itemKey: z.string().min(1).max(80),
        ok: z.boolean(),
      }),
    )
    .min(1)
    .max(20),
});

export type CreatePreProductionInput = z.infer<typeof createPreProductionSchema>;
export type UpdatePreProductionPlantInput = z.infer<typeof updatePreProductionPlantSchema>;
export type CreateProductionBatchInput = z.infer<typeof createProductionBatchSchema>;
export type ProductionBatchExecutionInput = z.infer<typeof productionBatchExecutionSchema>;
export type DispensingConsumptionInput = z.infer<typeof dispensingConsumptionSchema>;
export type IndentRequestLinesInput = z.infer<typeof indentRequestLinesSchema>;
export type PreProductionTransitionEnvelopeInput = z.infer<typeof preProductionTransitionEnvelopeSchema>;
export type CombinedLotTransitionEnvelopeInput = z.infer<typeof combinedLotTransitionEnvelopeSchema>;
export type ImportBatchStagesInput = z.infer<typeof importBatchStagesSchema>;
export type ChecklistUpdateInput = z.infer<typeof checklistUpdateSchema>;
export type CoaResultsReplaceInput = z.infer<typeof coaResultsReplaceSchema>;
export type CoaSignInput = z.infer<typeof coaSignSchema>;
