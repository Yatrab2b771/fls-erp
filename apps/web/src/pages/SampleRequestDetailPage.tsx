import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FlaskConical, Pencil } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useCreateRndSampleRequest, useInventoryItems } from "../lib/hooks";
import {
  FEEDBACK_LABEL,
  FEEDBACK_PILL,
  SAMPLE_STATUS_LABEL,
  SAMPLE_STATUS_PILL,
  TEMPLATE_LABEL,
  sampleAgeing,
  sampleNo,
  useBomUploaded,
  useRndTeam,
  useSampleAction,
  useSampleFeedback,
  useSampleRequest,
  useUpdateRaPart,
  useUpdateRndPart,
  useUpdateSalesPart,
  type SampleFeedback,
  type SampleRequestDetail,
} from "../lib/sampleRequestHooks";
import { ItemPicker } from "../components/ItemPicker";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";

// One sample request, in the colours of the Sample Request Sheet: yellow = Sales (BD), blue = R&D, pink = RA (Regulatory, Gummies only).
// Each department edits only its own colour; everyone else sees it.

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : "Could not save");
const dayYear = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-");
const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

function Part({ tone, title, note, children }: { tone: "yellow" | "blue" | "pink"; title: string; note?: string; children: React.ReactNode }) {
  const t = { yellow: ["border-yellow-300", "bg-yellow-100", "text-yellow-900"], blue: ["border-blue-300", "bg-blue-100", "text-blue-900"], pink: ["border-pink-300", "bg-pink-100", "text-pink-900"] }[tone];
  return (
    <div className={`overflow-hidden rounded-2xl border bg-white ${t[0]}`}>
      <div className={`flex items-center justify-between px-4 py-2 ${t[1]}`}>
        <p className={`text-micro font-black uppercase tracking-wider ${t[2]}`}>{title}</p>
        {note && <span className={`text-micro font-bold ${t[2]}`}>{note}</span>}
      </div>
      <div className="space-y-3 p-4 sm:p-5">{children}</div>
    </div>
  );
}

function Value({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-micro font-black uppercase tracking-wider text-slate-400">{label}</p>
      <div className="mt-0.5 whitespace-pre-wrap text-sm text-slate-800">{children || <span className="text-slate-300">-</span>}</div>
    </div>
  );
}

export function SampleRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { hasRole } = useAuth();
  const { data: r, isLoading } = useSampleRequest(id);

  if (isLoading) return <div className="skeleton h-64 w-full" />;
  if (!r) {
    return (
      <div className="space-y-4">
        <Link to="/sample-requests" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Sample Request
        </Link>
        <EmptyState icon={FlaskConical} title="Sample request not found" hint="It may belong to another salesman." />
      </div>
    );
  }

  const canSales = hasRole("BD", "ADMIN");
  const canRnd = hasRole("RND", "ADMIN");
  const canRa = hasRole("REGULATORY", "ADMIN");
  const ageing = sampleAgeing(r);
  const open = r.status !== "DISPATCHED" && r.status !== "CANNOT_MAKE";

  return (
    <div className="space-y-5">
      <Link to="/sample-requests" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Sample Request
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tight text-slate-900">
            {sampleNo(r.requestNo)} · {r.customerName}
            {r.round > 1 && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 align-middle text-xs font-bold text-amber-800">Round {r.round}</span>}
          </h1>
          <p className="text-sm text-slate-600">
            {TEMPLATE_LABEL[r.template]} · requested {dayYear(r.createdAt)} by {r.pocName} · customer needs it by {dayYear(r.neededBy)} ·{" "}
            <b className={ageing.took ? "text-slate-500" : ageing.days > 7 ? "text-rose-600" : "text-slate-800"}>
              {ageing.days} day{ageing.days === 1 ? "" : "s"} {ageing.took ? "to be Ready" : "since the request"}
            </b>
            {r.leadId && (
              <>
                {" "}
                · <Link to={`/leads/${r.leadId}`} className="font-bold text-brand-700 hover:underline">Lead</Link>
              </>
            )}
          </p>
        </div>
        <span className={`pill ${SAMPLE_STATUS_PILL[r.status]} !px-4 !py-1.5 !text-sm`}>{SAMPLE_STATUS_LABEL[r.status]}</span>
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[999_1_38rem] flex-col gap-4">
          <SalesPart r={r} canEdit={canSales && open} />
          {r.template === "GUMMIES" && <RaPart r={r} canEdit={canRa} />}
          <RndPart r={r} canEdit={canRnd} />
          <FeedbackPart r={r} canGive={canSales} />
          {r.feedback === "APPROVED" && <AfterApproval r={r} canMark={canRnd} />}
        </div>
        <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-4">
          <RmPart r={r} canRaise={canRnd && r.status !== "CANNOT_MAKE"} />
          <Rounds r={r} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function SalesPart({ r, canEdit }: { r: SampleRequestDetail; canEdit: boolean }) {
  const toast = useToast();
  const update = useUpdateSalesPart();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ composition: r.composition, neededBy: dateInput(r.neededBy), dosageForm: r.dosageForm ?? "", quantity: r.quantity ?? "", remarks: r.remarks ?? "", referenceSample: r.referenceSample ?? "" });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!editing) setF({ composition: r.composition, neededBy: dateInput(r.neededBy), dosageForm: r.dosageForm ?? "", quantity: r.quantity ?? "", remarks: r.remarks ?? "", referenceSample: r.referenceSample ?? "" });
  }, [r, editing]);

  async function save() {
    setError(null);
    if (!f.composition.trim()) return setError("Write the composition the customer wants.");
    if (!f.neededBy) return setError("Choose the Customer TAT date.");
    try {
      await update.mutateAsync({ id: r.id, composition: f.composition.trim(), neededBy: f.neededBy, dosageForm: f.dosageForm.trim() || null, quantity: f.quantity.trim() || null, remarks: f.remarks.trim() || null, ...(r.template !== "POWDER" ? { referenceSample: f.referenceSample.trim() || null } : {}) });
      toast.success("Saved. R&D is told.");
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Part tone="yellow" title="Business Development part" note={canEdit ? "BD fills this" : "view only for you"}>
      {editing ? (
        <div className="space-y-3">
          <div>
            <label className="label">Composition</label>
            <textarea className="field min-h-[6rem]" value={f.composition} onChange={(e) => setF({ ...f, composition: e.target.value })} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="label">Customer TAT</label>
              <input type="date" className="field" value={f.neededBy} onChange={(e) => setF({ ...f, neededBy: e.target.value })} />
            </div>
            <div>
              <label className="label">Dosage form</label>
              <input className="field" value={f.dosageForm} onChange={(e) => setF({ ...f, dosageForm: e.target.value })} />
            </div>
            <div>
              <label className="label">Sample quantity</label>
              <input className="field" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
            </div>
          </div>
          {r.template !== "POWDER" && (
            <div>
              <label className="label">Reference sample name</label>
              <input className="field" value={f.referenceSample} onChange={(e) => setF({ ...f, referenceSample: e.target.value })} />
            </div>
          )}
          <div>
            <label className="label">Remarks</label>
            <input className="field" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} />
          </div>
          {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={update.isPending} onClick={save}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <>
          <Value label="Composition">{r.composition}</Value>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Value label="Customer TAT">{dayYear(r.neededBy)}</Value>
            <Value label="Dosage form">{r.dosageForm ?? TEMPLATE_LABEL[r.template]}</Value>
            <Value label="Sample quantity">{r.quantity}</Value>
            <Value label="Client feedback">{r.feedback ? <span className={`pill ${FEEDBACK_PILL[r.feedback]}`}>{FEEDBACK_LABEL[r.feedback]}</span> : null}</Value>
          </div>
          {r.template !== "POWDER" && <Value label="Reference sample">{r.referenceSample}</Value>}
          <Value label="Remarks from Sales">{r.remarks}</Value>
          {canEdit && (
            <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" strokeWidth={2.25} /> Edit
            </button>
          )}
        </>
      )}
    </Part>
  );
}

function RaPart({ r, canEdit }: { r: SampleRequestDetail; canEdit: boolean }) {
  const toast = useToast();
  const update = useUpdateRaPart();
  const [ed, setEd] = useState(r.exportDomestic ?? "");
  const [claim, setClaim] = useState(r.labelClaim ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setEd(r.exportDomestic ?? "");
    setClaim(r.labelClaim ?? "");
  }, [r.exportDomestic, r.labelClaim]);
  async function save() {
    setError(null);
    try {
      await update.mutateAsync({ id: r.id, exportDomestic: (ed || null) as "Export" | "Domestic" | null, labelClaim: claim.trim() || null });
      toast.success("RA part saved.");
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <Part tone="pink" title="RA part · Gummies" note={canEdit ? "Regulatory fills this" : "view only for you"}>
      {canEdit ? (
        <div className="space-y-3">
          <div className="max-w-xs">
            <label className="label">Export / Domestic</label>
            <select className="field" value={ed} onChange={(e) => setEd(e.target.value)}>
              <option value="">Not set</option>
              <option>Export</option>
              <option>Domestic</option>
            </select>
          </div>
          <div>
            <label className="label">Label claim as per FSSAI</label>
            <textarea className="field min-h-[4.5rem]" value={claim} onChange={(e) => setClaim(e.target.value)} />
          </div>
          {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
          <div className="flex justify-end">
            <button type="button" className="btn-primary btn-sm" disabled={update.isPending} onClick={save}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Value label="Export / Domestic">{r.exportDomestic}</Value>
          <div className="sm:col-span-2">
            <Value label="Label claim as per FSSAI">{r.labelClaim}</Value>
          </div>
        </div>
      )}
    </Part>
  );
}

function RndPart({ r, canEdit }: { r: SampleRequestDetail; canEdit: boolean }) {
  const toast = useToast();
  const update = useUpdateRndPart();
  const act = useSampleAction();
  const { data: team } = useRndTeam();
  const [f, setF] = useState({ sampleCode: r.sampleCode ?? "", preparedByName: r.preparedByName ?? "", expectedDate: dateInput(r.expectedDate), preparedOn: dateInput(r.preparedOn), rdRemarks: r.rdRemarks ?? "" });
  const [ask, setAsk] = useState<"HOLD" | "CANNOT_MAKE" | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setF({ sampleCode: r.sampleCode ?? "", preparedByName: r.preparedByName ?? "", expectedDate: dateInput(r.expectedDate), preparedOn: dateInput(r.preparedOn), rdRemarks: r.rdRemarks ?? "" });
  }, [r.sampleCode, r.preparedByName, r.expectedDate, r.preparedOn, r.rdRemarks, r.round]);

  const closed = r.status === "CANNOT_MAKE";
  const names = [...new Set([...(team ?? []).map((t) => t.fullName), ...(r.preparedByName ? [r.preparedByName] : [])])];

  async function save(silent = false) {
    setError(null);
    try {
      await update.mutateAsync({ id: r.id, sampleCode: f.sampleCode.trim() || null, preparedByName: f.preparedByName || null, expectedDate: f.expectedDate || null, preparedOn: f.preparedOn || null, rdRemarks: f.rdRemarks.trim() || null });
      if (!silent) toast.success(!r.expectedDate && f.expectedDate ? "Saved. The ETA is told to Sales." : "Saved.");
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  }

  async function run(action: "START" | "READY" | "DISPATCH" | "HOLD" | "CANNOT_MAKE", why?: string) {
    setError(null);
    // what is typed is saved first, so a sample code entered just before "Ready" is counted
    if (action === "READY" && !(await save(true))) return;
    try {
      await act.mutateAsync({ id: r.id, action, ...(why ? { reason: why } : {}) });
      toast.success(action === "READY" ? "Marked Ready. Sales is told." : action === "DISPATCH" ? "Handed over. Sales can now enter the feedback." : action === "START" ? "Started." : action === "HOLD" ? "Put on hold." : "Closed.");
      setAsk(null);
      setReason("");
    } catch (err) {
      setError(errorText(err));
    }
  }

  const s = r.status;
  return (
    <Part tone="blue" title="Formulation and Development part" note={canEdit ? "R&D fills this" : "view only for you"}>
      {canEdit && !closed ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Sample code</label>
              <input className="field font-mono" value={f.sampleCode} onChange={(e) => setF({ ...f, sampleCode: e.target.value })} />
            </div>
            <div>
              <label className="label">
                Sample prepared by <span className="font-medium text-slate-400">· pick from the R&amp;D team</span>
              </label>
              <select className="field" value={f.preparedByName} onChange={(e) => setF({ ...f, preparedByName: e.target.value })}>
                <option value="">Not set</option>
                {names.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">
                Expected date (ETA) <span className="font-medium text-rose-600">· Sales is told</span>
              </label>
              <input type="date" className="field" value={f.expectedDate} onChange={(e) => setF({ ...f, expectedDate: e.target.value })} />
            </div>
            <div>
              <label className="label">Date of sample preparing</label>
              <input type="date" className="field" value={f.preparedOn} onChange={(e) => setF({ ...f, preparedOn: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="label">R&amp;D remarks</label>
            <input className="field" value={f.rdRemarks} onChange={(e) => setF({ ...f, rdRemarks: e.target.value })} />
          </div>
          {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary btn-sm" disabled={update.isPending} onClick={() => void save()}>
              Save
            </button>
            {["REQUESTED", "PLANNING", "ON_HOLD"].includes(s) && (
              <button type="button" className="btn-ghost btn-sm !border-blue-300 !text-blue-700" disabled={act.isPending} onClick={() => void run("START")}>
                {s === "ON_HOLD" ? "Resume making it" : "Start making it"}
              </button>
            )}
            {["PLANNING", "IN_PROCESS"].includes(s) && (
              <button type="button" className="btn-ghost btn-sm !border-emerald-300 !text-emerald-700" disabled={act.isPending} onClick={() => void run("READY")}>
                Sample is Ready
              </button>
            )}
            {s === "READY" && (
              <button type="button" className="btn-ghost btn-sm !border-cyan-300 !text-cyan-700" disabled={act.isPending} onClick={() => void run("DISPATCH")}>
                Handed over (Dispatched)
              </button>
            )}
            {["REQUESTED", "PLANNING", "IN_PROCESS"].includes(s) && (
              <button type="button" className="btn-ghost btn-sm" onClick={() => setAsk(ask === "HOLD" ? null : "HOLD")}>
                Put on Hold
              </button>
            )}
            {s !== "DISPATCHED" && (
              <button type="button" className="btn-ghost btn-sm !border-rose-200 !text-rose-600" onClick={() => setAsk(ask === "CANNOT_MAKE" ? null : "CANNOT_MAKE")}>
                Cannot make it
              </button>
            )}
          </div>
          {ask && (
            <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="min-w-[16rem] flex-1">
                <label className="label">{ask === "HOLD" ? "Why is it on hold?" : "Why can it not be made?"} (Sales is told)</label>
                <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              <button type="button" className="btn-primary btn-sm" disabled={act.isPending || !reason.trim()} onClick={() => void run(ask, reason.trim())}>
                Confirm
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Value label="Sample code">
              <span className="font-mono">{r.sampleCode}</span>
            </Value>
            <Value label="Prepared by">{r.preparedByName}</Value>
            <Value label="Expected date (ETA)">{dayYear(r.expectedDate)}</Value>
            <Value label="Prepared on">{dayYear(r.preparedOn)}</Value>
          </div>
          <Value label="R&D remarks">{r.rdRemarks}</Value>
        </>
      )}
    </Part>
  );
}

function FeedbackPart({ r, canGive }: { r: SampleRequestDetail; canGive: boolean }) {
  const toast = useToast();
  const give = useSampleFeedback();
  const [choice, setChoice] = useState<SampleFeedback | null>(null);
  const [customer, setCustomer] = useState("");
  const [internal, setInternal] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (r.feedback) {
    return (
      <Part tone="yellow" title="Client feedback">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`pill ${FEEDBACK_PILL[r.feedback]}`}>{FEEDBACK_LABEL[r.feedback]}</span>
          <span className="text-xs text-slate-400">round {r.round}</span>
        </div>
        <Value label="Customer's remark">{r.clientFeedback}</Value>
        <Value label="Internal remark">{r.internalRemark}</Value>
        {r.feedback === "APPROVED" && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-800">Approved. R&amp;D has been told to upload the BOM, and Regulatory has been told to start its work.</p>}
      </Part>
    );
  }
  if (r.status !== "DISPATCHED") {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 px-4 py-3 text-xs text-slate-500">
        <b>Client feedback</b> is entered by BD after the sample is handed over. {r.clientFeedback ? `Last round: "${r.clientFeedback}"` : ""}
      </div>
    );
  }
  if (!canGive) {
    return (
      <div className="rounded-2xl border border-dashed border-yellow-300 bg-yellow-50/50 px-4 py-3 text-xs text-yellow-900">
        <b>Client feedback awaited.</b> BD enters what the customer said.
      </div>
    );
  }

  async function save() {
    setError(null);
    if (!choice) return setError("Choose what the customer said.");
    if (!customer.trim()) return setError("Write the customer's remark.");
    try {
      await give.mutateAsync({ id: r.id, feedback: choice, customerRemark: customer.trim(), internalRemark: internal.trim() || undefined });
      toast.success(choice === "APPROVED" ? "Approved. R&D and Regulatory are told." : choice === "CHANGE_REQUESTED" ? `Saved. Round ${r.round + 1} starts with R&D.` : "Saved.");
    } catch (err) {
      setError(errorText(err));
    }
  }

  const option = (key: SampleFeedback, title: string, hint: string, tone: string) => (
    <button key={key} type="button" aria-pressed={choice === key} onClick={() => setChoice(key)} className={`rounded-xl border px-3 py-2 text-left ${choice === key ? "border-2 border-brand-500 bg-brand-50" : "border-slate-200 bg-white hover:border-slate-300"}`}>
      <span className={`block text-sm font-black ${tone}`}>{choice === key ? "✓ " : ""}{title}</span>
      <span className="block text-micro text-slate-400">{hint}</span>
    </button>
  );

  return (
    <Part tone="yellow" title="Client feedback" note="BD fills this">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {option("APPROVED", "Approved", "No change required", "text-emerald-700")}
        {option("CHANGE_REQUESTED", "Change requested", "What they want goes in the remark", "text-amber-700")}
        {option("REJECTED", "Rejected", "Customer does not want it", "text-rose-700")}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label">
            Customer's remark <span className="text-rose-600">· required</span>
          </label>
          <textarea className="field min-h-[4.5rem]" value={customer} onChange={(e) => setCustomer(e.target.value)} />
        </div>
        <div>
          <label className="label">
            Internal remark <span className="font-medium text-slate-400">· only our team sees it</span>
          </label>
          <textarea className="field min-h-[4.5rem]" value={internal} onChange={(e) => setInternal(e.target.value)} />
        </div>
      </div>
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      <div className="flex justify-end">
        <button type="button" className="btn-primary btn-sm" disabled={give.isPending} onClick={save}>
          Save feedback
        </button>
      </div>
    </Part>
  );
}

function RmPart({ r, canRaise }: { r: SampleRequestDetail; canRaise: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const raise = useCreateRndSampleRequest();
  const { data: items } = useInventoryItems("RM");
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState("");
  const [error, setError] = useState<string | null>(null);
  const item = (items ?? []).find((i) => i.id === itemId);

  async function submit() {
    setError(null);
    if (!item) return setError("Choose the raw material.");
    const n = Number(qty);
    if (!(n > 0)) return setError("Enter the quantity.");
    try {
      await raise.mutateAsync({ itemId: item.id, quantity: n, unit: item.unit ?? "Kg", note: `For ${sampleNo(r.requestNo)}`, sampleRequestId: r.id });
      await qc.invalidateQueries({ queryKey: ["sample-requests"] });
      toast.success("Raw material request sent to the Store.");
      setItemId("");
      setQty("");
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="card p-4">
      <p className="text-micro font-black uppercase tracking-wider text-slate-400">Raw material for this sample</p>
      {r.rmRequests.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">No raw material asked yet.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {r.rmRequests.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2 text-xs">
              <span className="font-bold text-slate-700">{m.itemName}</span>
              <span className="text-slate-500">
                {m.quantity} {m.unit} · {m.status.toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canRaise && (
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          <ItemPicker items={items ?? []} value={itemId} onChange={setItemId} placeholder="— Select a raw material —" />
          <div className="flex gap-2">
            <input className="field font-mono" type="number" min="0" step="any" placeholder={`Quantity${item?.unit ? ` (${item.unit})` : ""}`} value={qty} onChange={(e) => setQty(e.target.value)} />
            <button type="button" className="btn-primary btn-sm shrink-0" disabled={raise.isPending} onClick={submit}>
              Ask Store
            </button>
          </div>
          {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
          <p className="text-micro text-slate-400">Goes to the Store like any R&amp;D raw-material request, tied to this sample.</p>
        </div>
      )}
    </div>
  );
}

function Rounds({ r }: { r: SampleRequestDetail }) {
  if (r.rounds.length === 0) return null;
  return (
    <div className="card p-4">
      <p className="mb-2 text-micro font-black uppercase tracking-wider text-slate-400">Finished rounds</p>
      <ol className="space-y-3">
        {r.rounds.map((x) => (
          <li key={x.id} className="text-xs text-slate-600">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-black text-slate-800">Round {x.round}</span>
              <span className={`pill ${FEEDBACK_PILL[x.feedback]}`}>{FEEDBACK_LABEL[x.feedback]}</span>
            </div>
            <p className="mt-0.5 font-mono text-slate-500">
              {x.sampleCode ?? "no code"} · {x.preparedByName ?? "-"} · handed over {dayYear(x.dispatchedAt)}
            </p>
            <p className="mt-0.5">“{x.customerRemark}”</p>
            {x.internalRemark && <p className="text-slate-400">Internal: {x.internalRemark}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** After the customer approves: R&D uploads the BOM and Regulatory starts its work; then BD converts the lead and enters the PO. */
function AfterApproval({ r, canMark }: { r: SampleRequestDetail; canMark: boolean }) {
  const toast = useToast();
  const mark = useBomUploaded();
  const [error, setError] = useState<string | null>(null);
  async function done() {
    setError(null);
    try {
      await mark.mutateAsync(r.id);
      toast.success("BOM marked as uploaded. BD is told.");
    } catch (err) {
      setError(errorText(err));
    }
  }
  const step = (ok: boolean, title: string, text: React.ReactNode) => (
    <li className="flex gap-3">
      <span className={`mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-black ${ok ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-500"}`}>{ok ? "✓" : "•"}</span>
      <div className="min-w-0 text-sm">
        <p className="font-bold text-slate-800">{title}</p>
        <div className="text-xs text-slate-500">{text}</div>
      </div>
    </li>
  );
  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 sm:p-5">
      <p className="mb-3 text-micro font-black uppercase tracking-wider text-emerald-800">After approval: what happens next</p>
      <ol className="space-y-3">
        {step(true, "Customer approved the sample", "R&D and Regulatory were told at the same time.")}
        {step(
          !!r.bomUploadedAt,
          "R&D uploads the BOM",
          <>
            {r.bomUploadedAt ? `Uploaded on ${dayYear(r.bomUploadedAt)}.` : "Production cannot be planned without it."}{" "}
            <Link to="/bom-board" className="font-bold text-brand-700 hover:underline">
              Open the BOM pages
            </Link>
            {canMark && !r.bomUploadedAt && (
              <button type="button" className="btn-primary btn-sm ml-2" disabled={mark.isPending} onClick={done}>
                Mark BOM as uploaded
              </button>
            )}
          </>,
        )}
        {step(false, "Regulatory starts its work", "Production is not released until Regulatory has approved the product.")}
        {step(false, "BD converts the lead and enters the PO", r.leadId ? <Link to={`/leads/${r.leadId}`} className="font-bold text-brand-700 hover:underline">Open the lead</Link> : "Open the customer's order from the PO page.")}
      </ol>
      {error && <p className="mt-2 text-xs font-bold text-rose-600">{error}</p>}
    </div>
  );
}
