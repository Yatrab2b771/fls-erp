import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, CalendarClock } from "lucide-react";
import { ApiError } from "../lib/api";
import { LEAD_STATUS_META, followUpState, fmtDateTime, fromLocalInput, toLocalInput, useLeads, useRescheduleLead, type Lead } from "../lib/leadHooks";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";

// Every open lead whose next follow-up is due today or earlier. Done it: log the meeting. Could not: move the date, with the reason.

type Tab = "ALL" | "OVERDUE" | "TODAY";

export function LeadFollowUpsPage() {
  const { data, isLoading } = useLeads();
  const [tab, setTab] = useState<Tab>("ALL");
  const [moving, setMoving] = useState<string | null>(null);

  const due = useMemo(
    () =>
      (data ?? [])
        .map((l) => ({ l, f: followUpState(l.nextFollowUpAt, l.status) }))
        .filter(({ f }) => f.tone === "late" || f.tone === "today")
        .sort((a, b) => new Date(a.l.nextFollowUpAt!).getTime() - new Date(b.l.nextFollowUpAt!).getTime()),
    [data],
  );
  const overdue = due.filter(({ f }) => f.tone === "late").length;
  const today = due.length - overdue;
  const rows = due.filter(({ f }) => tab === "ALL" || (tab === "OVERDUE" ? f.tone === "late" : f.tone === "today"));
  const noDate = (data ?? []).filter((l) => !l.nextFollowUpAt && l.status !== "DROPPED" && l.status !== "CONVERTED").length;

  const pill = (key: Tab, label: string, n: number) => (
    <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)} className={`rounded-full border px-3.5 py-1.5 text-xs font-bold ${tab === key ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600"}`}>
      {label} {n}
    </button>
  );

  return (
    <div className="space-y-5">
      <Link to="/leads" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Leads
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Follow up today</h1>
          <p className="text-sm text-slate-500">Leads whose next follow-up is today or earlier. Done a follow-up? Log the meeting. Could not do it? Move the date.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {pill("ALL", "All", due.length)}
          {pill("OVERDUE", "Overdue", overdue)}
          {pill("TODAY", "Today", today)}
        </div>
      </div>
      {noDate > 0 && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
          {noDate} open lead{noDate === 1 ? " has" : "s have"} no follow-up date, so they do not show here. Open them from the Leads list and set one.
        </p>
      )}

      {isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={CalendarClock} title="Nothing to follow up" hint="No lead is due today. Leads show here on the day their next follow-up arrives." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2.5">Due</th>
                  <th className="px-3 py-2.5">Brand</th>
                  <th className="px-3 py-2.5">Lead status</th>
                  <th className="px-3 py-2.5">Last meeting says</th>
                  <th className="px-3 py-2.5 text-right">Meetings</th>
                  <th className="px-3 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ l, f }) => (
                  <Fragment key={l.id}>
                    <tr className={`border-b border-slate-50 ${f.tone === "late" ? "bg-rose-50/50" : "bg-brand-50/30"}`}>
                      <td className="px-3 py-3 align-top">
                        <span className={`font-black ${f.tone === "late" ? "text-rose-600" : "text-brand-700"}`}>{f.text}</span>
                        <p className="text-micro text-slate-400">{fmtDateTime(l.nextFollowUpAt)}</p>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <Link to={`/leads/${l.id}`} className="font-bold text-slate-800 hover:text-brand-600">
                          {l.brandName}
                        </Link>
                        <p className="text-micro text-slate-400">{[l.contactPerson, l.city].filter(Boolean).join(" · ")}</p>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <span className={`pill ${LEAD_STATUS_META[l.status].pill}`}>{LEAD_STATUS_META[l.status].label}</span>
                      </td>
                      <td className="max-w-md px-3 py-3 align-top text-slate-600">{l.lastMeeting ? <span className="line-clamp-2">{l.lastMeeting.notes}</span> : <span className="text-slate-300">No meeting yet</span>}</td>
                      <td className="px-3 py-3 text-right align-top font-mono font-bold text-slate-700">{l.meetingCount}</td>
                      <td className="px-3 py-3 text-right align-top">
                        <div className="flex flex-wrap justify-end gap-2">
                          <Link to={`/leads/${l.id}?meeting=1`} className="btn-primary btn-sm">
                            Log meeting
                          </Link>
                          <button type="button" className={`btn-ghost btn-sm ${moving === l.id ? "!border-brand-500 !text-brand-700" : ""}`} onClick={() => setMoving(moving === l.id ? null : l.id)}>
                            Change date
                          </button>
                        </div>
                      </td>
                    </tr>
                    {moving === l.id && (
                      <tr className="border-b border-slate-100 bg-white">
                        <td colSpan={6} className="px-3 pb-3">
                          <MoveDate lead={l} onDone={() => setMoving(null)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="text-xs text-slate-400">Moving a date is not a meeting: it is written in the lead's log with the reason.</p>
    </div>
  );
}

function MoveDate({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  const toast = useToast();
  const move = useRescheduleLead();
  const [to, setTo] = useState(toLocalInput(lead.nextFollowUpAt));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setError(null);
    if (!to) return setError("Choose the new date and time.");
    if (!reason.trim()) return setError("Write why the follow-up is moving.");
    try {
      await move.mutateAsync({ id: lead.id, toAt: fromLocalInput(to)!, reason: reason.trim() });
      toast.success(`${lead.brandName}: follow-up moved.`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-brand-200 bg-brand-50/30 p-3">
      <div>
        <label className="label">New date and time</label>
        <input type="datetime-local" className="field" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <div className="min-w-[14rem] flex-1">
        <label className="label">Why is it moving</label>
        <input className="field" placeholder="Kept in the lead's log" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <button type="button" className="btn-primary btn-sm" disabled={move.isPending} onClick={save}>
        Save date
      </button>
      {error && <p className="w-full text-xs font-bold text-rose-600">{error}</p>}
    </div>
  );
}
