import { useState } from "react";
import { Link } from "react-router-dom";
import { Beaker, Factory, Lock, Package, Recycle, RotateCcw, Trash2 } from "lucide-react";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import { EmptyState } from "../components/EmptyState";
import { StatTile } from "../components/StatTile";
import { useRecycleDecision, useRecycleStoreByBatch, useRecycleStoreByItem, useRecycleStoreTransactions } from "../lib/hooks";
import type { RecycleStoreByBatchRow, RecycleStoreByItemRow, RecycleStoreTransaction } from "../lib/types";

// Items/batches here can be in Kg, Ltr, Count, SKU — summing raw
// quantities across units would produce a meaningless number, so every
// total stays grouped by its own unit. Same helper as RndStorePage's own
// sumByUnit.
function sumByUnit(entries: { quantity: number; unit: string }[]): string {
  const totals = new Map<string, number>();
  for (const e of entries) {
    if (!e.quantity) continue;
    const unit = e.unit || "—";
    totals.set(unit, (totals.get(unit) ?? 0) + e.quantity);
  }
  if (totals.size === 0) return "0";
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([unit, qty]) => `${qty} ${unit}`)
    .join(" · ");
}

// Recycle Store — a read-only combined view over the two waste ledgers
// this app writes to automatically: a real RM/PM spill at Dispensing
// (Store's own WASTE-purpose consumption line) and a QA gate's own
// Wastage bucket (Phase F, QC's entry at QA_GATE_MFG/QA_GATE_PACKAGING).
// Unlike R&D Store, there's nothing to act on here — no send, confirm,
// consume, or return — everything below was written by the Batch
// pipeline itself (see transition.ts); this page only ever displays it.
export function RecycleStorePage() {
  const { hasRole } = useAuth();
  const canAccess = hasRole("STORE", "PRODUCTION", "QA_QC", "PPIC");

  const { data: transactions, isLoading: loadingTxns } = useRecycleStoreTransactions();
  const { data: byItem, isLoading: loadingByItem } = useRecycleStoreByItem();
  const { data: byBatch, isLoading: loadingByBatch } = useRecycleStoreByBatch();

  if (!canAccess) {
    return <EmptyState icon={Lock} title="Restricted" hint="This page belongs to Store, Production, QA/QC, and PPIC — ask a team member from one of those departments if you need something here." accent="slate" />;
  }

  const loading = loadingTxns || loadingByItem || loadingByBatch;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-black text-slate-900">
          <Recycle className="h-5 w-5 text-brand-600" strokeWidth={2.25} /> Recycle Store
        </h1>
        <p className="mt-1 text-xs text-slate-500">
          Everything wasted or rejected, in one place. Wastage is gone for good. Raw / packaging material rejected at the Plant waits here for QA: put it back into the Plant's stock (Reuse) or destroy it.
        </p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-20 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile icon={Package} label="RM/PM Wasted (Dispensing)" value={sumByUnit((byItem ?? []).map((r) => ({ quantity: r.totalQty, unit: r.unit })))} accent="amber" />
          <StatTile icon={Factory} label="Batch Output Wasted (QA Gates)" value={sumByUnit((byBatch ?? []).filter((r) => r.outputKind !== "REJECTED").map((r) => ({ quantity: r.totalQty, unit: r.unit })))} accent="amber" />
          <StatTile icon={Beaker} label="Items Affected" value={byItem?.length ?? 0} accent="slate" />
          <StatTile icon={Recycle} label="Batches Affected" value={byBatch?.length ?? 0} accent="slate" />
        </div>
      )}

      <ToDecidePanel rows={transactions} canDecide={hasRole("QA_QC", "ADMIN")} />
      <ByItemPanel loading={loadingByItem} rows={byItem} />
      <ByBatchPanel loading={loadingByBatch} rows={byBatch} />
      <ActivityFeedPanel loading={loadingTxns} rows={transactions} />
    </div>
  );
}

/** Rejected raw / packaging material that QA has not decided about yet: Reuse (back into the Plant's stock) or Destroy. */
function ToDecidePanel({ rows, canDecide }: { rows: RecycleStoreTransaction[] | undefined; canDecide: boolean }) {
  const waiting = (rows ?? []).filter((r) => r.kind === "material" && r.recycleKind === "REJECTED" && (r.toDecide ?? 0) > 1e-6);
  const [open, setOpen] = useState<{ id: string; decision: "REUSE" | "DESTROY" } | null>(null);
  if (waiting.length === 0) return null;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 bg-amber-50/70 px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-amber-800">
          <Recycle className="h-3.5 w-3.5" /> Waiting for QA's decision ({waiting.length})
        </h3>
        <p className="mt-0.5 text-micro text-amber-700">Rejected at the Plant. Reuse puts it back into the Plant's stock; Destroy writes it off with a certificate.</p>
      </div>
      <div className="divide-y divide-slate-100">
        {waiting.map((r) => (
          <div key={r.id} className="px-4 py-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-bold text-slate-700">
                  {r.itemName}
                  {r.productName && <span className="font-normal text-slate-400"> · {r.productName} {r.poNumber ? `(${r.poNumber})` : ""}</span>}
                </p>
                <p className="text-slate-400">
                  {r.plantName && `${r.plantName} · `}
                  {new Date(r.date).toLocaleDateString()}
                  {r.note ? ` · ${r.note}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-bold text-slate-800">
                  {r.toDecide} of {r.quantity} {r.unit} waiting
                </span>
                {canDecide && (
                  <>
                    <button type="button" className="btn-primary btn-sm" onClick={() => setOpen(open?.id === r.id && open.decision === "REUSE" ? null : { id: r.id, decision: "REUSE" })}>
                      <RotateCcw className="h-3.5 w-3.5" strokeWidth={2.25} /> Reuse
                    </button>
                    <button type="button" className="btn-ghost btn-sm text-rose-700" onClick={() => setOpen(open?.id === r.id && open.decision === "DESTROY" ? null : { id: r.id, decision: "DESTROY" })}>
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} /> Destroy
                    </button>
                  </>
                )}
              </div>
            </div>
            {open?.id === r.id && <DecisionForm row={r} decision={open.decision} onDone={() => setOpen(null)} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function DecisionForm({ row, decision, onDone }: { row: RecycleStoreTransaction; decision: "REUSE" | "DESTROY"; onDone: () => void }) {
  const toast = useToast();
  const decide = useRecycleDecision();
  const left = row.toDecide ?? 0;
  const [qty, setQty] = useState(String(left));
  const [note, setNote] = useState("");
  const [cert, setCert] = useState("");
  const n = Number(qty);
  const ok = n > 0 && n <= left + 1e-9;

  async function save() {
    try {
      await decide.mutateAsync({ id: row.id, decision, quantity: n, note: note.trim() || undefined, certificateNo: decision === "DESTROY" ? cert.trim() || undefined : undefined });
      toast.success(decision === "REUSE" ? `${n} ${row.unit} is back in the Plant's stock.` : `${n} ${row.unit} destroyed.`);
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
      <div className="w-40">
        <label className="label">{decision === "REUSE" ? "How much to reuse" : "How much to destroy"} (max {left})</label>
        <input className="field font-mono" type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
      </div>
      {decision === "DESTROY" && (
        <div className="w-48">
          <label className="label">Certificate no. (optional)</label>
          <input className="field" value={cert} onChange={(e) => setCert(e.target.value)} />
        </div>
      )}
      <div className="min-w-[14rem] flex-1">
        <label className="label">{decision === "REUSE" ? "Why is it fine to reuse? (optional)" : "Note (optional)"}</label>
        <input className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder={decision === "REUSE" ? "e.g. re-sieved, checked, within spec" : ""} />
      </div>
      <button type="button" className={decision === "REUSE" ? "btn-primary btn-sm" : "btn-danger btn-sm"} disabled={!ok || decide.isPending} onClick={() => void save()}>
        {decide.isPending ? "Saving…" : decision === "REUSE" ? "Put back into the Plant's stock" : "Destroy"}
      </button>
    </div>
  );
}

function ByItemPanel({ loading, rows }: { loading: boolean; rows: RecycleStoreByItemRow[] | undefined }) {
  if (loading) return <div className="skeleton h-40 w-full" />;
  if (!rows?.length) return null;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
          <Package className="h-3.5 w-3.5" /> RM/PM Wasted at Dispensing — by item
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="table-modern w-full">
          <thead>
            <tr>
              <th>Item</th>
              <th className="text-right">Category</th>
              <th className="text-right">Total Wasted</th>
              <th className="text-right">Entries</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.itemId}>
                <td className="font-bold text-slate-800">{r.itemName}</td>
                <td className="text-right text-slate-500">{r.category}</td>
                <td className="text-right font-mono font-bold text-amber-700">
                  {r.totalQty} {r.unit}
                </td>
                <td className="text-right font-mono text-slate-500">{r.entryCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ByBatchPanel({ loading, rows }: { loading: boolean; rows: RecycleStoreByBatchRow[] | undefined }) {
  if (loading) return <div className="skeleton h-40 w-full" />;
  if (!rows?.length) return null;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
          <Factory className="h-3.5 w-3.5" /> Batch Output Wasted / Rejected at QA Gates — by batch
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="table-modern w-full">
          <thead>
            <tr>
              <th>Product</th>
              <th>PO</th>
              <th>Gate</th>
              <th>What</th>
              <th className="text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.productionBatchId ?? r.combinedLotId}-${r.stageId}-${r.outputKind ?? "WASTAGE"}`}>
                <td className="font-bold text-slate-800">
                  <Link to={r.productionBatchId ? `/production-batches/${r.productionBatchId}` : `/combined-lots/${r.combinedLotId}`} className="hover:text-brand-600">
                    {r.productName}
                  </Link>
                  {r.batchNo && <span className="block text-micro font-normal text-slate-400">Batch {r.batchNo}</span>}
                </td>
                <td className="text-slate-500">{r.poNumber ?? "—"}</td>
                <td className="text-slate-500">{r.stageLabel}</td>
                <td>
                  <span className={`pill ${r.outputKind === "REJECTED" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>{r.outputKind === "REJECTED" ? "Rejected - held" : "Wasted"}</span>
                </td>
                <td className="text-right font-mono font-bold text-amber-700">
                  {r.totalQty} {r.unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActivityFeedPanel({ loading, rows }: { loading: boolean; rows: RecycleStoreTransaction[] | undefined }) {
  if (loading) return <div className="skeleton h-60 w-full" />;
  if (!rows?.length) return <EmptyState icon={Recycle} title="Nothing wasted yet" hint="Real RM/PM spills at Dispensing and each QA gate's own Wastage entries will show up here the moment either happens." accent="slate" />;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-600">Recent Activity</h3>
      </div>
      <div className="divide-y divide-slate-100">
        {rows.map((r) => (
          <div key={`${r.kind}-${r.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs">
            <div className="min-w-0">
              <p className="truncate font-bold text-slate-700">
                {r.kind === "material" ? r.itemName : r.stageLabel}
                {r.productName && (
                  <span className="font-normal text-slate-400">
                    {" "}
                    — {r.productName} {r.poNumber ? `(${r.poNumber})` : ""}
                  </span>
                )}
              </p>
              <p className="text-slate-400">
                {r.plantName && `${r.plantName} · `}
                {r.createdByName} · {new Date(r.date).toLocaleDateString()}
              </p>
            </div>
            <span className="flex items-center gap-2 shrink-0">
              <span className={`pill ${r.kind === "material" ? "border-amber-200 bg-amber-50 text-amber-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
                {r.kind === "material" ? "RM/PM" : "Batch Output"}
              </span>
              {r.kind === "material" && (
                <span className={`pill ${r.recycleKind === "REJECTED" ? ((r.toDecide ?? 0) > 1e-6 ? "border-violet-200 bg-violet-50 text-violet-700" : "border-emerald-200 bg-emerald-50 text-emerald-700") : "border-slate-200 bg-slate-50 text-slate-500"}`} title={(r.decisions ?? []).map((d) => `${d.decision === "REUSE" ? "Reused" : "Destroyed"} ${d.quantity}${d.certificateNo ? ` (cert ${d.certificateNo})` : ""}`).join(" · ")}>
                  {r.recycleKind === "REJECTED" ? ((r.toDecide ?? 0) > 1e-6 ? `Waiting for QA${(r.decisions ?? []).length ? ` (${r.toDecide} left)` : ""}` : "Decided") : "Wastage - closed"}
                </span>
              )}
              <span className="font-mono font-bold text-slate-700">
                {r.quantity} {r.unit}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
