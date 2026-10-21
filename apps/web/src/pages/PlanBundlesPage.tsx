import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronDown, ChevronRight, Download, HandHelping, Layers, PackageOpen, Send, X } from "lucide-react";
import { ApiError, api, apiAll } from "../lib/api";
import { appendParams, useTileFilters } from "../lib/tileFilters";
import { exportMaterialRequestsReport, type MaterialRequestRow } from "../lib/inventoryExport";
import { useEscalateMaterialRequest, useIssueInventoryRequest, useReviewInventoryRequest } from "../lib/hooks";
import { fmtQty } from "../lib/format";
import { groupBundles, type Bundle } from "../lib/bundles";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { ActionMenu } from "../components/ActionMenu";
import { AgingCell } from "../components/AgingCell";
import { BundleCard } from "../components/BundleCard";
import { TileFilterBar, AGING_FIELD, type FilterField } from "../components/TileFilterBar";
import type { OptionPage } from "../components/MultiSelectDropdown";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { STATUS_STYLE, SUPPLY_STYLE } from "./MaterialRequestsPage";

const BASE = "/api/inventory/material-requests";
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");

const serverList = (key: string, label: string): FilterField => ({
  key,
  label,
  load: (q) => api<OptionPage>(`${BASE}/options?field=${key}&kind=plan${q ? `&q=${encodeURIComponent(q)}` : ""}`),
});
const FIELDS: FilterField[] = [
  serverList("requester", "Requested By"),
  serverList("product", "Product"),
  serverList("po", "PO Number"),
  { key: "category", label: "Category", options: ["RM", "PM"] },
  serverList("item", "Item"),
  { key: "status", label: "Status", options: ["Pending", "Approved", "Partly issued", "Issued", "Rejected", "Cancelled"] },
  { key: "short", label: "Short at Warehouse", options: ["Yes", "No"] },
  { key: "supply", label: "Purchase Trail", options: ["With PPIC", "With Purchase", "On order", "Received"] },
  AGING_FIELD,
];

const isStorePending = (r: MaterialRequestRow) => r.source === "store" && r.statusKey === "PENDING";
const isIssuable = (r: MaterialRequestRow) => r.source === "store" && (r.statusKey === "APPROVED" || r.statusKey === "PARTIALLY_ISSUED") && r.warehouseOnHand > 0 && r.remainingQty > 0;
const isEscalable = (r: MaterialRequestRow) => r.short && r.supply === "NONE";

// The same material asked for by several plans (and Day Stores) is one line in the "By material" view: the Warehouse sends it in one go.
type MaterialGroup = { key: string; itemName: string; category: string; unit: string; lines: MaterialRequestRow[]; remaining: number; onHand: number; stores: number; plans: number; overdue: boolean };
// Earliest needed first (late ones, then the soonest needed-by, then the oldest request): the order a lot is shared between the plans.
const fifo = (a: MaterialRequestRow, b: MaterialRequestRow) => Number(b.overdue) - Number(a.overdue) || (a.neededBy ?? "9").localeCompare(b.neededBy ?? "9") || a.requestedAt.localeCompare(b.requestedAt);
function groupByMaterial(rows: MaterialRequestRow[]): MaterialGroup[] {
  const map = new Map<string, MaterialGroup>();
  for (const r of rows.filter((x) => x.open)) {
    const key = `${r.category}::${r.itemName}`;
    const g = map.get(key) ?? { key, itemName: r.itemName, category: r.category, unit: r.unit, lines: [], remaining: 0, onHand: r.warehouseOnHand, stores: 0, plans: 0, overdue: false };
    g.lines.push(r);
    g.remaining += r.remainingQty;
    g.overdue = g.overdue || r.overdue;
    map.set(key, g);
  }
  return [...map.values()]
    .map((g) => ({ ...g, remaining: Math.round(g.remaining * 1000) / 1000, stores: new Set(g.lines.map((l) => l.requesterStoreId ?? l.requesterName)).size, plans: new Set(g.lines.map((l) => l.purchaseOrderItemId ?? l.id)).size }))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.itemName.localeCompare(b.itemName));
}

// The urgent, plan-driven requests Day Stores raised to the Warehouse, one card per product (and Day Store): the materials a
// product's production plan still needs. The Warehouse approves and issues a whole product at once (header buttons) or
// line by line, and sends what it cannot fill to PPIC. Late ones come first.
export function PlanBundlesPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const tileFilters = useTileFilters();
  const escalate = useEscalateMaterialRequest();
  const review = useReviewInventoryRequest();
  const issue = useIssueInventoryRequest();
  const [exporting, setExporting] = useState(false);
  const [view, setView] = useState<"product" | "material">("product");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ key: string; mode: "issue" | "reject" } | null>(null);
  const [issueQty, setIssueQty] = useState("");
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const qs = appendParams(new URLSearchParams(), { ...tileFilters.params, kind: "plan" }).toString();
  const { data: rows, isLoading } = useQuery({ queryKey: ["inventory", "material-requests", "plan-all", qs], queryFn: () => apiAll<MaterialRequestRow>(`${BASE}?${qs}`) });
  const bundles = groupBundles(rows ?? [], (r) => r.requesterStoreId ?? r.requesterName);
  const pg = useClientPaging(bundles);
  const groups = groupByMaterial(rows ?? []);
  const gpg = useClientPaging(groups);
  const isFiltered = tileFilters.activeCount > 0;

  const refresh = () => qc.invalidateQueries({ queryKey: ["inventory", "material-requests"] });
  const closePanel = () => {
    setPanel(null);
    setFormError(null);
    setReason("");
  };
  const openPanel = (r: MaterialRequestRow, mode: "issue" | "reject") => {
    setFormError(null);
    setReason("");
    setIssueQty(String(Math.max(0, Math.min(r.remainingQty, r.warehouseOnHand))));
    setPanel({ key: r.key, mode });
  };

  async function runAll(key: string, lines: MaterialRequestRow[], doOne: (r: MaterialRequestRow) => Promise<unknown>, doneWord: string) {
    setBusyKey(key);
    let ok = 0;
    let failed = 0;
    let lastError = "";
    for (const line of lines) {
      try {
        await doOne(line);
        ok += 1;
      } catch (err) {
        failed += 1;
        lastError = err instanceof ApiError ? err.message : "failed";
      }
    }
    await refresh();
    setBusyKey(null);
    if (failed === 0) toast.success(`${ok} material${ok === 1 ? "" : "s"} ${doneWord}.`);
    else toast.error(`${ok} ${doneWord}, ${failed} could not be done — ${lastError}`);
  }

  const approveLine = (r: MaterialRequestRow) => review.mutateAsync({ id: r.id, action: "APPROVE" });
  const issueLine = (r: MaterialRequestRow) => issue.mutateAsync({ id: r.id, date: new Date().toISOString().slice(0, 10), unit: r.unit, quantity: Math.min(r.remainingQty, r.warehouseOnHand), dayStoreId: null });
  const escalateLine = (r: MaterialRequestRow) => escalate.mutateAsync({ source: r.source, id: r.id });

  async function one(label: string, fn: () => Promise<unknown>, fallback: string) {
    try {
      await fn();
      await refresh();
      toast.success(label);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : fallback);
    }
  }
  async function submitReject(r: MaterialRequestRow) {
    if (!reason.trim()) return setFormError("A reason is required to reject a request.");
    try {
      await review.mutateAsync({ id: r.id, action: "REJECT", rejectionReason: reason.trim() });
      await refresh();
      toast.success("Request rejected.");
      closePanel();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not reject this request");
    }
  }
  async function submitIssue(r: MaterialRequestRow) {
    const qty = Number(issueQty);
    if (!qty || qty <= 0) return setFormError("Enter a quantity greater than zero.");
    if (qty > r.remainingQty + 1e-9) return setFormError(`Only ${fmtQty(r.remainingQty)} ${r.unit} is still owed.`);
    if (qty > r.warehouseOnHand + 1e-9) return setFormError(`The Warehouse has only ${fmtQty(r.warehouseOnHand)} ${r.unit}.`);
    try {
      await issue.mutateAsync({ id: r.id, date: issueDate, unit: r.unit, quantity: qty, dayStoreId: null });
      await refresh();
      toast.success(`${fmtQty(qty)} ${r.unit} issued to ${r.requesterName}.`);
      closePanel();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not issue this request");
    }
  }

  // One material for every plan that needs it: approves what is waiting and issues what the Warehouse holds, sharing it between the plans
  // earliest-needed first. It all lands in the Day Store as one pile; the Day Store then sends each plan its part.
  async function issueMaterial(g: MaterialGroup) {
    setBusyKey(g.key);
    let left = g.onHand;
    let ok = 0;
    let failed = 0;
    let lastError = "";
    for (const r of [...g.lines].sort(fifo)) {
      const qty = Math.min(r.remainingQty, left);
      if (qty <= 1e-9) continue;
      try {
        if (isStorePending(r)) await approveLine(r);
        await issue.mutateAsync({ id: r.id, date: new Date().toISOString().slice(0, 10), unit: r.unit, quantity: qty, dayStoreId: null });
        left -= qty;
        ok += 1;
      } catch (err) {
        failed += 1;
        lastError = err instanceof ApiError ? err.message : "failed";
      }
    }
    await refresh();
    setBusyKey(null);
    if (failed === 0) toast.success(`${g.itemName}: issued for ${ok} request${ok === 1 ? "" : "s"}.`);
    else toast.error(`${g.itemName}: ${ok} issued, ${failed} could not be done — ${lastError}`);
  }
  const toggleOpen = (key: string) => setOpen((cur) => (cur.has(key) ? new Set([...cur].filter((k) => k !== key)) : new Set([...cur, key])));

  function renderMaterials() {
    return (
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="w-8 px-3 py-2.5"></th>
                <th className="px-4 py-2.5">Material</th>
                <th className="px-4 py-2.5">Category</th>
                <th className="px-4 py-2.5 text-right">Plans</th>
                <th className="px-4 py-2.5 text-right">Day Stores</th>
                <th className="px-4 py-2.5 text-right">Owed (all plans)</th>
                <th className="px-4 py-2.5 text-right">Warehouse Stock</th>
                <th className="px-4 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {gpg.rows.map((g) => {
                const short = g.remaining - g.onHand > 1e-6;
                const canIssue = g.onHand > 1e-9 && g.lines.some((l) => (isStorePending(l) || isIssuable(l) || l.statusKey === "APPROVED") && l.remainingQty > 0);
                return (
                  <Fragment key={g.key}>
                    <tr className="border-b border-slate-50 align-top hover:bg-slate-50">
                      <td className="px-3 py-2.5">
                        <button type="button" onClick={() => toggleOpen(g.key)} className="text-slate-400 hover:text-brand-600" title="Show the plans">
                          {open.has(g.key) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      </td>
                      <td className="px-4 py-2.5 font-bold text-slate-800">
                        {g.itemName}
                        {g.overdue && <span className="ml-1.5 rounded-full bg-rose-100 px-1.5 py-0.5 align-middle text-micro font-bold uppercase text-rose-700">Late</span>}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">{g.category === "RM" ? "Raw Material" : "Packaging"}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{g.plans}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{g.stores}</td>
                      <td className="px-4 py-2.5 text-right font-mono font-bold text-slate-900">
                        {fmtQty(g.remaining)} {g.unit}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="font-mono text-slate-700">{fmtQty(g.onHand)}</span>
                        {short && <span className="block text-micro font-bold text-rose-600">{fmtQty(g.remaining - g.onHand)} short</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button type="button" className="btn-primary btn-sm" disabled={!canIssue || busyKey === g.key} onClick={() => issueMaterial(g)} title="Approves what is waiting and issues what the Warehouse holds for all these plans together, earliest needed first">
                          <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {short ? "Issue what we have" : "Issue all"}
                        </button>
                      </td>
                    </tr>
                    {open.has(g.key) && (
                      <tr className="border-b border-slate-100">
                        <td colSpan={8} className="bg-slate-50/70 px-6 py-3">
                          <table className="w-full whitespace-nowrap text-xs">
                            <thead>
                              <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                                <th className="px-3 py-1.5">Product</th>
                                <th className="px-3 py-1.5">PO</th>
                                <th className="px-3 py-1.5">For</th>
                                <th className="px-3 py-1.5">Status</th>
                                <th className="px-3 py-1.5 text-right">Owed</th>
                                <th className="px-3 py-1.5">Needed by</th>
                              </tr>
                            </thead>
                            <tbody>
                              {[...g.lines].sort(fifo).map((l) => (
                                <tr key={l.key}>
                                  <td className="px-3 py-1.5 font-bold text-slate-700">{l.productName ?? "—"}</td>
                                  <td className="px-3 py-1.5 text-slate-600">{l.poNumber ?? "—"}</td>
                                  <td className="px-3 py-1.5 text-slate-600">{l.requesterName}</td>
                                  <td className="px-3 py-1.5">
                                    <span className={`pill ${STATUS_STYLE[l.status] ?? ""}`}>{l.status}</span>
                                  </td>
                                  <td className="px-3 py-1.5 text-right font-mono">
                                    {fmtQty(l.remainingQty)} {l.unit}
                                  </td>
                                  <td className={`px-3 py-1.5 ${l.overdue ? "font-bold text-rose-600" : "text-slate-600"}`}>{l.neededBy ? day(l.neededBy) : "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <ClientPager pg={gpg} />
      </div>
    );
  }

  async function exportAll() {
    setExporting(true);
    try {
      exportMaterialRequestsReport(rows ?? []);
    } finally {
      setExporting(false);
    }
  }

  function renderBundle(b: Bundle<MaterialRequestRow>) {
    const lines = b.lines;
    const pending = lines.filter(isStorePending);
    const issuable = lines.filter(isIssuable);
    const escalable = lines.filter(isEscalable);
    const shortLines = lines.filter((l) => l.short).length;
    const done = lines.filter((l) => !l.open).length;
    const busy = busyKey === b.key;
    const store = lines[0]!.requesterName;
    return (
      <BundleCard
        key={b.key}
        title={b.title}
        subtitle={[`For ${store}`, b.subtitle].filter(Boolean).join(" · ")}
        neededBy={b.neededBy ? day(b.neededBy) : null}
        overdue={b.overdue}
        chips={[
          { label: `${lines.length} material${lines.length === 1 ? "" : "s"}` },
          ...(done ? [{ label: `${done} done`, tone: "good" as const }] : []),
          ...(shortLines ? [{ label: `${shortLines} short at Warehouse`, tone: "bad" as const }] : []),
        ]}
        actions={
          <>
            {pending.length > 0 && (
              <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => runAll(b.key, pending, approveLine, "approved")}>
                <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> Approve all ({pending.length})
              </button>
            )}
            {issuable.length > 0 && (
              <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => runAll(b.key, issuable, issueLine, `issued to ${store}`)} title="Issues what the Warehouse holds for each approved material, up to what is owed">
                <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> Issue what we have ({issuable.length})
              </button>
            )}
            {escalable.length > 0 && (
              <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => runAll(b.key, escalable, escalateLine, "sent to PPIC")} title="Sends every material the Warehouse is short of to PPIC">
                <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> Send short to PPIC ({escalable.length})
              </button>
            )}
          </>
        }
      >
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2.5">Item</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5 text-right">Requested</th>
              <th className="px-4 py-2.5 text-right">Issued</th>
              <th className="px-4 py-2.5 text-right">Remaining</th>
              <th className="px-4 py-2.5 text-right">Warehouse Stock</th>
              <th className="px-4 py-2.5">Purchase Trail</th>
              <th className="px-4 py-2.5">Aging</th>
              <th className="px-4 py-2.5">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((r) => (
              <Fragment key={r.key}>
                <tr className="align-top transition hover:bg-slate-50">
                  <td className="whitespace-normal px-4 py-2.5 font-bold text-slate-800">{r.itemName}</td>
                  <td className="px-4 py-2.5">
                    <span className={`pill ${STATUS_STYLE[r.status] ?? ""}`}>{r.status}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                    {fmtQty(r.requestedQty)} {r.unit}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-emerald-700">{r.issuedQty ? fmtQty(r.issuedQty) : "—"}</td>
                  <td className={`px-4 py-2.5 text-right font-mono ${r.remainingQty > 0 ? "font-bold text-slate-900" : "text-slate-300"}`}>{r.remainingQty > 0 ? fmtQty(r.remainingQty) : "—"}</td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="font-mono text-slate-700">{fmtQty(r.warehouseOnHand)}</span>
                    {r.short && <span className="block text-micro font-bold text-rose-600">{fmtQty(r.shortBy)} short</span>}
                  </td>
                  <td className="px-4 py-2.5">
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
                  <td className="px-4 py-2.5">
                    <AgingCell since={r.requestedAt} />
                  </td>
                  <td className="px-4 py-2.5">
                    <ActionMenu
                      busy={review.isPending || escalate.isPending || busy}
                      items={[
                        ...(isStorePending(r)
                          ? [
                              { key: "approve", label: "Approve", icon: Check, tone: "primary" as const, onClick: () => one("Approved.", () => approveLine(r), "Could not approve this request") },
                              { key: "reject", label: "Reject", icon: X, tone: "danger" as const, onClick: () => openPanel(r, "reject") },
                            ]
                          : []),
                        ...(isIssuable(r) ? [{ key: "issue", label: r.short ? "Issue what we have" : "Issue", icon: Send, tone: "primary" as const, onClick: () => openPanel(r, "issue") }] : []),
                        ...(isEscalable(r) ? [{ key: "ppic", label: "Send to PPIC", icon: Send, onClick: () => one(`Sent to PPIC — ${fmtQty(r.shortBy)} ${r.unit} is short.`, () => escalateLine(r), "Could not send this to PPIC"), title: "The Warehouse cannot fill this - raise the shortage to PPIC" }] : []),
                      ]}
                    />
                  </td>
                </tr>
                {panel?.key === r.key && (
                  <tr>
                    <td colSpan={9} className="whitespace-normal bg-slate-50/70 px-4 py-3">
                      {panel.mode === "reject" ? (
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="min-w-[260px] flex-1">
                            <label className="label">Reason for rejecting {r.requesterName}&apos;s request</label>
                            <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. plan changed" />
                          </div>
                          <button type="button" className="btn-ghost btn-sm" onClick={closePanel}>
                            Cancel
                          </button>
                          <button type="button" className="btn-primary btn-sm" disabled={review.isPending} onClick={() => submitReject(r)}>
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
                          <span className="pb-2 text-tiny text-slate-500">Goes straight into {r.requesterName}.</span>
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
      </BundleCard>
    );
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
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Material Request (Plan)</h1>
            <p className="text-sm text-slate-500">
              {bundles.length.toLocaleString()} product{bundles.length === 1 ? "" : "s"} ({(rows ?? []).length.toLocaleString()} material request{(rows ?? []).length === 1 ? "" : "s"}){isFiltered ? " match" : ""} — urgent: what a production plan needs from the Warehouse. Late ones come first.
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm shrink-0" disabled={!rows?.length || exporting} onClick={exportAll}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Report{isFiltered ? " (Filtered)" : ""}
        </button>
      </div>

      <TileFilterBar filters={tileFilters} tileKey="material-request-plan" fields={FIELDS} dateLabel="Requested" />

      <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs font-bold">
        <button type="button" onClick={() => setView("product")} className={`rounded-md px-3 py-1.5 ${view === "product" ? "bg-brand-600 text-white" : "text-slate-500 hover:text-slate-800"}`}>
          By product
        </button>
        <button type="button" onClick={() => setView("material")} className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 ${view === "material" ? "bg-brand-600 text-white" : "text-slate-500 hover:text-slate-800"}`}>
          <Layers className="h-3.5 w-3.5" strokeWidth={2.25} /> By material (bulk)
        </button>
      </div>

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : view === "material" && groups.length > 0 ? (
        renderMaterials()
      ) : bundles.length === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "No plan requests"} hint={isFiltered ? "Nothing matches these filters." : "Requests show here when a Day Store asks the Warehouse for material a production plan needs."} accent="brand" />
      ) : (
        <div className="space-y-4">
          {pg.rows.map(renderBundle)}
          <div className="overflow-hidden rounded-2xl">
            <ClientPager pg={pg} />
          </div>
        </div>
      )}
    </div>
  );
}
