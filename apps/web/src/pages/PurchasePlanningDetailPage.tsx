import { Fragment, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ChevronDown, ClipboardList, Download, Truck } from "lucide-react";
import { useAuth } from "../lib/auth";
import { usePreInventoryRequirements } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { exportRequirementsReport } from "../lib/inventoryExport";
import {
  filterPurchasePlanningRows,
  getPurchasePlanningRows,
  needsPi,
  nextEta,
  purchaseSinceAt,
  PURCHASE_PLANNING_METRIC_LABEL,
  REQUIREMENT_STATUS_LABEL,
  requirementStatus,
  type PurchasePlanningMetric,
} from "../lib/purchasePlanning";
import { PiLogForm, PurchaseLineList, fmtDate } from "../components/PurchaseLines";
import { useClientPaging } from "../lib/useClientPaging";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { AgingCell, agingDays, inAgingBuckets } from "../components/AgingCell";
import { useTileFilters } from "../lib/tileFilters";
import { ClientPager } from "../components/Pagination";

const VALID_METRICS = new Set(Object.keys(PURCHASE_PLANNING_METRIC_LABEL));

const STATUS_PILL_CLASS: Record<string, string> = {
  COVERED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  SHORTFALL: "border-amber-200 bg-amber-50 text-amber-700",
  PARTIAL: "border-orange-200 bg-orange-50 text-orange-700",
  ORDERED: "border-brand-200 bg-brand-50 text-brand-700",
};

// The drill-down behind every Purchase dashboard tile — clicking a tile
// lands here with the exact list of Pre-Inventory requirements behind
// that number (see purchasePlanning.ts, the shared filter both the tile
// and this page read from), plus a one-click Excel export reusing
// PreInventoryPage's own exportRequirementsReport. Purchase can Log/Edit
// a PO right from this list too — same mutation PreInventoryPage uses,
// so they never have to leave this filtered view to act on it.
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
  const { hasRole } = useAuth();
  const canPurchase = hasRole("PURCHASE");
  const fullRows = getPurchasePlanningRows(metric, requirements);

  // The shared filter bar: the date range counts against the requirement's ETA, the rest are picks
  // from what this tile's own rows contain.
  const tileFilters = useTileFilters();
  const { applied } = tileFilters;
  const picked = (key: string) => applied.picks[key] ?? [];
  const distinct = (pick: (r: (typeof fullRows)[number]) => string | null | undefined) => [...new Set(fullRows.map(pick).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // One filter per column (Short / On Order are numbers, so they get the Yes / No "Still to order" instead).
  // Status only where the list mixes statuses; the PI Logged tile has none.
  const filterFields: FilterField[] = [
    { key: "item", label: "Item", options: distinct((r) => r.item.name) },
    { key: "customerPo", label: "Customer PO", options: distinct((r) => r.sourcePo?.poNumber) },
    { key: "product", label: "Product", options: distinct((r) => r.sourcePo?.productName) },
    { key: "category", label: "Category", options: ["RM", "PM"] },
    { key: "stillToOrder", label: "Still to order", options: ["Yes", "No"] },
    { key: "po", label: "PI Number", options: [...new Set(fullRows.flatMap((r) => r.purchaseLines.map((l) => l.piNumber)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) },
    { key: "vendor", label: "Vendor", options: [...new Set(fullRows.flatMap((r) => r.purchaseLines.map((l) => l.vendorName)))].sort((a, b) => a.localeCompare(b)) },
    ...(metric === "ordered" ? [] : [{ key: "status", label: "Status", options: Object.values(REQUIREMENT_STATUS_LABEL) } as FilterField]),
    AGING_FIELD,
  ];
  const rows = filterPurchasePlanningRows(fullRows, { etaFrom: applied.dateFrom, etaTo: applied.dateTo }).filter(
    (r) =>
      (!picked("customerPo").length || (r.sourcePo?.poNumber != null && picked("customerPo").includes(r.sourcePo.poNumber))) &&
      (!picked("product").length || (r.sourcePo?.productName != null && picked("product").includes(r.sourcePo.productName))) &&
      (!picked("po").length || r.purchaseLines.some((l) => picked("po").includes(l.piNumber))) &&
      (!picked("vendor").length || r.purchaseLines.some((l) => picked("vendor").includes(l.vendorName))) &&
      (!picked("item").length || picked("item").includes(r.item.name)) &&
      (!picked("category").length || picked("category").includes(r.category)) &&
      (!picked("stillToOrder").length || picked("stillToOrder").includes(needsPi(r) ? "Yes" : "No")) &&
      (!picked("status").length || picked("status").includes(REQUIREMENT_STATUS_LABEL[requirementStatus(r)])) &&
      inAgingBuckets(agingDays(purchaseSinceAt(metric, r)), picked("aging")),
  );
  const pg = useClientPaging(rows);
  const isFiltered = tileFilters.activeCount > 0;

  // Which row's Log/Edit PO form is currently open — at most one at a
  // time, same "click to expand, click Cancel/Save to close" shape as
  // PreInventoryPage's own RequirementCard.
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  // Rows whose PI lines are shown underneath (click the PI / Vendor cell).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
              {rows.length} requirement(s)
              {isFiltered ? ` of ${fullRows.length}` : ""}
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm" onClick={() => exportRequirementsReport(rows)} disabled={rows.length === 0}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Report{isFiltered ? " (Filtered)" : ""}
        </button>
      </div>

      <TileFilterBar filters={tileFilters} tileKey={`purchase-${metric}`} fields={filterFields} dateLabel="ETA" />

      {fullRows.length === 0 ? (
        <EmptyState icon={ClipboardList} title="Nothing here" hint="No records match this tile right now." accent="brand" />
      ) : rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No matches" hint="Nothing matches these filters." accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="sticky left-0 z-10 min-w-[210px] bg-slate-50 px-4 py-3">Item</th>
                <th className="px-4 py-3">Customer PO</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">Short</th>
                <th className="px-4 py-3 text-right">On Order</th>
                <th className="px-4 py-3">PI</th>
                <th className="px-4 py-3">Vendor</th>
                {metric === "ordered" ? <th className="px-4 py-3">Aging</th> : <th className="px-4 py-3">Status</th>}
                <th className="px-4 py-3">ETA</th>
                {canPurchase && <th className="px-4 py-3">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((r) => {
                const status = requirementStatus(r);
                const isOpen = openRowId === r.id;
                const isExpanded = expanded.has(r.id);
                const lines = r.purchaseLines;
                const eta = nextEta(r);
                const overdue = !!eta && new Date(eta) < new Date(new Date().toDateString());
                const vendors = [...new Set(lines.map((l) => l.vendorName))];
                return (
                  <Fragment key={r.id}>
                    <tr className="group align-middle transition hover:bg-slate-50">
                      <td className="sticky left-0 z-10 min-w-[210px] whitespace-normal bg-white px-4 py-3 font-bold text-slate-800 group-hover:bg-slate-50">{r.item.name}</td>
                      <td className="px-4 py-3">
                        {r.sourcePo ? (
                          <Link to={`/purchase-orders/${r.sourcePo.poId}`} className="font-semibold text-slate-700 hover:text-brand-600 hover:underline">
                            {r.sourcePo.poNumber ?? r.sourcePo.poId.slice(0, 8)}
                          </Link>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="max-w-[200px] whitespace-normal px-4 py-3 text-slate-600">{r.sourcePo?.productName ?? <span className="text-slate-300">—</span>}</td>
                      <td className="px-4 py-3 text-slate-500">{r.category === "RM" ? "Raw Material" : "Packaging Material"}</td>
                      <td className={`px-4 py-3 text-right font-mono tabular-nums ${r.shortQty > 0 ? "font-bold text-rose-600" : "text-slate-300"}`}>{r.shortQty > 0 ? `${r.shortQty} ${r.unit}` : "—"}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={`font-mono tabular-nums ${r.onOrderQty > 0 ? "font-bold text-emerald-700" : "text-slate-300"}`}>{r.onOrderQty > 0 ? `${r.onOrderQty} ${r.unit}` : "—"}</span>
                        {r.remainingToLog > 0 && (
                          <span className="block text-micro font-bold text-amber-700">
                            {r.remainingToLog} {r.unit} still to order
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {lines.length === 0 ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <button type="button" onClick={() => toggleExpanded(r.id)} aria-expanded={isExpanded} className="group/pi inline-flex items-center gap-1.5 font-bold text-brand-700 hover:underline" title="Show the PI details">
                            {lines.length === 1 ? lines[0].piNumber : `${lines.length} PIs`}
                            <ChevronDown className={`h-3.5 w-3.5 text-slate-400 transition group-hover/pi:text-brand-600 ${isExpanded ? "rotate-180" : ""}`} strokeWidth={2.5} />
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{lines.length === 0 ? <span className="text-slate-300">—</span> : vendors.length === 1 ? vendors[0] : `${vendors.length} vendors`}</td>
                      <td className="px-4 py-3">
                        {metric === "ordered" ? (
                          <AgingCell since={purchaseSinceAt(metric, r)} />
                        ) : (
                          <span className="inline-flex items-center gap-2">
                            <span className={`pill ${STATUS_PILL_CLASS[status]}`}>{REQUIREMENT_STATUS_LABEL[status]}</span>
                            <AgingCell since={purchaseSinceAt(metric, r)} />
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {eta ? (
                          <span className={overdue ? "font-semibold text-rose-700" : "text-slate-600"}>
                            {lines.length > 1 ? "Next: " : ""}
                            {fmtDate(eta)}
                            {overdue ? " (Overdue)" : ""}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      {canPurchase && (
                        <td className="px-4 py-3">
                          {needsPi(r) ? (
                            <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenRowId(isOpen ? null : r.id)}>
                              <Truck className="h-3.5 w-3.5" strokeWidth={2.5} /> {lines.length > 0 ? "Log another PI" : "Log PI"}
                            </button>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                    {isExpanded && lines.length > 0 && (
                      <tr>
                        <td colSpan={canPurchase ? 11 : 10} className="whitespace-normal border-l-2 border-brand-200 bg-slate-50/60 px-6 py-2">
                          <PurchaseLineList requirement={r} canPurchase={canPurchase} variant="table" />
                        </td>
                      </tr>
                    )}
                    {isOpen && (
                      <tr>
                        <td colSpan={canPurchase ? 11 : 10} className="whitespace-normal bg-slate-50/60 px-4 py-3">
                          <PiLogForm requirement={r} onDone={() => setOpenRowId(null)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <ClientPager pg={pg} />
        </div>
      )}
    </>
  );
}
