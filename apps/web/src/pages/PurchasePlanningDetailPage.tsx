import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ClipboardList, Download } from "lucide-react";
import { usePreInventoryRequirements } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { exportRequirementsReport } from "../lib/inventoryExport";
import { getPurchasePlanningRows, PURCHASE_PLANNING_METRIC_LABEL, REQUIREMENT_STATUS_LABEL, requirementStatus, type PurchasePlanningMetric } from "../lib/purchasePlanning";

const VALID_METRICS = new Set(Object.keys(PURCHASE_PLANNING_METRIC_LABEL));

const STATUS_PILL_CLASS: Record<string, string> = {
  COVERED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  SHORTFALL: "border-amber-200 bg-amber-50 text-amber-700",
  ORDERED: "border-brand-200 bg-brand-50 text-brand-700",
};

// The drill-down behind every Purchase dashboard tile — clicking a tile
// lands here with the exact list of Pre-Inventory requirements behind
// that number (see purchasePlanning.ts, the shared filter both the tile
// and this page read from), plus a one-click Excel export reusing
// PreInventoryPage's own exportRequirementsReport.
export function PurchasePlanningDetailPage() {
  const { metric } = useParams<{ metric: string }>();
  const { data: requirements, isLoading } = usePreInventoryRequirements();

  if (!metric || !VALID_METRICS.has(metric)) {
    return <EmptyState icon={ClipboardList} title="Unknown report" hint="That planning tile doesn't exist." accent="rose" />;
  }
  const m = metric as PurchasePlanningMetric;
  const label = PURCHASE_PLANNING_METRIC_LABEL[m];

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      {isLoading || !requirements ? (
        <div className="skeleton h-64 w-full" />
      ) : (
        <PurchasePlanningTable metric={m} label={label} requirements={requirements} />
      )}
    </div>
  );
}

function PurchasePlanningTable({
  metric,
  label,
  requirements,
}: {
  metric: PurchasePlanningMetric;
  label: string;
  requirements: NonNullable<ReturnType<typeof usePreInventoryRequirements>["data"]>;
}) {
  const rows = getPurchasePlanningRows(metric, requirements);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-brand-500/10 text-brand-600">
            <ClipboardList className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{label}</h1>
            <p className="text-sm text-slate-500">{rows.length} requirement(s)</p>
          </div>
        </div>
        <button className="btn-primary btn-sm" onClick={() => exportRequirementsReport(rows)} disabled={rows.length === 0}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Report
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title="Nothing here" hint="No records match this tile right now." accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Required</th>
                <th className="px-4 py-3">On Hand</th>
                <th className="px-4 py-3">Short By</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">PO / Vendor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                const status = requirementStatus(r);
                return (
                  <tr key={r.id} className="transition hover:bg-slate-50">
                    <td className="px-4 py-3 font-bold text-slate-700">{r.item.name}</td>
                    <td className="px-4 py-3 text-slate-500">{r.category === "RM" ? "Raw Material" : "Packaging Material"}</td>
                    <td className="px-4 py-3 text-slate-500">
                      {r.requiredQty} {r.unit}
                    </td>
                    <td className="px-4 py-3 text-slate-500">{r.currentStock}</td>
                    <td className="px-4 py-3 text-slate-500">{r.shortQty > 0 ? r.shortQty : "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`pill ${STATUS_PILL_CLASS[status]}`}>{REQUIREMENT_STATUS_LABEL[status]}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{r.poNumber ? `${r.poNumber} · ${r.vendorName ?? "—"}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
