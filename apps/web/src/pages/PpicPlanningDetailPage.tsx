import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ClipboardList, Download } from "lucide-react";
import { usePurchaseOrders, usePreProductions, useAllProductionBatches, usePendingPoMaterials } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import {
  filterPpicPlanningResult,
  getItemStage,
  getPoAgingDays,
  getPpicPlanningRows,
  hasCalculatedBom,
  hasCalculatedRm,
  PPIC_PLANNING_METRIC_LABEL,
  type PpicPlanningItemRow,
  type PpicPlanningMetric,
} from "../lib/ppicPlanning";
import { exportPpicPlanningReport } from "../lib/ppicPlanningReports";
import type { PendingPoMaterialRow } from "../lib/types";

const VALID_METRICS = new Set(Object.keys(PPIC_PLANNING_METRIC_LABEL));

function YesNoPill({ yes }: { yes: boolean }) {
  return yes ? (
    <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Yes</span>
  ) : (
    <span className="pill border-slate-200 bg-slate-50 text-slate-500">No</span>
  );
}

// One material's Complete/Short line, inside a product's RM or PM cell.
function MaterialLine({ name, requiredQty, unit, onHand, short, shortfallQty }: { name: string; requiredQty: number; unit: string; onHand: number | null; short: boolean; shortfallQty: number }) {
  return (
    <div className="flex items-center justify-between gap-2 whitespace-nowrap">
      <span className={short ? "font-semibold text-rose-700" : "text-slate-600"}>
        {name} <span className="text-slate-400">({requiredQty} {unit})</span>
      </span>
      {onHand === null ? (
        <span className="pill border-slate-200 bg-slate-50 text-slate-400" title="No matching catalog item — can't check stock">Not in Catalog</span>
      ) : short ? (
        <span className="pill border-rose-200 bg-rose-50 text-rose-700">Short {shortfallQty} {unit}</span>
      ) : (
        <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Complete</span>
      )}
    </div>
  );
}

// The drill-down behind every PPIC planning dashboard tile — clicking a
// tile lands here with the exact list of purchase orders/products behind
// that number (see ppicPlanning.ts, the shared filter both the tile and
// this page read from), plus a one-click Excel export of that same list.
export function PpicPlanningDetailPage() {
  const { metric } = useParams<{ metric: string }>();
  const { data: orders, isLoading } = usePurchaseOrders();
  // Only needed for the Pending POs report's Stage column — fetched
  // unconditionally (same as the Dashboard already does) since hooks
  // can't be called conditionally, but cheap: both are small, already-
  // cached queries other pages share.
  const { data: preRuns } = usePreProductions();
  const { data: batches } = useAllProductionBatches();
  const isPendingPos = metric === "pending-pos";
  const { data: materialRows, isLoading: materialsLoading } = usePendingPoMaterials({ enabled: isPendingPos });

  if (!metric || !VALID_METRICS.has(metric)) {
    return <EmptyState icon={ClipboardList} title="Unknown report" hint="That planning tile doesn't exist." accent="rose" />;
  }
  const m = metric as PpicPlanningMetric;
  const label = PPIC_PLANNING_METRIC_LABEL[m];
  const waitingOnMaterials = isPendingPos && (materialsLoading || !materialRows);

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      {isLoading || !orders || waitingOnMaterials ? (
        <div className="skeleton h-64 w-full" />
      ) : (
        <PpicPlanningTable metric={m} label={label} orders={orders} preRuns={preRuns ?? []} batches={batches ?? []} materialRows={materialRows ?? []} />
      )}
    </div>
  );
}

function PpicPlanningTable({
  metric,
  label,
  orders,
  preRuns,
  batches,
  materialRows,
}: {
  metric: PpicPlanningMetric;
  label: string;
  orders: NonNullable<ReturnType<typeof usePurchaseOrders>["data"]>;
  preRuns: NonNullable<ReturnType<typeof usePreProductions>["data"]>;
  batches: NonNullable<ReturnType<typeof useAllProductionBatches>["data"]>;
  materialRows: PendingPoMaterialRow[];
}) {
  const fullResult = getPpicPlanningRows(metric, orders);

  // Search + Order Date range apply to every tile (some, like Total
  // Products, run to 300+ rows with no other way to find one) — lifted
  // up here (not left inside the individual table components) so the
  // Download button can export exactly what's currently filtered on
  // screen, not the full unfiltered list. See ppicPlanning.ts's
  // filterPpicPlanningResult for the matching rule.
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const result = filterPpicPlanningResult(fullResult, { search, dateFrom, dateTo });
  const isFiltered = search.trim().length > 0 || !!dateFrom || !!dateTo;

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
              {isFiltered ? ` of ${fullResult.rows.length}` : ""}
            </p>
          </div>
        </div>
        <button
          className="btn-primary btn-sm"
          onClick={() => exportPpicPlanningReport(metric, result, { preRuns, batches, materialRows })}
          disabled={result.rows.length === 0}
        >
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Report{isFiltered ? " (Filtered)" : ""}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by PO Number, Customer or Product…"
          className="field w-full max-w-sm text-xs"
        />
        <label className="flex flex-col gap-1 text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
          Order Date From
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="field text-xs" />
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
          Order Date To
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="field text-xs" />
        </label>
        {(dateFrom || dateTo) && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => {
              setDateFrom("");
              setDateTo("");
            }}
          >
            Clear Dates
          </button>
        )}
      </div>

      {fullResult.rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title="Nothing here" hint="No records match this tile right now." accent="brand" />
      ) : result.rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No matches" hint="Nothing matches that search." accent="brand" />
      ) : metric === "pending-pos" && result.kind === "item" ? (
        <PendingPosTable rows={result.rows} preRuns={preRuns} batches={batches} materialRows={materialRows} />
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

// The Pending PO Report — one row per product on every pending PO:
// aging, current pipeline stage, and which RM/PM materials are complete
// vs. short (see pending-materials.ts on the API side for how the
// material list is derived from each product's own calculated RM/BOM
// plan).
function PendingPosTable({
  rows,
  preRuns,
  batches,
  materialRows,
}: {
  rows: PpicPlanningItemRow[];
  preRuns: NonNullable<ReturnType<typeof usePreProductions>["data"]>;
  batches: NonNullable<ReturnType<typeof useAllProductionBatches>["data"]>;
  materialRows: PendingPoMaterialRow[];
}) {
  const materialsByItemId = new Map(materialRows.map((r) => [r.purchaseOrderItemId, r]));

  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
            <th className="px-4 py-3">PO Number</th>
            <th className="px-4 py-3">Customer</th>
            <th className="px-4 py-3">Product</th>
            <th className="px-4 py-3">Aging</th>
            <th className="px-4 py-3">Expected Delivery</th>
            <th className="px-4 py-3">Regulatory Body</th>
            <th className="px-4 py-3">Current Stage</th>
            <th className="px-4 py-3">RM Materials</th>
            <th className="px-4 py-3">PM Materials</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map(({ po, item }) => {
            const stage = getItemStage(item, preRuns, batches);
            const aging = getPoAgingDays(po);
            const materials = materialsByItemId.get(item.id);
            const isDelayed = !!po.expectedDeliveryDate && new Date(po.expectedDeliveryDate) < new Date();
            return (
              <tr key={item.id} className="align-top transition hover:bg-slate-50">
                <td className="px-4 py-3 font-bold text-slate-700">
                  <Link to={`/purchase-orders/${po.id}`} className="hover:text-brand-600 hover:underline">
                    {po.poNumber ?? po.id.slice(0, 8)}
                  </Link>
                </td>
                <td className="px-4 py-3 text-slate-600">{po.customer.companyName}</td>
                <td className="px-4 py-3 text-slate-700">
                  {item.productName}
                  <div className="text-[10.5px] font-normal text-slate-400">
                    {item.quantity} {item.unit}
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-500">{aging}d</td>
                <td className="px-4 py-3">
                  {po.expectedDeliveryDate ? (
                    <span className={isDelayed ? "font-semibold text-rose-700" : "text-slate-500"}>
                      {po.expectedDeliveryDate.slice(0, 10)}
                      {isDelayed ? " (Delayed)" : ""}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-500">{po.regulatoryBody ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className="pill border-brand-200 bg-brand-50 text-brand-700">{stage}</span>
                </td>
                <td className="px-4 py-3 space-y-1">
                  {!materials || materials.rmMaterials.length === 0 ? (
                    <span className="text-slate-400">{materials?.rmPlanned ? "—" : "Not Planned Yet"}</span>
                  ) : (
                    materials.rmMaterials.map((m) => <MaterialLine key={m.name} {...m} />)
                  )}
                </td>
                <td className="px-4 py-3 space-y-1">
                  {!materials || materials.pmMaterials.length === 0 ? (
                    <span className="text-slate-400">{materials?.bomPlanned ? "—" : "Not Planned Yet"}</span>
                  ) : (
                    materials.pmMaterials.map((m) => <MaterialLine key={m.name} {...m} />)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
