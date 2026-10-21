import { fmtQty } from "../lib/format";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownToLine, ArrowLeft, Download, PackageOpen, Send } from "lucide-react";
import { ApiError, api, apiAll } from "../lib/api";
import { usePagedList } from "../lib/usePagedList";
import { appendParams, useTileFilters } from "../lib/tileFilters";
import { exportMyStoreReport, type MyStoreRow } from "../lib/inventoryExport";
import { useMyStoreInfo } from "../lib/hooks";
import { Pagination } from "../components/Pagination";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import type { OptionPage } from "../components/MultiSelectDropdown";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";

const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

const COPY = {
  received: {
    title: "Stock Received",
    icon: ArrowDownToLine,
    dateLabel: "Received",
    by: "Issued By (Warehouse)",
    empty: "Material shows here once the Warehouse issues it to your store.",
  },
  "issued-to-plant": {
    title: "Stock Issued to Plant",
    icon: Send,
    dateLabel: "Issued",
    by: "Issued By",
    empty: "Issues show here once your store sends material to its Plant.",
  },
} as const;

// A Day Store login's own movements - what the Warehouse issued into its store, or what the store issued
// on to its own Plant. A login that is not limited to a store (Warehouse seat, Admin) sees every Day Store.
export function MyStoreMovementsPage({ kind }: { kind: "received" | "issued-to-plant" }) {
  const copy = COPY[kind];
  const Icon = copy.icon;
  const BASE = `/api/inventory/my-store/${kind}`;
  const toast = useToast();
  const { data: info } = useMyStoreInfo();
  const tileFilters = useTileFilters();
  const [exporting, setExporting] = useState(false);
  const paged = usePagedList<MyStoreRow>({ key: ["inventory", "my-store", kind, "list"], path: BASE, params: tileFilters.params, noSearch: true });
  const isFiltered = tileFilters.activeCount > 0;
  const storeNames = (info?.stores ?? []).map((s) => s.name).join(", ");

  const serverList = (key: string, label: string): FilterField => ({
    key,
    label,
    load: (q) => api<OptionPage>(`${BASE}/options?field=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });
  const fields: FilterField[] = [
    ...(info?.scoped && info.stores.length === 1 ? [] : [serverList("store", "Day Store")]),
    { key: "category", label: "Category", options: ["RM", "PM"] },
    serverList("item", "Item"),
    { key: "status", label: "Status", options: ["Delivered", "In Transit"] },
    serverList("batchNo", "Batch No"),
    serverList("grnNo", "GRN No"),
  ];

  async function exportAll() {
    setExporting(true);
    try {
      const qs = appendParams(new URLSearchParams(), tileFilters.params);
      exportMyStoreReport(kind, await apiAll<MyStoreRow>(`${BASE}${qs.toString() ? `?${qs}` : ""}`));
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
          <div className="stat-icon bg-violet-500/10 text-violet-600">
            <Icon className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{copy.title}</h1>
            <p className="text-sm text-slate-500">
              {paged.total.toLocaleString()} {paged.total === 1 ? "entry" : "entries"}
              {isFiltered ? " match" : ""} {kind === "received" ? `received from the Warehouse into ${storeNames || "your store"}` : `issued from ${storeNames || "your store"} to its Plant`}
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm shrink-0" disabled={paged.total === 0 || exporting} onClick={exportAll}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> {exporting ? "Preparing…" : `Download Report${isFiltered ? " (Filtered)" : ""}`}
        </button>
      </div>

      <TileFilterBar filters={tileFilters} tileKey={`my-store-${kind}`} fields={fields} dateLabel={copy.dateLabel} />

      {paged.isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : paged.total === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "Nothing yet"} hint={isFiltered ? "Nothing matches these filters." : copy.empty} accent="brand" />
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
                <th className="px-4 py-3">Day Store</th>
                {kind === "issued-to-plant" && <th className="px-4 py-3">Plant</th>}
                <th className="px-4 py-3">Batch No</th>
                <th className="px-4 py-3">GRN No</th>
                <th className="px-4 py-3">Against</th>
                <th className="px-4 py-3">{copy.by}</th>
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
                  <td className="px-4 py-3 text-slate-700">{r.storeName ?? "—"}</td>
                  {kind === "issued-to-plant" && <td className="px-4 py-3 text-slate-700">{r.plantName ?? "—"}</td>}
                  <td className="px-4 py-3 text-slate-600">{r.batchNo ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{r.grnNo ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{r.viaRequest ? "Material Request" : "Direct"}</td>
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
