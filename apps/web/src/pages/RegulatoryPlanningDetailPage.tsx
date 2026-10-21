import { Fragment, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, Check, Download, ExternalLink, ListChecks, Pencil, ShieldCheck, X } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { usePurchaseOrders, useRegulatoryReview, useSetRegulatoryBody } from "../lib/hooks";
import { getRegulatoryPlanningRows, REGULATORY_PLANNING_METRIC_LABEL, type RegulatoryPlanningMetric } from "../lib/regulatoryPlanning";
import type { PpicPlanningItemRow } from "../lib/ppicPlanning";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { AgingCell, agingDays, inAgingBuckets } from "../components/AgingCell";
import { RowActionMenu } from "../components/RowActionMenu";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";
import { CustomerName } from "../components/CustomerName";
import { PlanFromPpic } from "../components/PlanFromPpic";
import { customerTypeLabel } from "../lib/customerTags";

const VALID_METRICS = new Set(Object.keys(REGULATORY_PLANNING_METRIC_LABEL));

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-");
const reviewLabel = (s: string | null | undefined) => s ?? "Pending Review";
const STATUS_PILL: Record<string, string> = {
  Approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
  "Not Approved": "border-rose-200 bg-rose-50 text-rose-700",
};
const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

// The drill-down behind every Regulatory dashboard tile: the product lines behind that number, with every detail on the row, the filters the
// other departments have, and the actions right here (Approve, Not Approved with a reason, set the body / status, open the PO).
export function RegulatoryPlanningDetailPage() {
  const { metric } = useParams<{ metric: string }>();
  const { data: orders, isLoading } = usePurchaseOrders();

  if (!metric || !VALID_METRICS.has(metric)) {
    return <EmptyState icon={ShieldCheck} title="Unknown report" hint="That tile does not exist." accent="rose" />;
  }
  const m = metric as RegulatoryPlanningMetric;
  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>
      {isLoading || !orders ? <div className="skeleton h-64 w-full" /> : <RegulatoryList key={m} metric={m} orders={orders} />}
    </div>
  );
}

type Mode = "APPROVE" | "NOT_APPROVE" | "BODY" | "PLAN";

function RegulatoryList({ metric, orders }: { metric: RegulatoryPlanningMetric; orders: NonNullable<ReturnType<typeof usePurchaseOrders>["data"]> }) {
  const { hasRole } = useAuth();
  const canAct = hasRole("REGULATORY", "ADMIN");
  const label = REGULATORY_PLANNING_METRIC_LABEL[metric];
  const filters = useTileFilters();
  const [open, setOpen] = useState<{ id: string; mode: Mode } | null>(null);
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const everyRow = useMemo(() => getRegulatoryPlanningRows(metric, orders), [metric, orders]);
  const since = (r: PpicPlanningItemRow) => (r.item.regulatoryStatus ? r.item.regulatoryReviewedAt : r.item.sentToRegulatoryAt) ?? null;

  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct(everyRow.map((r) => r.po.poNumber)) },
    { key: "customer", label: "Customer", options: distinct(everyRow.map((r) => r.po.customer.companyName)) },
    { key: "category", label: "Product Category", options: distinct(everyRow.map((r) => r.item.productCategory)) },
    { key: "product", label: "Product", options: distinct(everyRow.map((r) => r.item.productName)) },
    { key: "body", label: "Regulatory Body", options: distinct(everyRow.map((r) => r.po.regulatoryBody)) },
    { key: "bodyStatus", label: "Body Status", options: distinct(everyRow.map((r) => r.po.regulatoryStatus)) },
    { key: "plant", label: "Plant", options: distinct(everyRow.map((r) => r.item.plannedPlant?.name)) },
    AGING_FIELD,
  ];

  const rows = useMemo(() => {
    const { dateFrom, dateTo } = filters.applied;
    return everyRow
      .filter((r) => {
        const sent = (r.item.sentToRegulatoryAt ?? "").slice(0, 10);
        return (
          (!picked("po").length || picked("po").includes(r.po.poNumber ?? "")) &&
          (!picked("customer").length || picked("customer").includes(r.po.customer.companyName)) &&
          (!picked("category").length || picked("category").includes(r.item.productCategory ?? "")) &&
          (!picked("product").length || picked("product").includes(r.item.productName)) &&
          (!picked("body").length || picked("body").includes(r.po.regulatoryBody ?? "")) &&
          (!picked("bodyStatus").length || picked("bodyStatus").includes(r.po.regulatoryStatus ?? "")) &&
          (!picked("plant").length || picked("plant").includes(r.item.plannedPlant?.name ?? "")) &&
          inAgingBuckets(agingDays(since(r)), picked("aging")) &&
          (!dateFrom || (!!sent && sent >= dateFrom)) &&
          (!dateTo || (!!sent && sent <= dateTo))
        );
      })
      .sort((a, b) => (a.po.poNumber ?? "").localeCompare(b.po.poNumber ?? "", undefined, { numeric: true }) || a.item.productName.localeCompare(b.item.productName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyRow, filters.applied]);

  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;

  function download() {
    const lines = rows.map((r) => ({
      "PO Number": r.po.poNumber ?? "",
      "Body Status": r.po.regulatoryStatus ?? "",
      "Review Status": reviewLabel(r.item.regulatoryStatus),
      Customer: r.po.customer.companyName,
      "Customer Type": customerTypeLabel(r.po.customer.companyName),
      Category: r.item.productCategory ?? "",
      Product: r.item.productName,
      Qty: r.item.quantity,
      Unit: r.item.unit,
      Plant: r.item.plannedPlant?.name ?? "",
      "PO Date": day(r.po.orderDate),
      "PO Delivery Date": day(r.po.expectedDeliveryDate),
      "Regulatory Body": r.po.regulatoryBody ?? "",
      "Sent to Regulatory": day(r.item.sentToRegulatoryAt),
      "Reviewed On": day(r.item.regulatoryReviewedAt),
      Remarks: r.item.regulatoryRemarks ?? "",
      "Waiting (days)": agingDays(since(r)) ?? "",
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, label, `FLS Regulatory: ${label}`, describeFilters(filters, fields, "Sent to Regulatory"), lines);
    XLSX.writeFile(wb, stampedName(`FLS_Regulatory_${metric.replace(/-/g, "_")}`));
  }

  const colCount = 17;

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-indigo-500/10 text-indigo-600">
            <ShieldCheck className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{label}</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} product{rows.length === 1 ? "" : "s"}
              {isFiltered ? ` (of ${everyRow.length})` : ""}
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm shrink-0" onClick={download} disabled={rows.length === 0}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey={`regulatory-${metric}`} fields={fields} dateLabel="Sent to Regulatory" />

      {rows.length === 0 ? (
        <EmptyState icon={ShieldCheck} title={isFiltered ? "Nothing matches these filters" : "Nothing here"} hint="No records match this tile right now." accent="brand" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2.5">PO</th>
                  <th className="px-3 py-2.5">Body status</th>
                  <th className="px-3 py-2.5">Review status</th>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="px-3 py-2.5">Category</th>
                  <th className="px-3 py-2.5">Product</th>
                  <th className="px-3 py-2.5 text-right">Quantity</th>
                  <th className="px-3 py-2.5">Plant</th>
                  <th className="px-3 py-2.5">PO date</th>
                  <th className="px-3 py-2.5">Delivery</th>
                  <th className="px-3 py-2.5">Reg. body</th>
                  <th className="px-3 py-2.5">Sent to Regulatory</th>
                  <th className="px-3 py-2.5">Reviewed on</th>
                  <th className="px-3 py-2.5">Remarks</th>
                  <th className="px-3 py-2.5">Waiting</th>
                  <th className="sticky right-0 bg-white px-3 py-2.5 text-right shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.15)]">Action</th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r, i) => {
                  const isOpen = open?.id === r.item.id;
                  const newPo = i > 0 && pg.rows[i - 1]!.po.id !== r.po.id;
                  return (
                    <Fragment key={r.item.id}>
                      <tr className={`border-b border-slate-50 ${newPo ? "border-t-2 border-t-slate-200" : ""}`}>
                        <td className="px-3 py-2.5 font-mono font-bold text-slate-700">
                          <Link to={`/po-review/${r.po.id}`} className="hover:text-brand-600 hover:underline">{r.po.poNumber ?? r.po.id.slice(0, 8)}</Link>
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">{r.po.regulatoryStatus ?? "-"}</td>
                        <td className="px-3 py-2.5">
                          <span className={`pill ${STATUS_PILL[r.item.regulatoryStatus ?? ""] ?? "border-amber-200 bg-amber-50 text-amber-700"}`}>{reviewLabel(r.item.regulatoryStatus)}</span>
                        </td>
                        <td className="px-3 py-2.5 text-slate-600"><CustomerName name={r.po.customer.companyName} /></td>
                        <td className="px-3 py-2.5 text-slate-600">{r.item.productCategory ?? "-"}</td>
                        <td className="px-3 py-2.5 font-bold text-slate-800">{r.item.productName}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-slate-700">{fmtQty(r.item.quantity)} {r.item.unit}</td>
                        <td className="px-3 py-2.5 text-slate-600">{r.item.plannedPlant?.name ?? "-"}</td>
                        <td className="px-3 py-2.5 text-slate-600">{day(r.po.orderDate)}</td>
                        <td className="px-3 py-2.5 text-slate-600">{day(r.po.expectedDeliveryDate)}</td>
                        <td className="px-3 py-2.5 text-slate-600">{r.po.regulatoryBody ?? "-"}</td>
                        <td className="px-3 py-2.5 text-slate-600">{day(r.item.sentToRegulatoryAt)}</td>
                        <td className="px-3 py-2.5 text-slate-600">{day(r.item.regulatoryReviewedAt)}</td>
                        <td className="max-w-[16rem] truncate px-3 py-2.5 text-slate-600" title={r.item.regulatoryRemarks ?? ""}>{r.item.regulatoryRemarks ?? "-"}</td>
                        <td className="px-3 py-2.5"><AgingCell since={since(r)} /></td>
                        <td className="sticky right-0 bg-white px-3 py-2.5 text-right shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.15)]">
                          <RowActionMenu
                            actions={[
                              { label: "View plan (materials)", icon: <ListChecks className="h-3.5 w-3.5" strokeWidth={2.5} />, onClick: () => setOpen({ id: r.item.id, mode: "PLAN" }) },
                              { label: "Approve", icon: <Check className="h-3.5 w-3.5" strokeWidth={2.5} />, tone: "text-emerald-700", hidden: !canAct || r.item.regulatoryStatus === "Approved", onClick: () => setOpen({ id: r.item.id, mode: "APPROVE" }) },
                              { label: "Mark Not Approved", icon: <X className="h-3.5 w-3.5" strokeWidth={2.5} />, tone: "text-rose-600", hidden: !canAct || r.item.regulatoryStatus === "Not Approved", onClick: () => setOpen({ id: r.item.id, mode: "NOT_APPROVE" }) },
                              { label: "Edit regulatory body / status", icon: <Pencil className="h-3.5 w-3.5" strokeWidth={2.5} />, hidden: !canAct, onClick: () => setOpen({ id: r.item.id, mode: "BODY" }) },
                              { label: "Open PO", icon: <ExternalLink className="h-3.5 w-3.5" strokeWidth={2.5} />, to: `/po-review/${r.po.id}` },
                            ]}
                          />
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-slate-100">
                          <td colSpan={colCount} className="whitespace-normal bg-slate-50/70 px-4 py-4">
                            <div className="sticky left-4 max-w-[min(100%,60rem)] space-y-3">
                              {/* The plan's materials, so the reviewer sees what the product needs while deciding (not for the PO-level body edit) */}
                              {open!.mode !== "BODY" && (
                                <div className="space-y-2">
                                  <div className="flex items-center justify-between">
                                    <p className="text-xs font-bold text-slate-700">Plan: {r.item.productName} ({r.po.poNumber ?? "PO"}) · {fmtQty(r.item.quantity)} {r.item.unit}</p>
                                    {open!.mode === "PLAN" && (
                                      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(null)}>
                                        Close
                                      </button>
                                    )}
                                  </div>
                                  <PlanFromPpic poId={r.po.id} itemId={r.item.id} forRegulatory />
                                </div>
                              )}
                              {open!.mode !== "PLAN" && canAct && <ActionForm row={r} mode={open!.mode} onDone={() => setOpen(null)} />}
                            </div>
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
    </>
  );
}

const BODY_OPTIONS = ["FSSAI", "AYUSH"];
const BODY_STATUS_OPTIONS = ["Applied", "Not Applied", "Issued"];

function ActionForm({ row, mode, onDone }: { row: PpicPlanningItemRow; mode: Mode; onDone: () => void }) {
  const toast = useToast();
  const review = useRegulatoryReview(row.po.id);
  const setBody = useSetRegulatoryBody(row.po.id);
  const [remarks, setRemarks] = useState(row.item.regulatoryRemarks ?? "");
  const [body, setBodyValue] = useState(row.po.regulatoryBody ?? "");
  const [bodyStatus, setBodyStatus] = useState(row.po.regulatoryStatus ?? "");
  const [error, setError] = useState<string | null>(null);
  const busy = review.isPending || setBody.isPending;

  async function submit() {
    setError(null);
    try {
      if (mode === "BODY") {
        await setBody.mutateAsync({ regulatoryBody: body || undefined, regulatoryStatus: bodyStatus || undefined });
        toast.success("Regulatory body / status updated.");
      } else if (mode === "APPROVE") {
        await review.mutateAsync({ itemId: row.item.id, status: "Approved", remarks: remarks.trim() || undefined });
        toast.success(`Approved: ${row.item.productName}. PPIC can now send the plan to Production.`);
      } else {
        if (!remarks.trim()) return setError("Write why this product is not approved.");
        await review.mutateAsync({ itemId: row.item.id, status: "Not Approved", remarks: remarks.trim() });
        toast.success(`Marked Not Approved: ${row.item.productName}.`);
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-bold text-slate-700">
        {mode === "APPROVE" ? "Approve" : mode === "NOT_APPROVE" ? "Mark Not Approved" : "Edit regulatory body / status"}: {row.item.productName} ({row.po.poNumber ?? "PO"})
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        {mode === "BODY" ? (
          <>
            <div>
              <label className="mb-0.5 block text-micro text-slate-400">Regulatory body</label>
              <select className="field !py-1.5 text-xs" value={body} onChange={(e) => setBodyValue(e.target.value)}>
                <option value="">- choose -</option>
                {[...new Set([...BODY_OPTIONS, ...(body ? [body] : [])])].map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-0.5 block text-micro text-slate-400">Status</label>
              <select className="field !py-1.5 text-xs" value={bodyStatus} onChange={(e) => setBodyStatus(e.target.value)}>
                <option value="">- choose -</option>
                {BODY_STATUS_OPTIONS.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </div>
            <p className="self-end text-micro text-slate-400 sm:col-span-1">This is for the whole PO, not just this product.</p>
          </>
        ) : (
          <div className="sm:col-span-3">
            <label className="mb-0.5 block text-micro text-slate-400">{mode === "NOT_APPROVE" ? "Reason (required)" : "Remarks (optional)"}</label>
            <input className="field !py-1.5 text-xs" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={mode === "NOT_APPROVE" ? "Why is it not approved?" : "Anything to note"} />
          </div>
        )}
        <div className="flex items-end sm:col-start-4">
          <button type="button" className={`${mode === "NOT_APPROVE" ? "btn-danger" : "btn-primary"} btn-sm w-full`} disabled={busy} onClick={submit}>
            {busy ? "Saving..." : mode === "APPROVE" ? "Confirm approve" : mode === "NOT_APPROVE" ? "Confirm not approved" : "Save"}
          </button>
        </div>
      </div>
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
    </div>
  );
}
