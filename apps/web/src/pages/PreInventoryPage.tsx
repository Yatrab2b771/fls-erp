import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { CheckCircle2, Clock, ClipboardList, Download, FileSpreadsheet, Package, Plus, ShoppingCart, Trash2, Truck, Upload, UserPlus, Warehouse } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useCreateInventoryItem, useCreateRequirement, useDeleteRequirement, useImportPurchaseLog, useImportRequirements, useInventoryItems, useInventoryVendors, usePreInventoryRequirements, useSetRequirementPurchase } from "../lib/hooks";
import type { InventoryCategory, PreInventoryRequirement } from "../lib/types";
import { parsePurchaseLogWorkbook, parseRequirementWorkbook } from "../lib/inventoryImport";
import { downloadPurchaseLogImportTemplate, downloadRequirementImportTemplate, exportPurchaseAgingReport, exportRequirementsReport } from "../lib/inventoryExport";
import { ApiError } from "../lib/api";
import { StatTile } from "../components/StatTile";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";

const UNIT_OPTIONS = ["Kg", "Ltr", "Count", "Inch", "Ft"];
const CATEGORY_LABEL: Record<InventoryCategory, string> = { RM: "Raw Material", PM: "Packaging Material" };

// S2 ("what's already available") isn't a step any more — currentStock/
// shortQty come live off the real stock ledger on every fetch (see
// pre-inventory.routes.ts), so a requirement is always immediately one
// of these three, never "waiting on someone."
type RequirementStatus = "COVERED" | "SHORTFALL" | "ORDERED";

function requirementStatus(r: PreInventoryRequirement): RequirementStatus {
  if (r.shortQty <= 0) return "COVERED";
  return r.poNumber ? "ORDERED" : "SHORTFALL";
}

// A starting point, not a real numbering scheme — Purchase's own PO
// series lives outside this system, so this only needs to save typing
// on the common case, not be authoritative. Freely editable in the form.
function suggestPoNumber(r: PreInventoryRequirement): string {
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, ""); // yymmdd
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PO-${r.category}-${datePart}-${suffix}`;
}

const STATUS_STYLE: Record<RequirementStatus, string> = {
  COVERED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  SHORTFALL: "bg-amber-50 text-amber-700 border-amber-200",
  ORDERED: "bg-brand-50 text-brand-700 border-brand-200",
};
const STATUS_LABEL: Record<RequirementStatus, string> = {
  COVERED: "Fully Covered",
  SHORTFALL: "Shortfall — Awaiting PO",
  ORDERED: "PO Logged",
};

function StatusBadge({ status }: { status: RequirementStatus }) {
  return <span className={`pill ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>;
}

export function PreInventoryPage() {
  const { hasRole, user } = useAuth();
  const canRequest = hasRole("PPIC");
  const canPurchase = hasRole("PURCHASE");

  const [category, setCategory] = useState<InventoryCategory | "">("");
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);

  const { data: requirements, isLoading } = usePreInventoryRequirements(category ? { category } : undefined);
  const importRequirements = useImportRequirements();
  const importPurchaseLog = useImportPurchaseLog();
  const toast = useToast();

  const importFileRef = useRef<HTMLInputElement>(null);
  const importPurchaseFileRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!requirements) return requirements;
    const q = search.trim().toLowerCase();
    if (!q) return requirements;
    return requirements.filter((r) => r.item.name.toLowerCase().includes(q) || r.vendorName?.toLowerCase().includes(q) || r.poNumber?.toLowerCase().includes(q));
  }, [requirements, search]);

  const stats = useMemo(() => {
    const rows = requirements ?? [];
    return {
      total: rows.length,
      covered: rows.filter((r) => requirementStatus(r) === "COVERED").length,
      shortfall: rows.filter((r) => requirementStatus(r) === "SHORTFALL").length,
      ordered: rows.filter((r) => requirementStatus(r) === "ORDERED").length,
    };
  }, [requirements]);

  function handleExport() {
    if (!filtered?.length) return toast.error("Nothing to export — no requirements match.");
    exportRequirementsReport(filtered);
    toast.success("Report downloaded.");
  }

  // Report #7 — PO logged with a vendor & ETA, material still short.
  function handleExportPoAging() {
    if (!filtered?.length) return toast.error("Nothing to export — no requirements match.");
    const pending = filtered.filter((r) => !!r.poNumber && r.shortQty > 0);
    if (!pending.length) return toast.error("Nothing pending — every logged PO has fully arrived.");
    exportPurchaseAgingReport(filtered);
    toast.success(`PO aging report downloaded — ${pending.length} still-short PO(s).`);
  }

  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !canRequest) return;
    try {
      const buffer = await file.arrayBuffer();
      const { rows, skipped, sheetNames, detectedHeaders } = parseRequirementWorkbook(buffer, "RM");
      if (!rows.length) {
        // eslint-disable-next-line no-console
        console.error("[Pre-Inventory requirement import] No usable rows.", { fileName: file.name, fileSize: file.size, sheetNames, detectedHeaders, skipped });
        return toast.error(
          detectedHeaders.length
            ? `No usable rows in "${file.name}" — found columns [${detectedHeaders.join(", ")}], but none had a valid Item + Date + Unit + Required Qty together.`
            : `"${file.name}" has no data rows on any sheet (${sheetNames.join(", ") || "no sheets"}) — is this the right file?`,
        );
      }
      const result = await importRequirements.mutateAsync({ rows });
      const skippedNote = skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped)` : "";
      toast.success(`Added ${result.requirementsCreated} requirement${result.requirementsCreated === 1 ? "" : "s"}${result.itemsCreated ? `, ${result.itemsCreated} new item(s)` : ""}${skippedNote}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not import spreadsheet");
    }
  }

  async function handleImportPurchaseFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !canPurchase) return;
    try {
      const buffer = await file.arrayBuffer();
      const { rows, skipped, sheetNames, detectedHeaders } = parsePurchaseLogWorkbook(buffer, "RM");
      if (!rows.length) {
        // eslint-disable-next-line no-console
        console.error("[Pre-Inventory PO log import] No usable rows.", { fileName: file.name, fileSize: file.size, sheetNames, detectedHeaders, skipped });
        return toast.error(
          detectedHeaders.length
            ? `No usable rows in "${file.name}" — found columns [${detectedHeaders.join(", ")}], but none had a valid Item + PO Number + Vendor Name + ETA together.`
            : `"${file.name}" has no data rows on any sheet (${sheetNames.join(", ") || "no sheets"}) — is this the right file?`,
        );
      }
      const result = await importPurchaseLog.mutateAsync({ rows });
      const skippedNote = skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped)` : "";
      const unmatchedNote = result.unmatched.length ? ` — no open requirement found for: ${result.unmatched.join(", ")}` : "";
      if (result.posLogged > 0) toast.success(`Logged ${result.posLogged} PO${result.posLogged === 1 ? "" : "s"}${skippedNote}${unmatchedNote}.`);
      else toast.error(`No matching open requirements found${unmatchedNote}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not import spreadsheet");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Pre-Inventory</h1>
          <p className="text-sm text-slate-500">RM/PM requirement planning — PPIC states the need, live stock shows what's on hand, Purchase covers the gap.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" onClick={handleExport} title="Download the vendor / requirement list as an Excel report">
            <Download className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Report
          </button>
          <button className="btn-ghost" onClick={handleExportPoAging} title="Requirements with a PO already logged, sorted by how long the material has been overdue">
            <Clock className="h-3.5 w-3.5" strokeWidth={2.5} /> PO Aging
          </button>
          {canRequest && (
            <>
              <button className="btn-ghost" onClick={downloadRequirementImportTemplate} title="Download a blank template with the correct columns">
                <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Sample
              </button>
              <button className="btn-ghost" disabled={importRequirements.isPending} onClick={() => importFileRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> {importRequirements.isPending ? "Importing…" : "Import Excel"}
              </button>
              <input ref={importFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
              <button className="btn-primary" onClick={() => setShowNew((v) => !v)}>
                <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> New Requirement
              </button>
            </>
          )}
          {canPurchase && (
            <>
              <button className="btn-ghost" onClick={downloadPurchaseLogImportTemplate} title="Download a blank PO log template with the correct columns">
                <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={2.5} /> Download PO Sample
              </button>
              <button className="btn-ghost" disabled={importPurchaseLog.isPending} onClick={() => importPurchaseFileRef.current?.click()} title="Bulk-log POs against existing open requirements, matched by item + category">
                <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> {importPurchaseLog.isPending ? "Importing…" : "Import PO Log"}
              </button>
              <input ref={importPurchaseFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportPurchaseFile} />
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile icon={ClipboardList} label="Total Requirements" value={stats.total} accent="brand" />
        <StatTile icon={CheckCircle2} label="Fully Covered" value={stats.covered} accent="emerald" />
        <StatTile icon={Package} label="Shortfalls" value={stats.shortfall} accent="amber" />
        <StatTile icon={ShoppingCart} label="PO Logged" value={stats.ordered} accent="violet" />
      </div>

      {showNew && canRequest && <NewRequirementForm onDone={() => setShowNew(false)} />}

      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[220px] flex-1">
          <SearchBar value={search} onChange={setSearch} placeholder="Search item, vendor, or PO number…" />
        </div>
        <select className="field w-auto" value={category} onChange={(e) => setCategory(e.target.value as InventoryCategory | "")}>
          <option value="">All Categories</option>
          <option value="RM">Raw Material</option>
          <option value="PM">Packaging Material</option>
        </select>
      </div>

      {isLoading ? (
        <SkeletonRows rows={4} cols={1} />
      ) : !requirements?.length ? (
        <EmptyState icon={ClipboardList} title="No requirements yet" hint={canRequest ? "Add one above to get started." : "PPIC raises requirements here before Purchase can act on a shortfall."} accent="brand" />
      ) : !filtered?.length ? (
        <EmptyState icon={Warehouse} title="No matching requirements" hint="Try a different search." accent="slate" />
      ) : (
        <div className="space-y-3">
          {filtered.map((r) => (
            <RequirementCard key={r.id} requirement={r} canPurchase={canPurchase} isOwner={r.requestedBy.id === user?.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function NewRequirementForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [category, setCategory] = useState<InventoryCategory>("RM");
  const { data: items } = useInventoryItems(category);
  const createItem = useCreateInventoryItem();
  const createRequirement = useCreateRequirement();

  const [itemId, setItemId] = useState("");
  const [showNewItem, setShowNewItem] = useState(false);
  const [newItemName, setNewItemName] = useState("");

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [unit, setUnit] = useState(UNIT_OPTIONS[0]!);
  const [requiredQty, setRequiredQty] = useState("");
  const [size, setSize] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function switchCategory(next: InventoryCategory) {
    setCategory(next);
    setItemId("");
  }

  async function handleSubmit() {
    setError(null);
    let finalItemId = itemId;
    if (showNewItem) {
      if (!newItemName.trim()) return setError("Enter the new item's name.");
      try {
        const created = await createItem.mutateAsync({ category, name: newItemName.trim(), unit });
        finalItemId = created.id;
      } catch (err) {
        return setError(err instanceof ApiError ? err.message : "Could not create item");
      }
    }
    if (!finalItemId) return setError("Select or add an item first.");
    if (!date) return setError("Pick a date.");
    if (!requiredQty || Number(requiredQty) <= 0) return setError("Enter a required quantity greater than zero.");

    setSubmitting(true);
    try {
      const created = await createRequirement.mutateAsync({
        date,
        category,
        itemId: finalItemId,
        unit,
        requiredQty: Number(requiredQty),
        size: size.trim() || undefined,
        note: note.trim() || undefined,
      });
      toast.success(created.shortQty > 0 ? `Added — ${created.shortQty} ${unit} short, Purchase has been notified.` : "Added — already fully covered by current stock.");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create requirement");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card animate-slide-up space-y-5 p-5 sm:p-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className="label">Category</label>
          <select className="field" value={category} onChange={(e) => switchCategory(e.target.value as InventoryCategory)}>
            <option value="RM">Raw Material</option>
            <option value="PM">Packaging Material</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label">Item</label>
          {!showNewItem ? (
            <div className="flex flex-wrap gap-2">
              <select className="field min-w-0 flex-1" value={itemId} onChange={(e) => setItemId(e.target.value)}>
                <option value="">— Select an item —</option>
                {(items ?? []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-ghost shrink-0" onClick={() => setShowNewItem(true)}>
                <UserPlus className="h-3.5 w-3.5" strokeWidth={2.25} /> New
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <input className="field min-w-0 flex-1" placeholder="Exact item name" value={newItemName} onChange={(e) => setNewItemName(e.target.value)} />
              <button type="button" className="btn-ghost shrink-0" onClick={() => setShowNewItem(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
        <div>
          <label className="label">Date</label>
          <input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label">Unit</label>
          <select className="field" value={unit} onChange={(e) => setUnit(e.target.value)}>
            {UNIT_OPTIONS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Required Qty</label>
          <input className="field font-mono" type="number" min="0" step="any" placeholder="Quantity" value={requiredQty} onChange={(e) => setRequiredQty(e.target.value)} />
        </div>
        <div>
          <label className="label">Size (optional)</label>
          <input className="field" placeholder="e.g. 25 Kg bag" value={size} onChange={(e) => setSize(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label">Note (optional)</label>
          <input className="field" placeholder="e.g. For next month's production run" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>

      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={submitting} onClick={handleSubmit}>
          {submitting ? "Saving…" : "Add Requirement"}
        </button>
      </div>
    </div>
  );
}

function RequirementCard({ requirement, canPurchase, isOwner }: { requirement: PreInventoryRequirement; canPurchase: boolean; isOwner: boolean }) {
  const toast = useToast();
  const setPurchase = useSetRequirementPurchase();
  const deleteRequirement = useDeleteRequirement();
  const { data: vendors } = useInventoryVendors({ enabled: canPurchase });

  const [showPurchase, setShowPurchase] = useState(false);
  const [poNumber, setPoNumber] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [eta, setEta] = useState("");
  const [error, setError] = useState<string | null>(null);

  const status = requirementStatus(requirement);

  async function handleSetPurchase() {
    setError(null);
    if (!poNumber.trim() || !vendorName.trim() || !eta) return setError("PO Number, Vendor Name, and ETA are all required.");
    try {
      await setPurchase.mutateAsync({ id: requirement.id, poNumber: poNumber.trim(), vendorName: vendorName.trim(), eta });
      toast.success("PO logged — Finance has been notified.");
      setShowPurchase(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not log the PO");
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Remove this requirement for ${requirement.requiredQty} ${requirement.unit} ${requirement.item.name}? This can't be undone.`)) return;
    try {
      await deleteRequirement.mutateAsync(requirement.id);
      toast.success("Requirement removed.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove requirement");
    }
  }

  const canDelete = isOwner && !requirement.purchaseAt;

  return (
    <div className="card space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-bold text-slate-800">{requirement.item.name}</p>
            <StatusBadge status={status} />
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {CATEGORY_LABEL[requirement.category]} · <span className="font-mono font-bold text-slate-700">{requirement.requiredQty}</span> {requirement.unit} required ·{" "}
            <span className="font-mono font-bold text-slate-700">{requirement.currentStock}</span> in stock
            {requirement.shortQty > 0 && (
              <>
                {" "}
                ·{" "}
                <span className="font-mono font-bold text-amber-600">
                  {requirement.shortQty} {requirement.unit} short
                </span>
              </>
            )}
            {requirement.size && <> · {requirement.size}</>} · {new Date(requirement.date).toLocaleDateString()}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Requested by {requirement.requestedBy.fullName}
            {requirement.purchaseBy && <> · ordered by {requirement.purchaseBy.fullName}</>}
          </p>
          {requirement.note && <p className="mt-1.5 text-xs text-slate-600">"{requirement.note}"</p>}
          {requirement.poNumber && (
            <p className="mt-1.5 flex items-center gap-1 text-xs font-bold text-brand-700">
              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.5} /> {requirement.poNumber} · {requirement.vendorName} · ETA{" "}
              {requirement.eta && new Date(requirement.eta).toLocaleDateString()}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canPurchase && status === "SHORTFALL" && !showPurchase && (
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={() => {
                setPoNumber(suggestPoNumber(requirement));
                setShowPurchase(true);
              }}
            >
              <Truck className="h-3.5 w-3.5" strokeWidth={2.5} /> Log PO
            </button>
          )}
          {canDelete && (
            <button type="button" className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" title="Remove requirement" onClick={handleDelete}>
              <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>

      {showPurchase && (
        <div className="animate-fade-in grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3 sm:grid-cols-3">
          <div>
            <label className="label">PO Number</label>
            <input className="field font-mono" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
            <p className="mt-1 text-[11px] text-slate-400">Suggested — overwrite with your own PO number if you already have one.</p>
          </div>
          <div>
            <label className="label">Vendor Name</label>
            <input className="field" list={`po-vendor-options-${requirement.id}`} placeholder="Pick a known vendor or type a new one" value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
            <datalist id={`po-vendor-options-${requirement.id}`}>
              {vendors?.vendors.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="label">ETA</label>
            <input type="date" className="field" value={eta} onChange={(e) => setEta(e.target.value)} />
          </div>
          {error && <p className="sm:col-span-3 text-xs font-bold text-rose-600">{error}</p>}
          <div className="flex justify-end gap-2 sm:col-span-3">
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setShowPurchase(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={setPurchase.isPending} onClick={handleSetPurchase}>
              {setPurchase.isPending ? "Saving…" : "Save PO"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
