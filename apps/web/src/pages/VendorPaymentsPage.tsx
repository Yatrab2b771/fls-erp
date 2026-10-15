import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, Ban, Banknote, Download, PauseCircle, Wallet } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useFinanceHold, useFinancePayment, useFinanceReject, useFinanceRows, type FinanceRow, type FinanceStatus } from "../lib/financeHooks";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { AgingCell, inAgingBuckets } from "../components/AgingCell";
import { EmptyState } from "../components/EmptyState";
import { ActionMenu, type ActionMenuItem } from "../components/ActionMenu";
import { useToast } from "../components/Toast";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";

// Finance's list: the short RM / PM that Purchase has logged a vendor, PO number and ETA for. Finance checks the vendor ledger and decides: pay part or all
// of it, hold it or reject it, with a remark. The aging counts from Purchase's update, then from Finance's last remark.

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const today = () => new Date().toISOString().slice(0, 10);
const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const money = (v: number | null) => (v == null ? "—" : `₹${fmtQty(v)}`);

const STATUS_LABEL: Record<FinanceStatus, string> = { PENDING: "Pending", PAID_PARTIAL: "Part paid", PAID_FULL: "Paid in full", ON_HOLD: "On hold", REJECTED: "Rejected" };
const STATUS_PILL: Record<FinanceStatus, string> = {
  PENDING: "border-amber-200 bg-amber-50 text-amber-700",
  PAID_PARTIAL: "border-sky-200 bg-sky-50 text-sky-700",
  PAID_FULL: "border-emerald-200 bg-emerald-50 text-emerald-700",
  ON_HOLD: "border-violet-200 bg-violet-50 text-violet-700",
  REJECTED: "border-rose-200 bg-rose-50 text-rose-700",
};
/** What the dashboard tiles link with: /vendor-payments?status=pending|hold|rejected */
const FROM_QUERY: Record<string, FinanceStatus[]> = { pending: ["PENDING"], hold: ["ON_HOLD"], rejected: ["REJECTED"], paid: ["PAID_FULL", "PAID_PARTIAL"], full: ["PAID_FULL"], part: ["PAID_PARTIAL"] };

type Form = { id: string; kind: "pay" | "hold" | "reject" } | null;

export function VendorPaymentsPage() {
  const { hasRole } = useAuth();
  const canAct = hasRole("ACCOUNTS", "ADMIN");
  const { data, isLoading } = useFinanceRows();
  const pay = useFinancePayment();
  const hold = useFinanceHold();
  const reject = useFinanceReject();
  const toast = useToast();
  const filters = useTileFilters();
  const [params] = useSearchParams();
  const [form, setForm] = useState<Form>(null);
  const [payKind, setPayKind] = useState<"PARTIAL" | "FULL">("PARTIAL");
  const [amount, setAmount] = useState("");
  const [poAmount, setPoAmount] = useState("");
  const [paidOn, setPaidOn] = useState(today());
  const [remark, setRemark] = useState("");

  // opened from a tile: its status first (the same ones the tile counts)
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const wanted = FROM_QUERY[params.get("status") ?? ""];
    if (wanted) filters.applyPick("status", wanted.map((s) => STATUS_LABEL[s]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const everyRow = data ?? [];
  const { dateFrom, dateTo } = filters.applied;
  const fields: FilterField[] = [
    { key: "status", label: "Status", options: (Object.keys(STATUS_LABEL) as FinanceStatus[]).map((s) => STATUS_LABEL[s]) },
    { key: "pi", label: "PO / PI Number", options: distinct(everyRow.map((r) => r.piNumber)) },
    { key: "item", label: "RM / PM", options: distinct(everyRow.map((r) => r.itemName)) },
    { key: "category", label: "Category", options: ["RM", "PM"] },
    { key: "vendor", label: "Vendor", options: distinct(everyRow.map((r) => r.vendorName)) },
    { key: "customerPo", label: "Customer PO", options: distinct(everyRow.map((r) => r.customerPo?.poNumber)) },
    AGING_FIELD,
  ];
  const rows = everyRow.filter(
    (r) =>
      (!picked("status").length || picked("status").includes(STATUS_LABEL[r.status])) &&
      (!picked("pi").length || picked("pi").includes(r.piNumber)) &&
      (!picked("item").length || picked("item").includes(r.itemName)) &&
      (!picked("category").length || picked("category").includes(r.category)) &&
      (!picked("vendor").length || picked("vendor").includes(r.vendorName)) &&
      (!picked("customerPo").length || picked("customerPo").includes(r.customerPo?.poNumber ?? "")) &&
      inAgingBuckets(r.waitingDays, picked("aging")) &&
      (!dateFrom || r.eta.slice(0, 10) >= dateFrom) &&
      (!dateTo || r.eta.slice(0, 10) <= dateTo),
  );
  const pg = useClientPaging(rows);
  const fail = (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Could not save");

  function open(r: FinanceRow, kind: "pay" | "hold" | "reject") {
    setForm({ id: r.lineId, kind });
    setPayKind("PARTIAL");
    setAmount("");
    setPoAmount(r.poAmount != null ? String(r.poAmount) : "");
    setPaidOn(today());
    setRemark("");
  }

  function download() {
    const lines = rows.map((r) => ({
      "PO / PI Number": r.piNumber,
      Status: STATUS_LABEL[r.status],
      "RM / PM": r.itemName,
      Category: r.category === "RM" ? "Raw Material" : "Packaging Material",
      Unit: r.unit,
      "Short Qty": r.shortQty,
      Vendor: r.vendorName,
      ETA: day(r.eta),
      "Customer PO": r.customerPo?.poNumber ?? "",
      "PO Amount": r.poAmount ?? "",
      "Paid So Far": r.paidTotal,
      Balance: r.balance ?? "",
      "Finance Remarks": r.remarks ?? "",
      "Remark Updated": day(r.remarksAt),
      "Updated By": r.updatedBy ?? "",
      "Aging (Days)": r.waitingDays,
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Vendor payments", "FLS Vendor Payments (Finance)", describeFilters(filters, fields), lines, { totals: ["Short Qty", "Paid So Far"] });
    XLSX.writeFile(wb, stampedName("FLS_Vendor_Payments"));
  }

  const itemsFor = (r: FinanceRow): ActionMenuItem[] =>
    canAct
      ? [
          { key: "pay", label: r.status === "PAID_FULL" ? "Record another payment" : "Pay (partial or full)", icon: Banknote, tone: "primary", onClick: () => open(r, "pay") },
          ...(r.status !== "ON_HOLD" ? [{ key: "hold", label: "Hold", icon: PauseCircle, onClick: () => open(r, "hold") }] : []),
          ...(r.status !== "REJECTED" ? [{ key: "reject", label: "Reject", icon: Ban, tone: "danger" as const, onClick: () => open(r, "reject") }] : []),
        ]
      : [];

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-emerald-500/10 text-emerald-600">
            <Wallet className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Vendor Payments</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} short RM / PM with a vendor, PO number and ETA from Purchase.{" "}
              {canAct ? "Check the vendor ledger, then pay, hold or reject, with a remark." : "Finance's decision on each: paid (part or full), on hold or rejected."}
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey="vendor-payments" fields={fields} dateLabel="ETA" />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Wallet} title="Nothing here" hint="A short RM / PM shows here once Purchase has logged its vendor, PO number and ETA." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="whitespace-nowrap px-3 py-2.5">PO / PI no.</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Status</th>
                  <th className="min-w-[10rem] px-3 py-2.5">RM / PM</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right">Short qty</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Vendor</th>
                  <th className="whitespace-nowrap px-3 py-2.5">ETA</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right">PO amount</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right">Paid</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right">Balance</th>
                  <th className="min-w-[12rem] px-3 py-2.5">Finance remark</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Aging</th>
                  <th className="px-3 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r: FinanceRow) => (
                  <Fragment key={r.lineId}>
                    <tr className="border-b border-slate-50 align-top">
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono font-bold text-slate-700">{r.piNumber}</td>
                      <td className="px-3 py-2.5">
                        <span className={`pill whitespace-nowrap ${STATUS_PILL[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                      </td>
                      <td className="px-3 py-2.5 font-bold text-slate-800">
                        {r.itemName}
                        <span className="block text-micro font-normal text-slate-400">{[r.category === "RM" ? "Raw Material" : "Packaging Material", r.customerPo ? `for ${r.customerPo.poNumber ?? "PO"} · ${r.customerPo.productName}` : null].filter(Boolean).join(" · ")}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono font-bold text-slate-800">
                        {fmtQty(r.shortQty)} {r.unit}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">{r.vendorName}</td>
                      <td className={`whitespace-nowrap px-3 py-2.5 ${r.overdue ? "font-bold text-rose-600" : "text-slate-600"}`}>
                        {day(r.eta)}
                        {r.overdue && <span className="block text-micro">overdue</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-slate-700">{money(r.poAmount)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-slate-700" title={r.payments.map((p) => `${day(p.paidOn)}: ₹${fmtQty(p.amount)}${p.remark ? ` (${p.remark})` : ""}`).join("\n")}>
                        {r.payments.length ? money(r.paidTotal) : "—"}
                        {r.payments.length > 1 && <span className="block font-sans text-micro text-slate-400">{r.payments.length} payments</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-slate-700">{money(r.balance)}</td>
                      <td className="px-3 py-2.5 text-slate-600">
                        {r.remarks ?? <span className="text-slate-300">—</span>}
                        {r.remarksAt && (
                          <span className="block text-micro text-slate-400">
                            {day(r.remarksAt)}
                            {r.updatedBy ? ` · ${r.updatedBy}` : ""}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <AgingCell since={r.remarksAt ?? r.loggedAt} />
                        <span className="block text-micro text-slate-400">{r.remarksAt ? "since the last remark" : "since Purchase logged it"}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <ActionMenu items={itemsFor(r)} />
                      </td>
                    </tr>
                    {form?.id === r.lineId && form.kind === "pay" && (
                      <tr className="border-b border-slate-100">
                        <td colSpan={12} className="bg-slate-50 px-4 py-3">
                          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
                            <div>
                              <label className="mb-0.5 block text-micro text-slate-400">Payment</label>
                              <select className="field !py-1.5 text-xs" value={payKind} onChange={(e) => setPayKind(e.target.value as "PARTIAL" | "FULL")}>
                                <option value="PARTIAL">Partial</option>
                                <option value="FULL">Full</option>
                              </select>
                            </div>
                            <div>
                              <label className="mb-0.5 block text-micro text-slate-400">Amount paid (₹)</label>
                              <input type="number" min="0" step="any" className="field !py-1.5 text-xs" value={amount} onChange={(e) => setAmount(e.target.value)} />
                            </div>
                            <div>
                              <label className="mb-0.5 block text-micro text-slate-400">PO amount (₹)</label>
                              <input type="number" min="0" step="any" className="field !py-1.5 text-xs" value={poAmount} onChange={(e) => setPoAmount(e.target.value)} />
                            </div>
                            <div>
                              <label className="mb-0.5 block text-micro text-slate-400">Paid on</label>
                              <input type="date" className="field !py-1.5 text-xs" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
                            </div>
                            <div>
                              <label className="mb-0.5 block text-micro text-slate-400">Remark</label>
                              <input className="field !py-1.5 text-xs" value={remark} onChange={(e) => setRemark(e.target.value)} />
                            </div>
                          </div>
                          <div className="mt-2.5 flex justify-end gap-2">
                            <button type="button" className="btn-ghost btn-sm" onClick={() => setForm(null)}>
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="btn-primary btn-sm"
                              disabled={!(Number(amount) > 0) || pay.isPending}
                              onClick={() =>
                                pay.mutate(
                                  { lineId: r.lineId, kind: payKind, amount: Number(amount), poAmount: poAmount.trim() === "" ? undefined : Number(poAmount), paidOn: paidOn || undefined, remark: remark.trim() || undefined },
                                  { onSuccess: () => { toast.success("Payment saved. Purchase has been told."); setForm(null); }, onError: fail },
                                )
                              }
                            >
                              {pay.isPending ? "Saving…" : "Save payment"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {form?.id === r.lineId && (form.kind === "hold" || form.kind === "reject") && (
                      <tr className="border-b border-slate-100">
                        <td colSpan={12} className="bg-slate-50 px-4 py-3">
                          <div className="flex flex-wrap items-end gap-2">
                            <div className="min-w-[16rem] flex-1">
                              <label className="mb-0.5 block text-micro text-slate-400">{form.kind === "hold" ? "Why is it on hold?" : "Why is it rejected?"}</label>
                              <input className="field !py-1.5 text-xs" value={remark} onChange={(e) => setRemark(e.target.value)} />
                            </div>
                            <button type="button" className="btn-ghost btn-sm" onClick={() => setForm(null)}>
                              Cancel
                            </button>
                            <button
                              type="button"
                              className={form.kind === "hold" ? "btn-primary btn-sm" : "btn-danger btn-sm"}
                              disabled={!remark.trim() || hold.isPending || reject.isPending}
                              onClick={() =>
                                (form.kind === "hold" ? hold : reject).mutate(
                                  { lineId: r.lineId, remark: remark.trim() },
                                  { onSuccess: () => { toast.success(form.kind === "hold" ? "Put on hold. Purchase has been told." : "Rejected. Purchase has been told."); setForm(null); }, onError: fail },
                                )
                              }
                            >
                              {form.kind === "hold" ? "Put on hold" : "Reject"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <ClientPager pg={pg} />
        </div>
      )}
    </div>
  );
}
