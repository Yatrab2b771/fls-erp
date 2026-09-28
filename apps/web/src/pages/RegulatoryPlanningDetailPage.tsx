import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ClipboardList, Download } from "lucide-react";
import { usePurchaseOrders } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { getRegulatoryPlanningRows, REGULATORY_PLANNING_METRIC_LABEL, type RegulatoryPlanningMetric } from "../lib/regulatoryPlanning";
import { exportRegulatoryPlanningReport } from "../lib/regulatoryPlanningReports";

const VALID_METRICS = new Set(Object.keys(REGULATORY_PLANNING_METRIC_LABEL));

const STATUS_PILL_CLASS: Record<string, string> = {
  Approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
  "Not Approved": "border-rose-200 bg-rose-50 text-rose-700",
};

// The drill-down behind every Regulatory dashboard tile — clicking a
// tile lands here with the exact list of product lines behind that
// number (see regulatoryPlanning.ts, the shared filter both the tile and
// this page read from), plus a one-click Excel export.
export function RegulatoryPlanningDetailPage() {
  const { metric } = useParams<{ metric: string }>();
  const { data: orders, isLoading } = usePurchaseOrders();

  if (!metric || !VALID_METRICS.has(metric)) {
    return <EmptyState icon={ClipboardList} title="Unknown report" hint="That planning tile doesn't exist." accent="rose" />;
  }
  const m = metric as RegulatoryPlanningMetric;
  const label = REGULATORY_PLANNING_METRIC_LABEL[m];

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      {isLoading || !orders ? (
        <div className="skeleton h-64 w-full" />
      ) : (
        <RegulatoryPlanningTable metric={m} label={label} orders={orders} />
      )}
    </div>
  );
}

function RegulatoryPlanningTable({ metric, label, orders }: { metric: RegulatoryPlanningMetric; label: string; orders: NonNullable<ReturnType<typeof usePurchaseOrders>["data"]> }) {
  const rows = getRegulatoryPlanningRows(metric, orders);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-indigo-500/10 text-indigo-600">
            <ClipboardList className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{label}</h1>
            <p className="text-sm text-slate-500">{rows.length} product(s)</p>
          </div>
        </div>
        <button className="btn-primary btn-sm" onClick={() => exportRegulatoryPlanningReport(metric, orders)} disabled={rows.length === 0}>
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
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Qty</th>
                <th className="px-4 py-3">Regulatory Body</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ po, item }) => (
                <tr key={item.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">
                    <Link to={`/purchase-orders/${po.id}`} className="hover:text-brand-600 hover:underline">
                      {po.poNumber ?? po.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{po.customer.companyName}</td>
                  <td className="px-4 py-3 text-slate-700">{item.productName}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {item.quantity} {item.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{po.regulatoryBody ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`pill ${STATUS_PILL_CLASS[item.regulatoryStatus ?? ""] ?? "border-slate-200 bg-slate-50 text-slate-500"}`}>{item.regulatoryStatus ?? "Pending Review"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
