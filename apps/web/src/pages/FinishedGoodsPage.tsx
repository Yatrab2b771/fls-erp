import { fmtQty } from "../lib/format";
import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Ban, CheckCircle2, ChevronDown, Download, PackageCheck, PackageOpen, Send, Undo2 } from "lucide-react";
import { ApiError, api, apiAll } from "../lib/api";
import { usePagedList } from "../lib/usePagedList";
import { appendParams, useTileFilters } from "../lib/tileFilters";
import { exportFgListReport, type FgListRow } from "../lib/inventoryExport";
import { Pagination } from "../components/Pagination";
import { AgingCell } from "../components/AgingCell";
import { TileFilterBar, AGING_FIELD, type FilterField } from "../components/TileFilterBar";
import type { OptionPage } from "../components/MultiSelectDropdown";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { useAuth } from "../lib/auth";
import { ActionMenu, type ActionMenuItem } from "../components/ActionMenu";
import { useFgStockRequests, useReceiveFgFromWarehouse, useRefuseFgStockRequest, useRequestFgStock, useSendFgToDispatch, useWithdrawShipment } from "../lib/fgHooks";
import { CustomerName } from "../components/CustomerName";

const BASE = "/api/inventory/fg-list";

const serverList = (key: string, label: string): FilterField => ({
  key,
  label,
  load: (q) => api<OptionPage>(`${BASE}/options?field=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
});
const FIELDS: FilterField[] = [serverList("po", "PO Number"), serverList("product", "Product"), serverList("customer", "Customer"), serverList("plant", "Plant"), serverList("batch", "Batch / Lot"), AGING_FIELD];

const dayOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const REQUEST_LABEL: Record<string, { text: string; pill: string }> = {
  REQUESTED: { text: "Asked", pill: "border-amber-200 bg-amber-50 text-amber-700" },
  SENT: { text: "On the way", pill: "border-violet-200 bg-violet-50 text-violet-700" },
};

// Finished goods that have reached the FG Store (or a later stage) and still have quantity left,
// one row per batch / lot. Qty = Produced - Dispatched, the same maths as the other FG views.
export function FinishedGoodsPage() {
  const toast = useToast();
  const { hasRole } = useAuth();
  // Dispatch asks the Warehouse for stock to send to a customer; the Warehouse sends it, Dispatch confirms (FG Stock Requests).
  const canAsk = hasRole("DISPATCH", "ADMIN");
  const isWarehouse = hasRole("STORE", "ADMIN");
  const { data: stockRequests } = useFgStockRequests();
  const sendToDispatch = useSendFgToDispatch();
  const refuseRequest = useRefuseFgStockRequest();
  const receiveFromWarehouse = useReceiveFgFromWarehouse();
  const withdrawRequest = useWithdrawShipment();
  const [openReq, setOpenReq] = useState<string | null>(null);
  const [refuseFor, setRefuseFor] = useState<string | null>(null);
  const [refuseReason, setRefuseReason] = useState("");
  // The open requests (asked, or sent and not yet confirmed) of each batch
  const openByBatch = new Map<string, NonNullable<typeof stockRequests>>();
  for (const r of stockRequests ?? []) if (r.status === "REQUESTED" || r.status === "SENT") openByBatch.set(r.batchId, [...(openByBatch.get(r.batchId) ?? []), r]);
  const fail = (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Could not save");
  const requestStock = useRequestFgStock();
  const [askFor, setAskFor] = useState<string | null>(null);
  const [askQty, setAskQty] = useState("");
  const [askNote, setAskNote] = useState("");
  const tileFilters = useTileFilters();
  const [exporting, setExporting] = useState(false);
  const paged = usePagedList<FgListRow>({ key: ["inventory", "fg-list", "list"], path: BASE, params: tileFilters.params, noSearch: true });
  const isFiltered = tileFilters.activeCount > 0;

  async function exportAll() {
    setExporting(true);
    try {
      const qs = appendParams(new URLSearchParams(), tileFilters.params);
      exportFgListReport(await apiAll<FgListRow>(`${BASE}${qs.toString() ? `?${qs}` : ""}`));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not build the report");
    } finally {
      setExporting(false);
    }
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
              {paged.total.toLocaleString()} batch/lot(s){isFiltered ? " match" : " in stock"} — at the FG Store or later, not yet fully dispatched
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-primary btn-sm" disabled={paged.total === 0 || exporting} onClick={exportAll}>
            <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> {exporting ? "Preparing…" : `Download Report${isFiltered ? " (Filtered)" : ""}`}
          </button>
        </div>
      </div>

      <TileFilterBar filters={tileFilters} tileKey="finished-goods" fields={FIELDS} dateLabel="In FG Store" />

      {paged.isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : paged.total === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "No finished goods in stock"} hint={isFiltered ? "Nothing matches these filters." : "Batches show here once Store confirms them into the FG Store."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-3 py-3">PO Number</th>
                <th className="px-3 py-3">Product</th>
                <th className="px-3 py-3">Customer</th>
                <th className="px-3 py-3">Plant</th>
                <th className="px-3 py-3 text-right">Qty</th>
                <th className="px-3 py-3">Batch / Lot</th>
                <th className="px-3 py-3">In FG Store</th>
                <th className="px-3 py-3">Aging</th>
                {(canAsk || isWarehouse) && <th className="px-3 py-3">Request</th>}
                {(canAsk || isWarehouse) && <th className="px-3 py-3 text-right">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.rows.map((r) => (
                <Fragment key={`${r.kind}:${r.id}`}>
                <tr className="transition hover:bg-slate-50">
                  <td className="whitespace-nowrap px-3 py-3 font-bold text-brand-700">{r.poNumber ?? "—"}</td>
                  <td className="px-3 py-3 font-bold text-slate-700">{r.productName}</td>
                  <td className="px-3 py-3 text-slate-600"><CustomerName name={r.customerName} /></td>
                  <td className="px-3 py-3 text-slate-600">{r.plantName ?? <span className="text-slate-300">—</span>}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono font-bold text-slate-900">
                    {fmtQty(r.onHandQty)} {r.unit}
                    {r.dispatchedQty > 0 && <span className="block font-sans text-micro font-medium text-slate-400">of {fmtQty(r.producedQty)} produced</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-500">{r.label}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-500">{r.fgStoreDate ? new Date(r.fgStoreDate).toLocaleDateString() : "—"}</td>
                  <td className="whitespace-nowrap px-3 py-3">
                    <AgingCell since={r.fgStoreDate} />
                  </td>
                  {(canAsk || isWarehouse) && (
                    <td className="px-3 py-3">
                      {(openByBatch.get(r.id) ?? []).length === 0 ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        (() => {
                          const list = openByBatch.get(r.id) ?? [];
                          const one = list.length === 1 ? list[0]! : null;
                          const tone = one ? (REQUEST_LABEL[one.status]?.pill ?? "border-slate-200 bg-slate-50 text-slate-600") : "border-slate-200 bg-slate-50 text-slate-600";
                          return (
                            <button type="button" className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-bold transition hover:brightness-95 ${tone}`} onClick={() => setOpenReq(openReq === r.id ? null : r.id)} aria-expanded={openReq === r.id}>
                              {one ? `${REQUEST_LABEL[one.status]?.text ?? one.status} · ${fmtQty(one.quantity)} ${one.unit}` : `${list.length} requests`}
                              <ChevronDown className={`h-3 w-3 transition-transform ${openReq === r.id ? "rotate-180" : ""}`} strokeWidth={2.5} />
                            </button>
                          );
                        })()
                      )}
                    </td>
                  )}
                  {(canAsk || isWarehouse) && (
                    <td className="px-3 py-3 text-right">
                      <ActionMenu
                        items={(() => {
                          const items: ActionMenuItem[] = [];
                          for (const q of openByBatch.get(r.id) ?? []) {
                            const qty = `${fmtQty(q.quantity)} ${r.unit}`;
                            if (isWarehouse && q.status === "REQUESTED") {
                              items.push({ key: `send-${q.id}`, label: `Send ${qty} to Dispatch`, icon: Send, tone: "primary", onClick: () => sendToDispatch.mutate(q.id, { onSuccess: () => toast.success("Sent to Dispatch. Your stock is down by that much."), onError: fail }) });
                              items.push({ key: `refuse-${q.id}`, label: `Refuse ${qty} request`, icon: Ban, tone: "danger", onClick: () => { setRefuseFor(q.id); setRefuseReason(""); } });
                            }
                            if (canAsk && q.status === "SENT") {
                              items.push({ key: `receive-${q.id}`, label: `Confirm ${qty} received`, icon: CheckCircle2, tone: "primary", onClick: () => receiveFromWarehouse.mutate(q.id, { onSuccess: () => toast.success("Received. It is with Dispatch now: send it to the customer."), onError: fail }) });
                            }
                            if (canAsk && q.status === "REQUESTED") {
                              items.push({ key: `withdraw-${q.id}`, label: `Withdraw ${qty} request`, icon: Undo2, onClick: () => withdrawRequest.mutate(q.id, { onSuccess: () => toast.success("Request withdrawn."), onError: fail }) });
                            }
                          }
                          if (canAsk && r.kind === "BATCH" && r.onHandQty > 1e-6) {
                            items.push({ key: "ask", label: "Ask for Dispatch", icon: PackageCheck, onClick: () => { setAskFor(askFor === r.id ? null : r.id); setAskQty(String(r.onHandQty)); setAskNote(""); } });
                          }
                          return items;
                        })()}
                      />
                    </td>
                  )}
                </tr>
                {openReq === r.id && (openByBatch.get(r.id) ?? []).length > 0 && (
                  <>
                    {/* The requests sit in the same columns as the list above: Qty under Qty, dates under In FG Store and Request */}
                    <tr className="bg-slate-50/60">
                      <td className="border-l-2 border-brand-200 px-3 pb-1 pt-3 text-micro font-bold uppercase tracking-wide text-slate-400">Dispatch request</td>
                      <td colSpan={3} className="px-3 pb-1 pt-3 text-micro font-bold uppercase tracking-wide text-slate-400">
                        Note
                      </td>
                      <td className="px-3 pb-1 pt-3 text-right text-micro font-bold uppercase tracking-wide text-slate-400">Qty</td>
                      <td />
                      <td className="px-3 pb-1 pt-3 text-micro font-bold uppercase tracking-wide text-slate-400">Requested</td>
                      <td />
                      <td className="px-3 pb-1 pt-3 text-micro font-bold uppercase tracking-wide text-slate-400">Sent</td>
                      <td />
                    </tr>
                    {(openByBatch.get(r.id) ?? []).map((q, i, all) => (
                      <tr key={`req-${q.id}`} className={`bg-slate-50/60 ${i === all.length - 1 ? "" : ""}`}>
                        <td className="border-l-2 border-brand-200 px-3 py-2">
                          <span className={`pill ${REQUEST_LABEL[q.status]?.pill ?? "border-slate-200 bg-slate-50 text-slate-600"}`}>{REQUEST_LABEL[q.status]?.text ?? q.status}</span>
                        </td>
                        <td colSpan={3} className="px-3 py-2 text-slate-500">
                          {q.note ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-mono font-bold text-slate-800">
                          {fmtQty(q.quantity)} {q.unit}
                        </td>
                        <td />
                        <td className="whitespace-nowrap px-3 py-2 text-slate-600">{dayOf(q.requestedAt)}</td>
                        <td />
                        <td className="whitespace-nowrap px-3 py-2 text-slate-600">{dayOf(q.sentAt)}</td>
                        <td />
                      </tr>
                    ))}
                    <tr className="bg-slate-50/60">
                      <td colSpan={10} className="border-l-2 border-brand-200 pb-1" />
                    </tr>
                  </>
                )}
                {(openByBatch.get(r.id) ?? []).filter((q) => refuseFor === q.id).map((q) => (
                  <tr key={`refuse-${q.id}`} className="bg-slate-50/70">
                    <td colSpan={10} className="px-4 py-3">
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="min-w-[16rem] flex-1">
                          <label className="mb-0.5 block text-micro text-slate-400">Why can you not send it?</label>
                          <input className="field !py-1.5 text-xs" value={refuseReason} onChange={(e) => setRefuseReason(e.target.value)} />
                        </div>
                        <button
                          type="button"
                          className="btn-danger btn-sm"
                          disabled={!refuseReason.trim() || refuseRequest.isPending}
                          onClick={() =>
                            refuseRequest.mutate(
                              { id: q.id, reason: refuseReason.trim() },
                              {
                                onSuccess: () => {
                                  toast.success("Refused. Dispatch has been told.");
                                  setRefuseFor(null);
                                },
                                onError: fail,
                              },
                            )
                          }
                        >
                          Refuse request
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {canAsk && askFor === r.id && (
                  <tr className="bg-slate-50/70">
                    <td colSpan={10} className="px-4 py-3">
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="w-36">
                          <label className="mb-0.5 block text-micro text-slate-400">Quantity (max {fmtQty(r.onHandQty)} {r.unit})</label>
                          <input className="field !py-1.5 text-xs" type="number" min="0" step="any" value={askQty} onChange={(e) => setAskQty(e.target.value)} />
                        </div>
                        <div className="min-w-[16rem] flex-1">
                          <label className="mb-0.5 block text-micro text-slate-400">Note (optional)</label>
                          <input className="field !py-1.5 text-xs" value={askNote} onChange={(e) => setAskNote(e.target.value)} placeholder="e.g. for the customer order due Friday" />
                        </div>
                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          disabled={!(Number(askQty) > 0) || Number(askQty) > r.onHandQty + 1e-6 || requestStock.isPending}
                          onClick={() =>
                            requestStock.mutate(
                              { batchId: r.id, quantity: Number(askQty), note: askNote.trim() || undefined },
                              {
                                onSuccess: () => {
                                  toast.success("Asked the Warehouse. It will send the goods to Dispatch.");
                                  setAskFor(null);
                                },
                                onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not send the request"),
                              },
                            )
                          }
                        >
                          {requestStock.isPending ? "Sending…" : "Send request"}
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
          <Pagination page={paged.page} pageSize={paged.pageSize} total={paged.total} onPage={paged.setPage} onPageSize={paged.setPageSize} isFetching={paged.isFetching} />
        </div>
      )}
    </div>
  );
}
