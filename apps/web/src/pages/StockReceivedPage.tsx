import { fmtQty } from "../lib/format";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownToLine, ArrowLeft, Download, PackageOpen, Plus, X } from "lucide-react";
import { ApiError, api, apiAll } from "../lib/api";
import { usePagedList } from "../lib/usePagedList";
import { appendParams, useTileFilters } from "../lib/tileFilters";
import { exportStockReceivedReport, type StockReceivedRow } from "../lib/inventoryExport";
import { Pagination } from "../components/Pagination";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import type { OptionPage } from "../components/MultiSelectDropdown";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { LogEntryForm } from "../components/LogEntryForm";
import { useAuth } from "../lib/auth";

const BASE = "/api/inventory/stock-received";
const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };

const serverList = (key: string, label: string): FilterField => ({
  key,
  label,
  load: (q) => api<OptionPage>(`${BASE}/options?field=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
});
const FIELDS: FilterField[] = [
  { key: "category", label: "Category", options: ["RM", "PM"] },
  serverList("item", "Item"),
  serverList("vendor", "Vendor"),
  serverList("invoiceNo", "Invoice No"),
  serverList("grnNo", "GRN No"),
  serverList("batchNo", "Batch No"),
  { key: "qcStatus", label: "QC Status", options: ["Pending QC", "On Hold", "QC Approved", "QC Rejected", "Accepted"] },
  { key: "unit", label: "Unit", options: ["Kg", "Ltr", "Count"] },
];

const QC_STYLE: Record<string, string> = {
  "Pending QC": "bg-amber-50 text-amber-700",
  "On Hold": "bg-orange-50 text-orange-700",
  "QC Approved": "bg-sky-50 text-sky-700",
  "QC Rejected": "bg-rose-50 text-rose-700",
  Accepted: "bg-emerald-50 text-emerald-700",
};

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

// Every delivery the Warehouse has taken in from a vendor (Material Received log entries), newest first.
export function StockReceivedPage() {
  const toast = useToast();
  const tileFilters = useTileFilters();
  const [exporting, setExporting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const canLog = useAuth().hasRole("STORE"); // the Warehouse seat logs deliveries
  const paged = usePagedList<StockReceivedRow>({ key: ["inventory", "stock-received", "list"], path: BASE, params: tileFilters.params, noSearch: true });
  const isFiltered = tileFilters.activeCount > 0;

  async function exportAll() {
    setExporting(true);
    try {
      const qs = appendParams(new URLSearchParams(), tileFilters.params);
      exportStockReceivedReport(await apiAll<StockReceivedRow>(`${BASE}${qs.toString() ? `?${qs}` : ""}`));
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
          <div className="stat-icon bg-sky-500/10 text-sky-600">
            <ArrowDownToLine className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Stock Received</h1>
            <p className="text-sm text-slate-500">
              {paged.total.toLocaleString()} delivery entr{paged.total === 1 ? "y" : "ies"}
              {isFiltered ? " match" : ""} received in the Warehouse from vendors
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost btn-sm shrink-0" disabled={paged.total === 0 || exporting} onClick={exportAll}>
            <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> {exporting ? "Preparing…" : `Download Report${isFiltered ? " (Filtered)" : ""}`}
          </button>
          {canLog && (
            <button className="btn-primary btn-sm" onClick={() => setShowForm((s) => !s)}>
              {showForm ? (
                <>
                  <X className="h-3.5 w-3.5" strokeWidth={2.5} /> Close
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Log Entry
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {showForm && canLog && <LogEntryForm initialType="RECEIVED" lockType onDone={() => setShowForm(false)} />}

      <TileFilterBar filters={tileFilters} tileKey="stock-received" fields={FIELDS} dateLabel="Received" />

      {paged.isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : paged.total === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "Nothing received yet"} hint={isFiltered ? "Nothing matches these filters." : "Deliveries show here once Store logs a Material Received entry."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">QC Status</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">Quantity</th>
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Invoice No</th>
                <th className="px-4 py-3">Invoice Date</th>
                <th className="px-4 py-3">GRN No</th>
                <th className="px-4 py-3">Batch No</th>
                <th className="px-4 py-3">Mfg Date</th>
                <th className="px-4 py-3">Expiry Date</th>
                <th className="px-4 py-3 text-right">Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.rows.map((r) => (
                <tr key={r.id} className="transition hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{day(r.date)}</td>
                  <td className="px-4 py-3">
                    {r.qcStatus ? <span className={`inline-flex rounded-full px-2 py-0.5 text-micro font-bold ${QC_STYLE[r.qcStatus] ?? "bg-slate-100 text-slate-600"}`}>{r.qcStatus}</span> : "—"}
                  </td>
                  <td className="px-4 py-3 font-bold text-slate-700">{r.itemName}</td>
                  <td className="px-4 py-3 text-slate-500">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-mono font-bold text-slate-900">
                    {fmtQty(r.quantity)} {r.unit}
                    {!!r.rejectedQty && <span className="block font-sans text-micro font-semibold text-rose-600">{fmtQty(r.rejectedQty)} rejected</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{r.vendorName ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{r.invoiceNo ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{day(r.invoiceDate)}</td>
                  <td className="px-4 py-3 text-slate-600">{r.grnNo ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{r.batchNo ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{day(r.mfgDate)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{day(r.expiryDate)}</td>
                  <td className="px-4 py-3 text-right font-mono text-slate-600">{r.rate ?? "—"}</td>
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
