import { fmtQty } from "../lib/format";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, HandHelping, PackageOpen, Plus } from "lucide-react";
import { ApiError } from "../lib/api";
import { usePagedList } from "../lib/usePagedList";
import { useCreateStoreRequest, useInventoryItems, useMyStoreInfo } from "../lib/hooks";
import type { MaterialRequestRow } from "../lib/inventoryExport";
import { Pagination } from "../components/Pagination";
import { ItemPicker } from "../components/ItemPicker";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { STATUS_STYLE, SUPPLY_STYLE } from "./MaterialRequestsPage";

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");

// A Day Store login asks the Warehouse for material and follows each request: what has been issued so far and,
// when the Warehouse was short, where the purchase stands (With PPIC -> With Purchase -> On order -> Received).
export function MyStoreRequestsPage() {
  const toast = useToast();
  const { data: info } = useMyStoreInfo();
  const { data: items } = useInventoryItems();
  const create = useCreateStoreRequest();
  const paged = usePagedList<MaterialRequestRow>({ key: ["inventory", "my-store", "requests", "list"], path: "/api/inventory/my-store/requests", params: {}, noSearch: true });

  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState("");
  const [neededBy, setNeededBy] = useState("");
  const [note, setNote] = useState("");
  const [dayStoreId, setDayStoreId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const stores = info?.stores ?? [];

  async function submit() {
    setError(null);
    if (!itemId) return setError("Choose the item you need.");
    if (!qty || Number(qty) <= 0) return setError("Enter a quantity greater than zero.");
    if (stores.length > 1 && !dayStoreId) return setError("Choose which Store this is for.");
    try {
      await create.mutateAsync({ itemId, requestedQty: Number(qty), neededBy: neededBy || undefined, note: note.trim() || undefined, dayStoreId: dayStoreId || undefined });
      toast.success("Request sent to the Warehouse.");
      setItemId("");
      setQty("");
      setNeededBy("");
      setNote("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the request");
    }
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-brand-500/10 text-brand-600">
          <HandHelping className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">My Material Requests</h1>
          <p className="text-sm text-slate-500">Ask the Warehouse for material for {stores.map((s) => s.name).join(", ") || "your store"} and follow each request.</p>
        </div>
      </div>

      <div className="card space-y-3 p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">New request</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <label className="label">Item</label>
            <ItemPicker items={(items ?? []).map((i) => ({ id: i.id, name: i.name }))} value={itemId} onChange={setItemId} />
          </div>
          <div>
            <label className="label">Quantity</label>
            <input className="field font-mono" type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div>
            <label className="label">Needed by (optional)</label>
            <input className="field" type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
          </div>
          {stores.length > 1 && (
            <div>
              <label className="label">Store</label>
              <select className="field" value={dayStoreId} onChange={(e) => setDayStoreId(e.target.value)}>
                <option value="">— Select —</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className={stores.length > 1 ? "sm:col-span-3" : "sm:col-span-4"}>
            <label className="label">Note (optional)</label>
            <input className="field" placeholder="What it is for" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
        <div className="flex justify-end">
          <button type="button" className="btn-primary btn-sm" disabled={create.isPending} onClick={submit}>
            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> {create.isPending ? "Sending…" : "Send request"}
          </button>
        </div>
      </div>

      {paged.isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : paged.total === 0 ? (
        <EmptyState icon={PackageOpen} title="No requests yet" hint="Your requests to the Warehouse show here." accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Requested</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3 text-right">Requested</th>
                <th className="px-4 py-3 text-right">Issued</th>
                <th className="px-4 py-3 text-right">Remaining</th>
                <th className="px-4 py-3">Needed By</th>
                <th className="px-4 py-3">Purchase Trail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.rows.map((r) => (
                <tr key={r.key} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-600">{day(r.requestedAt)}</td>
                  <td className="px-4 py-3">
                    <span className={`pill ${STATUS_STYLE[r.status] ?? ""}`}>{r.status}</span>
                  </td>
                  <td className="whitespace-normal px-4 py-3 font-bold text-slate-800">{r.itemName}</td>
                  <td className="px-4 py-3 text-right font-mono text-slate-700">
                    {fmtQty(r.requestedQty)} {r.unit}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-700">{r.issuedQty ? fmtQty(r.issuedQty) : "—"}</td>
                  <td className="px-4 py-3 text-right font-mono text-slate-900">{r.remainingQty > 0 ? fmtQty(r.remainingQty) : "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{day(r.neededBy)}</td>
                  <td className="px-4 py-3">
                    {r.supply === "NONE" ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <>
                        <span className={`pill ${SUPPLY_STYLE[r.supplyLabel] ?? ""}`}>{r.supplyLabel}</span>
                        {r.supply === "ON_ORDER" && <span className="block text-micro text-slate-500">ETA {day(r.eta)}</span>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={paged.page} pageSize={paged.pageSize} total={paged.total} onPage={paged.setPage} onPageSize={paged.setPageSize} isFetching={paged.isFetching} />
        </div>
      )}
    </div>
  );
}
