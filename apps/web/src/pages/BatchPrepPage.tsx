import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, Check, ChevronDown, ClipboardList, Download, Hash, PackageCheck, Pencil, Send } from "lucide-react";
import { ActionMenu } from "../components/ActionMenu";
import { api, ApiError } from "../lib/api";
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
import { ExtraToDispense } from "../components/ExtraToDispense";
import { customerTypeLabel } from "../lib/customerTags";

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const today = () => new Date().toISOString().slice(0, 10);

type Stage = Exclude<BatchPrepStageId, "READY" | "LINE_CLEARANCE">;

// One page for the steps every batch goes through before its production, each on its own tile and each done by its own department:
//   Indent Issue (Production) -> Batch No (R&D) -> Dispensing (Day Store)
const STAGE_INFO: Record<Stage, { title: string; tileKey: string; role: "PRODUCTION" | "RND" | "STORE" | "QA_QC"; icon: typeof ClipboardList; accent: string; blurb: string; empty: string }> = {
  INDENT_ISSUE: { title: "Indent Issue", tileKey: "batch-indent", role: "PRODUCTION", icon: ClipboardList, accent: "bg-amber-500/10 text-amber-600", blurb: "Sign the indent of each batch. The materials come from the plan, scaled to the batch's quantity. R&D gives the batch number next.", empty: "A batch shows here once Production has divided a plan into batches (New Plan)." },
  BATCH_NO: { title: "Batch No", tileKey: "batch-no", role: "RND", icon: Hash, accent: "bg-orange-500/10 text-orange-600", blurb: "Allocate the batch number. The system gives the next serial (FLS-26-0001, ...), never repeated. The numbers you have given stay in the list (a number can be changed until the batch is dispensed).", empty: "A batch shows here once Production has signed its indent." },
  DISPENSING: { title: "Dispensing", tileKey: "batch-dispensing", role: "STORE", icon: Send, accent: "bg-emerald-500/10 text-emerald-600", blurb: "Dispense each batch's material to the Plant: only what that batch needs. Production can start the batch once its material is there.", empty: "A batch shows here once R&D has given it a batch number." },
  RECEIVE: { title: "Receive Material", tileKey: "batch-receive", role: "PRODUCTION", icon: PackageCheck, accent: "bg-sky-500/10 text-sky-600", blurb: "The Store has sent each batch's material to the Plant. Confirm what arrived, material by material: all of it, less (say why), or refuse it (it goes back to the Store). Production can start the batch once everything is received.", empty: "A batch shows here once the Store has dispensed it and sent material to the Plant." },
};

export function BatchPrepPage({ stage }: { stage: Stage }) {
  const info = STAGE_INFO[stage];
  const { hasRole } = useAuth();
  const canAct = hasRole(info.role, "ADMIN");
  // R&D's Batch No list also shows the numbers it has already allocated (and where those batches are now).
  // Batch No and Indent Issue also keep the batches already done at their step (with where they are now), so the history is not lost.
  const listsDone = stage === "BATCH_NO" || stage === "INDENT_ISSUE";
  const { data, isLoading } = usePrepBoard(stage, { all: listsDone });
  const filters = useTileFilters();
  const [openId, setOpenId] = useState<string | null>(null);
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const everyRow = data ?? [];
  const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const withNo = stage !== "INDENT_ISSUE";
  const waitingCount = listsDone ? everyRow.filter((r) => r.prepStageId === stage).length : everyRow.length;
  const waitLabel = stage === "INDENT_ISSUE" ? "Waiting for indent" : "Waiting for number";
  const doneLabel = stage === "INDENT_ISSUE" ? "Indent signed" : "Allocated";

  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct(everyRow.map((r) => r.poNumber)) },
    { key: "product", label: "Product", options: distinct(everyRow.map((r) => r.productName)) },
    ...(withNo ? [{ key: "batchno", label: "Batch No", options: distinct(everyRow.map((r) => r.batchNo)) }] : []),
    ...(listsDone ? [{ key: "bnstatus", label: "Status", options: [waitLabel, doneLabel] }] : []),
    { key: "plant", label: "Location", options: distinct(everyRow.map((r) => r.plant?.name)) },
  ];
  const rows = everyRow.filter(
    (r) =>
      (!picked("po").length || picked("po").includes(r.poNumber ?? "")) &&
      (!picked("product").length || picked("product").includes(r.productName)) &&
      (!picked("batchno").length || picked("batchno").includes(r.batchNo ?? "")) &&
      (!picked("bnstatus").length || picked("bnstatus").includes(r.prepStageId === stage ? waitLabel : doneLabel)) &&
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

  const cols = 7; // Batch, PO Number, Product, Location, Quantity, stage column, Action
  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className={`stat-icon ${info.accent}`}>
            <Icon className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{info.title}</h1>
            <p className="text-sm text-slate-500">
              {(listsDone ? waitingCount : rows.length).toLocaleString()} batch{(listsDone ? waitingCount : rows.length) === 1 ? "" : "es"}
              {!listsDone && isFiltered ? ` of ${everyRow.length}` : ""} waiting{listsDone && everyRow.length > waitingCount ? ` (${everyRow.length} listed, including the ones already done)` : ""}. {info.blurb}
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm shrink-0" disabled={rows.length === 0} onClick={download} title="Downloads the rows that match the filters above">
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      {stage === "DISPENSING" && canAct && <ExtraToDispense />}

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
                  <th className="px-4 py-2.5">PO Number</th>
                  <th className="px-4 py-2.5">Product</th>
                  <th className="px-4 py-2.5">Location</th>
                  <th className="px-4 py-2.5 text-right">Quantity</th>
                  <th className="px-4 py-2.5">{stage === "INDENT_ISSUE" ? "Indent" : stage === "BATCH_NO" ? "Indent signed" : stage === "DISPENSING" ? "Material" : stage === "RECEIVE" ? "On its way" : "Dispensed"}</th>
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
                        <td className="px-4 py-2.5 font-mono font-bold text-slate-700">{r.poNumber ?? "—"}</td>
                        <td className="px-4 py-2.5 font-bold text-slate-800">
                          {r.productName}
                          <span className="block text-micro font-normal text-slate-400">
                            <CustomerName name={r.customerName} />
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{r.plant?.name ?? "—"}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                          {fmtQty(r.plannedQty)} {r.unit}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {stage === "INDENT_ISSUE" && r.prepStageId === "INDENT_ISSUE" && (
                            <>
                              <span className="text-slate-400">Not signed</span>
                              <span className="block text-micro text-slate-400">{(r.requirements ?? []).length} material{(r.requirements ?? []).length === 1 ? "" : "s"}{notEnough > 0 ? ` · ${notEnough} short` : ""}</span>
                            </>
                          )}
                          {stage === "INDENT_ISSUE" && r.prepStageId !== "INDENT_ISSUE" && (
                            <>
                              <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Signed {day(r.indentSignedAt)}</span>
                              <span className="block text-micro text-slate-400">
                                {r.prodIndentSlipSign ? `Slip ${r.prodIndentSlipSign} · ` : ""}Now at {r.batchStatus === "COMPLETED" ? "Completed" : ({ BATCH_NO: "Batch No (R&D)", DISPENSING: "Dispensing", RECEIVE: "Receive (Production)", READY: "Production" } as Record<string, string>)[r.prepStageId] ?? r.prepStageId}
                              </span>
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
                                    Now at {r.batchStatus === "COMPLETED" ? "Completed" : ({ DISPENSING: "Dispensing", RECEIVE: "Receive (Production)", READY: "Production" } as Record<string, string>)[r.prepStageId] ?? r.prepStageId}
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
                          {stage === "RECEIVE" && (
                            <span className="pill border-sky-200 bg-sky-50 text-sky-700">
                              {(r.receiveLines ?? []).length} material{(r.receiveLines ?? []).length === 1 ? "" : "s"} to confirm
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {stage === "BATCH_NO" && canAct ? (
                            r.prepStageId === "BATCH_NO" ? <AllocateCell row={r} /> : <CorrectCell row={r} />
                          ) : stage === "BATCH_NO" || (stage === "INDENT_ISSUE" && r.prepStageId !== "INDENT_ISSUE") ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenId(open ? null : r.id)}>
                              {canAct ? (stage === "INDENT_ISSUE" ? "Sign indent" : stage === "DISPENSING" ? "Dispense" : stage === "RECEIVE" ? "Receive material" : "View") : "View"}{" "}
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
                            {stage === "RECEIVE" && <ReceiveForm row={r} canAct={canAct} onDone={() => setOpenId(null)} />}
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
// Giving a part of what is left is a partial round; only giving more than what is left (beyond the tolerance) needs a reason.
const deviates = (left: number, weighed: string) => weighed !== "" && left > 0 && (Number(weighed) - left) / left > WEIGH_TOLERANCE;

function RequirementsTable({ row, weighing }: { row: BatchPrepRow; weighing?: { values: Weighed; onChange: (itemId: string, patch: Partial<Weighed[string]>) => void; disabled: boolean; picked: Record<string, boolean>; onPick: (itemId: string, on: boolean) => void } }) {
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
                {weighing && <th className="px-3 py-2 text-right">Given so far</th>}
                {weighing && <th className="px-3 py-2 text-right">Left to give</th>}
                <th className="px-3 py-2 text-right">Free at Plant</th>
                <th className="px-3 py-2 text-right">At Store</th>
                <th className="px-3 py-2 text-left">Status</th>
                {weighing && <th className="px-3 py-2 text-left">Give now</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {reqs.length === 0 && (
                <tr>
                  <td colSpan={weighing ? 9 : 6} className="px-3 py-4 text-center text-slate-400">
                    No plan material for this product.
                  </td>
                </tr>
              )}
              {reqs.map((m) => (
                <tr key={m.itemId}>
                  <td className="px-3 py-1.5 font-bold text-slate-700">
                    {m.itemName}
                    {m.refusedNote && <span className="block font-normal text-micro text-rose-600">Production refused it: {m.refusedNote}</span>}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">{m.category}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">
                    {fmtQty(m.requiredQty)} {m.unit}
                  </td>
                  {weighing && <td className="px-3 py-1.5 text-right font-mono text-slate-700">{m.givenQty > 0 ? fmtQty(m.givenQty) : "—"}</td>}
                  {weighing && <td className="px-3 py-1.5 text-right font-mono text-slate-700">{m.dispensed ? "—" : fmtQty(m.remainingQty)}</td>}
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">{fmtQty(m.plantFreeQty)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">{fmtQty(m.dayStoreQty)}</td>
                  <td className="px-3 py-1.5">{m.dispensed ? <span className="pill border-sky-200 bg-sky-50 text-sky-700">Already dispensed</span> : m.givenQty > 0 && weighing && !weighing.picked[m.itemId] ? <span className="pill border-violet-200 bg-violet-50 text-violet-700">Partly dispensed</span> : m.enough ? <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Available</span> : <span className="pill border-amber-200 bg-amber-50 text-amber-700">Short</span>}</td>
                  {weighing && m.dispensed && <td className="px-3 py-1.5 text-slate-300">—</td>}
                  {weighing && !m.dispensed && (
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <input type="checkbox" className="h-3.5 w-3.5" checked={weighing.picked[m.itemId] !== false} disabled={weighing.disabled} onChange={(e) => weighing.onPick(m.itemId, e.target.checked)} title="Dispense this material now" />
                        <input
                          type="number"
                          min="0"
                          step="any"
                          className="field !w-24 !py-1 font-mono text-xs"
                          placeholder={fmtQty(m.remainingQty)}
                          value={weighing.values[m.itemId]?.qty ?? ""}
                          disabled={weighing.disabled || weighing.picked[m.itemId] === false}
                          onChange={(e) => weighing.onChange(m.itemId, { qty: e.target.value })}
                        />
                        <span className="text-micro text-slate-400">{m.unit}</span>
                        {weighing.picked[m.itemId] !== false && deviates(m.remainingQty, weighing.values[m.itemId]?.qty ?? "") && (
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
        <p className="mt-1 text-micro text-slate-400">These quantities come from the plan, scaled to this batch, and are the same ones the Store dispenses.</p>
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
      toast.success(`Batch number ${res.batchNo} allocated. The Store dispenses next.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not allocate the batch number");
    }
  }
  // One Action menu with both ways of giving the number; typing your own swaps it for a small input.
  if (typing) {
    return (
      <div className="flex items-center justify-end gap-2">
        <input className="field !h-8 !w-40 !py-0 font-mono !text-xs" placeholder="Type a number" value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} />
        <button type="button" className="btn-primary btn-sm" disabled={act.isPending || !typed.trim()} onClick={() => go(typed.trim())}>
          Allocate
        </button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setTyping(false)}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <ActionMenu
      busy={act.isPending}
      items={[
        { key: "generate", label: "Generate batch no.", icon: Hash, tone: "primary", onClick: () => void go() },
        { key: "type", label: "Type my own number", icon: Pencil, onClick: () => setTyping(true) },
      ]}
    />
  );
}

// An allocated number can be corrected until the batch is dispensed; after that it is locked.
function CorrectCell({ row }: { row: BatchPrepRow }) {
  const toast = useToast();
  const correct = useCorrectBatchNo();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.batchNo ?? "");
  // Until the Day Store dispenses the batch the number can be corrected; once Dispensing is done (the batch is in production or completed) it is locked.
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

// Production confirms what the Day Store sent to the Plant for this batch, material by material.
type ReceiveChoice = { action: "RECEIVE" | "REFUSE"; qty: string; note: string };

export function ReceiveForm({ row, canAct, onDone }: { row: BatchPrepRow; canAct: boolean; onDone: () => void }) {
  const toast = useToast();
  const act = useBatchPrepAction("receive");
  const lines = row.receiveLines ?? [];
  const [choice, setChoice] = useState<Record<string, ReceiveChoice>>({});
  const [error, setError] = useState<string | null>(null);
  const of = (lineId: string, sent: number): ReceiveChoice => choice[lineId] ?? { action: "RECEIVE", qty: String(sent), note: "" };
  const set = (lineId: string, sent: number, patch: Partial<ReceiveChoice>) => setChoice((c) => ({ ...c, [lineId]: { ...of(lineId, sent), ...patch } }));

  async function submit() {
    setError(null);
    const body = lines.map((l) => {
      const c = of(l.lineId, l.sentQty);
      const qty = Number(c.qty);
      if (c.action === "REFUSE") return { lineId: l.lineId, action: "REFUSE" as const, note: c.note.trim() };
      return { lineId: l.lineId, action: "RECEIVE" as const, ...(qty < l.sentQty - 1e-9 ? { receivedQty: qty } : {}), note: c.note.trim() || undefined };
    });
    for (const [i, l] of lines.entries()) {
      const c = of(l.lineId, l.sentQty);
      const qty = Number(c.qty);
      if (c.action === "REFUSE" && c.note.trim().length < 3) return setError(`Write why ${l.itemName} is refused.`);
      if (c.action === "RECEIVE" && (!(qty > 0) || qty > l.sentQty + 1e-9)) return setError(`${l.itemName}: enter a quantity up to ${fmtQty(l.sentQty)}.`);
      if (c.action === "RECEIVE" && qty < l.sentQty - 1e-9 && c.note.trim().length < 3) return setError(`${l.itemName}: only ${fmtQty(qty)} of ${fmtQty(l.sentQty)} arrived - write what happened to the rest.`);
      void i;
    }
    try {
      const res = await act.mutateAsync({ id: row.id, lines: body });
      const refused = body.filter((b) => b.action === "REFUSE").length;
      toast.success(res.prepStageId === "READY" ? `${row.batchNo ?? "Batch"}: material received. Production can start it.` : refused ? "Refused material goes back to the Store, which dispenses it again." : "Saved.");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <div className="space-y-3">
      <p className="label">Material sent for {row.batchNo ?? "this batch"}</p>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full whitespace-nowrap text-xs">
          <thead className="bg-slate-50 text-micro font-bold uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">Material</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-right">Needed (weighed)</th>
              <th className="px-3 py-2 text-right">Sent</th>
              <th className="px-3 py-2 text-left">What happened</th>
              <th className="px-3 py-2 text-left">Received</th>
              <th className="px-3 py-2 text-left">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((l) => {
              const c = of(l.lineId, l.sentQty);
              const short = c.action === "RECEIVE" && Number(c.qty) < l.sentQty - 1e-9;
              return (
                <tr key={l.lineId}>
                  <td className="px-3 py-1.5 font-bold text-slate-700">{l.itemName}</td>
                  <td className="px-3 py-1.5 text-slate-500">{l.category}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">
                    {fmtQty(l.givenQty)} {l.unit}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono font-bold text-sky-700">
                    {fmtQty(l.sentQty)} {l.unit}
                  </td>
                  <td className="px-3 py-1.5">
                    <select className="field !h-8 !w-28 !py-0 !text-xs" value={c.action} disabled={!canAct} onChange={(e) => set(l.lineId, l.sentQty, { action: e.target.value as ReceiveChoice["action"] })}>
                      <option value="RECEIVE">Receive</option>
                      <option value="REFUSE">Refuse</option>
                    </select>
                  </td>
                  <td className="px-3 py-1.5">
                    {c.action === "RECEIVE" ? (
                      <div className="flex items-center gap-1.5">
                        <input type="number" min="0" step="any" className="field !h-8 !w-24 !py-0 font-mono !text-xs" value={c.qty} disabled={!canAct} onChange={(e) => set(l.lineId, l.sentQty, { qty: e.target.value })} />
                        <span className="text-micro text-slate-400">{l.unit}</span>
                      </div>
                    ) : (
                      <span className="text-slate-300">goes back to the Store</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {c.action === "REFUSE" || short ? (
                      <input className="field !h-8 !w-56 !py-0 !text-xs" placeholder={c.action === "REFUSE" ? "Why is it refused? *" : "What happened to the rest? *"} value={c.note} disabled={!canAct} onChange={(e) => set(l.lineId, l.sentQty, { note: e.target.value })} />
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-micro text-slate-400">A material you receive joins the Plant&apos;s stock. A shortage is kept as a recorded loss. A refused material goes back to the Store, and the batch returns to Dispensing for that material only.</p>
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      {canAct && (
        <button type="button" className="btn-primary btn-sm" disabled={act.isPending || lines.length === 0} onClick={submit}>
          <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> {act.isPending ? "Saving…" : "Confirm"}
        </button>
      )}
    </div>
  );
}

function DispenseForm({ row, canAct, onDone }: { row: BatchPrepRow; canAct: boolean; onDone: () => void }) {
  const toast = useToast();
  const act = useBatchPrepAction("dispense");
  const [rmDate, setRmDate] = useState(today());
  const [pmDate, setPmDate] = useState(today());
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The GRN comes from the Generate button, never typed. It is made for this round and checked again when the batch is dispensed.
  const [grn, setGrn] = useState("");
  const [generating, setGenerating] = useState(false);
  const reqs = row.requirements ?? [];
  // A round can give only some of the materials, and only a part of one: the ticked materials, each for the quantity in its box (blank = all that is left).
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [weights, setWeights] = useState<Weighed>({});
  const setWeight = (itemId: string, patch: Partial<Weighed[string]>) =>
    setWeights((w) => {
      const cur = w[itemId] ?? { qty: "", note: "" };
      return { ...w, [itemId]: { ...cur, ...patch } };
    });
  const todo = reqs.filter((m) => !m.dispensed);
  const chosen = todo.filter((m) => picked[m.itemId] !== false);
  const giveNow = (m: (typeof reqs)[number]) => (weights[m.itemId]?.qty ? Number(weights[m.itemId]!.qty) : m.remainingQty);
  // Only what is being dispensed now has to be available; a material left for later does not hold the others back.
  const short = chosen.filter((m) => m.plantFreeQty + m.dayStoreQty < giveNow(m) - 1e-9);
  async function generate() {
    setError(null);
    setGenerating(true);
    try {
      setGrn((await api<{ grnNo: string }>(`/api/production-batches/${row.id}/grn-preview`)).grnNo);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not generate the GRN");
    } finally {
      setGenerating(false);
    }
  }
  async function submit() {
    setError(null);
    if (!grn) return setError("Press Generate to make the GRN first.");
    if (chosen.length === 0) return setError("Tick at least one material to dispense.");
    const unexplained = chosen.find((m) => deviates(m.remainingQty, weights[m.itemId]?.qty ?? "") && !weights[m.itemId]?.note.trim());
    if (unexplained) return setError(`Write why you are giving more than what is left of ${unexplained.itemName}.`);
    const lines = chosen.map((m) => ({ itemId: m.itemId, actualQty: giveNow(m), note: weights[m.itemId]?.note.trim() || undefined }));
    try {
      await act.mutateAsync({ id: row.id, rmDispensingDate: rmDate, pmIssuedDate: pmDate, dispensingRemarks: remarks || undefined, grnNo: grn, partial: true, lines });
      toast.success(`${row.batchNo ?? "Batch"} dispensed (GRN ${grn}).`);
      onDone();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Could not dispense this batch";
      if (/GRN has changed/i.test(message)) setGrn(""); // another batch took the number: Generate gives the new one
      setError(message);
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
          <label className="mb-0.5 block text-micro text-slate-400">GRN no.</label>
          <div className="flex items-center gap-1.5">
            <input className="field !py-1.5 text-xs" value={grn} placeholder="Press Generate" disabled readOnly />
            {canAct && (
              <button type="button" className="btn-ghost btn-sm shrink-0" disabled={generating} onClick={generate}>
                <Hash className="h-3.5 w-3.5" strokeWidth={2.5} /> {generating ? "…" : grn ? "Again" : "Generate"}
              </button>
            )}
          </div>
          {row.grnNo && <p className="mt-0.5 text-micro text-slate-400">Earlier round: {row.grnNo}. This round gets the same number with a letter added.</p>}
        </div>
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">Remarks</label>
          <input className="field !py-1.5 text-xs" value={remarks} disabled={!canAct} onChange={(e) => setRemarks(e.target.value)} />
        </div>
        {short.length > 0 && <p className="text-xs font-bold text-amber-700">{short.map((m) => m.itemName).join(", ")} {short.length === 1 ? "is" : "are"} short at the Plant and the Store together. Untick {short.length === 1 ? "it" : "them"} to dispense the rest now, or ask the Warehouse (Production Requests).</p>}
        {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
        {canAct && (
          <button type="button" className="btn-primary btn-sm w-full" disabled={act.isPending || short.length > 0 || !grn || chosen.length === 0} onClick={submit}>
            <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {act.isPending ? "Dispensing…" : chosen.length < todo.length || chosen.some((m) => giveNow(m) < m.remainingQty - 1e-9) ? "Dispense this part" : "Dispense this batch"}
          </button>
        )}
      </div>
      <div>
        <RequirementsTable row={row} weighing={{ values: weights, onChange: setWeight, disabled: !canAct, picked, onPick: (itemId, on) => setPicked((p) => ({ ...p, [itemId]: on })) }} />
        <p className="mt-1 text-micro text-slate-400">Tick the materials to dispense now and, for any of them, type a smaller quantity to give a part: the rest stays to be dispensed later (the batch goes on once everything is given). Blank = all that is left. The Plant gives what it already holds; the Store issues the rest to the Plant.</p>
      </div>
    </div>
  );
}
