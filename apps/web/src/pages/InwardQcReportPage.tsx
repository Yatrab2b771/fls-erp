import { materialKindName } from "../lib/materialKind";
import { Link } from "react-router-dom";
import { ArrowLeft, ClipboardCheck, Download, Lock } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useInventoryTransactions } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { exportTransactionReport } from "../lib/inventoryExport";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { agingDays, inAgingBuckets } from "../components/AgingCell";
import { ReceivedTable, vendorPoOf } from "../components/ReceivedTable";
import { useTileFilters } from "../lib/tileFilters";
import { ReceivedCard } from "./InventoryPage";
import type { InventoryReceiptStatus, InventoryTransaction } from "../lib/types";

// Only deliveries still waiting for R&D's decision are listed: not sampled yet, being tested, or on hold. Approved (accepted into stock) and
// rejected ones are done; they are in Stock Received and Quarantine.
const STATUS_OPTIONS: { value: InventoryReceiptStatus; label: string; pill: string }[] = [
  { value: "PENDING_QC", label: "Pending QC", pill: "border-slate-200 bg-slate-50 text-slate-600" },
  { value: "TESTING", label: "Testing", pill: "border-violet-200 bg-violet-50 text-violet-700" },
  { value: "ON_HOLD", label: "On Hold", pill: "border-amber-200 bg-amber-50 text-amber-700" },
];
const poOf = vendorPoOf;

// Every Material Received row in one table, filterable and downloadable, reached from the Dashboard's "Inward QC" tile. Each row has its
// Vendor PO number (so it can be read PO-wise); "Open" shows the full card under it, with the QC actions for R&D. Inward QC itself
// (Approve/Reject/Hold) is RND-only (see inventory.routes.ts's PATCH /transactions/:id/qc); PPIC gets the same page read-only.
export function InwardQcReportPage() {
  const { hasRole } = useAuth();
  const canAct = hasRole("RND");
  const canView = canAct || hasRole("PPIC");
  const { data: all, isLoading } = useInventoryTransactions({ type: "RECEIVED" }, { enabled: canView });
  const transactions = (all ?? []).filter((t) => STATUS_OPTIONS.some((o) => o.value === t.receiptStatus));
  const tileFilters = useTileFilters();

  const { applied } = tileFilters;
  const picked = (key: string) => applied.picks[key] ?? [];
  const statusPicks = STATUS_OPTIONS.filter((o) => picked("status").includes(o.label)).map((o) => o.value);
  const distinct = (pick: (t: InventoryTransaction) => string | null | undefined) => [...new Set((transactions ?? []).map(pick).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const filterFields: FilterField[] = [
    { key: "po", label: "Vendor PO", options: distinct(poOf) },
    { key: "item", label: "Item", options: distinct((t) => t.item.name) },
    { key: "type", label: "Material", options: ["Raw Material", "Packaging Material"] },
    { key: "vendor", label: "Vendor", options: distinct((t) => t.vendorName) },
    { key: "status", label: "QC Status", options: STATUS_OPTIONS.map((o) => o.label) },
    AGING_FIELD,
  ];
  // PO-wise: grouped by Vendor PO, then newest first
  const rows = (transactions ?? [])
    .filter((t) => {
      if (picked("po").length && !picked("po").includes(poOf(t) ?? "")) return false;
      if (picked("item").length && !picked("item").includes(t.item.name)) return false;
      if (picked("type").length && !picked("type").includes(materialKindName(t.item.category))) return false;
      if (picked("vendor").length && !picked("vendor").includes(t.vendorName ?? "")) return false;
      if (statusPicks.length && !statusPicks.includes(t.receiptStatus as InventoryReceiptStatus)) return false;
      if (!inAgingBuckets(agingDays(t.date), picked("aging"))) return false;
      const d = t.date.slice(0, 10);
      if (applied.dateFrom && d < applied.dateFrom) return false;
      if (applied.dateTo && d > applied.dateTo) return false;
      return true;
    })
    .sort((a, b) => (poOf(a) ?? "~").localeCompare(poOf(b) ?? "~") || b.date.localeCompare(a.date));
  const isFiltered = tileFilters.activeCount > 0;

  if (!canView) {
    return <EmptyState icon={Lock} title="Restricted to R&D / PPIC" hint="Ask R&D or PPIC if you need something here." accent="slate" />;
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-brand-500/10 text-brand-600">
            <ClipboardCheck className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Inward QC</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} row(s)
              {isFiltered ? ` of ${(transactions ?? []).length.toLocaleString()}` : ""}
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm shrink-0" onClick={() => exportTransactionReport(rows, "Material Received", "Material_Received")} disabled={rows.length === 0}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Report{isFiltered ? " (Filtered)" : ""}
        </button>
      </div>

      <TileFilterBar filters={tileFilters} tileKey="inward-qc" fields={filterFields} dateLabel="Received" />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="Nothing here" hint={isFiltered ? "Nothing matches these filters." : "Nothing is waiting for Inward QC."} accent="brand" />
      ) : (
        <ReceivedTable rows={rows} showPo showAging openLabel={canAct ? "Open / QC" : "Open"} renderExpanded={(t) => <ReceivedCard txn={t} canQc={canAct} canWrite={false} />} />
      )}
    </div>
  );
}
