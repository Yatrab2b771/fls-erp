import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PackagePlus, Send } from "lucide-react";
import { ApiError, api, apiAll } from "../lib/api";
import { fmtQty } from "../lib/format";
import { useToast } from "./Toast";

interface ExtraRow {
  id: string;
  isExtra: boolean;
  open: boolean;
  statusKey: string;
  batchId: string | null;
  batchNo: string | null;
  productName: string | null;
  poNumber: string | null;
  plantName: string | null;
  itemName: string;
  unit: string;
  remainingQty: number;
  storeStock: number;
  newMaterial?: boolean;
  note: string | null;
}

const KEY = ["inventory", "my-store", "production-requests", "extra-to-dispense"];

// The extra material Production asked for a batch (outside its plan, or what R&D's later BOM change needs), once the Store has approved it: the
// Store dispenses it here, like a batch's Dispensing (what was weighed, its own GRN, the lots it came from). It goes to the Plant as an issue that is
// on its way until Production receives it. The Store approves or rejects the request itself on its Production Requests page.
export function ExtraToDispense() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: () => apiAll<ExtraRow>("/api/inventory/my-store/production-requests"),
    refetchInterval: 30_000,
  });
  const rows = (data ?? []).filter((r) => r.isExtra && !!r.batchId && r.open && (r.statusKey === "APPROVED" || r.statusKey === "PARTIALLY_ISSUED") && r.remainingQty > 0);
  const [edits, setEdits] = useState<Record<string, { qty?: string; note?: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (rows.length === 0) return null;

  const qtyOf = (r: ExtraRow) => edits[r.id]?.qty ?? String(Math.max(0, Math.min(r.remainingQty, r.storeStock)));

  async function dispense(r: ExtraRow) {
    setError(null);
    const qty = Number(qtyOf(r));
    if (!(qty > 0)) return setError(`${r.itemName}: enter how much was weighed and given.`);
    if (qty > r.remainingQty + 1e-9) return setError(`${r.itemName}: only ${fmtQty(r.remainingQty)} ${r.unit} is still owed.`);
    if (qty > r.storeStock + 1e-9) return setError(`${r.itemName}: your store holds only ${fmtQty(r.storeStock)} ${r.unit}. Ask the Warehouse for the rest.`);
    setBusy(r.id);
    try {
      const done = await api<{ grnNo: string }>(`/api/production-batches/${r.batchId}/dispense-extra`, { method: "POST", body: { requestId: r.id, quantity: qty, note: edits[r.id]?.note?.trim() || undefined } });
      toast.success(`Dispensed ${fmtQty(qty)} ${r.unit} for batch ${r.batchNo}. GRN ${done.grnNo}: on its way, Production receives it.`);
      setEdits((cur) => ({ ...cur, [r.id]: {} }));
      await qc.invalidateQueries({ queryKey: ["inventory"] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not dispense it");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card overflow-hidden border-violet-200">
      <div className="flex items-center gap-2 border-b border-violet-100 bg-violet-50/60 px-4 py-3">
        <PackagePlus className="h-4 w-4 text-violet-600" strokeWidth={2.25} />
        <div>
          <p className="text-sm font-black text-slate-900">Extra material to dispense ({rows.length})</p>
          <p className="text-xs text-slate-500">Asked for a batch outside its plan and approved by you. Dispense it like the batch's own material: it gets its own GRN and goes to the Plant, where Production receives it.</p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2.5">Batch</th>
              <th className="px-4 py-2.5">Product</th>
              <th className="px-4 py-2.5">Material</th>
              <th className="px-4 py-2.5 text-right">Owed</th>
              <th className="px-4 py-2.5 text-right">At my Store</th>
              <th className="px-4 py-2.5">Weighed / given</th>
              <th className="px-4 py-2.5">Note</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-slate-50 align-top">
                <td className="px-4 py-2.5 font-mono font-black text-orange-800">{r.batchNo}</td>
                <td className="px-4 py-2.5 font-bold text-slate-800">
                  {r.productName ?? "—"}
                  <span className="block text-micro font-normal text-slate-400">{[r.poNumber, r.plantName].filter(Boolean).join(" · ")}</span>
                </td>
                <td className="whitespace-normal px-4 py-2.5 font-bold text-slate-800">
                  {r.itemName}
                  {r.newMaterial && <span className="ml-1.5 rounded-full bg-violet-100 px-1.5 py-0.5 align-middle text-micro font-bold uppercase text-violet-700">New material</span>}
                  {r.note && <span className="block text-micro font-normal text-slate-500">{r.note}</span>}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                  {fmtQty(r.remainingQty)} {r.unit}
                </td>
                <td className={`px-4 py-2.5 text-right font-mono ${r.storeStock + 1e-9 < r.remainingQty ? "font-bold text-rose-600" : "text-slate-700"}`}>{fmtQty(r.storeStock)}</td>
                <td className="px-4 py-2.5">
                  <input className="field !h-8 !w-28 !py-0 text-right font-mono !text-xs" type="number" min="0" step="any" value={qtyOf(r)} onChange={(e) => setEdits((cur) => ({ ...cur, [r.id]: { ...cur[r.id], qty: e.target.value } }))} />
                </td>
                <td className="px-4 py-2.5">
                  <input className="field !h-8 !w-44 !py-0 !text-xs" placeholder="e.g. weighed twice" value={edits[r.id]?.note ?? ""} onChange={(e) => setEdits((cur) => ({ ...cur, [r.id]: { ...cur[r.id], note: e.target.value } }))} />
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button type="button" className="btn-primary btn-sm" disabled={busy === r.id || r.storeStock <= 0} title={r.storeStock <= 0 ? "Your store holds none of it: ask the Warehouse (Production Requests)" : undefined} onClick={() => void dispense(r)}>
                    <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {busy === r.id ? "Dispensing…" : "Dispense"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="px-4 py-2 text-xs font-bold text-rose-600">{error}</p>}
    </div>
  );
}
