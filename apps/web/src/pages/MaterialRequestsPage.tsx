import { fmtQty } from "../lib/format";
import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Download, HandHelping, PackageOpen, Send, X } from "lucide-react";
import { ApiError, api, apiAll } from "../lib/api";
import { usePagedList } from "../lib/usePagedList";
import { appendParams, useTileFilters } from "../lib/tileFilters";
import { exportMaterialRequestsReport, type MaterialRequestRow } from "../lib/inventoryExport";
import { useEscalateMaterialRequest, useFulfillRndSampleRequest, useIssueInventoryRequest, useRejectRndSampleRequest, useReviewInventoryRequest } from "../lib/hooks";
import { Pagination } from "../components/Pagination";
import { AgingCell } from "../components/AgingCell";
import { TileFilterBar, AGING_FIELD, type FilterField } from "../components/TileFilterBar";
import type { OptionPage } from "../components/MultiSelectDropdown";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { ActionMenu } from "../components/ActionMenu";

const BASE = "/api/inventory/material-requests";
const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };
const round2 = (n: number) => Math.round(n * 100) / 100;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");

const serverList = (key: string, label: string, plan: boolean): FilterField => ({
  key,
  label,
  load: (q) => api<OptionPage>(`${BASE}/options?field=${key}${plan ? "&kind=plan" : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
});
const fieldsFor = (plan: boolean): FilterField[] => [
  serverList("requester", "Requested By", plan),
  ...(plan ? [serverList("product", "Product", plan), serverList("po", "PO Number", plan)] : []),
  { key: "category", label: "Category", options: ["RM", "PM"] },
  serverList("item", "Item", plan),
  { key: "status", label: "Status", options: ["Pending", "Approved", "Partly issued", "Issued", "Rejected", "Cancelled"] },
  { key: "short", label: "Short at Warehouse", options: ["Yes", "No"] },
  { key: "supply", label: "Purchase Trail", options: ["With PPIC", "With Purchase", "On order", "Received"] },
  AGING_FIELD,
];

export const STATUS_STYLE: Record<string, string> = {
  Pending: "border-amber-200 bg-amber-50 text-amber-700",
  Approved: "border-sky-200 bg-sky-50 text-sky-700",
  "Partly issued": "border-orange-200 bg-orange-50 text-orange-700",
  Issued: "border-emerald-200 bg-emerald-50 text-emerald-700",
  Rejected: "border-rose-200 bg-rose-50 text-rose-700",
  Cancelled: "border-slate-200 bg-slate-50 text-slate-500",
};
export const SUPPLY_STYLE: Record<string, string> = {
  "With PPIC": "border-violet-200 bg-violet-50 text-violet-700",
  "With Purchase": "border-blue-200 bg-blue-50 text-blue-700",
  "On order": "border-emerald-200 bg-emerald-50 text-emerald-700",
  Received: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

// What Day Stores and the R&D Store have asked the Warehouse for. The Warehouse approves and issues from the
// Inventory screen; when it is short, "Send to PPIC" raises the need so PPIC can take it on to Purchase, and the
// Purchase Trail column follows it: With PPIC -> With Purchase -> On order -> Received.
export function MaterialRequestsPage({ plan = false }: { plan?: boolean }) {
  const toast = useToast();
  const tileFilters = useTileFilters();
  const escalate = useEscalateMaterialRequest();
  const review = useReviewInventoryRequest();
  const issue = useIssueInventoryRequest();
  const fulfillRnd = useFulfillRndSampleRequest();
  const rejectRnd = useRejectRndSampleRequest();
  const qc = useQueryClient();
  const [exporting, setExporting] = useState(false);
  // The one row whose Issue / Reject form is open, and its inputs.
  const [panel, setPanel] = useState<{ key: string; mode: "issue" | "reject" } | null>(null);
  const [issueQty, setIssueQty] = useState("");
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [transit, setTransit] = useState(false);
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const paged = usePagedList<MaterialRequestRow>({ key: ["inventory", "material-requests", plan ? "plan" : "list"], path: BASE, params: { ...tileFilters.params, kind: plan ? "plan" : undefined }, noSearch: true });
  const isFiltered = tileFilters.activeCount > 0;

  async function exportAll() {
    setExporting(true);
    try {
      const qs = appendParams(new URLSearchParams(), tileFilters.params);
      exportMaterialRequestsReport(await apiAll<MaterialRequestRow>(`${BASE}${qs.toString() ? `?${qs}` : ""}`));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not build the report");
    } finally {
      setExporting(false);
    }
  }

  const refresh = () => qc.invalidateQueries({ queryKey: ["inventory", "material-requests"] });
  const closePanel = () => {
    setPanel(null);
    setFormError(null);
    setReason("");
    setTransit(false);
  };
  const openPanel = (row: MaterialRequestRow, mode: "issue" | "reject") => {
    setFormError(null);
    setReason("");
    setTransit(false);
    // Issue what the Warehouse has now, up to what is still owed - the rest stays open.
    setIssueQty(String(Math.max(0, Math.min(row.remainingQty, row.warehouseOnHand))));
    setPanel({ key: row.key, mode });
  };
  const fail = (err: unknown, fallback: string) => toast.error(err instanceof ApiError ? err.message : fallback);

  async function approve(row: MaterialRequestRow) {
    try {
      await review.mutateAsync({ id: row.id, action: "APPROVE" });
      await refresh();
      toast.success(`Approved - issue it to ${row.requesterName} when ready.`);
    } catch (err) {
      fail(err, "Could not approve this request");
    }
  }

  async function sendToRnd(row: MaterialRequestRow) {
    try {
      await fulfillRnd.mutateAsync(row.id);
      await refresh();
      toast.success(`${row.requestedQty} ${row.unit} of ${row.itemName} sent to the R&D Store.`);
    } catch (err) {
      fail(err, "Could not send this to the R&D Store");
    }
  }

  async function submitReject(row: MaterialRequestRow) {
    if (!reason.trim()) return setFormError("A reason is required to reject a request.");
    try {
      if (row.source === "rnd") await rejectRnd.mutateAsync({ id: row.id, reason: reason.trim() });
      else await review.mutateAsync({ id: row.id, action: "REJECT", rejectionReason: reason.trim() });
      await refresh();
      toast.success("Request rejected.");
      closePanel();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not reject this request");
    }
  }

  async function submitIssue(row: MaterialRequestRow) {
    const qty = Number(issueQty);
    if (!qty || qty <= 0) return setFormError("Enter a quantity greater than zero.");
    if (qty > row.remainingQty + 1e-9) return setFormError(`Only ${row.remainingQty} ${row.unit} is still owed on this request.`);
    if (qty > row.warehouseOnHand + 1e-9) return setFormError(`The Warehouse has only ${row.warehouseOnHand} ${row.unit}.`);
    try {
      await issue.mutateAsync({ id: row.id, date: issueDate, unit: row.unit, quantity: qty, dayStoreId: null, isTransitTracked: transit || undefined });
      await refresh();
      toast.success(qty >= row.remainingQty ? `Issued - ${row.requesterName}'s request is complete.` : `${qty} ${row.unit} issued - ${round2(row.remainingQty - qty)} still owed.`);
      closePanel();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not issue this request");
    }
  }

  async function sendToPpic(row: MaterialRequestRow) {
    try {
      await escalate.mutateAsync({ source: row.source, id: row.id });
      toast.success(`Sent to PPIC — ${row.shortBy} ${row.unit} of ${row.itemName} is short.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not send this to PPIC");
    }
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-brand-500/10 text-brand-600">
            <HandHelping className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{plan ? "Material Request (Plan)" : "Material Requests"}</h1>
            <p className="text-sm text-slate-500">
              {paged.total.toLocaleString()} request{paged.total === 1 ? "" : "s"}
              {isFiltered ? " match" : ""}{" "}
              {plan ? "— urgent: Stores asking for material a production plan needs. Late ones come first." : "from Stores and the R&D Store."}
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm shrink-0" disabled={paged.total === 0 || exporting} onClick={exportAll}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> {exporting ? "Preparing…" : `Download Report${isFiltered ? " (Filtered)" : ""}`}
        </button>
      </div>

      <TileFilterBar filters={tileFilters} tileKey={plan ? "material-request-plan" : "material-requests"} fields={fieldsFor(plan)} dateLabel="Requested" />

      {paged.isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : paged.total === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "No requests yet"} hint={isFiltered ? "Nothing matches these filters." : "Requests show here once a Store or the R&D Store asks the Warehouse for material."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Requested</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Requested By</th>
                {plan && <th className="px-4 py-3">Product / PO</th>}
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">Requested</th>
                <th className="px-4 py-3 text-right">Issued</th>
                <th className="px-4 py-3 text-right">Remaining</th>
                <th className="px-4 py-3">Needed By</th>
                <th className="px-4 py-3 text-right">Warehouse Stock</th>
                <th className="px-4 py-3">Purchase Trail</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.rows.map((r) => (
                <Fragment key={r.key}>
                <tr className={`transition hover:bg-slate-50 ${r.overdue ? "bg-rose-50/40" : ""}`}>
                  <td className="px-4 py-3 text-slate-600">{day(r.requestedAt)}</td>
                  <td className="px-4 py-3">
                    <span className={`pill ${STATUS_STYLE[r.status] ?? ""}`}>{r.status}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-bold text-slate-800">{r.requesterName}</span>
                    <span className="block text-micro text-slate-400">{r.requestedBy}</span>
                  </td>
                  {plan && (
                    <td className="whitespace-normal px-4 py-3">
                      <span className="font-bold text-slate-800">{r.productName ?? "—"}</span>
                      <span className="block text-micro text-slate-400">
                        {r.poNumber ?? "—"}
                        {r.plantName ? ` · ${r.plantName}` : ""}
                      </span>
                    </td>
                  )}
                  <td className="whitespace-normal px-4 py-3 font-bold text-slate-800">{r.itemName}</td>
                  <td className="px-4 py-3 text-slate-500">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                  <td className="px-4 py-3 text-right font-mono text-slate-700">
                    {fmtQty(r.requestedQty)} {r.unit}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-700">{r.issuedQty ? fmtQty(r.issuedQty) : "—"}</td>
                  <td className={`px-4 py-3 text-right font-mono ${r.remainingQty > 0 ? "font-bold text-slate-900" : "text-slate-300"}`}>{r.remainingQty > 0 ? fmtQty(r.remainingQty) : "—"}</td>
                  <td className={`px-4 py-3 ${r.overdue ? "font-bold text-rose-700" : "text-slate-500"}`}>
                    {day(r.neededBy)}
                    {r.overdue && <span className="block text-micro">Overdue</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="font-mono text-slate-700">{fmtQty(r.warehouseOnHand)}</span>
                    {r.short && <span className="block text-micro font-bold text-rose-600">{fmtQty(r.shortBy)} short</span>}
                  </td>
                  <td className="px-4 py-3">
                    {r.supply === "NONE" ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <>
                        <span className={`pill ${SUPPLY_STYLE[r.supplyLabel] ?? ""}`}>{r.supplyLabel}</span>
                        {r.supply === "ON_ORDER" && (
                          <span className="block text-micro text-slate-500">
                            {r.piNumber} · ETA {day(r.eta)}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <AgingCell since={r.requestedAt} />
                  </td>
                  <td className="px-4 py-3">
                    <ActionMenu
                      busy={review.isPending || escalate.isPending || fulfillRnd.isPending}
                      items={[
                        ...(r.source === "store" && r.statusKey === "PENDING"
                          ? [
                              { key: "approve", label: "Approve", icon: Check, tone: "primary" as const, onClick: () => approve(r) },
                              { key: "reject", label: "Reject", icon: X, tone: "danger" as const, onClick: () => openPanel(r, "reject") },
                            ]
                          : []),
                        ...(r.source === "store" && (r.statusKey === "APPROVED" || r.statusKey === "PARTIALLY_ISSUED") && r.warehouseOnHand > 0
                          ? [{ key: "issue", label: r.short ? "Issue what we have" : "Issue", icon: Send, tone: "primary" as const, onClick: () => openPanel(r, "issue") }]
                          : []),
                        ...(r.source === "rnd" && r.statusKey === "PENDING"
                          ? [
                              ...(r.warehouseOnHand >= r.remainingQty ? [{ key: "rnd", label: "Send to R&D", icon: Send, tone: "primary" as const, onClick: () => sendToRnd(r) }] : []),
                              { key: "reject", label: "Reject", icon: X, tone: "danger" as const, onClick: () => openPanel(r, "reject") },
                            ]
                          : []),
                        ...(r.short && r.supply === "NONE"
                          ? [{ key: "ppic", label: "Send to PPIC", icon: Send, onClick: () => sendToPpic(r), title: "The Warehouse cannot fill this - raise the shortage to PPIC" }]
                          : []),
                      ]}
                    />
                  </td>
                </tr>
                {panel?.key === r.key && (
                  <tr>
                    <td colSpan={plan ? 14 : 13} className="whitespace-normal bg-slate-50/70 px-4 py-3">
                      {panel.mode === "reject" ? (
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="min-w-[260px] flex-1">
                            <label className="label">Reason for rejecting {r.requesterName}&apos;s request</label>
                            <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. not needed / use stock already at your store" />
                          </div>
                          <button type="button" className="btn-ghost btn-sm" onClick={closePanel}>
                            Cancel
                          </button>
                          <button type="button" className="btn-primary btn-sm" disabled={review.isPending || rejectRnd.isPending} onClick={() => submitReject(r)}>
                            Reject request
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-end gap-3">
                          <div>
                            <label className="label">
                              Quantity to issue ({r.unit}) — {fmtQty(r.remainingQty)} owed, {fmtQty(r.warehouseOnHand)} in the Warehouse
                            </label>
                            <input className="field w-40 font-mono" type="number" min="0" step="any" value={issueQty} onChange={(e) => setIssueQty(e.target.value)} />
                          </div>
                          <div>
                            <label className="label">Date</label>
                            <input className="field" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
                          </div>
                          {r.source === "store" ? (
                            <span className="pb-2 text-tiny font-bold text-amber-700">Goes to {r.requesterName} as In Transit: it counts in their stock once they receive it.</span>
                          ) : (
                            <>
                              <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600" title="Won't count at the store until it confirms the delivery">
                                <input type="checkbox" className="h-3.5 w-3.5" checked={transit} onChange={(e) => setTransit(e.target.checked)} />
                                Track as in-transit
                              </label>
                              <span className="pb-2 text-tiny text-slate-500">Goes straight into {r.requesterName}.</span>
                            </>
                          )}
                          <button type="button" className="btn-ghost btn-sm" onClick={closePanel}>
                            Cancel
                          </button>
                          <button type="button" className="btn-primary btn-sm" disabled={issue.isPending} onClick={() => submitIssue(r)}>
                            {issue.isPending ? "Issuing…" : "Confirm issue"}
                          </button>
                        </div>
                      )}
                      {formError && <p className="mt-2 text-xs font-bold text-rose-600">{formError}</p>}
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
