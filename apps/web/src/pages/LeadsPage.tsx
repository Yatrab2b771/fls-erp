import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, CalendarClock, Download, Plus, ScanLine, TrendingUp, Users } from "lucide-react";
import { useAuth } from "../lib/auth";
import { LEAD_STATUS_META, LEAD_STATUS_ORDER, followUpState, fmtDateTime, fmtDay, fmtLac, isClosed, monthLabel, useLeads, type Lead } from "../lib/leadHooks";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";

// BD's leads: every company BD is talking to, with its status, last meeting and next follow-up. Everything is narrowed with the filters.

const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const FOLLOW_UP_BUCKETS = ["Overdue", "Today", "Later", "Not set"];
const WAITING_FOR_PO = "Waiting for PO (converted, no PO yet)";

function bucketOf(l: Lead): string {
  const s = followUpState(l.nextFollowUpAt, l.status);
  return s.tone === "late" ? "Overdue" : s.tone === "today" ? "Today" : s.tone === "later" ? "Later" : isClosed(l.status) ? "" : "Not set";
}

export function LeadsPage() {
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const { data, isLoading } = useLeads();
  const filters = useTileFilters();
  const every = data ?? [];
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const showPoc = hasRole("ADMIN") || distinct(every.map((l) => l.pocName)).length > 1;

  const fields: FilterField[] = [
    { key: "status", label: "Lead status", options: [...LEAD_STATUS_ORDER.map((s) => LEAD_STATUS_META[s].label), WAITING_FOR_PO] },
    { key: "ctype", label: "Customer type", options: distinct(every.flatMap((l) => l.customerTypes)) },
    { key: "format", label: "Product format", options: distinct(every.flatMap((l) => l.productFormats)) },
    { key: "powder", label: "Powder type", options: distinct(every.flatMap((l) => l.powderTypes)) },
    { key: "source", label: "Lead source", options: distinct(every.map((l) => l.leadSource)) },
    { key: "closure", label: "Closure month", options: distinct(every.map((l) => l.closureMonth)).map(monthLabel) },
    { key: "followup", label: "Follow-up", options: FOLLOW_UP_BUCKETS },
    ...(showPoc ? [{ key: "poc", label: "POC", options: distinct(every.map((l) => l.pocName)) }] : []),
  ];

  const rows = useMemo(() => {
    const { dateFrom, dateTo } = filters.applied;
    const any = (key: string, values: string[]) => !picked(key).length || values.some((v) => picked(key).includes(v));
    return every.filter(
      (l) =>
        any("status", [LEAD_STATUS_META[l.status].label, ...(l.waitingForPo ? [WAITING_FOR_PO] : [])]) &&
        any("ctype", l.customerTypes) &&
        any("format", l.productFormats) &&
        any("powder", l.powderTypes) &&
        any("source", l.leadSource ? [l.leadSource] : []) &&
        any("closure", l.closureMonth ? [monthLabel(l.closureMonth)] : []) &&
        any("followup", [bucketOf(l)]) &&
        any("poc", [l.pocName]) &&
        (!dateFrom || l.createdAt.slice(0, 10) >= dateFrom) &&
        (!dateTo || l.createdAt.slice(0, 10) <= dateTo),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [every, filters.applied]);

  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;

  function download() {
    const lines = rows.map((l) => ({
      Brand: l.brandName,
      "Lead Status": LEAD_STATUS_META[l.status].label,
      "Contact Person": l.contactPerson,
      Designation: l.designation,
      Phone: l.phones.join(", "),
      Email: l.email,
      City: l.city,
      State: l.state,
      "Customer Type": l.customerTypes.join(", "),
      "Product Formats": l.productFormats.join(", "),
      "Powder Types": l.powderTypes.join(", "),
      "Lead Source": l.leadSource ?? "",
      Meetings: l.meetingCount,
      "Last Meeting": l.lastMeeting ? fmtDay(l.lastMeeting.meetingDate) : "",
      "Last Meeting Notes": l.lastMeeting?.notes ?? "",
      "Next Follow-up": l.nextFollowUpAt ? fmtDateTime(l.nextFollowUpAt) : "",
      "Closure Month": l.closureMonth ? monthLabel(l.closureMonth) : "",
      "Estimated Qty": l.estimatedQty ?? "",
      "Estimated Value (Lac)": l.estimatedValueLac ?? "",
      "PO Status": l.status === "CONVERTED" ? (l.waitingForPo ? "Waiting for PO" : l.poNumbers.join(", ")) : "",
      POC: l.pocName,
      Added: fmtDay(l.createdAt),
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Leads", "FLS BD: Leads", describeFilters(filters, fields, "Added"), lines);
    XLSX.writeFile(wb, stampedName("FLS_Leads"));
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-brand-500/10 text-brand-600">
            <Users className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Leads</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} lead{rows.length === 1 ? "" : "s"}
              {isFiltered ? ` (of ${every.length})` : ""}. Every company you are talking to, with its status and next follow-up.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/leads/forecast" className="btn-ghost btn-sm">
            <TrendingUp className="h-3.5 w-3.5" strokeWidth={2.25} /> Forecast
          </Link>
          <Link to="/leads/follow-ups" className="btn-ghost btn-sm">
            <CalendarClock className="h-3.5 w-3.5" strokeWidth={2.25} /> Follow-ups
          </Link>
          <Link to="/visiting-cards" className="btn-ghost btn-sm">
            <ScanLine className="h-3.5 w-3.5" strokeWidth={2.25} /> Scan visiting card
          </Link>
          <button type="button" className="btn-ghost btn-sm shrink-0" disabled={rows.length === 0} onClick={download}>
            <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
          </button>
          {hasRole("BD") && (
            <Link to="/leads/new" className="btn-primary btn-sm">
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Add lead
            </Link>
          )}
        </div>
      </div>

      <TileFilterBar filters={filters} tileKey="leads" fields={fields} dateLabel="Added" />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Users} title={isFiltered ? "Nothing matches these filters" : "No leads yet"} hint={isFiltered ? "Clear a filter." : "Scan a visiting card or press “Add lead” to start."} />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2.5">Brand</th>
                  <th className="px-3 py-2.5">Lead status</th>
                  <th className="px-3 py-2.5">Contact</th>
                  <th className="px-3 py-2.5">Customer type</th>
                  <th className="px-3 py-2.5">Formats</th>
                  <th className="px-3 py-2.5 text-right">Meetings</th>
                  <th className="px-3 py-2.5">Next follow-up</th>
                  <th className="px-3 py-2.5">Closure month</th>
                  <th className="px-3 py-2.5">Estimated order</th>
                  {showPoc && <th className="px-3 py-2.5">POC</th>}
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((l) => {
                  const f = followUpState(l.nextFollowUpAt, l.status);
                  return (
                    <tr key={l.id} className={`cursor-pointer border-b border-slate-50 hover:bg-slate-50/70 ${f.tone === "late" ? "bg-rose-50/40" : f.tone === "today" ? "bg-brand-50/40" : ""}`} onClick={() => navigate(`/leads/${l.id}`)}>
                      <td className="px-3 py-2.5">
                        <Link to={`/leads/${l.id}`} className="font-bold text-slate-800 hover:text-brand-600" onClick={(e) => e.stopPropagation()}>
                          {l.brandName}
                        </Link>
                        <p className="text-micro text-slate-400">{[l.city, l.state].filter(Boolean).join(", ") || "-"}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`pill ${LEAD_STATUS_META[l.status].pill}`}>{LEAD_STATUS_META[l.status].label}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="font-semibold text-slate-700">{l.contactPerson || "-"}</p>
                        <p className="text-micro text-slate-400">{l.designation}</p>
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">{l.customerTypes.join(", ")}</td>
                      <td className="max-w-[16rem] truncate px-3 py-2.5 text-slate-600" title={l.productFormats.join(", ")}>
                        {l.productFormats.map((p) => (p === "Powder" && l.powderTypes.length ? `Powder: ${l.powderTypes.join(", ")}` : p)).join(" · ")}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-700">{l.meetingCount}</td>
                      <td className="px-3 py-2.5">
                        <span className={f.tone === "late" ? "font-black text-rose-600" : f.tone === "today" ? "font-black text-brand-700" : f.tone === "none" ? "text-slate-400" : "text-slate-600"}>{f.text}</span>
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">{monthLabel(l.closureMonth)}</td>
                      <td className="px-3 py-2.5 text-slate-600">
                        {l.estimatedQty || l.estimatedValueLac != null ? (
                          <>
                            {l.estimatedQty ?? "-"} · {fmtLac(l.estimatedValueLac)}
                            {l.waitingForPo && <span className="ml-1 rounded-full bg-amber-100 px-1.5 text-micro font-bold text-amber-800">waiting for PO</span>}
                          </>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                      {showPoc && <td className="px-3 py-2.5 text-slate-600">{l.pocName}</td>}
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
