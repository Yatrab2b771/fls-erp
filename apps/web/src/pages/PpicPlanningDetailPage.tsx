import { Fragment, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Ban, ChevronDown, ClipboardList, Download, Eye, Factory, Pause, Play, Send, ShoppingCart, Sparkles } from "lucide-react";
import { usePoItemPlan, useSetItemMaterialHold, useCreateBomPlan, useCreateRmPlan, useCancelPoItem, useSendShortToPurchase, useSendPlanToProduction } from "../lib/hooks";
import { ApiError, apiAll } from "../lib/api";
import { usePagedList } from "../lib/usePagedList";
import { Pagination } from "../components/Pagination";
import { AGING_FIELD, TileFilterBar, ppicFields, ppicTileFields } from "../components/TileFilterBar";
import { appendParams, useTileFilters } from "../lib/tileFilters";
import { AgingCell } from "../components/AgingCell";
import { PreparationSteps } from "../components/PlanFromPpic";
import { useToast } from "../components/Toast";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PartialReleaseDialog } from "../components/PartialReleaseDialog";
import { AssignPlantDialog } from "../components/AssignPlantDialog";
import { EmptyState } from "../components/EmptyState";
import {
  getItemStage,
  hasCalculatedBom,
  hasCalculatedRm,
  isFullyPlanned,
  PPIC_PLANNING_METRIC_LABEL,
  type PpicPlanningItemRow,
  type PpicPlanningResult,
  type PpicPlanningMetric,
} from "../lib/ppicPlanning";
import { exportPpicPlanningReport } from "../lib/ppicPlanningReports";
import type { PendingPoMaterialRow, PreProduction, ProductionBatch, PurchaseOrder, PurchaseOrderItem } from "../lib/types";
import { CustomerName } from "../components/CustomerName";

const VALID_METRICS = new Set(Object.keys(PPIC_PLANNING_METRIC_LABEL));

// The Action button in the Not Planned list: a small dropdown with
//   Generate      - creates whichever of the BOM / RM plans the product doesn't
//                   have yet (same as the Generate button on the PO page)
//   Hold / Release Hold - reversible pause: a held product's plan can't be generated
//   Cancel        - the product is dead for good, NO undo (reason required)
// Every one of them asks Yes / No first. The menu is portalled to <body> so the
// table's card (which has an effect that offsets fixed children) can't misplace it.
type PendingAction = "generate" | "hold" | "release" | "cancel" | "purchase" | "send" | "partial" | "plant";

// Just the bits of a product the menu needs, so both the Not Planned list (a
// PurchaseOrderItem) and the Material Planning list (a MaterialPlanningProduct)
// can use it. `stage` only changes what Generate / the Hold wording say:
// Material Planning products are fully planned, so there is no Generate there,
// and Hold there means "stop claiming stock / can't be sent to Production".
export type ActionItem = Pick<PurchaseOrderItem, "id" | "productName"> & { materialHeldAt?: string | null; partiallyReleased?: boolean; bomPlans?: unknown[]; rmPlans?: unknown[]; shortCount?: number; regulatoryStatus?: string | null; plannedPlantId?: string | null };

export function ProductActions({
  poId,
  poNumber,
  item,
  onToggleHold,
  busy,
  stage = "notPlanned",
}: {
  poId: string;
  poNumber: string;
  item: ActionItem;
  onToggleHold: (poId: string, itemId: string, productName: string, held: boolean) => void;
  busy: boolean;
  stage?: "notPlanned" | "materialPlanning" | "ready" | "onHold" | "sent";
}) {
  const toast = useToast();
  const createBomPlan = useCreateBomPlan();
  const createRmPlan = useCreateRmPlan();
  const cancelItem = useCancelPoItem();
  const sendShort = useSendShortToPurchase();
  const sendToProduction = useSendPlanToProduction(poId);
  // Where the menu sits: below the button, or above it when there's no room
  // underneath (last rows of a short page).
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const held = !!item.materialHeldAt;
  // Already sent to Production (no batch made yet): Hold / Cancel then also stop Production.
  const wasSent = stage === "sent" || !!(item as { planSentToProductionAt?: string | null }).planSentToProductionAt;
  const needsBom = !item.bomPlans?.length;
  const needsRm = !item.rmPlans?.length;
  const generating = createBomPlan.isPending || createRmPlan.isPending;
  const showGenerate = stage === "notPlanned";
  // Material Planning only: send this product's short materials to Purchase.
  const showPurchase = stage === "materialPlanning";
  // PO Readiness list only: send the (fully covered) plan to Production. Blocked
  // until Regulatory has approved it (the server enforces the same), and it needs
  // a Plant. Hold / Cancel stay as everywhere else; once sent the product leaves
  // the list, so they can't be used on it any more.
  const showSend = stage === "ready";
  // Start Production with part of the order (the material already in hand) - on PO Readiness and on Material Planning.
  const showPartial = stage === "ready" || stage === "materialPlanning";
  // Pick the Plant right from the list, without opening the PO.
  // Also before Generate: the plan's material goes to that Plant's Day Store, so the Plant comes first.
  // Only while the product is Not Planned - once planned, its material has gone to that Plant's Day Store.
  const showAssignPlant = stage === "notPlanned";
  const sendBlocked = held
    ? "On hold - release it first"
    : item.regulatoryStatus === "Not Approved"
      ? "Regulatory marked this Not Approved"
      : item.regulatoryStatus !== "Approved"
        ? "Waiting for Regulatory approval"
        : !item.plannedPlantId
          ? "Assign a Plant to this product first (open the PO)"
          : undefined;
  const claimsStage = stage !== "notPlanned";
  const shortCount = item.shortCount ?? 0;
  const purchaseDisabled = held || shortCount === 0 || sendShort.isPending;
  const purchaseHint = held ? "On hold - release it first" : shortCount === 0 ? "Nothing is short for this product" : undefined;
  const generateDisabled = held || generating || (!needsBom && !needsRm) || !item.plannedPlantId;
  const generateHint = held ? "On hold - release the hold first" : !item.plannedPlantId ? "Assign a Plant first (Assign Plant...)" : !needsBom && !needsRm ? "Both plans already created - open the PO to finish them" : undefined;
  const generateWhat = [needsBom && "Packaging BOM", needsRm && "RM BOM"].filter(Boolean).join(" + ");
  const label = `${item.productName} (${poNumber})`;

  async function generate() {
    setPending(null);
    try {
      const [bom, rm] = await Promise.all([
        needsBom ? createBomPlan.mutateAsync({ name: `${item.productName} — BOM`, purchaseOrderItemId: item.id }) : Promise.resolve(undefined),
        needsRm ? createRmPlan.mutateAsync({ name: `${item.productName} — RM BOM`, purchaseOrderItemId: item.id }) : Promise.resolve(undefined),
      ]);
      const calculated = [bom?.status === "CALCULATED" && "BOM", rm?.status === "CALCULATED" && "RM BOM"].filter(Boolean);
      toast.success(calculated.length ? `Generated — ${calculated.join(" + ")} calculated instantly.` : "Plan(s) created — no catalog match yet, add the SKU/Recipe by hand.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not generate");
    }
  }

  async function sendProduction() {
    try {
      await sendToProduction.mutateAsync(item.id);
      toast.success(`${item.productName} - plan sent to Production.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not send the plan");
    } finally {
      setPending(null);
    }
  }

  async function sendToPurchase() {
    setPending(null);
    try {
      const res = await sendShort.mutateAsync({ poId, itemId: item.id });
      const parts = [res.sent > 0 && `${res.sent} sent`, res.updated > 0 && `${res.updated} quantity updated`, res.skipped > 0 && `${res.skipped} already up to date`].filter(Boolean);
      toast.success(`Short material to Purchase: ${parts.join(", ")}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not send to Purchase");
    }
  }

  async function cancel(reason: string) {
    try {
      await cancelItem.mutateAsync({ poId, itemId: item.id, reason });
      setPending(null);
      toast.success(`${item.productName} cancelled.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not cancel the product");
    }
  }

  const menuItem = "flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-xs font-bold hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent";
  const choose = (action: PendingAction) => {
    setPos(null);
    setPending(action);
  };

  return (
    <>
      <button
        type="button"
        className="btn-ghost btn-sm"
        disabled={busy || generating || cancelItem.isPending}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const right = document.documentElement.clientWidth - rect.right;
          const menuHeight = (showGenerate || showPurchase || showSend ? 132 + (showPartial ? 36 : 0) : 92) + (showAssignPlant ? 36 : 0);
          setPos(rect.bottom + menuHeight + 8 > window.innerHeight ? { bottom: window.innerHeight - rect.top + 4, right } : { top: rect.bottom + 4, right });
        }}
      >
        {generating ? "Generating…" : "Action"} <ChevronDown className="h-3.5 w-3.5" strokeWidth={2.5} />
      </button>
      {pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setPos(null)} />
            <div className="fixed z-50 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-left shadow-lift" style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}>
              {showSend && (
                <button type="button" className={`${menuItem} text-emerald-700`} disabled={!!sendBlocked || sendToProduction.isPending} title={sendBlocked} onClick={() => choose("send")}>
                  <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {item.partiallyReleased ? "Release the rest" : "Send to Production"}
                </button>
              )}
              {showAssignPlant && (
                <button type="button" className={`${menuItem} text-slate-700`} onClick={() => choose("plant")}>
                  <Factory className="h-3.5 w-3.5" strokeWidth={2.5} /> {item.plannedPlantId ? "Change Plant…" : "Assign Plant…"}
                </button>
              )}
              {showPartial && (
                <button type="button" className={`${menuItem} text-emerald-700`} disabled={!!sendBlocked || sendToProduction.isPending} title={sendBlocked ?? "Start Production with only part of the order and release more later"} onClick={() => choose("partial")}>
                  <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> Send partial…
                </button>
              )}
              {showGenerate && (
                <button type="button" className={`${menuItem} text-slate-700`} disabled={generateDisabled} title={generateHint} onClick={() => choose("generate")}>
                  <Sparkles className="h-3.5 w-3.5" strokeWidth={2.5} /> Generate
                </button>
              )}
              <button type="button" className={`${menuItem} text-slate-700`} onClick={() => choose(held ? "release" : "hold")}>
                {held ? (
                  <>
                    <Play className="h-3.5 w-3.5" strokeWidth={2.5} /> Release Hold
                  </>
                ) : (
                  <>
                    <Pause className="h-3.5 w-3.5" strokeWidth={2.5} /> Hold
                  </>
                )}
              </button>
              {showPurchase && (
                <button type="button" className={`${menuItem} text-slate-700`} disabled={purchaseDisabled} title={purchaseHint} onClick={() => choose("purchase")}>
                  <ShoppingCart className="h-3.5 w-3.5" strokeWidth={2.5} /> Send to Purchase
                </button>
              )}
              <div className="my-1 border-t border-slate-100" />
              <button type="button" className={`${menuItem} text-rose-600`} onClick={() => choose("cancel")}>
                <Ban className="h-3.5 w-3.5" strokeWidth={2.5} /> Cancel
              </button>
            </div>
          </>,
          document.body,
        )}

      <AssignPlantDialog open={pending === "plant"} poId={poId} itemId={item.id} productName={item.productName} currentPlantId={item.plannedPlantId} onClose={() => setPending(null)} />
      <PartialReleaseDialog open={pending === "partial"} poId={poId} itemId={item.id} productName={item.productName} onClose={() => setPending(null)} />
      <ConfirmDialog
        open={pending === "send"}
        title="Send plan to Production?"
        message={
          <>
            <b>{label}</b> goes to Production. This is a crucial step - after it the product can no longer be held or cancelled. If any material is still short the server will refuse and tell you which.
          </>
        }
        confirmLabel="Yes, send to Production"
        busy={sendToProduction.isPending}
        onConfirm={sendProduction}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === "purchase"}
        title="Send short material to Purchase?"
        message={
          <>
            <b>{label}</b> - its {shortCount} short material(s) go to Purchase as shortfall requirements (the missing quantity only). Purchase is notified once.
          </>
        }
        busy={sendShort.isPending}
        onConfirm={sendToPurchase}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === "generate"}
        title="Generate plan?"
        message={
          <>
            <b>{label}</b> — {generateWhat || "plans"} will be generated, and calculated straight away where the catalog has a match.
          </>
        }
        onConfirm={generate}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === "hold"}
        title="Put on hold?"
        message={
          <>
            <b>{label}</b> —{" "}
            {wasSent
              ? "Production can't open or move its run, or make batches, until you release it. Material already at the Day Store stays there."
              : claimsStage
                ? "it stops claiming stock and can't be sent to Production until you release it. Regulatory carries on."
                : "its plan can't be generated until you release the hold."}
          </>
        }
        onConfirm={() => {
          setPending(null);
          onToggleHold(poId, item.id, item.productName, true);
        }}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === "release"}
        title="Release the hold?"
        message={
          <>
            <b>{label}</b> —{" "}
            {wasSent
              ? "Production can go on with it again."
              : stage === "onHold"
              ? "the hold is lifted: its plan can be generated again, and once planned it takes stock and can go to Production."
              : claimsStage
                ? "it goes back into the FIFO queue and can be sent to Production again."
                : "its plan can be generated again."}
          </>
        }
        onConfirm={() => {
          setPending(null);
          onToggleHold(poId, item.id, item.productName, false);
        }}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === "cancel"}
        tone="danger"
        title="Cancel this product for good?"
        message={
          <>
            <b>{label}</b> will be closed for good. <b>This cannot be undone</b> — it can never be released or planned again.
            {wasSent && " Production's run (if opened) stops and the Day Store's untouched requests for it are dropped; material already issued stays as stock."} BD will be told.
          </>
        }
        requireReason
        confirmLabel="Yes, cancel product"
        cancelLabel="No"
        busy={cancelItem.isPending}
        onConfirm={cancel}
        onCancel={() => setPending(null)}
      />
    </>
  );
}

// A PO's stage in the Total POs list.
// The products of one PO, in the Total POs list's dropdown: each with its own stage and how far its plan has got.
function PoProductsTable({ po, itemStages }: { po: PurchaseOrder; itemStages: Record<string, string> }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full whitespace-nowrap text-xs">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2">Product</th>
            <th className="px-3 py-2">Category</th>
            <th className="px-3 py-2">Qty</th>
            <th className="px-3 py-2">Plant</th>
            <th className="px-3 py-2">Stage</th>
            <th className="px-3 py-2">Packaging BOM</th>
            <th className="px-3 py-2">RM BOM</th>
            <th className="px-3 py-2">Plan sent</th>
            <th className="px-3 py-2">Dispatched</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {po.items.map((item) => (
            <tr key={item.id} className={item.cancelledAt ? "opacity-60" : ""}>
              <td className="px-3 py-2 font-bold text-slate-700">{item.productName}</td>
              <td className="px-3 py-2 text-slate-500">{item.productCategory ?? "-"}</td>
              <td className="px-3 py-2 text-slate-500">
                {item.quantity} {item.unit}
              </td>
              <td className="px-3 py-2 text-slate-500">{item.plannedPlant?.name ?? "-"}</td>
              <td className="px-3 py-2">
                <span className="pill border-slate-200 bg-slate-50 text-slate-700">{itemStages[item.id] ?? "-"}</span>
              </td>
              <td className="px-3 py-2">
                <YesNoPill yes={hasCalculatedBom(item)} />
              </td>
              <td className="px-3 py-2">
                <YesNoPill yes={hasCalculatedRm(item)} />
              </td>
              <td className="px-3 py-2">
                <YesNoPill yes={!!item.planSentToProductionAt} />
              </td>
              <td className="px-3 py-2 text-slate-500">{item.dispatch ? `${item.dispatch.dispatchedQty} / ${item.quantity}` : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PoStagePill({ summary }: { summary?: { stage: string; completed: number; total: number } }) {
  if (!summary) return <span className="text-slate-400">-</span>;
  const tone =
    summary.stage === "Completed"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : summary.stage === "In progress"
        ? "border-blue-200 bg-blue-50 text-blue-700"
        : summary.stage === "Rejected"
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : "border-slate-200 bg-slate-50 text-slate-600";
  return <span className={`pill ${tone}`}>{summary.stage}</span>;
}

function YesNoPill({ yes }: { yes: boolean }) {
  return yes ? (
    <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Yes</span>
  ) : (
    <span className="pill border-slate-200 bg-slate-50 text-slate-500">No</span>
  );
}

// One material's Complete/Short line, inside a product's RM or PM cell.
function MaterialLine({ name, requiredQty, unit, onHand, short, shortfallQty }: { name: string; requiredQty: number; unit: string; onHand: number | null; short: boolean; shortfallQty: number }) {
  return (
    <div className="flex items-center justify-between gap-2 whitespace-nowrap">
      <span className={short ? "font-semibold text-rose-700" : "text-slate-600"}>
        {name} <span className="text-slate-400">({requiredQty} {unit})</span>
      </span>
      {onHand === null ? (
        <span className="pill border-slate-200 bg-slate-50 text-slate-400" title="No matching catalog item — can't check stock">Not in Catalog</span>
      ) : short ? (
        <span className="pill border-rose-200 bg-rose-50 text-rose-700">Short {shortfallQty} {unit}</span>
      ) : (
        <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Complete</span>
      )}
    </div>
  );
}

// "View" on a plan-sent row — the same material read Add on Plan does,
// just resolved from this exact PO line item (see the API's
// getPoItemPlanAvailability). Only fetched once a row is expanded.
function PlanDetailPanel({ poId, itemId }: { poId: string; itemId: string }) {
  const { data, isLoading } = usePoItemPlan(poId, itemId);

  if (isLoading || !data) return <div className="skeleton h-16 w-full" />;
  if (!data.bom && !data.rm) {
    return <p className="text-xs text-slate-500">No calculated plan found for this product yet.</p>;
  }

  return (
    <div className="space-y-3">
      {data.preparation && <PreparationSteps prep={data.preparation} />}
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {data.bom && (
        <div>
          <p className="mb-1.5 text-micro font-bold uppercase tracking-wide text-slate-500">
            Packaging BOM — {data.bom.planName} <span className="font-normal normal-case text-slate-400">({new Date(data.bom.planCalculatedAt).toLocaleDateString()})</span>
          </p>
          {data.bom.materials.length === 0 ? (
            <p className="text-xs text-slate-400">No materials in this plan.</p>
          ) : (
            <div className="space-y-1">
              {data.bom.materials.map((m) => (
                <MaterialLine key={m.name} {...m} />
              ))}
            </div>
          )}
        </div>
      )}
      {data.rm && (
        <div>
          <p className="mb-1.5 text-micro font-bold uppercase tracking-wide text-slate-500">
            RM Plan — {data.rm.planName} <span className="font-normal normal-case text-slate-400">({new Date(data.rm.planCalculatedAt).toLocaleDateString()})</span>
          </p>
          {data.rm.materials.length === 0 ? (
            <p className="text-xs text-slate-400">No materials in this plan.</p>
          ) : (
            <div className="space-y-1">
              {data.rm.materials.map((m) => (
                <MaterialLine key={m.name} {...m} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
    </div>
  );
}

// The drill-down behind every PPIC planning dashboard tile — clicking a
// tile lands here with the exact list of purchase orders/products behind
// that number (see ppicPlanning.ts, the shared filter both the tile and
// this page read from), plus a one-click Excel export of that same list.
export function PpicPlanningDetailPage() {
  const { metric } = useParams<{ metric: string }>();
  if (!metric || !VALID_METRICS.has(metric)) {
    return <EmptyState icon={ClipboardList} title="Unknown report" hint="That planning tile doesn't exist." accent="rose" />;
  }
  const m = metric as PpicPlanningMetric;
  const label = PPIC_PLANNING_METRIC_LABEL[m];

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <PpicPlanningTable metric={m} label={label} />
    </div>
  );
}

// One row of a tile's list as the server sends it: the product + its PO, plus
// what the Pending POs report needs to name the product's stage and show its materials.
type PpicListRow = PpicPlanningItemRow & {
  preProduction: { id: string; currentStageId: string } | null;
  batchStages: string[];
  materials: PendingPoMaterialRow | null;
};

// The inputs getItemStage / the Pending POs table expect, rebuilt from the rows on screen.
function stageInputs(rows: PpicListRow[]) {
  const preRuns = rows.flatMap((r) => (r.preProduction ? [{ id: r.preProduction.id, purchaseOrderItemId: r.item.id, currentStageId: r.preProduction.currentStageId }] : [])) as unknown as PreProduction[];
  const batches = rows.flatMap((r) => (r.preProduction ? r.batchStages.map((s) => ({ preProductionId: r.preProduction!.id, currentStageId: s })) : [])) as unknown as ProductionBatch[];
  const materialRows = rows.flatMap((r) => (r.materials ? [r.materials] : []));
  return { preRuns, batches, materialRows };
}

// What the filter bar's date range counts from, per tile (the same moment Aging counts from).
const DATE_LABEL: Partial<Record<PpicPlanningMetric, string>> = { "plan-sent": "Sent to Production", "on-hold": "On hold", cancelled: "Cancelled", "pending-pos": "Approved", "not-planned-pos": "Approved", "total-pos": "Approved", "total-products": "Approved" };

function PpicPlanningTable({ metric, label }: { metric: PpicPlanningMetric; label: string }) {
  const [openPoId, setOpenPoId] = useState<string | null>(null);
  // Search + Order Date range apply to every tile (some, like Total
  // Products, run to 300+ rows with no other way to find one) — lifted
  // up here (not left inside the individual table components) so the
  // Download button can export exactly what's currently filtered on
  // screen, not the full unfiltered list. See ppicPlanning.ts's
  // filterPpicPlanningResult for the matching rule.
  const tileFilters = useTileFilters();
  // Server-side: the list is paged, searched ("Search By" included) and date-filtered over
  // EVERY PO, and only the page on screen is sent to the browser.
  const serverParams = { ...tileFilters.params };
  const paged = usePagedList<PpicListRow>({ key: ["purchase-orders", "ppic", "lists", metric], path: `/api/ppic/lists/${metric}`, params: serverParams, noSearch: true });
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  // Hold / Release on a product (Not Planned tile) — the same per-product hold
  // Material Planning uses: a held product takes no stock once its plans are done.
  const setHold = useSetItemMaterialHold();
  const toast = useToast();
  async function toggleHold(poId: string, itemId: string, productName: string, held: boolean) {
    try {
      await setHold.mutateAsync({ poId, itemId, held });
      toast.success(held ? `${productName} put on hold — its plan can't be generated until it's released.` : `${productName} — hold released.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update the hold");
    }
  }
  const result = { kind: metric === "total-pos" ? "po" : "item", rows: paged.rows } as unknown as PpicPlanningResult;
  const { preRuns, batches, materialRows } = stageInputs(paged.rows);
  const isFiltered = tileFilters.activeCount > 0;
  const [exporting, setExporting] = useState(false);

  // Download Report exports the WHOLE filtered list (every page), not just the page on screen.
  async function exportAll() {
    setExporting(true);
    try {
      const qs = new URLSearchParams();
      appendParams(qs, serverParams);
      const rows = await apiAll<PpicListRow>(`/api/ppic/lists/${metric}${qs.toString() ? `?${qs}` : ""}`);
      const all = { kind: metric === "total-pos" ? "po" : "item", rows } as unknown as PpicPlanningResult;
      exportPpicPlanningReport(metric, all, stageInputs(rows));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not build the report");
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-brand-500/10 text-brand-600">
            <ClipboardList className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{label}</h1>
            <p className="text-sm text-slate-500">
              {paged.total.toLocaleString()} {result.kind === "po" ? "purchase order(s)" : "product(s)"}
              {isFiltered ? " match" : ""}
            </p>
          </div>
        </div>
        <button
          className="btn-primary btn-sm"
          onClick={exportAll}
          disabled={paged.total === 0 || exporting}
        >
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> {exporting ? "Preparing…" : `Download Report${isFiltered ? " (Filtered)" : ""}`}
        </button>
      </div>

      <TileFilterBar filters={tileFilters} tileKey={metric} fields={[...ppicFields(metric, metric === "total-pos" ? ["po", "customer"] : undefined), ...ppicTileFields(metric), AGING_FIELD]} dateLabel={DATE_LABEL[metric] ?? "Date"} />

      {paged.isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : paged.total === 0 && !isFiltered ? (
        <EmptyState icon={ClipboardList} title="Nothing here" hint="No records match this tile right now." accent="brand" />
      ) : result.rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No matches" hint="Nothing matches these filters." accent="brand" />
      ) : metric === "pending-pos" && result.kind === "item" ? (
        <PendingPosTable rows={result.rows} preRuns={preRuns} batches={batches} materialRows={materialRows} />
      ) : metric === "cancelled" && result.kind === "item" ? (
        // Cancelled tile: products PPIC closed for good - read-only, there is no undo.
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Qty</th>
                <th className="px-4 py-3">Cancelled On</th>
                <th className="px-4 py-3">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map(({ po, item, sinceAt }) => (
                <tr key={item.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700 whitespace-nowrap">
                    <Link to={`/purchase-orders/${po.id}`} className="hover:text-brand-600 hover:underline">
                      {po.poNumber ?? po.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600 whitespace-nowrap"><CustomerName name={po.customer.companyName} /></td>
                  <td className="px-4 py-3">
                    <AgingCell since={sinceAt} />
                  </td>
                  <td className="px-4 py-3 text-slate-500 line-through decoration-slate-300 whitespace-nowrap">{item.productName}</td>
                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{item.productCategory ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                    {item.quantity} {item.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{item.cancelledAt?.slice(0, 10) ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{item.cancelReason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : metric === "on-hold" && result.kind === "item" ? (
        // Hold tile: every product PPIC has on hold.
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Qty</th>
                <th className="px-4 py-3">On Hold Since</th>
                <th className="px-4 py-3">Planning</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map(({ po, item, sinceAt }) => (
                <tr key={item.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">
                    <Link to={`/purchase-orders/${po.id}`} className="hover:text-brand-600 hover:underline">
                      {po.poNumber ?? po.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600"><CustomerName name={po.customer.companyName} /></td>
                  <td className="px-4 py-3">
                    <AgingCell since={sinceAt} />
                  </td>
                  <td className="px-4 py-3 text-slate-700">{item.productName}</td>
                  <td className="px-4 py-3 text-slate-500">{item.productCategory ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {item.quantity} {item.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{item.materialHeldAt?.slice(0, 10) ?? "—"}</td>
                  <td className="px-4 py-3">
                    {isFullyPlanned(item) ? (
                      <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Planned</span>
                    ) : hasCalculatedRm(item) || hasCalculatedBom(item) ? (
                      <span className="pill border-amber-200 bg-amber-50 text-amber-700">Partially Planned</span>
                    ) : (
                      <span className="text-slate-500">Not Planned</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <ProductActions stage="onHold" poId={po.id} poNumber={po.poNumber ?? po.id.slice(0, 8)} item={item} onToggleHold={toggleHold} busy={setHold.isPending} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : metric === "plan-sent" && result.kind === "item" ? (
        // In Production tile: every product whose plan PPIC has sent to Production.
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Current Stage</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Qty</th>
                <th className="px-4 py-3">Plant</th>
                <th className="px-4 py-3">Sent On</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map((row) => {
                const { po, item, sinceAt } = row;
                return (
                <tr key={item.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">
                    <Link to={`/purchase-orders/${po.id}`} className="hover:text-brand-600 hover:underline">
                      {po.poNumber ?? po.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className="pill border-blue-200 bg-blue-50 text-blue-700">{getItemStage(item, preRuns, batches)}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-600"><CustomerName name={po.customer.companyName} /></td>
                  <td className="px-4 py-3">
                    <AgingCell since={sinceAt} />
                  </td>
                  <td className="px-4 py-3 text-slate-700">{item.productName}</td>
                  <td className="px-4 py-3 text-slate-500">{item.productCategory ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {item.quantity} {item.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{item.plannedPlant?.name ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{item.planSentToProductionAt?.slice(0, 10) ?? "—"}</td>
                  <td className="px-4 py-3 text-right">
                    {/* Hold and Cancel are possible until Production has made the first batch */}
                    {((row as { batchStages?: string[] }).batchStages?.length ?? 0) === 0 ? (
                      <ProductActions stage="sent" poId={po.id} poNumber={po.poNumber ?? po.id.slice(0, 8)} item={item} onToggleHold={toggleHold} busy={setHold.isPending} />
                    ) : (
                      <span className="text-micro text-slate-300">Batch made</span>
                    )}
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
        </div>
      ) : metric === "not-planned-pos" && result.kind === "item" ? (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Qty</th>
                <th className="px-4 py-3">Order Date</th>
                <th className="px-4 py-3 text-center">RM BOM</th>
                <th className="px-4 py-3 text-center">PM BOM</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map(({ po, item, sinceAt }) => (
                <tr key={item.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">
                    <Link to={`/purchase-orders/${po.id}`} className="hover:text-brand-600 hover:underline">
                      {po.poNumber ?? po.id.slice(0, 8)}
                    </Link>
                  </td>
                  {/* Every row here is already BD-approved by definition, so the
                      useful status is PPIC's own: Not Planned, or Partially
                      Planned once one of the two BOMs is calculated. */}
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {hasCalculatedRm(item) || hasCalculatedBom(item) ? (
                        <span className="pill border-amber-200 bg-amber-50 text-amber-700">Partially Planned</span>
                      ) : (
                        <span className="text-slate-500">Not Planned</span>
                      )}
                      {item.materialHeldAt && (
                        <span className="pill border-amber-200 bg-amber-50 text-micro text-amber-700" title="On hold — its plan can't be generated until released">
                          On Hold
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-600"><CustomerName name={po.customer.companyName} /></td>
                  <td className="px-4 py-3">
                    <AgingCell since={sinceAt} />
                  </td>
                  <td className="px-4 py-3 text-slate-700">{item.productName}</td>
                  <td className="px-4 py-3 text-slate-500">{item.productCategory ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {item.quantity} {item.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{po.orderDate?.slice(0, 10) ?? "—"}</td>
                  <td className="px-4 py-3 text-center font-bold text-slate-600">{hasCalculatedRm(item) ? "✓" : "–"}</td>
                  <td className="px-4 py-3 text-center font-bold text-slate-600">{hasCalculatedBom(item) ? "✓" : "–"}</td>
                  <td className="px-4 py-3 text-right">
                    {!item.planSentToProductionAt && <ProductActions poId={po.id} poNumber={po.poNumber ?? po.id.slice(0, 8)} item={item} onToggleHold={toggleHold} busy={setHold.isPending} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : result.kind === "po" ? (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3">Order Date</th>
                <th className="px-4 py-3">Products</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map((po) => (
                <Fragment key={po.id}>
                <tr className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">
                    <Link to={`/purchase-orders/${po.id}`} className="hover:text-brand-600 hover:underline">
                      {po.poNumber ?? po.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <PoStagePill summary={(po as { stageSummary?: { stage: string; completed: number; total: number } }).stageSummary} />
                  </td>
                  <td className="px-4 py-3 text-slate-600"><CustomerName name={po.customer.companyName} /></td>
                  <td className="px-4 py-3">
                    <AgingCell since={(po as { sinceAt?: string }).sinceAt} />
                  </td>
                  <td className="px-4 py-3 text-slate-500">{po.orderDate?.slice(0, 10) ?? "—"}</td>
                  <td className="px-4 py-3">
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenPoId(openPoId === po.id ? null : po.id)} aria-expanded={openPoId === po.id}>
                      {po.items.length} <ChevronDown className={`h-3.5 w-3.5 transition-transform ${openPoId === po.id ? "rotate-180" : ""}`} strokeWidth={2.5} />
                    </button>
                  </td>
                </tr>
                {openPoId === po.id && (
                  <tr>
                    <td colSpan={6} className="bg-slate-50/60 px-4 py-3">
                      <PoProductsTable po={po} itemStages={(po as { itemStages?: Record<string, string> }).itemStages ?? {}} />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Qty</th>
                {metric === "total-products" && <th className="px-4 py-3">Stage</th>}
                <th className="px-4 py-3">Packaging BOM</th>
                <th className="px-4 py-3">RM BOM</th>
                <th className="px-4 py-3">Plan Sent</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map((row) => {
                const { po, item, sinceAt } = row;
                const isOpen = openItemId === item.id;
                return (
                  <Fragment key={item.id}>
                    <tr className="transition hover:bg-slate-50">
                      <td className="px-4 py-3 font-bold text-slate-700">
                        <Link to={`/purchase-orders/${po.id}`} className="hover:text-brand-600 hover:underline">
                          {po.poNumber ?? po.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-slate-600"><CustomerName name={po.customer.companyName} /></td>
                      <td className="px-4 py-3">
                        <AgingCell since={sinceAt} />
                      </td>
                      <td className="px-4 py-3 text-slate-700">{item.productName}</td>
                      <td className="px-4 py-3 text-slate-500">
                        {item.quantity} {item.unit}
                      </td>
                      {metric === "total-products" && (
                        <td className="px-4 py-3">
                          <span className="pill border-slate-200 bg-slate-50 text-slate-700">{(row as { stageLabel?: string }).stageLabel ?? "-"}</span>
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <YesNoPill yes={hasCalculatedBom(item)} />
                      </td>
                      <td className="px-4 py-3">
                        <YesNoPill yes={hasCalculatedRm(item)} />
                      </td>
                      <td className="px-4 py-3">
                        <YesNoPill yes={!!item.planSentToProductionAt} />
                      </td>
                      <td className="px-4 py-3">
                        <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenItemId(isOpen ? null : item.id)}>
                          <Eye className="h-3.5 w-3.5" strokeWidth={2.5} /> View
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={metric === "total-products" ? 10 : 9} className="bg-slate-50/60 px-4 py-3">
                          <PlanDetailPanel poId={po.id} itemId={item.id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {paged.total > 0 && !paged.isLoading && (
        <div className="card">
          <Pagination page={paged.page} pageSize={paged.pageSize} total={paged.total} onPage={paged.setPage} onPageSize={paged.setPageSize} isFetching={paged.isFetching} />
        </div>
      )}
    </>
  );
}

// The Pending PO Report — one row per product on every pending PO:
// aging, current pipeline stage, and which RM/PM materials are complete
// vs. short (see pending-materials.ts on the API side for how the
// material list is derived from each product's own calculated RM/BOM
// plan).
function PendingPosTable({
  rows,
  preRuns,
  batches,
  materialRows,
}: {
  rows: PpicPlanningItemRow[];
  preRuns: PreProduction[];
  batches: ProductionBatch[];
  materialRows: PendingPoMaterialRow[];
}) {
  const materialsByItemId = new Map(materialRows.map((r) => [r.purchaseOrderItemId, r]));

  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
            <th className="px-4 py-3">PO Number</th>
            <th className="px-4 py-3">Current Stage</th>
            <th className="px-4 py-3">Customer</th>
            <th className="px-4 py-3">Product</th>
            <th className="px-4 py-3">Aging</th>
            <th className="px-4 py-3">Expected Delivery</th>
            <th className="px-4 py-3">Regulatory Body</th>
            <th className="px-4 py-3">RM Materials</th>
            <th className="px-4 py-3">PM Materials</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map(({ po, item, sinceAt }) => {
            const stage = getItemStage(item, preRuns, batches);
            const materials = materialsByItemId.get(item.id);
            const isDelayed = !!po.expectedDeliveryDate && new Date(po.expectedDeliveryDate) < new Date();
            return (
              <tr key={item.id} className="align-top transition hover:bg-slate-50">
                <td className="px-4 py-3 font-bold text-slate-700">
                  <Link to={`/purchase-orders/${po.id}`} className="hover:text-brand-600 hover:underline">
                    {po.poNumber ?? po.id.slice(0, 8)}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <span className="pill border-brand-200 bg-brand-50 text-brand-700">{stage}</span>
                </td>
                <td className="px-4 py-3 text-slate-600"><CustomerName name={po.customer.companyName} /></td>
                <td className="px-4 py-3 text-slate-700">
                  {item.productName}
                  <div className="text-micro font-normal text-slate-400">
                    {item.quantity} {item.unit}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <AgingCell since={sinceAt} />
                </td>
                <td className="px-4 py-3">
                  {po.expectedDeliveryDate ? (
                    <span className={isDelayed ? "font-semibold text-rose-700" : "text-slate-500"}>
                      {po.expectedDeliveryDate.slice(0, 10)}
                      {isDelayed ? " (Delayed)" : ""}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-500">{po.regulatoryBody ?? "—"}</td>
                <td className="px-4 py-3 space-y-1">
                  {!materials || materials.rmMaterials.length === 0 ? (
                    <span className="text-slate-400">{materials?.rmPlanned ? "—" : "Not Planned Yet"}</span>
                  ) : (
                    materials.rmMaterials.map((m) => <MaterialLine key={m.name} {...m} />)
                  )}
                </td>
                <td className="px-4 py-3 space-y-1">
                  {!materials || materials.pmMaterials.length === 0 ? (
                    <span className="text-slate-400">{materials?.bomPlanned ? "—" : "Not Planned Yet"}</span>
                  ) : (
                    materials.pmMaterials.map((m) => <MaterialLine key={m.name} {...m} />)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
