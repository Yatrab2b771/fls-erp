import { fmtQty } from "../lib/format";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Download, PackageOpen, Plus, Send, X } from "lucide-react";
import { ApiError, api, apiAll } from "../lib/api";
import { usePagedList } from "../lib/usePagedList";
import { appendParams, useTileFilters } from "../lib/tileFilters";
import { exportStockIssuedReport, type StockIssuedRow } from "../lib/inventoryExport";
import { Pagination } from "../components/Pagination";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import type { OptionPage } from "../components/MultiSelectDropdown";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { LogEntryForm } from "../components/LogEntryForm";
import { useAuth } from "../lib/auth";

const BASE = "/api/inventory/stock-issued";
const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };

const serverList = (key: string, label: string): FilterField => ({
  key,
  label,
  load: (q) => api<OptionPage>(`${BASE}/options?field=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
});
const FIELDS: FilterField[] = [
  serverList("location", "Location"),
  { key: "category", label: "Category", options: ["RM", "PM"] },
  serverList("item", "Item"),
  { key: "status", label: "Status", options: ["Delivered", "In Transit"] },
  serverList("batchNo", "Batch No"),
  serverList("grnNo", "GRN No"),
  serverList("issuedBy", "Issued By"),
  { key: "unit", label: "Unit", options: ["Kg", "Ltr", "Count"] },
];

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

// Everything the Warehouse has issued out - to a Day Store or the R&D Store - newest first, filterable by
// location. (The Warehouse never issues to a Plant; a Day Store does, to its own Plant.)
export function StockIssuedPage() {
  const toast = useToast();
  const { hasRole } = useAuth();
  const canIssue = hasRole("STORE", "ADMIN");
  const [showForm, setShowForm] = useState(false);
  const tileFilters = useTileFilters();
  const [exporting, setExporting] = useState(false);
  const paged = usePagedList<StockIssuedRow>({ key: ["inventory", "stock-issued", "list"], path: BASE, params: tileFilters.params, noSearch: true });
  const isFiltered = tileFilters.activeCount > 0;

  async function exportAll() {
    setExporting(true);
    try {
      const qs = appendParams(new URLSearchParams(), tileFilters.params);
      exportStockIssuedReport(await apiAll<StockIssuedRow>(`${BASE}${qs.toString() ? `?${qs}` : ""}`));
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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-violet-500/10 text-violet-600">
            <Send className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Stock Issued</h1>
            <p className="text-sm text-slate-500">
              {paged.total.toLocaleString()} issue entr{paged.total === 1 ? "y" : "ies"}
              {isFiltered ? " match" : ""} from the Warehouse — to Day Stores and the R&D Store
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost btn-sm" disabled={paged.total === 0 || exporting} onClick={exportAll}>
            <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> {exporting ? "Preparing…" : `Download Report${isFiltered ? " (Filtered)" : ""}`}
          </button>
          {canIssue && (
            <button className="btn-primary btn-sm" onClick={() => setShowForm((v) => !v)}>
              {showForm ? (
                <>
                  <X className="h-3.5 w-3.5" strokeWidth={2.5} /> Close
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Issue Stock
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {showForm && canIssue && <LogEntryForm initialType="ISSUED_DAY_STORE" lockType onDone={() => setShowForm(false)} />}

      <TileFilterBar filters={tileFilters} tileKey="stock-issued" fields={FIELDS} dateLabel="Issued" />

      {paged.isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : paged.total === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "Nothing issued yet"} hint={isFiltered ? "Nothing matches these filters." : "Issues show here once Store sends material out of the Warehouse."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">Quantity</th>
                <th className="px-4 py-3">Issued To</th>
                <th className="px-4 py-3">Batch No</th>
                <th className="px-4 py-3">GRN No</th>
                <th className="px-4 py-3">Against</th>
                <th className="px-4 py-3">Issued By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.rows.map((r) => (
                <tr key={r.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-600">{day(r.date)}</td>
                  <td className="px-4 py-3">
                    <span className={`pill ${r.status === "In Transit" ? "border-amber-200 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>{r.status}</span>
                  </td>
                  <td className="whitespace-normal px-4 py-3 font-bold text-slate-800">{r.itemName}</td>
                  <td className="px-4 py-3 text-slate-500">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                  <td className="px-4 py-3 text-right font-mono font-bold text-slate-900">
                    {fmtQty(r.quantity)} {r.unit}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-semibold text-slate-700">{r.locationName ?? "—"}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{r.batchNo ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{r.grnNo ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{r.viaRequest ? "Material Request" : "Direct issue"}</td>
                  <td className="px-4 py-3 text-slate-500">{r.issuedBy}</td>
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
