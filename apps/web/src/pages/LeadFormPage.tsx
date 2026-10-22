import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useBackTo } from "../lib/backTo";
import { useBusinessCards } from "../lib/businessCardHooks";
import { LEAD_STATUS_META, LEAD_STATUS_ORDER, closureMonthOptions, fromLocalInput, useCreateLead, useLeadAssignees, type LeadStatus } from "../lib/leadHooks";
import { LeadKindFields, LeadSourceSelect } from "../components/LeadPickers";
import { useToast } from "../components/Toast";

// Add a lead by hand, or from a saved visiting card (?card=<id>: the card's details come in filled). Only BD adds leads; BD chooses who follows each one up.

const CARD_FORMATS: Record<string, string> = { Bar: "Bars", Gummy: "Gummies", Powder: "Powder", Liquid: "Liquid", Tablet: "Tablets", Capsule: "Capsules", Bars: "Bars", Gummies: "Gummies", Tablets: "Tablets", Capsules: "Capsules", Omega: "Omega", "Soft gel": "Soft gel", Others: "Others" };

export function LeadFormPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const back = useBackTo({ from: "/leads", label: "Leads" }); // a lead made from a card goes back to the cards
  const cardId = params.get("card");
  const { hasRole } = useAuth();
  const { data: cards } = useBusinessCards();
  const { data: assignees } = useLeadAssignees({ enabled: hasRole("BD") });
  const create = useCreateLead();
  const [assignToId, setAssignToId] = useState(""); // "" = BD themself

  const [brandName, setBrandName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [designation, setDesignation] = useState("");
  const [phones, setPhones] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [kinds, setKinds] = useState({ customerTypes: [] as string[], productFormats: [] as string[], powderTypes: [] as string[] });
  const [leadSource, setLeadSource] = useState<string | null>(null);
  const [status, setStatus] = useState<LeadStatus>("DISCUSSION");
  const [followUp, setFollowUp] = useState("");
  const [closureMonth, setClosureMonth] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [filledFrom, setFilledFrom] = useState<string | null>(null);

  const card = cardId ? cards?.find((c) => c.id === cardId) : undefined;
  useEffect(() => {
    if (!card || filledFrom === card.id) return;
    setFilledFrom(card.id);
    setBrandName(card.company || card.name);
    setContactPerson(card.name);
    setDesignation(card.designation);
    setPhones(card.phones.join(", "));
    setEmail(card.email);
    setAddress(card.address);
    setKinds((k) => ({ ...k, productFormats: [...new Set(card.categories.map((c) => CARD_FORMATS[c]).filter((v): v is string => !!v))] }));
  }, [card, filledFrom]);

  async function submit() {
    setError(null);
    if (!brandName.trim()) return setError("Enter the brand / company name.");
    if (kinds.customerTypes.length === 0) return setError("Choose at least one customer type.");
    if (kinds.productFormats.length === 0) return setError("Choose at least one product format.");
    if (kinds.productFormats.includes("Powder") && kinds.powderTypes.length === 0) return setError("Powder is selected: choose its powder type.");
    try {
      const lead = await create.mutateAsync({
        brandName: brandName.trim(),
        contactPerson: contactPerson.trim(),
        designation: designation.trim(),
        phones: phones.split(",").map((p) => p.trim()).filter(Boolean),
        email: email.trim(),
        address: address.trim(),
        city: city.trim(),
        state: state.trim(),
        ...kinds,
        leadSource,
        status,
        nextFollowUpAt: status === "DROPPED" ? undefined : fromLocalInput(followUp),
        closureMonth: closureMonth || undefined,
        businessCardId: card?.id,
        assignToId: assignToId || undefined,
      });
      toast.success(`${lead.brandName} is added as a lead.`);
      navigate(`/leads/${lead.id}`, back.from === "/leads" ? undefined : { state: { backTo: back } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  if (!hasRole("BD")) {
    return (
      <div className="mx-auto max-w-3xl space-y-3">
        <Link to={back.from} className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> {back.label}
        </Link>
        <p className="card p-5 text-sm text-slate-600">Only BD adds leads. BD hands you a lead to follow up; it then shows in your Leads list.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to={back.from} className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> {back.label}
      </Link>
      <div>
        <h1 className="text-2xl font-black tracking-tight text-slate-900">Add lead</h1>
        <p className="text-sm text-slate-500">{card ? "The details come from the visiting card. Check them and choose the types." : "Add the company you are talking to. You can log the first meeting right after."}</p>
      </div>

      <div className="card space-y-4 p-4 sm:p-5">
        <p className="text-micro font-black uppercase tracking-wider text-slate-400">The company and the contact</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label">Brand / company name *</label>
            <input className="field" value={brandName} onChange={(e) => setBrandName(e.target.value)} />
          </div>
          <div>
            <label className="label">Contact person</label>
            <input className="field" value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} />
          </div>
          <div>
            <label className="label">Designation</label>
            <input className="field" value={designation} onChange={(e) => setDesignation(e.target.value)} />
          </div>
          <div>
            <label className="label">Contact number</label>
            <input className="field" placeholder="Separate several numbers with commas" value={phones} onChange={(e) => setPhones(e.target.value)} />
          </div>
          <div>
            <label className="label">Email ID</label>
            <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Address</label>
            <input className="field" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <div>
            <label className="label">City</label>
            <input className="field" value={city} onChange={(e) => setCity(e.target.value)} />
          </div>
          <div>
            <label className="label">State</label>
            <input className="field" value={state} onChange={(e) => setState(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card space-y-4 p-4 sm:p-5">
        <p className="text-micro font-black uppercase tracking-wider text-slate-400">What they do and what they want</p>
        <LeadKindFields {...kinds} onChange={setKinds} />
        <div className="max-w-xs">
          <label className="label">Lead source</label>
          <LeadSourceSelect value={leadSource} onChange={setLeadSource} />
        </div>
      </div>

      <div className="card space-y-3 p-4 sm:p-5">
        <p className="text-micro font-black uppercase tracking-wider text-slate-400">Where it stands</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="label">Lead status</label>
            <select className="field" value={status} onChange={(e) => setStatus(e.target.value as LeadStatus)}>
              {LEAD_STATUS_ORDER.filter((s) => s !== "CONVERTED").map((s) => (
                <option key={s} value={s}>
                  {LEAD_STATUS_META[s].label} ({LEAD_STATUS_META[s].meaning.toLowerCase()})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Next follow-up</label>
            <input type="datetime-local" className="field" disabled={status === "DROPPED"} value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
          </div>
          <div>
            <label className="label">Closure month</label>
            <select className="field" value={closureMonth} onChange={(e) => setClosureMonth(e.target.value)}>
              <option value="">Not decided</option>
              {closureMonthOptions(null).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="max-w-sm">
          <label className="label">Who follows this lead up</label>
          <select className="field" value={assignToId} onChange={(e) => setAssignToId(e.target.value)}>
            <option value="">Me</option>
            {(assignees ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}{u.department ? ` (${u.department})` : ""}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-400">Any department. They see the lead in their Leads list and log its meetings; you can hand it to someone else later.</p>
        </div>
        <p className="text-xs text-slate-400">Converted is not offered here: it comes after the sample is approved, and only BD converts a lead.</p>
      </div>

      {error && <p className="text-sm font-bold text-rose-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <Link to={back.from} className="btn-ghost btn-sm">
          Cancel
        </Link>
        <button type="button" className="btn-primary btn-sm" disabled={create.isPending} onClick={submit}>
          {create.isPending ? "Saving..." : "Add lead"}
        </button>
      </div>
    </div>
  );
}
