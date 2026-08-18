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
