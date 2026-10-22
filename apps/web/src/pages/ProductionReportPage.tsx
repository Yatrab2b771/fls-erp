import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ClipboardList, Download, PackageOpen, X } from "lucide-react";
import { useBatchReportBoard, useHandoverBoard, usePlansBoard, type BatchReportDetail, type HandoverRow } from "../lib/hooks";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { ColumnFilter } from "../components/ColumnFilter";
import { EmptyState } from "../components/EmptyState";
import { fmtQty } from "../lib/format";
import { addReportSheet, stampedName } from "../lib/excelReport";
import { sheetTotals, summarize, toReportBatches, toSheetRows, type SheetRow } from "../lib/productionReport";

const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const dayText = (ymd: string) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "");
const num = (n: number | null, show: (v: number) => string = (v) => String(v)) => (n == null ? "" : show(n));

const STATUS_PILL: Record<SheetRow["status"], string> = {
  "In progress": "border-amber-200 bg-amber-50 text-amber-700",
  Completed: "border-violet-200 bg-violet-50 text-violet-700",
  "Handed over": "border-emerald-200 bg-emerald-50 text-emerald-700",
};

// One column of the sheet: the text a filter lists and matches, and how the cell looks. The Excel download has the same columns, in the same order.
interface Column {
  id: string;
  label: string;
  title?: string;
  right?: boolean;
  text: (r: SheetRow) => string;
  cell?: (r: SheetRow) => ReactNode;
}

const COLUMNS: Column[] = [
  { id: "date", label: "Date", text: (r) => dayText(r.date), cell: (r) => <span className="font-semibold text-slate-700">{dayText(r.date) || "—"}</span> },
  { id: "po", label: "PO Number", text: (r) => r.po },
  { id: "customer", label: "Customer", text: (r) => r.customer },
  { id: "product", label: "Product", text: (r) => r.product, cell: (r) => <span className="font-bold text-slate-800">{r.product}</span> },
  { id: "plant", label: "Plant", text: (r) => r.plant },
  {
    id: "batch",
    label: "Batch No",
    text: (r) => r.batchNo,
    cell: (r) => (
      <Link to={`/production-report/batch/${r.batchId}`} className="font-mono font-bold text-orange-800 underline decoration-orange-300 underline-offset-2 hover:text-brand-600" title="Open this batch's full report">
        {r.batchNo || `Batch ${r.batchId.slice(0, 8)}`}
      </Link>
    ),
  },
  { id: "shift", label: "Shift", text: (r) => r.shift },
  { id: "status", label: "Status", text: (r) => r.status, cell: (r) => <span className={`pill ${STATUS_PILL[r.status]}`}>{r.status}</span> },
  { id: "start", label: "Start Time", text: (r) => dt(r.startAt) },
  { id: "end", label: "End Time", text: (r) => dt(r.endAt) },
  { id: "hours", label: "Hours", right: true, text: (r) => num(r.hours) },
  { id: "unit", label: "Unit", text: (r) => r.unit },
  { id: "planned", label: "Planned Qty", right: true, text: (r) => fmtQty(r.planned) },
  { id: "input", label: "Input Qty", right: true, text: (r) => num(r.input, fmtQty) },
  { id: "produced", label: "Produced Qty", right: true, text: (r) => num(r.produced, fmtQty), cell: (r) => <b className="text-slate-900">{num(r.produced, fmtQty)}</b> },
  { id: "manpower", label: "Manpower Count", title: "The people who worked on this batch", right: true, text: (r) => num(r.manpower) },
  { id: "efficiency", label: "Manpower Efficiency", title: "Produced ÷ (manpower × hours): quantity made per man-hour", right: true, text: (r) => num(r.efficiency) },
  { id: "yield", label: "Yield %", title: "Produced ÷ Input", right: true, text: (r) => num(r.yieldPct, (v) => `${v}%`), cell: (r) => <span className="font-bold text-emerald-700">{num(r.yieldPct, (v) => `${v}%`)}</span> },
];

const distinct = (xs: string[]) => [...new Set(xs)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

// Production's Production Report: one sheet, a row for each batch by the day it started, like the Excel it downloads (same columns, a filter on every
// column header, a Total row). Manpower is each batch's own, so the Total adds the batches' manpower up.
export function ProductionReportPage() {
  const { data: board, isLoading } = usePlansBoard();
  const { data: handoverRows } = useHandoverBoard();
  const { data: batchDetails } = useBatchReportBoard();
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const detailOf = new Map<string, BatchReportDetail>((batchDetails ?? []).map((d) => [d.batchId, d]));
  const handover = new Map<string, HandoverRow>((handoverRows ?? []).map((h) => [h.batchId, h]));
  const everyRow = toSheetRows((board ?? []).filter((r) => r.batches.length > 0).map((r) => summarize(r, toReportBatches(r, handover, detailOf))));

  // A date range on the Date column, then a filter per column: each column lists only the values the other columns' filters leave, like Excel
  const inRange = everyRow.filter((r) => (!from && !to) || (!!r.date && (!from || r.date >= from) && (!to || r.date <= to)));
  const passes = (r: SheetRow, except?: string) => COLUMNS.every((c) => c.id === except || !(picks[c.id]?.length) || picks[c.id]!.includes(c.text(r)));
  const rows = inRange.filter((r) => passes(r));
  const totals = sheetTotals(rows);
  const pg = useClientPaging(rows);
  const activeFilters = COLUMNS.filter((c) => picks[c.id]?.length).length + (from || to ? 1 : 0);
  const clearAll = () => {
    setPicks({});
    setFrom("");
    setTo("");
  };

  function download() {
    const filterParts = [...(from || to ? [`Date: ${from || "…"} to ${to || "…"}`] : []), ...COLUMNS.filter((c) => picks[c.id]?.length).map((c) => `${c.label}: ${picks[c.id]!.map((v) => v || "(Blanks)").join(", ")}`)];
    const sheet = rows.map((r) => ({
      Date: dayText(r.date),
      "PO Number": r.po,
      Customer: r.customer,
      Product: r.product,
      Plant: r.plant,
      "Batch No": r.batchNo,
      Shift: r.shift,
      Status: r.status,
      "Start Time": dt(r.startAt),
      "End Time": dt(r.endAt),
      Hours: r.hours ?? "",
      Unit: r.unit,
      "Planned Qty": r.planned,
      "Input Qty": r.input ?? "",
      "Produced Qty": r.produced ?? "",
      "Manpower Count": r.manpower ?? "",
      "Manpower Efficiency": r.efficiency ?? "",
      "Yield %": r.yieldPct ?? "",
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Production Report", "FLS Production Report - batches by day", filterParts.length ? filterParts.join(" · ") : "None (all records)", sheet, {
      totals: ["Hours", "Planned Qty", "Input Qty", "Produced Qty", "Manpower Count"],
      totalValues: { "Manpower Efficiency": totals.efficiency ?? "", "Yield %": totals.yieldPct ?? "" },
    });
    XLSX.writeFile(wb, stampedName("FLS_Production_Report"));
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-violet-500/10 text-violet-600">
            <ClipboardList className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Production Report</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} batch{rows.length === 1 ? "" : "es"}
              {activeFilters ? ` of ${everyRow.length}` : ""} — one row for each batch, by the day it started. Filter any column from its header.
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm shrink-0" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel{activeFilters ? " (Filtered)" : ""}
        </button>
      </div>

      <div className="card flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col gap-1 text-micro font-bold uppercase tracking-wide text-slate-500">
          Date from
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="field text-xs" />
        </label>
        <label className="flex flex-col gap-1 text-micro font-bold uppercase tracking-wide text-slate-500">
          Date to
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="field text-xs" />
        </label>
        {COLUMNS.filter((c) => picks[c.id]?.length).map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-tiny font-bold text-brand-700">
            {c.label}: {picks[c.id]!.length === 1 ? picks[c.id]![0] || "(Blanks)" : `${picks[c.id]!.length} selected`}
            <button type="button" aria-label={`Clear ${c.label}`} onClick={() => setPicks((cur) => ({ ...cur, [c.id]: [] }))}>
              <X className="h-3 w-3" strokeWidth={2.5} />
            </button>
          </span>
        ))}
        {activeFilters > 0 && (
          <button type="button" className="btn-ghost btn-sm" onClick={clearAll}>
            Clear Filters
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={PackageOpen} title={activeFilters ? "No matches" : "Nothing to report yet"} hint={activeFilters ? "Nothing matches these filters." : "A batch shows here once Production has made it."} accent="brand" />
      ) : (
        <div className="card overflow-hidden">
          <div className="max-h-[68vh] overflow-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                  {COLUMNS.map((c) => (
                    <th key={c.id} title={c.title} className={`px-3 py-2.5 ${c.right ? "text-right" : ""}`}>
                      {c.label}
                      <ColumnFilter label={c.label} options={distinct(inRange.filter((r) => passes(r, c.id)).map(c.text))} selected={picks[c.id] ?? []} onChange={(next) => setPicks((cur) => ({ ...cur, [c.id]: next }))} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pg.rows.map((r) => (
                  <tr key={r.batchId} className="transition hover:bg-slate-50">
                    {COLUMNS.map((c) => (
                      <td key={c.id} className={`px-3 py-2 ${c.right ? "text-right font-mono" : ""} ${c.id === "customer" ? "text-slate-600" : "text-slate-700"}`}>
                        {c.cell ? c.cell(r) : c.text(r) || <span className="text-slate-300">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 z-10">
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-slate-800">
                  {COLUMNS.map((c, i) => (
                    <td key={c.id} className={`px-3 py-2.5 ${c.right ? "text-right font-mono" : ""}`}>
                      {i === 0
                        ? "Total"
                        : c.id === "hours"
                          ? totals.hours
                          : c.id === "planned"
                            ? fmtQty(totals.planned)
                            : c.id === "input"
                              ? fmtQty(totals.input)
                              : c.id === "produced"
                                ? fmtQty(totals.produced)
                                : c.id === "manpower"
                                  ? totals.manpower || ""
                                  : c.id === "efficiency"
                                    ? (totals.efficiency ?? "")
                                    : c.id === "yield"
                                      ? totals.yieldPct != null
                                        ? `${totals.yieldPct}%`
                                        : ""
                                      : ""}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="border-t border-slate-100 px-4 py-2 text-micro text-slate-400">
            Manpower is each batch's own: the Total adds the batches up. Efficiency = Produced ÷ (Manpower × Hours), per man-hour.
          </p>
          <ClientPager pg={pg} />
        </div>
      )}
    </div>
  );
}
