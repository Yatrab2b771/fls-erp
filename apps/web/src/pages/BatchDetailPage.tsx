import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Beaker, Check, ClipboardEdit, Download, FlaskConical, Lock, Pencil, Plus, Shuffle, Trash2, Undo2 } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useAssignBatchPlant, useBatch, useCreatePlant, useInventoryItems, usePlants, useTransitionBatchStage } from "../lib/hooks";
import { BATCH_STAGE_FIELDS, BATCH_STAGE_LABEL, BATCH_STAGE_ORDER, BATCH_STAGE_ROLE, getForwardTarget, getRejectTarget } from "../lib/batchStage";
import { FieldGrid } from "../components/FieldGrid";
import { PickerWithAdd } from "../components/PickerWithAdd";
import { DelayBadge, WastageBadge } from "../components/Badges";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { ApiError, downloadFile } from "../lib/api";
import type { Batch, BatchStageId } from "../lib/types";

function fieldValue(batch: Batch, name: string): string {
  const raw = (batch as unknown as Record<string, unknown>)[name];
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);
  return String(raw);
}

export function BatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: batch, isLoading } = useBatch(id);

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
  if (!batch) return <EmptyState icon={FlaskConical} title="Batch not found" accent="rose" />;

  const po = batch.purchaseOrderItem.purchaseOrder;

  return (
    <div className="space-y-6">
      <Link to={`/purchase-orders/${po.id}`} className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> {po.poNumber ?? po.id.slice(0, 8)}
      </Link>

      <div className="card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3.5">
            <div className="stat-icon bg-violet-50 text-violet-600">
              <FlaskConical className="h-5 w-5" strokeWidth={2} />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-black tracking-tight text-slate-900">{batch.batchNo ?? batch.id.slice(0, 8)}</h1>
                <DelayBadge delay={batch.delay} />
                <WastageBadge wastage={batch.wastage} />
              </div>
              <p className="text-sm text-slate-500">
                {batch.purchaseOrderItem.productName} · {po.customer.companyName}
              </p>
              <div className="mt-1.5">
                <BatchPlantControl batch={batch} />
              </div>
            </div>
          </div>
          <ExportReportButton batch={batch} />
        </div>
      </div>

      <StageProgressStrip batch={batch} />

      <CurrentStageCard batch={batch} />

      <ConsumptionHistory batch={batch} />

      <StageHistory batch={batch} />
    </div>
  );
}

// Visible to every department, always — this is the "everyone can see the
// batch's status" requirement. Only the current stage's owning role can
// act (see CurrentStageCard) — except ADMIN, who can click any stage here
// to move the batch there directly, bypassing the normal forward/reject
// sequence (for fixing a batch stuck in the wrong place).
function StageProgressStrip({ batch }: { batch: Batch }) {
  const { hasRole } = useAuth();
  const isAdmin = hasRole("ADMIN");
  const currentStageId = batch.currentStageId;
  const currentIndex = BATCH_STAGE_ORDER.indexOf(currentStageId);

  const transition = useTransitionBatchStage(batch.id);
  const toast = useToast();

  async function jumpTo(stage: BatchStageId) {
    if (stage === currentStageId) return;
    if (!window.confirm(`Move this batch directly to "${BATCH_STAGE_LABEL[stage]}"? This bypasses the normal forward/send-back flow.`)) return;
    try {
      await transition.mutateAsync({ action: "JUMP", targetStageId: stage } as never);
      toast.success(`Moved to ${BATCH_STAGE_LABEL[stage]}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not move the batch");
    }
  }

  return (
    <div className="card p-4 sm:p-5">
      {isAdmin && (
        <p className="mb-2.5 flex items-center gap-1.5 text-[10.5px] font-bold text-slate-400">
          <Shuffle className="h-3 w-3" strokeWidth={2.5} /> Admin: click any stage to move this batch there directly.
        </p>
      )}
      <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-none">
        {BATCH_STAGE_ORDER.map((stage, idx) => {
          const isDone = idx < currentIndex;
          const isCurrent = idx === currentIndex;
          const pillClass = `flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10.5px] font-bold whitespace-nowrap ${
            isCurrent
              ? "border-brand-300 bg-brand-50 text-brand-700 shadow-soft"
              : isDone
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-slate-200 bg-slate-50 text-slate-400"
          }`;
          const icon = isDone ? <Check className="h-3 w-3" strokeWidth={3} /> : isCurrent ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" /> : <Lock className="h-2.5 w-2.5" strokeWidth={2.5} />;
          return (
            <div key={stage} className="flex shrink-0 items-center gap-1">
              {isAdmin && !isCurrent ? (
                <button type="button" disabled={transition.isPending} onClick={() => jumpTo(stage)} className={`${pillClass} cursor-pointer transition-colors hover:border-slate-300 hover:bg-slate-100`}>
                  {icon}
                  {BATCH_STAGE_LABEL[stage]}
                </button>
              ) : (
                <div className={pillClass}>
                  {icon}
                  {BATCH_STAGE_LABEL[stage]}
                </div>
              )}
              {idx < BATCH_STAGE_ORDER.length - 1 && <ArrowRight className="h-3 w-3 shrink-0 text-slate-300" strokeWidth={2.5} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Admin-only, and only once the batch has actually reached Dispatch Plan —
// the "full report" is the batch's closing record, not a mid-flight
// snapshot.
function ExportReportButton({ batch }: { batch: Batch }) {
  const { hasRole } = useAuth();
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  if (!hasRole("ADMIN") || batch.currentStageId !== "DISPATCH_PLAN") return null;

  return (
    <button
      type="button"
      className="btn-ghost btn-sm"
      disabled={downloading}
      onClick={async () => {
        setDownloading(true);
        try {
          await downloadFile(`/api/batches/${batch.id}/export.pdf`, `FLS_Batch_Report_${batch.batchNo ?? batch.id}.pdf`);
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

// Which Plant this batch runs at — PPIC's call, any time (not just at
// creation). Needed before Dispensing can log real consumption against
// it (see DispensingConsumption below) — shown to everyone, editable
// only by PPIC/ADMIN.
function BatchPlantControl({ batch }: { batch: Batch }) {
  const { hasRole } = useAuth();
  const toast = useToast();
  const { data: plants } = usePlants();
  const createPlant = useCreatePlant();
  const assignPlant = useAssignBatchPlant(batch.id);
  const [editing, setEditing] = useState(false);
  const [plantId, setPlantId] = useState(batch.plantId ?? "");
  const canEdit = hasRole("PPIC") || hasRole("ADMIN");

  async function handleSave() {
    try {
      await assignPlant.mutateAsync(plantId || null);
      toast.success(plantId ? "Plant assigned." : "Plant cleared.");
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not assign Plant");
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5">
        {batch.plant ? (
          <span className="pill border-violet-200 bg-violet-50 text-violet-700">
            <Beaker className="h-3 w-3" strokeWidth={2.5} /> {batch.plant.name}
          </span>
        ) : (
          <span className="pill border-slate-200 bg-slate-50 text-slate-400">
            <Beaker className="h-3 w-3" strokeWidth={2.5} /> No Plant assigned
          </span>
        )}
        {canEdit && (
          <button
            type="button"
            className="btn-icon h-6 w-6"
            title="Assign / change Plant"
            onClick={() => {
              setPlantId(batch.plantId ?? "");
              setEditing(true);
            }}
          >
            <Pencil className="h-3 w-3" strokeWidth={2.25} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-end gap-2">
      <div className="w-56">
        <PickerWithAdd label="Plant" placeholder="— No Plant —" options={plants ?? []} value={plantId} onChange={setPlantId} onCreate={(name) => createPlant.mutateAsync(name)} />
      </div>
      <button type="button" className="btn-primary btn-sm" disabled={assignPlant.isPending} onClick={handleSave}>
        {assignPlant.isPending ? "…" : "Save"}
      </button>
      <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </div>
  );
}

function CurrentStageCard({ batch }: { batch: Batch }) {
  const { hasRole } = useAuth();
  const stage = batch.currentStageId;
  const role = BATCH_STAGE_ROLE[stage];
  const canAct = hasRole(role);
  const fields = BATCH_STAGE_FIELDS[stage];
  const forwardTarget = getForwardTarget(stage);
  const rejectTarget = getRejectTarget(stage);
  const isTerminal = stage === "DISPATCH_PLAN";

  const transition = useTransitionBatchStage(batch.id);
  const toast = useToast();

  const [values, setValues] = useState<Record<string, string>>({});
  const [showReject, setShowReject] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [consumptionLines, setConsumptionLines] = useState<ConsumptionLine[]>([]);

  useEffect(() => {
    if (fields) setValues(Object.fromEntries(fields.map((f) => [f.name, fieldValue(batch, f.name)])));
    setShowReject(false);
    setNote("");
    setError(null);
    setConsumptionLines([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.id, batch.currentStageId]);

  async function handleForward() {
    setError(null);
    const body: Record<string, unknown> = { action: "FORWARD" };
    for (const [key, value] of Object.entries(values)) {
      if (value !== "") body[key] = value;
    }
    if (stage === "DISPENSING" && consumptionLines.length > 0) {
      body.consumption = consumptionLines.map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), unit: l.unit }));
    }
    try {
      await transition.mutateAsync(body as never);
      toast.success(isTerminal ? "Dispatch details saved." : `Forwarded to ${BATCH_STAGE_LABEL[forwardTarget]}.`);
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
      await transition.mutateAsync({ action: "REJECT", note: note.trim() } as never);
      toast.success(`Sent back to ${rejectTarget ? BATCH_STAGE_LABEL[rejectTarget] : "the previous stage"}.`);
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
          <ClipboardEdit className="h-3.5 w-3.5" /> {BATCH_STAGE_LABEL[stage]}
        </h3>
        <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${canAct ? "border-brand-200 bg-brand-50 text-brand-700" : "border-slate-200 bg-slate-100 text-slate-400"}`}>
          {role}
        </span>
      </div>

      <div className="p-4">
        {!canAct ? (
          // Not your department's stage — only the stage name and who owns
          // it, not the field form itself (that's the owning department's
          // business until they forward or send it back).
          <p className="flex items-center gap-1.5 text-xs text-slate-400">
            <Lock className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} /> Waiting on the {role} department to {fields ? "fill this in and " : ""}move it forward.
          </p>
        ) : fields ? (
          <FieldGrid fields={fields} values={values} disabled={!canAct} onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))} />
        ) : (
          <p className="text-xs text-slate-400">This stage is status-only — no fields to fill, just forward or send it back.</p>
        )}

        {canAct && stage === "DISPENSING" && <DispensingConsumptionEditor hasPlant={!!batch.plantId} lines={consumptionLines} onChange={setConsumptionLines} />}

        {error && <p className="mt-3 text-xs font-bold text-rose-600">{error}</p>}

        {canAct && (
          <div className="mt-4 space-y-3">
            {showReject ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3">
                <label className="label !text-rose-500">Why is this being sent back?</label>
                <textarea
                  className="field min-h-[4.5rem] resize-y"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Required — e.g. wrong vendor PO date, quantity mismatch…"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setShowReject(false)}>
                    Cancel
                  </button>
                  <button type="button" className="btn-danger btn-sm" disabled={transition.isPending} onClick={handleReject}>
                    {transition.isPending ? "Sending…" : `Send Back to ${rejectTarget ? BATCH_STAGE_LABEL[rejectTarget] : "Previous Stage"}`}
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
                  {transition.isPending ? "Saving…" : isTerminal ? "Save Dispatch Details" : `Forward to ${BATCH_STAGE_LABEL[forwardTarget]}`}
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

interface ConsumptionLine {
  itemId: string;
  itemName: string;
  quantity: string;
  unit: string;
}

// Real RM/PM consumption — Dispensing only, entirely optional (a batch
// can still move through Dispensing with just the date/remark fields
// above, same as before this existed). Each line becomes a
// BatchMaterialConsumption row on forward, reducing the batch's Plant's
// real-time balance — see stock.ts getOnHandByPlantAndItem.
function DispensingConsumptionEditor({ hasPlant, lines, onChange }: { hasPlant: boolean; lines: ConsumptionLine[]; onChange: (lines: ConsumptionLine[]) => void }) {
  const [category, setCategory] = useState<"RM" | "PM">("RM");
  const { data: items } = useInventoryItems(category);
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("Kg");

  function addLine() {
    const item = items?.find((i) => i.id === itemId);
    if (!item || !quantity || Number(quantity) <= 0) return;
    onChange([...lines, { itemId, itemName: item.name, quantity, unit }]);
    setItemId("");
    setQuantity("");
  }

  function removeLine(idx: number) {
    onChange(lines.filter((_, i) => i !== idx));
  }

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <p className="mb-2 text-xs font-bold text-slate-600">RM/PM Consumption — optional, reduces this batch's Plant balance</p>
      {!hasPlant ? (
        <p className="flex items-center gap-1.5 text-xs font-bold text-amber-600">
          <Lock className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} /> This batch has no Plant assigned — ask PPIC to set one (above) before logging consumption.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <select
              className="field w-auto"
              value={category}
              onChange={(e) => {
                setCategory(e.target.value as "RM" | "PM");
                setItemId("");
              }}
            >
              <option value="RM">Raw Material</option>
              <option value="PM">Packaging Material</option>
            </select>
            <select className="field min-w-0 flex-1" value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">— Select item —</option>
              {items?.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
            <input className="field w-24 font-mono" type="number" min="0" step="any" placeholder="Qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            <input className="field w-20" placeholder="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
            <button type="button" className="btn-ghost shrink-0" onClick={addLine}>
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Add
            </button>
          </div>
          {lines.length > 0 && (
            <div className="mt-2 space-y-1">
              {lines.map((l, idx) => (
                <div key={idx} className="flex items-center justify-between rounded-lg bg-white px-2.5 py-1.5 text-xs">
                  <span className="font-bold text-slate-700">{l.itemName}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-slate-600">
                      {l.quantity} {l.unit}
                    </span>
                    <button type="button" className="btn-icon h-6 w-6 hover:!bg-rose-50 hover:!text-rose-600" onClick={() => removeLine(idx)}>
                      <Trash2 className="h-3 w-3" strokeWidth={2.25} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Every consumption line ever logged on this batch — visible always
// (not just while at Dispensing), same "it's a ledger, look back any
// time" reasoning as StageHistory below.
function ConsumptionHistory({ batch }: { batch: Batch }) {
  if (batch.consumptions.length === 0) return null;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
          <Beaker className="h-3.5 w-3.5" /> RM/PM Consumption
        </h3>
      </div>
      <div className="divide-y divide-slate-100">
        {batch.consumptions.map((c) => (
          <div key={c.id} className="flex items-center justify-between px-4 py-2.5">
            <span className="text-xs font-bold text-slate-700">{c.item.name}</span>
            <span className="flex items-center gap-2 text-xs">
              <span className="font-mono font-bold text-slate-600">
                {c.quantity} {c.unit}
              </span>
              <span className="text-slate-400">
                {c.createdBy.fullName} · {new Date(c.createdAt).toLocaleDateString()}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StageHistory({ batch }: { batch: Batch }) {
  if (batch.stageEvents.length === 0) {
    return <EmptyState icon={ClipboardEdit} title="No history yet" hint="Every forward and send-back on this batch will show up here." accent="slate" />;
  }
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-600">History</h3>
      </div>
      <div className="divide-y divide-slate-100">
        {[...batch.stageEvents].reverse().map((e) => (
          <div key={e.id} className="flex items-start gap-3 px-4 py-3">
            <div
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                e.action === "REJECT" ? "bg-rose-100 text-rose-600" : e.action === "JUMP" ? "bg-amber-100 text-amber-600" : "bg-emerald-100 text-emerald-600"
              }`}
            >
              {e.action === "REJECT" ? <Undo2 className="h-3 w-3" strokeWidth={2.5} /> : e.action === "JUMP" ? <Shuffle className="h-3 w-3" strokeWidth={2.5} /> : <Check className="h-3 w-3" strokeWidth={3} />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-slate-700">
                {BATCH_STAGE_LABEL[e.fromStageId]} <span className="text-slate-300">→</span> {BATCH_STAGE_LABEL[e.toStageId]}
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
