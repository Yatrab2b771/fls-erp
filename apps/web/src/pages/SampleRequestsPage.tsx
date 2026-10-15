import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, Download, FlaskConical, Plus } from "lucide-react";
import { useAuth } from "../lib/auth";
import { FEEDBACK_LABEL, FEEDBACK_PILL, SAMPLE_STATUS_LABEL, SAMPLE_STATUS_ORDER, SAMPLE_STATUS_PILL, TEMPLATE_LABEL, sampleAgeing, sampleNo, useSampleRequests, type SampleStatus } from "../lib/sampleRequestHooks";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";

// Samples customers have asked for. BD raises them, R&D makes them: both open this same list from their own tile. Yellow columns are Sales',
// blue columns are R&D's, like the Sample Request Sheet.

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "-");
const dayYear = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "");
const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const AGEING_BUCKETS = ["0-3 days", "4-7 days", "8-14 days", "15+ days"];
const bucketOf = (d: number) => (d <= 3 ? "0-3 days" : d <= 7 ? "4-7 days" : d <= 14 ? "8-14 days" : "15+ days");

export function SampleRequestsPage() {
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const canCreate = hasRole("BD", "ADMIN");
  const { data, isLoading } = useSampleRequests();
  const filters = useTileFilters();
  const [quick, setQuick] = useState<SampleStatus | "ALL">("ALL");
  const every = data ?? [];
  const picked = (key: string) => filters.applied.picks[key] ?? [];

  const counts = useMemo(() => {
    const c = Object.fromEntries(SAMPLE_STATUS_ORDER.map((s) => [s, 0])) as Record<SampleStatus, number>;
    for (const r of every) c[r.status] += 1;
    return c;
  }, [every]);
  const awaitingFeedback = every.filter((r) => r.status === "DISPATCHED" && !r.feedback).length;

  const fields: FilterField[] = [
    { key: "status", label: "Status", options: SAMPLE_STATUS_ORDER.map((s) => SAMPLE_STATUS_LABEL[s]) },
    { key: "company", label: "Company", options: distinct(every.map((r) => r.customerName)) },
    { key: "template", label: "Dosage form", options: Object.values(TEMPLATE_LABEL) },
    { key: "poc", label: "POC", options: distinct(every.map((r) => r.pocName)) },
    { key: "prepared", label: "Prepared by", options: distinct(every.map((r) => r.preparedByName)) },
    { key: "feedback", label: "Feedback", options: [...Object.values(FEEDBACK_LABEL), "Awaited"] },
    { key: "ageing", label: "Ageing", options: AGEING_BUCKETS },
  ];

  const rows = useMemo(() => {
    const { dateFrom, dateTo } = filters.applied;
    return every.filter(
      (r) =>
        (quick === "ALL" || r.status === quick) &&
        (!picked("status").length || picked("status").includes(SAMPLE_STATUS_LABEL[r.status])) &&
        (!picked("company").length || picked("company").includes(r.customerName)) &&
        (!picked("template").length || picked("template").includes(TEMPLATE_LABEL[r.template])) &&
        (!picked("poc").length || picked("poc").includes(r.pocName)) &&
        (!picked("prepared").length || picked("prepared").includes(r.preparedByName ?? "")) &&
        (!picked("feedback").length || picked("feedback").includes(r.feedback ? FEEDBACK_LABEL[r.feedback] : r.status === "DISPATCHED" ? "Awaited" : "")) &&
        (!picked("ageing").length || picked("ageing").includes(bucketOf(sampleAgeing(r).days))) &&
        (!dateFrom || r.createdAt.slice(0, 10) >= dateFrom) &&
        (!dateTo || r.createdAt.slice(0, 10) <= dateTo),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [every, filters.applied, quick]);

  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0 || quick !== "ALL";

  function download() {
    const lines = rows.map((r) => ({
      "Request No.": sampleNo(r.requestNo),
      Status: SAMPLE_STATUS_LABEL[r.status],
      Round: r.round,
      "Ageing (days)": sampleAgeing(r).days,
      "Request Date": dayYear(r.createdAt),
      "POC Name": r.pocName,
      "Company Name": r.customerName,
      "Dosage Form": r.dosageForm ?? TEMPLATE_LABEL[r.template],
      Template: TEMPLATE_LABEL[r.template],
      Composition: r.composition,
      "Customer TAT": dayYear(r.neededBy),
      "Sample Quantity": r.quantity ?? "",
      Remarks: r.remarks ?? "",
      "Reference Sample": r.referenceSample ?? "",
      "Export / Domestic": r.exportDomestic ?? "",
      "Label Claim": r.labelClaim ?? "",
      "Client Feedback": r.feedback ? FEEDBACK_LABEL[r.feedback] : "",
      "Customer Remark": r.clientFeedback ?? "",
      "Internal Remark": r.internalRemark ?? "",
      "Sample Code": r.sampleCode ?? "",
      "Sample Prepared By": r.preparedByName ?? "",
      "Expected Date": dayYear(r.expectedDate),
      "Date of Sample Preparing": dayYear(r.preparedOn),
      "R&D Remarks": r.rdRemarks ?? "",
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Sample Requests", "FLS: Sample Requests", describeFilters(filters, fields, "Requested"), lines);
    XLSX.writeFile(wb, stampedName("FLS_Sample_Requests"));
  }

  const tile = (key: SampleStatus | "ALL", label: string, value: number, hint: string, tone: string) => (
    <button key={key} type="button" aria-pressed={quick === key} onClick={() => setQuick(quick === key ? "ALL" : key)} className={`rounded-2xl border px-3.5 py-3 text-left transition ${quick === key ? "border-brand-500 bg-brand-50 ring-2 ring-brand-200" : "border-slate-200 bg-white hover:border-slate-300"}`}>
      <p className={`text-micro font-black uppercase tracking-wider ${tone}`}>{label}</p>
      <p className="mt-1 text-2xl font-black leading-none text-slate-900">{value}</p>
      <p className="mt-1 text-micro text-slate-400">{hint}</p>
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
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Sample Request</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} request{rows.length === 1 ? "" : "s"}
              {isFiltered ? ` (of ${every.length})` : ""}. Samples customers have asked for: BD raises them, R&amp;D makes them.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost btn-sm" disabled={rows.length === 0} onClick={download}>
            <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
          </button>
          {canCreate && (
            <Link to="/sample-requests/new" className="btn-primary btn-sm">
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> New request
            </Link>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {tile("REQUESTED", "New", counts.REQUESTED, "R&D has not picked up", "text-orange-700")}
        {tile("PLANNING", "Planning", counts.PLANNING, "ETA given", "text-sky-700")}
        {tile("IN_PROCESS", "In process", counts.IN_PROCESS, "being made", "text-amber-700")}
        {tile("READY", "Ready", counts.READY, "to be handed over", "text-emerald-700")}
        {tile("DISPATCHED", "Dispatched", counts.DISPATCHED, `feedback awaited: ${awaitingFeedback}`, "text-cyan-700")}
        {tile("ON_HOLD", "Hold", counts.ON_HOLD, "reason in R&D remarks", "text-slate-600")}
      </div>

      <TileFilterBar filters={filters} tileKey="sample-requests" fields={fields} dateLabel="Requested" />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={FlaskConical} title={isFiltered ? "Nothing matches these filters" : "No sample request yet"} hint={canCreate ? "Press “New request” when a customer asks for a sample, or open a lead whose status is Sampling." : "BD raises a request when a customer asks for a sample."} />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="text-left text-micro font-black uppercase tracking-wide">
                  <th colSpan={3} className="bg-amber-100 px-3 py-1.5 text-amber-900">
                    Status
                  </th>
                  <th colSpan={7} className="bg-yellow-100 px-3 py-1.5 text-yellow-900">
                    Business Development part · Sales fills
                  </th>
                  <th colSpan={5} className="bg-blue-100 px-3 py-1.5 text-blue-900">
                    Formulation and Development part · R&amp;D fills
                  </th>
                </tr>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2.5">No.</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Ageing</th>
                  <th className="px-3 py-2.5">Request date</th>
                  <th className="px-3 py-2.5">Company · POC</th>
                  <th className="px-3 py-2.5">Composition</th>
                  <th className="px-3 py-2.5">Customer TAT</th>
                  <th className="px-3 py-2.5">Dosage form</th>
                  <th className="px-3 py-2.5">Sample qty</th>
                  <th className="px-3 py-2.5">Client feedback</th>
                  <th className="px-3 py-2.5">Sample code</th>
                  <th className="px-3 py-2.5">Prepared by</th>
                  <th className="px-3 py-2.5">Expected date</th>
                  <th className="px-3 py-2.5">Prepared on</th>
                  <th className="px-3 py-2.5">R&amp;D remarks</th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r) => {
                  const a = sampleAgeing(r);
                  return (
                    <tr key={r.id} className={`cursor-pointer border-b border-slate-50 hover:bg-slate-50/70 ${r.status === "REQUESTED" ? "bg-orange-50/40" : ""}`} onClick={() => navigate(`/sample-requests/${r.id}`)}>
                      <td className="px-3 py-2.5 font-mono font-bold text-slate-700">
                        <Link to={`/sample-requests/${r.id}`} className="hover:text-brand-600" onClick={(e) => e.stopPropagation()}>
                          {sampleNo(r.requestNo)}
                        </Link>
                        {r.round > 1 && <span className="ml-1 rounded-full bg-amber-100 px-1.5 text-micro font-bold text-amber-800">R{r.round}</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`pill ${SAMPLE_STATUS_PILL[r.status]}`}>{SAMPLE_STATUS_LABEL[r.status]}</span>
                      </td>
                      <td className={`px-3 py-2.5 font-bold ${a.took ? "text-slate-400" : a.days > 7 ? "text-rose-600" : "text-slate-700"}`}>
                        {a.days} day{a.days === 1 ? "" : "s"}
                        {a.took ? " (took)" : ""}
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">{day(r.createdAt)}</td>
                      <td className="px-3 py-2.5">
                        <p className="font-bold text-slate-800">{r.customerName}</p>
                        <p className="text-micro text-slate-400">{r.pocName}</p>
                      </td>
                      <td className="max-w-[16rem] truncate px-3 py-2.5 text-slate-600" title={r.composition}>
                        {r.composition}
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">{day(r.neededBy)}</td>
                      <td className="px-3 py-2.5 text-slate-600">{r.dosageForm ?? TEMPLATE_LABEL[r.template]}</td>
                      <td className="px-3 py-2.5 text-slate-600">{r.quantity ?? "-"}</td>
                      <td className="px-3 py-2.5">{r.feedback ? <span className={`pill ${FEEDBACK_PILL[r.feedback]}`}>{FEEDBACK_LABEL[r.feedback]}</span> : r.status === "DISPATCHED" ? <span className="text-micro font-bold text-amber-700">Awaited</span> : <span className="text-slate-300">-</span>}</td>
                      <td className="px-3 py-2.5 font-mono text-slate-600">{r.sampleCode ?? "-"}</td>
                      <td className="px-3 py-2.5 text-slate-600">{r.preparedByName ?? "-"}</td>
                      <td className="px-3 py-2.5 font-bold text-slate-700">{day(r.expectedDate)}</td>
                      <td className="px-3 py-2.5 text-slate-600">{day(r.preparedOn)}</td>
                      <td className="max-w-[14rem] truncate px-3 py-2.5 text-slate-600" title={r.rdRemarks ?? ""}>
                        {r.rdRemarks ?? "-"}
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
    </div>
  );
}
