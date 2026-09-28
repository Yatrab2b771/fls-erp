import { useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, Download, FlaskConical, Lock } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useCombinedLots, useAllProductionBatches } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import type { CombinedLot } from "../lib/types";

type CoaStatus = "Not Started" | "Analyzed" | "Reviewed" | "Approved";

function coaStatus(lot: CombinedLot): CoaStatus {
  if (lot.coaApprovedAt) return "Approved";
  if (lot.coaReviewedAt) return "Reviewed";
  if (lot.coaAnalyzedAt) return "Analyzed";
  return "Not Started";
}

const COA_PILL_CLASS: Record<CoaStatus, string> = {
  "Not Started": "border-slate-200 bg-slate-50 text-slate-500",
  Analyzed: "border-amber-200 bg-amber-50 text-amber-700",
  Reviewed: "border-blue-200 bg-blue-50 text-blue-700",
  Approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

interface Row {
  key: string;
  to: string;
  kind: "Combined Lot" | "Production Batch";
  productName: string;
  customerName: string;
  batchNo: string | null;
  coa: CoaStatus | null; // null — ProductionBatch has no COA of its own, only the pooled CombinedLot does
}

function toDownloadRows(rows: Row[]) {
  return rows.map((r) => ({
    Type: r.kind,
    Product: r.productName,
    Customer: r.customerName,
    "Batch No": r.batchNo ?? "",
    "COA Status": r.coa ?? "N/A (Production Batch)",
  }));
}

// R&D's own Bulk QC / COA report — every CombinedLot and ProductionBatch
// currently sitting at the BULK_QC stage, filterable and downloadable,
// reached from the Dashboard's "Bulk QC / COA Pending" tile (same "tile
// -> filtered drill-down -> Download Report" shape as PPIC's planning
// tiles and the Inward QC report). Bulk QC is RND-only now (see
// combined-lot-stage.ts's COMBINED_LOT_STAGE_ROLE) — this page is gated
// the same way.
export function BulkQcReportPage() {
  const { hasRole } = useAuth();
  const canView = hasRole("RND");
  const { data: lots, isLoading: lotsLoading } = useCombinedLots();
  const { data: batches, isLoading: batchesLoading } = useAllProductionBatches();

  const [search, setSearch] = useState("");
  const [coaFilter, setCoaFilter] = useState<CoaStatus | "">("");

  if (!canView) {
    return <EmptyState icon={Lock} title="Restricted to R&D" hint="Bulk QC / COA belongs to R&D — ask them if you need something here." accent="slate" />;
  }

  const isLoading = lotsLoading || batchesLoading;
  const allRows: Row[] = [
    ...(lots ?? [])
      .filter((l) => l.currentStageId === "BULK_QC")
      .map((l) => ({
        key: `lot-${l.id}`,
        to: `/combined-lots/${l.id}`,
        kind: "Combined Lot" as const,
        productName: l.preProduction.purchaseOrderItem.productName,
        customerName: l.preProduction.purchaseOrderItem.purchaseOrder.customer.companyName,
        batchNo: null,
        coa: coaStatus(l),
      })),
    ...(batches ?? [])
      .filter((b) => b.currentStageId === "BULK_QC")
      .map((b) => ({
        key: `batch-${b.id}`,
        to: `/production-batches/${b.id}`,
        kind: "Production Batch" as const,
        productName: b.preProduction.purchaseOrderItem.productName,
        customerName: b.preProduction.purchaseOrderItem.purchaseOrder.customer.companyName,
        batchNo: b.batchNo,
        coa: null,
      })),
  ];

  const q = search.trim().toLowerCase();
  const rows = allRows.filter((r) => {
    if (q && !r.productName.toLowerCase().includes(q) && !r.customerName.toLowerCase().includes(q) && !(r.batchNo ?? "").toLowerCase().includes(q)) return false;
    if (coaFilter && r.coa !== coaFilter) return false;
    return true;
  });
  const isFiltered = !!q || !!coaFilter;

  function handleDownload() {
    const sheet = XLSX.utils.json_to_sheet(toDownloadRows(rows));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Bulk QC");
    XLSX.writeFile(workbook, `FLS_Bulk_QC_COA_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-brand-500/10 text-brand-600">
            <FlaskConical className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Bulk QC / COA</h1>
            <p className="text-sm text-slate-500">
              {rows.length} row(s)
              {isFiltered ? ` of ${allRows.length}` : ""}
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm" onClick={handleDownload} disabled={rows.length === 0}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Report{isFiltered ? " (Filtered)" : ""}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by Product, Customer or Batch No…" className="field w-full max-w-sm text-xs" />
        <label className="flex flex-col gap-1 text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
          COA Status
          <select value={coaFilter} onChange={(e) => setCoaFilter(e.target.value as CoaStatus | "")} className="field text-xs">
            <option value="">All</option>
            <option value="Not Started">Not Started</option>
            <option value="Analyzed">Analyzed</option>
            <option value="Reviewed">Reviewed</option>
            <option value="Approved">Approved</option>
          </select>
        </label>
        {coaFilter && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => setCoaFilter("")}>
            Clear Filter
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={FlaskConical} title="Nothing here" hint={isFiltered ? "Nothing matches these filters." : "No Combined Lots or Production Batches at Bulk QC right now."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Batch No</th>
                <th className="px-4 py-3">COA Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.key} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-500">{r.kind}</td>
                  <td className="px-4 py-3 font-bold text-slate-700">
                    <Link to={r.to} className="hover:text-brand-600 hover:underline">
                      {r.productName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{r.customerName}</td>
                  <td className="px-4 py-3 text-slate-500">{r.batchNo ?? "—"}</td>
                  <td className="px-4 py-3">{r.coa ? <span className={`pill ${COA_PILL_CLASS[r.coa]}`}>{r.coa}</span> : <span className="text-slate-400">N/A</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
