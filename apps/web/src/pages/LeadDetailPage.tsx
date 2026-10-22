import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, CalendarClock, Lock, Pencil, Plus } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useBackTo } from "../lib/backTo";
import {
  LEAD_STATUS_META,
  LEAD_STATUS_ORDER,
  MODE_LABEL,
  closureMonthOptions,
  followUpState,
  fmtDateTime,
  fmtDay,
  fmtLac,
  fromLocalInput,
  isClosed,
  monthLabel,
  toLocalInput,
  useAddMeeting,
  useConvertLead,
  useLead,
  useLeadAssignees,
  useRescheduleLead,
  useUpdateLead,
  type LeadDetail,
  type LeadMeetingMode,
  type LeadStatus,
} from "../lib/leadHooks";
import { LeadKindFields, LeadSourceSelect } from "../components/LeadPickers";
import { useCardPhoto } from "../lib/businessCardHooks";
import { SAMPLE_STATUS_LABEL, SAMPLE_STATUS_PILL, TEMPLATE_LABEL, sampleNo, useSampleRequests } from "../lib/sampleRequestHooks";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";

// One lead: who it is, where it stands, and the log of every meeting (newest first). Everything BD does to a lead happens here.

const MODES: LeadMeetingMode[] = ["CALL", "VIDEO", "IN_PERSON"];
const errorText = (err: unknown) => (err instanceof ApiError ? err.message : "Could not save");

/** BD / Admin: hand the lead to whoever should follow it up (any department). */
function HandOver({ lead }: { lead: LeadDetail }) {
  const toast = useToast();
  const update = useUpdateLead();
  const { data: people } = useLeadAssignees();
  const [pick, setPick] = useState("");
  async function hand() {
    const who = (people ?? []).find((p) => p.id === pick);
    if (!who || !window.confirm(`Hand this lead to ${who.name}? It then leaves your list unless you made it.`)) return;
    try {
      await update.mutateAsync({ id: lead.id, pocId: pick });
      toast.success(`Handed to ${who.name}.`);
      setPick("");
    } catch (err) {
      toast.error(errorText(err));
    }
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <select className="field !h-8 !w-56 !py-0 !text-xs" value={pick} onChange={(e) => setPick(e.target.value)}>
        <option value="">Hand over to…</option>
        {(people ?? []).filter((p) => p.id !== lead.pocId).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}{p.department ? ` (${p.department})` : ""}
          </option>
        ))}
      </select>
      <button type="button" className="btn-ghost btn-sm" disabled={!pick || update.isPending} onClick={hand}>
        Hand over
      </button>
    </div>
  );
}

export function LeadDetailPage() {
  const { hasRole } = useAuth();
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const back = useBackTo({ from: "/leads", label: "Leads" }); // where this lead was opened from
  const { data: lead, isLoading, error, refetch, isFetching } = useLead(id);
  const [showMeeting, setShowMeeting] = useState(false);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    if (params.get("meeting") === "1") {
      setShowMeeting(true);
      params.delete("meeting");
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  if (isLoading) return <div className="skeleton h-64 w-full" />;
  if (!lead) {
    return (
      <div className="space-y-4">
        <Link to={back.from} className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> {back.label}
        </Link>
        {/* Only a real 404 means "not found"; any other failure (server down, network, an error) says so, with its message and a retry. */}
        {error && !(error instanceof ApiError && error.status === 404) ? (
          <div className="space-y-3">
            <EmptyState icon={CalendarClock} title="Could not load this lead" hint={error instanceof Error ? error.message : "Something went wrong."} />
            <div className="flex justify-center">
              <button className="btn-primary btn-sm" disabled={isFetching} onClick={() => refetch()}>
                {isFetching ? "Trying…" : "Try again"}
              </button>
            </div>
          </div>
        ) : (
          <EmptyState icon={CalendarClock} title="Lead not found" hint="It may belong to another salesman, or it was removed." />
        )}
      </div>
    );
  }

  const f = followUpState(lead.nextFollowUpAt, lead.status);
  return (
    <div className="space-y-5">
      <Link to={back.from} className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> {back.label}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <CardPhoto lead={lead} />
          <div className="min-w-0">
          <p className="text-micro font-black uppercase tracking-wider text-slate-400">Lead · added {fmtDay(lead.createdAt)}{lead.businessCardId ? " from a visiting card" : ""} · POC {lead.pocName}</p>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">{lead.brandName}</h1>
          <p className="text-sm text-slate-600">{[lead.contactPerson, lead.designation, lead.phones.join(", "), lead.email].filter(Boolean).join(" · ") || "No contact details yet"}</p>
          {hasRole("BD") && <HandOver lead={lead} />}
          </div>
        </div>
        <StatusBox lead={lead} />
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[999_1_40rem] flex-col gap-4">
          <AboutCard lead={lead} />
          <div className="card p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-micro font-black uppercase tracking-wider text-slate-400">
                Meetings · {lead.meetings.length} so far{lead.meetings.length > 1 ? ", newest first" : ""}
              </p>
              {!showMeeting && (
                <button type="button" className="btn-primary btn-sm" onClick={() => setShowMeeting(true)}>
                  <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Add meeting
                </button>
              )}
            </div>
            {showMeeting && <MeetingForm lead={lead} onDone={() => setShowMeeting(false)} />}
            <MeetingLog lead={lead} />
          </div>
        </div>

        <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-4">
          <div className={`rounded-2xl border-2 p-4 ${f.tone === "late" ? "border-rose-300 bg-rose-50" : f.tone === "today" ? "border-brand-400 bg-brand-50" : "border-slate-200 bg-white"}`}>
            <p className="text-micro font-black uppercase tracking-wider text-slate-500">Next follow-up</p>
            <p className={`mt-1 text-xl font-black ${f.tone === "late" ? "text-rose-700" : f.tone === "today" ? "text-brand-800" : "text-slate-900"}`}>{f.text}</p>
            {lead.nextFollowUpAt && f.tone !== "later" && <p className="text-xs text-slate-500">was set for {fmtDateTime(lead.nextFollowUpAt)}</p>}
            {isClosed(lead.status) ? (
              <p className="mt-2 text-xs text-slate-500">This lead is {LEAD_STATUS_META[lead.status].label.toLowerCase()}: no follow-up is needed.</p>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="btn-primary btn-sm" onClick={() => setShowMeeting(true)}>
                  Log a meeting
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setMoving((v) => !v)}>
                  Change the date
                </button>
              </div>
            )}
            {moving && !isClosed(lead.status) && <RescheduleForm lead={lead} onDone={() => setMoving(false)} />}
          </div>

          <ClosureCard lead={lead} />

          <EstimateCard lead={lead} />
          {hasRole("BD") && <SampleCard lead={lead} />}

          {lead.reschedules.length > 0 && (
            <div className="card p-4">
              <p className="mb-2 text-micro font-black uppercase tracking-wider text-slate-400">Follow-up dates moved</p>
              <ul className="space-y-2 text-xs text-slate-600">
                {lead.reschedules.map((r) => (
                  <li key={r.id}>
                    <span className="font-bold text-slate-800">
                      {r.fromAt ? fmtDateTime(r.fromAt) : "no date"} → {fmtDateTime(r.toAt)}
                    </span>
                    <span className="block text-slate-500">
                      {r.reason} · {r.byName}, {fmtDay(r.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

/** The estimated order size (opens once a sample is approved), Convert lead, and what happens after: waiting for the PO. */
function EstimateCard({ lead }: { lead: LeadDetail }) {
  const { hasRole } = useAuth();
  const toast = useToast();
  const update = useUpdateLead();
  const convert = useConvertLead();
  const [qty, setQty] = useState(lead.estimatedQty ?? "");
  const [value, setValue] = useState(lead.estimatedValueLac != null ? String(lead.estimatedValueLac) : "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setQty(lead.estimatedQty ?? "");
    setValue(lead.estimatedValueLac != null ? String(lead.estimatedValueLac) : "");
  }, [lead.estimatedQty, lead.estimatedValueLac]);

  if (!lead.sampleApproved) {
    return <LockedCard title="Estimated order size" line="Opens after the sample is approved" note="Then quantity / volume and value (Lac) are asked, and the lead can be Converted." />;
  }

  const done = lead.status === "CONVERTED";
  const changed = qty.trim() !== (lead.estimatedQty ?? "") || (value.trim() === "" ? null : Number(value)) !== lead.estimatedValueLac;
  const parsed = () => {
    const v = Number(value);
    if (!qty.trim()) return "Enter the quantity / volume you expect.";
    if (!(v > 0)) return "Enter the value in Lac (more than zero).";
    return null;
  };

  async function save() {
    setError(null);
    const bad = parsed();
    if (bad) return setError(bad);
    try {
      await update.mutateAsync({ id: lead.id, estimatedQty: qty.trim(), estimatedValueLac: Number(value) });
      toast.success("Estimated order size saved.");
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function doConvert() {
    setError(null);
    const bad = parsed();
    if (bad) return setError(bad);
    if (!window.confirm("Convert this lead? It will wait for its PO, and no more follow-ups are asked.")) return;
    try {
      await convert.mutateAsync({ id: lead.id, estimatedQty: qty.trim(), estimatedValueLac: Number(value) });
      toast.success("Lead converted. Enter the PO when it comes.");
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="space-y-3 rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4">
      <p className="text-micro font-black uppercase tracking-wider text-emerald-800">Estimated order size · sample approved</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Quantity / volume</label>
          <input className="field" placeholder="e.g. 1 ton, 10,000 pcs" value={qty} disabled={done} onChange={(e) => setQty(e.target.value)} />
        </div>
        <div>
          <label className="label">Value (Lac)</label>
          <input className="field" type="number" min="0" step="any" placeholder="e.g. 12.5" value={value} disabled={done} onChange={(e) => setValue(e.target.value)} />
        </div>
      </div>
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      {!done && (
        <div className="flex flex-wrap gap-2">
          {changed && (
            <button type="button" className="btn-ghost btn-sm" disabled={update.isPending} onClick={save}>
              Save estimate
            </button>
          )}
          {lead.status !== "DROPPED" && hasRole("BD") && (
            <button type="button" className="btn-primary btn-sm" disabled={convert.isPending} onClick={doConvert}>
              Convert lead
            </button>
          )}
        </div>
      )}
      {done && <PoCard lead={lead} />}
      {!done && <p className="text-xs text-emerald-900">Mandatory now: it is asked at every meeting. R&amp;D uploads the BOM and Regulatory starts; then convert the lead and enter the PO.</p>}
    </div>
  );
}

/** A converted lead waits for its PO until one of its customer is entered. */
function PoCard({ lead }: { lead: LeadDetail }) {
  if (lead.poNumbers.length > 0) {
    return (
      <div className="rounded-xl border border-emerald-300 bg-white p-3 text-xs">
        <p className="font-black text-emerald-800">PO received ✓</p>
        <p className="mt-0.5 font-mono text-slate-700">{lead.poNumbers.join(", ")}</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3">
      <p className="text-xs font-black text-amber-900">Converted · waiting for the PO</p>
      <p className="mt-0.5 text-xs text-amber-800">As soon as a PO of this customer is entered, this lead leaves the waiting list.{lead.estimatedValueLac != null ? ` Expected ${fmtLac(lead.estimatedValueLac)}.` : ""}</p>
      {lead.customerId ? (
        <Link to={`/purchase-orders?newFor=${lead.customerId}`} className="btn-primary btn-sm mt-2 inline-flex">
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Enter PO
        </Link>
      ) : (
        <p className="mt-2 text-xs text-slate-500">No customer is linked to this lead yet.</p>
      )}
    </div>
  );
}

/** The lead's sample requests, and the button to ask for a new one once its status is Sampling. */
function SampleCard({ lead }: { lead: LeadDetail }) {
  const { data } = useSampleRequests();
  const mine = (data ?? []).filter((r) => r.leadId === lead.id);
  const canAsk = lead.status === "SAMPLING";
  return (
    <div className={`rounded-2xl border p-4 ${canAsk || mine.length ? "border-violet-200 bg-violet-50/40" : "border-dashed border-slate-300 bg-slate-50/70"}`}>
      <p className="text-micro font-black uppercase tracking-wider text-slate-400">Sample</p>
      {mine.length === 0 && !canAsk && (
        <>
          <p className="mt-1.5 flex items-center gap-1.5 text-sm font-bold text-slate-500">
            <Lock className="h-3.5 w-3.5" strokeWidth={2.5} /> Choose the status Sampling to ask for a sample
          </p>
          <p className="mt-1 text-xs text-slate-400">The request date, POC and company come filled from this lead.</p>
        </>
      )}
      {mine.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {mine.map((r) => (
            <li key={r.id}>
              <Link to={`/sample-requests/${r.id}`} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs hover:border-violet-300">
                <span className="font-bold text-slate-800">
                  {sampleNo(r.requestNo)} · {TEMPLATE_LABEL[r.template]}
                  {r.round > 1 ? ` · round ${r.round}` : ""}
                </span>
                <span className={`pill ${SAMPLE_STATUS_PILL[r.status]}`}>{SAMPLE_STATUS_LABEL[r.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {canAsk && (
        <Link to={`/sample-requests/new?lead=${lead.id}`} className="btn-primary btn-sm mt-3 inline-flex">
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> New sample request
        </Link>
      )}
    </div>
  );
}

/** The photo of the visiting card this lead came from (tap to enlarge). */
function CardPhoto({ lead }: { lead: LeadDetail }) {
  const photo = useCardPhoto(lead.businessCardId, !!lead.businessCardId);
  const [zoom, setZoom] = useState(false);
  if (!lead.businessCardId || !photo) return null;
  return (
    <>
      <button type="button" onClick={() => setZoom(true)} className="hidden flex-none overflow-hidden rounded-xl border border-slate-200 bg-slate-50 sm:block" title="The visiting card this lead came from">
        <img src={photo} alt="Visiting card" className="h-20 w-32 object-cover" />
      </button>
      {zoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setZoom(false)}>
          <img src={photo} alt="Visiting card" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </>
  );
}

function LockedCard({ title, line, note }: { title: string; line: string; note: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 p-4">
      <p className="text-micro font-black uppercase tracking-wider text-slate-400">{title}</p>
      <p className="mt-1.5 flex items-center gap-1.5 text-sm font-bold text-slate-500">
        <Lock className="h-3.5 w-3.5" strokeWidth={2.5} /> {line}
      </p>
      <p className="mt-1 text-xs text-slate-400">{note}</p>
    </div>
  );
}

/** The status, changed at any time. A lead that comes back from Dropped / Converted needs a new follow-up date. */
function StatusBox({ lead }: { lead: LeadDetail }) {
  const toast = useToast();
  const update = useUpdateLead();
  const [status, setStatus] = useState<LeadStatus>(lead.status);
  const [followUp, setFollowUp] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setStatus(lead.status), [lead.status]);
  const needsDate = isClosed(lead.status) && !isClosed(status);
  const changed = status !== lead.status;

  async function save() {
    setError(null);
    if (needsDate && !followUp) return setError("Choose the next follow-up date and time.");
    try {
      await update.mutateAsync({ id: lead.id, status, ...(needsDate ? { nextFollowUpAt: fromLocalInput(followUp) } : {}) });
      toast.success(`Status is now ${LEAD_STATUS_META[status].label}.`);
      setFollowUp("");
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="w-full max-w-xs space-y-2 sm:w-auto sm:min-w-[16rem]">
      <label className="label">Lead status</label>
      <div className="flex items-center gap-2">
        <select className={`field font-bold ${LEAD_STATUS_META[status].text}`} value={status} disabled={lead.status === "CONVERTED"} onChange={(e) => setStatus(e.target.value as LeadStatus)}>
          {LEAD_STATUS_ORDER.map((s) => (
            <option key={s} value={s} disabled={s === "CONVERTED" && lead.status !== "CONVERTED"}>
              {LEAD_STATUS_META[s].label} · {s === "CONVERTED" && lead.status !== "CONVERTED" ? "use Convert lead (after sample approval)" : LEAD_STATUS_META[s].meaning.toLowerCase()}
            </option>
          ))}
        </select>
        {changed && (
          <button type="button" className="btn-primary btn-sm" disabled={update.isPending} onClick={save}>
            Save
          </button>
        )}
      </div>
      {needsDate && changed && (
        <div>
          <label className="label">Next follow-up</label>
          <input type="datetime-local" className="field" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
        </div>
      )}
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
    </div>
  );
}

function ClosureCard({ lead }: { lead: LeadDetail }) {
  const toast = useToast();
  const update = useUpdateLead();
  async function change(value: string) {
    try {
      await update.mutateAsync({ id: lead.id, closureMonth: value || null });
      toast.success("Closure month saved.");
    } catch (err) {
      toast.error(errorText(err));
    }
  }
  return (
    <div className="card p-4">
      <p className="text-micro font-black uppercase tracking-wider text-slate-400">Closure month</p>
      <select className="field mt-1.5 font-bold" value={lead.closureMonth ?? ""} onChange={(e) => change(e.target.value)} disabled={update.isPending}>
        <option value="">Not decided</option>
        {closureMonthOptions(lead.closureMonth).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="mt-1.5 text-xs text-slate-500">When the order is expected. Update it after every meeting; the forecast follows it.</p>
    </div>
  );
}

function RescheduleForm({ lead, onDone }: { lead: LeadDetail; onDone: () => void }) {
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
      toast.success("Follow-up date moved.");
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-slate-200 bg-white p-3">
      <div>
        <label className="label">New date and time</label>
        <input type="datetime-local" className="field" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <div>
        <label className="label">Why is it moving</label>
        <input className="field" placeholder="Kept in the log" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost btn-sm" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="btn-primary btn-sm" disabled={move.isPending} onClick={save}>
          Save date
        </button>
      </div>
    </div>
  );
}

/** The lead's own details, read first and edited on request. */
function AboutCard({ lead }: { lead: LeadDetail }) {
  const toast = useToast();
  const update = useUpdateLead();
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState({ brandName: lead.brandName, contactPerson: lead.contactPerson, designation: lead.designation, phones: lead.phones.join(", "), email: lead.email, address: lead.address, city: lead.city, state: lead.state });
  const [kinds, setKinds] = useState({ customerTypes: lead.customerTypes, productFormats: lead.productFormats, powderTypes: lead.powderTypes });
  const [source, setSource] = useState<string | null>(lead.leadSource);
  const [error, setError] = useState<string | null>(null);

  function open() {
    setD({ brandName: lead.brandName, contactPerson: lead.contactPerson, designation: lead.designation, phones: lead.phones.join(", "), email: lead.email, address: lead.address, city: lead.city, state: lead.state });
    setKinds({ customerTypes: lead.customerTypes, productFormats: lead.productFormats, powderTypes: lead.powderTypes });
    setSource(lead.leadSource);
    setError(null);
    setEditing(true);
  }

  async function save() {
    setError(null);
    if (!d.brandName.trim()) return setError("Enter the brand / company name.");
    if (kinds.customerTypes.length === 0) return setError("Choose at least one customer type.");
    if (kinds.productFormats.length === 0) return setError("Choose at least one product format.");
    if (kinds.productFormats.includes("Powder") && kinds.powderTypes.length === 0) return setError("Powder is selected: choose its powder type.");
    try {
      await update.mutateAsync({ id: lead.id, ...d, brandName: d.brandName.trim(), phones: d.phones.split(",").map((p) => p.trim()).filter(Boolean), ...kinds, leadSource: source });
      toast.success("Lead saved.");
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const text = (k: keyof typeof d, label: string, wide?: boolean) => (
    <div className={wide ? "sm:col-span-2" : ""}>
      <label className="label">{label}</label>
      <input className="field" value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} />
    </div>
  );

  return (
    <div className="card space-y-4 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-micro font-black uppercase tracking-wider text-slate-400">About the lead</p>
        {!editing && (
          <button type="button" className="btn-ghost btn-sm" onClick={open}>
            <Pencil className="h-3.5 w-3.5" strokeWidth={2.25} /> Edit
          </button>
        )}
      </div>
      {editing && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {text("brandName", "Brand / company name *", true)}
          {text("contactPerson", "Contact person")}
          {text("designation", "Designation")}
          {text("phones", "Contact number (commas between numbers)")}
          {text("email", "Email ID")}
          {text("address", "Address", true)}
          {text("city", "City")}
          {text("state", "State")}
        </div>
      )}
      {!editing && (
        <p className="text-sm text-slate-600">
          {[lead.address, [lead.city, lead.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "No address yet"}
        </p>
      )}
      <LeadKindFields {...kinds} onChange={setKinds} disabled={!editing} />
      <div className="max-w-xs">
        <label className="label">Lead source</label>
        <LeadSourceSelect value={source} onChange={setSource} disabled={!editing} />
      </div>
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      {editing && (
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm" disabled={update.isPending} onClick={save}>
            {update.isPending ? "Saving..." : "Save lead"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Log a meeting: notes (mandatory), the status afterwards, the next follow-up (mandatory unless Dropped) and the closure month. */
function MeetingForm({ lead, onDone }: { lead: LeadDetail; onDone: () => void }) {
  const toast = useToast();
  const add = useAddMeeting();
  const next = lead.meetings.length + 1;
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const [date, setDate] = useState(`${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`);
  const [mode, setMode] = useState<LeadMeetingMode>("CALL");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<LeadStatus>(lead.status === "CONVERTED" ? "HOT" : lead.status);
  const [followUp, setFollowUp] = useState("");
  const [closure, setClosure] = useState(lead.closureMonth ?? "");
  const [estQty, setEstQty] = useState(lead.estimatedQty ?? "");
  const [estValue, setEstValue] = useState(lead.estimatedValueLac != null ? String(lead.estimatedValueLac) : "");
  const [error, setError] = useState<string | null>(null);
  const [triedSave, setTriedSave] = useState(false);
  const needEstimate = lead.sampleApproved && status !== "DROPPED";

  async function save() {
    setError(null);
    setTriedSave(true);
    if (!notes.trim()) return setError("Write the key points of this meeting. It cannot be saved without them.");
    if (status !== "DROPPED" && !followUp) return setError("Choose the next follow-up date and time.");
    if (needEstimate && (!estQty.trim() || !(Number(estValue) > 0))) return setError("Enter the estimated order size (quantity and value in Lac): the sample was approved.");
    try {
      await add.mutateAsync({
        id: lead.id,
        meetingDate: new Date(`${date}T12:00:00`).toISOString(),
        mode,
        notes: notes.trim(),
        statusAfter: status,
        nextFollowUpAt: status === "DROPPED" ? undefined : fromLocalInput(followUp),
        closureMonth: closure || undefined,
        ...(lead.sampleApproved && estQty.trim() && Number(estValue) > 0 ? { estimatedQty: estQty.trim(), estimatedValueLac: Number(estValue) } : {}),
      });
      toast.success(`Meeting ${next} saved.`);
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="mb-5 space-y-4 rounded-2xl border border-brand-200 bg-brand-50/30 p-4">
      <p className="text-sm font-black text-slate-800">Meeting {next}</p>
      <div className="flex flex-wrap gap-3">
        <div>
          <label className="label">Meeting date</label>
          <input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label">How</label>
          <div className="flex gap-1.5">
            {MODES.map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={`rounded-lg border px-3 py-2 text-xs font-bold ${mode === m ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-500"}`}>
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div>
        <label className="label">
          Meeting notes <span className="text-rose-600">· required</span>
        </label>
        <textarea className={`field min-h-[5.5rem] ${triedSave && !notes.trim() ? "!border-rose-400" : ""}`} placeholder="What was discussed, next steps…" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div>
        <label className="label">
          Lead status after this meeting <span className="font-medium text-slate-400">· can change it every time</span>
        </label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {LEAD_STATUS_ORDER.map((s) => {
            const locked = s === "CONVERTED";
            return (
              <button
                key={s}
                type="button"
                disabled={locked}
                aria-pressed={status === s}
                onClick={() => setStatus(s)}
                className={`rounded-xl border px-3 py-2 text-left ${locked ? "cursor-not-allowed border-dashed border-slate-300 bg-slate-50 text-slate-400" : status === s ? "border-2 border-brand-500 bg-brand-50" : "border-slate-200 bg-white hover:border-slate-300"}`}
              >
                <span className={`block text-xs font-black ${locked ? "" : status === s ? "text-brand-700" : "text-slate-800"}`}>
                  {locked ? "🔒 " : status === s ? "✓ " : ""}
                  {LEAD_STATUS_META[s].label}
                </span>
                <span className="block text-micro text-slate-400">{locked ? "Only after the sample is approved" : LEAD_STATUS_META[s].meaning}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label">
            Next follow-up {status === "DROPPED" ? <span className="font-medium text-slate-400">· not asked when Dropped</span> : <span className="text-rose-600">· required</span>}
          </label>
          <input type="datetime-local" className={`field ${triedSave && status !== "DROPPED" && !followUp ? "!border-rose-400" : ""}`} disabled={status === "DROPPED"} value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
        </div>
        <div>
          <label className="label">Closure month</label>
          <select className="field" value={closure} onChange={(e) => setClosure(e.target.value)}>
            <option value="">Not decided</option>
            {closureMonthOptions(closure || null).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {lead.sampleApproved && (
        <div className="grid grid-cols-1 gap-3 rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 sm:grid-cols-2">
          <div>
            <label className="label">
              Estimated quantity / volume {needEstimate && <span className="text-rose-600">· required</span>}
            </label>
            <input className={`field ${triedSave && needEstimate && !estQty.trim() ? "!border-rose-400" : ""}`} placeholder="e.g. 1 ton, 10,000 pcs" value={estQty} onChange={(e) => setEstQty(e.target.value)} />
          </div>
          <div>
            <label className="label">
              Estimated value (Lac) {needEstimate && <span className="text-rose-600">· required</span>}
            </label>
            <input className={`field ${triedSave && needEstimate && !(Number(estValue) > 0) ? "!border-rose-400" : ""}`} type="number" min="0" step="any" value={estValue} onChange={(e) => setEstValue(e.target.value)} />
          </div>
        </div>
      )}
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost btn-sm" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="btn-primary btn-sm" disabled={add.isPending} onClick={save}>
          {add.isPending ? "Saving..." : `Save meeting ${next}`}
        </button>
      </div>
    </div>
  );
}

function MeetingLog({ lead }: { lead: LeadDetail }) {
  if (lead.meetings.length === 0) return <p className="py-6 text-center text-sm text-slate-400">No meeting yet. Add the first one after you talk to them.</p>;
  return (
    <ol className="space-y-0">
      {lead.meetings.map((m, i) => {
        const last = i === lead.meetings.length - 1;
        return (
          <li key={m.id} className="flex gap-3.5">
            <div className="flex flex-col items-center">
              <span className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-xs font-black ${i === 0 ? "bg-brand-500 text-white" : "bg-brand-200 text-brand-900"}`}>{m.number}</span>
              {!last && <span className="mt-1 w-0.5 flex-1 bg-slate-200" />}
            </div>
            <div className={`min-w-0 flex-1 ${last ? "" : "pb-5"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-black text-slate-800">Meeting {m.number}</span>
                <span className="text-xs text-slate-400">
                  {fmtDay(m.meetingDate)} · {MODE_LABEL[m.mode]} · {m.createdByName}
                </span>
                <span className={`pill ${LEAD_STATUS_META[m.statusAfter].pill}`}>{LEAD_STATUS_META[m.statusAfter].label}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{m.notes}</p>
              <p className="mt-1 text-xs text-slate-500">
                {m.nextFollowUpAt ? (
                  <>
                    Next follow-up: <b>{fmtDateTime(m.nextFollowUpAt)}</b>
                  </>
                ) : (
                  "No follow-up set"
                )}
                {m.closureMonth ? (
                  <>
                    {" "}
                    · Closure month: <b>{monthLabel(m.closureMonth)}</b>
                  </>
                ) : null}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
