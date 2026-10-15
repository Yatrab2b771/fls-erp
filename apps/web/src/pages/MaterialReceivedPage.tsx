import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ChevronDown, Download, PackageCheck, PackageOpen } from "lucide-react";
import { useMaterialBoard, type MaterialBoardRow, type MaterialBoardStatus } from "../lib/hooks";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { AgingCell, agingDays, inAgingBuckets } from "../components/AgingCell";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";
import { CustomerName } from "../components/CustomerName";
import { customerTypeLabel } from "../lib/customerTags";

const STATUS_LABEL: Record<MaterialBoardStatus, string> = {
  NOT_DISPENSED: "Not dispensed yet",
  FULL: "Fully received",
  PARTIAL: "Partly received",
  IN_TRANSIT: "In transit",
  NOT_RECEIVED: "Not received",
  NOT_IN_CATALOG: "Not in catalog",
};
const STATUS_PILL: Record<MaterialBoardStatus, string> = {
  NOT_DISPENSED: "border-slate-200 bg-slate-50 text-slate-600",
  FULL: "border-emerald-200 bg-emerald-50 text-emerald-700",
  PARTIAL: "border-amber-200 bg-amber-50 text-amber-700",
  IN_TRANSIT: "border-sky-200 bg-sky-50 text-sky-700",
  NOT_RECEIVED: "border-rose-200 bg-rose-50 text-rose-700",
  NOT_IN_CATALOG: "border-slate-200 bg-slate-50 text-slate-500",
};
const CATEGORY_LABEL = { RM: "Raw Material", PM: "Packaging Material" } as const;
const SHOWN_STATUSES: MaterialBoardStatus[] = ["NOT_DISPENSED", "NOT_RECEIVED", "IN_TRANSIT", "PARTIAL", "FULL"];

// The "Material" filter, like Material Planning's: Received / Still to come, each with RM and PM underneath.
const MATERIAL_GROUPS = [
  { status: "PENDING", label: "Still to come", tone: "text-rose-700" },
  { status: "DONE", label: "Received", tone: "text-emerald-700" },
];

interface ProductGroup {
  itemId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  productCategory: string | null;
  plantName: string | null;
  releasedQty: number;
  orderQty: number;
  unit: string;
  sentAt: string;
  /** Every material line of the product (its true progress), and the lines that match the Material filters (what is listed). */
  allLines: MaterialBoardRow[];
  lines: MaterialBoardRow[];
  status: MaterialBoardStatus;
}

const progress = (lines: MaterialBoardRow[], category: "RM" | "PM") => {
  const of = lines.filter((l) => l.category === category);
  return { done: of.filter((l) => l.status === "FULL").length, total: of.length };
};

function groupByProduct(rows: MaterialBoardRow[]): ProductGroup[] {
  const map = new Map<string, MaterialBoardRow[]>();
  for (const r of rows) map.set(r.itemId, [...(map.get(r.itemId) ?? []), r]);
  return [...map.values()].map((lines) => {
    const first = lines[0]!;
    const full = lines.filter((m) => m.status === "FULL").length;
    const status: MaterialBoardStatus = lines.every((m) => m.status === "NOT_DISPENSED") ? "NOT_DISPENSED" : full === lines.length ? "FULL" : lines.some((m) => m.receivedQty > 0) ? "PARTIAL" : lines.some((m) => m.inTransitQty > 0) ? "IN_TRANSIT" : "NOT_RECEIVED";
    return {
      itemId: first.itemId,
      poNumber: first.poNumber,
      customerName: first.customerName,
      productName: first.productName,
      productCategory: first.productCategory,
      plantName: first.plant?.name ?? null,
      releasedQty: first.releasedQty,
      orderQty: first.orderQty,
      unit: first.productUnit,
      sentAt: first.sentAt,
      allLines: lines,
      lines,
      status,
    };
  });
}

// Production's second tile. One row per product with how much of its material has arrived (RM and PM separately); Materials opens the
// line-by-line detail: required, received, in transit, still to come, in production, left with Production and available at the Plant.
export function MaterialReceivedPage() {
  const { data, isLoading } = useMaterialBoard();
  const filters = useTileFilters();
  const [openId, setOpenId] = useState<string | null>(null);
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const lines = data ?? [];
  const everyProduct = groupByProduct(lines);
  const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // A Plant login sees only its own Plant, so the Plant column and filter only show when more than one Plant is in the list.
  const showPlant = distinct(everyProduct.map((g) => g.plantName)).length > 1;

  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct(everyProduct.map((g) => g.poNumber)) },
    { key: "customer", label: "Customer", options: distinct(everyProduct.map((g) => g.customerName)) },
    { key: "product", label: "Product", options: distinct(everyProduct.map((g) => g.productName)) },
    { key: "type", label: "Product Type", options: distinct(everyProduct.map((g) => g.productCategory)) },
    ...(showPlant ? [{ key: "plant", label: "Plant", options: distinct(everyProduct.map((g) => g.plantName)) }] : []),
    { key: "status", label: "Product Status", options: SHOWN_STATUSES.map((s) => STATUS_LABEL[s]) },
    { key: "mat", label: "Material", kind: "material", groups: MATERIAL_GROUPS },
    { key: "matname", label: "Material Name", options: distinct(lines.map((l) => l.material)) },
    AGING_FIELD,
  ];

  // A material line matches the Material filters when it is in a picked "Still to come / Received x RM / PM" box and a picked name.
  const lineOk = (l: MaterialBoardRow) =>
    (!picked("mat").length || picked("mat").includes(`${l.status === "FULL" ? "DONE" : "PENDING"}:${l.category}`)) && (!picked("matname").length || picked("matname").includes(l.material));
  const materialFiltered = picked("mat").length > 0 || picked("matname").length > 0;
  const from = filters.applied.dateFrom;
  const to = filters.applied.dateTo;
  const groups = everyProduct
    .filter(
      (g) =>
        (!picked("po").length || picked("po").includes(g.poNumber ?? "")) &&
        (!picked("customer").length || picked("customer").includes(g.customerName)) &&
        (!picked("product").length || picked("product").includes(g.productName)) &&
        (!picked("type").length || picked("type").includes(g.productCategory ?? "")) &&
        (!picked("plant").length || picked("plant").includes(g.plantName ?? "")) &&
        (!picked("status").length || picked("status").includes(STATUS_LABEL[g.status])) &&
        (!from || g.sentAt.slice(0, 10) >= from) &&
        (!to || g.sentAt.slice(0, 10) <= to) &&
        inAgingBuckets(agingDays(g.sentAt), picked("aging")),
    )
    .map((g) => ({ ...g, lines: g.allLines.filter(lineOk) }))
    .filter((g) => !materialFiltered || g.lines.length > 0);
  const pg = useClientPaging(groups);
  const isFiltered = filters.activeCount > 0;
  const count = (s: MaterialBoardStatus) => everyProduct.filter((g) => g.status === s).length;
  const toCome = lines.filter((l) => l.balanceQty > 0).length;
  const onTheWay = lines.filter((l) => l.inTransitQty > 0).length;

  function download() {
    const rows = groups.flatMap((g) => g.lines).map((r) => ({
        "PO Number": r.poNumber ?? "",
        Status: STATUS_LABEL[r.status],
        Customer: r.customerName,
        "Customer Type": customerTypeLabel(r.customerName),
        Product: r.productName,
        "Product Type": r.productCategory ?? "",
        Plant: r.plant?.name ?? "",
        "Released Qty": r.releasedQty,
        "Order Qty": r.orderQty,
        Material: r.material,
        Category: CATEGORY_LABEL[r.category],
        Unit: r.unit,
        "Required Qty": r.requiredQty,
        "Received Qty": r.receivedQty,
        "In Transit Qty": r.inTransitQty,
        "Balance (still to come)": r.balanceQty,
        "In Production (used)": r.usedQty,
        "Left with Production": r.leftQty,
        "Available at Plant": r.availableQty ?? "",
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Material Received", "FLS Material Received", describeFilters(filters, fields, "Plan sent on"), rows, { totals: ["Required Qty", "Received Qty", "In Transit Qty", "Balance (still to come)", "In Production (used)", "Left with Production"] });
    XLSX.writeFile(wb, stampedName("FLS_Material_Received"));
  }

  const chip = (s: MaterialBoardStatus) => (
    <button
      key={s}
      type="button"
      onClick={() => filters.applyPick("status", picked("status").includes(STATUS_LABEL[s]) ? [] : [STATUS_LABEL[s]])}
      className={`pill cursor-pointer ${STATUS_PILL[s]} ${picked("status").includes(STATUS_LABEL[s]) ? "ring-2 ring-brand-300" : ""}`}
    >
      {STATUS_LABEL[s]} · {count(s)}
    </button>
  );

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-amber-500/10 text-amber-600">
            <PackageCheck className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Material Received</h1>
            <p className="text-sm text-slate-500">
              {groups.length.toLocaleString()} product{groups.length === 1 ? "" : "s"}
              {isFiltered ? ` of ${everyProduct.length}` : ""} — how much of each product's material the Day Store has dispensed to you. Open Materials on a row for the line-by-line detail.
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm" disabled={groups.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {SHOWN_STATUSES.map(chip)}
        <span className="ml-2 text-tiny font-semibold text-slate-500">
          {toCome} material line{toCome === 1 ? "" : "s"} still to come · {onTheWay} on the way
        </span>
      </div>

      <TileFilterBar filters={filters} tileKey="material-received" fields={fields} dateLabel="Plan sent on" />

      {isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : groups.length === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "Nothing yet"} hint={isFiltered ? "Nothing matches these filters." : "Products show here as soon as PPIC sends them to Production."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Product Type</th>
                {showPlant && <th className="px-4 py-3">Plant</th>}
                <th className="px-4 py-3 text-right">Quantity</th>
                <th className="px-4 py-3">Material arrived</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3">Materials</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((g) => {
                const open = openId === g.itemId;
                const rm = progress(g.allLines, "RM");
                const pm = progress(g.allLines, "PM");
                const done = rm.done + pm.done;
                const total = rm.total + pm.total;
                const pct = total ? Math.round((done / total) * 100) : 0;
                return (
                  <Fragment key={g.itemId}>
                    <tr className={`transition hover:bg-slate-50 ${open ? "bg-slate-50/70" : ""}`}>
                      <td className="px-4 py-3 font-semibold text-slate-700">{g.poNumber ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span className={`pill ${STATUS_PILL[g.status]}`}>{STATUS_LABEL[g.status]}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-600"><CustomerName name={g.customerName} /></td>
                      <td className="px-4 py-3 font-bold text-slate-800">{g.productName}</td>
                      <td className="px-4 py-3 text-slate-600">{g.productCategory ?? "—"}</td>
                      {showPlant && <td className="px-4 py-3 text-slate-600">{g.plantName ?? "—"}</td>}
                      <td className="px-4 py-3 text-right font-mono text-slate-800">
                        {fmtQty(g.orderQty)} {g.unit}
                        {g.releasedQty < g.orderQty - 1e-6 && <span className="block font-sans text-micro font-bold text-amber-600">Released {fmtQty(g.releasedQty)} of {fmtQty(g.orderQty)}</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                            <div className={`h-full rounded-full ${g.status === "FULL" ? "bg-emerald-500" : "bg-amber-400"}`} style={{ width: `${pct}%` }} />
                          </div>
                          <div className="font-mono text-tiny font-bold leading-tight text-slate-700">
                            {done} / {total}
                            <span className="block font-sans text-micro font-semibold text-slate-400">
                              RM {rm.done}/{rm.total} · PM {pm.done}/{pm.total}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <AgingCell since={g.sentAt} />
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setOpenId(open ? null : g.itemId)}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-tiny font-bold transition ${open ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                        >
                          Materials{materialFiltered ? ` (${g.lines.length})` : ""} <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={showPlant ? 10 : 9} className="px-4 py-4">
                          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                            <table className="w-full whitespace-nowrap text-xs">
                              <thead>
                                <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                                  <th className="px-3 py-2">Material</th>
                                  <th className="px-3 py-2">Category</th>
                                  <th className="px-3 py-2 text-right" title="Needed for the part PPIC has released">Required</th>
                                  <th className="px-3 py-2 text-right" title="Issued by the Day Store and received at the Plant">Received</th>
                                  <th className="px-3 py-2 text-right" title="Issued but not yet received at the Plant">In Transit</th>
                                  <th className="px-3 py-2 text-right" title="Required - Received - In transit">Still to come</th>
                                  <th className="px-3 py-2 text-right" title="A + B + C + D - E: used in production, wastage, rejected, sample, minus what went back to the store">In Production</th>
                                  <th className="px-3 py-2 text-right" title="Received - In production">Left with me</th>
                                  <th className="px-3 py-2 text-right" title="Whole-Plant on hand for this material, shared by every product at the Plant">Available at Plant</th>
                                  <th className="px-3 py-2">Status</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {g.lines.map((m) => (
                                  <tr key={`${m.category}-${m.material}`}>
                                    <td className="px-3 py-2 font-bold text-slate-700">{m.material}</td>
                                    <td className="px-3 py-2 text-slate-500">{CATEGORY_LABEL[m.category]}</td>
                                    <td className="px-3 py-2 text-right font-mono font-bold text-slate-800">
                                      {fmtQty(m.requiredQty)} {m.unit}
                                    </td>
                                    <td className="px-3 py-2 text-right font-mono text-emerald-700">{m.receivedQty ? `${fmtQty(m.receivedQty)} ${m.unit}` : "—"}</td>
                                    <td className="px-3 py-2 text-right font-mono text-sky-700">{m.inTransitQty ? `${fmtQty(m.inTransitQty)} ${m.unit}` : "—"}</td>
                                    <td className={`px-3 py-2 text-right font-mono ${m.balanceQty ? "font-bold text-rose-600" : "text-slate-300"}`}>{m.balanceQty ? `${fmtQty(m.balanceQty)} ${m.unit}` : "—"}</td>
                                    <td className="px-3 py-2 text-right font-mono text-violet-700">{m.usedQty ? `${fmtQty(m.usedQty)} ${m.unit}` : "—"}</td>
                                    <td className="px-3 py-2 text-right font-mono text-slate-700">{m.receivedQty || m.usedQty ? `${fmtQty(m.leftQty)} ${m.unit}` : "—"}</td>
                                    <td className="px-3 py-2 text-right font-mono text-slate-700">{m.availableQty == null ? "—" : `${fmtQty(m.availableQty)} ${m.unit}`}</td>
                                    <td className="px-3 py-2">
                                      <span className={`pill ${STATUS_PILL[m.status]}`}>{STATUS_LABEL[m.status]}</span>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="mt-2 text-micro text-slate-400">"Available at Plant" is the whole Plant's stock of that material, shared by every product being made there.</p>
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
    </div>
  );
}
