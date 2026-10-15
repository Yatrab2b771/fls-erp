import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ClipboardList, Download, Eye } from "lucide-react";
import { usePurchaseOrders } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { BD_PLANNING_METRIC_LABEL, getBdPlanningRows, isItemDispatched, isPoDelayed, type BdPlanningMetric, type BdPlanningResult } from "../lib/bdPlanning";
import { exportBdPlanningReport } from "../lib/bdPlanningReports";
import type { PurchaseOrder, PurchaseOrderItem } from "../lib/types";
import { useTileFilters } from "../lib/tileFilters";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { CustomerName } from "../components/CustomerName";

const VALID_METRICS = new Set(Object.keys(BD_PLANNING_METRIC_LABEL));
const NO_TYPE = "No type set";
const typeOf = (item: PurchaseOrderItem) => item.productCategory || NO_TYPE;
const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

// A PO's stage, from its products: Draft / Rejected, else Completed when every live product is dispatched, In progress when some are, else Approved.
function stageOfPo(po: PurchaseOrder): { stage: string; completed: number; total: number } {
  const live = po.items.filter((i) => !i.cancelledAt);
  const completed = live.filter(isItemDispatched).length;
  const stage = po.status === "DRAFT" ? "Draft" : po.status === "REJECTED" ? "Rejected" : live.length > 0 && completed === live.length ? "Completed" : completed > 0 ? "In progress" : "Approved";
  return { stage, completed, total: live.length };
}
const STAGE_TONE: Record<string, string> = {
  Completed: "border-emerald-200 bg-emerald-50 text-emerald-700",
  "In progress": "border-blue-200 bg-blue-50 text-blue-700",
  Rejected: "border-rose-200 bg-rose-50 text-rose-700",
};

function YesNoPill({ yes, warn = false }: { yes: boolean; warn?: boolean }) {
  if (!yes) return <span className="pill border-slate-200 bg-slate-50 text-slate-500">No</span>;
  return <span className={`pill ${warn ? "border-rose-200 bg-rose-50 text-rose-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>Yes</span>;
}

// The drill-down behind every BD dashboard tile — clicking a tile lands
// here with the exact list of purchase orders/products/production runs
// behind that number (see bdPlanning.ts, the shared filter both the tile
// and this page read from), plus a one-click Excel export of that list.
export function BdPlanningDetailPage() {
  const { metric } = useParams<{ metric: string }>();
  const { data: orders, isLoading: ordersLoading } = usePurchaseOrders();

  if (!metric || !VALID_METRICS.has(metric)) {
    return <EmptyState icon={ClipboardList} title="Unknown report" hint="That planning tile doesn't exist." accent="rose" />;
  }
  const m = metric as BdPlanningMetric;
  const label = BD_PLANNING_METRIC_LABEL[m];
  const isLoading = ordersLoading;

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      {isLoading || !orders ? (
        <div className="skeleton h-64 w-full" />
      ) : (
        <BdPlanningTable key={m} metric={m} label={label} orders={orders} />
      )}
    </div>
  );
}

function BdPlanningTable({
  metric,
  label,
  orders,
}: {
  metric: BdPlanningMetric;
  label: string;
  orders: PurchaseOrder[];
}) {
  const full = getBdPlanningRows(metric, orders);
  const filters = useTileFilters();
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const live = (po: PurchaseOrder) => po.items.filter((i) => !i.cancelledAt);

  // "PO number | product" -> its Product Type, so a production row (which only knows PO number and product) can be filtered by type.
  const typeByProduct = new Map<string, string>();
  for (const po of orders) for (const i of live(po)) typeByProduct.set(`${po.poNumber ?? ""}|${i.productName}`, typeOf(i));
  const typeOfRun = (poNumber: string | null, productName: string) => typeByProduct.get(`${poNumber ?? ""}|${productName}`) ?? NO_TYPE;

  const itemOk = (i: PurchaseOrderItem) => (!picked("product").length || picked("product").includes(i.productName)) && (!picked("type").length || picked("type").includes(typeOf(i)));
  const poOk = (po: PurchaseOrder) => {
    const day = (po.orderDate ?? po.createdAt).slice(0, 10);
    return (
      (!picked("po").length || picked("po").includes(po.poNumber ?? "")) &&
      (!picked("customer").length || picked("customer").includes(po.customer.companyName)) &&
      (!picked("stage").length || picked("stage").includes(stageOfPo(po).stage)) &&
      (!picked("status").length || picked("status").includes(po.status)) &&
      (!filters.applied.dateFrom || day >= filters.applied.dateFrom) &&
      (!filters.applied.dateTo || day <= filters.applied.dateTo)
    );
  };
  const productFiltered = picked("product").length > 0 || picked("type").length > 0;

  let result: BdPlanningResult;
  let fields: FilterField[];
  const common = (poNumbers: (string | null)[], customers: string[], products: string[], types: string[]): FilterField[] => [
    { key: "po", label: "PO Number", options: distinct(poNumbers) },
    { key: "customer", label: "Customer", options: distinct(customers) },
    { key: "product", label: "Product", options: distinct(products) },
    { key: "type", label: "Product Type", options: distinct(types) },
  ];
  if (full.kind === "po") {
    result = { kind: "po", rows: full.rows.filter((po) => poOk(po) && (!productFiltered || live(po).some(itemOk))) };
    fields = [
      ...common(full.rows.map((po) => po.poNumber), full.rows.map((po) => po.customer.companyName), full.rows.flatMap((po) => live(po).map((i) => i.productName)), full.rows.flatMap((po) => live(po).map(typeOf))),
      { key: "stage", label: "Stage", options: ["Draft", "Approved", "In progress", "Completed", "Rejected"] },
    ];
  } else if (full.kind === "item") {
    result = { kind: "item", rows: full.rows.filter(({ po, item }) => poOk(po) && itemOk(item)) };
    fields = [
      ...common(full.rows.map((r) => r.po.poNumber), full.rows.map((r) => r.po.customer.companyName), full.rows.map((r) => r.item.productName), full.rows.map((r) => typeOf(r.item))),
      { key: "status", label: "PO Status", options: distinct(full.rows.map((r) => r.po.status)) },
    ];
  } else {
    result = {
      kind: "run",
      rows: full.rows.filter(
        (r) =>
          (!picked("po").length || picked("po").includes(r.poNumber ?? "")) &&
          (!picked("customer").length || picked("customer").includes(r.customerName)) &&
          (!picked("product").length || picked("product").includes(r.productName)) &&
          (!picked("type").length || picked("type").includes(typeOfRun(r.poNumber, r.productName))) &&
          (!picked("stage").length || picked("stage").includes(r.stage)),
      ),
    };
    fields = [
      ...common(full.rows.map((r) => r.poNumber), full.rows.map((r) => r.customerName), full.rows.map((r) => r.productName), full.rows.map((r) => typeOfRun(r.poNumber, r.productName))),
      { key: "stage", label: "Current Stage", options: distinct(full.rows.map((r) => r.stage)) },
    ];
  }
  const isFiltered = filters.activeCount > 0;
  const pg = useClientPaging(result.rows as unknown[]);

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
              {result.rows.length} {result.kind === "po" ? "purchase order(s)" : result.kind === "item" ? "product(s)" : "run(s)"}
              {isFiltered ? ` of ${full.rows.length}` : ""}
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm" onClick={() => exportBdPlanningReport(metric, orders, result, typeOfRun)} disabled={result.rows.length === 0}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Report
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey={`bd-${metric}`} fields={fields} dateLabel="Order date" hideDates={full.kind === "run"} />

      {result.rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title={isFiltered ? "No matches" : "Nothing here"} hint={isFiltered ? "Nothing matches these filters." : "No records match this tile right now."} accent="brand" />
      ) : result.kind === "po" ? (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Order Date</th>
                <th className="px-4 py-3">Expected Delivery</th>
                <th className="px-4 py-3">Products (completed / total)</th>
                <th className="px-4 py-3">Product Types</th>
                {metric === "delayed-pos" && <th className="px-4 py-3">Delayed</th>}
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(pg.rows as typeof result.rows).map((po) => (
                <tr key={po.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">
                    <Link to={`/purchase-orders/${po.id}`} className="hover:text-brand-600 hover:underline">
                      {po.poNumber ?? po.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`pill ${STAGE_TONE[stageOfPo(po).stage] ?? "border-slate-200 bg-slate-50 text-slate-600"}`}>{stageOfPo(po).stage}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-600"><CustomerName name={po.customer.companyName} /></td>
                  <td className="px-4 py-3 text-slate-500">{po.orderDate?.slice(0, 10) ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{po.expectedDeliveryDate?.slice(0, 10) ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {stageOfPo(po).completed} / {stageOfPo(po).total}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{distinct(live(po).map((i) => i.productCategory)).join(", ") || "—"}</td>
                  {metric === "delayed-pos" && (
                    <td className="px-4 py-3">
                      <YesNoPill yes={isPoDelayed(po)} warn />
                    </td>
                  )}
                  <td className="px-4 py-3 text-right">
                    <Link to={`/po-review/${po.id}`} className="btn-ghost btn-sm" title={po.status === "DRAFT" ? "Open the PO form, read it with the uploaded PO, then approve or reject it" : "Open the PO form"}>
                      <Eye className="h-3.5 w-3.5" strokeWidth={2.25} /> View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ClientPager pg={pg} />
        </div>
      ) : result.kind === "item" ? (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">PO Status</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Product Type</th>
                <th className="px-4 py-3">Qty</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(pg.rows as typeof result.rows).map(({ po, item }) => (
                <tr key={item.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">
                    <Link to={`/purchase-orders/${po.id}`} className="hover:text-brand-600 hover:underline">
                      {po.poNumber ?? po.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{po.status}</td>
                  <td className="px-4 py-3 text-slate-600"><CustomerName name={po.customer.companyName} /></td>
                  <td className="px-4 py-3 text-slate-700">{item.productName}</td>
                  <td className="px-4 py-3 text-slate-500">{item.productCategory ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {item.quantity} {item.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ClientPager pg={pg} />
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Current Stage</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Product Type</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(pg.rows as typeof result.rows).map((r) => (
                <tr key={r.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">
                    <Link to={r.to} className="hover:text-brand-600 hover:underline">
                      {r.poNumber ?? "—"}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{r.stage}</td>
                  <td className="px-4 py-3 text-slate-600"><CustomerName name={r.customerName} /></td>
                  <td className="px-4 py-3 text-slate-700">{r.productName}</td>
                  <td className="px-4 py-3 text-slate-500">{typeOfRun(r.poNumber, r.productName) === NO_TYPE ? "—" : typeOfRun(r.poNumber, r.productName)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ClientPager pg={pg} />
        </div>
      )}
    </>
  );
}
