import type { Prisma } from "@prisma/client";
import { COMBINED_LOT_STAGE_ROLE, type CombinedLotStageId } from "./combined-lot-stage";

/**
 * Where a per-batch-flow batch is between its start and Packaging.
 *
 * A batch's QA / R&D steps run while it is still in production: the moment Production saves its start fields (shift, manpower, start date and
 * time) it is at In-Process QA, then the QA Gate (manufacturing), then Bulk QC (R&D). Only after Bulk QC has passed does it come back to
 * Production, which fills the RM Utilization and the end time and sends it to Packaging (the batch is COMPLETED at that point). A batch of an
 * older run (not per-batch flow) is COMPLETED before it enters the QA steps, as it always was.
 */
export const EARLY_QA_STAGES = ["IPQC", "QA_GATE_MFG", "BULK_QC"] as const;

/** A batch that has reached the finished-goods store (or gone on from it) has been made and packed: no more material is asked or dispensed for it. */
export const PAST_PACKING_STAGES: readonly string[] = ["FG_STORE", "FG_QC_RELEASE", "FG_HANDOVER", "BILLING_EWAY_BILL", "DISPATCH_PLAN"];

/** A per-batch-flow batch that has started and is still in production: it already sits at its QA / R&D stage. */
export const startedInProduction: Prisma.ProductionBatchWhereInput = { status: "IN_PROGRESS", shiftStartAt: { not: null }, preProduction: { batchFlow: true } };

/** Every batch that is in the QA / packaging pipeline: completed ones, and started per-batch-flow ones still in production. */
export const inPipeline: Prisma.ProductionBatchWhereInput = { OR: [{ status: "COMPLETED" }, startedInProduction] };

/** True when a still-in-production batch of the per-batch flow is past Bulk QC, so Production can fill its RM Utilization and send it to Packaging. */
export const backWithProduction = (b: { status: string; currentStageId: string }) => b.status === "IN_PROGRESS" && b.currentStageId === "PACKAGING";

const DEPARTMENT: Record<string, string> = { QA_QC: "QA", RND: "R&D", PRODUCTION: "Production", STORE: "Store", ACCOUNTS: "Accounts", DISPATCH: "Dispatch" };

/** The department that owns a stage, as the screens name it: QA, R&D, Production, Day Store ... */
export const stageDepartment = (stage: CombinedLotStageId): string => (COMBINED_LOT_STAGE_ROLE[stage] ?? []).map((r) => DEPARTMENT[r] ?? r).join(" / ") || "-";
