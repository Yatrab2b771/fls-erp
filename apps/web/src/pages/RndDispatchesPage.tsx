import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Lock, Truck } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useRndStoreTransactions } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { DispatchToCustomerForm } from "./RndStorePage";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { CustomerName } from "../components/CustomerName";

export function RndDispatchesPage() {
  const { hasRole } = useAuth();
  const canView = hasRole("RND");
  const { data: transactions, isLoading } = useRndStoreTransactions({ enabled: canView });

  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  if (!canView) {
    return <EmptyState icon={Lock} title="Restricted to R&D" hint="Customer dispatches belong to R&D only." accent="slate" />;
  }

  const dispatches = useMemo(() => (transactions ?? []).filter((t) => t.type === "DISPATCHED"), [transactions]);

  const q = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      dispatches.filter((t) => {
        if (q && !t.itemName.toLowerCase().includes(q) && !(t.customerName ?? "").toLowerCase().includes(q)) return false;
        const txnDate = (t.date ?? t.createdAt).slice(0, 10);
        if (dateFrom && txnDate < dateFrom) return false;
        if (dateTo && txnDate > dateTo) return false;
        return true;
      }),
    [dispatches, q, dateFrom, dateTo],
  );
  const isFiltered = !!q || !!dateFrom || !!dateTo;

  const pg = useClientPaging(filtered);

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-violet-500/10 text-violet-600">
          <Truck className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Dispatch to Customer</h1>
          <p className="text-sm text-slate-500">{filtered.length} dispatch(es)</p>
        </div>
      </div>

      <DispatchToCustomerForm />

      <div className="card flex flex-wrap items-end gap-3 p-4">
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by item or customer…" className="field w-full max-w-sm text-xs" />
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
              setDateFrom("");
              setDateTo("");
            }}
          >
            Clear Filters
          </button>
        )}
      </div>

      {isLoading || !transactions ? (
        <div className="skeleton h-64 w-full" />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Truck} title="Nothing here" hint="No dispatches match this filter." accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Quantity</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Brand</th>
                <th className="px-4 py-3">Courier</th>
                <th className="px-4 py-3">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((t) => (
                <tr key={t.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">{t.itemName}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {t.quantity} {t.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-500"><CustomerName name={t.customerName} /></td>
                  <td className="px-4 py-3 text-slate-500">{t.brandName ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{t.courierDetails ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{new Date(t.date ?? t.createdAt).toLocaleDateString()}</td>
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
