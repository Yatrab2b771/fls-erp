import { useState } from "react";
import { Link } from "react-router-dom";
import { AlarmClock, ArrowLeft, Download, PackageOpen, Truck } from "lucide-react";
import { ApiError, api, apiAll } from "../lib/api";
import { usePagedList } from "../lib/usePagedList";
import { appendParams, useTileFilters } from "../lib/tileFilters";
import { exportIncomingReport, type IncomingRow } from "../lib/inventoryExport";
import { useIncomingSummary } from "../lib/hooks";
import { Pagination } from "../components/Pagination";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import type { OptionPage } from "../components/MultiSelectDropdown";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { CustomerName } from "../components/CustomerName";

const BASE = "/api/inventory/requirements/incoming";
const serverList = (key: string, label: string): FilterField => ({
  key,
  label,
  load: (q) => api<OptionPage>(`${BASE}/options?field=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
});
const FIELDS: FilterField[] = [
  serverList("customerPo", "Customer PO"),
  serverList("product", "Product"),
  serverList("item", "Item"),
  serverList("vendor", "Vendor"),
  serverList("pi", "PI Number"),
  { key: "category", label: "Category", options: ["RM", "PM"] },
];

// Material that Purchase has put on order and that has not arrived yet - one row per PI line,
// earliest ETA first. Store reads it as "what to expect and when"; PPIC as "when can the next
// product start". A line closes by itself when Store accepts the delivery into stock.
export function IncomingMaterialPage() {
  const tileFilters = useTileFilters();
  const paged = usePagedList<IncomingRow>({ key: ["pre-inventory", "requirements", "incoming"], path: BASE, params: tileFilters.params, noSearch: true });
  const { data: summary } = useIncomingSummary();
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const isFiltered = tileFilters.activeCount > 0;

  async function exportAll() {
    setExporting(true);
    try {
      const qs = appendParams(new URLSearchParams(), tileFilters.params);
      exportIncomingReport(await apiAll<IncomingRow>(`${BASE}${qs.toString() ? `?${qs}` : ""}`));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not build the report");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-amber-500/10 text-amber-600">
            <Truck className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">ETA</h1>
            <p className="text-sm text-slate-500">
              {paged.total.toLocaleString()} PI line(s) on their way{isFiltered ? " match" : ""}
              {summary && summary.overdue > 0 && (
                <>
                  {" "}
                  · <span className="font-bold text-rose-600">{summary.overdue} overdue</span>
                </>
              )}
              {summary && summary.dueThisWeek > 0 && <> · {summary.dueThisWeek} due within a week</>}
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm shrink-0" disabled={paged.total === 0 || exporting} onClick={exportAll}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> {exporting ? "Preparing…" : `Download Report${isFiltered ? " (Filtered)" : ""}`}
        </button>
      </div>

      <TileFilterBar filters={tileFilters} tileKey="incoming-material" fields={FIELDS} dateLabel="ETA" />

      {paged.isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : paged.total === 0 ? (
        <EmptyState
          icon={PackageOpen}
          title={isFiltered ? "No matches" : "Nothing incoming"}
          hint={isFiltered ? "Nothing matches these filters." : "Material shows here once Purchase logs a PI against a shortfall, until Store receives it."}
          accent="brand"
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Expected</th>
                <th className="px-4 py-3">PI Number</th>
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">ETA</th>
                <th className="px-4 py-3">Customer PO</th>
                <th className="px-4 py-3">Product</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.rows.map((r) => (
                <tr key={r.lineId} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">{r.itemName}</td>
                  <td className="px-4 py-3 text-slate-500">{r.category === "RM" ? "Raw Material" : "Packaging Material"}</td>
                  <td className="px-4 py-3 font-mono text-slate-700">
                    {r.quantity} {r.unit}
                    {r.quantity < r.orderedQty && <span className="ml-1.5 font-sans text-micro text-slate-400">of {r.orderedQty}</span>}
                  </td>
                  <td className="px-4 py-3 font-bold text-brand-700">{r.piNumber}</td>
                  <td className="px-4 py-3 text-slate-600">{r.vendorName}</td>
                  <td className="px-4 py-3">
                    <span className={r.overdue ? "inline-flex items-center gap-1 font-semibold text-rose-700" : "text-slate-600"}>
                      {r.overdue && <AlarmClock className="h-3.5 w-3.5" strokeWidth={2.5} />}
                      {new Date(r.eta).toLocaleDateString()}
                      {r.overdue ? " (Overdue)" : ""}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {r.customerPo ? (
                      <>
                        <Link to={`/purchase-orders/${r.customerPo.poId}`} className="font-semibold text-slate-700 hover:text-brand-600 hover:underline">
                          {r.customerPo.poNumber ?? r.customerPo.poId.slice(0, 8)}
                        </Link>
                        <span className="block text-micro text-slate-400"><CustomerName name={r.customerPo.customerName} /></span>
                      </>
                    ) : (
                      <span title="Raised by hand or imported - not tied to a customer PO">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-700">{r.customerPo?.productName ?? <span className="text-slate-400">—</span>}</td>
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
