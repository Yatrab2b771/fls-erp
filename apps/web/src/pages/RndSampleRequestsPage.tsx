import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Inbox, Lock } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useRndSampleRequests } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { RequestSampleForm } from "./RndStorePage";
import type { RndSampleRequestStatus } from "../lib/types";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";

const STATUS_LABEL: Record<RndSampleRequestStatus, string> = {
  PENDING: "Awaiting Warehouse",
  FULFILLED: "Sent",
  REJECTED: "Rejected",
  CANCELLED: "Withdrawn",
};
const STATUS_STYLE: Record<RndSampleRequestStatus, string> = {
  PENDING: "border-amber-200 bg-amber-50 text-amber-700",
  FULFILLED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  REJECTED: "border-rose-200 bg-rose-50 text-rose-700",
  CANCELLED: "border-slate-200 bg-slate-100 text-slate-600",
};

export function RndSampleRequestsPage() {
  const { hasRole } = useAuth();
  const canView = hasRole("RND");
  const { data: requests, isLoading } = useRndSampleRequests(undefined, { enabled: canView });

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<RndSampleRequestStatus | "">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  if (!canView) {
    return <EmptyState icon={Lock} title="Restricted to R&D" hint="Sample requests belong to R&D only." accent="slate" />;
  }

  const q = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (requests ?? []).filter((r) => {
        if (q && !r.itemName.toLowerCase().includes(q)) return false;
        if (status && r.status !== status) return false;
        const requestedDate = r.requestedAt.slice(0, 10);
        if (dateFrom && requestedDate < dateFrom) return false;
        if (dateTo && requestedDate > dateTo) return false;
        return true;
      }),
    [requests, q, status, dateFrom, dateTo],
  );
  const isFiltered = !!q || !!status || !!dateFrom || !!dateTo;

  const pg = useClientPaging(filtered);

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-brand-500/10 text-brand-600">
          <Inbox className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Sample Requests</h1>
          <p className="text-sm text-slate-500">{filtered.length} request(s)</p>
        </div>
      </div>

      <RequestSampleForm />

      <div className="card flex flex-wrap items-end gap-3 p-4">
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by item…" className="field w-full max-w-sm text-xs" />
        <label className="flex flex-col gap-1 text-micro font-bold uppercase tracking-wide text-slate-500">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as RndSampleRequestStatus | "")} className="field text-xs">
            <option value="">All</option>
            <option value="PENDING">Awaiting Warehouse</option>
            <option value="FULFILLED">Sent</option>
            <option value="REJECTED">Rejected</option>
            <option value="CANCELLED">Withdrawn</option>
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

      {isLoading || !requests ? (
        <div className="skeleton h-64 w-full" />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Inbox} title="Nothing here" hint="No sample requests match this filter." accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Quantity</th>
                <th className="px-4 py-3">Requested</th>
                <th className="px-4 py-3">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((r) => (
                <tr key={r.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">{r.itemName}</td>
                  <td className="px-4 py-3">
                    <span className={`pill ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{r.category}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {r.quantity} {r.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{new Date(r.requestedAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-slate-500">{r.status === "REJECTED" && r.rejectionReason ? r.rejectionReason : r.note ?? "—"}</td>
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
