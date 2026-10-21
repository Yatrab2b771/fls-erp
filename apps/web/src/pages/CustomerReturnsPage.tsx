import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ChevronDown, FileText, PackageOpen, RotateCcw, Search, ShieldCheck, Undo2, Wrench } from "lucide-react";
import { ApiError } from "../lib/api";
import { useSendReturnToQa, useSendToNewPlan } from "../lib/reworkHooks";
import { useAuth } from "../lib/auth";
import {
  RETURN_STATUS_LABEL,
  RETURN_STATUS_PILL,
  useCreditNote,
  useCustomerReturns,
  useDispatchChoice,
  useQaDecision,
  useRecordCustomerReturn,
  useReturnableBatches,
  type CustomerReturn,
} from "../lib/customerReturnHooks";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { fmtQty } from "../lib/format";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { CustomerName } from "../components/CustomerName";

// One page for every department's part of a customer return (see customer-returns.routes.ts): the same list, each with its own tile, title and
// action. Warehouse records the return; QA decides; Production reworks; Dispatch stores it or sends it again; Accounts raises the credit note.
export type ReturnView = "warehouse" | "qa" | "rework" | "dispatch" | "accounts";

const VIEWS: Record<ReturnView, { title: string; icon: typeof Undo2; accent: string; blurb: string; role: "STORE" | "QA_QC" | "PRODUCTION" | "DISPATCH" | "ACCOUNTS"; todo?: (r: CustomerReturn) => boolean; todoLabel: string; empty: string }> = {
  warehouse: { title: "Customer Returns", icon: Undo2, accent: "bg-rose-500/10 text-rose-600", blurb: "Goods a customer sent back reach the Warehouse. Record each return here: it then waits for QA and is not counted as stock until QA passes it.", role: "STORE", todoLabel: "In progress", todo: (r) => ["WITH_QA", "IN_REWORK", "AWAITING_DISPATCH"].includes(r.status), empty: "No customer return yet." },
  qa: { title: "Returned Goods", icon: ShieldCheck, accent: "bg-violet-500/10 text-violet-600", blurb: "Goods the customer sent back. Decide for each: pass it (Dispatch then stores it or sends it again), send it for rework to Production, or scrap it. Reworked goods come back here once more.", role: "QA_QC", todoLabel: "Waiting for QA", todo: (r) => r.status === "WITH_QA", empty: "Nothing is waiting for QA." },
  rework: { title: "Rework", icon: Wrench, accent: "bg-amber-500/10 text-amber-600", blurb: "Returned goods QA wants reprocessed. Send each to New Plan: it gets a Rework batch number (the original batch + -R1) and a sheet for shift, manpower, material and time. When it is done the goods go back to QA.", role: "PRODUCTION", todoLabel: "To rework", todo: (r) => r.status === "IN_REWORK", empty: "Nothing is waiting for rework." },
  dispatch: { title: "Returned Goods", icon: RotateCcw, accent: "bg-sky-500/10 text-sky-600", blurb: "Returned goods QA has passed. Store them in the Warehouse's finished-goods stock, or send them to the customer again (they go back into your stock of the batch for a normal shipment).", role: "DISPATCH", todoLabel: "To decide", todo: (r) => r.status === "AWAITING_DISPATCH", empty: "Nothing is waiting for your decision." },
  accounts: { title: "Credit Notes", icon: FileText, accent: "bg-emerald-500/10 text-emerald-600", blurb: "A credit note for each customer return. The amount is worked out from the invoice (value per unit x quantity returned); change it if the credit is different.", role: "ACCOUNTS", todoLabel: "No credit note yet", todo: (r) => !r.creditNote, empty: "Every return has its credit note." },
};

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const today = () => new Date().toISOString().slice(0, 10);

export function CustomerReturnsPage({ view }: { view: ReturnView }) {
  const cfg = VIEWS[view];
  const { hasRole } = useAuth();
  const canAct = hasRole(cfg.role, "ADMIN");
  const { data, isLoading } = useCustomerReturns();
  const [onlyTodo, setOnlyTodo] = useState(view !== "warehouse");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const all = data ?? [];
  const needle = search.trim().toLowerCase();
  const rows = all
    .filter((r) => (!onlyTodo || !cfg.todo || cfg.todo(r)) && (!needle || [r.poNumber, r.customerName, r.productName, r.batchNo, r.reason].some((v) => (v ?? "").toLowerCase().includes(needle))))
    .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  const pg = useClientPaging(rows);
  const todoCount = cfg.todo ? all.filter(cfg.todo).length : all.length;
  const Icon = cfg.icon;

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className={`stat-icon ${cfg.accent}`}>
            <Icon className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{cfg.title}</h1>
            <p className="text-sm text-slate-500">
              {todoCount} {cfg.todoLabel.toLowerCase()} · {all.length} in all. {cfg.blurb}
            </p>
          </div>
        </div>
      </div>

      {view === "warehouse" && canAct && <RecordReturnForm />}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-72 max-w-full">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input className="field w-full !pl-9" placeholder="Search PO, customer, product, batch" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {cfg.todo && (
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs font-bold" role="group" aria-label="Show">
            {(
              [
                [true, `${cfg.todoLabel} (${todoCount})`],
                [false, `All (${all.length})`],
              ] as const
            ).map(([key, label]) => (
              <button key={String(key)} type="button" onClick={() => setOnlyTodo(key)} className={`rounded-md px-3 py-1.5 transition ${onlyTodo === key ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={PackageOpen} title={search || !onlyTodo ? "No matches" : cfg.empty} hint={view === "warehouse" ? "Record a return above when a customer sends goods back." : "Returns show here as the earlier department passes them on."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-3 py-3">PO Number</th>
                <th className="px-3 py-3">Customer</th>
                <th className="px-3 py-3">Product</th>
                <th className="px-3 py-3">Batch</th>
                <th className="px-3 py-3 text-right">Returned</th>
                <th className="px-3 py-3">Reason</th>
                <th className="px-3 py-3">Received</th>
                <th className="px-3 py-3">Status</th>
                {view === "accounts" && <th className="px-3 py-3">Credit note</th>}
                <th className="px-3 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((r) => {
                const open = openId === r.id;
                const actionable = canAct && !!cfg.todo?.(r);
                return (
                  <Fragment key={r.id}>
                    <tr className={`transition hover:bg-slate-50 ${open ? "bg-slate-50/70" : ""}`}>
                      <td className="px-3 py-3 font-bold text-brand-700">{r.poNumber ?? "—"}</td>
                      <td className="px-3 py-3 text-slate-600"><CustomerName name={r.customerName} /></td>
                      <td className="px-3 py-3 font-bold text-slate-700">{r.productName}</td>
                      <td className="px-3 py-3 font-mono text-slate-600">{r.batchNo ?? "—"}</td>
                      <td className="px-3 py-3 text-right font-mono font-bold text-slate-900">
                        {fmtQty(r.quantity)} {r.unit}
                      </td>
                      <td className="max-w-[16rem] truncate px-3 py-3 text-slate-600" title={[r.reason, r.condition].filter(Boolean).join(" · ")}>
                        {r.reason}
                        {r.condition && <span className="block text-micro text-slate-400">{r.condition}</span>}
                      </td>
                      <td className="px-3 py-3 text-slate-500">{day(r.returnedAt)}</td>
                      <td className="px-3 py-3">
                        <span className={`pill ${RETURN_STATUS_PILL[r.status]}`}>{RETURN_STATUS_LABEL[r.status]}</span>
                        <span className="block text-micro text-slate-400">{progressNote(r)}</span>
                      </td>
                      {view === "accounts" && (
                        <td className="px-3 py-3 text-slate-600">
                          {r.creditNote ? (
                            <>
                              <span className="font-bold text-slate-800">{r.creditNote.no}</span>
                              <span className="block text-micro text-slate-400">
                                {day(r.creditNote.date)}
                                {r.creditNote.amount != null ? ` · ${fmtQty(r.creditNote.amount)}` : ""}
                              </span>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      )}
                      <td className="px-3 py-3 text-right">
                        {actionable ? (
                          <button type="button" className="btn-primary btn-sm" onClick={() => setOpenId(open ? null : r.id)}>
                            {actionLabel(view)} <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                          </button>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                    {open && actionable && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={view === "accounts" ? 10 : 9} className="whitespace-normal px-4 py-4">
                          {view === "qa" && <QaForm row={r} onDone={() => setOpenId(null)} />}
                          {view === "rework" && <SendToNewPlanForm row={r} onDone={() => setOpenId(null)} />}
                          {view === "dispatch" && <DispatchForm row={r} onDone={() => setOpenId(null)} />}
                          {view === "accounts" && <CreditForm row={r} onDone={() => setOpenId(null)} />}
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

const actionLabel = (view: ReturnView) => ({ warehouse: "Open", qa: "Decide", rework: "New Plan", dispatch: "Choose", accounts: "Credit note" })[view];

/** One line saying how far the return has got. */
export function progressNote(r: CustomerReturn): string {
  if (r.status === "SCRAPPED") return `QA scrapped ${fmtQty(r.quantity)}`;
  if (r.status === "IN_REWORK") return r.reworks.length ? `In New Plan: ${r.reworks.map((w) => w.reworkNo).join(", ")}` : (r.qa?.note ?? "QA sent it for rework");
  if (r.status === "WITH_QA" && r.reworked) return `Reworked: ${fmtQty(r.rework?.reworkedQty ?? 0)} ${r.unit} back to QA`;
  if (r.qa?.decision === "PASS" && r.qa.passedQty != null) return `QA passed ${fmtQty(r.qa.passedQty)}${r.qa.scrapQty > 0 ? `, scrapped ${fmtQty(r.qa.scrapQty)}` : ""}`;
  return "";
}

function useSave() {
  const toast = useToast();
  return (promise: Promise<unknown>, done: string, onDone: () => void) =>
    promise.then(
      () => {
        toast.success(done);
        onDone();
      },
      (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Could not save"),
    );
}

function RecordReturnForm() {
  const { data: batches } = useReturnableBatches();
  const record = useRecordCustomerReturn();
  const save = useSave();
  const [batchId, setBatchId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [returnedAt, setReturnedAt] = useState(today());
  const [reason, setReason] = useState("");
  const [condition, setCondition] = useState("");
  const picked = (batches ?? []).find((b) => b.batchId === batchId);
  const qty = Number(quantity);
  const ok = !!picked && qty > 0 && qty <= picked.withCustomerQty + 1e-9 && reason.trim().length >= 3;

  return (
    <div className="card space-y-3 p-4">
      <p className="text-sm font-black text-slate-800">Record a return</p>
      <div className="grid gap-3 md:grid-cols-4">
        <div className="md:col-span-2">
          <label className="label">Which goods came back?</label>
          <select className="field" value={batchId} onChange={(e) => (setBatchId(e.target.value), setQuantity(""))}>
            <option value="">Pick the PO / product / batch</option>
            {(batches ?? []).map((b) => (
              <option key={b.batchId} value={b.batchId}>
                {b.poNumber ?? "PO"} · {b.customerName} · {b.productName} · {b.batchNo ?? "batch"} (customer has {fmtQty(b.withCustomerQty)} {b.unit})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Quantity returned{picked ? ` (max ${fmtQty(picked.withCustomerQty)} ${picked.unit})` : ""}</label>
          <input className="field font-mono" type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <div>
          <label className="label">Received on</label>
          <input className="field" type="date" value={returnedAt} onChange={(e) => setReturnedAt(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <label className="label">Why did the customer send it back? <span className="text-rose-500">*</span></label>
          <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. seal broken, wrong product, quality complaint" />
        </div>
        <div className="md:col-span-2">
          <label className="label">How do the goods look?</label>
          <input className="field" value={condition} onChange={(e) => setCondition(e.target.value)} placeholder="e.g. tubs dented, cartons wet" />
        </div>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={!ok || record.isPending}
          onClick={() =>
            void save(
              record.mutateAsync({ batchId, quantity: qty, reason: reason.trim(), condition: condition.trim() || undefined, returnedAt }),
              "Return recorded. It waits for QA.",
              () => {
                setBatchId("");
                setQuantity("");
                setReason("");
                setCondition("");
              },
            )
          }
        >
          {record.isPending ? "Saving…" : "Record return"}
        </button>
      </div>
    </div>
  );
}

function QaForm({ row, onDone }: { row: CustomerReturn; onDone: () => void }) {
  const decide = useQaDecision();
  const save = useSave();
  const available = row.reworked ? (row.rework?.reworkedQty ?? 0) : row.quantity;
  const [decision, setDecision] = useState<"PASS" | "REWORK" | "SCRAP">("PASS");
  const [passedQty, setPassedQty] = useState(String(available));
  const [note, setNote] = useState("");
  const needsNote = decision !== "PASS";
  const passed = Number(passedQty);
  const ok = decision === "PASS" ? passed > 0 && passed <= available + 1e-9 : note.trim().length >= 3;

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-slate-500">
        {fmtQty(row.quantity)} {row.unit} came back{row.reworked ? `, ${fmtQty(available)} ${row.unit} after rework. This is the second look: pass or scrap` : ""}.
      </p>
      <div className="flex flex-wrap gap-2">
        {(
          [
            ["PASS", "Pass: goods are fine"],
            ...(row.reworked ? [] : ([["REWORK", "Rework: Production fixes it"]] as const)),
            ["SCRAP", "Scrap"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className={`cursor-pointer rounded-lg border px-3 py-2 text-xs font-bold ${decision === key ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600"}`}>
            <input type="radio" className="mr-2" checked={decision === key} onChange={() => setDecision(key)} />
            {label}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {decision === "PASS" && (
          <div className="w-44">
            <label className="label">Pass how much? (max {fmtQty(available)})</label>
            <input className="field font-mono" type="number" min="0" step="any" value={passedQty} onChange={(e) => setPassedQty(e.target.value)} />
            <p className="mt-0.5 text-micro text-slate-400">The rest is scrapped.</p>
          </div>
        )}
        <div className="min-w-[16rem] flex-1">
          <label className="label">
            {decision === "REWORK" ? "What has to be reworked?" : decision === "SCRAP" ? "Why is it scrapped?" : "Note (optional)"} {needsNote && <span className="text-rose-500">*</span>}
          </label>
          <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <button type="button" className="btn-primary btn-sm" disabled={!ok || decide.isPending} onClick={() => void save(decide.mutateAsync({ id: row.id, decision, ...(decision === "PASS" ? { passedQty: passed } : {}), note: note.trim() || undefined }), "Decision saved.", onDone)}>
          {decide.isPending ? "Saving…" : "Save decision"}
        </button>
      </div>
    </div>
  );
}

function SendToNewPlanForm({ row, onDone }: { row: CustomerReturn; onDone: () => void }) {
  const send = useSendToNewPlan();
  const toQa = useSendReturnToQa();
  const save = useSave();
  const [qty, setQty] = useState(String(row.reworkLeft));
  const n = Number(qty);
  const allDone = row.reworks.length > 0 && row.reworks.every((w) => w.status === "COMPLETED");
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-slate-500">
        QA asked for: {row.qa?.note ?? "rework"}. {fmtQty(row.quantity)} {row.unit} came back.
      </p>
      {row.reworks.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full whitespace-nowrap text-xs">
            <thead className="bg-slate-50 text-micro font-bold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">Rework batch</th>
                <th className="px-3 py-2 text-right">Quantity</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">Came out</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {row.reworks.map((w) => (
                <tr key={w.id}>
                  <td className="px-3 py-2 font-mono font-bold text-amber-700">{w.reworkNo}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtQty(w.quantity)} {row.unit}</td>
                  <td className="px-3 py-2 text-slate-600">{w.status === "COMPLETED" ? "Done" : w.status === "IN_PROGRESS" ? "In progress" : "In New Plan, not started"}</td>
                  <td className="px-3 py-2 text-right font-mono">{w.outputQty != null ? `${fmtQty(w.outputQty)} ${row.unit}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-slate-100 px-3 py-2 text-micro text-slate-400">
            Do the rework in New Plan (the “Rework sheet” of its row).{" "}
            <Link to="/new-plans" className="font-bold text-brand-700 hover:underline">
              Open New Plan →
            </Link>
          </p>
        </div>
      )}
      {row.reworkLeft > 1e-6 && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-44">
            <label className="label">Send how much? (max {fmtQty(row.reworkLeft)})</label>
            <input className="field font-mono" type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <button type="button" className="btn-primary btn-sm" disabled={!(n > 0) || n > row.reworkLeft + 1e-9 || send.isPending} onClick={() => void save(send.mutateAsync({ customerReturnId: row.id, quantity: n }), "Sent to New Plan with its Rework batch number.", onDone)}>
            {send.isPending ? "Sending…" : "Send to New Plan"}
          </button>
          {allDone && (
            <button type="button" className="btn-ghost btn-sm" disabled={toQa.isPending} onClick={() => void save(toQa.mutateAsync({ returnId: row.id }), "Sent back to QA with what came out.", onDone)} title="The rest of the return will not be reworked">
              Send the done ones to QA (rest not reworked)
            </button>
          )}
        </div>
      )}
      <p className="text-micro text-slate-400">Part of a return can go as one rework and the rest as another (-R1, -R2). When every rework is done and together they cover the whole return, it goes back to QA by itself.</p>
    </div>
  );
}

function DispatchForm({ row, onDone }: { row: CustomerReturn; onDone: () => void }) {
  const choose = useDispatchChoice();
  const save = useSave();
  const [note, setNote] = useState("");
  const passed = row.qa?.passedQty ?? 0;
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-slate-500">
        QA passed {fmtQty(passed)} {row.unit} of {row.productName}. What now?
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <label className="label">Note (optional)</label>
          <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <button type="button" className="btn-ghost btn-sm" disabled={choose.isPending} onClick={() => void save(choose.mutateAsync({ id: row.id, choice: "STORE", note: note.trim() || undefined }), "Stored: it is Warehouse finished-goods stock now.", onDone)}>
          Store in Warehouse
        </button>
        <button type="button" className="btn-primary btn-sm" disabled={choose.isPending} onClick={() => void save(choose.mutateAsync({ id: row.id, choice: "REDISPATCH", note: note.trim() || undefined }), "It is in your stock of the batch: send it from Finished Goods.", onDone)}>
          Dispatch again
        </button>
      </div>
      <p className="text-micro text-slate-400">“Dispatch again” puts it back in your stock of the batch: send it to the customer from Finished Goods like any shipment (Accounts adds the new invoice).</p>
    </div>
  );
}

function CreditForm({ row, onDone }: { row: CustomerReturn; onDone: () => void }) {
  const credit = useCreditNote();
  const save = useSave();
  const [no, setNo] = useState("");
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState(row.suggestedAmount != null ? String(row.suggestedAmount) : "");
  const [note, setNote] = useState("");
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-44">
        <label className="label">Credit note no. <span className="text-rose-500">*</span></label>
        <input className="field" value={no} onChange={(e) => setNo(e.target.value)} />
      </div>
      <div className="w-40">
        <label className="label">Date</label>
        <input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div className="w-40">
        <label className="label">Amount</label>
        <input className="field font-mono" type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
        {row.suggestedAmount != null && <p className="mt-0.5 text-micro text-slate-400">From the invoice: {fmtQty(row.suggestedAmount)}</p>}
      </div>
      <div className="min-w-[14rem] flex-1">
        <label className="label">Note</label>
        <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <button type="button" className="btn-primary btn-sm" disabled={!no.trim() || credit.isPending} onClick={() => void save(credit.mutateAsync({ id: row.id, creditNoteNo: no.trim(), date, amount: amount === "" ? undefined : Number(amount), note: note.trim() || undefined }), "Credit note saved.", onDone)}>
        {credit.isPending ? "Saving…" : "Save credit note"}
      </button>
    </div>
  );
}
