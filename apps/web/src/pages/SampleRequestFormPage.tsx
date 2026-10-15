import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useCreateCustomer, useCustomers } from "../lib/hooks";
import { useLead } from "../lib/leadHooks";
import { TEMPLATE_LABEL, sampleNo, useCreateSampleRequest, type SampleTemplate } from "../lib/sampleRequestHooks";
import { PickerWithAdd } from "../components/PickerWithAdd";
import { useToast } from "../components/Toast";

// BD raises a sample request (the yellow part of the Sample Request Sheet). From a lead (?lead=<id>) the company, POC and date come filled in.

const TEMPLATES: SampleTemplate[] = ["POWDER", "GUMMIES", "BARS"];
const DOSAGE_DEFAULT: Record<SampleTemplate, string> = { POWDER: "Powder", GUMMIES: "Gummies", BARS: "Bars" };

export function SampleRequestFormPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const leadId = params.get("lead") ?? undefined;
  const { data: lead } = useLead(leadId);
  const { data: customers } = useCustomers();
  const createCustomer = useCreateCustomer();
  const create = useCreateSampleRequest();

  const [template, setTemplate] = useState<SampleTemplate>("POWDER");
  const [customerId, setCustomerId] = useState("");
  const [composition, setComposition] = useState("");
  const [neededBy, setNeededBy] = useState("");
  const [dosageForm, setDosageForm] = useState("");
  const [quantity, setQuantity] = useState("");
  const [remarks, setRemarks] = useState("");
  const [referenceSample, setReferenceSample] = useState("");
  const [error, setError] = useState<string | null>(null);

  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  async function submit() {
    setError(null);
    if (!leadId && !customerId) return setError("Choose the customer this sample is for.");
    if (!composition.trim()) return setError("Write the composition the customer wants.");
    if (!neededBy) return setError("Choose the date the customer needs the sample by (Customer TAT).");
    try {
      const r = await create.mutateAsync({
        ...(leadId ? { leadId } : { customerId }),
        template,
        composition: composition.trim(),
        neededBy,
        dosageForm: dosageForm.trim() || DOSAGE_DEFAULT[template],
        quantity: quantity.trim() || undefined,
        remarks: remarks.trim() || undefined,
        referenceSample: template === "POWDER" ? undefined : referenceSample.trim() || undefined,
      });
      toast.success(`${sampleNo(r.requestNo)} is sent to R&D.`);
      navigate(`/sample-requests/${r.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  const autoBox = (label: string, value: string, note: string) => (
    <div className="min-w-[10rem] flex-1">
      <label className="label">{label}</label>
      <div className="field bg-slate-50 text-slate-500">
        {value} <span className="text-micro">· {note}</span>
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to={leadId ? `/leads/${leadId}` : "/sample-requests"} className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> {leadId ? "Lead" : "Sample Request"}
      </Link>
      <div>
        <h1 className="text-2xl font-black tracking-tight text-slate-900">New sample request</h1>
        <p className="text-sm text-slate-500">{leadId ? "Opened from the lead. The company comes from it." : "Choose the customer, or open it from a lead whose status is Sampling."}</p>
      </div>

      <div className="flex gap-1.5">
        {TEMPLATES.map((t) => (
          <button key={t} type="button" aria-pressed={template === t} onClick={() => setTemplate(t)} className={`rounded-xl border px-5 py-2.5 text-sm font-bold ${template === t ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-500"}`}>
            {TEMPLATE_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-yellow-300 bg-white">
        <div className="bg-yellow-100 px-4 py-2">
          <p className="text-micro font-black uppercase tracking-wider text-yellow-900">Business Development part · you fill this</p>
        </div>
        <div className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap gap-3">
            {autoBox("Request date", today, "automatic")}
            {autoBox("POC name", user?.fullName ?? "You", "from your login")}
            {leadId ? (
              autoBox("Company name", lead?.brandName ?? "…", "from the lead")
            ) : (
              <div className="min-w-[14rem] flex-[2]">
                <PickerWithAdd
                  label="Company name *"
                  placeholder="Choose the customer"
                  options={(customers ?? []).map((c) => ({ id: c.id, name: c.companyName }))}
                  value={customerId}
                  onChange={setCustomerId}
                  onCreate={async (name) => {
                    const c = await createCustomer.mutateAsync({ companyName: name });
                    return { id: c.id };
                  }}
                />
              </div>
            )}
          </div>
          <div>
            <label className="label">
              Composition <span className="text-rose-600">· required</span> <span className="font-medium text-slate-400">· type it, or paste from the customer's email</span>
            </label>
            <textarea className="field min-h-[7rem]" value={composition} onChange={(e) => setComposition(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="label">
                Customer TAT <span className="text-rose-600">· required</span>
              </label>
              <input type="date" className="field" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
            </div>
            <div>
              <label className="label">Dosage form</label>
              <input className="field" placeholder={DOSAGE_DEFAULT[template]} value={dosageForm} onChange={(e) => setDosageForm(e.target.value)} />
            </div>
            <div>
              <label className="label">Sample quantity</label>
              <input className="field" placeholder="e.g. Standard x 3, 10 gummies" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </div>
          </div>
          {template !== "POWDER" && (
            <div>
              <label className="label">Reference sample name (if available)</label>
              <input className="field" placeholder="The benchmark product, or a link" value={referenceSample} onChange={(e) => setReferenceSample(e.target.value)} />
            </div>
          )}
          <div>
            <label className="label">Remarks</label>
            <input className="field" placeholder="Taste, sugar, benchmark, anything R&D should know" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </div>
          <p className="text-xs text-slate-400">Client feedback is filled later, after the sample is given.</p>
        </div>
      </div>

      <div className="rounded-2xl border border-blue-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
        <b className="text-blue-900">Formulation and Development part</b> (sample code, prepared by, expected date, remarks) is filled by R&amp;D. You can see it on the request.
      </div>

      {error && <p className="text-sm font-bold text-rose-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <Link to={leadId ? `/leads/${leadId}` : "/sample-requests"} className="btn-ghost btn-sm">
          Cancel
        </Link>
        <button type="button" className="btn-primary btn-sm" disabled={create.isPending} onClick={submit}>
          {create.isPending ? "Sending..." : "Send to R&D"}
        </button>
      </div>
    </div>
  );
}
