import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PauseCircle } from "lucide-react";
import { ApiError } from "../lib/api";
import { usePurchaseOrders } from "../lib/hooks";
import { useCreateItemChangeRequest, type ItemChangeKind } from "../lib/itemChangeHooks";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import type { PurchaseOrder, PurchaseOrderItem } from "../lib/types";
import { ClientPager } from "./Pagination";
import { TileFilterBar, type FilterField } from "./TileFilterBar";
import { ConfirmDialog } from "./ConfirmDialog";
import { CustomerName } from "./CustomerName";
import { EmptyState } from "./EmptyState";
import { useToast } from "./Toast";

// BD's own view of every product of every approved PO, with where it stands, and the Hold / Cancel request right on the row.
// PPIC decides; the server checks the rules again (no batch made yet, one open request per product).

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-");
const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const BATCH_MADE = ["IN_PRODUCTION", "FINISHED_GOODS", "DISPATCH", "COMPLETED"];

const STAGE_LABEL: Record<string, string> = {
  PRE_PRODUCTION: "Production run opened",
  IN_PRODUCTION: "In production",
  FINISHED_GOODS: "Finished goods",
  DISPATCH: "Dispatch",
  COMPLETED: "Completed",
};

function statusOf(item: PurchaseOrderItem): { label: string; tone: string } {
  if (item.cancelledAt) return { label: "Cancelled", tone: "border-rose-200 bg-rose-50 text-rose-700" };
  if (item.materialHeldAt) return { label: "On hold", tone: "border-amber-200 bg-amber-50 text-amber-700" };
  if (item.productionStage) return { label: STAGE_LABEL[item.productionStage] ?? item.productionStage, tone: item.productionStage === "COMPLETED" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-sky-200 bg-sky-50 text-sky-700" };
  if (item.planSentToProductionAt) return { label: "Sent to Production", tone: "border-sky-200 bg-sky-50 text-sky-700" };
  return { label: "Not sent to Production", tone: "border-slate-200 bg-slate-50 text-slate-600" };
}

interface Row {
  po: PurchaseOrder;
  item: PurchaseOrderItem;
  status: string;
}

export function BdProductsList() {
  const toast = useToast();
  const { data: orders, isLoading } = usePurchaseOrders();
  const create = useCreateItemChangeRequest();
  const filters = useTileFilters();
  const [asking, setAsking] = useState<{ row: Row; kind: ItemChangeKind } | null>(null);
  const picked = (key: string) => filters.applied.picks[key] ?? [];

  // Only approved POs: a draft PO BD changes itself, and PPIC sees only approved ones
  const every = useMemo<Row[]>(
    () =>
      (orders ?? [])
        .filter((po) => po.status === "APPROVED")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .flatMap((po) => po.items.map((item) => ({ po, item, status: statusOf(item).label }))),
    [orders],
  );

  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct(every.map((r) => r.po.poNumber)) },
    { key: "customer", label: "Customer", options: distinct(every.map((r) => r.po.customer.companyName)) },
    { key: "product", label: "Product", options: distinct(every.map((r) => r.item.productName)) },
    { key: "status", label: "Status", options: distinct(every.map((r) => r.status)) },
  ];

  const rows = useMemo(() => {
    const { dateFrom, dateTo } = filters.applied;
    return every.filter(
      (r) =>
        (!picked("po").length || picked("po").includes(r.po.poNumber ?? "")) &&
        (!picked("customer").length || picked("customer").includes(r.po.customer.companyName)) &&
        (!picked("product").length || picked("product").includes(r.item.productName)) &&
        (!picked("status").length || picked("status").includes(r.status)) &&
        (!dateFrom || r.po.createdAt.slice(0, 10) >= dateFrom) &&
        (!dateTo || r.po.createdAt.slice(0, 10) <= dateTo),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [every, filters.applied]);
  const pg = useClientPaging(rows);

  async function send(reason: string) {
    if (!asking) return;
    try {
      await create.mutateAsync({ purchaseOrderItemId: asking.row.item.id, kind: asking.kind, reason });
      toast.success(`Request sent to PPIC for ${asking.row.item.productName}.`);
      setAsking(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not send the request");
    }
  }

  return (
    <div className="space-y-4">
      <TileFilterBar filters={filters} tileKey="bd-products" fields={fields} dateLabel="PO date" />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={PauseCircle} title={filters.activeCount > 0 ? "Nothing matches these filters" : "No approved PO yet"} hint="Every product of every approved PO shows here, with its status." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2.5">PO Number</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">PO date</th>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="px-3 py-2.5">Product</th>
                  <th className="px-3 py-2.5">Qty</th>
                  <th className="px-3 py-2.5">Plant</th>
                  <th className="px-3 py-2.5 text-right">Ask PPIC</th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r) => {
                  const { item } = r;
                  const st = statusOf(item);
                  const open = item.changeRequests?.[0];
                  const batchMade = !!item.productionStage && BATCH_MADE.includes(item.productionStage);
                  return (
                    <tr key={item.id} className="border-b border-slate-50">
                      <td className="px-3 py-2.5 font-bold text-slate-700">
                        <Link to={`/purchase-orders/${r.po.id}`} className="hover:text-brand-600 hover:underline">
                          {r.po.poNumber ?? r.po.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`pill ${st.tone}`}>{st.label}</span>
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">{day(r.po.orderDate ?? r.po.createdAt)}</td>
                      <td className="px-3 py-2.5 text-slate-600">
                        <CustomerName name={r.po.customer.companyName} />
                      </td>
                      <td className="px-3 py-2.5 font-bold text-slate-800">{item.productName}</td>
                      <td className="px-3 py-2.5 text-slate-600">
                        {item.quantity} {item.unit}
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">{item.plannedPlant?.name ?? "-"}</td>
                      <td className="px-3 py-2.5 text-right">
                        {item.cancelledAt ? (
                          <span className="text-slate-400">-</span>
                        ) : open ? (
                          <span className="pill border-amber-200 bg-amber-50 text-amber-700" title={`Your reason: ${open.reason}`}>
                            {open.kind === "HOLD" ? "Hold" : "Cancel"} requested: waiting for PPIC
                          </span>
                        ) : batchMade ? (
                          <span className="text-slate-400" title="Production has already made a batch, so it can't be held or cancelled any more">
                            Batch made
                          </span>
                        ) : (
                          <div className="inline-flex gap-1.5">
                            {!item.materialHeldAt && (
                              <button type="button" className="btn-ghost btn-sm" title="Ask PPIC to put this product on hold" onClick={() => setAsking({ row: r, kind: "HOLD" })}>
                                Hold
                              </button>
                            )}
                            <button type="button" className="btn-ghost btn-sm text-rose-600" title="Ask PPIC to cancel this product" onClick={() => setAsking({ row: r, kind: "CANCEL" })}>
                              Cancel
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ClientPager pg={pg} />
        </div>
      )}

      <ConfirmDialog
        open={asking !== null}
        tone={asking?.kind === "CANCEL" ? "danger" : "brand"}
        title={asking?.kind === "CANCEL" ? "Ask PPIC to cancel this product?" : "Ask PPIC to put this product on hold?"}
        message={
          asking && (
            <>
              <b>
                {asking.row.item.productName} ({asking.row.po.poNumber ?? "PO"})
              </b>{" "}
              - PPIC gets your request and decides. You are told either way. {asking.kind === "CANCEL" ? "A cancelled product is closed for good." : "Production will not start or go on with it while it is on hold."}
            </>
          )
        }
        requireReason
        confirmLabel="Send request"
        cancelLabel="Not now"
        busy={create.isPending}
        onConfirm={(reason) => void send(reason ?? "")}
        onCancel={() => setAsking(null)}
      />
    </div>
  );
}
