import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ChevronDown, Download, FlaskConical, PackageOpen } from "lucide-react";
import { useNewMaterial, useQcReviewTransaction, type NewMaterialRow, type NewMaterialStatus } from "../lib/hooks";
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

// Display statuses: Pending, Testing, Hold, Approved, Rejected (an old "QC approved, not yet accepted" row counts as Approved).
type Shown = "PENDING" | "TESTING" | "HOLD" | "APPROVED" | "REJECTED";
const shownOf = (s: NewMaterialStatus): Shown => (s === "PENDING_QC" ? "PENDING" : s === "TESTING" ? "TESTING" : s === "ON_HOLD" ? "HOLD" : s === "QC_REJECTED" ? "REJECTED" : "APPROVED");
const SHOWN_LABEL: Record<Shown, string> = { PENDING: "Pending", TESTING: "Testing", HOLD: "Hold", APPROVED: "Approved", REJECTED: "Rejected" };
const SHOWN_PILL: Record<Shown, string> = {
  PENDING: "border-slate-200 bg-slate-50 text-slate-600",
  TESTING: "border-sky-200 bg-sky-50 text-sky-700",
  HOLD: "border-amber-200 bg-amber-50 text-amber-700",
  APPROVED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  REJECTED: "border-rose-200 bg-rose-50 text-rose-700",
};
const isOpen = (s: NewMaterialStatus) => s === "PENDING_QC" || s === "TESTING" || s === "ON_HOLD";
const CATEGORY_LABEL = { RM: "Raw Material", PM: "Packaging Material" } as const;

const dayStr = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
// Aging: from the day the Warehouse received it to the day its status was set (Approved / Rejected), or to today while it is still open.
function agingOf(r: NewMaterialRow): number {
  const end = !isOpen(r.status) && r.statusAt ? new Date(r.statusAt).getTime() : Date.now();
  return Math.max(0, Math.floor((end - new Date(r.receivedAt).getTime()) / 86_400_000));
}
const agingTone = (days: number, open: boolean) => (!open ? "border-slate-200 bg-slate-50 text-slate-500" : days > 7 ? "border-rose-200 bg-rose-50 text-rose-700" : days > 3 ? "border-amber-200 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700");

// What the Warehouse received from vendors and where R&D stands on it: set the sampling date and the status (Testing, Hold, Approved,
// Rejected) right on the row. Approved puts it into stock; Hold and Rejected need a note.
export function NewMaterialPage() {
  const { data, isLoading } = useNewMaterial();
  const toast = useToast();
  const review = useQcReviewTransaction();
  const filters = useTileFilters();
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ samplingDate: "", status: "TEST" as "TEST" | "HOLD" | "APPROVE" | "REJECT", note: "" });
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const all = data ?? [];
  const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const fields: FilterField[] = [
    { key: "vendor", label: "Vendor", options: distinct(all.map((r) => r.vendorName)) },
    { key: "material", label: "Material", options: distinct(all.map((r) => r.itemName)) },
    { key: "category", label: "Category", options: ["Raw Material", "Packaging Material"] },
    { key: "status", label: "Status", options: Object.values(SHOWN_LABEL) },
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
      (!picked("status").length || picked("status").includes(SHOWN_LABEL[shownOf(r.status)])) &&
      (!picked("sampled").length || picked("sampled").includes(r.samplingDate ? "Sampled" : "Not sampled yet")) &&
      (!picked("batch").length || picked("batch").includes(r.batchNo ?? "")) &&
      (!picked("grn").length || picked("grn").includes(r.grnNo ?? "")) &&
      (!from || r.receivedAt.slice(0, 10) >= from) &&
      (!to || r.receivedAt.slice(0, 10) <= to) &&
      inAgingBuckets(agingOf(r), picked("aging")),
  );
  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;
  const count = (s: Shown) => all.filter((r) => shownOf(r.status) === s).length;

  function startUpdate(r: NewMaterialRow) {
    if (openId === r.id) return setOpenId(null);
    setOpenId(r.id);
    setDraft({ samplingDate: r.samplingDate ? r.samplingDate.slice(0, 10) : "", status: r.status === "TESTING" ? "APPROVE" : "TEST", note: "" });
  }

  async function save(r: NewMaterialRow) {
    if (!draft.samplingDate) return toast.error("Enter the sampling date first.");
    if ((draft.status === "HOLD" || draft.status === "REJECT") && !draft.note.trim()) return toast.error("A note is required for Hold and Rejected.");
    try {
      await review.mutateAsync({ id: r.id, action: draft.status, samplingDate: draft.samplingDate, note: draft.note.trim() || undefined });
      toast.success(draft.status === "TEST" ? "Marked as Testing." : draft.status === "APPROVE" ? "Approved. It is in stock now." : draft.status === "HOLD" ? "Put on hold." : "Rejected.");
      setOpenId(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  function download() {
    const lines = rows.map((r) => ({
      Vendor: r.vendorName ?? "",
      Status: SHOWN_LABEL[shownOf(r.status)],
      "Status Set On": r.statusAt && !isOpen(r.status) ? dayStr(r.statusAt) : "",
      Material: r.itemName,
      Category: CATEGORY_LABEL[r.category],
      Quantity: r.quantity,
      Unit: r.unit,
      "Batch No": r.batchNo ?? "",
      "GRN No": r.grnNo ?? "",
      "Invoice No": r.invoiceNo ?? "",
      "Received On": dayStr(r.receivedAt),
      "Sampling Date": r.samplingDate ? dayStr(r.samplingDate) : "",
      "Aging (Days)": agingOf(r),
      Note: r.note ?? "",
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "New Material", "FLS R&D - New Material (inward QC)", describeFilters(filters, fields, "Received"), lines, { totals: ["Quantity"] });
    XLSX.writeFile(wb, stampedName("FLS_New_Material"));
  }

  const chip = (s: Shown) => (
    <button
      key={s}
      type="button"
      onClick={() => filters.applyPick("status", picked("status").includes(SHOWN_LABEL[s]) ? [] : [SHOWN_LABEL[s]])}
      className={`pill cursor-pointer ${SHOWN_PILL[s]} ${picked("status").includes(SHOWN_LABEL[s]) ? "ring-2 ring-brand-300" : ""}`}
    >
      {SHOWN_LABEL[s]} · {count(s)}
    </button>
  );

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-violet-500/10 text-violet-600">
            <FlaskConical className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">New Material</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} receipt{rows.length === 1 ? "" : "s"}
              {isFiltered ? ` of ${all.length}` : ""} the Warehouse received from vendors. Set the sampling date and the status on each.
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">{(["PENDING", "TESTING", "HOLD", "APPROVED", "REJECTED"] as Shown[]).map(chip)}</div>

      <TileFilterBar filters={filters} tileKey="new-material" fields={fields} dateLabel="Received" />

      {isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "No new material"} hint={isFiltered ? "Nothing matches these filters." : "Material shows here as soon as the Warehouse receives it from a vendor."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Material</th>
                <th className="px-4 py-3 text-right">Quantity</th>
                <th className="px-4 py-3">Received</th>
                <th className="px-4 py-3">Sampling date</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((r) => {
                const shown = shownOf(r.status);
                const open = openId === r.id;
                const days = agingOf(r);
                return (
                  <Fragment key={r.id}>
                    <tr className={`transition hover:bg-slate-50 ${open ? "bg-slate-50/70" : ""}`}>
                      <td className="px-4 py-3 font-semibold text-slate-700">{r.vendorName ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span className={`pill ${SHOWN_PILL[shown]}`} title={r.note ?? undefined}>
                          {SHOWN_LABEL[shown]}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-bold text-slate-800">{r.itemName}</span>
                        <span className={`pill ml-2 text-micro ${r.category === "RM" ? "border-violet-200 bg-violet-50 text-violet-700" : "border-sky-200 bg-sky-50 text-sky-700"}`}>{r.category}</span>
                        {(r.batchNo || r.grnNo) && <span className="block text-micro text-slate-400">{[r.batchNo && `Batch ${r.batchNo}`, r.grnNo && `GRN ${r.grnNo}`].filter(Boolean).join(" · ")}</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-800">
                        {fmtQty(r.quantity)} {r.unit}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{dayStr(r.receivedAt)}</td>
                      <td className="px-4 py-3">{r.samplingDate ? <span className="font-semibold text-slate-700">{dayStr(r.samplingDate)}</span> : <span className="text-tiny font-bold text-amber-600">Not sampled yet</span>}</td>
                      <td className="px-4 py-3">
                        <span className={`pill ${agingTone(days, isOpen(r.status))}`} title={isOpen(r.status) ? "Days since it was received" : "Days from received to the status"}>
                          {days}d{isOpen(r.status) ? "" : " ✓"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {isOpen(r.status) ? (
                          <button
                            type="button"
                            onClick={() => startUpdate(r)}
                            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-tiny font-bold transition ${open ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                          >
                            Update <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                          </button>
                        ) : (
                          <span className="text-tiny text-slate-300">Done</span>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={8} className="px-4 py-4">
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                            <div>
                              <label className="label">Sampling date <span className="text-rose-500">*</span></label>
                              <input className="field !py-1.5 !text-xs" type="date" value={draft.samplingDate} onChange={(e) => setDraft((d) => ({ ...d, samplingDate: e.target.value }))} />
                            </div>
                            <div>
                              <label className="label">Status</label>
                              <select className="field !py-1.5 !text-xs" value={draft.status} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value as typeof draft.status }))}>
                                <option value="TEST">Testing</option>
                                <option value="HOLD">Hold</option>
                                <option value="APPROVE">Approved</option>
                                <option value="REJECT">Rejected</option>
                              </select>
                            </div>
                            <div className="sm:col-span-2">
                              <label className="label">Note {draft.status === "HOLD" || draft.status === "REJECT" ? <span className="text-rose-500">*</span> : <span className="font-normal normal-case text-slate-400">(optional)</span>}</label>
                              <input className="field !py-1.5 !text-xs" value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} placeholder={draft.status === "HOLD" ? "Why is it on hold?" : draft.status === "REJECT" ? "Why is it rejected?" : ""} />
                            </div>
                          </div>
                          <div className="mt-3 flex items-center justify-between gap-3">
                            <p className="text-micro text-slate-400">Approved puts the material into stock. A Rejected or Approved entry cannot be changed again.</p>
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
