import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ChevronDown, Download, Factory, Undo2 } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { usePlantStockBoard, useReturnFromPlant, type PlantStockRow } from "../lib/hooks";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";

// Production's Plant Stock tile: what the Plant holds of every material, how much is reserved for batches (dispensed to a batch and not yet
// accounted for by its Utilization) and how much is free. A batch's leftover (E · Return) stays here until Production sends it back to the Day Store.
export function PlantStockPage() {
  const { hasRole } = useAuth();
  const canReturn = hasRole("PRODUCTION", "ADMIN");
  const { data, isLoading } = usePlantStockBoard();
  const filters = useTileFilters();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const everyRow = data?.rows ?? [];
  const showPlant = (data?.plants.length ?? 0) > 1;
  const distinct = (xs: string[]) => [...new Set(xs)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const fields: FilterField[] = [
    ...(showPlant ? [{ key: "plant", label: "Plant", options: distinct(everyRow.map((r) => r.plantName)) }] : []),
    { key: "item", label: "Material", options: distinct(everyRow.map((r) => r.itemName)) },
    { key: "category", label: "Type", options: ["RM", "PM"] },
    { key: "state", label: "Stock", options: ["Leftover to send back", "Reserved for a batch", "Free"] },
  ];
  const rows = everyRow.filter(
    (r) =>
      (!picked("plant").length || picked("plant").includes(r.plantName)) &&
      (!picked("item").length || picked("item").includes(r.itemName)) &&
      (!picked("category").length || picked("category").includes(r.category)) &&
      (!picked("state").length || (picked("state").includes("Leftover to send back") && r.pendingReturn > 0) || (picked("state").includes("Reserved for a batch") && r.reserved > 0) || (picked("state").includes("Free") && r.free > 0)),
  );
  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;
  const pendingTotal = everyRow.filter((r) => r.pendingReturn > 0).length;

  function download() {
    const lines = rows.flatMap((r): Record<string, string | number>[] =>
      r.batches.length === 0
        ? [{ Plant: r.plantName, Material: r.itemName, Type: r.category, Unit: r.unit, "On hand": r.onHand, Reserved: r.reserved, Free: r.free, "Leftover to send back": r.pendingReturn, Batch: "", Given: "", Used: "", Leftover: "" }]
        : r.batches.map((b) => ({ Plant: r.plantName, Material: r.itemName, Type: r.category, Unit: r.unit, "On hand": r.onHand, Reserved: r.reserved, Free: r.free, "Leftover to send back": r.pendingReturn, Batch: b.batchNo ?? "", Given: b.given, Used: b.used, Leftover: b.leftover })),
    );
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Plant stock", "FLS Plant Stock", describeFilters(filters, fields), lines);
    XLSX.writeFile(wb, stampedName("FLS_Plant_Stock"));
  }

  const cols = 8 + (showPlant ? 1 : 0);
  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-teal-500/10 text-teal-600">
            <Factory className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Plant Stock</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} material{rows.length === 1 ? "" : "s"}
              {isFiltered ? ` of ${everyRow.length}` : ""} at the Plant{pendingTotal > 0 ? ` · ${pendingTotal} with leftover to send back` : ""}. Reserved is what batches were given and have not accounted for yet; Free is what a new batch could get. Leftover (E) from a batch stays here until you send it back to the Day Store.
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey="plant-stock" fields={fields} dateLabel="Date" hideDates />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Factory} title={isFiltered ? "Nothing matches these filters" : "No stock at the Plant"} hint="Material shows here once the Day Store has issued it to the Plant." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                  {showPlant && <th className="px-4 py-2.5">Plant</th>}
                  <th className="px-4 py-2.5">Material</th>
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5 text-right">On hand</th>
                  <th className="px-4 py-2.5 text-right">Reserved for batches</th>
                  <th className="px-4 py-2.5 text-right">Free</th>
                  <th className="px-4 py-2.5 text-right">Leftover to send back</th>
                  <th className="px-4 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r) => {
                  const key = `${r.plantId}::${r.itemId}`;
                  const open = openKey === key;
                  return (
                    <Fragment key={key}>
                      <tr className="border-b border-slate-50 align-top hover:bg-slate-50">
                        {showPlant && <td className="px-4 py-2.5 text-slate-600">{r.plantName}</td>}
                        <td className="px-4 py-2.5 font-bold text-slate-800">{r.itemName}</td>
                        <td className="px-4 py-2.5 text-slate-500">{r.category}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-800">
                          {fmtQty(r.onHand)} {r.unit}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-mono ${r.reserved > 0 ? "font-bold text-amber-700" : "text-slate-300"}`}>{r.reserved > 0 ? `${fmtQty(r.reserved)} ${r.unit}` : "—"}</td>
                        <td className={`px-4 py-2.5 text-right font-mono ${r.free > 0 ? "font-bold text-emerald-700" : "text-slate-300"}`}>{r.free > 0 ? `${fmtQty(r.free)} ${r.unit}` : "—"}</td>
                        <td className={`px-4 py-2.5 text-right font-mono ${r.pendingReturn > 0 ? "font-bold text-violet-700" : "text-slate-300"}`}>{r.pendingReturn > 0 ? `${fmtQty(r.pendingReturn)} ${r.unit}` : "—"}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenKey(open ? null : key)}>
                            {canReturn && r.free > 0 ? "Send back" : "Batches"} <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-slate-100">
                          <td colSpan={cols} className="whitespace-normal bg-slate-50/70 px-4 py-4">
                            <Detail row={r} canReturn={canReturn} onDone={() => setOpenKey(null)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ClientPager pg={pg} />
        </div>
      )}
    </div>
  );
}

function Detail({ row, canReturn, onDone }: { row: PlantStockRow; canReturn: boolean; onDone: () => void }) {
  const toast = useToast();
  const send = useReturnFromPlant();
  const [qty, setQty] = useState(String(row.pendingReturn > 0 ? Math.min(row.pendingReturn, row.free) : row.free));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setError(null);
    const n = Number(qty);
    if (!(n > 0)) return setError("Enter the quantity to send back.");
    if (n > row.free + 1e-9) return setError(`Only ${fmtQty(row.free)} ${row.unit} is free: the rest is reserved for batches.`);
    try {
      await send.mutateAsync({ plantId: row.plantId, itemId: row.itemId, quantity: n, note: note.trim() || undefined });
      toast.success(`${fmtQty(n)} ${row.unit} of ${row.itemName} sent back to the Day Store. It waits for the store to confirm.`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send it back");
    }
  }
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[20rem_1fr]">
      <div className="space-y-2.5">
        <p className="label">Send {row.itemName} back to the Day Store</p>
        {canReturn && row.free > 0 ? (
          <>
            <div>
              <label className="mb-0.5 block text-micro text-slate-400">
                Quantity ({row.unit}) · up to {fmtQty(row.free)} free
                {row.pendingReturn > 0 ? `, ${fmtQty(row.pendingReturn)} marked as leftover` : ""}
              </label>
              <input className="field !py-1.5 font-mono text-xs" type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div>
              <label className="mb-0.5 block text-micro text-slate-400">Note (optional)</label>
              <input className="field !py-1.5 text-xs" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
            <button type="button" className="btn-primary btn-sm w-full" disabled={send.isPending} onClick={submit}>
              <Undo2 className="h-3.5 w-3.5" strokeWidth={2.5} /> {send.isPending ? "Sending…" : "Send back to Day Store"}
            </button>
            <p className="text-micro text-slate-400">The Plant's stock drops now; the Day Store's rises once it confirms.</p>
          </>
        ) : (
          <p className="text-xs text-slate-400">{row.free > 0 ? "Production sends material back." : "Nothing is free to send back: all of it is reserved for batches."}</p>
        )}
      </div>
      <div>
        <p className="label">By batch</p>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full whitespace-nowrap text-xs">
            <thead className="bg-slate-50 text-micro font-bold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">Batch</th>
                <th className="px-3 py-2 text-right">Given</th>
                <th className="px-3 py-2 text-right">Used (A–D)</th>
                <th className="px-3 py-2 text-right">Leftover (E)</th>
                <th className="px-3 py-2 text-right">Still reserved</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {row.batches.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-slate-400">
                    No batch was given this material.
                  </td>
                </tr>
              )}
              {row.batches.map((b) => (
                <tr key={b.batchId}>
                  <td className="px-3 py-1.5 font-mono font-bold text-orange-800">{b.batchNo ?? b.batchId.slice(0, 8)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">{fmtQty(b.given)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">{b.used ? fmtQty(b.used) : "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-violet-700">{b.leftover ? fmtQty(b.leftover) : "—"}</td>
                  <td className={`px-3 py-1.5 text-right font-mono ${b.reserved > 0 ? "font-bold text-amber-700" : "text-slate-300"}`}>{b.reserved > 0 ? fmtQty(b.reserved) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
