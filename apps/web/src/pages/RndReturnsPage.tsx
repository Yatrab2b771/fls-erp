import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowLeftRight, Lock } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useRndTransfers } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { ReturnToWarehouseForm } from "./RndStorePage";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";

export function RndReturnsPage() {
  const { hasRole } = useAuth();
  const canView = hasRole("RND");
  const { data: transfers, isLoading } = useRndTransfers(undefined, { enabled: canView });

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | "PENDING" | "CONFIRMED">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  if (!canView) {
    return <EmptyState icon={Lock} title="Restricted to R&D" hint="Returns to Warehouse belong to R&D only." accent="slate" />;
  }

  const returns = useMemo(() => (transfers ?? []).filter((t) => t.direction === "TO_WAREHOUSE"), [transfers]);

  const q = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      returns.filter((t) => {
        if (q && !t.itemName.toLowerCase().includes(q)) return false;
        if (status === "PENDING" && t.confirmedAt) return false;
        if (status === "CONFIRMED" && !t.confirmedAt) return false;
        const sentDate = t.sentAt.slice(0, 10);
        if (dateFrom && sentDate < dateFrom) return false;
        if (dateTo && sentDate > dateTo) return false;
        return true;
      }),
    [returns, q, status, dateFrom, dateTo],
  );
  const isFiltered = !!q || !!status || !!dateFrom || !!dateTo;

  const pg = useClientPaging(filtered);

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-slate-500/10 text-slate-600">
          <ArrowLeftRight className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Returns to Warehouse</h1>
          <p className="text-sm text-slate-500">{filtered.length} return(s)</p>
        </div>
      </div>

      <ReturnToWarehouseForm />

      <div className="card flex flex-wrap items-end gap-3 p-4">
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by item…" className="field w-full max-w-sm text-xs" />
        <label className="flex flex-col gap-1 text-micro font-bold uppercase tracking-wide text-slate-500">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as "" | "PENDING" | "CONFIRMED")} className="field text-xs">
            <option value="">All</option>
            <option value="PENDING">Awaiting Warehouse</option>
            <option value="CONFIRMED">Confirmed</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-micro font-bold uppercase tracking-wide text-slate-500">
          Date From
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="field text-xs" />
        </label>
        <label className="flex flex-col gap-1 text-micro font-bold uppercase tracking-wide text-slate-500">
          Date To
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="field text-xs" />
        </label>
        {isFiltered && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => {
              setSearch("");
              setStatus("");
              setDateFrom("");
              setDateTo("");
            }}
          >
            Clear Filters
          </button>
        )}
      </div>

      {isLoading || !transfers ? (
        <div className="skeleton h-64 w-full" />
      ) : filtered.length === 0 ? (
        <EmptyState icon={ArrowLeftRight} title="Nothing here" hint="No returns match this filter." accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Quantity</th>
                <th className="px-4 py-3">Sent</th>
                <th className="px-4 py-3">Confirmed By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((t) => (
                <tr key={t.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">{t.itemName}</td>
                  <td className="px-4 py-3">
                    <span className={`pill ${t.confirmedAt ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
                      {t.confirmedAt ? "Confirmed" : "Awaiting Warehouse"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{t.category}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {t.quantity} {t.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{new Date(t.sentAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-slate-500">{t.confirmedByName ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ClientPager pg={pg} />
        </div>
      )}
    </div>
  );
}
