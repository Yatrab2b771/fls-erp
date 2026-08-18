import { AlarmClock } from "lucide-react";
import { BATCH_STAGE_LABEL } from "../lib/batchStage";
import type { BatchDelay, BatchStageId } from "../lib/types";

// Color-coded by rough phase of the pipeline, not one color per stage —
// 10 distinct colors would be noise.
const STAGE_COLOR: Record<BatchStageId, string> = {
  PO_RELEASE: "bg-amber-50 text-amber-700 border-amber-200",
  MATERIAL_RECEIVED: "bg-amber-50 text-amber-700 border-amber-200",
  INDENT_ISSUE: "bg-slate-100 text-slate-600 border-slate-200",
  DISPENSING: "bg-amber-50 text-amber-700 border-amber-200",
  PRODUCTION_EXECUTION: "bg-blue-50 text-blue-700 border-blue-200",
  QA_GATE_MFG: "bg-blue-50 text-blue-700 border-blue-200",
  PACKAGING: "bg-violet-50 text-violet-700 border-violet-200",
  QA_GATE_PACKAGING: "bg-violet-50 text-violet-700 border-violet-200",
  BILLING_EWAY_BILL: "bg-emerald-50 text-emerald-700 border-emerald-200",
  DISPATCH_PLAN: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

const STAGE_DOT: Record<BatchStageId, string> = {
  PO_RELEASE: "bg-amber-500",
  MATERIAL_RECEIVED: "bg-amber-500",
  INDENT_ISSUE: "bg-slate-400",
  DISPENSING: "bg-amber-500",
  PRODUCTION_EXECUTION: "bg-blue-500",
  QA_GATE_MFG: "bg-blue-500",
  PACKAGING: "bg-violet-500",
  QA_GATE_PACKAGING: "bg-violet-500",
  BILLING_EWAY_BILL: "bg-emerald-500",
  DISPATCH_PLAN: "bg-emerald-500",
};

export function StageBadge({ stage }: { stage: BatchStageId }) {
  return (
    <span className={`pill ${STAGE_COLOR[stage]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${STAGE_DOT[stage]} ${stage === "DISPATCH_PLAN" ? "" : "animate-pulse"}`} />
      {BATCH_STAGE_LABEL[stage]}
    </span>
  );
}

// PO Draft/Approved/Rejected — the same visual language as StageBadge.
const PO_STATUS_COLOR: Record<"DRAFT" | "APPROVED" | "REJECTED", string> = {
  DRAFT: "bg-slate-100 text-slate-500 border-slate-200",
  APPROVED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  REJECTED: "bg-rose-50 text-rose-700 border-rose-200",
};

export function PoStatusBadge({ status }: { status: "DRAFT" | "APPROVED" | "REJECTED" }) {
  return <span className={`pill ${PO_STATUS_COLOR[status]}`}>{status[0]}{status.slice(1).toLowerCase()}</span>;
}

export function DelayBadge({ delay }: { delay: BatchDelay }) {
  if (!delay.isDelayed) return null;
  const against = delay.against === "dispatchPlanDate" ? "Dispatch Plan" : "Production Plan";
  return (
    <span className="pill animate-fade-in border-rose-300 bg-rose-100 text-rose-700 shadow-[0_0_0_3px_rgba(244,63,94,.08)]">
      <AlarmClock className="h-3 w-3" strokeWidth={2.5} />
      {delay.daysLate}d late vs {against}
    </span>
  );
}
