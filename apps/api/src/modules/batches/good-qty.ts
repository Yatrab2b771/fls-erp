import { PRODUCTION_BATCH_STAGE_ORDER } from "./combined-lot-stage";

/**
 * What a finished batch counts for in "made so far" (the run's combinedQty), and for closing a product short: what it produced, less what QA
 * has taken out since. Each QA gate narrows it, but only once the batch has really passed that gate: after the manufacturing gate it is the
 * approved bulk, after the packaging gate the approved finished quantity. (A gate on Hold may be saved half-filled; that does not count.)
 * So a batch QA rejected part of does not still count as fully made.
 */
const ORDER: readonly string[] = PRODUCTION_BATCH_STAGE_ORDER;
/** True when the batch is past the stage `gate` (a stage outside the list is one of the older, later stages). */
const passed = (stage: string, gate: string) => {
  const i = ORDER.indexOf(stage);
  return i === -1 ? true : i > ORDER.indexOf(gate);
};

export const goodQtyOf = (b: { currentStageId: string; outputQty: number | null; mfgApprovedQty?: number | null; packApprovedQty?: number | null }): number => {
  if (b.packApprovedQty != null && passed(b.currentStageId, "QA_GATE_PACKAGING")) return b.packApprovedQty;
  if (b.mfgApprovedQty != null && passed(b.currentStageId, "QA_GATE_MFG")) return b.mfgApprovedQty;
  return b.outputQty ?? 0;
};
