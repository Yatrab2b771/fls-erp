import { useMemo, useState } from "react";
import { Check, ClipboardCheck, Scale, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useDayStores, useInventoryItems, useMyStoreInfo, usePlants } from "../lib/hooks";
import {
  ADJUSTMENT_REASON_LABEL,
  useAdjustmentPosition,
  useCreateStockAdjustment,
  useReviewStockAdjustment,
  useStockAdjustments,
  useStockAdjustmentSummary,
  useWithdrawStockAdjustment,
  type AdjustmentLocation,
  type AdjustmentReason,
  type AdjustmentStatus,
  type StockAdjustment,
} from "../lib/stockControlHooks";
import { ItemPicker } from "../components/ItemPicker";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { StatTile } from "../components/StatTile";
import { useToast } from "../components/Toast";
import { ApiError } from "../lib/api";
import { fmtQty } from "../lib/format";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";

const STATUS_STYLE: Record<AdjustmentStatus, string> = {
  PENDING: "border-amber-200 bg-amber-50 text-amber-700",
  APPROVED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  REJECTED: "border-rose-200 bg-rose-50 text-rose-700",
};

// A wrong balance used to be fixable only by deleting entries, which is blocked once other stock depends on them. A correction is
// raised by whoever is at the place (Store / Production / R&D), approved by Accounts or the Admin, and only then changes any stock.
export function StockAdjustmentsPage() {
  const { hasRole, user } = useAuth();
  const canRaise = hasRole("STORE", "PRODUCTION", "RND");
  const canReview = hasRole("ACCOUNTS");
  const [status, setStatus] = useState<AdjustmentStatus | "">(canReview ? "PENDING" : "");
  const { data: summary } = useStockAdjustmentSummary();
  const { data: rows, isLoading } = useStockAdjustments(status || undefined);
  const pg = useClientPaging(rows);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-brand-50 text-brand-600">
          <Scale className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Stock Corrections</h1>
          <p className="text-sm text-slate-500">Fix a balance that does not match the shelf. A second person (Accounts or Admin) approves it - only then does the stock change.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile icon={ClipboardCheck} label="Waiting for approval" value={summary?.pending ?? 0} accent="amber" />
        <StatTile icon={Check} label="Approved" value={summary?.approved ?? 0} accent="emerald" />
        <StatTile icon={X} label="Rejected" value={summary?.rejected ?? 0} accent="rose" />
      </div>

      {canRaise && <RaiseForm />}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {(["", "PENDING", "APPROVED", "REJECTED"] as const).map((s) => (
            <button key={s || "all"} className={status === s ? "btn-primary btn-sm" : "btn-ghost btn-sm"} onClick={() => setStatus(s)}>
              {s === "" ? "All" : s === "PENDING" ? "Waiting" : s === "APPROVED" ? "Approved" : "Rejected"}
            </button>
          ))}
        </div>
        {isLoading ? (
          <SkeletonRows rows={4} cols={6} />
        ) : !rows?.length ? (
          <EmptyState icon={Scale} title="No corrections here" hint={canRaise ? "Raise one above when the shelf and the system disagree." : "Nothing is waiting."} accent="brand" />
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="table-modern w-full whitespace-nowrap">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Place</th>
                    <th className="text-right">Change</th>
                    <th>Why</th>
                    <th>Raised by</th>
                    <th>Status</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pg.rows.map((a) => (
                    <AdjustmentRow key={a.id} adj={a} canReview={canReview || hasRole("ADMIN")} mine={a.requestedById === user?.id || hasRole("ADMIN")} />
                  ))}
                </tbody>
              </table>
              <ClientPager pg={pg} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AdjustmentRow({ adj, canReview, mine }: { adj: StockAdjustment; canReview: boolean; mine: boolean }) {
  const toast = useToast();
  const review = useReviewStockAdjustment();
  const withdraw = useWithdrawStockAdjustment();
  const [rejecting, setRejecting] = useState(false);

  async function approve() {
    try {
      await review.mutateAsync({ id: adj.id, action: "APPROVE" });
      toast.success("Approved - the stock is corrected.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not approve");
    }
  }
  async function reject(note: string) {
    try {
      await review.mutateAsync({ id: adj.id, action: "REJECT", note });
      toast.success("Rejected.");
      setRejecting(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not reject");
    }
  }
  async function doWithdraw() {
    try {
      await withdraw.mutateAsync(adj.id);
      toast.success("Withdrawn.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not withdraw");
    }
  }

  return (
    <tr>
      <td className="font-bold text-slate-800">{adj.itemName}</td>
      <td className="text-slate-600">{adj.locationName}</td>
      <td className={`text-right font-mono font-bold ${adj.quantityDelta > 0 ? "text-emerald-700" : "text-rose-700"}`}>
        {adj.quantityDelta > 0 ? "+" : ""}
        {fmtQty(adj.quantityDelta)} {adj.unit}
        {adj.countedQty !== null && adj.systemQty !== null && (
          <span className="block text-micro font-medium text-slate-400">
            counted {fmtQty(adj.countedQty)}, system {fmtQty(adj.systemQty)}
          </span>
        )}
      </td>
      <td className="max-w-[18rem] whitespace-normal text-slate-600">
        <span className="font-semibold">{ADJUSTMENT_REASON_LABEL[adj.reason]}</span>
        <span className="block text-xs text-slate-500">{adj.note}</span>
        {adj.reviewNote && <span className="block text-xs text-slate-400">Review: {adj.reviewNote}</span>}
      </td>
      <td className="text-slate-600">
        {adj.requestedByName}
        <span className="block text-micro text-slate-400">{new Date(adj.requestedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}</span>
      </td>
      <td>
        <span className={`pill ${STATUS_STYLE[adj.status]}`}>{adj.status === "PENDING" ? "Waiting" : adj.status === "APPROVED" ? "Approved" : "Rejected"}</span>
        {adj.reviewedByName && <span className="block text-micro text-slate-400">by {adj.reviewedByName}</span>}
      </td>
      <td className="text-right">
        {adj.status === "PENDING" && (
          <div className="inline-flex gap-1.5">
            {canReview && (
              <>
                <button className="btn-primary btn-sm" disabled={review.isPending} onClick={approve}>
                  <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> Approve
                </button>
                <button className="btn-ghost btn-sm" disabled={review.isPending} onClick={() => setRejecting(true)}>
                  Reject
                </button>
              </>
            )}
            {mine && !canReview && (
              <button className="btn-ghost btn-sm" disabled={withdraw.isPending} onClick={doWithdraw}>
                Withdraw
              </button>
            )}
          </div>
        )}
        <ConfirmDialog open={rejecting} title="Reject this correction?" message={`${adj.itemName}: ${adj.quantityDelta > 0 ? "+" : ""}${fmtQty(adj.quantityDelta)} ${adj.unit}`} confirmLabel="Reject" tone="danger" requireReason reasonLabel="Why" busy={review.isPending} onConfirm={reject} onCancel={() => setRejecting(false)} />
      </td>
    </tr>
  );
}

type PlaceOption = { id: string; name: string; type: AdjustmentLocation; dayStoreId?: string; plantId?: string };

function RaiseForm() {
  const toast = useToast();
  const { hasRole } = useAuth();
  const create = useCreateStockAdjustment();
  const { data: myStore } = useMyStoreInfo({ enabled: hasRole("STORE") });
  const { data: dayStores } = useDayStores({ enabled: hasRole("STORE", "ADMIN") });
  const { data: plants } = usePlants();
  const { data: items } = useInventoryItems();

  // The places this person can correct: a Day Store login its own store(s); the Warehouse seat the Warehouse and every Day Store;
  // Production the Plants; R&D its own store. (The server checks it again.)
  const places = useMemo<PlaceOption[]>(() => {
    const out: PlaceOption[] = [];
    const scopedStores = myStore?.scoped ? myStore.stores : null;
    if (hasRole("STORE", "ADMIN") && !scopedStores) out.push({ id: "WAREHOUSE", name: "Warehouse", type: "WAREHOUSE" });
    if (hasRole("STORE", "ADMIN")) for (const d of scopedStores ?? dayStores ?? []) out.push({ id: `DS:${d.id}`, name: `Day Store: ${d.name}`, type: "DAY_STORE", dayStoreId: d.id });
    if (hasRole("PRODUCTION", "ADMIN")) for (const p of plants ?? []) out.push({ id: `PL:${p.id}`, name: `Plant: ${p.name}`, type: "PLANT", plantId: p.id });
    if (hasRole("RND", "ADMIN")) out.push({ id: "RND", name: "R&D Store", type: "RND_STORE" });
    return out;
  }, [hasRole, myStore, dayStores, plants]);

  const [placeId, setPlaceId] = useState("");
  const place = places.find((p) => p.id === placeId) ?? (places.length === 1 ? places[0] : undefined);
  const [itemId, setItemId] = useState("");
  const item = items?.find((i) => i.id === itemId);
  const [mode, setMode] = useState<"COUNT" | "DELTA">("COUNT");
  const [counted, setCounted] = useState("");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState<AdjustmentReason>("COUNT_CORRECTION");
  const [note, setNote] = useState("");

  const { data: position } = useAdjustmentPosition({ itemId: itemId || undefined, locationType: place?.type, dayStoreId: place?.dayStoreId, plantId: place?.plantId });
  const diff = mode === "COUNT" && counted !== "" && position ? Math.round((Number(counted) - position.onHand) * 1000) / 1000 : null;

  const reasonOptions: AdjustmentReason[] = mode === "COUNT" ? ["COUNT_CORRECTION"] : ["DAMAGED", "SPILLAGE", "FOUND_EXTRA", ...(place?.type === "WAREHOUSE" ? (["EXPIRED_DISPOSAL"] as AdjustmentReason[]) : []), "OTHER"];

  async function submit() {
    if (!place || !itemId) return toast.error("Pick the place and the item.");
    if (note.trim().length < 3) return toast.error("Write why the stock is being corrected.");
    try {
      await create.mutateAsync({
        itemId,
        locationType: place.type,
        dayStoreId: place.dayStoreId,
        plantId: place.plantId,
        mode,
        ...(mode === "COUNT" ? { countedQty: Number(counted) } : { quantityDelta: Number(delta), reason }),
        note: note.trim(),
      });
      toast.success("Sent for approval.");
      setCounted("");
      setDelta("");
      setNote("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not raise the correction");
    }
  }

  if (places.length === 0) return null;
  return (
    <div className="card space-y-4 p-5 sm:p-6">
      <p className="label !mb-0 flex items-center gap-1.5">
        <Scale className="h-3.5 w-3.5" /> Raise a correction
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="label">
            Place <span className="text-rose-500">*</span>
          </label>
          {places.length === 1 ? <div className="field flex items-center bg-slate-50 font-semibold text-slate-700">{places[0]!.name}</div> : <ItemPicker items={places.map((p) => ({ id: p.id, name: p.name }))} value={placeId} onChange={setPlaceId} placeholder="— Where is the stock? —" />}
        </div>
        <div className="sm:col-span-2">
          <label className="label">
            Item <span className="text-rose-500">*</span>
          </label>
          <ItemPicker items={(items ?? []).map((i) => ({ id: i.id, name: i.name, code: i.code }))} value={itemId} onChange={setItemId} placeholder="— Select an item —" />
        </div>
      </div>

      {place && item && (
        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-sm text-slate-600">
          The system shows <b className="font-mono text-slate-900">{position ? `${fmtQty(position.onHand)} ${item.unit ?? ""}` : "…"}</b> of {item.name} at {place.name}.
          {position && position.expiredInQuarantine > 0 && (
            <span className="ml-1 text-amber-700">
              Another {fmtQty(position.expiredInQuarantine)} {item.unit ?? ""} is expired in Quarantine (not counted above).
            </span>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <button className={mode === "COUNT" ? "btn-primary btn-sm" : "btn-ghost btn-sm"} onClick={() => (setMode("COUNT"), setReason("COUNT_CORRECTION"))}>
          I counted it
        </button>
        <button className={mode === "DELTA" ? "btn-primary btn-sm" : "btn-ghost btn-sm"} onClick={() => (setMode("DELTA"), setReason("DAMAGED"))}>
          Add / take out
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {mode === "COUNT" ? (
          <div>
            <label className="label">
              Counted quantity <span className="text-rose-500">*</span>
            </label>
            <input className="field font-mono" type="number" min="0" step="any" value={counted} onChange={(e) => setCounted(e.target.value)} />
            {diff !== null && <p className={`mt-1 text-xs font-bold ${diff === 0 ? "text-slate-400" : diff > 0 ? "text-emerald-700" : "text-rose-700"}`}>{diff === 0 ? "Same as the system - nothing to correct." : `Difference: ${diff > 0 ? "+" : ""}${fmtQty(diff)} ${item?.unit ?? ""}`}</p>}
          </div>
        ) : (
          <>
            <div>
              <label className="label">
                Quantity (+ add, - take out) <span className="text-rose-500">*</span>
              </label>
              <input className="field font-mono" type="number" step="any" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="e.g. -2.5" />
            </div>
            <div>
              <label className="label">Reason</label>
              <select className="field" value={reason} onChange={(e) => setReason(e.target.value as AdjustmentReason)}>
                {reasonOptions.map((r) => (
                  <option key={r} value={r}>
                    {ADJUSTMENT_REASON_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <div className={mode === "COUNT" ? "sm:col-span-2" : ""}>
          <label className="label">
            Why <span className="text-rose-500">*</span>
          </label>
          <input className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened?" />
        </div>
      </div>
      <button className="btn-primary" disabled={create.isPending} onClick={submit}>
        {create.isPending ? "Sending…" : "Send for approval"}
      </button>
    </div>
  );
}
