import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as XLSX from "xlsx";
import { AlertTriangle, ArrowLeft, Building2, Camera, Check, ChevronRight, Contact, Download, FileEdit, ImageUp, Layers, Loader2, Search, UserRound } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { SURE_ENOUGH, downloadVcf, findDuplicateCards, useBusinessCards, useCardPhoto, useScanCard, type BusinessCard } from "../lib/businessCardHooks";
import { LEAD_STATUS_META, fmtDay, guessCityState, useCreateLead, useLeads, type Lead } from "../lib/leadHooks";
import { LeadKindFields } from "./LeadPickers";
import { ChipMulti } from "./LeadPickers";
import { POWDER_TYPES, PRODUCT_FORMATS } from "../lib/leadHooks";
import { addReportSheet, stampedName } from "../lib/excelReport";
import { useToast } from "./Toast";

// The visiting-card flow, step by step like the phone app: Home -> take or pick a photo -> check it -> choose the product formats ->
// the card is read -> review the details (brand, contact, address, customer type, formats) -> Save. Saving makes the card a LEAD, and the next
// screen offers "Add 1st meeting". A card typed in by hand skips the photo and the reading.

const CARD_FORMAT_NAMES: Record<string, string> = { Bar: "Bars", Gummy: "Gummies", Tablet: "Tablets", Capsule: "Capsules" };
const asFormats = (categories: string[]) => [...new Set(categories.map((c) => CARD_FORMAT_NAMES[c] ?? c).filter((c) => (PRODUCT_FORMATS as readonly string[]).includes(c)))];

type Kinds = { customerTypes: string[]; productFormats: string[]; powderTypes: string[] };
type Step =
  | { name: "home" }
  | { name: "preview"; file: File; url: string }
  | { name: "formats"; file: File; url: string }
  | { name: "reading"; file: File; url: string; error?: string }
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

export function CardScanner({ onShowSaved }: { onShowSaved: () => void }) {
  const [step, setStep] = useState<Step>({ name: "home" });
  const [kinds, setKinds] = useState<Kinds>({ customerTypes: [], productFormats: [], powderTypes: [] });
  const scan = useScanCard();

  const home = () => {
    setKinds({ customerTypes: [], productFormats: [], powderTypes: [] });
    setStep({ name: "home" });
  };

  function chosen(file: File | undefined) {
    if (!file) return;
    setStep({ name: "preview", file, url: URL.createObjectURL(file) });
  }

  async function read(file: File, url: string) {
    setStep({ name: "reading", file, url });
    try {
      const card = await scan.mutateAsync({ photo: file, categories: kinds.productFormats });
      setStep({ name: "review", card });
    } catch (err) {
      setStep({ name: "reading", file, url, error: err instanceof ApiError ? err.message : "Could not read the card. Try again." });
    }
  }

  switch (step.name) {
    case "home":
      return (
        <CardHome
          onPhoto={chosen}
          onManual={() => {
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
    case "preview":
      return (
        <Screen title="Preview" onBack={home}>
          <p className="text-sm text-slate-500">Check that the card is in focus and all text is readable.</p>
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
            <img src={step.url} alt="Visiting card" className="max-h-[26rem] w-full object-contain" />
          </div>
          <div className="space-y-2">
            <button type="button" className="btn-primary h-12 w-full justify-center text-sm" onClick={() => setStep({ name: "formats", file: step.file, url: step.url })}>
              <Check className="h-4 w-4" strokeWidth={2.5} /> Use This Photo
            </button>
            <button type="button" className="btn-ghost h-12 w-full justify-center text-sm" onClick={home}>
              <Camera className="h-4 w-4" strokeWidth={2.25} /> Retake
            </button>
          </div>
        </Screen>
      );
    case "formats":
      return (
        <Screen title="Categories" onBack={() => setStep({ name: "preview", file: step.file, url: step.url })}>
          <div className="card space-y-3 p-4 sm:p-5">
            <p className="text-lg font-black text-slate-900">Product Formats</p>
            <p className="text-sm text-slate-500">Choose every product format that applies. Selecting Powder lets you pick its types.</p>
            <FormatsOnly kinds={kinds} setKinds={setKinds} />
          </div>
          <button
            type="button"
            className="btn-primary h-12 w-full justify-center text-sm"
            disabled={kinds.productFormats.length === 0 || (kinds.productFormats.includes("Powder") && kinds.powderTypes.length === 0)}
            onClick={() => void read(step.file, step.url)}
          >
            Continue to text recognition
          </button>
          {kinds.productFormats.length === 0 && <p className="text-xs font-bold text-amber-600">Choose at least one product format.</p>}
          {kinds.productFormats.includes("Powder") && kinds.powderTypes.length === 0 && <p className="text-xs font-bold text-amber-600">Powder is selected: choose its powder type.</p>}
        </Screen>
      );
    case "reading":
      return (
        <Screen title="Reading card" onBack={() => setStep({ name: "formats", file: step.file, url: step.url })}>
          <div className="relative mx-auto max-w-sm overflow-hidden rounded-2xl border border-brand-200 bg-slate-50">
            <img src={step.url} alt="Visiting card" className="max-h-64 w-full object-contain" />
            {!step.error && <div className="absolute inset-x-0 top-0 h-full animate-pulse bg-gradient-to-b from-transparent via-brand-400/25 to-transparent" />}
          </div>
          {step.error ? (
            <div className="space-y-2">
              <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{step.error}</p>
              <div className="flex gap-2">
                <button type="button" className="btn-primary btn-sm" onClick={() => void read(step.file, step.url)}>
                  Try again
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={home}>
                  Retake
                </button>
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-sm items-center justify-center gap-2 rounded-full border border-brand-200 bg-white px-5 py-3 text-sm font-bold text-slate-700 shadow-sm">
              <Loader2 className="h-4 w-4 animate-spin text-brand-600" /> Reading text from the card…
            </div>
          )}
          <p className="text-center text-xs text-slate-400">The card is read on our server and saved only when you press Save.</p>
        </Screen>
      );
    case "review":
      return <CardReview card={step.card} kinds={kinds} setKinds={setKinds} onBack={home} onSaved={(lead, card) => setStep({ name: "saved", lead, card })} />;
    case "saved":
      return <CardSaved lead={step.lead} card={step.card} onAnother={home} />;
  }
}

// ---------------------------------------------------------------------------------------------------------------------

function FormatsOnly({ kinds, setKinds }: { kinds: Kinds; setKinds: (k: Kinds) => void }) {
  const hasPowder = kinds.productFormats.includes("Powder");
  return (
    <div className="space-y-3">
      <ChipMulti options={PRODUCT_FORMATS} value={kinds.productFormats} onChange={(v) => setKinds({ ...kinds, productFormats: v, powderTypes: v.includes("Powder") ? kinds.powderTypes : [] })} />
      {hasPowder && (
        <div className="rounded-xl border border-dashed border-brand-300 bg-brand-50/40 px-3 py-2.5">
          <p className="mb-1.5 text-xs font-bold text-brand-800">Powder type</p>
          <ChipMulti options={POWDER_TYPES} value={kinds.powderTypes} onChange={(v) => setKinds({ ...kinds, powderTypes: v })} small />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------------------------------------------------

function LeadThumb({ lead }: { lead: Lead }) {
  const photo = useCardPhoto(lead.businessCardId, !!lead.businessCardId);
  return photo ? <img src={photo} alt="" className="h-14 w-20 flex-none rounded-lg border border-slate-200 object-cover" /> : <div className="flex h-14 w-20 flex-none items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Building2 className="h-5 w-5" /></div>;
}

function CardHome({ onPhoto, onManual, onResume, onShowSaved }: { onPhoto: (f: File | undefined) => void; onManual: () => void; onResume: (c: BusinessCard) => void; onShowSaved: () => void }) {
  const { user } = useAuth();
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const { data: cards } = useBusinessCards();
  const { data: leads } = useLeads();
  const scanned = (cards ?? []).length;
  const unfinished = (cards ?? []).filter((c) => c.status === "NEEDS_VERIFY");
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
          <p className="text-2xl font-black text-slate-900">Instant Card Scanner</p>
          <p className="mt-1 text-sm text-slate-500">Capture visiting cards, automatically extract the details, and keep every contact as a lead you can follow up.</p>
        </div>
        <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { onPhoto(e.target.files?.[0]); e.target.value = ""; }} />
        <input ref={gallery} type="file" accept="image/*" className="hidden" onChange={(e) => { onPhoto(e.target.files?.[0]); e.target.value = ""; }} />
        <button type="button" className="btn-primary h-14 w-full justify-center text-base" onClick={() => camera.current?.click()}>
          <Camera className="h-5 w-5" strokeWidth={2.25} /> Scan Visiting Card
        </button>
        <button type="button" className="btn-ghost h-12 w-full justify-center text-sm" onClick={onManual}>
          <FileEdit className="h-4 w-4" strokeWidth={2.25} /> Add Card Manually
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="card p-4">
          <Layers className="h-5 w-5 text-brand-600" />
          <p className="mt-2 text-3xl font-black text-slate-900">{scanned}</p>
          <p className="text-sm text-slate-500">Cards scanned</p>
        </div>
        <button type="button" onClick={() => gallery.current?.click()} className="card p-4 text-left hover:border-brand-300">
          <ImageUp className="h-5 w-5 text-brand-600" />
          <p className="mt-2 text-lg font-black text-brand-700">Upload Card</p>
          <p className="text-sm text-slate-500">Choose a card photo from the gallery</p>
        </button>
      </div>

      <button type="button" onClick={onShowSaved} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-brand-200 bg-brand-50/60 py-3 text-sm font-black text-brand-700 hover:bg-brand-50">
        <Search className="h-4 w-4" strokeWidth={2.5} /> View Saved Cards
      </button>
      <button type="button" onClick={exportMine} disabled={(leads ?? []).length === 0} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white py-3 text-sm font-black text-slate-700 hover:bg-slate-50 disabled:opacity-50">
        <Download className="h-4 w-4" strokeWidth={2.5} /> Export My Data
      </button>

      {unfinished.length > 0 && (
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
              <Link key={l.id} to={`/leads/${l.id}`} className="card block space-y-2.5 p-4 hover:border-brand-300">
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
        <button type="button" className="btn-primary h-12 w-full justify-center text-sm" onClick={() => navigate(`/leads/${lead.id}?meeting=1`)}>
          Add 1st Meeting
        </button>
        <button type="button" className="btn-ghost h-12 w-full justify-center text-sm" onClick={onAnother}>
          <Camera className="h-4 w-4" strokeWidth={2.25} /> Scan Another Card
        </button>
      </div>
    </div>
  );
}
