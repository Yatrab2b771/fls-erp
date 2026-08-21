import { AlarmClock, Recycle } from "lucide-react";
import { BATCH_STAGE_LABEL } from "../lib/batchStage";
import type { BatchDelay, BatchStageId, BatchWastage } from "../lib/types";

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

// Material Request lifecycle — PENDING → APPROVED → (PARTIALLY_ISSUED →)* ISSUED, or REJECTED.
type RequestStatus = "PENDING" | "APPROVED" | "PARTIALLY_ISSUED" | "REJECTED" | "ISSUED";
const REQUEST_STATUS_COLOR: Record<RequestStatus, string> = {
  PENDING: "bg-amber-50 text-amber-700 border-amber-200",
  APPROVED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  PARTIALLY_ISSUED: "bg-blue-50 text-blue-700 border-blue-200",
  REJECTED: "bg-rose-50 text-rose-700 border-rose-200",
  ISSUED: "bg-brand-50 text-brand-700 border-brand-200",
};
const REQUEST_STATUS_DOT: Record<RequestStatus, string> = {
  PENDING: "animate-pulse bg-amber-500",
  APPROVED: "bg-emerald-500",
  PARTIALLY_ISSUED: "animate-pulse bg-blue-500",
  REJECTED: "bg-rose-500",
  ISSUED: "bg-brand-500",
};
const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  PARTIALLY_ISSUED: "Partially Issued",
  REJECTED: "Rejected",
  ISSUED: "Issued",
};

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span className={`pill ${REQUEST_STATUS_COLOR[status]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${REQUEST_STATUS_DOT[status]}`} />
      {REQUEST_STATUS_LABEL[status]}
    </span>
  );
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

// Only shown once Production has actually recorded input/output — a
// batch that hasn't reached that stage yet has nothing to report.
export function WastageBadge({ wastage }: { wastage: BatchWastage }) {
  if (wastage.wastageQty === null) return null;
  return (
    <span className="pill animate-fade-in border-amber-200 bg-amber-50 text-amber-700" title="Production wastage — inputQty minus outputQty">
      <Recycle className="h-3 w-3" strokeWidth={2.5} />
      {wastage.wastageQty} wastage ({wastage.wastagePct}%)
    </span>
  );
}
