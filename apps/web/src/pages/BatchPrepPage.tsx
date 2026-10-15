import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ChevronDown, ClipboardList, Download, Hash, Send, ShieldCheck } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useBatchPrepAction, useCorrectBatchNo, usePrepBoard, type BatchPrepRow } from "../lib/hooks";
import type { BatchPrepStageId } from "../lib/types";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";
import { CustomerName } from "../components/CustomerName";
import { customerTypeLabel } from "../lib/customerTags";

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const today = () => new Date().toISOString().slice(0, 10);

type Stage = Exclude<BatchPrepStageId, "READY">;

// One page for the four steps every batch goes through before its production, each on its own tile and each done by its own department:
//   Indent Issue (Production) -> Batch No (R&D) -> Dispensing (Day Store) -> Line Clearance (QA)
const STAGE_INFO: Record<Stage, { title: string; tileKey: string; role: "PRODUCTION" | "RND" | "STORE" | "QA_QC"; icon: typeof ClipboardList; accent: string; blurb: string; empty: string }> = {
  INDENT_ISSUE: { title: "Indent Issue", tileKey: "batch-indent", role: "PRODUCTION", icon: ClipboardList, accent: "bg-amber-500/10 text-amber-600", blurb: "Sign the indent of each batch. The materials come from the plan, scaled to the batch's quantity. R&D gives the batch number next.", empty: "A batch shows here once Production has divided a plan into batches (New Plan)." },
  BATCH_NO: { title: "Batch No", tileKey: "batch-no", role: "RND", icon: Hash, accent: "bg-orange-500/10 text-orange-600", blurb: "Allocate the batch number. The system gives the next serial (FLS-26-0001, ...), never repeated. The numbers you have given stay in the list (a number can be changed until the batch is dispensed).", empty: "A batch shows here once Production has signed its indent." },
  DISPENSING: { title: "Dispensing", tileKey: "batch-dispensing", role: "STORE", icon: Send, accent: "bg-emerald-500/10 text-emerald-600", blurb: "Dispense each batch's material to the Plant: only what that batch needs. QA clears the line next.", empty: "A batch shows here once R&D has given it a batch number." },
  LINE_CLEARANCE: { title: "Line Clearance", tileKey: "batch-line-clearance", role: "QA_QC", icon: ShieldCheck, accent: "bg-violet-500/10 text-violet-600", blurb: "Clear the line for each batch. Approved lets Production start the batch.", empty: "A batch shows here once the Day Store has dispensed its material." },
};

export function BatchPrepPage({ stage }: { stage: Stage }) {
  const info = STAGE_INFO[stage];
  const { hasRole } = useAuth();
  const canAct = hasRole(info.role, "ADMIN");
  // R&D's Batch No list also shows the numbers it has already allocated (and where those batches are now).
  const { data, isLoading } = usePrepBoard(stage, { all: stage === "BATCH_NO" });
  const filters = useTileFilters();
  const [openId, setOpenId] = useState<string | null>(null);
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const everyRow = data ?? [];
  const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const showPlant = distinct(everyRow.map((r) => r.plant?.name)).length > 1;
  const withNo = stage !== "INDENT_ISSUE";
  const waitingCount = stage === "BATCH_NO" ? everyRow.filter((r) => r.prepStageId === "BATCH_NO").length : everyRow.length;

  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct(everyRow.map((r) => r.poNumber)) },
    { key: "product", label: "Product", options: distinct(everyRow.map((r) => r.productName)) },
    ...(withNo ? [{ key: "batchno", label: "Batch No", options: distinct(everyRow.map((r) => r.batchNo)) }] : []),
    ...(stage === "BATCH_NO" ? [{ key: "bnstatus", label: "Status", options: ["Waiting for number", "Allocated"] }] : []),
    ...(showPlant ? [{ key: "plant", label: "Plant", options: distinct(everyRow.map((r) => r.plant?.name)) }] : []),
  ];
  const rows = everyRow.filter(
    (r) =>
      (!picked("po").length || picked("po").includes(r.poNumber ?? "")) &&
      (!picked("product").length || picked("product").includes(r.productName)) &&
      (!picked("batchno").length || picked("batchno").includes(r.batchNo ?? "")) &&
      (!picked("bnstatus").length || picked("bnstatus").includes(r.prepStageId === "BATCH_NO" ? "Waiting for number" : "Allocated")) &&
      (!picked("plant").length || picked("plant").includes(r.plant?.name ?? "")),
  );
  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;
  const Icon = info.icon;

  function download() {
    const lines = rows.map((r) => ({
      "Batch No": r.batchNo ?? "",
      "PO Number": r.poNumber ?? "",
      Customer: r.customerName,
      "Customer Type": customerTypeLabel(r.customerName),
      Product: r.productName,
      Plant: r.plant?.name ?? "",
      "Batch Qty": r.plannedQty,
      Unit: r.unit,
      "Indent Slip": r.prodIndentSlipSign ?? "",
      "Indent Signed": day(r.indentSignedAt),
      "Batch No Allocated": day(r.batchNoAllocatedAt),
      "Dispensed On": day(r.dispensedAt),
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, info.title, `FLS ${info.title} (batch-wise)`, describeFilters(filters, fields), lines);
    XLSX.writeFile(wb, stampedName(`FLS_${info.title.replace(/\s+/g, "_")}`));
  }

  const cols = 5 + (showPlant ? 1 : 0);
  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className={`stat-icon ${info.accent}`}>
            <Icon className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{info.title}</h1>
            <p className="text-sm text-slate-500">
              {(stage === "BATCH_NO" ? waitingCount : rows.length).toLocaleString()} batch{(stage === "BATCH_NO" ? waitingCount : rows.length) === 1 ? "" : "es"}
              {stage !== "BATCH_NO" && isFiltered ? ` of ${everyRow.length}` : ""} waiting. {info.blurb}
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey={info.tileKey} fields={fields} dateLabel="Waiting since" hideDates />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Icon} title={isFiltered ? "Nothing matches these filters" : `No batch waiting for ${info.title}`} hint={info.empty} />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2.5">Batch</th>
                  <th className="px-4 py-2.5">Product</th>
                  {showPlant && <th className="px-4 py-2.5">Plant</th>}
                  <th className="px-4 py-2.5 text-right">Quantity</th>
                  <th className="px-4 py-2.5">{stage === "INDENT_ISSUE" ? "Indent" : stage === "BATCH_NO" ? "Indent signed" : stage === "DISPENSING" ? "Material" : "Dispensed"}</th>
                  <th className="px-4 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r, i) => {
                  const open = openId === r.id;
                  const notEnough = (r.requirements ?? []).filter((m) => !m.enough).length;
                  return (
                    <Fragment key={r.id}>
                      <tr className="border-b border-slate-50 align-top">
                        <td className="px-4 py-2.5">{r.batchNo ? <span className="font-mono font-black text-orange-800">{r.batchNo}</span> : <span className="text-slate-400">Batch {i + 1 + (pg.page - 1) * pg.pageSize}</span>}</td>
                        <td className="px-4 py-2.5 font-bold text-slate-800">
                          {r.productName}
                          <span className="block text-micro font-normal text-slate-400">
                            {r.poNumber ?? "—"} · <CustomerName name={r.customerName} />
                          </span>
                        </td>
                        {showPlant && <td className="px-4 py-2.5 text-slate-600">{r.plant?.name ?? "—"}</td>}
                        <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                          {fmtQty(r.plannedQty)} {r.unit}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {stage === "INDENT_ISSUE" && (
                            <>
                              <span className="text-slate-400">Not signed</span>
                              <span className="block text-micro text-slate-400">{(r.requirements ?? []).length} material{(r.requirements ?? []).length === 1 ? "" : "s"}{notEnough > 0 ? ` · ${notEnough} short` : ""}</span>
                            </>
                          )}
                          {stage === "BATCH_NO" && (
                            <>
                              {r.prepStageId === "BATCH_NO" ? (
                                <>
                                  {r.prodIndentSlipSign ?? "—"}
                                  <span className="block text-micro text-slate-400">Indent signed {day(r.indentSignedAt)}</span>
                                </>
                              ) : (
                                <>
                                  <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Allocated {day(r.batchNoAllocatedAt)}</span>
                                  <span className="block text-micro text-slate-400">
                                    Now at {r.batchStatus === "COMPLETED" ? "Completed" : ({ DISPENSING: "Dispensing", LINE_CLEARANCE: "Line Clearance", READY: "Production" } as Record<string, string>)[r.prepStageId] ?? r.prepStageId}
                                  </span>
                                </>
                              )}
                            </>
                          )}
                          {stage === "DISPENSING" && (
                            <span className={`pill ${notEnough === 0 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
                              {(r.requirements ?? []).length} material{(r.requirements ?? []).length === 1 ? "" : "s"}
                              {notEnough > 0 ? ` · ${notEnough} short` : " · all available"}
                            </span>
                          )}
                          {stage === "LINE_CLEARANCE" && (
                            <>
                              {day(r.dispensedAt)}
                              {r.lineClearanceStatus && <span className="block text-micro font-bold text-amber-600">{r.lineClearanceStatus}</span>}
                            </>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {stage === "BATCH_NO" && canAct ? (
                            r.prepStageId === "BATCH_NO" ? <AllocateCell row={r} /> : <CorrectCell row={r} />
                          ) : stage === "BATCH_NO" ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenId(open ? null : r.id)}>
                              {canAct ? (stage === "INDENT_ISSUE" ? "Sign indent" : stage === "DISPENSING" ? "Dispense" : "Clear the line") : "View"}{" "}
                              <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                            </button>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-slate-100">
                          <td colSpan={cols} className="whitespace-normal bg-slate-50/70 px-4 py-4">
                            {stage === "INDENT_ISSUE" && <IndentForm row={r} canAct={canAct} onDone={() => setOpenId(null)} />}
                            {stage === "DISPENSING" && <DispenseForm row={r} canAct={canAct} onDone={() => setOpenId(null)} />}
                            {stage === "LINE_CLEARANCE" && <LineClearanceForm row={r} canAct={canAct} onDone={() => setOpenId(null)} />}
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

// The plan's materials for this batch (the plan scaled to the batch's quantity) and whether the Plant and its Day Store hold them.
// How far a weighed quantity may be from the plan before the Day Store has to say why (the server enforces the same 5%).
const WEIGH_TOLERANCE = 0.05;
type Weighed = Record<string, { qty: string; note: string }>;
const deviates = (planned: number, weighed: string) => weighed !== "" && planned > 0 && Math.abs(Number(weighed) - planned) / planned > WEIGH_TOLERANCE;

function RequirementsTable({ row, weighing }: { row: BatchPrepRow; weighing?: { values: Weighed; onChange: (itemId: string, patch: Partial<Weighed[string]>) => void; disabled: boolean } }) {
  const reqs = row.requirements ?? [];
  return (
    <>
      <p className="label">
          Material of this batch ({fmtQty(row.plannedQty)} {row.unit})
      </p>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full whitespace-nowrap text-xs">
            <thead className="bg-slate-50 text-micro font-bold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">Material</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-right">Needed</th>
                <th className="px-3 py-2 text-right">Free at Plant</th>
                <th className="px-3 py-2 text-right">At Day Store</th>
                <th className="px-3 py-2 text-left">Status</th>
                {weighing && <th className="px-3 py-2 text-left">Weighed (if different)</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {reqs.length === 0 && (
                <tr>
                  <td colSpan={weighing ? 7 : 6} className="px-3 py-4 text-center text-slate-400">
                    No plan material for this product.
                  </td>
                </tr>
              )}
              {reqs.map((m) => (
                <tr key={m.itemId}>
                  <td className="px-3 py-1.5 font-bold text-slate-700">{m.itemName}</td>
                  <td className="px-3 py-1.5 text-slate-500">{m.category}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">
                    {fmtQty(m.requiredQty)} {m.unit}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">{fmtQty(m.plantFreeQty)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">{fmtQty(m.dayStoreQty)}</td>
                  <td className="px-3 py-1.5">{m.enough ? <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Available</span> : <span className="pill border-amber-200 bg-amber-50 text-amber-700">Short</span>}</td>
                  {weighing && (
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          className="field !w-24 !py-1 font-mono text-xs"
                          placeholder={fmtQty(m.requiredQty)}
                          value={weighing.values[m.itemId]?.qty ?? ""}
                          disabled={weighing.disabled}
                          onChange={(e) => weighing.onChange(m.itemId, { qty: e.target.value })}
                        />
                        <span className="text-micro text-slate-400">{m.unit}</span>
                        {deviates(m.requiredQty, weighing.values[m.itemId]?.qty ?? "") && (
                          <input className="field !w-44 !py-1 text-xs" placeholder="Why different? *" value={weighing.values[m.itemId]?.note ?? ""} disabled={weighing.disabled} onChange={(e) => weighing.onChange(m.itemId, { note: e.target.value })} />
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
    </>
  );
}

function IndentForm({ row, canAct, onDone }: { row: BatchPrepRow; canAct: boolean; onDone: () => void }) {
  const toast = useToast();
  const act = useBatchPrepAction("indent");
  const [slip, setSlip] = useState(row.prodIndentSlipSign ?? "");
  const [planDate, setPlanDate] = useState(row.productionPlanDate?.slice(0, 10) ?? today());
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setError(null);
    if (!slip.trim()) return setError("Enter the indent slip sign / number.");
    try {
      await act.mutateAsync({ id: row.id, prodIndentSlipSign: slip.trim(), productionPlanDate: planDate });
      toast.success("Indent signed. R&D gives the batch number next.");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign the indent");
    }
  }
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[18rem_1fr]">
      <div className="space-y-2.5">
        <p className="label">Indent</p>
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">Indent slip sign / number</label>
          <input className="field !py-1.5 text-xs" value={slip} disabled={!canAct} onChange={(e) => setSlip(e.target.value)} />
        </div>
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">Production plan date</label>
          <input type="date" className="field !py-1.5 text-xs" value={planDate} disabled={!canAct} onChange={(e) => setPlanDate(e.target.value)} />
        </div>
        {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
        {canAct && (
          <button type="button" className="btn-primary btn-sm w-full" disabled={act.isPending} onClick={submit}>
            <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {act.isPending ? "Saving…" : "Sign indent"}
          </button>
        )}
      </div>
      <div>
        <RequirementsTable row={row} />
        <p className="mt-1 text-micro text-slate-400">These quantities come from the plan, scaled to this batch, and are the same ones the Day Store dispenses.</p>
      </div>
    </div>
  );
}

// R&D: one tap gives the next serial number; a number can also be typed (it is checked against every batch).
function AllocateCell({ row }: { row: BatchPrepRow }) {
  const toast = useToast();
  const act = useBatchPrepAction("batch-no/allocate");
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  async function go(batchNo?: string) {
    try {
      const res = await act.mutateAsync({ id: row.id, ...(batchNo ? { batchNo } : {}) });
      toast.success(`Batch number ${res.batchNo} allocated. The Day Store dispenses next.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not allocate the batch number");
    }
  }
  return (
    <div className="flex items-center justify-end gap-2">
      {typing && <input className="field !h-8 !w-40 !py-0 font-mono !text-xs" placeholder="Type a number" value={typed} onChange={(e) => setTyped(e.target.value)} />}
      {typing ? (
        <button type="button" className="btn-primary btn-sm" disabled={act.isPending || !typed.trim()} onClick={() => go(typed.trim())}>
          Allocate
        </button>
      ) : (
        <button type="button" className="btn-primary btn-sm" disabled={act.isPending} onClick={() => go()}>
          {act.isPending ? "Allocating…" : "Generate batch no."}
        </button>
      )}
      <button type="button" className="text-tiny font-bold text-slate-500 hover:text-brand-600" onClick={() => setTyping((t) => !t)}>
        {typing ? "Use serial" : "Type my own"}
      </button>
    </div>
  );
}

// An allocated number can be corrected until the batch is dispensed; after that it is locked.
function CorrectCell({ row }: { row: BatchPrepRow }) {
  const toast = useToast();
  const correct = useCorrectBatchNo();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.batchNo ?? "");
  // Until the Day Store dispenses the batch the number can be corrected; once Dispensing is done (the batch is at Line Clearance, in production or completed) it is locked.
  if (row.prepStageId !== "DISPENSING") return <span className="text-micro font-bold text-slate-400" title="Dispensing is already done for this batch, so its number can no longer be changed">Locked: Dispensing is done</span>;
  async function save() {
    try {
      await correct.mutateAsync({ id: row.id, batchNo: value.trim() });
      toast.success("Batch number changed.");
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not change the batch number");
    }
  }
  return editing ? (
    <div className="flex items-center justify-end gap-2">
      <input className="field !h-8 !w-40 !py-0 font-mono !text-xs" value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="button" className="btn-primary btn-sm" disabled={correct.isPending || !value.trim()} onClick={save}>
        Save
      </button>
      <button type="button" className="text-tiny font-bold text-slate-500 hover:text-brand-600" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </div>
  ) : (
    <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(true)}>
      Change number
    </button>
  );
}

function DispenseForm({ row, canAct, onDone }: { row: BatchPrepRow; canAct: boolean; onDone: () => void }) {
  const toast = useToast();
  const act = useBatchPrepAction("dispense");
  const [rmDate, setRmDate] = useState(today());
  const [pmDate, setPmDate] = useState(today());
  const [remarks, setRemarks] = useState("");
  const [grn, setGrn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reqs = row.requirements ?? [];
  const short = reqs.filter((m) => !m.enough);
  // What was actually weighed out, where it differs from the plan. Nothing entered = the plan quantity is given.
  const [weights, setWeights] = useState<Weighed>({});
  const setWeight = (itemId: string, patch: Partial<Weighed[string]>) =>
    setWeights((w) => {
      const cur = w[itemId] ?? { qty: "", note: "" };
      return { ...w, [itemId]: { ...cur, ...patch } };
    });
  async function submit() {
    setError(null);
    const lines = reqs
      .filter((m) => weights[m.itemId]?.qty)
      .map((m) => ({ itemId: m.itemId, actualQty: Number(weights[m.itemId]!.qty), note: weights[m.itemId]!.note.trim() || undefined }));
    const unexplained = reqs.find((m) => deviates(m.requiredQty, weights[m.itemId]?.qty ?? "") && !weights[m.itemId]?.note.trim());
    if (unexplained) return setError(`Write why ${unexplained.itemName} was weighed different from the plan.`);
    try {
      await act.mutateAsync({ id: row.id, rmDispensingDate: rmDate, pmIssuedDate: pmDate, dispensingRemarks: remarks || undefined, grnNo: grn || undefined, ...(lines.length ? { lines } : {}) });
      toast.success(`${row.batchNo ?? "Batch"} dispensed. QA clears the line next.`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not dispense this batch");
    }
  }
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[20rem_1fr]">
      <div className="space-y-2.5">
        <p className="label">Dispensing of {row.batchNo}</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-0.5 block text-micro text-slate-400">RM dispensing date</label>
            <input type="date" className="field !py-1.5 text-xs" value={rmDate} disabled={!canAct} onChange={(e) => setRmDate(e.target.value)} />
          </div>
          <div>
            <label className="mb-0.5 block text-micro text-slate-400">PM issued date</label>
            <input type="date" className="field !py-1.5 text-xs" value={pmDate} disabled={!canAct} onChange={(e) => setPmDate(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">GRN no. (optional)</label>
          <input className="field !py-1.5 text-xs" value={grn} disabled={!canAct} onChange={(e) => setGrn(e.target.value)} />
        </div>
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">Remarks</label>
          <input className="field !py-1.5 text-xs" value={remarks} disabled={!canAct} onChange={(e) => setRemarks(e.target.value)} />
        </div>
        {short.length > 0 && <p className="text-xs font-bold text-amber-700">{short.length} material{short.length === 1 ? " is" : "s are"} short at the Plant and the Day Store together. Ask the Warehouse (Production Requests) before dispensing.</p>}
        {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
        {canAct && (
          <button type="button" className="btn-primary btn-sm w-full" disabled={act.isPending || short.length > 0} onClick={submit}>
            <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {act.isPending ? "Dispensing…" : "Dispense this batch"}
          </button>
        )}
      </div>
      <div>
        <RequirementsTable row={row} weighing={{ values: weights, onChange: setWeight, disabled: !canAct }} />
        <p className="mt-1 text-micro text-slate-400">The Plant gives what it already holds; the Day Store issues the rest to the Plant when you dispense. If you weighed something different from the plan, enter it - leave it blank and the plan quantity is taken as given.</p>
      </div>
    </div>
  );
}

function LineClearanceForm({ row, canAct, onDone }: { row: BatchPrepRow; canAct: boolean; onDone: () => void }) {
  const toast = useToast();
  const act = useBatchPrepAction("line-clearance");
  const [status, setStatus] = useState(row.lineClearanceStatus ?? "Approved");
  const [remarks, setRemarks] = useState(row.lineClearanceRemarks ?? "");
  const [checks, setChecks] = useState<Record<string, boolean>>(() => Object.fromEntries(row.lineClearanceChecklist.map((i) => [i.key, i.ok])));
  const [error, setError] = useState<string | null>(null);
  const left = row.lineClearanceChecklist.filter((i) => !checks[i.key]).length;
  async function submit() {
    setError(null);
    if (status !== "Approved" && !remarks.trim()) return setError("Write the remark for Not Approved / Hold.");
    if (status === "Approved" && left > 0) return setError(`Tick every checklist item before approving (${left} left).`);
    try {
      await act.mutateAsync({ id: row.id, lineClearanceStatus: status, lineClearanceRemarks: remarks.trim() || undefined, lineClearanceChecks: checks });
      toast.success(status === "Approved" ? `${row.batchNo} is cleared. Production can start it.` : "Saved. The batch stays here until it is Approved.");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-full rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-3 py-1.5">
          <p className="text-micro font-bold uppercase tracking-wide text-slate-500">Line Clearance checklist (BMR 4.0)</p>
          <div className="flex items-center gap-3">
            <span className={`text-micro font-bold ${left === 0 ? "text-emerald-600" : "text-amber-600"}`}>{left === 0 ? "All items ticked" : `${left} of ${row.lineClearanceChecklist.length} left`}</span>
            {canAct && (
              <button type="button" className="text-micro font-bold text-brand-600 hover:underline" onClick={() => setChecks(Object.fromEntries(row.lineClearanceChecklist.map((i) => [i.key, left > 0])))}>
                {left > 0 ? "Tick all" : "Clear all"}
              </button>
            )}
          </div>
        </div>
        <ul className="divide-y divide-slate-100">
          {row.lineClearanceChecklist.map((i, n) => (
            <li key={i.key}>
              <label className={`flex items-start gap-2.5 px-3 py-1.5 text-xs ${canAct ? "cursor-pointer hover:bg-slate-50" : ""}`}>
                <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 accent-emerald-600" checked={!!checks[i.key]} disabled={!canAct} onChange={(e) => setChecks((c) => ({ ...c, [i.key]: e.target.checked }))} />
                <span className="font-mono text-slate-400">{n + 1}.</span>
                <span className={checks[i.key] ? "text-slate-700" : "text-slate-500"}>{i.label}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
      <div className="w-44">
        <label className="mb-0.5 block text-micro text-slate-400">Line Clearance</label>
        <select className="field !py-1.5 text-xs" value={status} disabled={!canAct} onChange={(e) => setStatus(e.target.value)}>
          <option>Approved</option>
          <option>Not Approved</option>
          <option>Hold</option>
        </select>
      </div>
      <div className="min-w-[16rem] flex-1">
        <label className="mb-0.5 block text-micro text-slate-400">Remarks</label>
        <input className="field !py-1.5 text-xs" value={remarks} disabled={!canAct} onChange={(e) => setRemarks(e.target.value)} />
      </div>
      {canAct && (
        <button type="button" className="btn-primary btn-sm" disabled={act.isPending} onClick={submit}>
          <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2.5} /> {act.isPending ? "Saving…" : "Save"}
        </button>
      )}
      {error && <p className="w-full text-xs font-bold text-rose-600">{error}</p>}
    </div>
  );
}
