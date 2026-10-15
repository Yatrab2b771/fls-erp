import { useMemo, useState } from "react";
import { CardScanner } from "../components/CardScanner";
import { Link, useNavigate } from "react-router-dom";
import * as XLSX from "xlsx";
import { AlertTriangle, ArrowLeft, Check, Contact, Download, Loader2, Pencil, ScanLine, Search, Trash2, UserPlus, Users, X } from "lucide-react";
import { ApiError } from "../lib/api";
import { useLeads } from "../lib/leadHooks";
import {
  CARD_CATEGORIES,
  SURE_ENOUGH,
  downloadVcf,
  findDuplicateCards,
  useBusinessCards,
  useCardPhoto,
  useCreateCard,
  useCreateCustomerFromCard,
  useDeleteCard,
  useUpdateCard,
  type BusinessCard,
} from "../lib/businessCardHooks";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { RowActionMenu } from "../components/RowActionMenu";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";
import { useTileFilters } from "../lib/tileFilters";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { agingDays, inAgingBuckets } from "../components/AgingCell";

// BD's visiting-card book. Take a photo of a card (or pick one from the gallery): the server reads it, BD checks every field and saves it.
// The fields the reader was not sure about are highlighted. A card can also be typed in by hand. Saved cards can be searched, filtered by
// category, downloaded as Excel, added to the phone's contacts, or turned into a Customer.

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-");
type Tab = "scan" | "saved" | "verify";

export function VisitingCardsPage() {
  const { data, isLoading } = useBusinessCards();
  const [tab, setTab] = useState<Tab>("scan");
  const [editing, setEditing] = useState<BusinessCard | null>(null);
  const cards = data ?? [];
  const saved = cards.filter((c) => c.status === "VERIFIED");
  const toVerify = cards.filter((c) => c.status === "NEEDS_VERIFY");

  // The scanner (like the phone app) is the front door: scan, check, save as a lead. The list of saved cards is behind "View Saved Cards".
  if (tab === "scan") {
    return (
      <div className="space-y-5">
        <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
        </Link>
        <CardScanner onShowSaved={() => setTab("saved")} />
      </div>
    );
  }

  const tabs: [Tab, string, number][] = [
    ["saved", "Saved cards", saved.length],
    ["verify", "Needs verify", toVerify.length],
  ];

  return (
    <div className="space-y-5">
      <button type="button" onClick={() => { setTab("scan"); setEditing(null); }} className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Scan a card
      </button>
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-brand-500/10 text-brand-600">
          <ScanLine className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Saved cards</h1>
          <p className="text-sm text-slate-500">
            {saved.length} saved{toVerify.length ? `, ${toVerify.length} waiting to be verified` : ""}. A card you save is also a lead: open it from the Leads list.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {tabs.map(([k, label, n]) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setTab(k);
              setEditing(null);
            }}
            className={`pill cursor-pointer ${k === tab ? "border-brand-300 bg-brand-50 text-brand-700 ring-2 ring-brand-200" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}
          >
            {label} · {n}
          </button>
        ))}
      </div>

      {editing ? (
        <CardForm key={editing.id} card={editing} initialCategories={editing.categories} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />
      ) : isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : (
        <CardList rows={tab === "saved" ? saved : toVerify} mode={tab} onOpen={(c) => setEditing(c)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 1: categories, then a photo (or typing it in)
// ---------------------------------------------------------------------------------------------------------------------

function CategoryPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const custom = value.filter((v) => !(CARD_CATEGORIES as readonly string[]).includes(v));
  const [othersOn, setOthersOn] = useState(custom.length > 0);
  const toggle = (c: string) => onChange(value.includes(c) ? value.filter((x) => x !== c) : [...value, c]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {CARD_CATEGORIES.map((c) => (
          <button key={c} type="button" onClick={() => toggle(c)} className={`pill cursor-pointer px-3 py-1.5 ${value.includes(c) ? "border-brand-300 bg-brand-50 text-brand-700 ring-2 ring-brand-200" : "border-slate-200 bg-white text-slate-600"}`}>
            {value.includes(c) && <Check className="mr-1 h-3 w-3" strokeWidth={3} />}
            {c}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            if (othersOn) onChange(value.filter((v) => (CARD_CATEGORIES as readonly string[]).includes(v)));
            setOthersOn(!othersOn);
          }}
          className={`pill cursor-pointer px-3 py-1.5 ${othersOn ? "border-brand-300 bg-brand-50 text-brand-700 ring-2 ring-brand-200" : "border-slate-200 bg-white text-slate-600"}`}
        >
          {othersOn && <Check className="mr-1 h-3 w-3" strokeWidth={3} />}Others
        </button>
      </div>
      {othersOn && (
        <input
          className="field max-w-xs"
          placeholder="Write the category (e.g. Softgel)"
          value={custom.join(", ")}
          onChange={(e) => onChange([...value.filter((v) => (CARD_CATEGORIES as readonly string[]).includes(v)), ...e.target.value.split(",").map((s) => s.trim()).filter(Boolean)])}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 2: check the details and save (also used to edit a saved card, or to type one in)
// ---------------------------------------------------------------------------------------------------------------------

type FormState = { name: string; designation: string; company: string; phones: string[]; email: string; website: string; address: string; gstNo: string; notes: string; categories: string[] };
type FieldKey = "name" | "designation" | "company" | "phone" | "email" | "website" | "address" | "gstNo";

function CardForm({ card, initialCategories, onClose, onSaved }: { card: BusinessCard | null; initialCategories: string[]; onClose: () => void; onSaved: (c: BusinessCard) => void }) {
  const toast = useToast();
  const create = useCreateCard();
  const update = useUpdateCard();
  const del = useDeleteCard();
  const photo = useCardPhoto(card?.id ?? null, !!card?.hasPhoto);
  const [f, setF] = useState<FormState>({
    name: card?.name ?? "",
    designation: card?.designation ?? "",
    company: card?.company ?? "",
    phones: card?.phones.length ? card.phones : [""],
    email: card?.email ?? "",
    website: card?.website ?? "",
    address: card?.address ?? "",
    gstNo: card?.gstNo ?? "",
    notes: card?.notes ?? "",
    categories: initialCategories,
  });
  const [focus, setFocus] = useState<{ key: FieldKey; index?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dups, setDups] = useState<{ id: string; name: string; company: string; addedBy: string }[] | null>(null);
  const [zoom, setZoom] = useState(false);
  const isVerified = card?.status === "VERIFIED";
  const busy = create.isPending || update.isPending || del.isPending;

  const unsure = (key: FieldKey, value: string) => !!card?.confidence && !!value && (card.confidence[key] ?? 1) < SURE_ENOUGH && !isVerified;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  // Tapping a line the reader found puts it in the field that was last touched.
  function putLine(text: string) {
    if (!focus) return toast.error("Tap a field first, then tap the line.");
    if (focus.key === "phone") {
      const i = focus.index ?? 0;
      set("phones", f.phones.map((p, j) => (j === i ? text : p)));
    } else set(focus.key, text as never);
  }

  const payload = () => ({ ...f, phones: f.phones.map((p) => p.trim()).filter(Boolean), name: f.name.trim(), company: f.company.trim() });

  async function save(mode: "verify" | "later" | "edit", skipDupCheck = false) {
    setError(null);
    const body = payload();
    if (mode !== "later" && !body.name && !body.company) return setError("Enter at least a name or a company.");
    if (mode !== "later" && body.categories.length === 0) return setError("Choose at least one category.");
    try {
      if (mode !== "later" && !skipDupCheck) {
        const found = await findDuplicateCards({ email: body.email.toLowerCase(), phones: body.phones, excludeId: card?.id });
        if (found.length) return setDups(found);
      }
      const saved = card ? await update.mutateAsync({ id: card.id, ...body, verify: mode === "verify" }) : await create.mutateAsync(body);
      toast.success(mode === "later" ? "Saved. Verify it later from “Needs verify”." : isVerified ? "Changes saved." : "Card saved.");
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function remove() {
    if (!card || !window.confirm("Delete this card? This cannot be undone.")) return;
    try {
      await del.mutateAsync(card.id);
      toast.success("Card deleted.");
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete");
    }
  }

  const input = (key: FieldKey, label: string, value: string, onChange: (v: string) => void, props: { type?: string; textarea?: boolean; placeholder?: string } = {}) => {
    const flagged = unsure(key, value);
    const missing = !!card && card.source === "SCAN" && !isVerified && !value;
    const cls = `field ${flagged ? "!border-amber-400 !bg-amber-50" : ""}`;
    return (
      <div>
        <label className="label flex items-center gap-2">
          {label}
          {flagged && <span className="text-micro font-bold normal-case text-amber-600">please check</span>}
          {missing && <span className="text-micro font-bold normal-case text-slate-400">not found</span>}
        </label>
        {props.textarea ? (
          <textarea className={cls} rows={3} value={value} placeholder={props.placeholder} onFocus={() => setFocus({ key })} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input className={cls} type={props.type ?? "text"} value={value} placeholder={props.placeholder} onFocus={() => setFocus({ key })} onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
    );
  };

  return (
    <div className="card max-w-5xl space-y-4 p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-black text-slate-900">{card ? (isVerified ? "Card details" : "Verify details") : "New card"}</p>
          {card && !isVerified && card.source === "SCAN" && <p className="text-xs font-bold text-amber-600">The reader can make mistakes: please check every field. Highlighted ones it was not sure about.</p>}
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className={`grid grid-cols-1 gap-5 ${card?.hasPhoto ? "lg:grid-cols-[18rem_1fr]" : ""}`}>
        {card?.hasPhoto && (
          <div className="space-y-3">
            {photo ? (
              <button type="button" onClick={() => setZoom(true)} className="block w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                <img src={photo} alt="Visiting card" className="w-full object-contain" />
              </button>
            ) : (
              <div className="skeleton h-40 w-full" />
            )}
            {card.ocrLines && card.ocrLines.length > 0 && (
              <div>
                <p className="mb-1.5 text-micro font-bold uppercase tracking-wide text-slate-400">Lines the reader found: tap a field, then a line</p>
                <div className="flex flex-wrap gap-1.5">
                  {card.ocrLines.map((l, i) => (
                    <button key={i} type="button" onClick={() => putLine(l)} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-left text-xs text-slate-600 hover:border-brand-300 hover:bg-brand-50">
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {input("name", "Name", f.name, (v) => set("name", v))}
            {input("designation", "Designation", f.designation, (v) => set("designation", v))}
            <div className="sm:col-span-2">{input("company", "Company", f.company, (v) => set("company", v))}</div>
          </div>

          <div>
            <label className="label flex items-center gap-2">
              Phone numbers
              {!!card && !isVerified && f.phones.some((p) => p.trim()) && (card.confidence?.phone ?? 1) < SURE_ENOUGH && <span className="text-micro font-bold normal-case text-amber-600">please check</span>}
            </label>
            <div className="space-y-2">
              {f.phones.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <input className={`field ${!!card && !isVerified && p.trim() && (card.confidence?.phone ?? 1) < SURE_ENOUGH ? "!border-amber-400 !bg-amber-50" : ""}`} inputMode="tel" placeholder="e.g. +91 98765 43210" value={p} onFocus={() => setFocus({ key: "phone", index: i })} onChange={(e) => set("phones", f.phones.map((x, j) => (j === i ? e.target.value : x)))} />
                  {f.phones.length > 1 && (
                    <button type="button" className="rounded-lg p-2 text-slate-400 hover:bg-slate-100" aria-label="Remove number" onClick={() => set("phones", f.phones.filter((_, j) => j !== i))}>
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
              {f.phones.length < 6 && (
                <button type="button" className="text-xs font-bold text-brand-600 hover:underline" onClick={() => set("phones", [...f.phones, ""])}>
                  + Add another number
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {input("email", "Email", f.email, (v) => set("email", v), { type: "email" })}
            {input("website", "Website", f.website, (v) => set("website", v))}
            <div className="sm:col-span-2">{input("address", "Address", f.address, (v) => set("address", v), { textarea: true })}</div>
            {input("gstNo", "GST number", f.gstNo, (v) => set("gstNo", v.toUpperCase()))}
            <div>
              <label className="label">Notes</label>
              <input className="field" placeholder="e.g. met at the expo, wants Whey samples" value={f.notes} onChange={(e) => set("notes", e.target.value)} />
            </div>
          </div>

          <div>
            <label className="label">Categories *</label>
            <CategoryPicker value={f.categories} onChange={(v) => set("categories", v)} />
          </div>
        </div>
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
            <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => { setDups(null); void save(card && !isVerified ? "verify" : card ? "edit" : "verify", true); }}>
              Save anyway
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setDups(null)}>
              Go back
            </button>
          </div>
        </div>
      )}
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{error}</p>}

      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void save(isVerified ? "edit" : "verify")}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" strokeWidth={2.5} />} {isVerified ? "Save changes" : card ? "Verify & save" : "Save card"}
        </button>
        {card && !isVerified && (
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => void save("later")}>
            Save for later
          </button>
        )}
        {card && (
          <button type="button" className="btn-ghost text-rose-600" disabled={busy} onClick={remove}>
            <Trash2 className="h-4 w-4" strokeWidth={2.25} /> Delete
          </button>
        )}
      </div>

      {zoom && photo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setZoom(false)}>
          <img src={photo} alt="Visiting card" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Saved cards / Needs verify
// ---------------------------------------------------------------------------------------------------------------------

function CardList({ rows: all, mode, onOpen }: { rows: BusinessCard[]; mode: "saved" | "verify"; onOpen: (c: BusinessCard) => void }) {
  const toast = useToast();
  const del = useDeleteCard();
  const makeCustomer = useCreateCustomerFromCard();
  const navigate = useNavigate();
  const { data: leads } = useLeads();
  const leadOfCard = new Map((leads ?? []).filter((l) => l.businessCardId).map((l) => [l.businessCardId!, l.id]));
  const filters = useTileFilters();
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const distinct = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const fields: FilterField[] = [
    { key: "company", label: "Company", options: distinct(all.map((c) => c.company)) },
    { key: "name", label: "Name", options: distinct(all.map((c) => c.name)) },
    { key: "designation", label: "Designation", options: distinct(all.map((c) => c.designation)) },
    { key: "category", label: "Category", options: distinct(all.flatMap((c) => c.categories)) },
    { key: "addedBy", label: "Added by", options: distinct(all.map((c) => c.createdByName)) },
    AGING_FIELD,
  ];

  const rows = useMemo(() => {
    const { dateFrom, dateTo } = filters.applied;
    return all.filter(
      (c) =>
        (!picked("company").length || picked("company").includes(c.company)) &&
        (!picked("name").length || picked("name").includes(c.name)) &&
        (!picked("designation").length || picked("designation").includes(c.designation)) &&
        (!picked("category").length || c.categories.some((x) => picked("category").includes(x))) &&
        (!picked("addedBy").length || picked("addedBy").includes(c.createdByName)) &&
        inAgingBuckets(agingDays(c.createdAt), picked("aging")) &&
        (!dateFrom || c.createdAt.slice(0, 10) >= dateFrom) &&
        (!dateTo || c.createdAt.slice(0, 10) <= dateTo),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, filters.applied]);
  const pg = useClientPaging(rows);

  function download() {
    const lines = rows.map((c) => ({
      Name: c.name,
      Designation: c.designation,
      Company: c.company,
      "Phone 1": c.phones[0] ?? "",
      "Phone 2": c.phones[1] ?? "",
      "Phone 3": c.phones[2] ?? "",
      Email: c.email,
      Website: c.website,
      Address: c.address,
      "GST No.": c.gstNo,
      Categories: c.categories.join(", "),
      Notes: c.notes,
      "Added By": c.createdByName,
      "Added On": day(c.createdAt),
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Visiting Cards", "FLS BD: Visiting Cards", describeFilters(filters, fields, "Added"), lines);
    XLSX.writeFile(wb, stampedName("FLS_Visiting_Cards"));
  }

  async function remove(c: BusinessCard) {
    if (!window.confirm(`Delete the card of ${c.name || c.company || "this contact"}? This cannot be undone.`)) return;
    try {
      await del.mutateAsync(c.id);
      toast.success("Card deleted.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not delete");
    }
  }

  async function toCustomer(c: BusinessCard) {
    try {
      const r = await makeCustomer.mutateAsync(c.id);
      toast.success(r.existed ? `${r.companyName} is already a customer.` : `${r.companyName} added as a customer.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not create the customer");
    }
  }

  if (all.length === 0) return <EmptyState icon={Contact} title={mode === "saved" ? "No saved cards yet" : "Nothing waiting to be verified"} hint={mode === "saved" ? "Scan a card from the “Scan / Add” tab." : "A scanned card you did not finish shows here."} />;

  return (
    <div className="space-y-3">
      {mode === "saved" && (
        <div className="flex justify-end">
          <button type="button" className="btn-ghost btn-sm" disabled={rows.length === 0} onClick={download}>
            <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
          </button>
        </div>
      )}
      <TileFilterBar filters={filters} tileKey={`visiting-cards-${mode}`} fields={fields} dateLabel="Added" />

      {rows.length === 0 ? (
        <EmptyState icon={Search} title="Nothing matches" hint="Try different filters or press Reset." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2.5">Name</th>
                  <th className="px-3 py-2.5">Designation</th>
                  <th className="px-3 py-2.5">Company</th>
                  <th className="px-3 py-2.5">Phone</th>
                  <th className="px-3 py-2.5">Email</th>
                  <th className="px-3 py-2.5">Categories</th>
                  <th className="px-3 py-2.5">Added</th>
                  <th className="sticky right-0 bg-white px-3 py-2.5 text-right shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.15)]">Action</th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((c) => (
                  <tr key={c.id} className="border-b border-slate-50">
                    <td className="px-3 py-2.5 font-bold text-slate-800">
                      <button type="button" className="text-left hover:text-brand-600" onClick={() => onOpen(c)}>
                        {c.name || "(no name)"}
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{c.designation || "-"}</td>
                    <td className="px-3 py-2.5 text-slate-700">
                      {c.company || "-"}
                      {c.customerId && <span className="pill ml-2 border-emerald-200 bg-emerald-50 text-emerald-700">Customer</span>}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-slate-600">{c.phones.join(", ") || "-"}</td>
                    <td className="px-3 py-2.5 text-slate-600">{c.email || "-"}</td>
                    <td className="px-3 py-2.5 text-slate-600">{c.categories.join(", ") || "-"}</td>
                    <td className="px-3 py-2.5 text-slate-600">{day(c.createdAt)}</td>
                    <td className="sticky right-0 bg-white px-3 py-2.5 text-right shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.15)]">
                      <RowActionMenu
                        actions={[
                          { label: mode === "verify" ? "Check & verify" : "View / edit", icon: mode === "verify" ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : <Pencil className="h-3.5 w-3.5" strokeWidth={2.5} />, onClick: () => onOpen(c) },
                          { label: "Save to phone contacts", icon: <Contact className="h-3.5 w-3.5" strokeWidth={2.5} />, hidden: mode === "verify", onClick: () => downloadVcf(c) },
                          { label: "Create customer", icon: <UserPlus className="h-3.5 w-3.5" strokeWidth={2.5} />, tone: "text-emerald-700", hidden: mode === "verify" || !!c.customerId || !c.company, onClick: () => void toCustomer(c) },
                          { label: leadOfCard.has(c.id) ? "Open lead" : "Make lead", icon: <Users className="h-3.5 w-3.5" strokeWidth={2.5} />, tone: "text-brand-700", hidden: mode === "verify", onClick: () => navigate(leadOfCard.has(c.id) ? `/leads/${leadOfCard.get(c.id)}` : `/leads/new?card=${c.id}`) },
                          { label: "Delete", icon: <Trash2 className="h-3.5 w-3.5" strokeWidth={2.5} />, tone: "text-rose-600", onClick: () => void remove(c) },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ClientPager pg={pg} />
        </div>
      )}
    </div>
  );
}

