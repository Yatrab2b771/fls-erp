import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Beaker, Check, CheckCircle2, ClipboardEdit, ClipboardList, FlaskConical, Layers, Link2, ListChecks, ListPlus, Lock, Pencil, Plus, Shuffle, Trash2, Undo2 } from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useAssignPreProductionPlant,
  useCompleteProductionBatch,
  useConfirmQcSampleTransfer,
  useConsumeQcSample,
  useCreatePlant,
  useCreateProductionBatch,
  useDispensingRequirements,
  useInventoryItems,
  useInventoryTransactions,
  usePlants,
  usePreProduction,
  useProductionBatches,
  useQcSampleSummary,
  useReturnQcSample,
  useTransitionPreProductionStage,
  useUpdatePreProductionChecklist,
  useUpdateProductionBatch,
  useVerifyConsumption,
} from "../lib/hooks";
import { PRE_PRODUCTION_STAGE_FIELDS, PRE_PRODUCTION_STAGE_LABEL, PRE_PRODUCTION_STAGE_ORDER, PRE_PRODUCTION_STAGE_ROLE, getForwardTarget, getRejectTarget } from "../lib/preProductionStage";
import { FieldGrid } from "../components/FieldGrid";
import { ItemPicker } from "../components/ItemPicker";
import { PickerWithAdd } from "../components/PickerWithAdd";
import { DelayBadge } from "../components/Badges";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { ApiError } from "../lib/api";
import type { ChecklistRow, DispensingRequirementItem, PreProduction, PreProductionStageId, ProductionBatch, QcSampleConsumeReason } from "../lib/types";

// --- Tier 1 of the three-tier production pipeline — see types.ts's own
// comment block above PreProduction/ProductionBatch/CombinedLot. This
// page owns Material Received through Sample QC Approval, then (once
// that gate clears) the ProductionBatch runs Production plans against
// it and the CombinedLot they combine into — see
// CombinedLotDetailPage.tsx for that back half. ---

const CATEGORY_OPTIONS = [
  { id: "RM", name: "Raw Material" },
  { id: "PM", name: "Packaging Material" },
];

interface AggregatedRequirement {
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  requiredQty: number;
  consumedQty: number;
  remainingQty: number;
}

function aggregateRequirements(items: DispensingRequirementItem[]): AggregatedRequirement[] {
  const byItem = new Map<string, AggregatedRequirement>();
  for (const i of items) {
    const existing = byItem.get(i.itemId);
    if (existing) {
      existing.requiredQty += i.requiredQty;
    } else {
      byItem.set(i.itemId, { itemId: i.itemId, itemName: i.itemName, category: i.category === "PM" ? "PM" : "RM", unit: i.unit, requiredQty: i.requiredQty, consumedQty: i.consumedQty, remainingQty: 0 });
    }
  }
  for (const row of byItem.values()) row.remainingQty = Math.max(row.requiredQty - row.consumedQty, 0);
  return [...byItem.values()];
}

function fillQty(n: number): string {
  const rounded = Number(n.toFixed(4));
  return String(rounded >= n ? rounded : Number((rounded + 0.0001).toFixed(4)));
}

function fieldValue(run: PreProduction, name: string): string {
  const raw = (run as unknown as Record<string, unknown>)[name];
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);
  return String(raw);
}

export function PreProductionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: run, isLoading } = usePreProduction(id);

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
  if (!run) return <EmptyState icon={FlaskConical} title="Production run not found" accent="rose" />;

  const po = run.purchaseOrderItem.purchaseOrder;

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
                <h1 className="text-xl font-black tracking-tight text-slate-900">{run.purchaseOrderItem.productName}</h1>
                <DelayBadge delay={run.delay} />
              </div>
              <p className="text-sm text-slate-500">{po.customer.companyName}</p>
              <div className="mt-1.5">
                <PreProductionPlantControl run={run} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <StageProgressStrip run={run} />

      <CurrentStageCard run={run} />

      <IndentRequestHistory run={run} />

      <LinkedRecordsCard run={run} />

      <ConsumptionHistory run={run} />

      {/* Tier 2/3 — only relevant once this run's own gate has cleared. */}
      <ProductionBatchesSection run={run} />

      <StageHistory run={run} />
    </div>
  );
}

function StageProgressStrip({ run }: { run: PreProduction }) {
  const { hasRole } = useAuth();
  const isAdmin = hasRole("ADMIN");
  const currentStageId = run.currentStageId;
  const currentIndex = PRE_PRODUCTION_STAGE_ORDER.indexOf(currentStageId);

  const transition = useTransitionPreProductionStage(run.id);
  const toast = useToast();

  async function jumpTo(stage: PreProductionStageId) {
    if (stage === currentStageId) return;
    if (!window.confirm(`Move this run directly to "${PRE_PRODUCTION_STAGE_LABEL[stage]}"? This bypasses the normal forward/send-back flow.`)) return;
    try {
      await transition.mutateAsync({ action: "JUMP", targetStageId: stage } as never);
      toast.success(`Moved to ${PRE_PRODUCTION_STAGE_LABEL[stage]}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not move the run");
    }
  }

  return (
    <div className="card p-4 sm:p-5">
      {isAdmin && (
        <p className="mb-2.5 flex items-center gap-1.5 text-[10.5px] font-bold text-slate-400">
          <Shuffle className="h-3 w-3" strokeWidth={2.5} /> Admin: click any stage to move this run there directly.
        </p>
      )}
      <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-none">
        {PRE_PRODUCTION_STAGE_ORDER.map((stage, idx) => {
          const isDone = idx < currentIndex || (idx === currentIndex && stage === "SAMPLE_QC_APPROVAL" && run.sampleQcStatus === "Approved");
          const isCurrent = idx === currentIndex && !isDone;
          const pillClass = `flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10.5px] font-bold whitespace-nowrap ${
            isCurrent ? "border-brand-300 bg-brand-50 text-brand-700 shadow-soft" : isDone ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-400"
          }`;
          const icon = isDone ? <Check className="h-3 w-3" strokeWidth={3} /> : isCurrent ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" /> : <Lock className="h-2.5 w-2.5" strokeWidth={2.5} />;
          return (
            <div key={stage} className="flex shrink-0 items-center gap-1">
              {isAdmin && idx !== currentIndex ? (
                <button type="button" disabled={transition.isPending} onClick={() => jumpTo(stage)} className={`${pillClass} cursor-pointer transition-colors hover:border-slate-300 hover:bg-slate-100`}>
                  {icon}
                  {PRE_PRODUCTION_STAGE_LABEL[stage]}
                </button>
              ) : (
                <div className={pillClass}>
                  {icon}
                  {PRE_PRODUCTION_STAGE_LABEL[stage]}
                </div>
              )}
              {idx < PRE_PRODUCTION_STAGE_ORDER.length - 1 && <ArrowRight className="h-3 w-3 shrink-0 text-slate-300" strokeWidth={2.5} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PreProductionPlantControl({ run }: { run: PreProduction }) {
  const { hasRole } = useAuth();
  const toast = useToast();
  const { data: plants } = usePlants();
  const createPlant = useCreatePlant();
  const assignPlant = useAssignPreProductionPlant(run.id);
  const [editing, setEditing] = useState(false);
  const [plantId, setPlantId] = useState(run.plantId ?? "");
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
        {run.plant ? (
          <span className="pill border-violet-200 bg-violet-50 text-violet-700">
            <Beaker className="h-3 w-3" strokeWidth={2.5} /> {run.plant.name}
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
              setPlantId(run.plantId ?? "");
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

function CurrentStageCard({ run }: { run: PreProduction }) {
  const { hasRole } = useAuth();
  const stage = run.currentStageId;
  const roles = PRE_PRODUCTION_STAGE_ROLE[stage];
  const canAct = hasRole(...roles);
  const roleLabel = roles.join(" / ");
  const fields = PRE_PRODUCTION_STAGE_FIELDS[stage];
  const forwardTarget = getForwardTarget(stage);
  const rejectTarget = getRejectTarget(stage);
  const isTerminal = stage === "SAMPLE_QC_APPROVAL";

  const transition = useTransitionPreProductionStage(run.id);
  const toast = useToast();

  const [values, setValues] = useState<Record<string, string>>({});
  const [showReject, setShowReject] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [consumptionLines, setConsumptionLines] = useState<ConsumptionLine[]>([]);
  const [indentLines, setIndentLines] = useState<IndentLine[]>([]);
  const [sourceReceiptId, setSourceReceiptId] = useState(run.sourceReceiptId ?? "");

  useEffect(() => {
    if (fields) setValues(Object.fromEntries(fields.map((f) => [f.name, fieldValue(run, f.name)])));
    setShowReject(false);
    setNote("");
    setError(null);
    setConsumptionLines([]);
    setIndentLines([]);
    setSourceReceiptId(run.sourceReceiptId ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, run.currentStageId]);

  async function handleForward() {
    setError(null);
    const body: Record<string, unknown> = { action: "FORWARD" };
    for (const [key, value] of Object.entries(values)) {
      if (value !== "") body[key] = value;
    }
    if (stage === "DISPENSING" && consumptionLines.length > 0) {
      body.consumption = consumptionLines.map((l) => ({
        itemId: l.itemId,
        quantity: Number(l.quantity),
        unit: l.unit,
        purpose: l.purpose,
        grossWeight: l.grossWeight ? Number(l.grossWeight) : undefined,
        tareWeight: l.tareWeight ? Number(l.tareWeight) : undefined,
        arNo: l.arNo || undefined,
      }));
    }
    if (stage === "INDENT_ISSUE" && indentLines.length > 0) {
      body.indentLines = indentLines.map((l) => ({ itemId: l.itemId, category: l.category, requestedQty: Number(l.requestedQty) }));
    }
    if (stage === "MATERIAL_RECEIVED") body.sourceReceiptId = sourceReceiptId || null;
    try {
      const result = await transition.mutateAsync(body as never);
      if (result.dispensingShortfall && result.dispensingShortfall.length > 0) {
        const list = result.dispensingShortfall.map((i) => `${i.itemName} (needs ${i.requiredQty} ${i.unit}, have ${i.consumedQty})`).join("; ");
        toast.error(`Saved — still short: ${list}`);
      } else if (stage === "LINE_CLEARANCE" && result.currentStageId === "LINE_CLEARANCE" && result.lineClearanceStatus !== "Approved") {
        toast.error(`Saved — can't move on to ${PRE_PRODUCTION_STAGE_LABEL[getForwardTarget(stage)]} until QC sets this to Approved.`);
      } else if (stage === "SAMPLE_QC_APPROVAL" && result.sampleQcStatus !== "Approved") {
        // This stage completes in place either way (its own terminal
        // stage — see pre-production-stage.ts), so currentStageId alone
        // can't tell "still pending" from "just Approved" the way every
        // earlier stage can; the literal status is what actually says so.
        toast.error("Saved — can't hand off to Production until QC sets this to Approved.");
      } else {
        toast.success(isTerminal ? "Saved." : `Forwarded to ${PRE_PRODUCTION_STAGE_LABEL[forwardTarget]}.`);
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
      setError("A note is required when sending a run back.");
      return;
    }
    try {
      await transition.mutateAsync({ action: "REJECT", note: note.trim() } as never);
      toast.success(`Sent back to ${rejectTarget ? PRE_PRODUCTION_STAGE_LABEL[rejectTarget] : "the previous stage"}.`);
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
          <ClipboardEdit className="h-3.5 w-3.5" /> {PRE_PRODUCTION_STAGE_LABEL[stage]}
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

        {stage === "DISPENSING" && <DispensingRequirementsChecklist preProductionId={run.id} />}

        {canAct && stage === "DISPENSING" && <DispensingConsumptionEditor preProductionId={run.id} hasPlant={!!run.plantId} lines={consumptionLines} onChange={setConsumptionLines} />}

        {stage === "SAMPLE_QC_APPROVAL" && <QcSampleApprovalPanel preProductionId={run.id} />}

        {stage === "LINE_CLEARANCE" && (
          <ChecklistPanelForPreProduction preProductionId={run.id} title="Line Clearance Checklist — dispensing area (per BMR-1, 1.0)" deptLabel="Store" canEditDept={hasRole("STORE")} rows={run.lineClearanceChecklist} />
        )}

        {canAct && stage === "INDENT_ISSUE" && <IndentRequestLinesEditor preProductionId={run.id} lines={indentLines} onChange={setIndentLines} />}

        {canAct && stage === "MATERIAL_RECEIVED" && <MaterialReceiptLinker value={sourceReceiptId} onChange={setSourceReceiptId} />}

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
                    {transition.isPending ? "Sending…" : `Send Back to ${rejectTarget ? PRE_PRODUCTION_STAGE_LABEL[rejectTarget] : "Previous Stage"}`}
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
                  {transition.isPending ? "Saving…" : isTerminal ? "Save" : `Forward to ${PRE_PRODUCTION_STAGE_LABEL[forwardTarget]}`}
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

function DispensingRequirementsChecklist({ preProductionId }: { preProductionId: string }) {
  const { data } = useDispensingRequirements(preProductionId);
  if (!data || data.items.length === 0) return null;
  const allCovered = data.items.every((i) => i.covered);
  return (
    <div className={`mt-4 rounded-xl border p-3 ${allCovered ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/60"}`}>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-slate-600">
        {allCovered ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2.5} /> : <ArrowRight className="h-3.5 w-3.5 text-amber-600" strokeWidth={2.5} />}
        Required for this product{allCovered ? " — all logged" : " — must be fully logged before this run can leave Dispensing"}
      </p>
      <div className="space-y-1">
        {data.items.map((i) => (
          <div key={i.itemId} className="flex items-center justify-between rounded-lg bg-white px-2.5 py-1.5 text-xs">
            <span className="font-bold text-slate-700">
              {i.itemName} <span className="text-slate-400">({i.category})</span>
            </span>
            <span className={`font-mono font-bold ${i.covered ? "text-emerald-600" : "text-amber-700"}`}>
              {i.consumedQty} / {i.requiredQty} {i.unit}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ConsumptionLine {
  itemId: string;
  itemName: string;
  quantity: string;
  unit: string;
  purpose: "PRODUCTION" | "SAMPLE" | "WASTE";
  grossWeight: string;
  tareWeight: string;
  arNo: string;
}

const CONSUMPTION_PURPOSE_OPTIONS = [
  { id: "PRODUCTION", name: "Production" },
  { id: "SAMPLE", name: "QC Sample" },
  { id: "WASTE", name: "Waste" },
];

function DispensingConsumptionEditor({
  preProductionId,
  hasPlant,
  lines,
  onChange,
}: {
  preProductionId: string;
  hasPlant: boolean;
  lines: ConsumptionLine[];
  onChange: (lines: ConsumptionLine[]) => void;
}) {
  const [category, setCategory] = useState<"RM" | "PM">("RM");
  const { data: items } = useInventoryItems(category);
  const { data: requirements } = useDispensingRequirements(preProductionId);
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("Kg");
  const [purpose, setPurpose] = useState<ConsumptionLine["purpose"]>("PRODUCTION");

  function addLine() {
    const item = items?.find((i) => i.id === itemId);
    if (!item || !quantity || Number(quantity) <= 0) return;
    onChange([...lines, { itemId, itemName: item.name, quantity, unit, purpose, grossWeight: "", tareWeight: "", arNo: "" }]);
    setItemId("");
    setQuantity("");
  }

  function removeLine(idx: number) {
    onChange(lines.filter((_, i) => i !== idx));
  }

  function updateLine(idx: number, patch: Partial<ConsumptionLine>) {
    onChange(lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  const stagedItemIds = new Set(lines.map((l) => l.itemId));
  const toFill = aggregateRequirements(requirements?.items ?? []).filter((r) => r.remainingQty > 0 && !stagedItemIds.has(r.itemId));

  function fillFromRequirement() {
    onChange([...lines, ...toFill.map((r) => ({ itemId: r.itemId, itemName: r.itemName, quantity: fillQty(r.remainingQty), unit: r.unit, purpose: "PRODUCTION" as const, grossWeight: "", tareWeight: "", arNo: "" }))]);
  }

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <p className="mb-2 text-xs font-bold text-slate-600">
        RM/PM Consumption — optional, reduces this run's Plant balance. Split Production/Sample/Waste — a Sample line is sent on to QC for Sample QC Approval, a Waste line goes straight to the
        Recycle Store.
      </p>
      {!hasPlant ? (
        <p className="flex items-center gap-1.5 text-xs font-bold text-amber-600">
          <Lock className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} /> This run has no Plant assigned — ask PPIC to set one (above) before logging consumption.
        </p>
      ) : (
        <>
          {toFill.length > 0 && (
            <button type="button" className="btn-ghost btn-sm mb-2" onClick={fillFromRequirement}>
              <ListPlus className="h-3.5 w-3.5" strokeWidth={2.5} /> Fill {toFill.length} remaining {toFill.length === 1 ? "item" : "items"} from requirement
            </button>
          )}
          <div className="flex flex-wrap gap-2">
            <div className="w-40">
              <ItemPicker
                items={CATEGORY_OPTIONS}
                value={category}
                onChange={(v) => {
                  setCategory(v as "RM" | "PM");
                  setItemId("");
                }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <ItemPicker items={items ?? []} value={itemId} onChange={setItemId} placeholder="— Select item —" />
            </div>
            <input className="field w-24 font-mono" type="number" min="0" step="any" placeholder="Qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            <input className="field w-20" placeholder="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
            <div className="w-32">
              <ItemPicker items={CONSUMPTION_PURPOSE_OPTIONS} value={purpose} onChange={(v) => setPurpose(v as ConsumptionLine["purpose"])} />
            </div>
            <button type="button" className="btn-ghost shrink-0" onClick={addLine}>
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Add
            </button>
          </div>
          {lines.length > 0 && (
            <div className="mt-2 space-y-1">
              {lines.map((l, idx) => (
                <div key={idx} className="flex flex-wrap items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate font-bold text-slate-700" title={l.itemName}>
                    {l.itemName}
                  </span>
                  <input className="field !h-7 w-24 !py-0 font-mono !text-xs" type="number" min="0" step="any" aria-label={`Quantity for ${l.itemName}`} value={l.quantity} onChange={(e) => updateLine(idx, { quantity: e.target.value })} />
                  <input className="field !h-7 w-16 !py-0 !text-xs" aria-label={`Unit for ${l.itemName}`} value={l.unit} onChange={(e) => updateLine(idx, { unit: e.target.value })} />
                  <div className="w-28">
                    <ItemPicker items={CONSUMPTION_PURPOSE_OPTIONS} value={l.purpose} onChange={(v) => updateLine(idx, { purpose: v as ConsumptionLine["purpose"] })} />
                  </div>
                  <button type="button" className="btn-icon h-6 w-6 shrink-0 hover:!bg-rose-50 hover:!text-rose-600" aria-label={`Remove ${l.itemName}`} onClick={() => removeLine(idx)}>
                    <Trash2 className="h-3 w-3" strokeWidth={2.25} />
                  </button>
                  <div className="flex w-full flex-wrap items-center gap-2 pl-1">
                    <input
                      className="field !h-6 w-20 !py-0 font-mono !text-[11px]"
                      type="number"
                      min="0"
                      step="any"
                      placeholder="Gross wt."
                      aria-label={`Gross weight for ${l.itemName}`}
                      value={l.grossWeight}
                      onChange={(e) => updateLine(idx, { grossWeight: e.target.value })}
                    />
                    <input
                      className="field !h-6 w-20 !py-0 font-mono !text-[11px]"
                      type="number"
                      min="0"
                      step="any"
                      placeholder="Tare wt."
                      aria-label={`Tare weight for ${l.itemName}`}
                      value={l.tareWeight}
                      onChange={(e) => updateLine(idx, { tareWeight: e.target.value })}
                    />
                    <span className="font-mono text-[10.5px] text-slate-400">Net: {l.grossWeight && l.tareWeight ? (Number(l.grossWeight) - Number(l.tareWeight)).toFixed(2) : "—"}</span>
                    <input className="field !h-6 w-28 !py-0 !text-[11px]" placeholder="A.R. No." aria-label={`A.R. No. for ${l.itemName}`} value={l.arNo} onChange={(e) => updateLine(idx, { arNo: e.target.value })} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const QC_CONSUME_REASON_OPTIONS = [
  { id: "TESTING", name: "Testing" },
  { id: "WASTAGE", name: "Wastage" },
  { id: "REJECTED", name: "Rejected" },
];

function QcSampleApprovalPanel({ preProductionId }: { preProductionId: string }) {
  const { hasRole } = useAuth();
  // RND alongside QA_QC — see qc-sample.routes.ts's own role gate on
  // confirm/consume/return (inward QC access extends to this sample
  // lifecycle too). Independent from the stage's own FORWARD/REJECT
  // gate above (PRE_PRODUCTION_STAGE_ROLE.SAMPLE_QC_APPROVAL stays
  // QA_QC-only — R&D can test the sample, only QA/QC signs off the gate).
  const canAct = hasRole("QA_QC", "RND");
  const { data: summary } = useQcSampleSummary(preProductionId);
  const confirmTransfer = useConfirmQcSampleTransfer(preProductionId);
  const consume = useConsumeQcSample(preProductionId);
  const returnSample = useReturnQcSample(preProductionId);
  const toast = useToast();

  const [consumeItemId, setConsumeItemId] = useState("");
  const [consumeQty, setConsumeQty] = useState("");
  const [consumeUnit, setConsumeUnit] = useState("");
  const [consumeReason, setConsumeReason] = useState<QcSampleConsumeReason>("TESTING");
  const [consumeNote, setConsumeNote] = useState("");

  const [returnItemId, setReturnItemId] = useState("");
  const [returnQty, setReturnQty] = useState("");
  const [returnUnit, setReturnUnit] = useState("");

  if (!summary) return null;

  async function handleConfirm(transferId: string) {
    try {
      await confirmTransfer.mutateAsync(transferId);
      toast.success("Receipt confirmed.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not confirm");
    }
  }

  const onHandRows = Object.entries(summary.onHand)
    .map(([itemId, qty]) => {
      const txn = summary.transactions.find((t) => t.itemId === itemId);
      return { itemId, itemName: txn?.itemName ?? itemId.slice(0, 8), unit: txn?.unit ?? "", onHand: qty };
    })
    .filter((r) => r.onHand !== 0);
  const itemOptions = onHandRows.map((r) => ({ id: r.itemId, name: `${r.itemName} (${r.onHand} ${r.unit} on hand)` }));
  const pendingToQc = summary.transfers.filter((t) => t.direction === "TO_QC" && t.status === "PENDING");

  async function handleConsume() {
    const item = onHandRows.find((r) => r.itemId === consumeItemId);
    if (!item || !consumeQty || Number(consumeQty) <= 0) return;
    try {
      await consume.mutateAsync({ itemId: consumeItemId, quantity: Number(consumeQty), unit: consumeUnit || item.unit, consumeReason, note: consumeNote || undefined });
      setConsumeItemId("");
      setConsumeQty("");
      setConsumeUnit("");
      setConsumeNote("");
      toast.success("Logged.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not log result");
    }
  }

  async function handleReturn() {
    const item = onHandRows.find((r) => r.itemId === returnItemId);
    if (!item || !returnQty || Number(returnQty) <= 0) return;
    try {
      await returnSample.mutateAsync({ itemId: returnItemId, quantity: Number(returnQty), unit: returnUnit || item.unit });
      setReturnItemId("");
      setReturnQty("");
      setReturnUnit("");
      toast.success("Leftover returned to the Plant.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not return leftover");
    }
  }

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-sky-200">
      <div className="flex items-center gap-1.5 bg-sky-100/70 px-3 py-2">
        <FlaskConical className="h-3.5 w-3.5 text-sky-700" strokeWidth={2.25} />
        <p className="text-xs font-bold text-sky-800">QC Sample — sent from Dispensing, confirm receipt then log the test result</p>
      </div>

      <div className="space-y-3 bg-sky-50/40 p-3">
        {pendingToQc.length > 0 && (
          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">Awaiting confirmation</p>
            <div className="space-y-1.5">
              {pendingToQc.map((t) => (
                <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs shadow-soft">
                  <span className="font-bold text-slate-700">
                    {t.itemName}{" "}
                    <span className="font-mono font-normal text-slate-500">
                      {t.quantity} {t.unit}
                    </span>
                  </span>
                  {canAct ? (
                    <button type="button" className="btn-primary btn-sm" disabled={confirmTransfer.isPending} onClick={() => handleConfirm(t.id)}>
                      <Check className="h-3 w-3" strokeWidth={2.5} /> Confirm receipt
                    </button>
                  ) : (
                    <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">Awaiting QC</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {onHandRows.length > 0 && (
          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">On hand at QC — this run</p>
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-100 bg-white px-3 shadow-soft">
              {onHandRows.map((r) => (
                <div key={r.itemId} className="flex items-center justify-between py-2 text-xs">
                  <span className="text-slate-600">{r.itemName}</span>
                  <span className="font-mono font-bold text-slate-700">
                    {r.onHand} {r.unit}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {canAct && onHandRows.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-100 bg-white p-2.5 shadow-soft">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">Log test result</p>
              <div className="space-y-1.5">
                <ItemPicker items={itemOptions} value={consumeItemId} onChange={setConsumeItemId} placeholder="— Item —" />
                <div className="flex gap-1.5">
                  <input className="field font-mono" type="number" min="0" step="any" placeholder="Qty" value={consumeQty} onChange={(e) => setConsumeQty(e.target.value)} />
                  <input className="field" placeholder="Unit" value={consumeUnit} onChange={(e) => setConsumeUnit(e.target.value)} />
                </div>
                <ItemPicker items={QC_CONSUME_REASON_OPTIONS} value={consumeReason} onChange={(v) => setConsumeReason(v as QcSampleConsumeReason)} />
                <input className="field" placeholder="Note (optional)" value={consumeNote} onChange={(e) => setConsumeNote(e.target.value)} />
                <button type="button" className="btn-primary btn-sm w-full justify-center" disabled={consume.isPending} onClick={handleConsume}>
                  {consume.isPending ? "Logging…" : "Log result"}
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-slate-100 bg-white p-2.5 shadow-soft">
              <p className="mb-2 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                <Undo2 className="h-3 w-3" strokeWidth={2.5} /> Return leftover to Plant
              </p>
              <div className="space-y-1.5">
                <ItemPicker items={itemOptions} value={returnItemId} onChange={setReturnItemId} placeholder="— Item —" />
                <div className="flex gap-1.5">
                  <input className="field font-mono" type="number" min="0" step="any" placeholder="Qty" value={returnQty} onChange={(e) => setReturnQty(e.target.value)} />
                  <input className="field" placeholder="Unit" value={returnUnit} onChange={(e) => setReturnUnit(e.target.value)} />
                </div>
                <button type="button" className="btn-ghost btn-sm w-full justify-center" disabled={returnSample.isPending} onClick={handleReturn}>
                  {returnSample.isPending ? "Returning…" : "Return leftover"}
                </button>
              </div>
            </div>
          </div>
        )}

        {pendingToQc.length === 0 && onHandRows.length === 0 && <p className="text-xs text-slate-400">Nothing sent to QC yet for this run.</p>}
      </div>
    </div>
  );
}

// A checklist panel — shared shape with CombinedLotDetailPage's own
// bulk-mfg version, just this run's dispensing-area rows and Store's
// column instead of Production's.
export function ChecklistPanel({
  title,
  deptLabel,
  canEditDept,
  rows,
  onToggle,
  pending,
}: {
  title: string;
  deptLabel: string;
  canEditDept: boolean;
  rows: ChecklistRow[];
  onToggle: (column: "DEPT" | "QA", itemKey: string, current: boolean | null) => void;
  pending: boolean;
}) {
  const { hasRole } = useAuth();
  const canEditQa = hasRole("QA_QC");
  const allDeptChecked = rows.every((r) => r.deptOk === true);
  const allQaChecked = rows.every((r) => r.qaOk === true);

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-sky-200">
      <div className="flex items-center gap-1.5 bg-sky-100/70 px-3 py-2">
        <ListChecks className="h-3.5 w-3.5 text-sky-700" strokeWidth={2.25} />
        <p className="text-xs font-bold text-sky-800">{title}</p>
      </div>

      <div className="divide-y divide-slate-100 bg-white">
        <div className="flex items-center gap-2 px-3 py-1.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">
          <span className="flex-1">Checklist item</span>
          <span className="w-14 text-center">{deptLabel}</span>
          <span className="w-14 text-center">QA</span>
        </div>
        {rows.map((row) => (
          <div key={row.itemKey} className="flex items-center gap-2 px-3 py-2 text-xs">
            <span className="flex-1 text-slate-600">{row.label}</span>
            <span className="flex w-14 justify-center">
              <button
                type="button"
                disabled={!canEditDept || pending}
                onClick={() => onToggle("DEPT", row.itemKey, row.deptOk)}
                title={canEditDept ? `Toggle ${deptLabel} check` : `${deptLabel}'s column`}
                className={`flex h-6 w-6 items-center justify-center rounded-md border transition ${row.deptOk ? "border-emerald-300 bg-emerald-100 text-emerald-700" : "border-slate-200 bg-slate-50 text-transparent"} ${canEditDept ? "cursor-pointer hover:border-emerald-300" : "cursor-default"}`}
              >
                <Check className="h-3.5 w-3.5" strokeWidth={3} />
              </button>
            </span>
            <span className="flex w-14 justify-center">
              <button
                type="button"
                disabled={!canEditQa || pending}
                onClick={() => onToggle("QA", row.itemKey, row.qaOk)}
                title={canEditQa ? "Toggle QA check" : "QA's column"}
                className={`flex h-6 w-6 items-center justify-center rounded-md border transition ${row.qaOk ? "border-emerald-300 bg-emerald-100 text-emerald-700" : "border-slate-200 bg-slate-50 text-transparent"} ${canEditQa ? "cursor-pointer hover:border-emerald-300" : "cursor-default"}`}
              >
                <Check className="h-3.5 w-3.5" strokeWidth={3} />
              </button>
            </span>
          </div>
        ))}
      </div>

      <div className="bg-sky-50/40 px-3 py-2 text-[10.5px] font-semibold text-slate-500">
        {allDeptChecked && allQaChecked
          ? `All items checked by both ${deptLabel} and QA — ready to set the status above to Approved.`
          : `Every item needs both a ${deptLabel} check and a QA check before this gate should be approved.`}
      </div>
    </div>
  );
}

function ChecklistPanelForPreProduction({ preProductionId, title, deptLabel, canEditDept, rows }: { preProductionId: string; title: string; deptLabel: string; canEditDept: boolean; rows: ChecklistRow[] }) {
  const update = useUpdatePreProductionChecklist(preProductionId);
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

interface IndentLine {
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  requestedQty: string;
}

function IndentRequestLinesEditor({ preProductionId, lines, onChange }: { preProductionId: string; lines: IndentLine[]; onChange: (lines: IndentLine[]) => void }) {
  const [category, setCategory] = useState<"RM" | "PM">("RM");
  const { data: items } = useInventoryItems(category);
  const { data: requirements } = useDispensingRequirements(preProductionId);
  const [itemId, setItemId] = useState("");
  const [requestedQty, setRequestedQty] = useState("");

  function addLine() {
    const item = items?.find((i) => i.id === itemId);
    if (!item || !requestedQty || Number(requestedQty) <= 0) return;
    onChange([...lines, { itemId, itemName: item.name, category, requestedQty }]);
    setItemId("");
    setRequestedQty("");
  }

  function removeLine(idx: number) {
    onChange(lines.filter((_, i) => i !== idx));
  }

  function updateLine(idx: number, patch: Partial<IndentLine>) {
    onChange(lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  const stagedItemIds = new Set(lines.map((l) => l.itemId));
  const toFill = aggregateRequirements(requirements?.items ?? []).filter((r) => r.remainingQty > 0 && !stagedItemIds.has(r.itemId));

  function fillFromRequirement() {
    onChange([...lines, ...toFill.map((r) => ({ itemId: r.itemId, itemName: r.itemName, category: r.category, requestedQty: fillQty(r.remainingQty) }))]);
  }

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <p className="mb-2 text-xs font-bold text-slate-600">Material Indent Lines — optional, raises real Material Requests for Store</p>
      {toFill.length > 0 && (
        <button type="button" className="btn-ghost btn-sm mb-2" onClick={fillFromRequirement}>
          <ListPlus className="h-3.5 w-3.5" strokeWidth={2.5} /> Fill {toFill.length} {toFill.length === 1 ? "item" : "items"} from requirement
        </button>
      )}
      <div className="flex flex-wrap gap-2">
        <div className="w-40">
          <ItemPicker
            items={CATEGORY_OPTIONS}
            value={category}
            onChange={(v) => {
              setCategory(v as "RM" | "PM");
              setItemId("");
            }}
          />
        </div>
        <div className="min-w-0 flex-1">
          <ItemPicker items={items ?? []} value={itemId} onChange={setItemId} placeholder="— Select item —" />
        </div>
        <input className="field w-24 font-mono" type="number" min="0" step="any" placeholder="Qty" value={requestedQty} onChange={(e) => setRequestedQty(e.target.value)} />
        <button type="button" className="btn-ghost shrink-0" onClick={addLine}>
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Add
        </button>
      </div>
      {lines.length > 0 && (
        <div className="mt-2 space-y-1">
          {lines.map((l, idx) => (
            <div key={idx} className="flex flex-wrap items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate font-bold text-slate-700" title={l.itemName}>
                {l.itemName} <span className="text-slate-400">({l.category})</span>
              </span>
              <input className="field !h-7 w-24 !py-0 font-mono !text-xs" type="number" min="0" step="any" aria-label={`Requested quantity for ${l.itemName}`} value={l.requestedQty} onChange={(e) => updateLine(idx, { requestedQty: e.target.value })} />
              <button type="button" className="btn-icon h-6 w-6 shrink-0 hover:!bg-rose-50 hover:!text-rose-600" aria-label={`Remove ${l.itemName}`} onClick={() => removeLine(idx)}>
                <Trash2 className="h-3 w-3" strokeWidth={2.25} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MaterialReceiptLinker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { data: receipts } = useInventoryTransactions({ type: "RECEIVED" });
  const items = (receipts ?? []).map((r) => ({ id: r.id, name: `${r.item.name} · ${r.grnNo || "no GRN no."} · ${r.quantity} ${r.unit} · ${new Date(r.date).toLocaleDateString()}` }));
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <label className="label flex items-center gap-1.5">
        <Link2 className="h-3 w-3" strokeWidth={2.5} /> Link to Warehouse GRN — optional, traceability only
      </label>
      <ItemPicker items={items} value={value} onChange={onChange} placeholder="— Not linked —" />
    </div>
  );
}

function ConsumptionHistory({ run }: { run: PreProduction }) {
  const { hasRole } = useAuth();
  // RND alongside QA_QC — see pre-production.routes.ts's own role gate on
  // this verify route (same dual-access rule as inward QC/Bulk QC/COA
  // elsewhere in this pipeline).
  const canVerify = hasRole("QA_QC", "RND");
  const verify = useVerifyConsumption(run.id);
  const toast = useToast();

  if (run.consumptions.length === 0) return null;

  async function handleVerify(consumptionId: string) {
    try {
      await verify.mutateAsync(consumptionId);
      toast.success("Verified.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not verify");
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
          <Beaker className="h-3.5 w-3.5" /> RM/PM Consumption — Dispensing Sheet
        </h3>
      </div>
      <div className="divide-y divide-slate-100">
        {run.consumptions.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
            <div className="min-w-0">
              <span className="text-xs font-bold text-slate-700">{c.item.name}</span>
              {(c.grossWeight != null || c.tareWeight != null || c.arNo) && (
                <p className="mt-0.5 font-mono text-[10.5px] text-slate-400">
                  {c.grossWeight != null && <>Gross {c.grossWeight} · </>}
                  {c.tareWeight != null && <>Tare {c.tareWeight} · </>}
                  {c.netWeight != null && <>Net {c.netWeight} · </>}
                  {c.arNo && <>A.R. No. {c.arNo}</>}
                </p>
              )}
            </div>
            <span className="flex items-center gap-2 text-xs">
              <span className="font-mono font-bold text-slate-600">
                {c.quantity} {c.unit}
              </span>
              <span className="text-slate-400">
                {c.createdBy.fullName} · {new Date(c.createdAt).toLocaleDateString()}
              </span>
              {c.qaVerifiedByName ? (
                <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">
                  <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} /> Verified — {c.qaVerifiedByName}
                </span>
              ) : canVerify ? (
                <button type="button" className="btn-ghost btn-sm" disabled={verify.isPending} onClick={() => handleVerify(c.id)}>
                  <Check className="h-3 w-3" strokeWidth={2.5} /> Verify
                </button>
              ) : (
                <span className="pill border-slate-200 bg-slate-100 text-slate-400">Awaiting QA</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const REQUEST_STATUS_STYLE: Record<string, string> = {
  PENDING: "border-amber-200 bg-amber-50 text-amber-700",
  APPROVED: "border-sky-200 bg-sky-50 text-sky-700",
  PARTIALLY_ISSUED: "border-violet-200 bg-violet-50 text-violet-700",
  ISSUED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  REJECTED: "border-rose-200 bg-rose-50 text-rose-700",
};

function IndentRequestHistory({ run }: { run: PreProduction }) {
  if (run.indentRequests.length === 0) return null;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
          <ClipboardList className="h-3.5 w-3.5" /> Material Indent Requests
        </h3>
      </div>
      <div className="divide-y divide-slate-100">
        {run.indentRequests.map((r) => (
          <div key={r.id} className="flex items-center justify-between px-4 py-2.5">
            <span className="text-xs font-bold text-slate-700">
              {r.item.name} <span className="text-slate-400">({r.category})</span>
            </span>
            <span className="flex items-center gap-2 text-xs">
              <span className="font-mono font-bold text-slate-600">
                {r.requestedQty} {r.item.unit ?? ""}
              </span>
              <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${REQUEST_STATUS_STYLE[r.status] ?? "border-slate-200 bg-slate-100 text-slate-500"}`}>{r.status}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LinkedRecordsCard({ run }: { run: PreProduction }) {
  if (!run.sourceReceipt) return null;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
          <Link2 className="h-3.5 w-3.5" /> Linked Records
        </h3>
      </div>
      <div className="px-4 py-2.5 text-xs">
        <p className="py-1.5">
          <span className="font-bold text-slate-700">Warehouse GRN:</span> {run.sourceReceipt.item.name} · {run.sourceReceipt.grnNo || "no GRN no."} · {run.sourceReceipt.quantity} {run.sourceReceipt.unit} ·{" "}
          {new Date(run.sourceReceipt.date).toLocaleDateString()}
        </p>
      </div>
    </div>
  );
}

// --- Tier 2 — Production Execution. Only relevant once this run's own
// gate (Sample QC Approval) has actually Approved — Production plans one
// or more small manufacturing runs against the remaining quantity, and
// completing each one automatically pools its output into combinedQty.
// Once that reaches the full plannedQty, the CombinedLot (Tier 3) is
// created automatically and every downstream stage happens there. ---
function ProductionBatchesSection({ run }: { run: PreProduction }) {
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const ready = run.sampleQcStatus === "Approved";
  const { data: batches } = useProductionBatches(ready ? run.id : undefined);

  if (!ready) return null;

  if (run.combinedLot) {
    return (
      <div className="card overflow-hidden">
        <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
          <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
            <Layers className="h-3.5 w-3.5" /> Production
          </h3>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-xs text-slate-500">
            Every planned production run has pooled in ({run.combinedQty} / {run.plannedQty}) — Combined Lot created, everything from IPQC onward happens there now.
          </p>
          <button type="button" className="btn-primary btn-sm" onClick={() => navigate(`/combined-lots/${run.combinedLot!.id}`)}>
            Open Combined Lot <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
          <Layers className="h-3.5 w-3.5" /> Production Execution
        </h3>
        <span className="font-mono text-xs font-bold text-slate-600">
          Combined {run.combinedQty} / {run.plannedQty} — remaining {run.remainingQty}
        </span>
      </div>
      <div className="space-y-3 p-4">
        {(batches ?? []).map((pb) => (
          <ProductionBatchCard key={pb.id} preProductionId={run.id} batch={pb} />
        ))}
        {hasRole("PRODUCTION") && run.remainingQty > 0 && <NewProductionBatchForm preProductionId={run.id} remainingQty={run.remainingQty} />}
        {(batches ?? []).length === 0 && run.remainingQty <= 0 && <p className="text-xs text-slate-400">No production runs yet.</p>}
      </div>
    </div>
  );
}

function NewProductionBatchForm({ preProductionId, remainingQty }: { preProductionId: string; remainingQty: number }) {
  const create = useCreateProductionBatch(preProductionId);
  const toast = useToast();
  const [batchNo, setBatchNo] = useState("");
  const [plannedQty, setPlannedQty] = useState(String(remainingQty));

  async function handleCreate() {
    if (!plannedQty || Number(plannedQty) <= 0) return;
    try {
      await create.mutateAsync({ batchNo: batchNo.trim() || undefined, plannedQty: Number(plannedQty) });
      setBatchNo("");
      setPlannedQty("");
      toast.success("Production run started.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not start a new production run");
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-3">
      <div className="w-40">
        <label className="label">Batch No. (optional)</label>
        <input className="field" placeholder="e.g. B-2026-081" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />
      </div>
      <div className="w-32">
        <label className="label">Planned Qty</label>
        <input className="field font-mono" type="number" min="0" step="any" value={plannedQty} onChange={(e) => setPlannedQty(e.target.value)} />
      </div>
      <button type="button" className="btn-primary btn-sm" disabled={create.isPending} onClick={handleCreate}>
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> {create.isPending ? "Starting…" : "Start Production Run"}
      </button>
    </div>
  );
}

function ProductionBatchCard({ preProductionId, batch }: { preProductionId: string; batch: ProductionBatch }) {
  const { hasRole } = useAuth();
  const canAct = hasRole("PRODUCTION");
  const update = useUpdateProductionBatch(preProductionId);
  const complete = useCompleteProductionBatch(preProductionId);
  const toast = useToast();
  const isDone = batch.status === "COMPLETED";

  const [values, setValues] = useState({
    manufacturingStartDate: batch.manufacturingStartDate?.slice(0, 10) ?? "",
    manufacturingStatus: batch.manufacturingStatus ?? "",
    manufacturingEndDate: batch.manufacturingEndDate?.slice(0, 10) ?? "",
    manufacturingRemarks: batch.manufacturingRemarks ?? "",
    inputQty: batch.inputQty != null ? String(batch.inputQty) : "",
    outputQty: batch.outputQty != null ? String(batch.outputQty) : "",
  });

  async function handleSave() {
    try {
      const body: Record<string, unknown> = { id: batch.id };
      for (const [k, v] of Object.entries(values)) if (v !== "") body[k] = k === "inputQty" || k === "outputQty" ? Number(v) : v;
      await update.mutateAsync(body as never);
      toast.success("Saved.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function handleComplete() {
    if (batch.outputQty == null) {
      toast.error("Record the output quantity before completing this run.");
      return;
    }
    if (!window.confirm("Mark this production run completed? Its output will be added to the run's combined total.")) return;
    try {
      const result = await complete.mutateAsync(batch.id);
      toast.success(result.combinedLot ? "Completed — every planned run has now pooled in, Combined Lot created." : "Completed and combined.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not complete");
    }
  }

  return (
    <div className={`rounded-xl border p-3 ${isDone ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200 bg-white"}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-black text-slate-800">{batch.batchNo ?? `Run ${batch.id.slice(0, 8)}`}</span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-[10.5px] text-slate-400">Planned {batch.plannedQty}</span>
          {isDone ? (
            <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">
              <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} /> Completed — output {batch.outputQty}
            </span>
          ) : (
            <span className="pill border-amber-200 bg-amber-50 text-amber-700">In Progress</span>
          )}
        </span>
      </div>

      {!isDone && canAct && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div>
              <label className="label">Start Date</label>
              <input className="field !h-8 !text-xs" type="date" value={values.manufacturingStartDate} onChange={(e) => setValues((v) => ({ ...v, manufacturingStartDate: e.target.value }))} />
            </div>
            <div>
              <label className="label">End Date</label>
              <input className="field !h-8 !text-xs" type="date" value={values.manufacturingEndDate} onChange={(e) => setValues((v) => ({ ...v, manufacturingEndDate: e.target.value }))} />
            </div>
            <div>
              <label className="label">Status</label>
              <input className="field !h-8 !text-xs" placeholder="e.g. Completed" value={values.manufacturingStatus} onChange={(e) => setValues((v) => ({ ...v, manufacturingStatus: e.target.value }))} />
            </div>
            <div>
              <label className="label">Input Qty</label>
              <input className="field !h-8 font-mono !text-xs" type="number" min="0" step="any" value={values.inputQty} onChange={(e) => setValues((v) => ({ ...v, inputQty: e.target.value }))} />
            </div>
            <div>
              <label className="label">Output Qty</label>
              <input className="field !h-8 font-mono !text-xs" type="number" min="0" step="any" value={values.outputQty} onChange={(e) => setValues((v) => ({ ...v, outputQty: e.target.value }))} />
            </div>
            <div>
              <label className="label">Remarks</label>
              <input className="field !h-8 !text-xs" value={values.manufacturingRemarks} onChange={(e) => setValues((v) => ({ ...v, manufacturingRemarks: e.target.value }))} />
            </div>
          </div>
          {batch.inputQty != null && batch.outputQty != null && batch.wastage.wastageQty != null && (
            <p className="mt-1.5 font-mono text-[10.5px] text-slate-400">
              Wastage: {batch.wastage.wastageQty} ({batch.wastage.wastagePct}%)
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn-ghost btn-sm" disabled={update.isPending} onClick={handleSave}>
              {update.isPending ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={complete.isPending} onClick={handleComplete}>
              <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> {complete.isPending ? "Completing…" : "Mark Completed"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function StageHistory({ run }: { run: PreProduction }) {
  if (run.stageEvents.length === 0) {
    return <EmptyState icon={ClipboardEdit} title="No history yet" hint="Every forward and send-back on this run will show up here." accent="slate" />;
  }
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-600">History</h3>
      </div>
      <div className="divide-y divide-slate-100">
        {[...run.stageEvents].reverse().map((e) => (
          <div key={e.id} className="flex items-start gap-3 px-4 py-3">
            <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${e.action === "REJECT" ? "bg-rose-100 text-rose-600" : e.action === "JUMP" ? "bg-amber-100 text-amber-600" : "bg-emerald-100 text-emerald-600"}`}>
              {e.action === "REJECT" ? <Undo2 className="h-3 w-3" strokeWidth={2.5} /> : e.action === "JUMP" ? <Shuffle className="h-3 w-3" strokeWidth={2.5} /> : <Check className="h-3 w-3" strokeWidth={3} />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-slate-700">
                {PRE_PRODUCTION_STAGE_LABEL[e.fromStageId]} <span className="text-slate-300">→</span> {PRE_PRODUCTION_STAGE_LABEL[e.toStageId]}
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
