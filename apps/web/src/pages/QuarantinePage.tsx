import { fmtQty } from "../lib/format";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, Download, PackageOpen, ShieldAlert } from "lucide-react";
import { ApiError, api, apiAll } from "../lib/api";
import { usePagedList } from "../lib/usePagedList";
import { appendParams, useTileFilters } from "../lib/tileFilters";
import { exportQuarantineReport, type QuarantineListRow } from "../lib/inventoryExport";
import { useAuth } from "../lib/auth";
import { useReleaseExpiry } from "../lib/hooks";
import { Pagination } from "../components/Pagination";
import { AgingCell } from "../components/AgingCell";
import { TileFilterBar, AGING_FIELD, type FilterField } from "../components/TileFilterBar";
import type { OptionPage } from "../components/MultiSelectDropdown";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";

const BASE = "/api/inventory/quarantine-list";
const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };

const serverList = (key: string, label: string): FilterField => ({
  key,
  label,
  load: (q) => api<OptionPage>(`${BASE}/options?field=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
});
const FIELDS: FilterField[] = [
  { key: "reason", label: "Hold Reason", options: ["Awaiting QC", "Testing", "On Hold", "Lab Test"] },
  { key: "category", label: "Category", options: ["RM", "PM"] },
  serverList("item", "Item"),
  serverList("vendor", "Vendor"),
  serverList("invoiceNo", "Invoice No"),
  serverList("grnNo", "GRN No"),
  serverList("batchNo", "Batch No"),
  { key: "unit", label: "Unit", options: ["Kg", "Ltr", "Count"] },
  AGING_FIELD,
];

const REASON_STYLE: Record<string, string> = {
  "Awaiting QC": "border-amber-200 bg-amber-50 text-amber-700",
  Testing: "border-sky-200 bg-sky-50 text-sky-700",
  "On Hold": "border-orange-200 bg-orange-50 text-orange-700",
  "Lab Test": "border-rose-200 bg-rose-50 text-rose-700",
};

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

// Everything held back from stock: waiting for its first inward QC, put on hold by QC, or past its
// expiry and sent for a lab test. A Lab Test entry is released back into stock by QA/QC from here;
// the QC decision on the other two is taken in Inventory -> Quarantine Store.
export function QuarantinePage() {
  const toast = useToast();
  const { hasRole } = useAuth();
  const canRelease = hasRole("QA_QC") || hasRole("RND");
  const release = useReleaseExpiry();
  const tileFilters = useTileFilters();
  const [exporting, setExporting] = useState(false);

  const params = tileFilters.params;
  const paged = usePagedList<QuarantineListRow>({ key: ["inventory", "quarantine-list", "list"], path: BASE, params, noSearch: true });
  const isFiltered = tileFilters.activeCount > 0;

  async function exportAll() {
    setExporting(true);
    try {
      const qs = appendParams(new URLSearchParams(), params);
      exportQuarantineReport(await apiAll<QuarantineListRow>(`${BASE}${qs.toString() ? `?${qs}` : ""}`));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not build the report");
    } finally {
      setExporting(false);
    }
  }

  async function handleRelease(row: QuarantineListRow) {
    try {
      await release.mutateAsync(row.id);
      toast.success(`${row.itemName} released back into stock.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not release this entry");
    }
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-amber-500/10 text-amber-600">
            <ShieldAlert className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Quarantine Stock</h1>
            <p className="text-sm text-slate-500">
              {paged.total.toLocaleString()} entr{paged.total === 1 ? "y" : "ies"}
              {isFiltered ? " match" : " held"} — awaiting QC, on hold, or sent for a lab test
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm" disabled={paged.total === 0 || exporting} onClick={exportAll}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> {exporting ? "Preparing…" : `Download Report${isFiltered ? " (Filtered)" : ""}`}
        </button>
      </div>

      <TileFilterBar filters={tileFilters} tileKey="quarantine" fields={FIELDS} dateLabel="Received" />

      {paged.isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : paged.total === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "Nothing in quarantine"} hint={isFiltered ? "Nothing matches these filters." : "Nothing is awaiting QC, on hold, or waiting for a lab test."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Hold Reason</th>
                <th className="px-4 py-3">Received</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">Quantity</th>
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Invoice No</th>
                <th className="px-4 py-3">GRN No</th>
                <th className="px-4 py-3">Batch No</th>
                <th className="px-4 py-3">Mfg Date</th>
                <th className="px-4 py-3">Expiry Date</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.rows.map((r) => (
                <tr key={r.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <span className={`pill whitespace-nowrap ${REASON_STYLE[r.reason] ?? ""}`}>{r.reason}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{day(r.date)}</td>
                  <td className="px-4 py-3 font-bold text-slate-700">{r.itemName}</td>
                  <td className="px-4 py-3 text-slate-500">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-mono font-bold text-slate-900">
                    {fmtQty(r.quantity)} {r.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{r.vendorName ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{r.invoiceNo ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{r.grnNo ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{r.batchNo ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{day(r.mfgDate)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{day(r.expiryDate)}</td>
                  <td className="px-4 py-3">
                    <AgingCell since={r.sinceAt} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {r.reason === "Lab Test" ? (
                      canRelease && (
                        <button type="button" className="btn-primary btn-sm" disabled={release.isPending} onClick={() => handleRelease(r)}>
                          <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> Release to Stock
                        </button>
                      )
                    ) : (
                      <Link to="/inventory" className="text-tiny font-bold text-brand-600 hover:underline" title="The QC decision is taken in Inventory → Quarantine Store">
                        Review in Inventory
                      </Link>
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
