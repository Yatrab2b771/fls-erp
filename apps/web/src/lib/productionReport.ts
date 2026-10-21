import type { BatchReportDetail, BoardMaterial, HandoverRow, PlanBoardRow } from "./hooks";
import { materialUsed, q3 } from "./utilization";
import { COMBINED_LOT_STAGE_LABEL } from "./combinedLotStage";
import type { CombinedLotStageId } from "./types";

// The Production Report: for one product, everything about its batches - shifts, manpower, quantities, material and the hand-over to
// Dispatch. Built on the plans board (batches, shifts, manpower, material) joined with the handover board (stage, packaging, dispatched).

export interface ReportBatch {
  id: string;
  batchNo: string | null;
  inProgress: boolean;
  plannedQty: number;
  inputQty: number | null;
  outputQty: number | null;
  wastageQty: number | null;
  /** output / input, as a percentage */
  yieldPct: number | null;
  shift: "Day" | "Night" | null;
  manpower: number | null;
  startAt: string | null;
  endAt: string | null;
  hours: number | null;
  materials: BoardMaterial[];
  nowAt: string;
  packagingStatus: string | null;
  packedQty: number | null;
  dispatchedQty: number;
  handedOverAt: string | null;
}

export type ReportStatus = "NO_BATCHES" | "IN_PRODUCTION" | "PRODUCTION_DONE" | "HANDED_OVER";
export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  NO_BATCHES: "No batches yet",
  IN_PRODUCTION: "In production",
  PRODUCTION_DONE: "Production complete",
  HANDED_OVER: "Handed over to Dispatch",
};

export interface ProductReport {
  row: PlanBoardRow;
  batches: ReportBatch[];
  status: ReportStatus;
  totals: {
    batches: number;
    completed: number;
    inProgress: number;
    dayBatches: number;
    nightBatches: number;
    hours: number;
    manpowerTotal: number;
    manpowerAvg: number | null;
    manpowerMax: number | null;
    planned: number;
    input: number;
    output: number;
    wastage: number;
    yieldPct: number | null;
    rmUsed: number;
    rmWasted: number;
    rmYieldPct: number | null;
    manHours: number;
    /** output per man-hour (batches that have manpower and both times) */
    productivity: number | null;
    firstStart: string | null;
    lastEnd: string | null;
    handedBatches: number;
    handedQty: number;
    pendingQty: number;
    dispatchedQty: number;
  };
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const hoursBetween = (a: string | null, b: string | null) => (a && b ? Math.round(((new Date(b).getTime() - new Date(a).getTime()) / 3_600_000) * 10) / 10 : null);

const PREP_LABEL: Record<string, string> = { INDENT_ISSUE: "Indent Issue", BATCH_NO: "Batch No (R&D)", DISPENSING: "Dispensing", RECEIVE: "Receive (Production)", LINE_CLEARANCE: "Line Clearance" };
// Stages a batch passes before Packaging is finished: after these it has been handed over to QA.
const BEFORE_HANDOVER = ["IPQC", "QA_GATE_MFG", "BULK_QC", "PACKAGING"];

// `detail` (the report board) knows every batch, however far it has gone. The handover board only lists batches at Packaging / QA's packaging
// gate, so for a batch that has moved on (FG Store, Dispatch) the detail is what tells where it is and how much has been dispatched.
export function toReportBatches(row: PlanBoardRow, handover: Map<string, HandoverRow>, detail: Map<string, BatchReportDetail> = new Map()): ReportBatch[] {
  return row.batches.map((b) => {
    const h = handover.get(b.id);
    const d = detail.get(b.id);
    const handedOver = d && b.status === "COMPLETED" && !BEFORE_HANDOVER.includes(d.currentStageId);
    const wastage = b.inputQty != null && b.outputQty != null ? q3(b.inputQty - b.outputQty) : null;
    return {
      id: b.id,
      batchNo: b.batchNo,
      inProgress: b.status === "IN_PROGRESS",
      plannedQty: b.plannedQty,
      inputQty: b.inputQty,
      outputQty: b.outputQty,
      wastageQty: wastage,
      yieldPct: b.inputQty != null && b.outputQty != null ? pct(b.outputQty, b.inputQty) : null,
      shift: b.shift,
      manpower: b.manpowerCount,
      startAt: b.shiftStartAt,
      endAt: b.shiftEndAt,
      hours: hoursBetween(b.shiftStartAt, b.shiftEndAt),
      materials: b.materials,
      nowAt:
        b.status === "IN_PROGRESS"
          ? (PREP_LABEL[b.prepStageId] ?? "Manufacturing")
          : (h?.currentStageId ?? d?.currentStageId)
            ? (COMBINED_LOT_STAGE_LABEL[(h?.currentStageId ?? d?.currentStageId) as CombinedLotStageId] ?? (h?.currentStageId ?? d?.currentStageId)!)
            : "—",
      packagingStatus: h?.packagingStatus ?? d?.packagingStatus ?? null,
      packedQty: h?.packedQty ?? d?.packApprovedQty ?? null,
      dispatchedQty: h?.dispatchedQty ?? d?.dispatchedQty ?? 0,
      handedOverAt: h?.handedOverAt ?? (handedOver ? (d.packagingEndAt ?? d.completedAt) : null),
    };
  });
}

export function summarize(row: PlanBoardRow, batches: ReportBatch[]): ProductReport {
  const done = batches.filter((b) => !b.inProgress);
  const withManpower = batches.filter((b) => b.manpower != null);
  const mats = batches.flatMap((b) => b.materials).filter((m) => m.category === "RM");
  const rmA = mats.reduce((s, m) => s + m.consumedQty, 0);
  const rmUsed = mats.reduce((s, m) => s + materialUsed(m), 0);
  const input = batches.reduce((s, b) => s + (b.inputQty ?? 0), 0);
  const output = batches.reduce((s, b) => s + (b.outputQty ?? 0), 0);
  const handed = batches.filter((b) => b.handedOverAt);
  const status: ReportStatus = batches.length === 0 ? "NO_BATCHES" : batches.some((b) => b.inProgress) ? "IN_PRODUCTION" : handed.length === batches.length ? "HANDED_OVER" : "PRODUCTION_DONE";
  return {
    row,
    batches,
    status,
    totals: {
      batches: batches.length,
      completed: done.length,
      inProgress: batches.length - done.length,
      dayBatches: batches.filter((b) => b.shift === "Day").length,
      nightBatches: batches.filter((b) => b.shift === "Night").length,
      hours: q3(batches.reduce((s, b) => s + (b.hours ?? 0), 0)),
      manpowerTotal: withManpower.reduce((s, b) => s + (b.manpower ?? 0), 0),
      manpowerAvg: withManpower.length ? Math.round((withManpower.reduce((s, b) => s + (b.manpower ?? 0), 0) / withManpower.length) * 10) / 10 : null,
      manpowerMax: withManpower.length ? Math.max(...withManpower.map((b) => b.manpower ?? 0)) : null,
      planned: q3(batches.reduce((s, b) => s + b.plannedQty, 0)),
      input: q3(input),
      output: q3(output),
      wastage: q3(batches.reduce((s, b) => s + (b.wastageQty ?? 0), 0)),
      yieldPct: pct(output, input),
      rmUsed: q3(rmUsed),
      rmWasted: q3(mats.reduce((s, m) => s + m.wastedQty, 0)),
      rmYieldPct: pct(rmA, rmUsed),
      manHours: q3(batches.reduce((s, b) => s + (b.manpower != null && b.hours != null ? b.manpower * b.hours : 0), 0)),
      productivity: (() => {
        const timed = batches.filter((b) => b.manpower != null && b.hours != null && b.hours > 0 && b.outputQty != null);
        const mh = timed.reduce((s, b) => s + (b.manpower ?? 0) * (b.hours ?? 0), 0);
        return mh > 0 ? Math.round((timed.reduce((s, b) => s + (b.outputQty ?? 0), 0) / mh) * 100) / 100 : null;
      })(),
      firstStart: batches.map((b) => b.startAt).filter((v): v is string => !!v).sort()[0] ?? null,
      lastEnd: batches.map((b) => b.endAt).filter((v): v is string => !!v).sort().at(-1) ?? null,
      handedBatches: handed.length,
      handedQty: q3(handed.reduce((s, b) => s + (b.outputQty ?? 0), 0)),
      pendingQty: q3(done.filter((b) => !b.handedOverAt).reduce((s, b) => s + (b.outputQty ?? 0), 0)),
      dispatchedQty: q3(batches.reduce((s, b) => s + b.dispatchedQty, 0)),
    },
  };
}
