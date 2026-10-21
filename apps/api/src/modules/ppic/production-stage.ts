// Where a product that has been sent to Production is, from its run and batches. ONE rule, used everywhere (the data check, and the
// "Active Products in Production" tile for BD), so no list can place a product somewhere else.
//
//   PRE_PRODUCTION  sent to Production; the run is at Material Received / Indent Issue / Dispensing / Line Clearance (or not opened yet), or
//                   every batch of a per-batch-flow run is still at its own Indent / Batch No / Dispensing / Line Clearance
//   IN_PRODUCTION   a batch exists and has not yet passed QA's packaging gate (manufacturing, IPQC, QA gate, Bulk QC, Packaging)
//   FINISHED_GOODS  past the packaging QA gate: at the Day Store, waiting for FG approval or hand-over
//   DISPATCH        handed over to Dispatch (some of it may already be shipped)
//   COMPLETED       the whole ordered quantity has gone to the customer

export type ProductionStage = "PRE_PRODUCTION" | "IN_PRODUCTION" | "FINISHED_GOODS" | "DISPATCH" | "COMPLETED";

export const BATCH_STAGE_ORDER = ["IPQC", "QA_GATE_MFG", "BULK_QC", "PACKAGING", "QA_GATE_PACKAGING", "FG_STORE", "FG_QC_RELEASE", "FG_HANDOVER", "BILLING_EWAY_BILL", "DISPATCH_PLAN"];
export const batchPast = (stage: string, than: string) => BATCH_STAGE_ORDER.indexOf(stage) > BATCH_STAGE_ORDER.indexOf(than);

export const PRODUCTION_STAGE_LABEL: Record<ProductionStage, string> = {
  PRE_PRODUCTION: "Pre-production",
  IN_PRODUCTION: "In production",
  FINISHED_GOODS: "Finished goods",
  DISPATCH: "With Dispatch",
  COMPLETED: "Completed",
};

export function productionStageOf(item: { planSentToProductionAt: Date | null; quantity: number; /** The quantity the product ends at when it was closed short. */ requiredQty?: number | null; batches: { currentStageId: string; handedOverToDispatchAt: Date | null; customerShippedQty: number; prepStageId?: string }[] }): ProductionStage | null {
  if (!item.planSentToProductionAt) return null;
  const { batches } = item;
  // No batch yet, or (per-batch flow) every batch is still being prepared (indent, batch number, Dispensing, Line Clearance): its production has not started.
  if (batches.every((b) => b.prepStageId !== undefined && b.prepStageId !== "READY")) return "PRE_PRODUCTION";
  const shipped = batches.reduce((a, b) => a + b.customerShippedQty, 0);
  if (shipped >= (item.requiredQty ?? item.quantity) - 1e-6) return "COMPLETED";
  if (batches.some((b) => b.handedOverToDispatchAt)) return "DISPATCH";
  if (batches.some((b) => batchPast(b.currentStageId, "QA_GATE_PACKAGING"))) return "FINISHED_GOODS";
  return "IN_PRODUCTION";
}
