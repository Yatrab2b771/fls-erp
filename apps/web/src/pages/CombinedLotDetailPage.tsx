import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Beaker, Check, CheckCircle2, ClipboardEdit, ClipboardList, Download, FlaskConical, Link2, Lock, Plus, Shuffle, Trash2, Undo2 } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useCombinedLot, useDispatchTransfers, useReplaceCoaResults, useSignCoa, useTransitionCombinedLotStage, useUpdateCombinedLotChecklist } from "../lib/hooks";
import { COMBINED_LOT_STAGE_FIELDS, COMBINED_LOT_STAGE_LABEL, COMBINED_LOT_STAGE_ORDER, COMBINED_LOT_STAGE_ROLE, getForwardTarget, getRejectTarget } from "../lib/combinedLotStage";
import { ChecklistPanel } from "./PreProductionDetailPage";
import { FieldGrid } from "../components/FieldGrid";
import { ItemPicker } from "../components/ItemPicker";
import { DelayBadge } from "../components/Badges";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { ApiError, downloadFile } from "../lib/api";
import type { CombinedLot, CombinedLotStageId } from "../lib/types";

// --- Tier 3 of the three-tier production pipeline — see types.ts's own
// comment block above PreProduction/ProductionBatch/CombinedLot. Created
// automatically once every planned ProductionBatch has completed and
// combined into a PreProduction run (see PreProductionDetailPage.tsx) —
// IPQC through Dispatch Plan happens exactly once here, against the
// whole pooled lot. ---

function fieldValue(lot: CombinedLot, name: string): string {
  const raw = (lot as unknown as Record<string, unknown>)[name];
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);
  return String(raw);
}

export function CombinedLotDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: lot, isLoading } = useCombinedLot(id);

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
  if (!lot) return <EmptyState icon={FlaskConical} title="Combined lot not found" accent="rose" />;

  const item = lot.preProduction.purchaseOrderItem;
  const po = item.purchaseOrder;

  return (
    <div className="space-y-6">
      <Link to={`/pre-productions/${lot.preProductionId}`} className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> {item.productName}
      </Link>

      <div className="card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3.5">
            <div className="stat-icon bg-violet-50 text-violet-600">
              <FlaskConical className="h-5 w-5" strokeWidth={2} />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-black tracking-tight text-slate-900">{item.productName}</h1>
                <DelayBadge delay={lot.delay} />
              </div>
              <p className="text-sm text-slate-500">
                {po.customer.companyName} {po.poNumber && `· ${po.poNumber}`} · Combined {lot.preProduction.combinedQty} / {lot.preProduction.plannedQty}
              </p>
            </div>
          </div>
          <ExportReportButton lot={lot} />
        </div>
      </div>

      <StageProgressStrip lot={lot} />

      <CurrentStageCard lot={lot} />

      <LinkedRecordsCard lot={lot} />

      <RecycleLogHistory lot={lot} />

      <StageHistory lot={lot} />
    </div>
  );
}

function StageProgressStrip({ lot }: { lot: CombinedLot }) {
  const { hasRole } = useAuth();
  const isAdmin = hasRole("ADMIN");
  const currentStageId = lot.currentStageId;
  const currentIndex = COMBINED_LOT_STAGE_ORDER.indexOf(currentStageId);
  const transition = useTransitionCombinedLotStage(lot.id);
  const toast = useToast();

  async function jumpTo(stage: CombinedLotStageId) {
    if (stage === currentStageId) return;
    if (!window.confirm(`Move this lot directly to "${COMBINED_LOT_STAGE_LABEL[stage]}"? This bypasses the normal forward/send-back flow.`)) return;
    try {
      await transition.mutateAsync({ action: "JUMP", targetStageId: stage } as never);
      toast.success(`Moved to ${COMBINED_LOT_STAGE_LABEL[stage]}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not move the lot");
    }
  }

  return (
    <div className="card p-4 sm:p-5">
      {isAdmin && (
        <p className="mb-2.5 flex items-center gap-1.5 text-[10.5px] font-bold text-slate-400">
          <Shuffle className="h-3 w-3" strokeWidth={2.5} /> Admin: click any stage to move this lot there directly.
        </p>
      )}
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
              {isAdmin && !isCurrent ? (
                <button type="button" disabled={transition.isPending} onClick={() => jumpTo(stage)} className={`${pillClass} cursor-pointer transition-colors hover:border-slate-300 hover:bg-slate-100`}>
                  {icon}
                  {COMBINED_LOT_STAGE_LABEL[stage]}
                </button>
              ) : (
                <div className={pillClass}>
                  {icon}
                  {COMBINED_LOT_STAGE_LABEL[stage]}
                </div>
              )}
              {idx < COMBINED_LOT_STAGE_ORDER.length - 1 && <ArrowRight className="h-3 w-3 shrink-0 text-slate-300" strokeWidth={2.5} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExportReportButton({ lot }: { lot: CombinedLot }) {
  const { hasRole } = useAuth();
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  if (!hasRole("ADMIN") || lot.currentStageId !== "DISPATCH_PLAN") return null;

  return (
    <button
      type="button"
      className="btn-ghost btn-sm"
      disabled={downloading}
      onClick={async () => {
        setDownloading(true);
        try {
          await downloadFile(`/api/combined-lots/${lot.id}/export.pdf`, `FLS_Production_Report_${lot.id}.pdf`);
        } catch (err) {
          toast.error(err instanceof ApiError ? err.message : "Could not export the report");
        } finally {
          setDownloading(false);
        }
      }}
    >
      <Download className="h-3.5 w-3.5" strokeWidth={2.5} /> {downloading ? "Exporting…" : "Export Report"}
    </button>
  );
}

function CurrentStageCard({ lot }: { lot: CombinedLot }) {
  const { hasRole } = useAuth();
  const stage = lot.currentStageId;
  const roles = COMBINED_LOT_STAGE_ROLE[stage];
  const canAct = hasRole(...roles);
  const roleLabel = roles.join(" / ");
  const fields = COMBINED_LOT_STAGE_FIELDS[stage];
  const forwardTarget = getForwardTarget(stage);
  const rejectTarget = getRejectTarget(stage);
  const isTerminal = stage === "DISPATCH_PLAN";

  const transition = useTransitionCombinedLotStage(lot.id);
  const toast = useToast();

  const [values, setValues] = useState<Record<string, string>>({});
  const [showReject, setShowReject] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dispatchTransferId, setDispatchTransferId] = useState(lot.dispatchTransferId ?? "");

  useEffect(() => {
    if (fields) setValues(Object.fromEntries(fields.map((f) => [f.name, fieldValue(lot, f.name)])));
    setShowReject(false);
    setNote("");
    setError(null);
    setDispatchTransferId(lot.dispatchTransferId ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lot.id, lot.currentStageId]);

  async function handleForward(confirmPartialDispatch = false) {
    setError(null);
    const body: Record<string, unknown> = { action: "FORWARD" };
    for (const [key, value] of Object.entries(values)) {
      if (value !== "") body[key] = value;
    }
    if (stage === "BILLING_EWAY_BILL" || stage === "DISPATCH_PLAN") body.dispatchTransferId = dispatchTransferId || null;
    if (confirmPartialDispatch) body.confirmPartialDispatch = true;
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
      // DISPATCH_PLAN only — the real business rule is one PO ships as one
      // combined shipment. This 409 means a sibling item's lot on the
      // same PO hasn't reached Dispatch Plan yet; offer the explicit
      // override instead of just failing, since a genuine partial
      // shipment is sometimes the right call.
      const siblingsNotReady =
        (err instanceof ApiError && (err.details as { siblingsNotReady?: { productName: string; currentStageLabel: string }[] } | undefined)?.siblingsNotReady) || null;
      if (siblingsNotReady && siblingsNotReady.length > 0) {
        const list = siblingsNotReady.map((s) => `• ${s.productName} — still at ${s.currentStageLabel}`).join("\n");
        const proceed = window.confirm(`This PO normally ships as one combined shipment, but these items aren't at Dispatch Plan yet:\n\n${list}\n\nDispatch this lot separately anyway?`);
        if (proceed) return handleForward(true);
        return;
      }
      const msg = err instanceof ApiError ? err.message : "Could not save";
      setError(msg);
      toast.error(msg);
    }
  }

  async function handleReject() {
    setError(null);
    if (!note.trim()) {
      setError("A note is required when sending a lot back.");
      return;
    }
    try {
      await transition.mutateAsync({ action: "REJECT", note: note.trim() } as never);
      toast.success(`Sent back to ${rejectTarget ? COMBINED_LOT_STAGE_LABEL[rejectTarget] : "the previous stage"}.`);
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

        {stage === "IPQC" && <BulkReconciliationReadout values={values} saved={lot.bulkReconciliation} />}

        {stage === "IPQC" && <ChecklistPanelForCombinedLot lotId={lot.id} title="Line Clearance Checklist — bulk manufacturing area (per BMR-1, 4.0)" deptLabel="Production" canEditDept={hasRole("PRODUCTION")} rows={lot.lineClearanceChecklist} />}

        {stage === "BULK_QC" && <CoaPanel lot={lot} />}

        {canAct && (stage === "BILLING_EWAY_BILL" || stage === "DISPATCH_PLAN") && (
          <DispatchTransferLinker customerId={lot.preProduction.purchaseOrderItem.purchaseOrder.customer.id} value={dispatchTransferId} onChange={setDispatchTransferId} />
        )}

        {error && <p className="mt-3 text-xs font-bold text-rose-600">{error}</p>}

        {canAct && (
          <div className="mt-4 space-y-3">
            {showReject ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3">
                <label className="label !text-rose-500">Why is this being sent back?</label>
                <textarea className="field min-h-[4.5rem] resize-y" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Required — e.g. wrong vendor PO date, quantity mismatch…" />
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setShowReject(false)}>
                    Cancel
                  </button>
                  <button type="button" className="btn-danger btn-sm" disabled={transition.isPending} onClick={handleReject}>
                    {transition.isPending ? "Sending…" : `Send Back to ${rejectTarget ? COMBINED_LOT_STAGE_LABEL[rejectTarget] : "Previous Stage"}`}
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
                <button type="button" className="btn-primary" disabled={transition.isPending} onClick={() => handleForward()}>
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

function BulkReconciliationReadout({ values, saved }: { values: Record<string, string>; saved: { yieldPct: number | null; processLoss: number | null } }) {
  const a = Number(values.bulkTheoreticalWeight);
  const b = Number(values.bulkActualWeight);
  const c = values.bulkQcSampleWeight ? Number(values.bulkQcSampleWeight) : 0;
  const hasLiveInputs = values.bulkTheoreticalWeight && values.bulkActualWeight && a > 0;
  const liveYield = hasLiveInputs ? Math.round(((b + c) / a) * 1000) / 10 : null;
  const liveLoss = hasLiveInputs ? Math.max(0, Math.round((a - (b + c)) * 1000) / 1000) : null;
  const yieldPct = liveYield ?? saved.yieldPct;
  const processLoss = liveLoss ?? saved.processLoss;

  if (yieldPct === null) return null;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl border border-violet-200 bg-violet-50/50 px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs font-bold text-violet-800">
        <Beaker className="h-3.5 w-3.5" /> Bulk Reconciliation — Yield {"{(b+c)/a×100}"}
      </p>
      <span className={`font-mono text-sm font-black ${yieldPct >= 99 ? "text-emerald-700" : "text-amber-700"}`}>{yieldPct}%</span>
      <span className="text-[10.5px] font-semibold text-violet-600">{yieldPct >= 99 ? "Meets NLT 99.0%" : "Below the doc's NLT 99.0% floor"}</span>
      {processLoss !== null && <span className="font-mono text-xs text-slate-500">Process loss: {processLoss}</span>}
    </div>
  );
}

function ChecklistPanelForCombinedLot({ lotId, title, deptLabel, canEditDept, rows }: { lotId: string; title: string; deptLabel: string; canEditDept: boolean; rows: import("../lib/types").ChecklistRow[] }) {
  const update = useUpdateCombinedLotChecklist(lotId);
  const toast = useToast();
  async function toggle(column: "DEPT" | "QA", itemKey: string, current: boolean | null) {
    try {
      await update.mutateAsync({ column, items: [{ itemKey, ok: !current }] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }
  return <ChecklistPanel title={title} deptLabel={deptLabel} canEditDept={canEditDept} rows={rows} onToggle={toggle} pending={update.isPending} />;
}

interface CoaRow {
  testName: string;
  specification: string;
  observation: string;
}

const COA_SIGN_STEPS = [
  { step: "ANALYZED" as const, label: "Analyzed By" },
  { step: "REVIEWED" as const, label: "Reviewed By" },
  { step: "APPROVED" as const, label: "Approved By" },
];

function CoaPanel({ lot }: { lot: CombinedLot }) {
  const { hasRole } = useAuth();
  const canEdit = hasRole("QA_QC", "RND");
  const replaceResults = useReplaceCoaResults(lot.id);
  const sign = useSignCoa(lot.id);
  const toast = useToast();

  const [rows, setRows] = useState<CoaRow[]>(
    lot.coaResults.length > 0 ? lot.coaResults.map((r) => ({ testName: r.testName, specification: r.specification ?? "", observation: r.observation ?? "" })) : [{ testName: "", specification: "", observation: "" }],
  );

  function updateRow(idx: number, patch: Partial<CoaRow>) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, { testName: "", specification: "", observation: "" }]);
  }
  function removeRow(idx: number) {
    setRows((rs) => rs.filter((_, i) => i !== idx));
  }

  async function handleSaveResults() {
    const usable = rows.filter((r) => r.testName.trim());
    try {
      await replaceResults.mutateAsync(usable.map((r) => ({ testName: r.testName, specification: r.specification || undefined, observation: r.observation || undefined })));
      toast.success("COA results saved.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function handleSign(step: "ANALYZED" | "REVIEWED" | "APPROVED") {
    try {
      await sign.mutateAsync(step);
      toast.success(`Signed — ${step.toLowerCase()}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not sign");
    }
  }

  const signedAt: Record<string, { byName: string | null; at: string | null }> = {
    ANALYZED: { byName: lot.coaAnalyzedByName, at: lot.coaAnalyzedAt },
    REVIEWED: { byName: lot.coaReviewedByName, at: lot.coaReviewedAt },
    APPROVED: { byName: lot.coaApprovedByName, at: lot.coaApprovedAt },
  };
  const firstUnsignedIdx = COA_SIGN_STEPS.findIndex((s) => !signedAt[s.step]!.byName);

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-sky-200">
      <div className="flex items-center gap-1.5 bg-sky-100/70 px-3 py-2">
        <ClipboardList className="h-3.5 w-3.5 text-sky-700" strokeWidth={2.25} />
        <p className="text-xs font-bold text-sky-800">Certificate of Analysis</p>
      </div>

      <div className="space-y-2 bg-white p-3">
        <div className="flex items-center gap-2 px-1 text-[9px] font-bold uppercase tracking-wide text-slate-400">
          <span className="flex-1">Test Parameter</span>
          <span className="w-40">Specification</span>
          <span className="w-40">Observation</span>
        </div>
        {rows.map((row, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <input className="field !h-7 flex-1 !py-0 !text-xs" placeholder="e.g. Moisture" disabled={!canEdit} value={row.testName} onChange={(e) => updateRow(idx, { testName: e.target.value })} />
            <input className="field !h-7 w-40 !py-0 !text-xs" placeholder="e.g. NMT 7% (w/w)" disabled={!canEdit} value={row.specification} onChange={(e) => updateRow(idx, { specification: e.target.value })} />
            <input className="field !h-7 w-40 !py-0 !text-xs" placeholder="Observed result" disabled={!canEdit} value={row.observation} onChange={(e) => updateRow(idx, { observation: e.target.value })} />
            {canEdit && (
              <button type="button" className="btn-icon h-6 w-6 shrink-0 hover:!bg-rose-50 hover:!text-rose-600" aria-label="Remove row" onClick={() => removeRow(idx)}>
                <Trash2 className="h-3 w-3" strokeWidth={2.25} />
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <div className="flex items-center gap-2 pt-1">
            <button type="button" className="btn-ghost btn-sm" onClick={addRow}>
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Add Test
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={replaceResults.isPending} onClick={handleSaveResults}>
              {replaceResults.isPending ? "Saving…" : "Save Results"}
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-slate-100 bg-slate-50/60 px-3 py-2.5">
        {COA_SIGN_STEPS.map(({ step, label }, idx) => {
          const info = signedAt[step]!;
          const isNext = idx === firstUnsignedIdx;
          return info.byName ? (
            <span key={step} className="pill border-emerald-200 bg-emerald-50 text-emerald-700">
              <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} /> {label} — {info.byName}
            </span>
          ) : (
            <button key={step} type="button" className="btn-ghost btn-sm" disabled={!canEdit || !isNext || sign.isPending} title={!isNext ? "Sign the earlier step(s) first" : undefined} onClick={() => handleSign(step)}>
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DispatchTransferLinker({ customerId, value, onChange }: { customerId: string; value: string; onChange: (id: string) => void }) {
  const { data: transfers } = useDispatchTransfers({ type: "FG", customerId });
  const items = (transfers ?? []).map((t) => ({ id: t.id, name: `${t.productName} · ${t.quantity} · ${new Date(t.date).toLocaleDateString()}${t.invoiceNumber ? ` · Inv ${t.invoiceNumber}` : ""}` }));
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <label className="label flex items-center gap-1.5">
        <Link2 className="h-3 w-3" strokeWidth={2.5} /> Link to FG Dispatch Transfer — optional, traceability only
      </label>
      <ItemPicker items={items} value={value} onChange={onChange} placeholder="— Not linked —" />
    </div>
  );
}

function RecycleLogHistory({ lot }: { lot: CombinedLot }) {
  if (lot.recycleLogs.length === 0) return null;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
          <Trash2 className="h-3.5 w-3.5" /> Recycle Store — Wastage
        </h3>
      </div>
      <div className="divide-y divide-slate-100">
        {lot.recycleLogs.map((r) => (
          <div key={r.id} className="flex items-center justify-between px-4 py-2.5">
            <span className="text-xs font-bold text-slate-700">{r.stageId === "QA_GATE_MFG" ? "QA Gate — Manufacturing" : "QA Gate — Packaging"}</span>
            <span className="flex items-center gap-2 text-xs">
              <span className="font-mono font-bold text-amber-700">
                {r.quantity} {r.unit}
              </span>
              <span className="text-slate-400">{new Date(r.createdAt).toLocaleDateString()}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LinkedRecordsCard({ lot }: { lot: CombinedLot }) {
  if (!lot.dispatchTransfer) return null;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
          <Link2 className="h-3.5 w-3.5" /> Linked Records
        </h3>
      </div>
      <div className="px-4 py-2.5 text-xs">
        <p className="py-1.5">
          <span className="font-bold text-slate-700">FG Dispatch Transfer:</span> {lot.dispatchTransfer.productName} · {lot.dispatchTransfer.quantity}
          {lot.dispatchTransfer.invoiceNumber && ` · Inv ${lot.dispatchTransfer.invoiceNumber}`}
          {lot.dispatchTransfer.qcStatus && ` · QC ${lot.dispatchTransfer.qcStatus}`}
        </p>
      </div>
    </div>
  );
}

function StageHistory({ lot }: { lot: CombinedLot }) {
  if (lot.stageEvents.length === 0) {
    return <EmptyState icon={ClipboardEdit} title="No history yet" hint="Every forward and send-back on this lot will show up here." accent="slate" />;
  }
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-600">History</h3>
      </div>
      <div className="divide-y divide-slate-100">
        {[...lot.stageEvents].reverse().map((e) => (
          <div key={e.id} className="flex items-start gap-3 px-4 py-3">
            <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${e.action === "REJECT" ? "bg-rose-100 text-rose-600" : e.action === "JUMP" ? "bg-amber-100 text-amber-600" : "bg-emerald-100 text-emerald-600"}`}>
              {e.action === "REJECT" ? <Undo2 className="h-3 w-3" strokeWidth={2.5} /> : e.action === "JUMP" ? <Shuffle className="h-3 w-3" strokeWidth={2.5} /> : <Check className="h-3 w-3" strokeWidth={3} />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-slate-700">
                {COMBINED_LOT_STAGE_LABEL[e.fromStageId]} <span className="text-slate-300">→</span> {COMBINED_LOT_STAGE_LABEL[e.toStageId]}
              </p>
              {e.note && <p className="mt-0.5 text-xs text-slate-500">{e.note}</p>}
              <p className="mt-0.5 text-[10px] text-slate-400">
                {e.actorName} · {new Date(e.createdAt).toLocaleString()}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
