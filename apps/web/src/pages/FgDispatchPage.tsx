import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ChevronDown, Download, PackageCheck, Send, Truck, Warehouse } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  useDecideWarehouseRequest,
  useFgDispatchBoard,
  useFgWarehouseRequests,
  useReceiveFromDispatch,
  useRequestWarehouse,
  useResubmitShipment,
  useSendToCustomer,
  useSendToWarehouse,
  useShipToCustomer,
  useWithdrawShipment,
  type FgBatchRow,
  type FgShipment,
  type FgShipmentStatus,
  type FgWarehouseRequestRow,
} from "../lib/fgHooks";
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
const TRANSPORT = ["By Land", "By Courier", "By Air"] as const;
const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const STATUS_LABEL: Record<FgShipmentStatus, string> = { REQUESTED: "Asked the Warehouse", ACCEPTED: "Warehouse accepted", REJECTED: "Warehouse refused", SENT: "On the way", RECEIVED: "Received by Warehouse", DISPATCHED: "Sent to customer", WITH_ACCOUNTS: "With Accounts", READY_TO_SEND: "Ready to send", SENT_BACK: "Sent back by Accounts" };
const STATUS_PILL: Record<FgShipmentStatus, string> = {
  REQUESTED: "border-amber-200 bg-amber-50 text-amber-700",
  ACCEPTED: "border-sky-200 bg-sky-50 text-sky-700",
  REJECTED: "border-rose-200 bg-rose-50 text-rose-700",
  SENT: "border-violet-200 bg-violet-50 text-violet-700",
  RECEIVED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  DISPATCHED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  WITH_ACCOUNTS: "border-amber-200 bg-amber-50 text-amber-700",
  READY_TO_SEND: "border-sky-200 bg-sky-50 text-sky-700",
  SENT_BACK: "border-rose-200 bg-rose-50 text-rose-700",
};

// Dispatch's Finished Goods tile: what the Day Store has handed over, with what is left. A part can go to the customer straight away, or to the
// Warehouse - which is asked first and has to accept before Dispatch sends.
export function FgDispatchPage() {
  const { hasRole } = useAuth();
  const canAct = hasRole("DISPATCH", "ADMIN");
  const { data, isLoading } = useFgDispatchBoard({ shipped: true });
  const filters = useTileFilters();
  const [openId, setOpenId] = useState<string | null>(null);
  // "To send": goods still with Dispatch or a Warehouse request still open. "Sent": batches that have gone to the customer (a batch sent in
  // parts is in both until the last part has gone).
  const [tab, setTab] = useState<"send" | "sent">("send");
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const all = data ?? [];
  const isOpenRow = (r: FgBatchRow) => r.remainingQty > 1e-6 || r.shipments.some((s) => s.status === "REQUESTED" || s.status === "ACCEPTED" || s.status === "WITH_ACCOUNTS" || s.status === "READY_TO_SEND" || s.status === "SENT_BACK");
  const toCustomer = (r: FgBatchRow) => r.shipments.filter((s) => s.type === "CUSTOMER" && s.status === "DISPATCHED");
  const toSendRows = all.filter(isOpenRow);
  const sentRows = all.filter((r) => toCustomer(r).length > 0);
  const everyRow = tab === "send" ? toSendRows : sentRows;
  const sentInfo = (r: FgBatchRow) => {
    const ships = toCustomer(r);
    const dates = ships.map((x) => x.dispatchDate).filter((d): d is string => !!d).sort();
    return {
      qty: ships.reduce((a, x) => a + x.quantity, 0),
      last: dates.length ? dates[dates.length - 1]! : null,
      transport: [...new Set(ships.map((x) => x.transportType).filter(Boolean))].join(", "),
      invoices: [...new Set(ships.map((x) => x.invoiceNo).filter(Boolean))].join(", "),
    };
  };
  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct(everyRow.map((r) => r.poNumber)) },
    { key: "customer", label: "Customer", options: distinct(everyRow.map((r) => r.customerName)) },
    { key: "product", label: "Product", options: distinct(everyRow.map((r) => r.productName)) },
  ];
  const rows = everyRow.filter(
    (r) => (!picked("po").length || picked("po").includes(r.poNumber ?? "")) && (!picked("customer").length || picked("customer").includes(r.customerName)) && (!picked("product").length || picked("product").includes(r.productName)),
  );
  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;

  function download() {
    const lines = rows.flatMap<Record<string, unknown>>((r) =>
      r.shipments.length
        ? r.shipments.map((s) => ({ "PO Number": r.poNumber ?? "", Customer: r.customerName, "Customer Type": customerTypeLabel(r.customerName), Product: r.productName, Batch: r.batchNo ?? "", Unit: r.unit, "Approved Qty": r.approvedQty, "Left With Dispatch": r.remainingQty, "Shipment To": s.type === "CUSTOMER" ? "Customer" : "Warehouse", Status: STATUS_LABEL[s.status], "Shipment Qty": s.quantity, "Dispatch Date": day(s.dispatchDate), Transport: s.transportType ?? "", "Transport Name": s.transportName ?? "", "Vehicle No.": s.vehicleNo ?? "", "LR No.": s.lrNo ?? "", "Weight (Kg)": s.weightKg ?? "", Cartons: s.cartonCount ?? "", "Goods Value": s.goodsValue ?? "", "Freight Charge": s.freightCharge ?? "", "Insurance Charge": s.insuranceCharge ?? "", "Invoice No.": s.invoiceNo ?? "" }))
        : [{ "PO Number": r.poNumber ?? "", Customer: r.customerName, "Customer Type": customerTypeLabel(r.customerName), Product: r.productName, Batch: r.batchNo ?? "", Unit: r.unit, "Approved Qty": r.approvedQty, "Left With Dispatch": r.remainingQty, "Shipment To": "", Status: "", "Shipment Qty": "", "Dispatch Date": "", Transport: "", "Transport Name": "", "Vehicle No.": "", "LR No.": "", "Weight (Kg)": "", Cartons: "", "Goods Value": "", "Freight Charge": "", "Insurance Charge": "", "Invoice No.": "" }],
    );
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Finished goods", "FLS Finished Goods (Dispatch)", describeFilters(filters, fields), lines);
    XLSX.writeFile(wb, stampedName("FLS_Finished_Goods_Dispatch"));
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-emerald-500/10 text-emerald-600">
            <PackageCheck className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Finished Goods</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} batch{rows.length === 1 ? "" : "es"}
              {isFiltered ? ` of ${everyRow.length}` : ""} {tab === "send" ? "with Dispatch. Send them to the customer, or to the Warehouse (it is asked first)." : "sent to the customer. Open one to see each shipment."}
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {([["send", "To send", toSendRows.length], ["sent", "Sent to customer", sentRows.length]] as const).map(([k, label, n]) => (
          <button key={k} type="button" onClick={() => { setTab(k); setOpenId(null); }} className={`pill cursor-pointer ${k === tab ? "border-brand-300 bg-brand-50 text-brand-700 ring-2 ring-brand-200" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}>
            {label} · {n}
          </button>
        ))}
      </div>

      <TileFilterBar filters={filters} tileKey={`fg-dispatch-${tab}`} fields={fields} dateLabel="Handed over" hideDates />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={PackageCheck} title={isFiltered ? "Nothing matches these filters" : tab === "send" ? "No finished goods with Dispatch" : "Nothing sent to a customer yet"} hint={tab === "send" ? "They show here once the Day Store has handed over what QA approved." : "A batch shows here once you have sent some of it to the customer."} />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2.5">PO</th>
                  <th className="px-4 py-2.5">Product</th>
                  <th className="px-4 py-2.5">Batch</th>
                  <th className="px-4 py-2.5 text-right">Approved</th>
                  {tab === "send" ? (
                    <>
                      <th className="px-4 py-2.5 text-right">Sent</th>
                      <th className="px-4 py-2.5 text-right">Left with Dispatch</th>
                      <th className="px-4 py-2.5">Handed over</th>
                    </>
                  ) : (
                    <>
                      <th className="px-4 py-2.5 text-right">Sent to customer</th>
                      <th className="px-4 py-2.5 text-right">Left with Dispatch</th>
                      <th className="px-4 py-2.5">Last dispatched</th>
                      <th className="px-4 py-2.5">Transport</th>
                      <th className="px-4 py-2.5">Invoice</th>
                    </>
                  )}
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r) => {
                  const open = openId === r.batchId;
                  const openRequests = r.shipments.filter((s) => s.status === "REQUESTED" || s.status === "ACCEPTED" || s.status === "SENT").length;
                  return (
                    <Fragment key={r.batchId}>
                      <tr className="border-b border-slate-50">
                        <td className="px-4 py-2.5 font-mono text-slate-600">{r.poNumber ?? "—"}</td>
                        <td className="px-4 py-2.5 font-bold text-slate-800">
                          {r.productName}
                          <span className="block text-micro font-normal text-slate-400"><CustomerName name={r.customerName} /></span>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-slate-600">{r.batchNo ?? "—"}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                          {fmtQty(r.approvedQty)} {r.unit}
                        </td>
                        {tab === "send" ? (
                          <>
                            <td className="px-4 py-2.5 text-right font-mono text-slate-700">{r.shippedQty ? fmtQty(r.shippedQty) : "—"}</td>
                            <td className="px-4 py-2.5 text-right font-mono font-bold text-slate-900">
                              {fmtQty(r.remainingQty)}
                              {openRequests > 0 && <span className="block text-micro font-bold text-amber-600">{openRequests} warehouse request{openRequests === 1 ? "" : "s"} open</span>}
                            </td>
                            <td className="px-4 py-2.5 text-slate-600">{day(r.handedOverAt)}</td>
                          </>
                        ) : (
                          <>
                            <td className="px-4 py-2.5 text-right font-mono font-bold text-emerald-700">{fmtQty(sentInfo(r).qty)} {r.unit}</td>
                            <td className="px-4 py-2.5 text-right font-mono text-slate-700">{fmtQty(r.remainingQty)}</td>
                            <td className="px-4 py-2.5 text-slate-600">{day(sentInfo(r).last)}</td>
                            <td className="px-4 py-2.5 text-slate-600">{sentInfo(r).transport || "—"}</td>
                            <td className="px-4 py-2.5 text-slate-600">{sentInfo(r).invoices || "—"}</td>
                          </>
                        )}
                        <td className="px-4 py-2.5 text-right">
                          <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenId(open ? null : r.batchId)}>
                            {tab === "sent" ? "Shipments" : canAct ? "Send" : "View"} <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-slate-100">
                          <td colSpan={tab === "send" ? 8 : 10} className="whitespace-normal bg-slate-50/70 px-4 py-4">
                            <SendPanel row={r} canAct={canAct} />
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

// Transport and charges of a shipment (to the customer, or on its way to the Warehouse): the same fields in both forms.
interface ShipDetailState {
  transportName: string;
  vehicleNo: string;
  lrNo: string;
  weightKg: string;
  cartonCount: string;
  goodsValue: string;
  freightCharge: string;
  insuranceCharge: string;
  insuranceEdited: boolean;
}
const EMPTY_DETAILS: ShipDetailState = { transportName: "", vehicleNo: "", lrNo: "", weightKg: "", cartonCount: "", goodsValue: "", freightCharge: "", insuranceCharge: "", insuranceEdited: false };
const INSURANCE_RATE = 0.001; // 0.1% of the goods value, unless Dispatch types another figure
const num = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
function detailsBody(d: ShipDetailState) {
  return {
    transportName: d.transportName.trim() || undefined,
    vehicleNo: d.vehicleNo.trim() || undefined,
    lrNo: d.lrNo.trim() || undefined,
    weightKg: num(d.weightKg),
    cartonCount: num(d.cartonCount) === undefined ? undefined : Math.round(num(d.cartonCount)!),
    goodsValue: num(d.goodsValue),
    freightCharge: num(d.freightCharge),
    insuranceCharge: num(d.insuranceCharge),
  };
}

function ShipmentDetailFields({ d, set, customerName }: { d: ShipDetailState; set: (next: ShipDetailState) => void; customerName: string }) {
  const change = (patch: Partial<ShipDetailState>) => set({ ...d, ...patch });
  const input = (label: string, key: keyof ShipDetailState, type = "text", hint?: string) => (
    <div>
      <label className="mb-0.5 block text-micro text-slate-400">{label}</label>
      <input type={type} min={type === "number" ? "0" : undefined} step={type === "number" ? "any" : undefined} className="field !py-1.5 text-xs" value={String(d[key])} onChange={(e) => change({ [key]: e.target.value })} title={hint} />
    </div>
  );
  return (
    <>
      <div>
        <label className="mb-0.5 block text-micro text-slate-400">Customer</label>
        <input className="field !py-1.5 text-xs" value={customerName} readOnly disabled />
      </div>
      {input("Transport name", "transportName")}
      {input("Vehicle no.", "vehicleNo")}
      {input("LR no.", "lrNo")}
      {input("Weight (Kg)", "weightKg", "number")}
      {input("Cartons (count)", "cartonCount", "number")}
      <div>
        <label className="mb-0.5 block text-micro text-slate-400">Goods value (₹)</label>
        <input
          type="number"
          min="0"
          step="any"
          className="field !py-1.5 text-xs"
          value={d.goodsValue}
          onChange={(e) => {
            const goodsValue = e.target.value;
            const value = num(goodsValue);
            change({ goodsValue, ...(d.insuranceEdited ? {} : { insuranceCharge: value === undefined ? "" : String(Math.round(value * INSURANCE_RATE * 100) / 100) }) });
          }}
        />
      </div>
      {input("Freight charge (₹)", "freightCharge", "number", "What carrying the goods costs")}
      <div>
        <label className="mb-0.5 block text-micro text-slate-400">Insurance charge (₹) · 0.1% of goods value, you can change it</label>
        <input type="number" min="0" step="any" className="field !py-1.5 text-xs" value={d.insuranceCharge} onChange={(e) => change({ insuranceCharge: e.target.value, insuranceEdited: true })} />
      </div>
    </>
  );
}

// One set of fields for every shipment form (to the customer, or to the Warehouse): the same inputs in both.
interface ShipForm {
  dispatchDate: string;
  transport: string;
  invoiceNo: string;
  pickedBy: string;
  pickingDate: string;
  loadedBy: string;
  loadingDate: string;
  remarks: string;
  details: ShipDetailState;
}
const emptyForm = (): ShipForm => ({ dispatchDate: today(), transport: "", invoiceNo: "", pickedBy: "", pickingDate: today(), loadedBy: "", loadingDate: today(), remarks: "", details: EMPTY_DETAILS });
function shipBody(f: ShipForm) {
  return {
    dispatchDate: f.dispatchDate,
    transportType: f.transport || undefined,
    pickedBy: f.pickedBy.trim() || undefined,
    pickingDate: f.pickingDate,
    loadedBy: f.loadedBy.trim() || undefined,
    loadingDate: f.loadingDate,
    remarks: f.remarks.trim() || undefined,
    ...detailsBody(f.details),
  };
}
function ShipFormFields({ f, set, customerName }: { f: ShipForm; set: (next: ShipForm) => void; customerName: string }) {
  const change = (patch: Partial<ShipForm>) => set({ ...f, ...patch });
  const text = (label: string, key: "invoiceNo" | "pickedBy" | "loadedBy") => (
    <div>
      <label className="mb-0.5 block text-micro text-slate-400">{label}</label>
      <input className="field !py-1.5 text-xs" value={f[key]} onChange={(e) => change({ [key]: e.target.value })} />
    </div>
  );
  const date = (label: string, key: "dispatchDate" | "pickingDate" | "loadingDate") => (
    <div>
      <label className="mb-0.5 block text-micro text-slate-400">{label}</label>
      <input type="date" className="field !py-1.5 text-xs" value={f[key]} onChange={(e) => change({ [key]: e.target.value })} />
    </div>
  );
  return (
    <>
      {date("Dispatch date", "dispatchDate")}
      <div>
        <label className="mb-0.5 block text-micro text-slate-400">Transport</label>
        <select className="field !py-1.5 text-xs" value={f.transport} onChange={(e) => change({ transport: e.target.value })}>
          <option value="">— choose —</option>
          {TRANSPORT.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      {text("Picked by", "pickedBy")}
      {date("Picking date", "pickingDate")}
      {text("Loaded by", "loadedBy")}
      {date("Loading date", "loadingDate")}
      <ShipmentDetailFields d={f.details} set={(details) => change({ details })} customerName={customerName} />
      <div className="col-span-2 sm:col-span-4">
        <label className="mb-0.5 block text-micro text-slate-400">Remarks</label>
        <input className="field !py-1.5 text-xs" value={f.remarks} onChange={(e) => change({ remarks: e.target.value })} />
      </div>
    </>
  );
}

function SendPanel({ row, canAct }: { row: FgBatchRow; canAct: boolean }) {
  const toast = useToast();
  const toCustomer = useShipToCustomer();
  const askWarehouse = useRequestWarehouse();
  const [mode, setMode] = useState<"customer" | "warehouse">("customer");
  const [qty, setQty] = useState(String(row.remainingQty));
  const [form, setForm] = useState<ShipForm>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const busy = toCustomer.isPending || askWarehouse.isPending;

  async function submit() {
    setError(null);
    const quantity = Number(qty);
    if (!(quantity > 0)) return setError("Enter the quantity.");
    if (quantity > row.remainingQty + 1e-6) return setError(`Only ${fmtQty(row.remainingQty)} is left with Dispatch.`);
    try {
      if (mode === "customer") {
        await toCustomer.mutateAsync({ batchId: row.batchId, quantity, ...shipBody(form) });
        toast.success(`${fmtQty(quantity)} ${row.unit} sent to Accounts. You can send it to the customer once Accounts adds the invoice.`);
      } else {
        await askWarehouse.mutateAsync({ batchId: row.batchId, quantity, note: form.remarks.trim() || undefined, ...shipBody(form) });
        toast.success(`The Warehouse has been told you want to send ${fmtQty(quantity)} ${row.unit}. You can send it once it accepts.`);
      }
      setQty(String(Math.max(0, Math.round((row.remainingQty - quantity) * 1000) / 1000)));
      setForm(emptyForm());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <div className="space-y-4">
      {row.shipments.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full whitespace-nowrap text-xs">
            <thead className="bg-slate-50 text-micro font-bold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">To</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Dispatch date</th>
                <th className="px-3 py-2 text-left">Transport / LR</th>
                <th className="px-3 py-2 text-left">Charges</th>
                <th className="px-3 py-2 text-left">Invoice</th>
                <th className="px-3 py-2 text-left" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {row.shipments.map((s) => (
                <ShipmentRow key={s.id} shipment={s} unit={row.unit} canAct={canAct} customerName={row.customerName} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canAct && row.remainingQty > 1e-6 && (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => setMode("customer")} className={`pill cursor-pointer ${mode === "customer" ? "border-brand-300 bg-brand-50 text-brand-700 ring-2 ring-brand-200" : "border-slate-200 text-slate-600"}`}>
              <Truck className="h-3 w-3" strokeWidth={2.5} /> Send to customer (via Accounts)
            </button>
            <button type="button" onClick={() => setMode("warehouse")} className={`pill cursor-pointer ${mode === "warehouse" ? "border-brand-300 bg-brand-50 text-brand-700 ring-2 ring-brand-200" : "border-slate-200 text-slate-600"}`}>
              <Warehouse className="h-3 w-3" strokeWidth={2.5} /> Send to Warehouse
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <div>
              <label className="mb-0.5 block text-micro text-slate-400">Quantity ({row.unit}), up to {fmtQty(row.remainingQty)}</label>
              <input type="number" min="0" step="any" className="field !py-1.5 text-xs" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <ShipFormFields f={form} set={setForm} customerName={row.customerName} />
          </div>
          {mode === "warehouse" && <p className="text-micro text-slate-500">The Warehouse is told how much is coming. It has to accept before you can send it; the details you enter here are kept for that send.</p>}
          {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
          <div className="flex justify-end">
            <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={submit}>
              <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {busy ? "Saving…" : mode === "customer" ? "Send to Accounts" : "Ask the Warehouse"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ShipmentRow({ shipment: s, unit, canAct, customerName }: { shipment: FgShipment; unit: string; canAct: boolean; customerName: string }) {
  const toast = useToast();
  const send = useSendToWarehouse();
  const withdraw = useWithdrawShipment();
  const resubmit = useResubmitShipment();
  const sendToCustomer = useSendToCustomer();
  const [sendOpen, setSendOpen] = useState(false);
  const [form, setForm] = useState<ShipForm>(() => ({
    ...emptyForm(),
    transport: s.transportType ?? "",
    pickedBy: s.pickedBy ?? "",
    loadedBy: s.loadedBy ?? "",
    remarks: s.remarks ?? s.note ?? "",
    details: {
      ...EMPTY_DETAILS,
      transportName: s.transportName ?? "",
      vehicleNo: s.vehicleNo ?? "",
      lrNo: s.lrNo ?? "",
      weightKg: s.weightKg != null ? String(s.weightKg) : "",
      cartonCount: s.cartonCount != null ? String(s.cartonCount) : "",
      goodsValue: s.goodsValue != null ? String(s.goodsValue) : "",
      freightCharge: s.freightCharge != null ? String(s.freightCharge) : "",
      insuranceCharge: s.insuranceCharge != null ? String(s.insuranceCharge) : "",
      insuranceEdited: s.insuranceCharge != null,
    },
  }));
  const fail = (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Could not save");

  return (
    <>
      <tr>
        <td className="px-3 py-1.5 font-bold text-slate-700">{s.type === "CUSTOMER" ? "Customer" : "Warehouse"}</td>
        <td className="px-3 py-1.5 text-right font-mono text-slate-700">
          {fmtQty(s.quantity)} {unit}
        </td>
        <td className="px-3 py-1.5">
          <span className={`pill ${STATUS_PILL[s.status]}`}>{STATUS_LABEL[s.status]}</span>
          {(s.status === "REJECTED" || s.status === "SENT_BACK") && s.rejectedReason && <span className="ml-1.5 text-micro text-rose-600">{s.rejectedReason}</span>}
        </td>
        <td className="px-3 py-1.5 text-slate-600">{day(s.dispatchDate)}</td>
        <td className="px-3 py-1.5 text-slate-600">
          {[s.transportName, s.vehicleNo, s.lrNo ? `LR ${s.lrNo}` : null].filter(Boolean).join(" · ") || "—"}
          {(s.weightKg != null || s.cartonCount != null) && (
            <span className="block text-micro text-slate-400">{[s.weightKg != null ? `${fmtQty(s.weightKg)} Kg` : null, s.cartonCount != null ? `${s.cartonCount} cartons` : null].filter(Boolean).join(" · ")}</span>
          )}
        </td>
        <td className="px-3 py-1.5 text-slate-600">
          {s.freightCharge != null || s.insuranceCharge != null ? (
            <>
              {s.freightCharge != null && <span className="block">Freight ₹{fmtQty(s.freightCharge)}</span>}
              {s.insuranceCharge != null && <span className="block">Insurance ₹{fmtQty(s.insuranceCharge)}</span>}
            </>
          ) : (
            "—"
          )}
        </td>
        <td className="px-3 py-1.5 text-slate-600">
          {s.type === "CUSTOMER" ? (s.invoiceNo ?? "—") : "—"}
        </td>
        <td className="px-3 py-1.5 text-right">
          {canAct && s.type === "CUSTOMER" && s.status === "READY_TO_SEND" && (
            <button type="button" className="btn-primary btn-sm" disabled={sendToCustomer.isPending} onClick={() => sendToCustomer.mutate(s.id, { onSuccess: () => toast.success("Sent to the customer."), onError: fail })}>
              Send to customer
            </button>
          )}
          {canAct && s.type === "CUSTOMER" && s.status === "SENT_BACK" && (
            <button type="button" className="btn-primary btn-sm" onClick={() => setSendOpen((v) => !v)}>
              Correct and resubmit
            </button>
          )}
          {canAct && s.type === "CUSTOMER" && (s.status === "WITH_ACCOUNTS" || s.status === "READY_TO_SEND" || s.status === "SENT_BACK") && (
            <button type="button" className="btn-ghost btn-sm ml-1" disabled={withdraw.isPending} onClick={() => window.confirm("Withdraw this shipment? The quantity goes back to Dispatch.") && withdraw.mutate(s.id, { onError: fail })}>
              Withdraw
            </button>
          )}
          {canAct && s.type === "WAREHOUSE" && s.status === "ACCEPTED" && (
            <button type="button" className="btn-primary btn-sm" onClick={() => setSendOpen((v) => !v)}>
              Send now
            </button>
          )}
          {canAct && s.type === "WAREHOUSE" && (s.status === "REQUESTED" || s.status === "ACCEPTED") && (
            <button type="button" className="btn-ghost btn-sm ml-1" disabled={withdraw.isPending} onClick={() => window.confirm("Withdraw this request to the Warehouse?") && withdraw.mutate(s.id, { onError: fail })}>
              Withdraw
            </button>
          )}
        </td>
      </tr>
      {sendOpen && (
        <tr>
          <td colSpan={8} className="bg-slate-50 px-3 py-2">
            <div className="mb-2 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <ShipFormFields f={form} set={setForm} customerName={customerName} />
            </div>
            <div className="flex flex-wrap items-end gap-2">
              {s.type === "CUSTOMER" ? (
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={resubmit.isPending}
                  onClick={() =>
                    resubmit.mutate(
                      { id: s.id, ...shipBody(form) },
                      { onSuccess: () => { toast.success("Sent to Accounts again."); setSendOpen(false); }, onError: fail },
                    )
                  }
                >
                  <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {resubmit.isPending ? "Sending…" : "Send to Accounts again"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={send.isPending}
                  onClick={() =>
                    send.mutate(
                      { id: s.id, ...shipBody(form) },
                      { onSuccess: () => { toast.success("Sent. The Warehouse will confirm when it arrives."); setSendOpen(false); }, onError: fail },
                    )
                  }
                >
                  <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {send.isPending ? "Sending…" : "Mark as sent"}
                </button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// The Warehouse's list of finished-goods requests from Dispatch: accept (or refuse with a reason), and confirm when the goods arrive.
export function FgWarehouseRequestsPage() {
  const { hasRole } = useAuth();
  const canAct = hasRole("STORE", "ADMIN");
  const { data, isLoading } = useFgWarehouseRequests();
  const decide = useDecideWarehouseRequest();
  const receive = useReceiveFromDispatch();
  const toast = useToast();
  const filters = useTileFilters();
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const everyRow = data ?? [];
  const fields: FilterField[] = [
    { key: "status", label: "Status", options: (["REQUESTED", "ACCEPTED", "SENT", "RECEIVED", "REJECTED"] as FgShipmentStatus[]).map((s) => STATUS_LABEL[s]) },
    { key: "product", label: "Product", options: distinct(everyRow.map((r) => r.productName)) },
    { key: "po", label: "PO Number", options: distinct(everyRow.map((r) => r.poNumber)) },
  ];
  const rows = everyRow.filter((r) => (!picked("status").length || picked("status").includes(STATUS_LABEL[r.status])) && (!picked("product").length || picked("product").includes(r.productName)) && (!picked("po").length || picked("po").includes(r.poNumber ?? "")));
  const pg = useClientPaging(rows);
  const fail = (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Could not save");

  function download() {
    const lines = rows.map((r) => ({ "PO Number": r.poNumber ?? "", Customer: r.customerName, "Customer Type": customerTypeLabel(r.customerName), Product: r.productName, Batch: r.batchNo ?? "", Plant: r.plantName ?? "", Unit: r.unit, Qty: r.quantity, Status: STATUS_LABEL[r.status], Requested: day(r.requestedAt), "Dispatch Date": day(r.dispatchDate), Received: day(r.receivedAt), Reason: r.rejectedReason ?? "" }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "FG requests", "FLS Finished Goods Requests", describeFilters(filters, fields), lines, { totals: ["Qty"] });
    XLSX.writeFile(wb, stampedName("FLS_FG_Warehouse_Requests"));
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-emerald-500/10 text-emerald-600">
            <Warehouse className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Finished Goods Requests</h1>
            <p className="text-sm text-slate-500">{rows.length.toLocaleString()} request{rows.length === 1 ? "" : "s"} from Dispatch. Accept what you can take, and confirm when it arrives.</p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey="fg-warehouse-requests" fields={fields} dateLabel="Requested" hideDates />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Warehouse} title="No requests" hint="Dispatch's requests to send finished goods to the Warehouse show here." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2.5">PO</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Product</th>
                  <th className="px-4 py-2.5">Batch</th>
                  <th className="px-4 py-2.5 text-right">Qty</th>
                  <th className="px-4 py-2.5">Requested</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r: FgWarehouseRequestRow) => (
                  <Fragment key={r.id}>
                    <tr className="border-b border-slate-50">
                      <td className="px-4 py-2.5 font-mono text-slate-600">{r.poNumber ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        <span className={`pill ${STATUS_PILL[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                        {r.status === "REJECTED" && r.rejectedReason && <span className="block text-micro text-rose-600">{r.rejectedReason}</span>}
                      </td>
                      <td className="px-4 py-2.5 font-bold text-slate-800">
                        {r.productName}
                        <span className="block text-micro font-normal text-slate-400"><CustomerName name={r.customerName} /></span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-slate-600">{r.batchNo ?? "—"}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                        {fmtQty(r.quantity)} {r.unit}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">{day(r.requestedAt)}</td>
                      <td className="px-4 py-2.5 text-right">
                        {canAct && r.status === "REQUESTED" && (
                          <>
                            <button type="button" className="btn-primary btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, action: "ACCEPT" }, { onSuccess: () => toast.success("Accepted. Dispatch can send it now."), onError: fail })}>
                              Accept
                            </button>
                            <button type="button" className="btn-ghost btn-sm ml-1" onClick={() => { setReasonFor(reasonFor === r.id ? null : r.id); setReason(""); }}>
                              Refuse
                            </button>
                          </>
                        )}
                        {canAct && r.status === "SENT" && (
                          <button type="button" className="btn-primary btn-sm" disabled={receive.isPending} onClick={() => receive.mutate(r.id, { onSuccess: () => toast.success("Received. It is now in the Warehouse's finished-goods stock."), onError: fail })}>
                            Confirm received
                          </button>
                        )}
                      </td>
                    </tr>
                    {reasonFor === r.id && (
                      <tr className="border-b border-slate-100">
                        <td colSpan={7} className="bg-slate-50 px-4 py-2.5">
                          <div className="flex flex-wrap items-end gap-2">
                            <div className="min-w-[16rem] flex-1">
                              <label className="mb-0.5 block text-micro text-slate-400">Why can you not take it?</label>
                              <input className="field !py-1.5 text-xs" value={reason} onChange={(e) => setReason(e.target.value)} />
                            </div>
                            <button
                              type="button"
                              className="btn-danger btn-sm"
                              disabled={!reason.trim() || decide.isPending}
                              onClick={() => decide.mutate({ id: r.id, action: "REJECT", reason: reason.trim() }, { onSuccess: () => { toast.success("Refused. Dispatch has been told."); setReasonFor(null); }, onError: fail })}
                            >
                              Refuse request
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
