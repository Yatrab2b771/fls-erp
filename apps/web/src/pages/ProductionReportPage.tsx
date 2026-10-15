import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ChevronDown, ClipboardList, Download, PackageOpen } from "lucide-react";
import { useBatchReportBoard, useHandoverBoard, usePlansBoard, type BatchReportDetail, type BatchReportMaterial, type BoardMaterial, type HandoverRow } from "../lib/hooks";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { AgingCell, agingDays, inAgingBuckets } from "../components/AgingCell";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { fmtQty } from "../lib/format";
import { materialUsed, q3, utilizationDifference, yieldPct } from "../lib/utilization";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";
import { REPORT_STATUS_LABEL, summarize, toReportBatches, type ProductReport, type ReportBatch, type ReportStatus } from "../lib/productionReport";
import { CustomerName } from "../components/CustomerName";
import { customerTypeLabel } from "../lib/customerTags";

const STATUS_PILL: Record<ReportStatus, string> = {
  NO_BATCHES: "border-slate-200 bg-slate-50 text-slate-500",
  IN_PRODUCTION: "border-violet-200 bg-violet-50 text-violet-700",
  PRODUCTION_DONE: "border-amber-200 bg-amber-50 text-amber-700",
  HANDED_OVER: "border-emerald-200 bg-emerald-50 text-emerald-700",
};
const YIELD_BUCKETS = [
  { label: "Below 90%", ok: (y: number | null) => y != null && y < 90 },
  { label: "90% to 95%", ok: (y: number | null) => y != null && y >= 90 && y < 95 },
  { label: "95% to 100%", ok: (y: number | null) => y != null && y >= 95 },
  { label: "No yield yet", ok: (y: number | null) => y == null },
];
const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="mb-1.5 text-micro font-bold uppercase tracking-wide text-slate-400">{title}</p>
      <dl className="space-y-1">{children}</dl>
    </div>
  );
}
function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="text-slate-500">{k}</dt>
      <dd className="font-mono font-bold text-slate-800">{v}</dd>
    </div>
  );
}

// Day / Night (and "No shift set") split of a product batches.
function shiftRows(batches: ReportBatch[]) {
  return (["Day", "Night", null] as const)
    .map((shift) => {
      const of = batches.filter((b) => b.shift === shift);
      const input = of.reduce((s, b) => s + (b.inputQty ?? 0), 0);
      const output = of.reduce((s, b) => s + (b.outputQty ?? 0), 0);
      return {
        label: shift ?? "No shift set",
        batches: of.length,
        hours: q3(of.reduce((s, b) => s + (b.hours ?? 0), 0)),
        manpower: of.reduce((s, b) => s + (b.manpower ?? 0), 0),
        output: q3(output),
        yieldPct: input > 0 ? Math.round((output / input) * 1000) / 10 : null,
      };
    })
    .filter((s) => s.batches > 0);
}

// A product material across all its batches, one line per material.
function materialRows(batches: ReportBatch[]): BoardMaterial[] {
  const map = new Map<string, BoardMaterial>();
  for (const b of batches)
    for (const m of b.materials) {
      const cur = map.get(m.itemId);
      if (!cur) map.set(m.itemId, { ...m });
      else {
        cur.consumedQty += m.consumedQty;
        cur.wastedQty += m.wastedQty;
        cur.rejectedQty += m.rejectedQty;
        cur.sampleQty += m.sampleQty;
        cur.returnedQty += m.returnedQty;
      }
    }
  return [...map.values()];
}

// Production's fourth tile: the full report of each product (PO line): how many batches, which shifts, how much manpower and hours, what was
// produced, the material it took, and what has gone over to Dispatch. Batch-wise detail is in the dropdown; the whole list downloads as Excel.
export function ProductionReportPage() {
  const { data: board, isLoading } = usePlansBoard();
  const { data: handoverRows } = useHandoverBoard();
  const { data: batchDetails } = useBatchReportBoard();
  const detailOf = new Map<string, BatchReportDetail>((batchDetails ?? []).map((d) => [d.batchId, d]));
  const filters = useTileFilters();
  const [openId, setOpenId] = useState<string | null>(null);
  const picked = (key: string) => filters.applied.picks[key] ?? [];

  const handover = new Map<string, HandoverRow>((handoverRows ?? []).map((h) => [h.batchId, h]));
  const all = (board ?? []).filter((r) => r.batches.length > 0 || !!r.run).map((r) => ({ row: r, batches: toReportBatches(r, handover, detailOf) }));
  const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const showPlant = distinct(all.map((a) => a.row.plant?.name)).length > 1;

  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct(all.map((a) => a.row.poNumber)) },
    { key: "customer", label: "Customer", options: distinct(all.map((a) => a.row.customerName)) },
    { key: "product", label: "Product", options: distinct(all.map((a) => a.row.productName)) },
    { key: "type", label: "Product Type", options: distinct(all.map((a) => a.row.productCategory)) },
    ...(showPlant ? [{ key: "plant", label: "Plant", options: distinct(all.map((a) => a.row.plant?.name)) }] : []),
    { key: "status", label: "Status", options: Object.values(REPORT_STATUS_LABEL) },
    { key: "batchno", label: "Batch No", options: distinct(all.flatMap((a) => a.batches.map((b) => b.batchNo))) },
    { key: "shift", label: "Shift", options: ["Day", "Night"] },
    { key: "bstatus", label: "Batch Status", options: ["In progress", "Completed"] },
    { key: "handover", label: "Handover", options: ["Handed over", "Not handed over"] },
    { key: "yield", label: "Yield", options: YIELD_BUCKETS.map((b) => b.label) },
    AGING_FIELD,
  ];

  const batchOk = (b: ReportBatch) =>
    (!picked("batchno").length || picked("batchno").includes(b.batchNo ?? "")) &&
    (!picked("shift").length || picked("shift").includes(b.shift ?? "")) &&
    (!picked("bstatus").length || picked("bstatus").includes(b.inProgress ? "In progress" : "Completed")) &&
    (!picked("handover").length || picked("handover").includes(b.handedOverAt ? "Handed over" : "Not handed over")) &&
    (!picked("yield").length || YIELD_BUCKETS.some((y) => picked("yield").includes(y.label) && y.ok(b.yieldPct)));
  const batchFiltered = ["batchno", "shift", "bstatus", "handover", "yield"].some((k) => picked(k).length > 0);
  const from = filters.applied.dateFrom;
  const to = filters.applied.dateTo;

  const reports: ProductReport[] = all
    .filter(
      ({ row }) =>
        (!picked("po").length || picked("po").includes(row.poNumber ?? "")) &&
        (!picked("customer").length || picked("customer").includes(row.customerName)) &&
        (!picked("product").length || picked("product").includes(row.productName)) &&
        (!picked("type").length || picked("type").includes(row.productCategory ?? "")) &&
        (!picked("plant").length || picked("plant").includes(row.plant?.name ?? "")) &&
        (!from || row.sentAt.slice(0, 10) >= from) &&
        (!to || row.sentAt.slice(0, 10) <= to) &&
        inAgingBuckets(agingDays(row.sentAt), picked("aging")),
    )
    .map(({ row, batches }) => summarize(row, batchFiltered ? batches.filter(batchOk) : batches))
    .filter((r) => (!batchFiltered || r.batches.length > 0) && (!picked("status").length || picked("status").includes(REPORT_STATUS_LABEL[r.status])));
  const pg = useClientPaging(reports);
  const isFiltered = filters.activeCount > 0;

  function download() {
    const filterText = describeFilters(filters, fields, "Plan sent on");
    const productHead = (row: ProductReport["row"]) => ({ "PO Number": row.poNumber ?? "", Customer: row.customerName, "Customer Type": customerTypeLabel(row.customerName), Product: row.productName, "Product Type": row.productCategory ?? "", Plant: row.plant?.name ?? "" });

    const summary = reports.map(({ row, totals: t, status, batches }) => ({
      ...productHead(row),
      Status: REPORT_STATUS_LABEL[status],
      "Batch Nos": batches.map((b) => b.batchNo).filter(Boolean).join(", "),
      Unit: row.unit,
      "Ordered Qty": row.quantity,
      "Released Qty": row.releasedQty,
      Batches: t.batches,
      "Batches Completed": t.completed,
      "Batches Running": t.inProgress,
      "Day Shift Batches": t.dayBatches,
      "Night Shift Batches": t.nightBatches,
      "Hours Worked": t.hours,
      "Total Manpower": t.manpowerTotal,
      "Avg Manpower": t.manpowerAvg ?? "",
      "Max Manpower": t.manpowerMax ?? "",
      "Man-Hours": t.manHours,
      "Output per Man-Hour": t.productivity ?? "",
      "Planned Qty": t.planned,
      "Input Qty": t.input,
      "Output Qty": t.output,
      "Wastage Qty": t.wastage,
      "Yield %": t.yieldPct ?? "",
      "RM Used": t.rmUsed,
      "RM Wasted": t.rmWasted,
      "RM Yield %": t.rmYieldPct ?? "",
      "Handed Over Batches": t.handedBatches,
      "Handed Over Qty": t.handedQty,
      "With Production Qty": t.pendingQty,
      "Dispatched Qty": t.dispatchedQty,
      "First Start": t.firstStart ? dt(t.firstStart) : "",
      "Last End": t.lastEnd ? dt(t.lastEnd) : "",
    }));

    const shifts = reports.flatMap(({ row, batches }) => shiftRows(batches).map((sh) => ({ ...productHead(row), Shift: sh.label, Batches: sh.batches, Hours: sh.hours, Manpower: sh.manpower, "Output Qty": sh.output, "Yield %": sh.yieldPct ?? "" })));

    const materials = reports.flatMap(({ row, batches }) =>
      materialRows(batches).map((m) => ({
        ...productHead(row),
        Material: m.itemName,
        Category: m.category === "RM" ? "Raw Material" : "Packaging Material",
        Unit: m.unit,
        "A - Production": q3(m.consumedQty),
        "B - Wastage": q3(m.wastedQty),
        "C - Rejected": q3(m.rejectedQty),
        "D - Sample": q3(m.sampleQty),
        "E - Return to Store": q3(m.returnedQty),
        "Material Used (A+B+C+D-E)": materialUsed(m),
        "Yield % (A / Used)": yieldPct(m) ?? "",
      })),
    );

    // One row per batch, shown from different angles: what it is, who worked, what it made, what it used, where it went.
    const perBatch = <T extends Record<string, unknown>>(build: (b: ReportBatch, row: ProductReport["row"]) => T) => reports.flatMap(({ row, batches }) => batches.map((b) => ({ ...productHead(row), "Batch No": b.batchNo ?? "", ...build(b, row) })));

    const batchesSheet = perBatch((b, row) => ({
      Shift: b.shift ?? "",
      Status: b.inProgress ? "In progress" : "Completed",
      "Start Time": b.startAt ? dt(b.startAt) : "",
      "End Time": b.endAt ? dt(b.endAt) : "",
      Hours: b.hours ?? "",
      Unit: row.unit,
      "Planned Qty": b.plannedQty,
    }));

    const manpowerSheet = perBatch((b) => ({
      Shift: b.shift ?? "",
      Manpower: b.manpower ?? "",
      Hours: b.hours ?? "",
      "Man-Hours": b.manpower != null && b.hours != null ? q3(b.manpower * b.hours) : "",
      "Output Qty": b.outputQty ?? "",
      "Output per Man-Hour": b.manpower != null && b.hours != null && b.hours > 0 && b.outputQty != null ? Math.round((b.outputQty / (b.manpower * b.hours)) * 100) / 100 : "",
    }));

    const outputSheet = perBatch((b, row) => ({
      Unit: row.unit,
      "Packaging Status": b.packagingStatus ?? "",
      "Planned Qty": b.plannedQty,
      "Input Qty": b.inputQty ?? "",
      "Output Qty": b.outputQty ?? "",
      "Wastage Qty": b.wastageQty ?? "",
      "Yield %": b.yieldPct ?? "",
      "Packed Qty": b.packedQty ?? "",
    }));

    const batchMaterials = reports.flatMap(({ row, batches }) =>
      batches.flatMap((b) =>
        b.materials.map((m) => ({
          ...productHead(row),
          "Batch No": b.batchNo ?? "",
          Material: m.itemName,
          Category: m.category === "RM" ? "Raw Material" : "Packaging Material",
          Unit: m.unit,
          "A - Production": q3(m.consumedQty),
          "B - Wastage": q3(m.wastedQty),
          "C - Rejected": q3(m.rejectedQty),
          "D - Sample": q3(m.sampleQty),
          "E - Return to Store": q3(m.returnedQty),
          "Material Used (A+B+C+D-E)": materialUsed(m),
          "Yield % (A / Used)": yieldPct(m) ?? "",
        })),
      ),
    );

    const dispatchSheet = perBatch((b, row) => ({
      Unit: row.unit,
      "Output Qty": b.outputQty ?? "",
      "Now At": b.nowAt,
      Handover: b.handedOverAt ? "Handed over" : b.inProgress ? "Still manufacturing" : "Not handed over yet",
      "Handed Over On": b.handedOverAt ? dt(b.handedOverAt) : "",
      "Dispatched Qty": b.dispatchedQty,
    }));

    // Utilization of each batch, RM and PM apart: what the plan needs for the batch, what the Day Store gave, A used, B wastage, C reject,
    // D sample, E leftover and the Difference. Material used outside the plan is marked Extra.
    const utilizationSheet = (category: "RM" | "PM") =>
      reports.flatMap(({ row, batches }) =>
        batches.flatMap((b) =>
          (detailOf.get(b.id)?.materials ?? [])
            .filter((m: BatchReportMaterial) => m.category === category)
            .map((m: BatchReportMaterial) => ({
              ...productHead(row),
              "Batch No": b.batchNo ?? "",
              Material: m.itemName,
              Unit: m.unit,
              "In Plan": m.inPlan ? "Yes" : "Extra (not in plan)",
              "Plan Needs": m.inPlan ? m.requiredQty : "",
              Given: m.givenQty,
              "Extra Asked (product)": m.extraRequestedQty || "",
              "Extra Issued (product)": m.extraIssuedQty || "",
              "A - Used": m.consumedQty,
              "B - Wastage": m.wastedQty,
              "C - Reject": m.rejectedQty,
              "D - Sample": m.sampleQty,
              "E - Leftover": m.returnedQty,
              "Material Used (A+B+C+D)": materialUsed(m),
              "Yield %": yieldPct(m) ?? "",
              "Difference (A..E - Given)": utilizationDifference(m, m.givenQty),
            })),
        ),
      );

    // Packaging's own sheet: shift, manpower, start and end, hours, status and what was packed.
    const packagingSheet = perBatch((b, row) => {
      const d = detailOf.get(b.id);
      const hrs = d?.packagingStartAt && d.packagingEndAt ? Math.round(((new Date(d.packagingEndAt).getTime() - new Date(d.packagingStartAt).getTime()) / 3_600_000) * 10) / 10 : "";
      return {
        Unit: row.unit,
        "Packaging Shift": d?.packagingShift ?? "",
        "Packaging Manpower": d?.packagingManpowerCount ?? "",
        "Packaging Start": d?.packagingStartAt ? dt(d.packagingStartAt) : "",
        "Packaging End": d?.packagingEndAt ? dt(d.packagingEndAt) : "",
        "Packaging Hours": hrs,
        "Man-Hours": hrs !== "" && d?.packagingManpowerCount != null ? q3(d.packagingManpowerCount * hrs) : "",
        "Packaging Status": d?.packagingStatus ?? "",
        "Packed Qty (QA approved)": d?.packApprovedQty ?? "",
        "Packaging Wastage": d?.packWastageQty ?? "",
        "Packaging Remarks": d?.packagingRemarks ?? "",
      };
    });

    // The batch's journey: when each step happened, one row per batch.
    const timelineSheet = perBatch((b) => {
      const d = detailOf.get(b.id);
      return {
        "Batch Created": d ? dt(d.createdAt) : "",
        "Indent Signed": d?.indentSignedAt ? dt(d.indentSignedAt) : "",
        "Batch No Allocated": d?.batchNoAllocatedAt ? dt(d.batchNoAllocatedAt) : "",
        "Dispensed": d?.dispensedAt ? dt(d.dispensedAt) : "",
        "Line Clearance": d?.lineClearanceStatus ? `${d.lineClearanceStatus}${d.lineClearanceAt ? ` (${dt(d.lineClearanceAt)})` : ""}` : "",
        "Manufacturing Start": d?.shiftStartAt ? dt(d.shiftStartAt) : "",
        "Manufacturing End": d?.shiftEndAt ? dt(d.shiftEndAt) : "",
        "Manufacturing Completed": d?.completedAt ? dt(d.completedAt) : "",
        IPQC: d?.ipqcStatus ?? "",
        "QA Gate (Mfg)": d?.mfgQaStatus ?? "",
        "Bulk QC": d?.bulkQcStatus ?? "",
        "Packaging Start": d?.packagingStartAt ? dt(d.packagingStartAt) : "",
        "Packaging End": d?.packagingEndAt ? dt(d.packagingEndAt) : "",
        "FG Store Received": d?.fgStoreReceivedDate ? dt(d.fgStoreReceivedDate) : "",
        "Handed Over to Dispatch": d?.handedOverToDispatchAt ? dt(d.handedOverToDispatchAt) : "",
        "Invoice Date": d?.invoiceDate ? dt(d.invoiceDate) : "",
        "Dispatch Date": d?.dispatchDate ? dt(d.dispatchDate) : "",
        "Now At": b.nowAt,
      };
    });

    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Summary", "FLS Production Report - product summary", filterText, summary, {
      totals: ["Ordered Qty", "Released Qty", "Batches", "Batches Completed", "Batches Running", "Day Shift Batches", "Night Shift Batches", "Hours Worked", "Total Manpower", "Man-Hours", "Planned Qty", "Input Qty", "Output Qty", "Wastage Qty", "RM Used", "RM Wasted", "Handed Over Batches", "Handed Over Qty", "With Production Qty", "Dispatched Qty"],
    });
    addReportSheet(wb, "Batches", "FLS Production Report - batches (shift and time)", filterText, batchesSheet, { totals: ["Hours", "Planned Qty"] });
    addReportSheet(wb, "Shift-wise", "FLS Production Report - shift-wise", filterText, shifts, { totals: ["Batches", "Hours", "Manpower", "Output Qty"] });
    addReportSheet(wb, "Manpower", "FLS Production Report - manpower (batch-wise)", filterText, manpowerSheet, { totals: ["Manpower", "Hours", "Man-Hours", "Output Qty"] });
    addReportSheet(wb, "Output & Yield", "FLS Production Report - output and yield (batch-wise)", filterText, outputSheet, { totals: ["Planned Qty", "Input Qty", "Output Qty", "Wastage Qty", "Packed Qty"] });
    addReportSheet(wb, "Material (Product)", "FLS Production Report - material, product-wise (all batches)", filterText, materials);
    addReportSheet(wb, "Material (Batch)", "FLS Production Report - material, batch-wise", filterText, batchMaterials);
    addReportSheet(wb, "RM Utilization (Batch)", "FLS Production Report - RM Utilization, batch-wise", filterText, utilizationSheet("RM"), { totals: ["Plan Needs", "Given", "A - Used", "B - Wastage", "C - Reject", "D - Sample", "E - Leftover", "Material Used (A+B+C+D)"] });
    addReportSheet(wb, "PM Utilization (Batch)", "FLS Production Report - PM Utilization, batch-wise", filterText, utilizationSheet("PM"), { totals: ["Plan Needs", "Given", "A - Used", "B - Wastage", "C - Reject", "D - Sample", "E - Leftover", "Material Used (A+B+C+D)"] });
    addReportSheet(wb, "Packaging (Batch)", "FLS Production Report - packaging, batch-wise (shift, manpower, time)", filterText, packagingSheet, { totals: ["Packaging Manpower", "Packaging Hours", "Man-Hours", "Packed Qty (QA approved)", "Packaging Wastage"] });
    addReportSheet(wb, "Batch Timeline", "FLS Production Report - batch timeline", filterText, timelineSheet);
    addReportSheet(wb, "Handover & Dispatch", "FLS Production Report - hand-over to Dispatch (batch-wise)", filterText, dispatchSheet, { totals: ["Output Qty", "Dispatched Qty"] });
    XLSX.writeFile(wb, stampedName("FLS_Production_Report"));
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-violet-500/10 text-violet-600">
            <ClipboardList className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Production Report</h1>
            <p className="text-sm text-slate-500">
              {reports.length.toLocaleString()} product{reports.length === 1 ? "" : "s"}
              {isFiltered ? ` of ${all.length}` : ""} — batches, shifts, manpower, output, material and hand-over to Dispatch. Open Batch-wise for each batch.
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm" disabled={reports.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey="production-report" fields={fields} dateLabel="Plan sent on" />

      {isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : reports.length === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "Nothing to report yet"} hint={isFiltered ? "Nothing matches these filters." : "A product shows here once its production run has started."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-3 py-3">PO Number</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Customer</th>
                <th className="px-3 py-3">Product</th>
                <th className="px-3 py-3">Batch No</th>
                <th className="px-3 py-3">Type</th>
                {showPlant && <th className="px-3 py-3">Plant</th>}
                <th className="px-3 py-3 text-right">Ordered</th>
                <th className="px-3 py-3">Batches</th>
                <th className="px-3 py-3">Produced</th>
                <th className="px-3 py-3">Aging</th>
                <th className="px-3 py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((r) => {
                const { row, totals: t } = r;
                const open = openId === row.itemId;
                return (
                  <Fragment key={row.itemId}>
                    <tr className={`align-top transition hover:bg-slate-50 ${open ? "bg-slate-50/70" : ""}`}>
                      <td className="px-3 py-3 font-semibold text-slate-700">{row.poNumber ?? "—"}</td>
                      <td className="px-3 py-3">
                        <span className={`pill ${STATUS_PILL[r.status]}`}>{REPORT_STATUS_LABEL[r.status]}</span>
                      </td>
                      <td className="px-3 py-3 text-slate-600"><CustomerName name={row.customerName} /></td>
                      <td className="px-3 py-3 font-bold text-slate-800">{row.productName}</td>
                      <td className="px-3 py-3">
                        {(() => {
                          const nos = r.batches.map((b) => b.batchNo).filter((n): n is string => !!n);
                          if (nos.length === 0) return <span className="text-slate-300">—</span>;
                          return (
                            <span className="font-mono font-bold text-orange-800" title={nos.join(", ")}>
                              {nos.slice(0, 2).join(", ")}
                              {nos.length > 2 && <span className="ml-1 font-sans text-micro font-bold text-slate-400">+{nos.length - 2} more</span>}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-3 text-slate-600">{row.productCategory ?? "—"}</td>
                      {showPlant && <td className="px-3 py-3 text-slate-600">{row.plant?.name ?? "—"}</td>}
                      <td className="px-3 py-3 text-right font-mono text-slate-800">
                        {fmtQty(row.quantity)} {row.unit}
                        {row.releasedQty < row.quantity - 1e-6 && <span className="block font-sans text-micro font-bold text-amber-600">Released {fmtQty(row.releasedQty)}</span>}
                      </td>
                      <td className="px-3 py-3">
                        <b className="font-mono text-slate-800">{t.batches}</b>
                        <span className="block text-micro text-slate-400">
                          {t.completed} done · {t.inProgress} running
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <b className="font-mono text-slate-800">
                          {fmtQty(t.output)} {row.unit}
                        </b>
                        <span className="block text-micro text-slate-400">
                          in {fmtQty(t.input)} · wastage {fmtQty(t.wastage)}
                          {t.yieldPct != null ? ` · yield ${t.yieldPct}%` : ""}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <AgingCell since={row.sentAt} />
                      </td>
                      <td className="px-3 py-3">
                        <button
                          type="button"
                          onClick={() => setOpenId(open ? null : row.itemId)}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-tiny font-bold transition ${open ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                        >
                          Batch-wise ({t.batches}) <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={11 + (showPlant ? 1 : 0)} className="px-4 py-4">
                          {r.batches.length === 0 ? (
                            <p className="text-xs text-slate-500">No batches yet.</p>
                          ) : (
                            <div className="space-y-4">
                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                <Card title="Shifts">
                                  <Line k="Day shift" v={`${t.dayBatches} batch${t.dayBatches === 1 ? "" : "es"}`} />
                                  <Line k="Night shift" v={`${t.nightBatches} batch${t.nightBatches === 1 ? "" : "es"}`} />
                                  <Line k="Hours worked" v={t.hours ? `${t.hours} h` : "—"} />
                                  <Line k="First start" v={dt(t.firstStart)} />
                                  <Line k="Last end" v={dt(t.lastEnd)} />
                                </Card>
                                <Card title="Manpower">
                                  <Line k="Total (all batches)" v={t.manpowerTotal ? String(t.manpowerTotal) : "—"} />
                                  <Line k="Average per batch" v={t.manpowerAvg != null ? String(t.manpowerAvg) : "—"} />
                                  <Line k="Most in a batch" v={t.manpowerMax != null ? String(t.manpowerMax) : "—"} />
                                  <Line k="Man-hours" v={t.manHours ? String(t.manHours) : "—"} />
                                  <Line k="Output per man-hour" v={t.productivity != null ? `${t.productivity} ${row.unit}` : "—"} />
                                </Card>
                                <Card title="Output">
                                  <Line k="Planned" v={`${fmtQty(t.planned)} ${row.unit}`} />
                                  <Line k="Input" v={`${fmtQty(t.input)} ${row.unit}`} />
                                  <Line k="Output" v={`${fmtQty(t.output)} ${row.unit}`} />
                                  <Line k="Wastage" v={`${fmtQty(t.wastage)} ${row.unit}`} />
                                  <Line k="Yield" v={t.yieldPct != null ? `${t.yieldPct}%` : "—"} />
                                  <Line k="Against order" v={`${row.quantity ? Math.round((t.output / row.quantity) * 100) : 0}% of ${fmtQty(row.quantity)} ${row.unit}`} />
                                </Card>
                                <Card title="Raw material">
                                  <Line k="Used" v={t.rmUsed ? fmtQty(t.rmUsed) : "—"} />
                                  <Line k="Wasted" v={t.rmWasted ? fmtQty(t.rmWasted) : "—"} />
                                  <Line k="Yield" v={t.rmYieldPct != null ? `${t.rmYieldPct}%` : "—"} />
                                </Card>
                                <Card title="Hand-over to Dispatch">
                                  <Line k="Handed over" v={`${t.handedBatches} batch${t.handedBatches === 1 ? "" : "es"} · ${fmtQty(t.handedQty)} ${row.unit}`} />
                                  <Line k="With Production" v={`${fmtQty(t.pendingQty)} ${row.unit}`} />
                                  <Line k="Dispatched" v={`${fmtQty(t.dispatchedQty)} ${row.unit}`} />
                                </Card>
                              </div>

                              <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                                <p className="border-b border-slate-100 bg-slate-50/80 px-3 py-2 text-micro font-bold uppercase tracking-wide text-slate-500">Shift-wise</p>
                                <table className="w-full whitespace-nowrap text-xs">
                                  <thead>
                                    <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                                      <th className="px-3 py-2">Shift</th>
                                      <th className="px-3 py-2 text-right">Batches</th>
                                      <th className="px-3 py-2 text-right">Hours</th>
                                      <th className="px-3 py-2 text-right">Manpower</th>
                                      <th className="px-3 py-2 text-right">Output</th>
                                      <th className="px-3 py-2 text-right">Yield</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-100">
                                    {shiftRows(r.batches).map((sh) => (
                                      <tr key={sh.label}>
                                        <td className="px-3 py-2 font-bold text-slate-700">{sh.label}</td>
                                        <td className="px-3 py-2 text-right font-mono">{sh.batches}</td>
                                        <td className="px-3 py-2 text-right font-mono">{sh.hours || "—"}</td>
                                        <td className="px-3 py-2 text-right font-mono">{sh.manpower || "—"}</td>
                                        <td className="px-3 py-2 text-right font-mono font-bold text-slate-800">
                                          {fmtQty(sh.output)} {row.unit}
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono font-bold text-emerald-700">{sh.yieldPct != null ? `${sh.yieldPct}%` : "—"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>

                              {materialRows(r.batches).length > 0 && (
                                <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                                  <p className="border-b border-slate-100 bg-slate-50/80 px-3 py-2 text-micro font-bold uppercase tracking-wide text-slate-500">Material (all batches)</p>
                                  <table className="w-full whitespace-nowrap text-xs">
                                    <thead>
                                      <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                                        <th className="px-3 py-2">Material</th>
                                        <th className="px-3 py-2 text-right">A · Production</th>
                                        <th className="px-3 py-2 text-right">B · Wastage</th>
                                        <th className="px-3 py-2 text-right">C · Rejected</th>
                                        <th className="px-3 py-2 text-right">D · Sample</th>
                                        <th className="px-3 py-2 text-right">E · Return</th>
                                        <th className="px-3 py-2 text-right">Used</th>
                                        <th className="px-3 py-2 text-right">Yield</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100">
                                      {materialRows(r.batches).map((m) => (
                                        <tr key={m.itemId}>
                                          <td className="px-3 py-2 font-bold text-slate-700">{m.itemName}</td>
                                          {[m.consumedQty, m.wastedQty, m.rejectedQty, m.sampleQty, m.returnedQty].map((qty, i) => (
                                            <td key={i} className={`px-3 py-2 text-right font-mono ${qty ? "text-slate-800" : "text-slate-300"}`}>
                                              {qty ? `${q3(qty)} ${m.unit}` : "—"}
                                            </td>
                                          ))}
                                          <td className="px-3 py-2 text-right font-mono font-bold text-slate-900">
                                            {materialUsed(m)} {m.unit}
                                          </td>
                                          <td className="px-3 py-2 text-right font-mono font-bold text-emerald-700">{yieldPct(m) != null ? `${yieldPct(m)}%` : "—"}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}

                            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                              <p className="border-b border-slate-100 bg-slate-50/80 px-3 py-2 text-micro font-bold uppercase tracking-wide text-slate-500">Batch-wise</p>
                              <table className="w-full whitespace-nowrap text-xs">
                                <thead>
                                  <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                                    <th className="px-3 py-2">Batch</th>
                                    <th className="px-3 py-2">Shift</th>
                                    <th className="px-3 py-2 text-right">Manpower</th>
                                    <th className="px-3 py-2">Start</th>
                                    <th className="px-3 py-2">End</th>
                                    <th className="px-3 py-2 text-right">Hours</th>
                                    <th className="px-3 py-2 text-right">Planned</th>
                                    <th className="px-3 py-2 text-right">Input</th>
                                    <th className="px-3 py-2 text-right">Output</th>
                                    <th className="px-3 py-2 text-right">Wastage</th>
                                    <th className="px-3 py-2 text-right">Yield</th>
                                    <th className="px-3 py-2 text-right" title="Raw material used by this batch (A+B+C+D-E)">RM used</th>
                                    <th className="px-3 py-2">Packaging</th>
                                    <th className="px-3 py-2">Now at</th>
                                    <th className="px-3 py-2">Handed over</th>
                                    <th className="px-3 py-2 text-right">Dispatched</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {r.batches.map((b) => {
                                    const rm = q3(b.materials.filter((m) => m.category === "RM").reduce((s, m) => s + materialUsed(m), 0));
                                    return (
                                      <tr key={b.id}>
                                        <td className="px-3 py-2 font-bold text-slate-700">
                                          <Link to={`/production-report/batch/${b.id}`} className="font-mono text-orange-800 underline decoration-orange-300 underline-offset-2 hover:text-brand-600" title="Open this batch's full report">
                                            {b.batchNo ?? `Batch ${b.id.slice(0, 8)}`}
                                          </Link>
                                        </td>
                                        <td className="px-3 py-2 text-slate-600">{b.shift ?? "—"}</td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-800">{b.manpower ?? "—"}</td>
                                        <td className="px-3 py-2 text-slate-500">{dt(b.startAt)}</td>
                                        <td className="px-3 py-2 text-slate-500">{dt(b.endAt)}</td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-700">{b.hours ?? "—"}</td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-700">{fmtQty(b.plannedQty)}</td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-700">{b.inputQty != null ? fmtQty(b.inputQty) : "—"}</td>
                                        <td className="px-3 py-2 text-right font-mono font-bold text-slate-800">{b.outputQty != null ? fmtQty(b.outputQty) : "—"}</td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-700">{b.wastageQty != null ? fmtQty(b.wastageQty) : "—"}</td>
                                        <td className="px-3 py-2 text-right font-mono font-bold text-emerald-700">{b.yieldPct != null ? `${b.yieldPct}%` : "—"}</td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-700">{rm ? fmtQty(rm) : "—"}</td>
                                        <td className="px-3 py-2 text-slate-600">{b.packagingStatus ?? "—"}</td>
                                        <td className="px-3 py-2 text-slate-600">{b.nowAt}</td>
                                        <td className="px-3 py-2 text-slate-500">{b.handedOverAt ? dt(b.handedOverAt) : "—"}</td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-700">{b.dispatchedQty ? fmtQty(b.dispatchedQty) : "—"}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                            </div>
                          )}
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
