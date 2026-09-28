import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ClipboardCheck, Download, Lock } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useInventoryTransactions } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { exportTransactionReport } from "../lib/inventoryExport";
import { ReceivedCard } from "./InventoryPage";
import type { InventoryReceiptStatus } from "../lib/types";

const STATUS_OPTIONS: { value: InventoryReceiptStatus | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "PENDING_QC", label: "Pending QC" },
  { value: "ON_HOLD", label: "On Hold" },
  { value: "QC_APPROVED", label: "QC Approved" },
  { value: "QC_REJECTED", label: "QC Rejected" },
  { value: "ACCEPTED", label: "Accepted" },
];

// Every Material Received row, filterable and downloadable, reached
// from the Dashboard's "Inward QC" tile (same "tile -> filtered
// drill-down -> Download Report" shape as PPIC's planning tiles). Inward
// QC itself (Approve/Reject/Hold) is RND-only (see inventory.routes.ts's
// PATCH /transactions/:id/qc) — PPIC gets the same page read-only, so
// they can track whether the RM/PM they asked Purchase for has actually
// arrived, without needing the approve/reject authority itself.
export function InwardQcReportPage() {
  const { hasRole } = useAuth();
  const canAct = hasRole("RND");
  const canView = canAct || hasRole("PPIC");
  const { data: transactions, isLoading } = useInventoryTransactions({ type: "RECEIVED" }, { enabled: canView });

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<InventoryReceiptStatus | "">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  if (!canView) {
    return <EmptyState icon={Lock} title="Restricted to R&D / PPIC" hint="Ask R&D or PPIC if you need something here." accent="slate" />;
  }

  const q = search.trim().toLowerCase();
  const rows = (transactions ?? []).filter((t) => {
    if (q && !t.item.name.toLowerCase().includes(q) && !(t.vendorName ?? "").toLowerCase().includes(q)) return false;
    if (status && t.receiptStatus !== status) return false;
    if (dateFrom || dateTo) {
      const d = t.date.slice(0, 10);
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
    }
    return true;
  });
  const isFiltered = !!q || !!status || !!dateFrom || !!dateTo;

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-brand-500/10 text-brand-600">
            <ClipboardCheck className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Inward QC</h1>
            <p className="text-sm text-slate-500">
              {rows.length} row(s)
              {isFiltered ? ` of ${transactions?.length ?? 0}` : ""}
            </p>
          </div>
        </div>
        <button
          className="btn-primary btn-sm"
          onClick={() => exportTransactionReport(rows, "Material Received", "Material_Received")}
          disabled={rows.length === 0}
        >
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Report{isFiltered ? " (Filtered)" : ""}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by Item or Vendor…" className="field w-full max-w-sm text-xs" />
        <label className="flex flex-col gap-1 text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
          QC Status
          <select value={status} onChange={(e) => setStatus(e.target.value as InventoryReceiptStatus | "")} className="field text-xs">
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
          Date From
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="field text-xs" />
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
          Date To
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="field text-xs" />
        </label>
        {(status || dateFrom || dateTo) && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => {
              setStatus("");
              setDateFrom("");
              setDateTo("");
            }}
          >
            Clear Filters
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="Nothing here" hint={isFiltered ? "Nothing matches these filters." : "No Material Received rows yet."} accent="brand" />
      ) : (
        <div className="space-y-3">
          {rows.map((t) => (
            <ReceivedCard key={t.id} txn={t} canQc={canAct} canWrite={false} />
          ))}
        </div>
      )}
    </div>
  );
}
