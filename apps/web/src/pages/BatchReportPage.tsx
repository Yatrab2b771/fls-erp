import { Link, useParams } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, Download, PackageOpen } from "lucide-react";
import { useBatchReportBoard, usePlansBoard, type BatchReportDetail, type BatchReportMaterial, type PlanBoardRow } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { fmtQty } from "../lib/format";
import { materialUsed, q3, utilizationDifference, yieldPct } from "../lib/utilization";
import { addReportSheet, stampedName } from "../lib/excelReport";

const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const hoursBetween = (a: string | null, b: string | null) => (a && b ? Math.round(((new Date(b).getTime() - new Date(a).getTime()) / 3_600_000) * 10) / 10 : null);
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="mb-2 text-micro font-bold uppercase tracking-wide text-slate-400">{title}</p>
      <dl className="space-y-1.5">{children}</dl>
    </div>
  );
}
function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="text-slate-500">{k}</dt>
      <dd className="text-right font-mono font-bold text-slate-800">{v}</dd>
    </div>
  );
}

// The batch's journey, in order: when each step happened and how it went. A step that has not happened yet reads "waiting".
function timelineOf(b: BatchReportDetail): { step: string; owner: string; when: string | null; detail: string }[] {
  const q = (n: number | null) => (n != null ? fmtQty(n) : "—");
  return [
    { step: "Batch created", owner: "Production", when: b.createdAt, detail: `Planned ${fmtQty(b.plannedQty)}` },
    { step: "Indent Issue", owner: "Production", when: b.indentSignedAt, detail: b.productionPlanDate ? `Production plan date ${dt(b.productionPlanDate)}` : "" },
    { step: "Batch No", owner: "R&D", when: b.batchNoAllocatedAt, detail: b.batchNo ?? "" },
    { step: "Dispensing", owner: "Day Store", when: b.dispensedAt, detail: [b.rmDispensingDate ? `RM ${dt(b.rmDispensingDate)}` : "", b.pmIssuedDate ? `PM ${dt(b.pmIssuedDate)}` : "", b.grnNo ? `GRN ${b.grnNo}` : ""].filter(Boolean).join(" · ") },
    { step: "Line Clearance", owner: "QA", when: b.lineClearanceAt, detail: b.lineClearanceStatus ? `${b.lineClearanceStatus} · checklist ${Object.values(b.lineClearanceChecks ?? {}).filter(Boolean).length} of 7 OK` : "" },
    { step: "Manufacturing started", owner: "Production", when: b.shiftStartAt, detail: [b.shift ?? "", b.manpowerCount != null ? `${b.manpowerCount} people` : ""].filter(Boolean).join(" · ") },
    { step: "Manufacturing completed", owner: "Production", when: b.completedAt ?? b.shiftEndAt, detail: b.manufacturingStatus ?? "" },
    { step: "IPQC", owner: "QA", when: null, detail: b.ipqcStatus ?? "" },
    { step: "QA Gate: Manufacturing", owner: "QA", when: null, detail: b.mfgQaStatus ? `${b.mfgQaStatus} · approved ${q(b.mfgApprovedQty)} · rejected ${q(b.mfgRejectedQty)} · wastage ${q(b.mfgWastageQty)}` : "" },
    { step: "Bulk QC", owner: "R&D", when: null, detail: b.bulkQcStatus ?? "" },
    { step: "Packaging", owner: "Production", when: b.packagingStartAt, detail: [b.packagingStatus ?? "", b.packagingEndAt ? `ended ${dt(b.packagingEndAt)}` : ""].filter(Boolean).join(" · ") },
    { step: "Handover to QA", owner: "Production", when: b.packagingEndAt && b.currentStageId !== "PACKAGING" ? b.packagingEndAt : null, detail: "" },
    { step: "FG Store", owner: "Day Store", when: b.fgStoreReceivedDate, detail: b.fgQaStatus ? `FG QC ${b.fgQaStatus}` : "" },
    { step: "Handed over to Dispatch", owner: "Day Store", when: b.handedOverToDispatchAt, detail: "" },
    { step: "Invoice", owner: "Accounts", when: b.invoiceDate, detail: "" },
    { step: "Dispatched", owner: "Dispatch", when: b.dispatchDate, detail: b.dispatchedQty ? `${fmtQty(b.dispatchedQty)} sent` : "" },
  ];
}

function UtilizationTable({ title, rows, unitNote }: { title: string; rows: BatchReportMaterial[]; unitNote: string }) {
  const ordered = [...rows.filter((m) => m.inPlan), ...rows.filter((m) => !m.inPlan)];
  const qty = (n: number) => (n ? <span className="text-slate-700">{q3(n)}</span> : <span className="text-slate-300">—</span>);
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <div className="flex items-baseline justify-between border-b border-slate-100 bg-slate-50/80 px-3 py-2">
        <p className="text-micro font-bold uppercase tracking-wide text-slate-500">{title}</p>
        <p className="text-micro text-slate-400">{unitNote}</p>
      </div>
      {ordered.length === 0 ? (
        <p className="px-3 py-4 text-xs text-slate-400">No materials on this sheet.</p>
      ) : (
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2">Material</th>
              <th className="px-3 py-2 text-right">Plan needs</th>
              <th className="px-3 py-2 text-right">Given</th>
              <th className="px-3 py-2 text-right">A · Used</th>
              <th className="px-3 py-2 text-right">B · Wastage</th>
              <th className="px-3 py-2 text-right">C · Reject</th>
              <th className="px-3 py-2 text-right">D · Sample</th>
              <th className="px-3 py-2 text-right">E · Leftover</th>
              <th className="px-3 py-2 text-right">Material Used</th>
              <th className="px-3 py-2 text-right">Difference</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {ordered.map((m) => {
              const d = utilizationDifference(m, m.givenQty);
              return (
                <tr key={m.itemId} className={m.inPlan ? "" : "bg-amber-50/50"}>
                  <td className="px-3 py-2 font-bold text-slate-700">
                    {m.itemName}
                    {!m.inPlan && <span className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-micro font-bold text-amber-700">Extra · not in plan</span>}
                    {m.extraRequestedQty > 0 && (
                      <span className="mt-0.5 block text-micro font-medium text-amber-700" title="Extra material is asked for the product, not for one batch">
                        Extra for this product: {q3(m.extraIssuedQty)} of {q3(m.extraRequestedQty)} {m.unit} issued
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{m.inPlan ? `${q3(m.requiredQty)} ${m.unit}` : <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-2 text-right font-mono">{m.givenQty ? `${q3(m.givenQty)} ${m.unit}` : <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-2 text-right font-mono font-bold">{qty(m.consumedQty)}</td>
                  <td className="px-3 py-2 text-right font-mono">{qty(m.wastedQty)}</td>
                  <td className="px-3 py-2 text-right font-mono">{qty(m.rejectedQty)}</td>
                  <td className="px-3 py-2 text-right font-mono">{qty(m.sampleQty)}</td>
                  <td className="px-3 py-2 text-right font-mono">{qty(m.returnedQty)}</td>
                  <td className="px-3 py-2 text-right font-mono font-bold text-slate-900">
                    {materialUsed(m)} {m.unit}
                    {yieldPct(m) != null && <span className="ml-1 font-sans text-micro font-bold text-emerald-700">({yieldPct(m)}%)</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {m.givenQty <= 0 && m.inPlan ? (
                      <span className="text-slate-300">—</span>
                    ) : Math.abs(d) < 0.0005 ? (
                      <span className="text-slate-400">balanced</span>
                    ) : d > 0 ? (
                      <span className="font-bold text-amber-700">
                        +{d} {m.inPlan ? "over" : "extra"}
                      </span>
                    ) : (
                      <span className="text-slate-500">{-d} left</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// One batch, start to finish: the page behind a Batch No in the Production Report. Everything is read from the batch's own record, so it
// matches what Production, the Day Store, QA and Dispatch entered on their tiles.
export function BatchReportPage() {
  const { batchId } = useParams<{ batchId: string }>();
  const { data: batches, isLoading } = useBatchReportBoard();
  const { data: board } = usePlansBoard();
  const b = (batches ?? []).find((x) => x.batchId === batchId);
  const row: PlanBoardRow | undefined = (board ?? []).find((r) => r.batches.some((x) => x.id === batchId));
  const unit = row?.unit ?? "";

  if (isLoading) return <p className="text-sm text-slate-400">Loading…</p>;
  if (!b) {
    return (
      <div className="space-y-4">
        <Link to="/production-report" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Production Report
        </Link>
        <EmptyState icon={PackageOpen} title="Batch not found" hint="It may belong to another Plant, or it was removed." />
      </div>
    );
  }

  const rm = b.materials.filter((m) => m.category === "RM");
  const pm = b.materials.filter((m) => m.category === "PM");
  const hours = hoursBetween(b.shiftStartAt, b.shiftEndAt);
  const packHours = hoursBetween(b.packagingStartAt, b.packagingEndAt);
  const yieldP = b.inputQty != null && b.outputQty != null ? pct(b.outputQty, b.inputQty) : null;
  const timeline = timelineOf(b);
  const label = b.batchNo ?? `Batch ${b.batchId.slice(0, 8)}`;

  function download() {
    if (!b) return;
    const head = { "Batch No": b.batchNo ?? "", Product: row?.productName ?? "", "PO Number": row?.poNumber ?? "", Customer: row?.customerName ?? "", Plant: row?.plant?.name ?? "" };
    const sheetRows = (list: BatchReportMaterial[]) =>
      list.map((m) => ({
        ...head,
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
      }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Batch", `FLS Batch Report - ${label}`, "This batch only", [
      {
        ...head,
        Status: b.status === "COMPLETED" ? "Completed" : "In progress",
        Unit: unit,
        "Planned Qty": b.plannedQty,
        "BOM Version Used": b.bomVersion + (b.bomVersionNote ? ` (${b.bomVersionNote})` : ""),
        Shift: b.shift ?? "",
        Manpower: b.manpowerCount ?? "",
        "Start Time": dt(b.shiftStartAt),
        "End Time": dt(b.shiftEndAt),
        Hours: hours ?? "",
        "Input Qty": b.inputQty ?? "",
        "Output Qty": b.outputQty ?? "",
        "Yield %": yieldP ?? "",
        "Packaging Shift": b.packagingShift ?? "",
        "Packaging Manpower": b.packagingManpowerCount ?? "",
        "Packaging Start": dt(b.packagingStartAt),
        "Packaging End": dt(b.packagingEndAt),
        "Packaging Hours": packHours ?? "",
        "Packaging Status": b.packagingStatus ?? "",
        "Packed Qty": b.packApprovedQty ?? "",
        "Dispatched Qty": b.dispatchedQty ?? 0,
      },
    ]);
    addReportSheet(wb, "Timeline", `FLS Batch Report - ${label} - timeline`, "This batch only", timeline.map((t) => ({ ...head, Step: t.step, Department: t.owner, When: dt(t.when), Detail: t.detail })));
    addReportSheet(wb, "RM Utilization", `FLS Batch Report - ${label} - RM Utilization`, "This batch only", sheetRows(rm));
    addReportSheet(wb, "PM Utilization", `FLS Batch Report - ${label} - PM Utilization`, "This batch only", sheetRows(pm));
    XLSX.writeFile(wb, stampedName(`FLS_Batch_${label}`));
  }

  return (
    <div className="space-y-5">
      <Link to="/production-report" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Production Report
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-micro font-bold uppercase tracking-wide text-slate-400">Batch report</p>
          <h1 className="font-mono text-2xl font-extrabold text-orange-800">{label}</h1>
          <p className="mt-1 text-sm text-slate-600">
            <span className="font-bold text-slate-800">{row?.productName ?? "—"}</span>
            {row?.poNumber ? ` · PO ${row.poNumber}` : ""}
            {row ? ` · ${row.customerName}` : ""}
            {row?.plant ? ` · ${row.plant.name}` : ""}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Planned {fmtQty(b.plannedQty)} {unit} · {b.status === "COMPLETED" ? "Manufacturing completed" : "In progress"}
          </p>
        </div>
        <button type="button" onClick={download} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50">
          <Download className="h-3.5 w-3.5" strokeWidth={2.5} /> Excel
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Card title="Production sheet">
          <Line k="Shift" v={b.shift ?? "—"} />
          <Line k="Manpower" v={b.manpowerCount != null ? String(b.manpowerCount) : "—"} />
          <Line k="Start" v={dt(b.shiftStartAt)} />
          <Line k="End" v={dt(b.shiftEndAt)} />
          <Line k="Hours" v={hours != null ? String(hours) : "—"} />
          <Line k="Man-hours" v={b.manpowerCount != null && hours != null ? String(q3(b.manpowerCount * hours)) : "—"} />
        </Card>
        <Card title="Packaging sheet">
          <Line k="Shift" v={b.packagingShift ?? "—"} />
          <Line k="Manpower" v={b.packagingManpowerCount != null ? String(b.packagingManpowerCount) : "—"} />
          <Line k="Start" v={dt(b.packagingStartAt)} />
          <Line k="End" v={dt(b.packagingEndAt)} />
          <Line k="Hours" v={packHours != null ? String(packHours) : "—"} />
          <Line k="Status" v={b.packagingStatus ?? "—"} />
        </Card>
        <Card title="Quantities">
          <Line k="Input (A+B+C+D)" v={b.inputQty != null ? `${fmtQty(b.inputQty)} ${unit}` : "—"} />
          <Line k="Output (A)" v={b.outputQty != null ? `${fmtQty(b.outputQty)} ${unit}` : "—"} />
          <Line k="Yield" v={yieldP != null ? `${yieldP}%` : "—"} />
          <Line k="Packed (QA approved)" v={b.packApprovedQty != null ? `${fmtQty(b.packApprovedQty)} ${unit}` : "—"} />
          <Line k="Packaging wastage" v={b.packWastageQty != null ? `${fmtQty(b.packWastageQty)} ${unit}` : "—"} />
          <Line k="Dispatched" v={b.dispatchedQty ? `${fmtQty(b.dispatchedQty)} ${unit}` : "—"} />
          <Line k="BOM version used" v={b.bomVersion} />
          {b.bomVersionNote && <p className="pt-1 text-micro text-slate-400">{b.bomVersionNote}</p>}
        </Card>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <p className="border-b border-slate-100 bg-slate-50/80 px-3 py-2 text-micro font-bold uppercase tracking-wide text-slate-500">Timeline</p>
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Step</th>
              <th className="px-3 py-2">Department</th>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {timeline.map((t, i) => {
              const done = !!t.when || !!t.detail;
              return (
                <tr key={t.step}>
                  <td className="px-3 py-2 font-mono text-slate-400">{i + 1}</td>
                  <td className={`px-3 py-2 font-bold ${done ? "text-slate-800" : "text-slate-400"}`}>{t.step}</td>
                  <td className="px-3 py-2 text-slate-500">{t.owner}</td>
                  <td className="px-3 py-2 text-slate-600">{t.when ? dt(t.when) : done ? "—" : <span className="text-slate-300">waiting</span>}</td>
                  <td className="px-3 py-2 text-slate-600">{t.detail}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <UtilizationTable title="RM Utilization" rows={rm} unitNote="Raw material: filled on the Batch tile" />
      <UtilizationTable title="PM Utilization" rows={pm} unitNote="Packaging material: filled on the Packaging tile" />
    </div>
  );
}
