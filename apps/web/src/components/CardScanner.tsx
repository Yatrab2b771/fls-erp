import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as XLSX from "xlsx";
import { AlertTriangle, ArrowLeft, Building2, Camera, Check, ChevronRight, Contact, Download, FileEdit, ImageUp, Layers, Loader2, Search, UserRound } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fromVisitingCards } from "../lib/backTo";
import { SURE_ENOUGH, downloadVcf, findDuplicateCards, useBusinessCards, useCardEvent, useCardEvents, useCardPhoto, useScanCard, type BusinessCard } from "../lib/businessCardHooks";
import { LEAD_STATUS_META, fmtDay, guessCityState, useCreateLead, useLeads, type Lead } from "../lib/leadHooks";
import { LeadKindFields } from "./LeadPickers";
import { PRODUCT_FORMATS } from "../lib/leadHooks";
import { addReportSheet, stampedName } from "../lib/excelReport";
import { useToast } from "./Toast";

// The visiting-card home. Scanning is the QUICK scan, the same for every department (made for an event): one tap on a photo saves the card at once,
// with the event's name, and it is read in the background while the person scans the next one. The person then checks the card from "My cards"
// (everyone) or "Waiting for your check" (BD). BD's check is the review screen: brand, contact, address, customer type, formats -> Save, which makes
// the card a LEAD (handing it to whoever follows it up is done from the card list's "Make lead"), and the next screen offers "Add 1st meeting".
// A card typed in by hand is reviewed the same way (BD) or saved as a card (everyone else).

const CARD_FORMAT_NAMES: Record<string, string> = { Bar: "Bars", Gummy: "Gummies", Tablet: "Tablets", Capsule: "Capsules" };
const asFormats = (categories: string[]) => [...new Set(categories.map((c) => CARD_FORMAT_NAMES[c] ?? c).filter((c) => (PRODUCT_FORMATS as readonly string[]).includes(c)))];

type Kinds = { customerTypes: string[]; productFormats: string[]; powderTypes: string[] };
type Step =
  | { name: "home" }
  | { name: "review"; card: BusinessCard | null }
  | { name: "saved"; lead: Lead; card: BusinessCard | null };

function Screen({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack} className="rounded-xl border border-slate-200 bg-white p-2 text-brand-600 hover:bg-slate-50" aria-label="Back">
          <ArrowLeft className="h-4 w-4" strokeWidth={2.5} />
        </button>
        <h2 className="text-lg font-black text-slate-900">{title}</h2>
      </div>
      {children}
    </div>
  );
}

export function CardScanner({ onShowSaved, onOpenCard, onNewCard }: { onShowSaved: () => void; onOpenCard: (c: BusinessCard) => void; onNewCard: () => void }) {
  const { hasRole } = useAuth();
  const canLead = hasRole("BD");
  const [step, setStep] = useState<Step>({ name: "home" });
  const [kinds, setKinds] = useState<Kinds>({ customerTypes: [], productFormats: [], powderTypes: [] });

  const home = () => {
    setKinds({ customerTypes: [], productFormats: [], powderTypes: [] });
    setStep({ name: "home" });
  };

  switch (step.name) {
    case "home":
      return (
        <CardHome
          canLead={canLead}
          onOpenCard={onOpenCard}
          onManual={() => {
            if (!canLead) return onNewCard(); // only BD makes a lead on the spot; others save the card
            setKinds({ customerTypes: [], productFormats: [], powderTypes: [] });
            setStep({ name: "review", card: null });
          }}
          onResume={(c) => {
            setKinds({ customerTypes: [], productFormats: asFormats(c.categories), powderTypes: [] });
            setStep({ name: "review", card: c });
          }}
          onShowSaved={onShowSaved}
        />
      );
    case "review":
      return <CardReview card={step.card} kinds={kinds} setKinds={setKinds} onBack={home} onSaved={(lead, card) => setStep({ name: "saved", lead, card })} />;
    case "saved":
      return <CardSaved lead={step.lead} card={step.card} onAnother={home} />;
  }
}

// ---------------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------------------------------------------------

function LeadThumb({ lead }: { lead: Lead }) {
  const photo = useCardPhoto(lead.businessCardId, !!lead.businessCardId);
  return photo ? <img src={photo} alt="" className="h-14 w-20 flex-none rounded-lg border border-slate-200 object-cover" /> : <div className="flex h-14 w-20 flex-none items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Building2 className="h-5 w-5" /></div>;
}

function CardHome({ canLead, onOpenCard, onManual, onResume, onShowSaved }: { canLead: boolean; onOpenCard: (c: BusinessCard) => void; onManual: () => void; onResume: (c: BusinessCard) => void; onShowSaved: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const quickCamera = useRef<HTMLInputElement>(null);
  const quickGallery = useRef<HTMLInputElement>(null);
  const quick = useScanCard();
  const [event, setEvent] = useCardEvent();
  const { data: events } = useCardEvents();
  const { data: cards } = useBusinessCards();
  const { data: leads } = useLeads();
  // BD sees every card; this screen is about the ones this person collected
  const mine = useMemo(() => (cards ?? []).filter((c) => c.collectedBy.id === user?.id), [cards, user?.id]);
  const scanned = mine.length;
  const unfinished = mine.filter((c) => c.status === "NEEDS_VERIFY");
  const reading = mine.filter((c) => c.status === "READING");

  // One tap on a photo: it is saved at once and read in the background, so the next card can be scanned straight away
  async function quickScan(files: FileList | null) {
    const list = [...(files ?? [])];
    let ok = 0;
    for (const file of list) {
      try {
        await quick.mutateAsync({ photo: file, categories: [], event: event.trim() });
        ok += 1;
      } catch (err) {
        toast.error(`${file.name || "Photo"}: ${err instanceof ApiError ? err.message : "could not be saved"}`);
      }
    }
    if (ok) toast.success(ok === 1 ? "Saved. It is being read: scan the next card." : `${ok} cards saved. They are being read.`);
  }
  const recent = useMemo(() => [...(leads ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5), [leads]);

  function exportMine() {
    const rows = (leads ?? []).map((l) => ({
      "Brand Name": l.brandName,
      "Contact Person": l.contactPerson,
      Designation: l.designation,
      "Contact Number": l.phones.join(", "),
      "Email ID": l.email,
      Address: l.address,
      City: l.city,
      State: l.state,
      "Customer Type": l.customerTypes.join(", "),
      "Product Formats": l.productFormats.map((p) => (p === "Powder" && l.powderTypes.length ? `Powder: ${l.powderTypes.join(", ")}` : p)).join(", "),
      "Lead Status": LEAD_STATUS_META[l.status].label,
      Meetings: l.meetingCount,
      Added: fmtDay(l.createdAt),
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "My Cards", "FLS BD: my visiting cards and leads", "All", rows);
    XLSX.writeFile(wb, stampedName("FLS_My_Cards"));
  }

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500 text-sm font-black text-white shadow">FLS</div>
        <div>
          <p className="text-micro font-black uppercase tracking-wider text-brand-600">Fermentis Life Science</p>
          <p className="text-xl font-black text-slate-900">{user?.fullName ?? "BD"}</p>
        </div>
      </div>

      <div className="card space-y-4 p-5">
        <div>
          <p className="text-2xl font-black text-slate-900">{canLead ? "Instant Card Scanner" : "Collect visiting cards"}</p>
          <p className="mt-1 text-sm text-slate-500">{canLead ? "Scan visiting cards fast (each is read in the background), then turn the cards into leads and hand them to whoever follows them up." : "Take a photo of every card you collect. It is saved at once and read in the background, so scan the next one straight away. BD follows the cards up."}</p>
        </div>
        <div>
          <label className="label">Event</label>
          <input className="field" list="card-events" value={event} onChange={(e) => setEvent(e.target.value)} placeholder="e.g. Expo Delhi 2026: every card you scan gets this name" />
          <datalist id="card-events">
            {(events ?? []).map((ev) => (
              <option key={ev} value={ev} />
            ))}
          </datalist>
        </div>
        <input ref={quickCamera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { void quickScan(e.target.files); e.target.value = ""; }} />
        <input ref={quickGallery} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { void quickScan(e.target.files); e.target.value = ""; }} />
        <button type="button" className="btn-primary h-14 w-full justify-center text-base" disabled={quick.isPending} onClick={() => quickCamera.current?.click()}>
          {quick.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" strokeWidth={2.25} />} Scan Visiting Card
        </button>
        <button type="button" className="btn-ghost h-12 w-full justify-center text-sm" onClick={onManual}>
          <FileEdit className="h-4 w-4" strokeWidth={2.25} /> Add Card Manually
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="card p-4">
          <Layers className="h-5 w-5 text-brand-600" />
          <p className="mt-2 text-3xl font-black text-slate-900">{scanned}</p>
          <p className="text-sm text-slate-500">Cards you scanned{reading.length ? ` (${reading.length} being read)` : ""}</p>
        </div>
        <button type="button" onClick={() => quickGallery.current?.click()} className="card p-4 text-left hover:border-brand-300">
          <ImageUp className="h-5 w-5 text-brand-600" />
          <p className="mt-2 text-lg font-black text-brand-700">Upload Cards</p>
          <p className="text-sm text-slate-500">Choose one or many card photos from the gallery</p>
        </button>
      </div>

      <button type="button" onClick={onShowSaved} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-brand-200 bg-brand-50/60 py-3 text-sm font-black text-brand-700 hover:bg-brand-50">
        <Search className="h-4 w-4" strokeWidth={2.5} /> View Saved Cards
      </button>
      {canLead && <button type="button" onClick={exportMine} disabled={(leads ?? []).length === 0} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white py-3 text-sm font-black text-slate-700 hover:bg-slate-50 disabled:opacity-50">
        <Download className="h-4 w-4" strokeWidth={2.5} /> Export My Data
      </button>}

      {!canLead && mine.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-black text-slate-900">My cards ({mine.length})</p>
          {mine.slice(0, 8).map((c) => (
            <button key={c.id} type="button" disabled={c.status === "READING"} onClick={() => onOpenCard(c)} className={`flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left ${c.status === "VERIFIED" ? "border-emerald-200 bg-emerald-50/50" : "border-amber-200 bg-amber-50"}`}>
              <span className="min-w-0">
                <span className="block truncate text-sm font-black text-slate-800">{c.status === "READING" ? "Reading the card…" : c.company || c.name || "Scanned card"}</span>
                <span className="block text-xs text-slate-500">
                  {c.status === "READING" ? "Saved. The details fill in by themselves." : c.status === "VERIFIED" ? "Verified" : c.readError ? c.readError : "Read. Tap to check the details and choose the category."}
                  {c.event ? ` · ${c.event}` : ""}
                </span>
                {c.duplicateOf && <span className="block text-xs font-bold text-amber-700">Possible duplicate of {c.duplicateOf.name || c.duplicateOf.company} (added by {c.duplicateOf.addedBy})</span>}
              </span>
              {c.status === "READING" ? <Loader2 className="h-4 w-4 flex-none animate-spin text-brand-600" /> : <ChevronRight className="h-4 w-4 flex-none text-slate-400" />}
            </button>
          ))}
        </div>
      )}

      {canLead && unfinished.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-black text-amber-700">Waiting for your check ({unfinished.length})</p>
          {unfinished.map((c) => (
            <button key={c.id} type="button" onClick={() => onResume(c)} className="flex w-full items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left">
              <span className="min-w-0">
                <span className="block truncate text-sm font-black text-slate-800">{c.company || c.name || "Scanned card"}</span>
                <span className="block text-xs text-amber-700">Scanned, not saved yet. Tap to check the details.</span>
              </span>
              <ChevronRight className="h-4 w-4 flex-none text-amber-600" />
            </button>
          ))}
        </div>
      )}

      {canLead && (
      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-lg font-black text-slate-900">Recent cards</p>
          <Link to="/leads" className="text-sm font-black text-brand-600 hover:underline">
            See all
          </Link>
        </div>
        {recent.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-400">No card yet. Scan the first one.</p>
        ) : (
          <div className="space-y-3">
            {recent.map((l) => (
              <Link key={l.id} to={`/leads/${l.id}`} {...fromVisitingCards()} className="card block space-y-2.5 p-4 hover:border-brand-300">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-base font-black text-slate-900">{l.brandName}</p>
                    <p className="text-xs text-slate-400">{[l.city, l.state].filter(Boolean).join(", ") || "-"}</p>
                  </div>
                  <ChevronRight className="h-5 w-5 flex-none text-brand-500" />
                </div>
                <div className="flex gap-3 rounded-xl bg-slate-50 p-2.5">
                  <LeadThumb lead={l} />
                  <div className="min-w-0 text-sm">
                    <p className="flex items-center gap-1.5 font-bold text-slate-800">
                      <UserRound className="h-3.5 w-3.5 text-brand-500" /> {l.contactPerson || "-"}
                    </p>
                    <p className="truncate text-xs text-slate-500">{l.designation}</p>
                    <p className="truncate font-mono text-xs text-brand-700">{l.phones[0] ?? ""}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {l.productFormats.map((p) => (
                    <span key={p} className="rounded-full border border-brand-200 bg-brand-50 px-2.5 py-0.5 text-xs font-bold text-brand-700">
                      {p === "Powder" && l.powderTypes.length ? `Powder: ${l.powderTypes.join(", ")}` : p}
                    </span>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
                  <span className={`pill ${LEAD_STATUS_META[l.status].pill}`}>{LEAD_STATUS_META[l.status].label}</span>
                  <span className="text-xs text-slate-400">
                    {l.lastMeeting ? `${l.meetingCount === 1 ? "1st" : `${l.meetingCount}`} meet · ${fmtDay(l.lastMeeting.meetingDate)}` : `Added ${fmtDay(l.createdAt)}`}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Review details
// ---------------------------------------------------------------------------------------------------------------------

function CardReview({ card, kinds, setKinds, onBack, onSaved }: { card: BusinessCard | null; kinds: Kinds; setKinds: (k: Kinds) => void; onBack: () => void; onSaved: (lead: Lead, card: BusinessCard | null) => void }) {
  const toast = useToast();
  const create = useCreateLead();
  const photo = useCardPhoto(card?.id ?? null, !!card?.hasPhoto);
  const guess = guessCityState(card?.address ?? "");
  const [f, setF] = useState({
    brandName: card?.company || card?.name || "",
    contactPerson: card?.name ?? "",
    designation: card?.designation ?? "",
    phones: card?.phones.join(", ") ?? "",
    email: card?.email ?? "",
    address: card?.address ?? "",
    city: guess.city,
    state: guess.state,
  });
  const [error, setError] = useState<string | null>(null);
  const [dups, setDups] = useState<{ id: string; name: string; company: string; addedBy: string }[] | null>(null);
  const [zoom, setZoom] = useState(false);
  const [focus, setFocus] = useState<keyof typeof f | null>(null);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);

  const unsure = (key: string, value: string) => !!card?.confidence && !!value && (card.confidence[key] ?? 1) < SURE_ENOUGH;
  const phoneList = () => f.phones.split(",").map((p) => p.trim()).filter(Boolean);

  async function save(skipDup = false) {
    setError(null);
    if (!f.brandName.trim()) return setError("Enter the brand / company name.");
    if (kinds.customerTypes.length === 0) return setError("Choose at least one customer type.");
    if (kinds.productFormats.length === 0) return setError("Choose at least one product format.");
    if (kinds.productFormats.includes("Powder") && kinds.powderTypes.length === 0) return setError("Powder is selected: choose its powder type.");
    try {
      if (!skipDup && (f.email.trim() || phoneList().length)) {
        const found = await findDuplicateCards({ email: f.email.trim().toLowerCase(), phones: phoneList(), excludeId: card?.id });
        if (found.length) return setDups(found);
      }
      const lead = await create.mutateAsync({
        brandName: f.brandName.trim(),
        contactPerson: f.contactPerson.trim(),
        designation: f.designation.trim(),
        phones: phoneList(),
        email: f.email.trim(),
        address: f.address.trim(),
        city: f.city.trim(),
        state: f.state.trim(),
        ...kinds,
        businessCardId: card?.id,
      });
      toast.success("Visiting card saved.");
      onSaved(lead, card);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  const input = (key: keyof typeof f, label: string, opts: { confKey?: string; textarea?: boolean; type?: string; hint?: string } = {}) => {
    const flagged = opts.confKey ? unsure(opts.confKey, f[key]) : false;
    const cls = `field ${flagged ? "!border-amber-400 !bg-amber-50" : ""}`;
    return (
      <div>
        <label className="label flex items-center gap-2">
          {label}
          {flagged && <span className="text-micro font-bold normal-case text-amber-600">please check</span>}
        </label>
        {opts.textarea ? (
          <textarea className={cls} rows={3} value={f[key]} onFocus={() => setFocus(key)} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
        ) : (
          <input className={cls} type={opts.type ?? "text"} value={f[key]} onFocus={() => setFocus(key)} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
        )}
        {opts.hint && <p className="mt-1 text-xs text-slate-400">{opts.hint}</p>}
      </div>
    );
  };

  return (
    <Screen title={card ? "Review details" : "New card"} onBack={onBack}>
      {card?.hasPhoto && (
        <div className="space-y-2">
          {photo ? (
            <button type="button" onClick={() => setZoom(true)} className="block w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
              <img src={photo} alt="Visiting card" className="max-h-44 w-full object-contain" />
            </button>
          ) : (
            <div className="skeleton h-32 w-full" />
          )}
          {card.ocrLines && card.ocrLines.length > 0 && (
            <details className="rounded-xl border border-slate-200 bg-white px-3 py-2">
              <summary className="cursor-pointer text-xs font-bold text-slate-500">Lines the reader found: tap a field, then a line</summary>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {card.ocrLines.map((l, i) => (
                  <button key={i} type="button" onClick={() => (focus ? setF({ ...f, [focus]: l }) : toast.error("Tap a field first, then tap the line."))} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-left text-xs text-slate-600 hover:border-brand-300 hover:bg-brand-50">
                    {l}
                  </button>
                ))}
              </div>
            </details>
          )}
          {card.status === "NEEDS_VERIFY" && <p className="text-xs font-bold text-amber-600">The reader can make mistakes: please check every field. Highlighted ones it was not sure about.</p>}
        </div>
      )}

      <div className="card space-y-3 p-4 sm:p-5">
        {input("brandName", "Brand Name", { confKey: "company" })}
        {input("contactPerson", "Contact Person", { confKey: "name" })}
        {input("designation", "Designation", { confKey: "designation" })}
        {input("phones", "Contact Number", { confKey: "phone", hint: "Separate multiple numbers with commas" })}
        {input("email", "Email ID", { confKey: "email", type: "email" })}
        {input("address", "Address", { confKey: "address", textarea: true })}
        <div className="grid grid-cols-2 gap-3">
          {input("city", "City")}
          {input("state", "State")}
        </div>
      </div>

      <div className="card p-4 sm:p-5">
        <LeadKindFields {...kinds} onChange={setKinds} />
      </div>

      {dups && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <p className="flex items-center gap-2 font-black">
            <AlertTriangle className="h-4 w-4" /> This contact looks already saved
          </p>
          <ul className="mt-1 list-inside list-disc text-xs">
            {dups.map((d) => (
              <li key={d.id}>
                {d.name || "(no name)"}
                {d.company ? `, ${d.company}` : ""} (added by {d.addedBy})
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary btn-sm" onClick={() => { setDups(null); void save(true); }}>
              Save anyway
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setDups(null)}>
              Go back
            </button>
          </div>
        </div>
      )}
      {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{error}</p>}
      <button type="button" className="btn-primary h-12 w-full justify-center text-sm" disabled={create.isPending} onClick={() => void save()}>
        {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" strokeWidth={2.5} />} Save Card
      </button>

      {zoom && photo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setZoom(false)}>
          <img src={photo} alt="Visiting card" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Saved
// ---------------------------------------------------------------------------------------------------------------------

function CardSaved({ lead, card, onAnother }: { lead: Lead; card: BusinessCard | null; onAnother: () => void }) {
  const navigate = useNavigate();
  const photo = useCardPhoto(lead.businessCardId, !!lead.businessCardId);
  function vcf() {
    const c = { name: lead.contactPerson, company: lead.brandName, designation: lead.designation, phones: lead.phones, email: lead.email, website: "", address: lead.address, gstNo: "", categories: lead.productFormats, notes: "" } as unknown as BusinessCard;
    downloadVcf(c);
  }
  return (
    <div className="mx-auto max-w-xl space-y-5 pt-4 text-center">
      <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-emerald-50 ring-8 ring-emerald-100/60">
        <Check className="h-12 w-12 text-emerald-600" strokeWidth={3} />
      </div>
      <div>
        <h2 className="text-3xl font-black text-slate-900">Visiting Card Saved!</h2>
        <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">{card ? "The card details and its photo are saved with your account, as a lead." : "The details are saved with your account, as a lead."}</p>
      </div>

      <div className="card space-y-3 p-4 text-left">
        <div>
          <p className="text-lg font-black text-slate-900">{lead.brandName}</p>
          <p className="text-xs text-slate-400">{[lead.city, lead.state].filter(Boolean).join(", ") || "-"}</p>
        </div>
        <div className="flex gap-3 rounded-xl bg-slate-50 p-2.5">
          {photo ? <img src={photo} alt="" className="h-16 w-24 flex-none rounded-lg border border-slate-200 object-cover" /> : <div className="flex h-16 w-24 flex-none items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Contact className="h-6 w-6" /></div>}
          <div className="min-w-0 text-sm">
            <p className="font-bold text-slate-800">{lead.contactPerson || "-"}</p>
            <p className="truncate text-xs text-slate-500">{lead.designation}</p>
            <p className="truncate font-mono text-xs text-brand-700">{lead.phones[0] ?? ""}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {lead.productFormats.map((p) => (
            <span key={p} className="rounded-full border border-brand-200 bg-brand-50 px-2.5 py-0.5 text-xs font-bold text-brand-700">
              {p === "Powder" && lead.powderTypes.length ? `Powder: ${lead.powderTypes.join(", ")}` : p}
            </span>
          ))}
        </div>
        <p className="text-right text-xs text-slate-400">{fmtDay(lead.createdAt)}</p>
      </div>

      <div className="space-y-2">
        <button type="button" className="btn-ghost h-12 w-full justify-center text-sm" onClick={vcf}>
          <Contact className="h-4 w-4" strokeWidth={2.25} /> Save to Phone Contacts
        </button>
        <button type="button" className="btn-primary h-12 w-full justify-center text-sm" onClick={() => navigate(`/leads/${lead.id}?meeting=1`, fromVisitingCards())}>
          Add 1st Meeting
        </button>
        <button type="button" className="btn-ghost h-12 w-full justify-center text-sm" onClick={onAnother}>
          <Camera className="h-4 w-4" strokeWidth={2.25} /> Scan Another Card
        </button>
      </div>
    </div>
  );
}
