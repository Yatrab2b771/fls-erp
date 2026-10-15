import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { ArrowLeft, BellRing, Download } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useTileFilters } from "../lib/tileFilters";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { customerTypeLabel } from "../lib/customerTags";

// Everything that needs attention, from every department, in one list (Admin). Worked out live on the server (see alerts.routes.ts):
// Late (past a date), Stuck (waiting more than 3 days), Blocked (on hold / rejected / not approved) and Short (material short).

type Severity = "Late" | "Stuck" | "Blocked" | "Short";
export interface AlertRow {
  key: string;
  severity: Severity;
  type: string;
  po: string | null;
  customer: string | null;
  product: string | null;
  detail: string;
  sinceAt: string | null;
  days: number;
  department: string;
  link: string;
}

export interface AlertSummary {
  total: number;
  late: number;
  stuck: number;
  blocked: number;
  short: number;
}

export const useAlerts = (options?: { enabled?: boolean }) => useQuery({ queryKey: ["alerts", "list"], queryFn: () => api<AlertRow[]>("/api/alerts"), enabled: options?.enabled ?? true });
export const useAlertSummary = (options?: { enabled?: boolean }) => useQuery({ queryKey: ["alerts", "summary"], queryFn: () => api<AlertSummary>("/api/alerts/summary"), enabled: options?.enabled ?? true, refetchInterval: 60_000 });

const TONE: Record<Severity, string> = {
  Late: "border-rose-200 bg-rose-50 text-rose-700",
  Blocked: "border-amber-200 bg-amber-50 text-amber-700",
  Stuck: "border-violet-200 bg-violet-50 text-violet-700",
  Short: "border-sky-200 bg-sky-50 text-sky-700",
};
const distinct = (xs: (string | null)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-");

export function AlertsPage() {
  const { hasRole } = useAuth();
  const filters = useTileFilters();
  const { data, isLoading } = useAlerts({ enabled: hasRole("ADMIN") });
  const rows = data ?? [];

  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const has = (key: string, value: string | null) => !picked(key).length || picked(key).includes(value ?? "");
  const shown = rows.filter((r) => has("severity", r.severity) && has("type", r.type) && has("po", r.po) && has("customer", r.customer) && has("product", r.product) && has("department", r.department));
  const isFiltered = filters.activeCount > 0;
  const fields: FilterField[] = [
    { key: "severity", label: "Kind", options: ["Late", "Blocked", "Stuck", "Short"] },
    { key: "type", label: "Alert", options: distinct(rows.map((r) => r.type)) },
    { key: "department", label: "Department", options: distinct(rows.map((r) => r.department)) },
    { key: "po", label: "PO Number", options: distinct(rows.map((r) => r.po)) },
    { key: "customer", label: "Customer", options: distinct(rows.map((r) => r.customer)) },
    { key: "product", label: "Product / Material", options: distinct(rows.map((r) => r.product)) },
  ];
  const pg = useClientPaging(shown);

  function download() {
    const sheet = XLSX.utils.json_to_sheet(shown.map((r) => ({ Kind: r.severity, Alert: r.type, Department: r.department, "PO Number": r.po ?? "", Customer: r.customer ?? "", "Customer Type": customerTypeLabel(r.customer ?? ""), "Product / Material": r.product ?? "", Detail: r.detail, Since: r.sinceAt ? r.sinceAt.slice(0, 10) : "", Days: r.days })));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Alerts");
    XLSX.writeFile(book, `FLS_Alerts_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-rose-500/10 text-rose-600">
            <BellRing className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Alerts</h1>
            <p className="text-sm text-slate-500">
              {shown.length} alert(s){isFiltered ? ` (of ${rows.length})` : ""} — late, blocked, waiting too long (over 3 days) or short, from every department
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm" onClick={download} disabled={shown.length === 0}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Report{isFiltered ? " (Filtered)" : ""}
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey="alerts" fields={fields} hideDates />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : shown.length === 0 ? (
        <EmptyState icon={BellRing} title="No alerts" hint={isFiltered ? "Nothing matches these filters." : "Nothing is late, blocked, stuck or short right now."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="whitespace-nowrap px-4 py-3">Kind</th>
                <th className="whitespace-nowrap px-4 py-3">Alert</th>
                <th className="whitespace-nowrap px-4 py-3">PO Number</th>
                <th className="whitespace-nowrap px-4 py-3">Customer</th>
                <th className="whitespace-nowrap px-4 py-3">Product / Material</th>
                <th className="px-4 py-3">Detail</th>
                <th className="whitespace-nowrap px-4 py-3">Since</th>
                <th className="whitespace-nowrap px-4 py-3 text-right">Days</th>
                <th className="whitespace-nowrap px-4 py-3">Department</th>
                <th className="whitespace-nowrap px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((r) => (
                <tr key={r.key} className="align-top transition hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <span className={`pill ${TONE[r.severity]}`}>{r.severity}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-bold text-slate-700">{r.type}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{r.po ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{r.customer ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-bold text-slate-800">{r.product ?? "—"}</td>
                  <td className="min-w-[18rem] max-w-md px-4 py-3 text-slate-600">{r.detail}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{day(r.sinceAt)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-slate-700">{r.sinceAt ? r.days : "—"}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{r.department}</td>
                  <td className="px-4 py-3 text-right">
                    <Link to={r.link} className="btn-ghost btn-sm">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ClientPager pg={pg} />
        </div>
      )}
    </div>
  );
}
