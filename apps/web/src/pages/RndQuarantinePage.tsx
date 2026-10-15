import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ChevronDown, Download, PackageOpen, ShieldAlert } from "lucide-react";
import { useQcReviewTransaction, useReleaseExpiry, useRndQuarantine, type RndQuarantineReason, type RndQuarantineRow } from "../lib/hooks";
import { ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { inAgingBuckets } from "../components/AgingCell";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";

const REASON_LABEL: Record<RndQuarantineReason, string> = { PENDING_QC: "Not approved yet", TESTING: "Testing", ON_HOLD: "Hold", REJECTED: "Rejected", EXPIRED: "Expired" };
const REASON_PILL: Record<RndQuarantineReason, string> = {
  PENDING_QC: "border-slate-200 bg-slate-50 text-slate-600",
  TESTING: "border-sky-200 bg-sky-50 text-sky-700",
  ON_HOLD: "border-amber-200 bg-amber-50 text-amber-700",
  REJECTED: "border-rose-200 bg-rose-50 text-rose-700",
  EXPIRED: "border-orange-200 bg-orange-50 text-orange-700",
};
const CATEGORY_LABEL = { RM: "Raw Material", PM: "Packaging Material" } as const;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const DAY = 86_400_000;

// Aging: how long it has been in quarantine - since it was received (not approved / rejected) or since it passed its expiry date.
function agingOf(r: RndQuarantineRow): number {
  const start = r.reason === "EXPIRED" && r.expiryDate ? new Date(r.expiryDate).getTime() : new Date(r.receivedAt).getTime();
  return Math.max(0, Math.floor((Date.now() - start) / DAY));
}
const expiryBucket = (r: RndQuarantineRow) => {
  if (!r.expiryDate) return "No expiry date";
  const left = Math.ceil((new Date(r.expiryDate).getTime() - Date.now()) / DAY);
  return left < 0 ? "Expired" : left <= 30 ? "Expires within 30 days" : "Expires later";
};

// R&D's sixth tile: everything the Warehouse received that is not usable stock - not approved yet (pending, testing, hold), rejected, or
// expired. R&D decides on the open ones: Approve (the row leaves this list), Reject, Hold or mark Testing. Rejected is final.
export function RndQuarantinePage() {
  const { data, isLoading } = useRndQuarantine();
  const toast = useToast();
  const review = useQcReviewTransaction();
  const release = useReleaseExpiry();
  const filters = useTileFilters();
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ samplingDate: "", status: "APPROVE" as "TEST" | "HOLD" | "APPROVE" | "REJECT", note: "" });
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const all = data ?? [];
  const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const fields: FilterField[] = [
    { key: "vendor", label: "Vendor", options: distinct(all.map((r) => r.vendorName)) },
    { key: "material", label: "Material", options: distinct(all.map((r) => r.itemName)) },
    { key: "category", label: "Category", options: ["Raw Material", "Packaging Material"] },
    { key: "reason", label: "Why in quarantine", options: Object.values(REASON_LABEL) },
    { key: "expiry", label: "Expiry", options: ["Expired", "Expires within 30 days", "Expires later", "No expiry date"] },
    { key: "sampled", label: "Sampling", options: ["Sampled", "Not sampled yet"] },
    { key: "batch", label: "Batch No", options: distinct(all.map((r) => r.batchNo)) },
    { key: "grn", label: "GRN No", options: distinct(all.map((r) => r.grnNo)) },
    AGING_FIELD,
  ];
  const from = filters.applied.dateFrom;
  const to = filters.applied.dateTo;
  const rows = all.filter(
    (r) =>
      (!picked("vendor").length || picked("vendor").includes(r.vendorName ?? "")) &&
      (!picked("material").length || picked("material").includes(r.itemName)) &&
      (!picked("category").length || picked("category").includes(CATEGORY_LABEL[r.category])) &&
      (!picked("reason").length || picked("reason").includes(REASON_LABEL[r.reason])) &&
      (!picked("expiry").length || picked("expiry").includes(expiryBucket(r))) &&
      (!picked("sampled").length || picked("sampled").includes(r.samplingDate ? "Sampled" : "Not sampled yet")) &&
      (!picked("batch").length || picked("batch").includes(r.batchNo ?? "")) &&
      (!picked("grn").length || picked("grn").includes(r.grnNo ?? "")) &&
      (!from || r.receivedAt.slice(0, 10) >= from) &&
      (!to || r.receivedAt.slice(0, 10) <= to) &&
      inAgingBuckets(agingOf(r), picked("aging")),
  );
  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;
  const count = (s: RndQuarantineReason) => all.filter((r) => r.reason === s).length;

  function startUpdate(r: RndQuarantineRow) {
    if (openId === r.id) return setOpenId(null);
    setOpenId(r.id);
    setDraft({ samplingDate: r.samplingDate ? r.samplingDate.slice(0, 10) : "", status: "APPROVE", note: "" });
  }

  async function save(r: RndQuarantineRow) {
    if (!draft.samplingDate) return toast.error("Enter the sampling date first.");
    if ((draft.status === "HOLD" || draft.status === "REJECT") && !draft.note.trim()) return toast.error("A note is required for Hold and Rejected.");
    try {
      await review.mutateAsync({ id: r.id, action: draft.status, samplingDate: draft.samplingDate, note: draft.note.trim() || undefined });
      toast.success(draft.status === "APPROVE" ? "Approved. It is out of quarantine and in stock." : draft.status === "TEST" ? "Marked as Testing." : draft.status === "HOLD" ? "Put on hold." : "Rejected.");
      setOpenId(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function releaseExpired(r: RndQuarantineRow) {
    if (!window.confirm(`Approve ${r.itemName} (expired ${day(r.expiryDate)}) after the lab test and release it back into stock?`)) return;
    try {
      await release.mutateAsync(r.id);
      toast.success("Approved. It is out of quarantine and back in stock.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not release");
    }
  }

  function download() {
    const lines = rows.map((r) => ({
      Vendor: r.vendorName ?? "",
      Material: r.itemName,
      Category: CATEGORY_LABEL[r.category],
      Quantity: r.quantity,
      "Rejected Qty": r.rejectedQty ?? "",
      Unit: r.unit,
      "Batch No": r.batchNo ?? "",
      "GRN No": r.grnNo ?? "",
      "Invoice No": r.invoiceNo ?? "",
      "Received On": day(r.receivedAt),
      "Sampling Date": r.samplingDate ? day(r.samplingDate) : "",
      "Expiry Date": r.expiryDate ? day(r.expiryDate) : "",
      "Why In Quarantine": REASON_LABEL[r.reason],
      "Aging (Days)": agingOf(r),
      Note: r.note ?? "",
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Quarantine", "FLS R&D - Quarantine", describeFilters(filters, fields, "Received"), lines, { totals: ["Quantity", "Rejected Qty"] });
    XLSX.writeFile(wb, stampedName("FLS_RnD_Quarantine"));
  }

  const chip = (s: RndQuarantineReason) => (
    <button
      key={s}
      type="button"
      onClick={() => filters.applyPick("reason", picked("reason").includes(REASON_LABEL[s]) ? [] : [REASON_LABEL[s]])}
      className={`pill cursor-pointer ${REASON_PILL[s]} ${picked("reason").includes(REASON_LABEL[s]) ? "ring-2 ring-brand-300" : ""}`}
    >
      {REASON_LABEL[s]} · {count(s)}
    </button>
  );

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-rose-500/10 text-rose-600">
            <ShieldAlert className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Quarantine</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} item{rows.length === 1 ? "" : "s"}
              {isFiltered ? ` of ${all.length}` : ""} that are not usable stock: not approved yet, rejected or expired. Approve one and it leaves this list.
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">{(["PENDING_QC", "TESTING", "ON_HOLD", "REJECTED", "EXPIRED"] as RndQuarantineReason[]).map(chip)}</div>

      <TileFilterBar filters={filters} tileKey="rnd-quarantine" fields={fields} dateLabel="Received" />

      {isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "Nothing in quarantine"} hint={isFiltered ? "Nothing matches these filters." : "All received material is approved and in date."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Material</th>
                <th className="px-4 py-3 text-right">Quantity</th>
                <th className="px-4 py-3">Received</th>
                <th className="px-4 py-3">Sampling date</th>
                <th className="px-4 py-3">Expiry</th>
                <th className="px-4 py-3">Why</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((r) => {
                const open = openId === r.id;
                const days = agingOf(r);
                const expired = !!r.expiryDate && new Date(r.expiryDate).getTime() < Date.now();
                return (
                  <Fragment key={r.id}>
                    <tr className={`transition hover:bg-slate-50 ${open ? "bg-slate-50/70" : ""}`}>
                      <td className="px-4 py-3 font-semibold text-slate-700">{r.vendorName ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span className="font-bold text-slate-800">{r.itemName}</span>
                        <span className={`pill ml-2 text-micro ${r.category === "RM" ? "border-violet-200 bg-violet-50 text-violet-700" : "border-sky-200 bg-sky-50 text-sky-700"}`}>{r.category}</span>
                        {(r.batchNo || r.grnNo) && <span className="block text-micro text-slate-400">{[r.batchNo && `Batch ${r.batchNo}`, r.grnNo && `GRN ${r.grnNo}`].filter(Boolean).join(" · ")}</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-800">
                        {fmtQty(r.quantity)} {r.unit}
                        {!!r.rejectedQty && <span className="block font-sans text-micro font-bold text-rose-600">{fmtQty(r.rejectedQty)} rejected</span>}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{day(r.receivedAt)}</td>
                      <td className="px-4 py-3">{r.samplingDate ? <span className="font-semibold text-slate-700">{day(r.samplingDate)}</span> : <span className="text-tiny font-bold text-amber-600">Not sampled yet</span>}</td>
                      <td className={`px-4 py-3 ${expired ? "font-bold text-orange-700" : "text-slate-600"}`}>{day(r.expiryDate)}</td>
                      <td className="px-4 py-3">
                        <span className={`pill ${REASON_PILL[r.reason]}`} title={r.note ?? undefined}>
                          {REASON_LABEL[r.reason]}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`pill ${days > 7 ? "border-rose-200 bg-rose-50 text-rose-700" : days > 3 ? "border-amber-200 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>{days}d</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {r.reason === "EXPIRED" ? (
                          <button type="button" className="btn-primary btn-sm" disabled={release.isPending} onClick={() => void releaseExpired(r)} title="Approve it after the lab test: it goes back into stock">
                            Approve
                          </button>
                        ) : r.reason === "REJECTED" ? (
                          <span className="text-tiny text-slate-300">Final</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => startUpdate(r)}
                            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-tiny font-bold transition ${open ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                          >
                            Update <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                          </button>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={9} className="px-4 py-4">
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                            <div>
                              <label className="label">Sampling date <span className="text-rose-500">*</span></label>
                              <input className="field !py-1.5 !text-xs" type="date" value={draft.samplingDate} onChange={(e) => setDraft((d) => ({ ...d, samplingDate: e.target.value }))} />
                            </div>
                            <div>
                              <label className="label">Decision</label>
                              <select className="field !py-1.5 !text-xs" value={draft.status} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value as typeof draft.status }))}>
                                <option value="APPROVE">Approve</option>
                                <option value="HOLD">Hold</option>
                                <option value="REJECT">Reject</option>
                                <option value="TEST">Testing</option>
                              </select>
                            </div>
                            <div className="sm:col-span-2">
                              <label className="label">Note {draft.status === "HOLD" || draft.status === "REJECT" ? <span className="text-rose-500">*</span> : <span className="font-normal normal-case text-slate-400">(optional)</span>}</label>
                              <input className="field !py-1.5 !text-xs" value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} placeholder={draft.status === "HOLD" ? "Why is it on hold?" : draft.status === "REJECT" ? "Why is it rejected?" : ""} />
                            </div>
                          </div>
                          <div className="mt-3 flex items-center justify-between gap-3">
                            <p className="text-micro text-slate-400">Approve puts it into stock and it leaves this list. Reject is final.</p>
                            <button type="button" className="btn-primary btn-sm" disabled={review.isPending} onClick={() => void save(r)}>
                              {review.isPending ? "Saving…" : "Save"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <ClientPager pg={pg} />
        </div>
      )}
    </div>
  );
}
