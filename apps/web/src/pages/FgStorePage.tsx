import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ChevronDown, Download, PackageCheck, Send } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useMyStoreInfo } from "../lib/hooks";
import { useFgStageForward, useFgStoreBoard, type FgBatchRow, type FgStoreStage } from "../lib/fgHooks";
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

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const today = () => new Date().toISOString().slice(0, 10);
const APPROVAL = ["Approved", "Not approved", "Hold"] as const;

const STAGE_COPY: Record<FgStoreStage, { tab: string; title: string; blurb: string; open: string }> = {
  FG_STORE: { tab: "To receive", title: "Receive finished goods", blurb: "Batches QA has passed at the packaging gate. Record that you received the finished goods.", open: "Receive" },
  FG_QC_RELEASE: { tab: "Waiting for QA", title: "Finished goods approval", blurb: "Finished goods held at the Store, waiting for QA's approval.", open: "Approve" },
  FG_HANDOVER: { tab: "To hand over", title: "Hand over to Dispatch", blurb: "Finished goods QA has approved. Hand them over to Dispatch, who ships them to the customer or the Warehouse.", open: "Hand over" },
};
const STATUS_PILL: Record<FgStoreStage, string> = {
  FG_STORE: "border-sky-200 bg-sky-50 text-sky-700",
  FG_QC_RELEASE: "border-amber-200 bg-amber-50 text-amber-700",
  FG_HANDOVER: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

type Row = FgBatchRow & { stage: FgStoreStage };

// The Day Store's Finished Goods tile (receive, wait for QA, hand over to Dispatch) and QA's Finished Goods Approval tile are the same page with
// different stages: finished goods stay with the Day Store of the batch's Plant until Dispatch has them. The Store's page is ONE list of every batch
// (its Status says where it is: to receive, waiting for QA, to hand over) narrowed with the filters; the Excel report is exactly what the filters show.
export function FgStorePage({ stages, heading, blurb, tileKey }: { stages: FgStoreStage[]; heading: string; blurb: string; tileKey: string }) {
  const { hasRole } = useAuth();
  const { data: myStore } = useMyStoreInfo({ enabled: hasRole("STORE") });
  const isDayStore = hasRole("ADMIN") || (hasRole("STORE") && !!myStore?.scoped);
  const boards = {
    FG_STORE: useFgStoreBoard("FG_STORE", { enabled: stages.includes("FG_STORE") }),
    FG_QC_RELEASE: useFgStoreBoard("FG_QC_RELEASE", { enabled: stages.includes("FG_QC_RELEASE") }),
    FG_HANDOVER: useFgStoreBoard("FG_HANDOVER", { enabled: stages.includes("FG_HANDOVER") }),
  };
  const multi = stages.length > 1;
  const isLoading = stages.some((s) => boards[s].isLoading);
  const filters = useTileFilters();
  const [openId, setOpenId] = useState<string | null>(null);
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const everyRow: Row[] = stages.flatMap((s) => (boards[s].data ?? []).map((r) => ({ ...r, stage: s })));
  const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const showPlant = distinct(everyRow.map((r) => r.plantName)).length > 1;
  const fields: FilterField[] = [
    ...(multi ? [{ key: "status", label: "Status", options: stages.map((s) => STAGE_COPY[s].tab) }] : []),
    { key: "po", label: "PO Number", options: distinct(everyRow.map((r) => r.poNumber)) },
    { key: "customer", label: "Customer", options: distinct(everyRow.map((r) => r.customerName)) },
    { key: "product", label: "Product", options: distinct(everyRow.map((r) => r.productName)) },
    { key: "type", label: "Product Type", options: distinct(everyRow.map((r) => r.productCategory)) },
    { key: "batch", label: "Batch No", options: distinct(everyRow.map((r) => r.batchNo)) },
    ...(showPlant ? [{ key: "plant", label: "Plant", options: distinct(everyRow.map((r) => r.plantName)) }] : []),
    AGING_FIELD,
  ];
  const any = (key: string, value: string) => !picked(key).length || picked(key).includes(value);
  const rows = everyRow.filter((r) => {
    const arrived = (r.fgStoreReceivedDate ?? r.waitingSince).slice(0, 10);
    return (
      any("status", STAGE_COPY[r.stage].tab) &&
      any("po", r.poNumber ?? "") &&
      any("customer", r.customerName) &&
      any("product", r.productName) &&
      any("type", r.productCategory ?? "") &&
      any("batch", r.batchNo ?? "") &&
      any("plant", r.plantName ?? "") &&
      inAgingBuckets(agingDays(r.waitingSince), picked("aging")) &&
      (!filters.applied.dateFrom || arrived >= filters.applied.dateFrom) &&
      (!filters.applied.dateTo || arrived <= filters.applied.dateTo)
    );
  });
  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;
  const canActOn = (r: Row) => (r.stage === "FG_QC_RELEASE" ? hasRole("QA_QC", "ADMIN") : isDayStore);
  const columns = 7 + (showPlant ? 1 : 0) + (multi ? 1 : 0);

  function download() {
    const lines = rows.map((r) => ({
      Status: STAGE_COPY[r.stage].tab,
      "PO Number": r.poNumber ?? "",
      Customer: r.customerName,
      "Customer Type": customerTypeLabel(r.customerName),
      Product: r.productName,
      "Product Type": r.productCategory ?? "",
      Batch: r.batchNo ?? "",
      Plant: r.plantName ?? "",
      Unit: r.unit,
      "Approved Qty": r.approvedQty,
      "Shipped Qty": r.shippedQty,
      "Remaining Qty": r.remainingQty,
      "Received Date": day(r.fgStoreReceivedDate),
      "QA Status": r.fgQaStatus ?? "",
      "QC Status": r.fgQcStatus ?? "",
      Remarks: r.fgRemarks ?? r.fgStoreRemarks ?? "",
      "Waiting Since": day(r.waitingSince),
      "Aging (days)": agingDays(r.waitingSince) ?? "",
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Finished Goods", `FLS Finished Goods${multi ? "" : `: ${STAGE_COPY[stages[0]!].tab}`}`, describeFilters(filters, fields, "Received"), lines, { totals: ["Approved Qty", "Shipped Qty", "Remaining Qty"] });
    XLSX.writeFile(wb, stampedName("FLS_Finished_Goods"));
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-emerald-500/10 text-emerald-600">
            <PackageCheck className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{heading}</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} batch{rows.length === 1 ? "" : "es"}
              {isFiltered ? ` of ${everyRow.length}` : ""}. {multi ? "To receive, waiting for QA and to hand over to Dispatch: narrow them with the filters (the Status filter picks the step)." : blurb}
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm shrink-0" disabled={rows.length === 0} onClick={download} title="Downloads exactly the rows the filters show">
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel{isFiltered ? " (Filtered)" : ""}
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey={tileKey} fields={fields} dateLabel="Received" />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={PackageCheck} title={isFiltered ? "Nothing matches these filters" : "Nothing waiting here"} hint="Batches show up as they reach the Store." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2.5">PO</th>
                  <th className="px-4 py-2.5">Product</th>
                  <th className="px-4 py-2.5">Batch</th>
                  {showPlant && <th className="px-4 py-2.5">Plant</th>}
                  {multi && <th className="px-4 py-2.5">Status</th>}
                  <th className="px-4 py-2.5 text-right">Approved qty</th>
                  <th className="px-4 py-2.5">Received</th>
                  <th className="px-4 py-2.5">Aging</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r) => {
                  const open = openId === r.batchId;
                  const canAct = canActOn(r);
                  return (
                    <Fragment key={r.batchId}>
                      <tr className="border-b border-slate-50">
                        <td className="px-4 py-2.5 font-mono text-slate-600">{r.poNumber ?? "—"}</td>
                        <td className="px-4 py-2.5 font-bold text-slate-800">
                          {r.productName}
                          <span className="block text-micro font-normal text-slate-400"><CustomerName name={r.customerName} /></span>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-slate-600">{r.batchNo ?? "—"}</td>
                        {showPlant && <td className="px-4 py-2.5 text-slate-600">{r.plantName ?? "—"}</td>}
                        {multi && (
                          <td className="px-4 py-2.5">
                            <span className={`pill ${STATUS_PILL[r.stage]}`}>{STAGE_COPY[r.stage].tab}</span>
                          </td>
                        )}
                        <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                          {fmtQty(r.approvedQty)} {r.unit}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{day(r.fgStoreReceivedDate)}</td>
                        <td className="px-4 py-2.5">
                          <AgingCell since={r.waitingSince} />
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenId(open ? null : r.batchId)}>
                            {canAct ? STAGE_COPY[r.stage].open : "View"} <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-slate-100">
                          <td colSpan={columns} className="whitespace-normal bg-slate-50/70 px-4 py-4">
                            <FgForm stage={r.stage} row={r} canAct={canAct} onDone={() => setOpenId(null)} />
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

function FgForm({ stage, row, canAct, onDone }: { stage: FgStoreStage; row: FgBatchRow; canAct: boolean; onDone: () => void }) {
  const toast = useToast();
  const forward = useFgStageForward();
  const [receivedDate, setReceivedDate] = useState(row.fgStoreReceivedDate?.slice(0, 10) ?? today());
  const [remarks, setRemarks] = useState(stage === "FG_STORE" ? (row.fgStoreRemarks ?? "") : (row.fgRemarks ?? ""));
  const [qa, setQa] = useState(row.fgQaStatus ?? "");
  const [qc, setQc] = useState(row.fgQcStatus ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      if (stage === "FG_STORE") {
        await forward.mutateAsync({ batchId: row.batchId, fgStoreReceivedDate: receivedDate || undefined, fgStoreRemarks: remarks.trim() || undefined });
        toast.success("Received. The goods stay here, waiting for QA's approval.");
      } else if (stage === "FG_QC_RELEASE") {
        if (!qa) return setError("Choose the QA status.");
        await forward.mutateAsync({ batchId: row.batchId, fgQaStatus: qa, fgQcStatus: qc || undefined, fgRemarks: remarks.trim() || undefined });
        if (qa === "Approved") toast.success("Approved. The Store can now hand the finished goods to Dispatch.");
        else toast.error("Saved, but they move on only when the QA status is Approved.");
      } else {
        await forward.mutateAsync({ batchId: row.batchId });
        toast.success("Handed over to Dispatch.");
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
      {stage === "FG_STORE" && (
        <>
          <div>
            <label className="mb-0.5 block text-micro text-slate-400">Received date</label>
            <input type="date" className="field !py-1.5 text-xs" value={receivedDate} disabled={!canAct} onChange={(e) => setReceivedDate(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-0.5 block text-micro text-slate-400">Remarks</label>
            <input className="field !py-1.5 text-xs" value={remarks} disabled={!canAct} onChange={(e) => setRemarks(e.target.value)} />
          </div>
        </>
      )}
      {stage === "FG_QC_RELEASE" && (
        <>
          <div>
            <label className="mb-0.5 block text-micro text-slate-400">QA status</label>
            <select className="field !py-1.5 text-xs" value={qa} disabled={!canAct} onChange={(e) => setQa(e.target.value)}>
              <option value="">— choose —</option>
              {APPROVAL.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-0.5 block text-micro text-slate-400">QC status</label>
            <select className="field !py-1.5 text-xs" value={qc} disabled={!canAct} onChange={(e) => setQc(e.target.value)}>
              <option value="">— choose —</option>
              {APPROVAL.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-0.5 block text-micro text-slate-400">Remarks</label>
            <input className="field !py-1.5 text-xs" value={remarks} disabled={!canAct} onChange={(e) => setRemarks(e.target.value)} />
          </div>
        </>
      )}
      {stage === "FG_HANDOVER" && (
        <p className="text-xs text-slate-600 sm:col-span-3">
          QA approved {fmtQty(row.approvedQty)} {row.unit} of {row.productName}
          {row.batchNo ? ` (batch ${row.batchNo})` : ""}. Handing over tells Dispatch they have it.
        </p>
      )}
      <div className="flex items-end">
        {canAct ? (
          <button type="button" className="btn-primary btn-sm w-full" disabled={forward.isPending} onClick={submit}>
            <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {forward.isPending ? "Saving…" : stage === "FG_STORE" ? "Receive" : stage === "FG_QC_RELEASE" ? "Save approval" : "Hand over to Dispatch"}
          </button>
        ) : (
          <p className="text-micro text-slate-400">{stage === "FG_QC_RELEASE" ? "Waiting for QA." : "Only the Store of this Plant does this step."}</p>
        )}
      </div>
      {stage === "FG_STORE" && canAct && <p className="text-micro text-slate-400 sm:col-span-4">The goods stay in the Store. QA checks them here; then you hand them over to Dispatch.</p>}
      {error && <p className="text-xs font-bold text-rose-600 sm:col-span-4">{error}</p>}
    </div>
  );
}
