import { Fragment, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, Check, ChevronDown, Download, ExternalLink, PauseCircle, ShieldCheck, X } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useQcAct, useQcBoard, type QcBoardRow, type QcBoardView, type QcDecision } from "../lib/qcBoardHooks";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { AgingCell, agingDays, inAgingBuckets } from "../components/AgingCell";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";
import { CustomerName } from "../components/CustomerName";
import { customerTypeLabel } from "../lib/customerTags";

// One QA/QC stage's list: every product waiting at that stage, grouped under its PO, with the whole row (PO, customer, product, batch, plant,
// quantities, shift, dates, what was filled at this stage, how long it has waited) and the actions (Approve / Hold / Reject / Open).

const STAGES: Record<string, { view: QcBoardView; title: string; blurb: string }> = {
  "line-clearance": { view: "LINE_CLEARANCE", title: "Line Clearance", blurb: "Runs waiting for QA's line clearance before production starts. Approve and the batches can be made." },
  ipqc: { view: "IPQC", title: "IPQC (In-Process QA)", blurb: "Batches whose in-process check is waiting for QA." },
  "qa-gate-mfg": { view: "QA_GATE_MFG", title: "QA Gate: Manufacturing", blurb: "Batches that finished manufacturing and wait at QA's gate." },
  "qa-gate-packaging": { view: "QA_GATE_PACKAGING", title: "QA Gate: Packaging", blurb: "Batches that finished packaging and wait at QA's gate." },
  "fg-release": { view: "FG_QC_RELEASE", title: "FG QC & Release", blurb: "Finished goods at the Day Store waiting for QA's approval. Only an Approved lets the Day Store hand them to Dispatch." },
  "on-hold": { view: "ON_HOLD", title: "On Hold", blurb: "Everything QA has put on hold, at any stage. Approve to release it, or send it back." },
};

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-");
const dayTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-");
const statusLabel = (s: string | null) => s ?? "Awaiting review";
const statusPill = (s: string | null) => (s === "Approved" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : s === "Hold" ? "border-amber-200 bg-amber-50 text-amber-700" : s ? "border-rose-200 bg-rose-50 text-rose-700" : "border-slate-200 bg-slate-50 text-slate-500");
const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

export function QcStagePage() {
  const { slug } = useParams<{ slug: string }>();
  const stage = STAGES[slug ?? ""];
  if (!stage) return <EmptyState icon={ShieldCheck} title="Unknown QC stage" accent="rose" />;
  return <QcStageList key={slug} stage={stage} slug={slug!} />;
}

function QcStageList({ stage, slug }: { stage: { view: QcBoardView; title: string; blurb: string }; slug: string }) {
  const { hasRole } = useAuth();
  const canAct = hasRole("QA_QC", "ADMIN");
  const { data, isLoading } = useQcBoard(stage.view);
  const filters = useTileFilters();
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<QcDecision>("APPROVE");
  const everyRow = data ?? [];
  const isBatchStage = stage.view !== "LINE_CLEARANCE";
  const isHoldView = stage.view === "ON_HOLD";
  const picked = (key: string) => filters.applied.picks[key] ?? [];

  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct(everyRow.map((r) => r.poNumber)) },
    { key: "customer", label: "Customer", options: distinct(everyRow.map((r) => r.customerName)) },
    { key: "category", label: "Product Category", options: distinct(everyRow.map((r) => r.productCategory)) },
    { key: "product", label: "Product", options: distinct(everyRow.map((r) => r.productName)) },
    ...(isBatchStage ? [{ key: "batch", label: "Batch No.", options: distinct(everyRow.map((r) => r.batchNo)) }] : []),
    { key: "plant", label: "Plant", options: distinct(everyRow.map((r) => r.plantName)) },
    ...(isHoldView ? [{ key: "stage", label: "Stage", options: distinct(everyRow.map((r) => r.stageLabel)) }] : []),
    { key: "status", label: "QA Status", options: ["Awaiting review", "Approved", "Hold", "Not Approved"] },
    ...(isBatchStage ? [{ key: "shift", label: "Shift", options: distinct(everyRow.map((r) => r.shift)) }] : []),
    AGING_FIELD,
  ];

  const rows = useMemo(() => {
    const { dateFrom, dateTo } = filters.applied;
    return everyRow
      .filter(
        (r) =>
          (!picked("po").length || picked("po").includes(r.poNumber ?? "")) &&
          (!picked("customer").length || picked("customer").includes(r.customerName)) &&
          (!picked("category").length || picked("category").includes(r.productCategory ?? "")) &&
          (!picked("product").length || picked("product").includes(r.productName)) &&
          (!picked("batch").length || picked("batch").includes(r.batchNo ?? "")) &&
          (!picked("plant").length || picked("plant").includes(r.plantName ?? "")) &&
          (!picked("stage").length || picked("stage").includes(r.stageLabel)) &&
          (!picked("status").length || picked("status").includes(statusLabel(r.qaStatus === "Not approved" ? "Not Approved" : r.qaStatus))) &&
          (!picked("shift").length || picked("shift").includes(r.shift ?? "")) &&
          inAgingBuckets(agingDays(r.waitingSince), picked("aging")) &&
          (!dateFrom || r.waitingSince.slice(0, 10) >= dateFrom) &&
          (!dateTo || r.waitingSince.slice(0, 10) <= dateTo),
      )
      .sort((a, b) => (a.poNumber ?? "").localeCompare(b.poNumber ?? "", undefined, { numeric: true }) || a.productName.localeCompare(b.productName) || (a.batchNo ?? "").localeCompare(b.batchNo ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyRow, filters.applied]);

  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;
  const poCount = new Set(rows.map((r) => r.poId)).size;

  function download() {
    const lines = rows.map((r) => ({
      "PO Number": r.poNumber ?? "",
      "QA Status": statusLabel(r.qaStatus),
      "QC Status": r.qcStatus ?? "",
      Customer: r.customerName,
      "Customer Type": customerTypeLabel(r.customerName),
      Product: r.productName,
      Category: r.productCategory ?? "",
      ...(isHoldView ? { Stage: r.stageLabel } : {}),
      "Batch No.": r.batchNo ?? "",
      Plant: r.plantName ?? "",
      Unit: r.unit,
      "Planned Qty": r.plannedQty,
      "Output Qty": r.outputQty ?? "",
      Shift: r.shift ?? "",
      Manpower: r.manpowerCount ?? "",
      "Manufacturing Start": dayTime(r.manufacturingStart),
      "Manufacturing End": dayTime(r.manufacturingEnd),
      "PO Delivery Date": day(r.expectedDeliveryDate),
      "Approved Qty": r.approvedQty ?? "",
      "Rejected Qty": r.rejectedQty ?? "",
      "Wastage Qty": r.wastageQty ?? "",
      Remarks: r.remarks ?? "",
      "Waiting Since": day(r.waitingSince),
      "Waiting (days)": agingDays(r.waitingSince) ?? "",
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, stage.title, `FLS QC: ${stage.title}`, describeFilters(filters, fields, "Waiting since"), lines);
    XLSX.writeFile(wb, stampedName(`FLS_QC_${slug.replace(/-/g, "_")}`));
  }

  // Gate and finished-goods stages carry quantities (approved / rejected / wastage); the mixed On Hold list shows them too.
  const showQty = stage.view === "QA_GATE_MFG" || stage.view === "QA_GATE_PACKAGING" || stage.view === "FG_QC_RELEASE" || stage.view === "ON_HOLD";
  const colCount = 12 + (isBatchStage ? 6 : 0) + (isHoldView ? 1 : 0) + (showQty ? 3 : 0);

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-sky-500/10 text-sky-600">
            <ShieldCheck className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{stage.title}</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} {isBatchStage ? "batch" : "run"}
              {rows.length === 1 ? "" : isBatchStage ? "es" : "s"} in {poCount} PO{poCount === 1 ? "" : "s"}
              {isFiltered ? ` (of ${everyRow.length})` : ""}. {stage.blurb}
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey={`qc-${slug}`} fields={fields} dateLabel="Waiting since" />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={ShieldCheck} title={isFiltered ? "Nothing matches these filters" : "Nothing waiting here"} hint="Items show up here as they reach this stage." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2.5">PO</th>
                  <th className="px-3 py-2.5">QA status</th>
                  <th className="px-3 py-2.5">QC status</th>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="px-3 py-2.5">Category</th>
                  <th className="px-3 py-2.5">Product</th>
                  {isHoldView && <th className="px-3 py-2.5">Stage</th>}
                  {isBatchStage && <th className="px-3 py-2.5">Batch</th>}
                  <th className="px-3 py-2.5">Plant</th>
                  <th className="px-3 py-2.5 text-right">Planned</th>
                  {isBatchStage && <th className="px-3 py-2.5 text-right">Output</th>}
                  {isBatchStage && <th className="px-3 py-2.5">Shift</th>}
                  {isBatchStage && <th className="px-3 py-2.5 text-right">Manpower</th>}
                  {isBatchStage && <th className="px-3 py-2.5">Mfg start</th>}
                  {isBatchStage && <th className="px-3 py-2.5">Mfg end</th>}
                  <th className="px-3 py-2.5">Delivery</th>
                  {showQty && <th className="px-3 py-2.5 text-right">Approved</th>}
                  {showQty && <th className="px-3 py-2.5 text-right">Rejected</th>}
                  {showQty && <th className="px-3 py-2.5 text-right">Wastage</th>}
                  <th className="px-3 py-2.5">Remarks</th>
                  <th className="px-3 py-2.5">Waiting</th>
                  <th className="sticky right-0 bg-white px-3 py-2.5 text-right shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.15)]">Action</th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r, i) => {
                  const newPo = i === 0 || pg.rows[i - 1]!.poId !== r.poId;
                  const open = openId === r.id + r.stage;
                  return (
                    <Fragment key={r.id + r.stage}>
                      <tr className={`border-b border-slate-50 ${newPo && i > 0 ? "border-t-2 border-t-slate-200" : ""} ${r.isHold ? "bg-amber-50/30" : ""}`}>
                        <td className="px-3 py-2.5 font-mono text-slate-700">{r.poNumber ?? "-"}</td>
                        <td className="px-3 py-2.5">
                          <span className={`pill ${statusPill(r.qaStatus)}`}>{statusLabel(r.qaStatus)}</span>
                        </td>
                        <td className="px-3 py-2.5">{r.qcStatus ? <span className={`pill ${statusPill(r.qcStatus)}`}>{r.qcStatus}</span> : <span className="text-slate-300">-</span>}</td>
                        <td className="px-3 py-2.5 text-slate-600"><CustomerName name={r.customerName} /></td>
                        <td className="px-3 py-2.5 text-slate-600">{r.productCategory ?? "-"}</td>
                        <td className="px-3 py-2.5 font-bold text-slate-800">{r.productName}</td>
                        {isHoldView && <td className="px-3 py-2.5 text-slate-600">{r.stageLabel}</td>}
                        {isBatchStage && <td className="px-3 py-2.5 font-mono text-slate-600">{r.batchNo ?? "-"}</td>}
                        <td className="px-3 py-2.5 text-slate-600">{r.plantName ?? "-"}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-slate-700">{fmtQty(r.plannedQty)} {r.unit}</td>
                        {isBatchStage && <td className="px-3 py-2.5 text-right font-mono text-slate-700">{r.outputQty != null ? `${fmtQty(r.outputQty)} ${r.unit}` : "-"}</td>}
                        {isBatchStage && <td className="px-3 py-2.5 text-slate-600">{r.shift ?? "-"}</td>}
                        {isBatchStage && <td className="px-3 py-2.5 text-right font-mono text-slate-600">{r.manpowerCount ?? "-"}</td>}
                        {isBatchStage && <td className="px-3 py-2.5 text-slate-600">{dayTime(r.manufacturingStart)}</td>}
                        {isBatchStage && <td className="px-3 py-2.5 text-slate-600">{dayTime(r.manufacturingEnd)}</td>}
                        <td className="px-3 py-2.5 text-slate-600">{day(r.expectedDeliveryDate)}</td>
                        {showQty && <td className="px-3 py-2.5 text-right font-mono text-emerald-700">{r.approvedQty != null ? fmtQty(r.approvedQty) : "-"}</td>}
                        {showQty && <td className="px-3 py-2.5 text-right font-mono text-rose-700">{r.rejectedQty != null ? fmtQty(r.rejectedQty) : "-"}</td>}
                        {showQty && <td className="px-3 py-2.5 text-right font-mono text-amber-700">{r.wastageQty != null ? fmtQty(r.wastageQty) : "-"}</td>}
                        <td className="max-w-[16rem] truncate px-3 py-2.5 text-slate-600" title={r.remarks ?? ""}>{r.remarks ?? "-"}</td>
                        <td className="px-3 py-2.5"><AgingCell since={r.waitingSince} /></td>
                        <td className={`sticky right-0 px-3 py-2.5 text-right shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.15)] ${r.isHold ? "bg-amber-50" : "bg-white"}`}>
                          <ActionMenu
                            canAct={canAct}
                            isHold={r.isHold}
                            link={r.link}
                            onPick={(m) => { setOpenId(open && mode === m ? null : r.id + r.stage); setMode(m); }}
                          />
                        </td>
                      </tr>
                      {open && canAct && (
                        <tr className="border-b border-slate-100">
                          <td colSpan={colCount} className="whitespace-normal bg-slate-50/70 px-4 py-4">
                            <div className="sticky left-4 max-w-[min(100%,70rem)]">
                              <ActionForm row={r} mode={mode} onMode={setMode} onDone={() => setOpenId(null)} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ClientPager pg={pg} />
        </div>
      )}
    </div>
  );
}

// The row actions in one dropdown. It is drawn on top of the page, outside the table, so the table scrolling never clips it.
function ActionMenu({ canAct, isHold, link, onPick }: { canAct: boolean; isHold: boolean; link: string; onPick: (m: QcDecision) => void }) {
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const item = "flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold hover:bg-slate-50";

  function toggle(e: React.MouseEvent<HTMLButtonElement>) {
    if (pos) return setPos(null);
    const r = e.currentTarget.getBoundingClientRect();
    const right = window.innerWidth - r.right;
    // Open upward when the button is near the bottom of the screen.
    setPos(r.bottom + 190 > window.innerHeight ? { bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right });
  }
  const pick = (m: QcDecision) => {
    setPos(null);
    onPick(m);
  };

  return (
    <>
      <button type="button" className="btn-ghost btn-sm" onClick={toggle} aria-haspopup="menu" aria-expanded={!!pos}>
        Actions <ChevronDown className={`h-3 w-3 transition-transform ${pos ? "rotate-180" : ""}`} strokeWidth={2.5} />
      </button>
      {pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setPos(null)} />
            <div role="menu" className="fixed z-50 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-left shadow-lift" style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}>
              {canAct && (
                <button type="button" role="menuitem" className={`${item} text-emerald-700`} onClick={() => pick("APPROVE")}>
                  <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> Approve
                </button>
              )}
              {canAct && !isHold && (
                <button type="button" role="menuitem" className={`${item} text-amber-700`} onClick={() => pick("HOLD")}>
                  <PauseCircle className="h-3.5 w-3.5" strokeWidth={2.5} /> Put on hold
                </button>
              )}
              {canAct && (
                <button type="button" role="menuitem" className={`${item} text-rose-600`} onClick={() => pick("REJECT")}>
                  <X className="h-3.5 w-3.5" strokeWidth={2.5} /> Reject (send back)
                </button>
              )}
              <Link to={link} role="menuitem" className={`${item} border-t border-slate-100 text-slate-700`} onClick={() => setPos(null)}>
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={2.5} /> Open full page
              </Link>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

const MODE_COPY: Record<QcDecision, { title: string; button: string; tone: string }> = {
  APPROVE: { title: "Approve", button: "Confirm approve", tone: "btn-primary" },
  HOLD: { title: "Put on hold", button: "Confirm hold", tone: "btn-ghost" },
  REJECT: { title: "Send back", button: "Confirm send back", tone: "btn-danger" },
};

function ActionForm({ row, mode, onMode, onDone }: { row: QcBoardRow; mode: QcDecision; onMode: (m: QcDecision) => void; onDone: () => void }) {
  const toast = useToast();
  const act = useQcAct();
  const isGate = row.stage === "QA_GATE_MFG" || row.stage === "QA_GATE_PACKAGING";
  const [remarks, setRemarks] = useState(row.remarks ?? "");
  const [approved, setApproved] = useState(String(row.approvedQty ?? row.outputQty ?? ""));
  const [rejected, setRejected] = useState(String(row.rejectedQty ?? 0));
  const [wastage, setWastage] = useState(String(row.wastageQty ?? 0));
  const [error, setError] = useState<string | null>(null);
  const copy = MODE_COPY[mode];
  const needsReason = mode !== "APPROVE";

  async function submit() {
    setError(null);
    if (needsReason && !remarks.trim()) return setError(mode === "HOLD" ? "Write why it is on hold." : "Write why it is sent back.");
    try {
      await act.mutateAsync({
        row,
        decision: mode,
        remarks,
        ...(isGate && mode !== "REJECT" ? { approvedQty: Number(approved) || 0, rejectedQty: Number(rejected) || 0, wastageQty: Number(wastage) || 0 } : {}),
      });
      toast.success(mode === "APPROVE" ? `Approved: ${row.productName}${row.batchNo ? ` (${row.batchNo})` : ""}.` : mode === "HOLD" ? "Put on hold." : "Sent back to the stage before.");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-bold text-slate-700">
          {copy.title}: {row.productName}
          {row.batchNo ? ` (batch ${row.batchNo})` : ""} <ChevronDown className="inline h-3 w-3 -rotate-90 text-slate-300" /> {row.stageLabel}
        </p>
        <div className="ml-auto flex gap-1">
          {(["APPROVE", "HOLD", "REJECT"] as QcDecision[]).map((m) => (
            <button key={m} type="button" onClick={() => onMode(m)} className={`pill cursor-pointer ${m === mode ? "border-brand-300 bg-brand-50 text-brand-700 ring-2 ring-brand-200" : "border-slate-200 bg-white text-slate-500"}`}>
              {MODE_COPY[m].title}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        {isGate && mode !== "REJECT" && (
          <>
            <div>
              <label className="mb-0.5 block text-micro text-slate-400">Approved qty ({row.unit})</label>
              <input type="number" min="0" step="any" className="field !py-1.5 text-xs" value={approved} onChange={(e) => setApproved(e.target.value)} />
            </div>
            <div>
              <label className="mb-0.5 block text-micro text-slate-400">Rejected qty</label>
              <input type="number" min="0" step="any" className="field !py-1.5 text-xs" value={rejected} onChange={(e) => setRejected(e.target.value)} />
            </div>
            <div>
              <label className="mb-0.5 block text-micro text-slate-400">Wastage qty</label>
              <input type="number" min="0" step="any" className="field !py-1.5 text-xs" value={wastage} onChange={(e) => setWastage(e.target.value)} />
            </div>
          </>
        )}
        <div className={isGate && mode !== "REJECT" ? "" : "sm:col-span-3"}>
          <label className="mb-0.5 block text-micro text-slate-400">{needsReason ? "Reason (required)" : "Remarks (optional)"}</label>
          <input className="field !py-1.5 text-xs" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={needsReason ? "Why?" : "Anything to note"} />
        </div>
        <div className="flex items-end sm:col-start-4">
          <button type="button" className={`${copy.tone} btn-sm w-full`} disabled={act.isPending} onClick={submit}>
            {act.isPending ? "Saving..." : copy.button}
          </button>
        </div>
      </div>
      {mode === "HOLD" && <p className="text-micro text-slate-500">Hold keeps it at this stage and tells everyone it is waiting on QA. Approve it later to release it.</p>}
      {mode === "REJECT" && <p className="text-micro text-slate-500">Sends it back to the stage before, with your reason.</p>}
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
    </div>
  );
}
