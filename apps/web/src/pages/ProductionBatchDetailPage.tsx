import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, ClipboardEdit, Download, FlaskConical, Lock, Pencil, Undo2 } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useAssignProductionBatchNo, useProductionBatch, useTransitionProductionBatchStage } from "../lib/hooks";
import { COMBINED_LOT_STAGE_LABEL, COMBINED_LOT_STAGE_ORDER, COMBINED_LOT_STAGE_ROLE, getForwardTarget, getRejectTarget } from "../lib/combinedLotStage";
import { PRODUCTION_BATCH_STAGE_FIELDS } from "../lib/productionBatchStage";
import { FieldGrid } from "../components/FieldGrid";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { ApiError, downloadFile } from "../lib/api";
import type { ProductionBatch, CombinedLotStageId } from "../lib/types";

// A ProductionBatch's OWN Tier-3 pipeline (IPQC through Dispatch Plan) —
// same shape as CombinedLotDetailPage, trimmed of Bulk Reconciliation,
// COA, checklists, and FG-transfer linking (all pooled-lot-only
// concepts — see schema.prisma's comment on ProductionBatch). Reachable
// once this batch is COMPLETED: it no longer has to wait for every
// sibling batch on the same PreProduction to finish before it can be
// packaged and shipped on its own.

function fieldValue(batch: ProductionBatch, name: string): string {
  const raw = (batch as unknown as Record<string, unknown>)[name];
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);
  return String(raw);
}

export function ProductionBatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: batch, isLoading } = useProductionBatch(id);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-4 w-40" />
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-16 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }
  if (!batch) return <EmptyState icon={FlaskConical} title="Production batch not found" accent="rose" />;

  const item = batch.preProduction.purchaseOrderItem;
  const po = item.purchaseOrder;

  return (
    <div className="space-y-6">
      <Link to={`/pre-productions/${batch.preProductionId}`} className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> {item.productName}
      </Link>

      <div className="card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3.5">
            <div className="stat-icon bg-violet-50 text-violet-600">
              <FlaskConical className="h-5 w-5" strokeWidth={2} />
            </div>
            <div>
              <h1 className="text-xl font-black tracking-tight text-slate-900">{item.productName}</h1>
              <p className="text-sm text-slate-500">
                {po.customer.companyName} {po.poNumber && `· ${po.poNumber}`} · Batch Qty {batch.plannedQty} {item.unit}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-ghost btn-sm" onClick={() => downloadFile(`/api/production-batches/${batch.id}/bmr-report.pdf`, `BMR_${batch.batchNo ?? batch.id}.pdf`)}>
              <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download BMR Report
            </button>
            <BatchNoBadge batch={batch} />
          </div>
        </div>
      </div>

      {batch.status !== "COMPLETED" ? (
        <EmptyState
          icon={Lock}
          title="Not ready for QC/packaging/dispatch yet"
          hint="This run needs to be completed (output quantity recorded, back on its Pre-Production page) before it can move through its own pipeline."
          accent="amber"
        />
      ) : (
        <>
          <StageProgressStrip batch={batch} />
          <CurrentStageCard batch={batch} />
        </>
      )}
    </div>
  );
}

function BatchNoBadge({ batch }: { batch: ProductionBatch }) {
  const { hasRole } = useAuth();
  const canAssign = hasRole("QA_QC", "RND");
  const assign = useAssignProductionBatchNo(batch.preProductionId);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(batch.batchNo ?? "");

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    try {
      await assign.mutateAsync({ id: batch.id, batchNo: trimmed });
      toast.success("Batch number assigned.");
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not assign the batch number");
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <input autoFocus className="field h-8 w-36 py-0 text-sm font-bold" placeholder="Batch No." value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSave()} />
        <button className="btn-icon h-8 w-8" disabled={assign.isPending} onClick={handleSave} title="Save">
          <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5">
      <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Batch No.</span>
      <span className="font-mono text-sm font-black text-slate-800">{batch.batchNo ?? "— not assigned —"}</span>
      {canAssign && (
        <button className="btn-icon h-6 w-6" onClick={() => setEditing(true)} title="QA/QC assigns the batch number">
          <Pencil className="h-3 w-3" strokeWidth={2.25} />
        </button>
      )}
    </div>
  );
}

function StageProgressStrip({ batch }: { batch: ProductionBatch }) {
  const currentIndex = COMBINED_LOT_STAGE_ORDER.indexOf(batch.currentStageId);
  return (
    <div className="card p-4 sm:p-5">
      <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-none">
        {COMBINED_LOT_STAGE_ORDER.map((stage, idx) => {
          const isDone = idx < currentIndex;
          const isCurrent = idx === currentIndex;
          const pillClass = `flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10.5px] font-bold whitespace-nowrap ${
            isCurrent ? "border-brand-300 bg-brand-50 text-brand-700 shadow-soft" : isDone ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-400"
          }`;
          const icon = isDone ? <Check className="h-3 w-3" strokeWidth={3} /> : isCurrent ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" /> : <Lock className="h-2.5 w-2.5" strokeWidth={2.5} />;
          return (
            <div key={stage} className="flex shrink-0 items-center gap-1">
              <div className={pillClass}>
                {icon}
                {COMBINED_LOT_STAGE_LABEL[stage]}
              </div>
              {idx < COMBINED_LOT_STAGE_ORDER.length - 1 && <ArrowRight className="h-3 w-3 shrink-0 text-slate-300" strokeWidth={2.5} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CurrentStageCard({ batch }: { batch: ProductionBatch }) {
  const { hasRole } = useAuth();
  const stage = batch.currentStageId;
  const roles = COMBINED_LOT_STAGE_ROLE[stage];
  const canAct = hasRole(...roles);
  const roleLabel = roles.join(" / ");
  const fields = PRODUCTION_BATCH_STAGE_FIELDS[stage];
  const forwardTarget = getForwardTarget(stage);
  const rejectTarget = getRejectTarget(stage);
  const isTerminal = stage === "DISPATCH_PLAN";

  const transition = useTransitionProductionBatchStage(batch.id, batch.preProductionId);
  const toast = useToast();

  const [values, setValues] = useState<Record<string, string>>({});
  const [showReject, setShowReject] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fields) setValues(Object.fromEntries(fields.map((f) => [f.name, fieldValue(batch, f.name)])));
    setShowReject(false);
    setNote("");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.id, batch.currentStageId]);

  async function handleForward() {
    setError(null);
    const body: Record<string, unknown> = { action: "FORWARD" };
    for (const [key, value] of Object.entries(values)) {
      if (value !== "") body[key] = value;
    }
    try {
      const result = await transition.mutateAsync(body as never);
      if ((stage === "QA_GATE_MFG" || stage === "QA_GATE_PACKAGING") && result.currentStageId === stage) {
        toast.error("Saved — still on hold. Approve or Reject to move it forward.");
      } else if ((stage === "IPQC" || stage === "BULK_QC") && result.currentStageId === stage) {
        toast.error(`Saved — can't move on to ${COMBINED_LOT_STAGE_LABEL[getForwardTarget(stage)]} until QC sets this to Approved.`);
      } else {
        toast.success(isTerminal ? "Dispatch details saved." : `Forwarded to ${COMBINED_LOT_STAGE_LABEL[forwardTarget]}.`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not save";
      setError(msg);
      toast.error(msg);
    }
  }

  async function handleReject() {
    setError(null);
    if (!note.trim()) {
      setError("A note is required when sending a batch back.");
      return;
    }
    try {
      await transition.mutateAsync({ action: "REJECT", note: note.trim() });
      toast.success(`Sent back to ${rejectTarget ? COMBINED_LOT_STAGE_LABEL[rejectTarget as CombinedLotStageId] : "the previous stage"}.`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not send back";
      setError(msg);
      toast.error(msg);
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
          <ClipboardEdit className="h-3.5 w-3.5" /> {COMBINED_LOT_STAGE_LABEL[stage]}
        </h3>
        <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${canAct ? "border-brand-200 bg-brand-50 text-brand-700" : "border-slate-200 bg-slate-100 text-slate-400"}`}>
          {roleLabel}
        </span>
      </div>

      <div className="p-4">
        {!canAct ? (
          <p className="flex items-center gap-1.5 text-xs text-slate-400">
            <Lock className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} /> Waiting on the {roleLabel} department to {fields ? "fill this in and " : ""}move it forward.
          </p>
        ) : fields ? (
          <FieldGrid fields={fields} values={values} disabled={!canAct} onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))} />
        ) : (
          <p className="text-xs text-slate-400">This stage is status-only — no fields to fill, just forward or send it back.</p>
        )}

        {error && <p className="mt-3 text-xs font-bold text-rose-600">{error}</p>}

        {canAct && (
          <div className="mt-4 space-y-3">
            {showReject ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3">
                <label className="label !text-rose-500">Why is this being sent back?</label>
                <textarea className="field min-h-[4.5rem] resize-y" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Required — e.g. wrong quantity, missing weighing sign-off…" />
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setShowReject(false)}>
                    Cancel
                  </button>
                  <button type="button" className="btn-danger btn-sm" disabled={transition.isPending} onClick={handleReject}>
                    {transition.isPending ? "Sending…" : `Send Back to ${rejectTarget ? COMBINED_LOT_STAGE_LABEL[rejectTarget as CombinedLotStageId] : "Previous Stage"}`}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap justify-end gap-2">
                {rejectTarget && (
                  <button type="button" className="btn-ghost" onClick={() => setShowReject(true)}>
                    <Undo2 className="h-3.5 w-3.5" strokeWidth={2.5} /> Send Back
                  </button>
                )}
                <button type="button" className="btn-primary" disabled={transition.isPending} onClick={handleForward}>
                  {transition.isPending ? "Saving…" : isTerminal ? "Save Dispatch Details" : `Forward to ${COMBINED_LOT_STAGE_LABEL[forwardTarget]}`}
                  {!transition.isPending && !isTerminal && <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
