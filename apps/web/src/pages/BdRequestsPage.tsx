import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, MessageSquareWarning, X } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ITEM_CHANGE_LABEL, useDecideItemChangeRequest, useItemChangeRequests, type ItemChangeRequest, type ItemChangeStatus } from "../lib/itemChangeHooks";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { AgingCell, agingDays, inAgingBuckets } from "../components/AgingCell";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { BdProductsList } from "../components/BdProductsList";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { CustomerName } from "../components/CustomerName";

// BD asks PPIC to put a product on Hold or to cancel it (possible until Production has made the first batch). PPIC accepts, which does it,
// or rejects with a reason. BD is told either way.

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-");
const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
type Tab = ItemChangeStatus | "PRODUCTS";
const TABS: [Tab, string][] = [
  ["PENDING", "Waiting for PPIC"],
  ["ACCEPTED", "Accepted"],
  ["REJECTED", "Rejected"],
];
const KIND_PILL = { HOLD: "border-amber-200 bg-amber-50 text-amber-700", CANCEL: "border-rose-200 bg-rose-50 text-rose-700" } as const;

export function BdRequestsPage() {
  const { hasRole } = useAuth();
  const canDecide = hasRole("PPIC", "ADMIN");
  const canAsk = hasRole("BD");
  const toast = useToast();
  // BD opens on the list of every product (to hold / cancel from there); PPIC opens on what waits for it
  const [tab, setTab] = useState<Tab>(canAsk && !canDecide ? "PRODUCTS" : "PENDING");
  const { data, isLoading } = useItemChangeRequests(tab === "PRODUCTS" ? "PENDING" : tab);
  const decide = useDecideItemChangeRequest();
  const filters = useTileFilters();
  const [asking, setAsking] = useState<{ row: ItemChangeRequest; action: "ACCEPT" | "REJECT" } | null>(null);
  const everyRow = data ?? [];
  const picked = (key: string) => filters.applied.picks[key] ?? [];

  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct(everyRow.map((r) => r.poNumber)) },
    { key: "customer", label: "Customer", options: distinct(everyRow.map((r) => r.customerName)) },
    { key: "product", label: "Product", options: distinct(everyRow.map((r) => r.productName)) },
    { key: "kind", label: "Request", options: ["Hold", "Cancel"] },
    { key: "by", label: "Requested by", options: distinct(everyRow.map((r) => r.requestedByName)) },
    AGING_FIELD,
  ];

  const rows = useMemo(() => {
    const { dateFrom, dateTo } = filters.applied;
    return everyRow.filter(
      (r) =>
        (!picked("po").length || picked("po").includes(r.poNumber ?? "")) &&
        (!picked("customer").length || picked("customer").includes(r.customerName)) &&
        (!picked("product").length || picked("product").includes(r.productName)) &&
        (!picked("kind").length || picked("kind").includes(ITEM_CHANGE_LABEL[r.kind])) &&
        (!picked("by").length || picked("by").includes(r.requestedByName)) &&
        inAgingBuckets(r.status === "PENDING" ? agingDays(r.requestedAt) : null, picked("aging")) &&
        (!dateFrom || r.requestedAt.slice(0, 10) >= dateFrom) &&
        (!dateTo || r.requestedAt.slice(0, 10) <= dateTo),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyRow, filters.applied]);
  const pg = useClientPaging(rows);

  async function run(reason: string) {
    if (!asking) return;
    try {
      await decide.mutateAsync({ id: asking.row.id, action: asking.action, note: reason || undefined });
      toast.success(asking.action === "ACCEPT" ? `${asking.row.productName}: done, BD is told.` : "Request rejected, BD is told.");
      setAsking(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-amber-500/10 text-amber-600">
            <MessageSquareWarning className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{canDecide ? "BD Requests" : "Hold / Cancel Requests"}</h1>
            <p className="text-sm text-slate-500">
              {canDecide
                ? "BD asks you to put a product on hold or cancel it. Possible until Production has made the first batch."
                : "Every product of every approved PO with its status. Ask PPIC to hold or cancel one from its row, and see what PPIC decided in the other tabs. Possible until Production has made the first batch."}
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(canAsk ? ([["PRODUCTS", "All products"], ...TABS] as [Tab, string][]) : TABS).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`pill cursor-pointer ${k === tab ? "border-brand-300 bg-brand-50 text-brand-700 ring-2 ring-brand-200" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "PRODUCTS" ? (
        <BdProductsList />
      ) : (
        <>
      <TileFilterBar filters={filters} tileKey={`bd-requests-${tab}`} fields={fields} dateLabel="Requested" />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={MessageSquareWarning} title={filters.activeCount > 0 ? "Nothing matches these filters" : tab === "PENDING" ? "No request is waiting" : "Nothing here yet"} hint={canAsk ? "Ask PPIC to hold or cancel a product from the All products tab." : "BD raises a request from the Hold / Cancel Requests page."} />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2.5">PO Number</th>
                  <th className="px-3 py-2.5">Stage</th>
                  <th className="px-3 py-2.5">Request</th>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="px-3 py-2.5">Product</th>
                  <th className="px-3 py-2.5">Qty</th>
                  <th className="px-3 py-2.5">Plant</th>
                  <th className="px-3 py-2.5">Reason</th>
                  <th className="px-3 py-2.5">Requested by</th>
                  <th className="px-3 py-2.5">{tab === "PENDING" ? "Waiting" : "Decided"}</th>
                  {tab !== "PENDING" && <th className="px-3 py-2.5">PPIC's note</th>}
                  {tab === "PENDING" && canDecide && <th className="px-3 py-2.5 text-right">Action</th>}
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50">
                    <td className="px-3 py-2.5 font-bold text-slate-700">
                      <Link to={`/purchase-orders/${r.poId}`} className="hover:text-brand-600 hover:underline">
                        {r.poNumber ?? r.poId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{r.isCancelled ? "Cancelled" : r.isHeld ? "On hold" : r.planSent ? "Sent to Production" : "Not sent to Production"}</td>
                    <td className="px-3 py-2.5">
                      <span className={`pill ${KIND_PILL[r.kind]}`}>{ITEM_CHANGE_LABEL[r.kind]}</span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600"><CustomerName name={r.customerName} /></td>
                    <td className="px-3 py-2.5 font-bold text-slate-800">{r.productName}</td>
                    <td className="px-3 py-2.5 text-slate-600">
                      {r.quantity} {r.unit}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{r.plantName ?? "-"}</td>
                    <td className="max-w-[18rem] truncate px-3 py-2.5 text-slate-600" title={r.reason}>
                      {r.reason}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{r.requestedByName}</td>
                    <td className="px-3 py-2.5">{tab === "PENDING" ? <AgingCell since={r.requestedAt} /> : <span className="text-slate-600">{day(r.decidedAt)}</span>}</td>
                    {tab !== "PENDING" && (
                      <td className="max-w-[16rem] truncate px-3 py-2.5 text-slate-600" title={r.decisionNote ?? ""}>
                        {r.decisionNote ?? "-"}
                      </td>
                    )}
                    {tab === "PENDING" && canDecide && (
                      <td className="px-3 py-2.5 text-right">
                        <div className="inline-flex gap-1.5">
                          <button type="button" className="btn-primary btn-sm" disabled={r.hasBatch || r.isCancelled} title={r.hasBatch ? "Production has already made a batch" : undefined} onClick={() => setAsking({ row: r, action: "ACCEPT" })}>
                            <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> Accept
                          </button>
                          <button type="button" className="btn-ghost btn-sm text-rose-600" onClick={() => setAsking({ row: r, action: "REJECT" })}>
                            <X className="h-3.5 w-3.5" strokeWidth={2.5} /> Reject
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ClientPager pg={pg} />
        </div>
      )}
        </>
      )}

      <ConfirmDialog
        open={asking?.action === "ACCEPT"}
        tone={asking?.row.kind === "CANCEL" ? "danger" : "brand"}
        title={asking?.row.kind === "CANCEL" ? "Cancel this product for good?" : "Put this product on hold?"}
        message={
          asking && (
            <>
              <b>
                {asking.row.productName} ({asking.row.poNumber ?? "PO"})
              </b>
              : BD asked for this ("{asking.row.reason}").{" "}
              {asking.row.kind === "CANCEL" ? "A cancelled product is closed for good and cannot be undone." : "Production cannot open or move its run, or make batches, until you release it."}
            </>
          )
        }
        confirmLabel={asking?.row.kind === "CANCEL" ? "Yes, cancel it" : "Yes, put on hold"}
        busy={decide.isPending}
        onConfirm={() => void run("")}
        onCancel={() => setAsking(null)}
      />
      <ConfirmDialog
        open={asking?.action === "REJECT"}
        title="Reject the request?"
        message={asking && <>Tell BD why {asking.row.productName} stays as it is.</>}
        requireReason
        reasonLabel="Reason for BD"
        confirmLabel="Reject"
        busy={decide.isPending}
        onConfirm={(reason) => void run(reason)}
        onCancel={() => setAsking(null)}
      />
    </div>
  );
}
