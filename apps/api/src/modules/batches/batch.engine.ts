// Pure, dependency-free helpers over a Batch row — no Prisma import, so
// these are unit-testable without a database.
//
// computeStage() used to live here, inferring a display stage from which
// fields were filled in. That's gone now — Batch.currentStageId is an
// explicit, gated field (see batch-stage.ts), not something to infer.
// Delay computation stays; it's an orthogonal concern (are we late against
// the plan) that doesn't depend on which stage the batch is currently at.

export interface DelayFields {
  dispatchDate: Date | null;
  dispatchPlanDate: Date | null;
  manufacturingStartDate: Date | null;
  productionPlanDate: Date | null;
}

export interface DelayStatus {
  isDelayed: boolean;
  against: "dispatchPlanDate" | "productionPlanDate" | null;
  daysLate: number | null;
}

const NOT_DELAYED: DelayStatus = { isDelayed: false, against: null, daysLate: null };

// Compares "today" against whichever planned date the batch should
// already have cleared, given how far it's actually progressed. A
// dispatched batch is never delayed regardless of how late it ran.
export function computeDelay(batch: DelayFields, now: Date = new Date()): DelayStatus {
  if (batch.dispatchDate) return NOT_DELAYED;

  if (batch.dispatchPlanDate && now.getTime() > batch.dispatchPlanDate.getTime()) {
    return { isDelayed: true, against: "dispatchPlanDate", daysLate: daysLate(batch.dispatchPlanDate, now) };
  }
  if (!batch.manufacturingStartDate && batch.productionPlanDate && now.getTime() > batch.productionPlanDate.getTime()) {
    return { isDelayed: true, against: "productionPlanDate", daysLate: daysLate(batch.productionPlanDate, now) };
  }
  return NOT_DELAYED;
}

function daysLate(plannedDate: Date, now: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.max(1, Math.round((now.getTime() - plannedDate.getTime()) / msPerDay));
}

// Wastage (mechanical/process loss during manufacturing, e.g. powder
// lost to sieving) and quality rejection (QC flagging part of the
// output as unusable) are two independent numbers, both against the
// same input — never derived from each other. Wastage is the only one
// computed here (inputQty - outputQty); rejectedQty is QC's own
// direct entry at the QA Gate, nothing to compute.
export interface WastageFields {
  inputQty: number | null;
  outputQty: number | null;
}

export interface WastageResult {
  wastageQty: number | null; // null until both input and output are recorded
  wastagePct: number | null;
}

export function computeWastage(batch: WastageFields): WastageResult {
  if (batch.inputQty === null || batch.outputQty === null) return { wastageQty: null, wastagePct: null };
  // Rounded to avoid float artifacts like 100 - 99.9 === 0.09999999999999432.
  const wastageQty = Math.max(0, Math.round((batch.inputQty - batch.outputQty) * 1000) / 1000);
  const wastagePct = batch.inputQty > 0 ? Math.round((wastageQty / batch.inputQty) * 1000) / 10 : null;
  return { wastageQty, wastagePct };
}

// Bulk Reconciliation — BMR-1.docx "8.0 BULK RECONCILATION", the client's
// real yield formula: Yield {(b+c)/a×100}%, NLT 99.0% — (b) Actual
// Weight of Bulk, (c) QC Sample weight, (a) Theoretical Weight. A
// distinct, more formal calculation from the simpler input/output
// wastage above (that one's RM in vs RM out; this one's finished bulk
// vs what the formulation predicted, accounting for the QC sample pulled
// out separately). Process loss is the doc's other blank cell, derived
// the same way: whatever's left over once actual + sample are accounted
// for against theoretical.
export interface BulkReconciliationFields {
  bulkTheoreticalWeight: number | null;
  bulkActualWeight: number | null;
  bulkQcSampleWeight: number | null;
}

export interface BulkReconciliationResult {
  yieldPct: number | null; // null until theoretical + actual are both recorded
  processLoss: number | null;
}

export function computeBulkReconciliation(batch: BulkReconciliationFields): BulkReconciliationResult {
  const a = batch.bulkTheoreticalWeight;
  const b = batch.bulkActualWeight;
  if (a === null || b === null || !(a > 0)) return { yieldPct: null, processLoss: null };
  const c = batch.bulkQcSampleWeight ?? 0;
  const yieldPct = Math.round(((b + c) / a) * 1000) / 10;
  const processLoss = Math.max(0, Math.round((a - (b + c)) * 1000) / 1000);
  return { yieldPct, processLoss };
}
