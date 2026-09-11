import { useRef, useState, type ChangeEvent } from "react";
import { ArrowLeftRight, Beaker, CheckCircle2, Clock, FileSpreadsheet, FlaskConical, Inbox, Lock, PackageCheck, PackageMinus, Plus, Send, Trash2, Truck, Upload, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import { EmptyState } from "../components/EmptyState";
import { ItemPicker } from "../components/ItemPicker";
import { StatTile } from "../components/StatTile";
import { useToast } from "../components/Toast";
import {
  useCancelRndSampleRequest,
  useConfirmRndTransfer,
  useConsumeAtRnd,
  useCreateRndSampleRequest,
  useCreateRndTransfer,
  useCustomers,
  useDispatchRndToCustomer,
  useFulfillRndSampleRequest,
  useImportRndSampleRequests,
  useInventoryItems,
  useRejectRndSampleRequest,
  useRndSampleRequests,
  useRndStoreReport,
  useRndStoreStock,
  useRndStoreTransactions,
  useRndTransfers,
} from "../lib/hooks";
import { parseRndSampleRequestWorkbook } from "../lib/inventoryImport";
import { downloadRndSampleRequestImportTemplate } from "../lib/inventoryExport";
import type { InventoryCategory, RndConsumeReason, RndSampleRequest, RndTransfer } from "../lib/types";

const REASON_LABEL: Record<RndConsumeReason, string> = { TESTING: "Testing", FORMULATION_TRIAL: "Formulation Trial", WASTAGE: "Wastage", REJECTED: "Rejected" };
const REASON_STYLE: Record<RndConsumeReason, string> = {
  TESTING: "border-emerald-200 bg-emerald-50 text-emerald-700",
  FORMULATION_TRIAL: "border-emerald-200 bg-emerald-50 text-emerald-700",
  WASTAGE: "border-amber-200 bg-amber-50 text-amber-700",
  REJECTED: "border-rose-200 bg-rose-50 text-rose-700",
};

// Items here can be in Kg, Ltr, Count, Inch, Ft — summing raw quantities
// across units would produce a meaningless number, so every quantity
// stays grouped by its own unit: "20 Kg · 5 Ltr" instead of a blended
// "25". Largest unit group first.
function sumByUnit(entries: { quantity: number; unit: string }[]): string {
  const totals = new Map<string, number>();
  for (const e of entries) {
    if (!e.quantity) continue;
    const unit = e.unit || "—";
    totals.set(unit, (totals.get(unit) ?? 0) + e.quantity);
  }
  if (totals.size === 0) return "0";
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([unit, qty]) => `${qty} ${unit}`)
    .join(" · ");
}

// R&D Store — a second, independent stock ledger for R&D's own sample
// lifecycle: Warehouse sends a sample -> R&D confirms receipt -> research
// uses/wastes/rejects some, sends some to a customer, sends the leftover
// back -> Warehouse confirms. See rnd-store.routes.ts for the full
// 6-step mapping. STORE and RND each own their own half of the two
// two-sided transfers; the purely-R&D-side events (consume, dispatch)
// are RND's alone.
export function RndStorePage() {
  const { hasRole } = useAuth();
  const isStore = hasRole("STORE");
  const isRnd = hasRole("RND");
  const canAccess = isStore || isRnd;
  const toast = useToast();

  const { data: pendingTransfers, isLoading: loadingTransfers } = useRndTransfers("PENDING");
  const { data: allRequests } = useRndSampleRequests();
  const { data: stock } = useRndStoreStock();
  const { data: transactions } = useRndStoreTransactions();
  const { data: report } = useRndStoreReport();
  const confirmTransfer = useConfirmRndTransfer();
  const fulfillRequest = useFulfillRndSampleRequest();
  const rejectRequest = useRejectRndSampleRequest();
  const cancelRequest = useCancelRndSampleRequest();

  if (!canAccess) {
    return <EmptyState icon={Lock} title="Restricted to Store / R&D" hint="This page belongs to Store and R&D — ask a team member from either department if you need something here." accent="slate" />;
  }

  const myPending = (pendingTransfers ?? []).filter((t) => (isStore && t.direction === "TO_WAREHOUSE") || (isRnd && t.direction === "TO_RND"));
  const pendingRequests = (allRequests ?? []).filter((r) => r.status === "PENDING");
  const myRequestHistory = (allRequests ?? []).filter((r) => r.status !== "PENDING").slice(0, 10);

  async function handleConfirm(t: RndTransfer) {
    try {
      await confirmTransfer.mutateAsync(t.id);
      toast.success(`Confirmed — ${t.quantity} ${t.unit} ${t.itemName}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not confirm");
    }
  }

  async function handleFulfill(r: RndSampleRequest) {
    try {
      await fulfillRequest.mutateAsync(r.id);
      toast.success(`Sent ${r.quantity} ${r.unit} ${r.itemName} to R&D Store.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not fulfill");
    }
  }

  async function handleReject(r: RndSampleRequest) {
    const reason = window.prompt(`Why is ${r.itemName} being rejected?`);
    if (!reason) return;
    try {
      await rejectRequest.mutateAsync({ id: r.id, reason });
      toast.success("Request rejected.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not reject");
    }
  }

  async function handleCancel(r: RndSampleRequest) {
    try {
      await cancelRequest.mutateAsync(r.id);
      toast.success("Request withdrawn.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not cancel");
    }
  }

  const onHandByUnit = sumByUnit((stock ?? []).map((r) => ({ quantity: r.onHand, unit: r.item.unit ?? "" })));
  const testingByUnit = sumByUnit((report ?? []).map((r) => ({ quantity: r.testingQty, unit: r.unit })));
  const formulationTrialByUnit = sumByUnit((report ?? []).map((r) => ({ quantity: r.formulationTrialQty, unit: r.unit })));
  const wastageByUnit = sumByUnit((report ?? []).map((r) => ({ quantity: r.wastageQty, unit: r.unit })));
  const rejectedByUnit = sumByUnit((report ?? []).map((r) => ({ quantity: r.rejectedQty, unit: r.unit })));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-violet-50 text-violet-600">
          <FlaskConical className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">R&D Store</h1>
          <p className="text-sm text-slate-500">Samples out of the Warehouse, through research, to a customer or back — a second ledger, tracked end to end.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile icon={PackageCheck} label="On Hand at R&D" value={onHandByUnit} accent="violet" />
        <StatTile icon={CheckCircle2} label="Testing" value={testingByUnit} accent="emerald" />
        <StatTile icon={CheckCircle2} label="Formulation Trial" value={formulationTrialByUnit} accent="emerald" />
        <StatTile icon={PackageMinus} label="Wastage" value={wastageByUnit} accent="amber" />
        <StatTile icon={PackageMinus} label="Rejected" value={rejectedByUnit} accent="rose" />
      </div>

      {myPending.length > 0 && (
        <div>
          <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
            <Clock className="h-3.5 w-3.5" /> Awaiting Your Confirmation ({myPending.length})
          </h2>
          <div className="space-y-2">
            {myPending.map((t) => (
              <div key={t.id} className="card flex flex-wrap items-center justify-between gap-3 p-3.5">
                <div>
                  <p className="text-xs font-bold text-slate-700">
                    {t.itemName} <span className="font-mono text-slate-500">— {t.quantity} {t.unit}</span>
                  </p>
                  <p className="text-[10px] text-slate-400">
                    {t.direction === "TO_RND" ? "From Warehouse" : "Returned from R&D Store"} · sent by {t.sentByName}
                    {t.note && <> · {t.note}</>}
                  </p>
                </div>
                <button type="button" className="btn-primary btn-sm" disabled={confirmTransfer.isPending} onClick={() => handleConfirm(t)}>
                  {confirmTransfer.isPending ? "Confirming…" : "Confirm Receipt"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {isStore && pendingRequests.length > 0 && (
        <div>
          <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
            <Inbox className="h-3.5 w-3.5" /> R&D Requests Awaiting Fulfillment ({pendingRequests.length})
          </h2>
          <div className="space-y-2">
            {pendingRequests.map((r) => (
              <div key={r.id} className="card flex flex-wrap items-center justify-between gap-3 p-3.5">
                <div>
                  <p className="text-xs font-bold text-slate-700">
                    {r.itemName} <span className="font-mono text-slate-500">— {r.quantity} {r.unit}</span>
                  </p>
                  <p className="text-[10px] text-slate-400">
                    Requested by {r.requestedByName}
                    {r.note && <> · {r.note}</>}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn-ghost btn-sm" disabled={rejectRequest.isPending} onClick={() => handleReject(r)}>
                    Reject
                  </button>
                  <button type="button" className="btn-primary btn-sm" disabled={fulfillRequest.isPending} onClick={() => handleFulfill(r)}>
                    {fulfillRequest.isPending ? "Sending…" : "Fulfill — Send to R&D"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {isRnd && pendingRequests.length > 0 && (
        <div>
          <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
            <Clock className="h-3.5 w-3.5" /> Your Requests — Awaiting Store ({pendingRequests.length})
          </h2>
          <div className="space-y-2">
            {pendingRequests.map((r) => (
              <div key={r.id} className="card flex flex-wrap items-center justify-between gap-3 p-3.5">
                <div>
                  <p className="text-xs font-bold text-slate-700">
                    {r.itemName} <span className="font-mono text-slate-500">— {r.quantity} {r.unit}</span>
                  </p>
                  <p className="text-[10px] text-slate-400">
                    Requested by {r.requestedByName}
                    {r.note && <> · {r.note}</>}
                  </p>
                </div>
                <button type="button" className="btn-ghost btn-sm" disabled={cancelRequest.isPending} onClick={() => handleCancel(r)}>
                  <X className="h-3.5 w-3.5" /> Withdraw
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {isRnd && <RequestSampleForm />}
        {isRnd && <ReturnToWarehouseForm />}
        {isRnd && <ConsumeForm />}
        {isRnd && <DispatchToCustomerForm />}
      </div>

      {isRnd && myRequestHistory.length > 0 && (
        <div>
          <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
            <Inbox className="h-3.5 w-3.5" /> Recent Requests
          </h2>
          <div className="space-y-1.5">
            {myRequestHistory.map((r) => (
              <div key={r.id} className="card flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-xs font-bold text-slate-700">
                    {r.itemName} <span className="font-mono text-slate-500">{r.quantity} {r.unit}</span>
                  </p>
                  <p className="text-[10px] text-slate-400">
                    {r.status === "REJECTED" && r.rejectionReason ? r.rejectionReason : r.note}
                  </p>
                </div>
                <span
                  className={`pill shrink-0 ${
                    r.status === "FULFILLED" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : r.status === "REJECTED" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-slate-200 bg-slate-100 text-slate-600"
                  }`}
                >
                  {r.status === "FULFILLED" ? "Sent" : r.status === "REJECTED" ? "Rejected" : "Withdrawn"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
          <Beaker className="h-3.5 w-3.5" /> R&D Store — Current Stock
        </h2>
        {!stock || stock.length === 0 ? (
          <EmptyState icon={Beaker} title="Nothing on hand" hint="Once Store sends a sample and R&D confirms it, it'll show here." accent="violet" />
        ) : (
          <div className="card overflow-x-auto">
            <table className="table-modern w-full">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th>Unit</th>
                  <th className="text-center">On Hand</th>
                </tr>
              </thead>
              <tbody>
                {stock.map((r) => (
                  <tr key={r.item.id}>
                    <td className="font-semibold text-slate-700">{r.item.name}</td>
                    <td className="text-slate-500">{r.item.category}</td>
                    <td className="text-slate-500">{r.item.unit ?? "—"}</td>
                    <td className="text-center font-mono font-bold text-violet-700">{r.onHand}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
          <ArrowLeftRight className="h-3.5 w-3.5" /> Where the Raw Material Went — Per Item
        </h2>
        {!report || report.length === 0 ? (
          <EmptyState icon={ArrowLeftRight} title="No activity yet" accent="slate" />
        ) : (
          <div className="card overflow-x-auto">
            <table className="table-modern w-full">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Unit</th>
                  <th className="text-center">Received from Warehouse</th>
                  <th className="text-center">Testing</th>
                  <th className="text-center">Formulation Trial</th>
                  <th className="text-center">Wastage</th>
                  <th className="text-center">Rejected</th>
                  <th className="text-center">Sent to Customer</th>
                  <th className="text-center">Returned to Warehouse</th>
                  <th className="text-center">On Hand</th>
                </tr>
              </thead>
              <tbody>
                {report.map((r) => (
                  <tr key={r.itemId}>
                    <td className="font-semibold text-slate-700">{r.itemName}</td>
                    <td className="text-slate-500">{r.unit || "—"}</td>
                    <td className="text-center font-mono text-slate-600">{r.inboundQty}</td>
                    <td className="text-center font-mono text-emerald-700">{r.testingQty}</td>
                    <td className="text-center font-mono text-emerald-700">{r.formulationTrialQty}</td>
                    <td className="text-center font-mono text-amber-700">{r.wastageQty}</td>
                    <td className="text-center font-mono text-rose-700">{r.rejectedQty}</td>
                    <td className="text-center font-mono text-slate-600">{r.dispatchedQty}</td>
                    <td className="text-center font-mono text-slate-600">{r.returnedQty}</td>
                    <td className="text-center font-mono font-bold text-violet-700">{r.onHand}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
          <Clock className="h-3.5 w-3.5" /> Recent Activity
        </h2>
        {!transactions || transactions.length === 0 ? (
          <EmptyState icon={Clock} title="Nothing logged yet" accent="slate" />
        ) : (
          <div className="space-y-1.5">
            {transactions.slice(0, 30).map((t) => (
              <div key={t.id} className="card flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-xs font-bold text-slate-700">
                    {t.itemName} <span className="font-mono text-slate-500">{t.quantity} {t.unit}</span>
                  </p>
                  <p className="text-[10px] text-slate-400">
                    {t.customerName && <>to {t.customerName}{t.brandName && <> ({t.brandName})</>} · </>}
                    {t.courierDetails && <>via {t.courierDetails} · </>}
                    {t.projectName && <>{t.projectName} · </>}
                    {t.formulationRef && <>Ref {t.formulationRef} · </>}
                    {t.batchNo && <>Batch {t.batchNo} · </>}
                    {t.note && <>{t.note} · </>}
                    {t.createdByName} · {new Date(t.date ?? t.createdAt).toLocaleString()}
                  </p>
                </div>
                <span
                  className={`pill shrink-0 ${
                    t.type === "INBOUND"
                      ? "border-brand-200 bg-brand-50 text-brand-700"
                      : t.type === "DISPATCHED"
                        ? "border-violet-200 bg-violet-50 text-violet-700"
                        : t.type === "RETURNED"
                          ? "border-slate-200 bg-slate-100 text-slate-600"
                          : t.consumeReason
                            ? REASON_STYLE[t.consumeReason]
                            : "border-slate-200 bg-slate-100 text-slate-600"
                  }`}
                >
                  {t.type === "INBOUND" ? "Received" : t.type === "DISPATCHED" ? "To Customer" : t.type === "RETURNED" ? "Returned" : t.consumeReason ? REASON_LABEL[t.consumeReason] : "Consumed"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {loadingTransfers && null}
    </div>
  );
}

interface RequestDraftRow {
  key: string;
  category: InventoryCategory;
  itemId: string;
  quantity: string;
  unit: string;
}

function blankDraftRow(): RequestDraftRow {
  return { key: Math.random().toString(36).slice(2), category: "RM", itemId: "", quantity: "", unit: "Kg" };
}

// Step 1's real trigger: R&D is mid-research on a product PPIC asked for
// (see the RecipeRequest / R&D Department flow) and knows exactly what
// raw material it needs — so R&D asks Store, Store fulfills or rejects
// (see the "R&D Requests Awaiting Fulfillment" section above). Multiple
// rows in one submission covers the everyday "need a handful of
// materials for this trial" case; the Excel import next to it covers a
// genuinely long list someone already has in a spreadsheet.
function RequestSampleForm() {
  const toast = useToast();
  const { data: allItems } = useInventoryItems();
  const [rows, setRows] = useState<RequestDraftRow[]>([blankDraftRow()]);
  const [note, setNote] = useState("");
  const createRequest = useCreateRndSampleRequest();
  const importRequests = useImportRndSampleRequests();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  function updateRow(key: string, patch: Partial<RequestDraftRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeRow(key: string) {
    setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : rs));
  }

  async function handleSubmit() {
    setError(null);
    const valid = rows.filter((r) => r.itemId && Number(r.quantity) > 0);
    if (!valid.length) return setError("Add at least one item with a quantity greater than zero.");

    const results = await Promise.allSettled(
      valid.map((r) => createRequest.mutateAsync({ itemId: r.itemId, quantity: Number(r.quantity), unit: r.unit, note: note.trim() || undefined })),
    );
    const succeededKeys = new Set(valid.filter((_, i) => results[i]?.status === "fulfilled").map((r) => r.key));
    const failedCount = valid.length - succeededKeys.size;

    if (succeededKeys.size) {
      toast.success(`Sent ${succeededKeys.size} request${succeededKeys.size === 1 ? "" : "s"} to Store${failedCount ? ` (${failedCount} failed — still in the form below)` : ""}.`);
    }
    if (!succeededKeys.size) return setError("Could not send any of the requests.");

    // Drop the rows that made it through; keep failed ones so nothing typed gets lost.
    setRows((rs) => {
      const remaining = rs.filter((r) => !succeededKeys.has(r.key));
      return remaining.length ? remaining : [blankDraftRow()];
    });
    if (!failedCount) setNote("");
  }

  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const { rows: parsedRows, skipped, sheetNames, detectedHeaders } = parseRndSampleRequestWorkbook(buffer, "RM");
      if (!parsedRows.length) {
        return toast.error(
          detectedHeaders.length
            ? `No usable rows in "${file.name}" — found columns [${detectedHeaders.join(", ")}], but none had a valid Item + Quantity + Unit together.`
            : `"${file.name}" has no data rows on any sheet (${sheetNames.join(", ") || "no sheets"}) — is this the right file?`,
        );
      }
      const result = await importRequests.mutateAsync({ rows: parsedRows });
      const skippedNote = skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped — missing a required field)` : "";
      toast.success(`Sent ${result.requestsCreated} request${result.requestsCreated === 1 ? "" : "s"} to Store${result.itemsCreated ? `, ${result.itemsCreated} new item(s)` : ""}${skippedNote}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not import spreadsheet");
    }
  }

  const busy = createRequest.isPending || importRequests.isPending;

  return (
    <div className="card space-y-3 p-4 lg:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="label flex items-center gap-1.5">
          <Send className="h-3.5 w-3.5" /> Request Samples from Store
        </p>
        <div className="flex gap-2">
          <button type="button" className="btn-ghost btn-sm" onClick={downloadRndSampleRequestImportTemplate} title="Download a blank template with the correct columns">
            <FileSpreadsheet className="h-3.5 w-3.5" /> Sample Sheet
          </button>
          <button type="button" className="btn-ghost btn-sm" disabled={importRequests.isPending} onClick={() => fileRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" /> Import Excel
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
        </div>
      </div>

      <div className="space-y-2">
        {rows.map((row) => {
          const rowItems = (allItems ?? []).filter((i) => i.category === row.category);
          return (
            <div key={row.key} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-100 p-2 sm:flex-nowrap">
              <select
                className="field w-28 shrink-0"
                value={row.category}
                onChange={(e) => updateRow(row.key, { category: e.target.value as InventoryCategory, itemId: "" })}
              >
                <option value="RM">RM</option>
                <option value="PM">PM</option>
              </select>
              <div className="min-w-[12rem] flex-1">
                <ItemPicker items={rowItems} value={row.itemId} onChange={(id) => updateRow(row.key, { itemId: id })} />
              </div>
              <input
                className="field w-24 shrink-0 font-mono"
                type="number"
                min="0"
                step="any"
                placeholder="Qty"
                value={row.quantity}
                onChange={(e) => updateRow(row.key, { quantity: e.target.value })}
              />
              <select className="field w-24 shrink-0" value={row.unit} onChange={(e) => updateRow(row.key, { unit: e.target.value })}>
                {["Kg", "Ltr", "Count", "Inch", "Ft"].map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
              <button type="button" className="btn-ghost btn-sm shrink-0" disabled={rows.length === 1} onClick={() => removeRow(row.key)} title="Remove row">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      <button type="button" className="btn-ghost btn-sm" onClick={() => setRows((rs) => [...rs, blankDraftRow()])}>
        <Plus className="h-3.5 w-3.5" /> Add Item
      </button>

      <input className="field" placeholder="Note (optional) — e.g. which product this is for, applies to every row" value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      <button type="button" className="btn-primary w-full" disabled={busy} onClick={handleSubmit}>
        {createRequest.isPending ? "Sending…" : `Send ${rows.filter((r) => r.itemId && Number(r.quantity) > 0).length || ""} Request${rows.filter((r) => r.itemId && Number(r.quantity) > 0).length === 1 ? "" : "s"} to Store`}
      </button>
    </div>
  );
}

function ReturnToWarehouseForm() {
  const toast = useToast();
  const { data: stock } = useRndStoreStock();
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const createTransfer = useCreateRndTransfer();
  const [error, setError] = useState<string | null>(null);

  const items = (stock ?? []).map((r) => ({ id: r.item.id, name: `${r.item.name} (${r.onHand} on hand)` }));
  const selected = stock?.find((r) => r.item.id === itemId);

  async function handleSubmit() {
    setError(null);
    if (!itemId) return setError("Select an item.");
    if (!quantity || Number(quantity) <= 0) return setError("Enter a quantity greater than zero.");
    try {
      await createTransfer.mutateAsync({ direction: "TO_WAREHOUSE", itemId, quantity: Number(quantity), unit: selected?.item.unit ?? "Kg" });
      toast.success("Sent back to Warehouse — awaiting their confirmation.");
      setItemId("");
      setQuantity("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send");
    }
  }

  return (
    <div className="card space-y-3 p-4">
      <p className="label flex items-center gap-1.5">
        <ArrowLeftRight className="h-3.5 w-3.5" /> Return Leftover to Warehouse
      </p>
      <ItemPicker items={items} value={itemId} onChange={setItemId} placeholder="— Select an item on hand —" />
      <input className="field font-mono" type="number" min="0" step="any" placeholder="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      <button type="button" className="btn-primary w-full" disabled={createTransfer.isPending} onClick={handleSubmit}>
        {createTransfer.isPending ? "Sending…" : "Send Back to Warehouse"}
      </button>
    </div>
  );
}

function ConsumeForm() {
  const toast = useToast();
  const { data: stock } = useRndStoreStock();
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState<RndConsumeReason>("TESTING");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [projectName, setProjectName] = useState("");
  const [formulationRef, setFormulationRef] = useState("");
  const [batchNo, setBatchNo] = useState("");
  const [note, setNote] = useState("");
  const consume = useConsumeAtRnd();
  const [error, setError] = useState<string | null>(null);

  const items = (stock ?? []).map((r) => ({ id: r.item.id, name: `${r.item.name} (${r.onHand} on hand)` }));
  const selected = stock?.find((r) => r.item.id === itemId);

  async function handleSubmit() {
    setError(null);
    if (!itemId) return setError("Select an item.");
    if (!quantity || Number(quantity) <= 0) return setError("Enter a quantity greater than zero.");
    try {
      await consume.mutateAsync({
        itemId,
        quantity: Number(quantity),
        unit: selected?.item.unit ?? "Kg",
        reason,
        date: date || undefined,
        projectName: projectName.trim() || undefined,
        formulationRef: formulationRef.trim() || undefined,
        batchNo: batchNo.trim() || undefined,
        note: note.trim() || undefined,
      });
      toast.success(`Logged as ${REASON_LABEL[reason]}.`);
      setItemId("");
      setQuantity("");
      setProjectName("");
      setFormulationRef("");
      setBatchNo("");
      setNote("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not log");
    }
  }

  return (
    <div className="card space-y-3 p-4">
      <p className="label flex items-center gap-1.5">
        <FlaskConical className="h-3.5 w-3.5" /> Log Research Consumption
      </p>
      <ItemPicker items={items} value={itemId} onChange={setItemId} placeholder="— Select an item on hand —" />
      <div className="grid grid-cols-2 gap-2">
        <input className="field font-mono" type="number" min="0" step="any" placeholder="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <select className="field" value={reason} onChange={(e) => setReason(e.target.value as RndConsumeReason)}>
          <option value="TESTING">Testing</option>
          <option value="FORMULATION_TRIAL">Formulation Trial</option>
          <option value="WASTAGE">Wastage</option>
          <option value="REJECTED">Rejected</option>
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
        <input className="field" placeholder="Project / Product Name (optional)" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input className="field" placeholder="Formulation Ref No. (optional)" value={formulationRef} onChange={(e) => setFormulationRef(e.target.value)} />
        <input className="field" placeholder="Batch / Lot No. (optional)" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />
      </div>
      <input className="field" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      <button type="button" className="btn-primary w-full" disabled={consume.isPending} onClick={handleSubmit}>
        {consume.isPending ? "Logging…" : "Log Consumption"}
      </button>
    </div>
  );
}

function DispatchToCustomerForm() {
  const toast = useToast();
  const { data: stock } = useRndStoreStock();
  const { data: customers } = useCustomers();
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [brandName, setBrandName] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [courierDetails, setCourierDetails] = useState("");
  const [note, setNote] = useState("");
  const dispatch = useDispatchRndToCustomer();
  const [error, setError] = useState<string | null>(null);

  const items = (stock ?? []).map((r) => ({ id: r.item.id, name: `${r.item.name} (${r.onHand} on hand)` }));
  const selected = stock?.find((r) => r.item.id === itemId);

  async function handleSubmit() {
    setError(null);
    if (!itemId) return setError("Select an item.");
    if (!customerId) return setError("Select a customer.");
    if (!quantity || Number(quantity) <= 0) return setError("Enter a quantity greater than zero.");
    try {
      await dispatch.mutateAsync({
        itemId,
        quantity: Number(quantity),
        unit: selected?.item.unit ?? "Kg",
        customerId,
        brandName: brandName.trim() || undefined,
        date: date || undefined,
        courierDetails: courierDetails.trim() || undefined,
        note: note.trim() || undefined,
      });
      toast.success("Sent to customer.");
      setItemId("");
      setQuantity("");
      setCustomerId("");
      setBrandName("");
      setCourierDetails("");
      setNote("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send");
    }
  }

  return (
    <div className="card space-y-3 p-4">
      <p className="label flex items-center gap-1.5">
        <Truck className="h-3.5 w-3.5" /> Send Sample to Customer
      </p>
      <ItemPicker items={items} value={itemId} onChange={setItemId} placeholder="— Select an item on hand —" />
      <div className="grid grid-cols-2 gap-2">
        <ItemPicker items={(customers ?? []).map((c) => ({ id: c.id, name: c.companyName }))} value={customerId} onChange={setCustomerId} placeholder="— Select a customer —" />
        <input className="field" placeholder="Brand Name (optional)" value={brandName} onChange={(e) => setBrandName(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input className="field font-mono" type="number" min="0" step="any" placeholder="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <input className="field" placeholder="Courier / Dispatch Details (optional)" value={courierDetails} onChange={(e) => setCourierDetails(e.target.value)} />
      <input className="field" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      <button type="button" className="btn-primary w-full" disabled={dispatch.isPending} onClick={handleSubmit}>
        {dispatch.isPending ? "Sending…" : "Send to Customer"}
      </button>
    </div>
  );
}
