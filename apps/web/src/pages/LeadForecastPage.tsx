import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, Download, TrendingUp } from "lucide-react";
import { fmtLac, monthLabel, useLeadForecast, type ForecastBucket } from "../lib/leadHooks";
import { addReportSheet, stampedName } from "../lib/excelReport";
import { EmptyState } from "../components/EmptyState";

// What BD can expect: the open leads by the month their order is expected, by lead source, and the funnel from lead to PO. A salesman sees his own
// leads, Admin sees all. The estimated value exists only for leads whose sample was approved (that is when it is asked).

function Stat({ label, value, hint, tone = "text-slate-900" }: { label: string; value: string | number; hint?: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-micro font-black uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-black leading-none ${tone}`}>{value}</p>
      {hint && <p className="mt-1 text-micro text-slate-400">{hint}</p>}
    </div>
  );
}

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "-");

function HeatBar({ b }: { b: ForecastBucket }) {
  const total = b.hot + b.warm + b.cold + b.other + (b.converted ? 0 : 0) || 1;
  const w = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="flex h-2 w-28 overflow-hidden rounded-full bg-slate-100" title={`Hot ${b.hot} · Warm ${b.warm} · Cold ${b.cold} · Other ${b.other}`}>
      <span className="bg-rose-400" style={{ width: w(b.hot) }} />
      <span className="bg-amber-400" style={{ width: w(b.warm) }} />
      <span className="bg-sky-400" style={{ width: w(b.cold) }} />
      <span className="bg-slate-300" style={{ width: w(b.other) }} />
    </div>
  );
}

function BucketTable({ title, first, rows }: { title: string; first: string; rows: { label: string; b: ForecastBucket }[] }) {
  return (
    <div className="card overflow-hidden">
      <p className="border-b border-slate-100 bg-slate-50/80 px-4 py-2.5 text-micro font-black uppercase tracking-wider text-slate-500">{title}</p>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2.5">{first}</th>
              <th className="px-3 py-2.5 text-right">Leads</th>
              <th className="px-3 py-2.5">How hot</th>
              <th className="px-3 py-2.5 text-right">Hot</th>
              <th className="px-3 py-2.5 text-right">Warm</th>
              <th className="px-3 py-2.5 text-right">Cold</th>
              <th className="px-3 py-2.5 text-right">Converted</th>
              <th className="px-3 py-2.5 text-right">Estimated value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, b }) => (
              <tr key={label} className="border-t border-slate-50">
                <td className="px-4 py-2.5 font-bold text-slate-800">{label}</td>
                <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-700">{b.leads}</td>
                <td className="px-3 py-2.5">
                  <HeatBar b={b} />
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-rose-700">{b.hot || "-"}</td>
                <td className="px-3 py-2.5 text-right font-mono text-amber-700">{b.warm || "-"}</td>
                <td className="px-3 py-2.5 text-right font-mono text-sky-700">{b.cold || "-"}</td>
                <td className="px-3 py-2.5 text-right font-mono text-emerald-700">{b.converted || "-"}</td>
                <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-900">{b.valueLac ? fmtLac(b.valueLac) : <span className="text-slate-300">-</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function LeadForecastPage() {
  const { data, isLoading } = useLeadForecast();

  if (isLoading) return <div className="skeleton h-64 w-full" />;
  if (!data || data.totals.leads === 0) {
    return (
      <div className="space-y-4">
        <Link to="/leads" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Leads
        </Link>
        <EmptyState icon={TrendingUp} title="No leads to forecast yet" hint="Add leads and log meetings with a closure month. The forecast fills in from them." />
      </div>
    );
  }

  const { totals: t, funnel: f } = data;
  const months = data.byMonth.map((m) => ({ label: m.key === "none" ? "No closure month set" : monthLabel(m.key), b: m }));
  const sources = data.bySource.map((s) => ({ label: s.key, b: s }));
  const stages: { label: string; n: number; hint: string }[] = [
    { label: "Leads", n: f.leads, hint: "all leads" },
    { label: "Sample asked", n: f.sample, hint: "a sample request was raised" },
    { label: "Sample approved", n: f.approved, hint: "the customer approved a sample" },
    { label: "Converted", n: f.converted, hint: "lead converted" },
    { label: "PO received", n: f.poReceived, hint: "the PO is entered" },
  ];

  function download() {
    const wb = XLSX.utils.book_new();
    const bucket = (key: string, label: string, b: ForecastBucket) => ({ [key]: label, Leads: b.leads, Hot: b.hot, Warm: b.warm, Cold: b.cold, Other: b.other, Converted: b.converted, "Estimated Value (Lac)": b.valueLac });
    addReportSheet(wb, "By closure month", "FLS BD: lead forecast by closure month", "Dropped leads are left out", months.map((m) => bucket("Closure Month", m.label, m.b)), { totals: ["Leads", "Hot", "Warm", "Cold", "Other", "Converted", "Estimated Value (Lac)"] });
    addReportSheet(wb, "By lead source", "FLS BD: leads by source", "All leads", sources.map((s) => bucket("Lead Source", s.label, s.b)), { totals: ["Leads", "Hot", "Warm", "Cold", "Other", "Converted", "Estimated Value (Lac)"] });
    addReportSheet(wb, "Funnel", "FLS BD: funnel from lead to PO", "All leads", stages.map((s, i) => ({ Stage: s.label, Leads: s.n, "% of leads": pct(s.n, f.leads), "% of the stage before": i === 0 ? "" : pct(s.n, stages[i - 1]!.n) })));
    XLSX.writeFile(wb, stampedName("FLS_Lead_Forecast"));
  }

  return (
    <div className="space-y-5">
      <Link to="/leads" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Leads
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-emerald-500/10 text-emerald-600">
            <TrendingUp className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Forecast</h1>
            <p className="text-sm text-slate-500">What to expect from your leads, by the month the order is expected. The value is asked once a sample is approved.</p>
          </div>
        </div>
        <button type="button" className="btn-ghost btn-sm" onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
        <Stat label="Open leads" value={t.open} hint={`${t.dropped} dropped`} />
        <Stat label="Open pipeline" value={fmtLac(t.openValueLac)} hint="estimated, sample approved" tone="text-brand-700" />
        <Stat label="Converted" value={fmtLac(t.convertedValueLac)} hint="orders coming" tone="text-emerald-700" />
        <Stat label="Waiting for PO" value={t.waitingForPo} hint={t.waitingForPo ? fmtLac(t.waitingValueLac) : "none waiting"} tone={t.waitingForPo ? "text-amber-700" : "text-slate-900"} />
        <Stat label="No closure month" value={t.noClosureMonth} hint="open leads to date" tone={t.noClosureMonth ? "text-rose-600" : "text-slate-900"} />
      </div>

      <div className="card p-4 sm:p-5">
        <p className="mb-3 text-micro font-black uppercase tracking-wider text-slate-400">Funnel: from lead to PO</p>
        <div className="space-y-2.5">
          {stages.map((s, i) => (
            <div key={s.label} className="flex items-center gap-3">
              <div className="w-36 shrink-0">
                <p className="text-xs font-bold text-slate-800">{s.label}</p>
                <p className="text-micro text-slate-400">{s.hint}</p>
              </div>
              <div className="h-6 min-w-0 flex-1 overflow-hidden rounded-lg bg-slate-100">
                <div className="flex h-full items-center rounded-lg bg-gradient-to-r from-brand-400 to-brand-600 px-2 text-xs font-black text-white" style={{ width: `${Math.max(4, f.leads ? (s.n / f.leads) * 100 : 0)}%` }}>
                  {s.n}
                </div>
              </div>
              <p className="w-28 shrink-0 text-right text-micro text-slate-500">{i === 0 ? "" : `${pct(s.n, stages[i - 1]!.n)} of the stage before`}</p>
            </div>
          ))}
        </div>
      </div>

      <BucketTable title="By the month the order is expected (dropped leads left out)" first="Closure month" rows={months} />
      <BucketTable title="By lead source" first="Lead source" rows={sources} />
    </div>
  );
}
