import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ClipboardList, Download } from "lucide-react";
import { usePurchaseOrders } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { getPpicPlanningRows, hasCalculatedBom, hasCalculatedRm, PPIC_PLANNING_METRIC_LABEL, type PpicPlanningMetric } from "../lib/ppicPlanning";
import { exportPpicPlanningReport } from "../lib/ppicPlanningReports";

const VALID_METRICS = new Set(Object.keys(PPIC_PLANNING_METRIC_LABEL));

function YesNoPill({ yes }: { yes: boolean }) {
  return yes ? (
    <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Yes</span>
  ) : (
    <span className="pill border-slate-200 bg-slate-50 text-slate-500">No</span>
  );
}

// The drill-down behind every PPIC planning dashboard tile — clicking a
// tile lands here with the exact list of purchase orders/products behind
// that number (see ppicPlanning.ts, the shared filter both the tile and
// this page read from), plus a one-click Excel export of that same list.
export function PpicPlanningDetailPage() {
  const { metric } = useParams<{ metric: string }>();
  const { data: orders, isLoading } = usePurchaseOrders();

  if (!metric || !VALID_METRICS.has(metric)) {
    return <EmptyState icon={ClipboardList} title="Unknown report" hint="That planning tile doesn't exist." accent="rose" />;
  }
  const m = metric as PpicPlanningMetric;
  const label = PPIC_PLANNING_METRIC_LABEL[m];

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      {isLoading || !orders ? (
        <div className="skeleton h-64 w-full" />
      ) : (
        <PpicPlanningTable metric={m} label={label} orders={orders} />
      )}
    </div>
  );
}

function PpicPlanningTable({ metric, label, orders }: { metric: PpicPlanningMetric; label: string; orders: NonNullable<ReturnType<typeof usePurchaseOrders>["data"]> }) {
  const result = getPpicPlanningRows(metric, orders);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-brand-500/10 text-brand-600">
            <ClipboardList className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{label}</h1>
            <p className="text-sm text-slate-500">
              {result.rows.length} {result.kind === "po" ? "purchase order(s)" : "product(s)"}
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm" onClick={() => exportPpicPlanningReport(metric, orders)} disabled={result.rows.length === 0}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Report
        </button>
      </div>

      {result.rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title="Nothing here" hint="No records match this tile right now." accent="brand" />
      ) : result.kind === "po" ? (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Order Date</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Products</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map((po) => (
                <tr key={po.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">
                    <Link to={`/purchase-orders/${po.id}`} className="hover:text-brand-600 hover:underline">
                      {po.poNumber ?? po.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{po.customer.companyName}</td>
                  <td className="px-4 py-3 text-slate-500">{po.orderDate?.slice(0, 10) ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{po.status}</td>
                  <td className="px-4 py-3 text-slate-500">{po.items.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Qty</th>
                <th className="px-4 py-3">Packaging BOM</th>
                <th className="px-4 py-3">RM BOM</th>
                <th className="px-4 py-3">Plan Sent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map(({ po, item }) => (
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
                  <td className="px-4 py-3">
                    <YesNoPill yes={hasCalculatedBom(item)} />
                  </td>
                  <td className="px-4 py-3">
                    <YesNoPill yes={hasCalculatedRm(item)} />
                  </td>
                  <td className="px-4 py-3">
                    <YesNoPill yes={!!item.planSentToProductionAt} />
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
