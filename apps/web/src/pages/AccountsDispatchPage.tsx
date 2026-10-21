import { Fragment, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, Ban, Download, FileText, Receipt } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAccountsApprove, useAccountsQueue, useAccountsReturn, type FgShipmentStatus, type FgWarehouseRequestRow } from "../lib/fgHooks";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { AgingCell, agingDays, inAgingBuckets } from "../components/AgingCell";
import { EmptyState } from "../components/EmptyState";
import { ActionMenu, type ActionMenuItem } from "../components/ActionMenu";
import { useToast } from "../components/Toast";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";
import { CustomerName } from "../components/CustomerName";
import { customerTypeLabel } from "../lib/customerTags";

// Accounts' list of customer shipments Dispatch has prepared: add the invoice and e-way bill (then Dispatch can send it to the customer),
// or send it back to Dispatch with a reason.

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const today = () => new Date().toISOString().slice(0, 10);
const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const STATUS_LABEL: Partial<Record<FgShipmentStatus, string>> = { WITH_ACCOUNTS: "With Accounts", READY_TO_SEND: "Ready to send", SENT_BACK: "Sent back to Dispatch" };
const STATUS_PILL: Partial<Record<FgShipmentStatus, string>> = {
  WITH_ACCOUNTS: "border-amber-200 bg-amber-50 text-amber-700",
  READY_TO_SEND: "border-sky-200 bg-sky-50 text-sky-700",
  SENT_BACK: "border-rose-200 bg-rose-50 text-rose-700",
};
const label = (s: FgShipmentStatus) => STATUS_LABEL[s] ?? s;
const money = (v: number | null) => (v == null ? "—" : `₹${fmtQty(v)}`);

export function AccountsDispatchPage() {
  const { hasRole } = useAuth();
  const canAct = hasRole("ACCOUNTS", "ADMIN");
  const { data, isLoading } = useAccountsQueue();
  const approve = useAccountsApprove();
  const sendBack = useAccountsReturn();
  const toast = useToast();
  const filters = useTileFilters();
  const [openFor, setOpenFor] = useState<{ id: string; kind: "invoice" | "return" } | null>(null);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [ewayBillNo, setEwayBillNo] = useState("");
  const [ewayBillDate, setEwayBillDate] = useState("");
  const [reason, setReason] = useState("");
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    filters.applyPick("status", [STATUS_LABEL.WITH_ACCOUNTS!]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const everyRow = data ?? [];
  const fields: FilterField[] = [
    { key: "status", label: "Status", options: (["WITH_ACCOUNTS", "READY_TO_SEND", "SENT_BACK"] as FgShipmentStatus[]).map(label) },
    { key: "po", label: "PO Number", options: distinct(everyRow.map((r) => r.poNumber)) },
    { key: "product", label: "Product", options: distinct(everyRow.map((r) => r.productName)) },
    { key: "customer", label: "Customer", options: distinct(everyRow.map((r) => r.customerName)) },
    { key: "transport", label: "Transport", options: distinct(everyRow.map((r) => r.transportName)) },
    { key: "lr", label: "LR No.", options: distinct(everyRow.map((r) => r.lrNo)) },
    { key: "invoice", label: "Invoice No.", options: distinct(everyRow.map((r) => r.invoiceNo)) },
    AGING_FIELD,
  ];
  const { dateFrom, dateTo } = filters.applied;
  const rows = everyRow.filter(
    (r) => (!picked("status").length || picked("status").includes(label(r.status))) && (!picked("po").length || picked("po").includes(r.poNumber ?? "")) && (!picked("product").length || picked("product").includes(r.productName)) && (!picked("customer").length || picked("customer").includes(r.customerName)) &&
      (!picked("transport").length || picked("transport").includes(r.transportName ?? "")) &&
      (!picked("lr").length || picked("lr").includes(r.lrNo ?? "")) &&
      (!picked("invoice").length || picked("invoice").includes(r.invoiceNo ?? "")) &&
      inAgingBuckets(r.status === "WITH_ACCOUNTS" ? agingDays(r.requestedAt) : null, picked("aging")) &&
      (!dateFrom || r.requestedAt.slice(0, 10) >= dateFrom) &&
      (!dateTo || r.requestedAt.slice(0, 10) <= dateTo),
  );
  const pg = useClientPaging(rows);
  const fail = (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Could not save");

  function open(r: FgWarehouseRequestRow, kind: "invoice" | "return") {
    setOpenFor({ id: r.id, kind });
    setInvoiceNo(r.invoiceNo ?? "");
    setInvoiceDate(r.invoiceDate ? r.invoiceDate.slice(0, 10) : today());
    setInvoiceAmount(r.invoiceAmount != null ? String(r.invoiceAmount) : r.goodsValue != null ? String(r.goodsValue) : "");
    setEwayBillNo(r.ewayBillNo ?? "");
    setEwayBillDate(r.ewayBillDate ? r.ewayBillDate.slice(0, 10) : "");
    setReason("");
  }

  function download() {
    const lines = rows.map((r) => ({
      Status: label(r.status),
      "PO Number": r.poNumber ?? "",
      Customer: r.customerName,
      "Customer Type": customerTypeLabel(r.customerName),
      Product: r.productName,
      Batch: r.batchNo ?? "",
      Unit: r.unit,
      Qty: r.quantity,
      "Transport Name": r.transportName ?? "",
      "Vehicle No.": r.vehicleNo ?? "",
      "LR No.": r.lrNo ?? "",
      "Weight (Kg)": r.weightKg ?? "",
      Cartons: r.cartonCount ?? "",
      "Goods Value": r.goodsValue ?? "",
      "Freight Charge": r.freightCharge ?? "",
      "Insurance Charge": r.insuranceCharge ?? "",
      "Invoice No.": r.invoiceNo ?? "",
      "Invoice Date": day(r.invoiceDate),
      "Invoice Amount": r.invoiceAmount ?? "",
      "E-way Bill No.": r.ewayBillNo ?? "",
      "E-way Bill Date": day(r.ewayBillDate),
      "With Accounts Since": day(r.requestedAt),
      "Sent back because": r.rejectedReason ?? "",
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Dispatch invoices", "FLS Customer Shipments with Accounts", describeFilters(filters, fields), lines, { totals: ["Qty"] });
    XLSX.writeFile(wb, stampedName("FLS_Dispatch_Invoices"));
  }

  const itemsFor = (r: FgWarehouseRequestRow): ActionMenuItem[] =>
    canAct && (r.status === "WITH_ACCOUNTS" || r.status === "READY_TO_SEND")
      ? [
          { key: "invoice", label: r.status === "READY_TO_SEND" ? "Edit invoice details" : "Add invoice and approve", icon: Receipt, tone: "primary", onClick: () => open(r, "invoice") },
          ...(r.status === "WITH_ACCOUNTS" ? [{ key: "return", label: "Send back to Dispatch", icon: Ban, tone: "danger" as const, onClick: () => open(r, "return") }] : []),
        ]
      : [];

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-amber-500/10 text-amber-600">
            <FileText className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Dispatch Invoices</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} customer shipment{rows.length === 1 ? "" : "s"} prepared by Dispatch. Add the invoice and e-way bill, and Dispatch can send it to the customer.
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm shrink-0" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey="accounts-dispatch" fields={fields} dateLabel="Sent to Accounts" />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={FileText} title="Nothing waiting" hint="Customer shipments Dispatch prepares show here for the invoice." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="whitespace-nowrap px-3 py-2.5">PO</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Status</th>
                  <th className="min-w-[11rem] px-3 py-2.5">Product</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Batch</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right">Qty</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Transport</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Vehicle no.</th>
                  <th className="whitespace-nowrap px-3 py-2.5">LR no.</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Weight / Cartons</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right">Goods value</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Freight / Insurance</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Invoice</th>
                  <th className="whitespace-nowrap px-3 py-2.5">With Accounts since</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Aging</th>
                  <th className="px-3 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r: FgWarehouseRequestRow) => (
                  <Fragment key={r.id}>
                    <tr className="border-b border-slate-50 align-top">
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-slate-600">{r.poNumber ?? "—"}</td>
                      <td className="px-3 py-2.5">
                        <span className={`pill whitespace-nowrap ${STATUS_PILL[r.status] ?? "border-slate-200 bg-slate-50 text-slate-600"}`}>{label(r.status)}</span>
                        {r.status === "SENT_BACK" && r.rejectedReason && <span className="mt-1 block max-w-[14rem] text-micro text-rose-600">{r.rejectedReason}</span>}
                      </td>
                      <td className="px-3 py-2.5 font-bold text-slate-800">
                        {r.productName}
                        <span className="block text-micro font-normal text-slate-400"><CustomerName name={r.customerName} /></span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-slate-600">{r.batchNo ?? "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-slate-700">
                        {fmtQty(r.quantity)} {r.unit}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{r.transportName ?? "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{r.vehicleNo ?? "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-slate-600">{r.lrNo ?? "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{[r.weightKg != null ? `${fmtQty(r.weightKg)} Kg` : null, r.cartonCount != null ? `${r.cartonCount} cartons` : null].filter(Boolean).join(" · ") || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-slate-700">{money(r.goodsValue)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">
                        <span className="block">Freight {money(r.freightCharge)}</span>
                        <span className="block">Insurance {money(r.insuranceCharge)}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">
                        {r.invoiceNo ?? "—"}
                        {r.invoiceNo && <span className="block text-micro text-slate-400">{[day(r.invoiceDate), r.invoiceAmount != null ? money(r.invoiceAmount) : null].filter(Boolean).join(" · ")}</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{day(r.requestedAt)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5">{r.status === "WITH_ACCOUNTS" ? <AgingCell since={r.requestedAt} /> : <span className="text-slate-300">—</span>}</td>
                      <td className="px-3 py-2.5 text-right">
                        <ActionMenu items={itemsFor(r)} />
                      </td>
                    </tr>
                    {openFor?.id === r.id && openFor.kind === "invoice" && (
                      <tr className="border-b border-slate-100">
                        <td colSpan={15} className="bg-slate-50 px-4 py-3">
                          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
                            <div>
                              <label className="mb-0.5 block text-micro text-slate-400">Invoice no.</label>
                              <input className="field !py-1.5 text-xs" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
                            </div>
                            <div>
                              <label className="mb-0.5 block text-micro text-slate-400">Invoice date</label>
                              <input type="date" className="field !py-1.5 text-xs" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
                            </div>
                            <div>
                              <label className="mb-0.5 block text-micro text-slate-400">Invoice amount (₹)</label>
                              <input type="number" min="0" step="any" className="field !py-1.5 text-xs" value={invoiceAmount} onChange={(e) => setInvoiceAmount(e.target.value)} />
                            </div>
                            <div>
                              <label className="mb-0.5 block text-micro text-slate-400">E-way bill no.</label>
                              <input className="field !py-1.5 text-xs" value={ewayBillNo} onChange={(e) => setEwayBillNo(e.target.value)} />
                            </div>
                            <div>
                              <label className="mb-0.5 block text-micro text-slate-400">E-way bill date</label>
                              <input type="date" className="field !py-1.5 text-xs" value={ewayBillDate} onChange={(e) => setEwayBillDate(e.target.value)} />
                            </div>
                          </div>
                          <div className="mt-2.5 flex justify-end gap-2">
                            <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenFor(null)}>
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="btn-primary btn-sm"
                              disabled={!invoiceNo.trim() || approve.isPending}
                              onClick={() =>
                                approve.mutate(
                                  { id: r.id, invoiceNo: invoiceNo.trim(), invoiceDate: invoiceDate || undefined, invoiceAmount: invoiceAmount.trim() === "" ? undefined : Number(invoiceAmount), ewayBillNo: ewayBillNo.trim() || undefined, ewayBillDate: ewayBillDate || undefined },
                                  { onSuccess: () => { toast.success("Saved. Dispatch can send it to the customer now."); setOpenFor(null); }, onError: fail },
                                )
                              }
                            >
                              {approve.isPending ? "Saving…" : r.status === "READY_TO_SEND" ? "Save" : "Approve: ready to send"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {openFor?.id === r.id && openFor.kind === "return" && (
                      <tr className="border-b border-slate-100">
                        <td colSpan={15} className="bg-slate-50 px-4 py-3">
                          <div className="flex flex-wrap items-end gap-2">
                            <div className="min-w-[16rem] flex-1">
                              <label className="mb-0.5 block text-micro text-slate-400">What does Dispatch have to correct?</label>
                              <input className="field !py-1.5 text-xs" value={reason} onChange={(e) => setReason(e.target.value)} />
                            </div>
                            <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenFor(null)}>
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="btn-danger btn-sm"
                              disabled={!reason.trim() || sendBack.isPending}
                              onClick={() => sendBack.mutate({ id: r.id, reason: reason.trim() }, { onSuccess: () => { toast.success("Sent back to Dispatch."); setOpenFor(null); }, onError: fail })}
                            >
                              Send back
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
