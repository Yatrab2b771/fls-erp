import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Save, ArrowLeft, ArrowRight, Beaker, Check, CheckCircle2, ClipboardEdit, ClipboardList, FlaskConical, Layers, Link2, ListChecks, ListPlus, Lock, Pencil, Plus, Shuffle, Trash2, Truck, Undo2 } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useMyStoreInfo, usePlantConsumptionBalance } from "../lib/hooks";
import {
  useAssignPreProductionPlant,
  useCompleteProductionBatch,
  useCreateProductionBatch,
  useDispensingRequirements,
  useMaterialCoverage,
  useInventoryItems,
  useInventoryTransactions,
  usePlants,
  usePreProduction,
  useProductionBatches,
  useTransitionPreProductionStage,
  useUpdatePreProductionChecklist,
  useUpdateProductionBatch,
  useVerifyConsumption,
} from "../lib/hooks";
import { PRE_PRODUCTION_STAGE_FIELDS, PRE_PRODUCTION_STAGE_LABEL, PRE_PRODUCTION_STAGE_ORDER, PRE_PRODUCTION_STAGE_ROLE, getForwardTarget, getRejectTarget } from "../lib/preProductionStage";
import { COMBINED_LOT_STAGE_LABEL } from "../lib/combinedLotStage";
import { FieldGrid } from "../components/FieldGrid";
import { PlanFromPpic } from "../components/PlanFromPpic";
import { ItemPicker } from "../components/ItemPicker";
import { PickerWithAdd } from "../components/PickerWithAdd";
import { DelayBadge } from "../components/Badges";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { ApiError } from "../lib/api";
import type { ChecklistRow, DispensingRequirementItem, PreProduction, PreProductionStageId, ProductionBatch } from "../lib/types";
import { CustomerName } from "../components/CustomerName";
import { ActionMenu, type ActionMenuItem } from "../components/ActionMenu";

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
  const { hasRole } = useAuth();

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
      <Link to={hasRole("PRODUCTION") && !hasRole("ADMIN") ? "/new-plans" : `/purchase-orders/${po.id}`} className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> {hasRole("PRODUCTION") && !hasRole("ADMIN") ? "New Plan" : po.poNumber ?? po.id.slice(0, 8)}
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
              <p className="text-sm text-slate-500"><CustomerName name={po.customer.companyName} /></p>
              <div className="mt-1.5">
                <PreProductionPlantControl run={run} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <StageProgressStrip run={run} />

      <details className="card group overflow-hidden" open>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-600">
          <span className="flex items-center gap-1.5">
            <ListChecks className="h-3.5 w-3.5" /> Plan from PPIC (RM + PM, with quantities)
          </span>
          <span className="text-micro font-semibold normal-case text-slate-400 group-open:hidden">Show</span>
          <span className="hidden text-micro font-semibold normal-case text-slate-400 group-open:inline">Hide</span>
        </summary>
        <div className="border-t border-slate-100 p-4">
          <PlanFromPpic poId={po.id} itemId={run.purchaseOrderItem.id} />
        </div>
      </details>

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
        <p className="mb-2.5 flex items-center gap-1.5 text-micro font-bold text-slate-400">
          <Shuffle className="h-3 w-3" strokeWidth={2.5} /> Admin: click any stage to move this run there directly.
        </p>
      )}
      <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-none">
        {PRE_PRODUCTION_STAGE_ORDER.map((stage, idx) => {
          const isDone = idx < currentIndex || (idx === currentIndex && stage === "SAMPLE_QC_APPROVAL" && run.sampleQcStatus === "Approved");
          const isCurrent = idx === currentIndex && !isDone;
          const pillClass = `flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-micro font-bold whitespace-nowrap ${
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
        <PickerWithAdd label="Plant" placeholder="— No Plant —" options={plants ?? []} value={plantId} onChange={setPlantId} />
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
  // Material Received & GRN and Dispensing are done by the Day Store of this run's Plant - not by the Warehouse seat, not by another store.
  const { data: myStore } = useMyStoreInfo({ enabled: hasRole("STORE") });
  const isAdmin = hasRole("ADMIN");
  const dayStoreStage = stage === "MATERIAL_RECEIVED" || stage === "DISPENSING";
  const ownPlantStore = !!run.plantId && !!myStore?.stores.some((s) => s.plantId === run.plantId);
  const canAct = hasRole(...roles) && (!dayStoreStage || isAdmin || (myStore?.scoped === true && ownPlantStore));
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
  const [sourceReceiptId, setSourceReceiptId] = useState(run.sourceReceiptId ?? "");

  useEffect(() => {
    if (fields) setValues(Object.fromEntries(fields.map((f) => [f.name, fieldValue(run, f.name)])));
    setShowReject(false);
    setNote("");
    setError(null);
    setConsumptionLines([]);
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
    if (stage === "MATERIAL_RECEIVED") body.sourceReceiptId = sourceReceiptId || null;
    try {
      const result = await transition.mutateAsync(body as never);
      if (result.dispensingShortfall && result.dispensingShortfall.length > 0) {
        const list = result.dispensingShortfall.map((i) => `${i.itemName} (needs ${i.requiredQty} ${i.unit}, have ${i.consumedQty})`).join("; ");
        toast.error(`Saved — still short: ${list}`);
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
        <span className={`rounded-full border px-2 py-0.5 text-micro font-bold uppercase tracking-wide ${canAct ? "border-brand-200 bg-brand-50 text-brand-700" : "border-slate-200 bg-slate-100 text-slate-400"}`}>
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

        {stage === "SAMPLE_QC_APPROVAL" && (
          <ChecklistPanelForPreProduction
            preProductionId={run.id}
            title="Line Clearance Checklist — bulk manufacturing area (per BMR-1, 4.0)"
            deptLabel="Production"
            canEditDept={hasRole("PRODUCTION")}
            rows={run.bulkMfgLineClearanceChecklist}
          />
        )}


        {/* The indent follows the plan: its materials are shown, not typed. */}
        {stage === "INDENT_ISSUE" && <MaterialCoveragePanel preProductionId={run.id} />}

        {stage === "MATERIAL_RECEIVED" && <MaterialCoveragePanel preProductionId={run.id} />}

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

// Stage 1: the GRN is recorded once the material the released quantity needs has reached the Plant.
function MaterialCoveragePanel({ preProductionId }: { preProductionId: string }) {
  const { data } = useMaterialCoverage(preProductionId);
  if (!data || data.lines.length === 0) return null;
  const partial = data.releasedQty < data.orderQty - 1e-6;
  return (
    <div className={`mt-4 rounded-xl border p-3 ${data.allCovered ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/60"}`}>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-slate-600">
        {data.allCovered ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2.5} /> : <ArrowRight className="h-3.5 w-3.5 text-amber-600" strokeWidth={2.5} />}
        Material for {data.releasedQty} {data.unit}
        {partial ? ` (part of ${data.orderQty} ${data.unit} released so far)` : ""}
        {data.allCovered ? " — all with the Day Store" : " — must reach the Day Store before this stage can be recorded"}
      </p>
      <div className="space-y-1">
        {data.lines.map((l) => (
          <div key={`${l.category}-${l.material}`} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
            <span className="font-bold text-slate-700">
              {l.material} <span className="text-slate-400">({l.category})</span>
            </span>
            <span className={`font-mono font-bold ${l.covered ? "text-emerald-600" : "text-amber-700"}`}>
              {Math.round((l.receivedQty + l.atDayStoreQty) * 1000) / 1000} / {l.requiredQty} {l.unit}
              <span className="ml-1 font-sans text-micro font-bold text-slate-400">
                ({l.atDayStoreQty} at Day Store{l.receivedQty > 0 ? `, ${l.receivedQty} at Plant` : ""})
              </span>
              {!l.covered && l.inTransitQty > 0 && <span className="ml-1 font-sans text-micro font-bold text-sky-600">({l.inTransitQty} on the way)</span>}
            </span>
          </div>
        ))}
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
                      className="field !h-6 w-20 !py-0 font-mono !text-tiny"
                      type="number"
                      min="0"
                      step="any"
                      placeholder="Gross wt."
                      aria-label={`Gross weight for ${l.itemName}`}
                      value={l.grossWeight}
                      onChange={(e) => updateLine(idx, { grossWeight: e.target.value })}
                    />
                    <input
                      className="field !h-6 w-20 !py-0 font-mono !text-tiny"
                      type="number"
                      min="0"
                      step="any"
                      placeholder="Tare wt."
                      aria-label={`Tare weight for ${l.itemName}`}
                      value={l.tareWeight}
                      onChange={(e) => updateLine(idx, { tareWeight: e.target.value })}
                    />
                    <span className="font-mono text-micro text-slate-400">Net: {l.grossWeight && l.tareWeight ? (Number(l.grossWeight) - Number(l.tareWeight)).toFixed(2) : "—"}</span>
                    <input className="field !h-6 w-28 !py-0 !text-tiny" placeholder="A.R. No." aria-label={`A.R. No. for ${l.itemName}`} value={l.arNo} onChange={(e) => updateLine(idx, { arNo: e.target.value })} />
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
        <div className="flex items-center gap-2 px-3 py-1.5 text-micro font-bold uppercase tracking-wide text-slate-400">
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

      <div className="bg-sky-50/40 px-3 py-2 text-micro font-semibold text-slate-500">
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

function MaterialReceiptLinker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { data: receipts } = useInventoryTransactions({ type: "RECEIVED" });
  const items = (receipts ?? []).map((r) => ({ id: r.id, name: `${r.item.name} · ${r.grnNo || "no GRN no."} · ${r.quantity} ${r.unit} · ${new Date(r.date).toLocaleDateString()}`, code: r.item.code }));
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
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
          <Beaker className="h-3.5 w-3.5" /> RM/PM Consumption — Dispensing Sheet
        </h3>
        {hasRole("PRODUCTION", "STORE", "QA_QC") && (
          <Link to={`/material-consumption?preProductionId=${run.id}`} className="text-micro font-bold text-brand-600 hover:underline">
            Full report
          </Link>
        )}
      </div>
      <div className="divide-y divide-slate-100">
        {run.consumptions.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
            <div className="min-w-0">
              <span className="text-xs font-bold text-slate-700">{c.item.name}</span>
              {(c.grossWeight != null || c.tareWeight != null || c.arNo) && (
                <p className="mt-0.5 font-mono text-micro text-slate-400">
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
              <span className={`rounded-full border px-2 py-0.5 text-micro font-bold uppercase tracking-wide ${REQUEST_STATUS_STYLE[r.status] ?? "border-slate-200 bg-slate-100 text-slate-500"}`}>{r.status}</span>
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
// or more small manufacturing runs against the remaining quantity.
// Completing one just adds its output to combinedQty (a running
// produced-so-far figure) and makes it eligible for its OWN IPQC-
// through-Dispatch pipeline (see ProductionBatchCard below) — "combine"
// isn't the model any more, so nothing pools automatically. The
// `run.combinedLot` branch below only ever fires for a PreProduction
// that already had one from before this change — new runs never get
// one. ---
function ProductionBatchesSection({ run }: { run: PreProduction }) {
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const ready = run.sampleQcStatus === "Approved";
  const { data: batches } = useProductionBatches(ready ? run.id : undefined);
  // PPIC may have released only part of the order: batches can be planned only up to that, less what is produced or already planned.
  const released = run.releasedQty ?? run.plannedQty;
  const inProgressPlanned = (batches ?? []).filter((b) => b.status === "IN_PROGRESS").reduce((sum, b) => sum + b.plannedQty, 0);
  const canPlan = Math.max(0, Math.min(run.remainingQty, Math.round((released - run.combinedQty - inProgressPlanned) * 1000) / 1000));

  if (!ready) {
    return (
      <div className="card p-4 text-xs text-slate-500">
        <b className="text-slate-700">Production sheet</b> — batches (shift, manpower, start / end time, utilization) open here once Line Clearance and Sample QC are approved.
      </div>
    );
  }

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
            This run combined before batches started dispatching independently ({run.combinedQty} / {run.plannedQty}) — everything from IPQC onward still happens on that Combined Lot.
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
          Produced {run.combinedQty} / {run.plannedQty} — remaining {run.remainingQty}
          {released < run.plannedQty - 1e-6 && <span className="ml-2 text-amber-600">· Released {released}</span>}
        </span>
      </div>
      <div className="space-y-3 p-4">
        <PlanDetails run={run} />
        <MaterialUtilization runId={run.id} />
        <ProductionBatchesTable
          preProductionId={run.id}
          batches={batches ?? []}
          renderUtilization={() => (
            <Link to="/batches" className="text-xs font-bold text-brand-700 hover:underline">
              Fill and see a batch&apos;s Utilization on the Batch page →
            </Link>
          )}
        />
        {hasRole("PRODUCTION") && run.remainingQty > 0 && canPlan > 0 && <NewProductionBatchForm key={canPlan} preProductionId={run.id} remainingQty={canPlan} />}
        {hasRole("PRODUCTION") && run.remainingQty > 0 && canPlan <= 0 && released < run.plannedQty - 1e-6 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
            All of the {released} {run.purchaseOrderItem.unit} PPIC has released is planned. More batches open up when PPIC releases more.
          </p>
        )}
        {(batches ?? []).length === 0 && run.remainingQty <= 0 && <p className="text-xs text-slate-400">No production runs yet.</p>}
      </div>
    </div>
  );
}

// The top of the production sheet: everything the PO and PPIC already know, ready-filled (read-only).
function PlanDetails({ run }: { run: PreProduction }) {
  const item = run.purchaseOrderItem;
  const cells: [string, string][] = [
    ["PO", item.purchaseOrder.poNumber ?? "—"],
    ["Customer", item.purchaseOrder.customer.companyName],
    ["Product", item.productName],
    ["Product Type", item.productCategory ?? "—"],
    ["Quantity", `${item.quantity} ${item.unit}${item.volume != null ? ` · Volume ${item.volume}` : ""}`],
    ["Plant", run.plant?.name ?? "—"],
  ];
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <p className="mb-2 text-micro font-bold uppercase tracking-wide text-slate-400">Plan (from the PO)</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {cells.map(([label, value]) => (
          <div key={label}>
            <dt className="text-micro font-bold uppercase tracking-wide text-slate-400">{label}</dt>
            <dd className="text-xs font-semibold text-slate-800">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// Material utilisation for the run, per material: A Production (used), B Wastage, C Rejected, D Sample, E Return to Store.
// Read from the Plant's consumption log (Plant Consumption page), which is kept per run, not per batch.
function MaterialUtilization({ runId }: { runId: string }) {
  const { hasRole } = useAuth();
  const { data } = usePlantConsumptionBalance(runId);
  const items = data?.items ?? [];
  if (!data?.plant) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2.5">
        <p className="text-micro font-bold uppercase tracking-wide text-slate-400">Material utilization (this run)</p>
        {hasRole("PRODUCTION", "STORE") && (
          <Link to="/plant-consumption" className="text-tiny font-bold text-brand-600 hover:underline">
            Log usage →
          </Link>
        )}
      </div>
      {items.length === 0 ? (
        <p className="px-3 py-3 text-xs text-slate-400">Nothing used yet. It fills in as material is used, wasted, rejected, sampled or returned.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                <th className="px-3 py-2">Material</th>
                <th className="px-3 py-2 text-right">A · Production</th>
                <th className="px-3 py-2 text-right">B · Wastage</th>
                <th className="px-3 py-2 text-right">C · Rejected</th>
                <th className="px-3 py-2 text-right">D · Sample</th>
                <th className="px-3 py-2 text-right">E · Return to Store</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((i) => (
                <tr key={i.itemId}>
                  <td className="px-3 py-2 font-bold text-slate-700">{i.itemName}</td>
                  {[i.consumedQty, i.wastedQty, i.rejectedQty, i.sampleQty, i.returnedQty].map((q, idx) => (
                    <td key={idx} className={`px-3 py-2 text-right font-mono ${q ? "font-bold text-slate-800" : "text-slate-300"}`}>
                      {q ? `${Math.round(q * 1000) / 1000} ${i.unit}` : "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// No Batch No. field here any more — QC assigns the real batch number
// once, on this batch's own pipeline page, the first time it touches
// the run (see ProductionBatchDetailPage.tsx's BatchNoBadge). Production
// just starts the run.
export function NewProductionBatchForm({ preProductionId, remainingQty }: { preProductionId: string; remainingQty: number }) {
  const create = useCreateProductionBatch(preProductionId);
  const toast = useToast();
  const [plannedQty, setPlannedQty] = useState(String(remainingQty));

  // A batch is divided off with just its quantity. Its indent, batch number, Dispensing and Line Clearance come next (each by its own
  // department); its production sheet (shift, manpower, start) is filled when its production starts.
  async function handleCreate() {
    if (!(Number(plannedQty) > 0)) return;
    try {
      await create.mutateAsync({ plannedQty: Number(plannedQty) });
      setPlannedQty("");
      toast.success("Batch added. It goes to Indent Issue next.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add the batch");
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-3">
      <div className="w-36">
        <label className="label">Add a batch: quantity</label>
        <input className="field font-mono" type="number" min="0" step="any" value={plannedQty} onChange={(e) => setPlannedQty(e.target.value)} />
      </div>
      <button type="button" className="btn-primary btn-sm" disabled={!(Number(plannedQty) > 0) || create.isPending} onClick={handleCreate}>
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> {create.isPending ? "Adding…" : "Add batch"}
      </button>
      <p className="pb-2 text-tiny text-slate-500">The total of all batches cannot go beyond what PPIC has released.</p>
    </div>
  );
}

/**
 * The batches of a run as one sheet (an Excel-like table): a row for each batch, its fields as cells that can be edited right there.
 * Save keeps what was typed; Mark Completed sends the batch on to its own QC / Packaging / Dispatch pipeline.
 */
export function ProductionBatchesTable({ preProductionId, batches, renderUtilization }: { preProductionId: string; batches: ProductionBatch[]; renderUtilization?: (batch: ProductionBatch) => ReactNode }) {
  if (batches.length === 0) return null;
  // Per-batch flow: input and output are worked out from the Utilization (no boxes, no wastage column).
  const flow = batches.some((b) => b.preProduction?.batchFlow);
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2.5">Batch</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5 text-right">Quantity</th>
              <th className="px-3 py-2.5">Shift</th>
              <th className="px-3 py-2.5">Manpower</th>
              <th className="px-3 py-2.5">Start date &amp; time</th>
              {!flow && <th className="px-3 py-2.5">Input qty</th>}
              <th className="px-3 py-2.5">Utilization (RM)</th>
              <th className="px-3 py-2.5">End date &amp; time</th>
              {!flow && <th className="px-3 py-2.5">Output qty</th>}
              <th className="px-3 py-2.5">Mfg status</th>
              <th className="px-3 py-2.5">Remarks</th>
              {!flow && <th className="px-3 py-2.5 text-right">Wastage</th>}
              <th className="px-3 py-2.5">Pipeline</th>
              <th className="px-3 py-2.5 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {batches.map((b) => (
              <ProductionBatchRow key={b.id} preProductionId={preProductionId} batch={b} flow={flow} renderUtilization={renderUtilization} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Compact cells: the base .field is tall; a disabled one stays readable.
const CELL = "field !h-8 !py-0 !px-2 !text-xs disabled:!bg-transparent disabled:!border-transparent disabled:!text-slate-700 disabled:!opacity-100 disabled:!shadow-none";

function ProductionBatchRow({ preProductionId, batch, flow, renderUtilization }: { preProductionId: string; batch: ProductionBatch; flow: boolean; renderUtilization?: (batch: ProductionBatch) => ReactNode }) {
  const { hasRole } = useAuth();
  const canAct = hasRole("PRODUCTION");
  const update = useUpdateProductionBatch(preProductionId);
  const complete = useCompleteProductionBatch(preProductionId);
  const toast = useToast();
  const [showUtil, setShowUtil] = useState(false);
  const isDone = batch.status === "COMPLETED";
  const locked = isDone || !canAct;
  // The finishing fields (end, output, status, remarks) open only once every plan material has its Production quantity on this batch.
  const util = batch.utilization;
  const utilDone = util ? util.complete : true;
  // Per-batch flow: the start fields (shift, manpower, start date & time) must be in first, too.
  const startFilled = !!batch.shift && !!batch.manpowerCount && !!batch.shiftStartAt;
  const finishLocked = locked || !utilDone || (flow && !startFilled);
  const finishTip = isDone ? undefined : !startFilled && flow ? "Fill and Save the start fields first (shift, manpower, start date & time)" : !utilDone ? "Fill the Utilization first" : undefined;

  // A date-time input wants the local "yyyy-MM-ddTHH:mm"; the API stores it as a full timestamp.
  const toLocalInput = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const [values, setValues] = useState({
    shift: batch.shift ?? "",
    manpowerCount: batch.manpowerCount != null ? String(batch.manpowerCount) : "",
    shiftStartAt: toLocalInput(batch.shiftStartAt),
    shiftEndAt: toLocalInput(batch.shiftEndAt),
    manufacturingStatus: batch.manufacturingStatus ?? "",
    manufacturingRemarks: batch.manufacturingRemarks ?? "",
    inputQty: batch.inputQty != null ? String(batch.inputQty) : "",
    outputQty: batch.outputQty != null ? String(batch.outputQty) : "",
  });
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value }));
  const FINISHING = ["shiftEndAt", "outputQty", "manufacturingStatus", "manufacturingRemarks"];

  async function handleSave() {
    try {
      const body: Record<string, unknown> = { id: batch.id };
      for (const [k, v] of Object.entries(values)) {
        if (v === "") continue;
        if ((!utilDone || (flow && !startFilled)) && FINISHING.includes(k)) continue; // shut until the Utilization is complete and the start fields are saved
        if (flow && (k === "inputQty" || k === "outputQty")) continue; // worked out from the Utilization
        body[k] = k === "inputQty" || k === "outputQty" || k === "manpowerCount" ? Number(v) : k === "shiftStartAt" || k === "shiftEndAt" ? new Date(v).toISOString() : v;
      }
      await update.mutateAsync(body as never);
      toast.success("Saved.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function handleComplete() {
    if (!utilDone) {
      toast.error(`Fill the Utilization first: ${util!.missing.length} of ${util!.required} materials have no Production quantity on this batch yet.`);
      setShowUtil(true);
      return;
    }
    if (flow && !batch.shiftEndAt) {
      toast.error("Record the end date and time (and Save) before completing this batch.");
      return;
    }
    if (!flow && batch.outputQty == null) {
      toast.error("Record the output quantity (and Save) before completing this batch.");
      return;
    }
    if (!window.confirm("Mark this batch completed? It'll then have its own QC/Packaging/Dispatch pipeline to go through, independent of any other batch on this run.")) return;
    try {
      await complete.mutateAsync(batch.id);
      toast.success("Completed. This batch now has its own pipeline to go through.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not complete");
    }
  }

  const items: ActionMenuItem[] =
    locked
      ? []
      : [
          { key: "save", label: update.isPending ? "Saving…" : "Save", icon: Save, onClick: handleSave, disabled: update.isPending },
          { key: "complete", label: complete.isPending ? "Completing…" : "Mark Completed", icon: Check, tone: "primary", onClick: handleComplete, disabled: complete.isPending || !utilDone || (flow && !startFilled), title: finishTip },
        ];

  return (
    <>
      <tr className={isDone ? "bg-emerald-50/30" : "hover:bg-slate-50"}>
        <td className="px-3 py-1.5 font-black text-slate-800">{batch.batchNo ?? `Batch ${batch.id.slice(0, 8)}`}</td>
        <td className="px-3 py-1.5">
          {isDone ? (
            <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">
              <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} /> Completed
            </span>
          ) : (
            <span className="pill border-amber-200 bg-amber-50 text-amber-700">In Progress</span>
          )}
        </td>
        <td className="px-3 py-1.5 text-right font-mono text-slate-600">{batch.plannedQty}</td>
        <td className="px-3 py-1.5">
          <select disabled={locked} className={`${CELL} w-24`} value={values.shift} onChange={set("shift")}>
            <option value="">—</option>
            <option value="Day">Day</option>
            <option value="Night">Night</option>
          </select>
        </td>
        <td className="px-3 py-1.5">
          <input disabled={locked} className={`${CELL} w-20 font-mono`} type="number" min="0" step="1" value={values.manpowerCount} onChange={set("manpowerCount")} />
        </td>
        <td className="px-3 py-1.5">
          <input disabled={locked} className={`${CELL} w-44`} type="datetime-local" value={values.shiftStartAt} onChange={set("shiftStartAt")} />
        </td>
        {!flow && (
          <td className="px-3 py-1.5">
            <input disabled={locked} className={`${CELL} w-24 font-mono`} type="number" min="0" step="any" value={values.inputQty} onChange={set("inputQty")} />
          </td>
        )}
        <td className="px-3 py-1.5">
          {util && util.required > 0 ? (
            <button
              type="button"
              onClick={() => setShowUtil((o) => !o)}
              className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-tiny font-bold ${utilDone ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}
              title={utilDone ? "Every plan material has its Production quantity on this batch" : `Missing: ${util.missing.join(", ")}`}
            >
              {util.logged} of {util.required} {showUtil ? "▴" : "▾"}
            </button>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </td>
        <td className="px-3 py-1.5">
          <input disabled={finishLocked} title={finishTip} className={`${CELL} w-44`} type="datetime-local" value={values.shiftEndAt} onChange={set("shiftEndAt")} />
        </td>
        {!flow && (
          <td className="px-3 py-1.5">
            <input disabled={finishLocked} title={finishTip} className={`${CELL} w-24 font-mono`} type="number" min="0" step="any" value={values.outputQty} onChange={set("outputQty")} />
          </td>
        )}
        <td className="px-3 py-1.5">
          <input disabled={finishLocked} title={finishTip} className={`${CELL} w-32`} placeholder="e.g. Completed" value={values.manufacturingStatus} onChange={set("manufacturingStatus")} />
        </td>
        <td className="px-3 py-1.5">
          <input disabled={finishLocked} title={finishTip} className={`${CELL} w-44`} value={values.manufacturingRemarks} onChange={set("manufacturingRemarks")} />
        </td>
        {!flow && <td className="px-3 py-1.5 text-right font-mono text-slate-600">{batch.inputQty != null && batch.outputQty != null && batch.wastage.wastageQty != null ? `${batch.wastage.wastageQty} (${batch.wastage.wastagePct}%)` : "—"}</td>}
        <td className="px-3 py-1.5">
          {isDone ? (
            <Link to={`/production-batches/${batch.id}`} className="inline-flex items-center gap-1 font-bold text-brand-700 hover:underline" title="This batch's own QC / Packaging / Dispatch pipeline">
              <Truck className="h-3.5 w-3.5" strokeWidth={2.25} /> {COMBINED_LOT_STAGE_LABEL[batch.currentStageId]} <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
            </Link>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </td>
        <td className="px-3 py-1.5 text-right">
          <ActionMenu items={items} />
        </td>
      </tr>
      {showUtil && renderUtilization && (
        <tr className="bg-slate-50/70">
          <td colSpan={flow ? 12 : 15} className="whitespace-normal px-4 py-3">
            {renderUtilization(batch)}
          </td>
        </tr>
      )}
    </>
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
              <p className="mt-0.5 text-micro text-slate-400">
                {e.actorName} · {new Date(e.createdAt).toLocaleString()}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
