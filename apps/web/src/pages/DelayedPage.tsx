import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { AlarmClock, ArrowLeft, Download } from "lucide-react";
import { useAllProductionBatches, useCombinedLots, usePreInventoryRequirements, usePreProductions, usePurchaseOrders } from "../lib/hooks";
import { getBdPlanningRows } from "../lib/bdPlanning";
import { useTileFilters } from "../lib/tileFilters";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import type { StageDelay } from "../lib/types";
import { customerTypeLabel } from "../lib/customerTags";

// Everything in the system that is running late, in one list: orders past their promised delivery date, production runs / lots / batches
// behind their plan dates, and purchases whose ETA has passed without the material arriving.

const DAY_MS = 86_400_000;
const KINDS = ["PO delivery", "Production run", "Combined lot", "Production batch", "Purchase ETA"] as const;
type Kind = (typeof KINDS)[number];

interface Row {
  key: string;
  kind: Kind;
  po: string;
  customer: string;
  product: string;
  against: string;
  where: string;
  daysLate: number;
  to: string;
}

const AGAINST: Record<NonNullable<StageDelay["against"]>, string> = { productionPlanDate: "Production plan date", dispatchPlanDate: "Dispatch plan date" };
const distinct = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const stageLabel = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export function DelayedPage() {
  const filters = useTileFilters();
  const { data: orders, isLoading: l1 } = usePurchaseOrders();
  const { data: runs, isLoading: l2 } = usePreProductions();
  const { data: lots, isLoading: l3 } = useCombinedLots();
  const { data: batches, isLoading: l4 } = useAllProductionBatches();
  const { data: requirements, isLoading: l5 } = usePreInventoryRequirements();
  const isLoading = l1 || l2 || l3 || l4 || l5;

  const now = Date.now();
  const todayStart = new Date(new Date().toDateString()).getTime();
  const rows: Row[] = [];
  const full = getBdPlanningRows("delayed-pos", orders ?? []);
  if (full.kind === "po") {
    for (const po of full.rows) {
      const live = po.items.filter((i) => !i.cancelledAt);
      rows.push({
        key: `po-${po.id}`,
        kind: "PO delivery",
        po: po.poNumber ?? po.id.slice(0, 8),
        customer: po.customer.companyName,
        product: live.length === 1 ? live[0]!.productName : `${live.length} products`,
        against: "Expected delivery date",
        where: po.status === "APPROVED" ? "Not completed" : po.status,
        daysLate: Math.max(1, Math.floor((now - new Date(po.expectedDeliveryDate!).getTime()) / DAY_MS)),
        to: `/purchase-orders/${po.id}`,
      });
    }
  }
  for (const r of runs ?? []) {
    if (!r.delay.isDelayed) continue;
    rows.push({ key: `run-${r.id}`, kind: "Production run", po: r.purchaseOrderItem.purchaseOrder.poNumber ?? "", customer: r.purchaseOrderItem.purchaseOrder.customer.companyName, product: r.purchaseOrderItem.productName, against: r.delay.against ? AGAINST[r.delay.against] : "Plan date", where: stageLabel(r.currentStageId), daysLate: r.delay.daysLate ?? 0, to: `/pre-productions/${r.id}` });
  }
  for (const l of lots ?? []) {
    if (!l.delay.isDelayed) continue;
    const item = l.preProduction.purchaseOrderItem;
    rows.push({ key: `lot-${l.id}`, kind: "Combined lot", po: item.purchaseOrder.poNumber ?? "", customer: item.purchaseOrder.customer.companyName, product: item.productName, against: l.delay.against ? AGAINST[l.delay.against] : "Plan date", where: stageLabel(l.currentStageId), daysLate: l.delay.daysLate ?? 0, to: `/combined-lots/${l.id}` });
  }
  for (const b of batches ?? []) {
    const delay = (b as { delay?: StageDelay }).delay;
    if (!delay?.isDelayed) continue;
    const item = b.preProduction.purchaseOrderItem;
    rows.push({ key: `batch-${b.id}`, kind: "Production batch", po: item.purchaseOrder.poNumber ?? "", customer: item.purchaseOrder.customer.companyName, product: `${item.productName}${b.batchNo ? ` (${b.batchNo})` : ""}`, against: delay.against ? AGAINST[delay.against] : "Plan date", where: stageLabel(b.currentStageId), daysLate: delay.daysLate ?? 0, to: `/production-batches/${b.id}` });
  }
  for (const req of requirements ?? []) {
    for (const line of req.purchaseLines) {
      const eta = new Date(line.eta).getTime();
      if (line.status !== "OPEN" || eta >= todayStart) continue;
      rows.push({
        key: `eta-${line.id}`,
        kind: "Purchase ETA",
        po: req.sourcePo?.poNumber ?? "",
        customer: req.sourcePo?.customerName ?? "",
        product: req.item.name,
        against: `ETA ${line.eta.slice(0, 10)} (${line.vendorName}, ${line.piNumber})`,
        where: "Material not received",
        daysLate: Math.max(1, Math.round((todayStart - eta) / DAY_MS)),
        to: "/incoming-material",
      });
    }
  }
  rows.sort((a, b) => b.daysLate - a.daysLate);

  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const has = (key: string, value: string) => !picked(key).length || picked(key).includes(value);
  const shown = rows.filter((r) => has("kind", r.kind) && has("po", r.po) && has("customer", r.customer) && has("product", r.product) && has("late", r.daysLate > 30 ? "Over 30 days" : r.daysLate > 7 ? "8-30 days" : "Up to 7 days"));
  const isFiltered = filters.activeCount > 0;
  const fields: FilterField[] = [
    { key: "kind", label: "What is late", options: [...KINDS] },
    { key: "po", label: "PO Number", options: distinct(rows.map((r) => r.po)) },
    { key: "customer", label: "Customer", options: distinct(rows.map((r) => r.customer)) },
    { key: "product", label: "Product / Material", options: distinct(rows.map((r) => r.product)) },
    { key: "late", label: "Late by", options: ["Up to 7 days", "8-30 days", "Over 30 days"] },
  ];
  const pg = useClientPaging(shown);

  function download() {
    const sheet = XLSX.utils.json_to_sheet(shown.map((r) => ({ "What is late": r.kind, "PO Number": r.po, Customer: r.customer, "Customer Type": customerTypeLabel(r.customer), "Product / Material": r.product, "Late against": r.against, "Where it is": r.where, "Days late": r.daysLate })));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Delayed");
    XLSX.writeFile(book, `FLS_Delayed_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-rose-500/10 text-rose-600">
            <AlarmClock className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Delayed</h1>
            <p className="text-sm text-slate-500">
              {shown.length} running late{isFiltered ? ` (of ${rows.length})` : ""} — orders, production and purchases
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm shrink-0" onClick={download} disabled={shown.length === 0}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Report{isFiltered ? " (Filtered)" : ""}
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey="delayed" fields={fields} hideDates />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : shown.length === 0 ? (
        <EmptyState icon={AlarmClock} title="Nothing is late" hint={isFiltered ? "Nothing matches these filters." : "No order, run or purchase is behind its date right now."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">What is late</th>
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Product / Material</th>
                <th className="px-4 py-3">Late against</th>
                <th className="px-4 py-3">Where it is</th>
                <th className="px-4 py-3 text-right">Days late</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((r) => (
                <tr key={r.key} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-500">{r.kind}</td>
                  <td className="px-4 py-3 font-bold text-slate-700">{r.po || "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{r.customer || "—"}</td>
                  <td className="px-4 py-3 font-bold text-slate-800">{r.product}</td>
                  <td className="px-4 py-3 text-slate-500">{r.against}</td>
                  <td className="px-4 py-3 text-slate-500">{r.where}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="pill border-rose-200 bg-rose-50 text-rose-700">{r.daysLate} d</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link to={r.to} className="btn-ghost btn-sm">
                      Open
                    </Link>
                  </td>
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
