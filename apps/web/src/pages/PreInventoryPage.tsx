import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { CheckCircle2, ClipboardList, Download, FileSpreadsheet, Package, Plus, Send, ShoppingCart, Trash2, Truck, Upload, UserPlus, Warehouse } from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useCreateInventoryItem,
  useCreateRequirement,
  useDeleteRequirement,
  useImportPurchaseLog,
  useImportRequirements,
  useInventoryItems,
  useNotifyPurchase,
  usePreInventoryRequirements,
} from "../lib/hooks";
import type { InventoryCategory, PreInventoryRequirement } from "../lib/types";
import { hasPiOnOrder, needsPi, requirementStatus, REQUIREMENT_STATUS_LABEL, type RequirementStatus } from "../lib/purchasePlanning";
import { PiLogForm, PurchaseLineList } from "../components/PurchaseLines";
import { PoProductPicker, type PickedProduct } from "../components/PoProductPicker";
import { parsePurchaseLogWorkbook, parseRequirementWorkbook } from "../lib/inventoryImport";
import { downloadPurchaseLogImportTemplate, downloadRequirementImportTemplate, exportRequirementsReport } from "../lib/inventoryExport";
import { ApiError } from "../lib/api";
import { StatTile } from "../components/StatTile";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { SearchBar } from "../components/SearchBar";
import { ItemPicker } from "../components/ItemPicker";
import { useToast } from "../components/Toast";
import { ExpandTable } from "../components/ExpandTable";

const UNIT_OPTIONS = ["Kg", "Ltr", "Count", "Inch", "Ft"];
const UNIT_ITEMS = UNIT_OPTIONS.map((u) => ({ id: u, name: u }));
const CATEGORY_ITEMS = [
  { id: "RM", name: "Raw Material" },
  { id: "PM", name: "Packaging Material" },
];
const CATEGORY_FILTER_ITEMS = [{ id: "", name: "All Categories" }, ...CATEGORY_ITEMS];
const CATEGORY_LABEL: Record<InventoryCategory, string> = { RM: "Raw Material", PM: "Packaging Material" };

// A starting point, not a real numbering scheme — Purchase's own PO
// series lives outside this system, so this only needs to save typing
// on the common case, not be authoritative. Freely editable in the form.
const STATUS_STYLE: Record<RequirementStatus, string> = {
  COVERED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  SHORTFALL: "bg-amber-50 text-amber-700 border-amber-200",
  PARTIAL: "bg-orange-50 text-orange-700 border-orange-200",
  ORDERED: "bg-brand-50 text-brand-700 border-brand-200",
};
function StatusBadge({ status }: { status: RequirementStatus }) {
  return <span className={`pill ${STATUS_STYLE[status]}`}>{REQUIREMENT_STATUS_LABEL[status]}</span>;
}

export function PreInventoryPage() {
  const { hasRole, user } = useAuth();
  // PPIC-only used to be the rule — Purchase can now log a requirement
  // directly too, not just react to one PPIC already raised. See
  // pre-inventory.routes.ts's POST / for the same relaxed gate.
  const canRequest = hasRole("PPIC", "PURCHASE");
  // Purchase-only — PPIC plans (raises the requirement above), Purchase
  // buys (logs the PO/Vendor/ETA here). See pre-inventory.routes.ts's
  // PATCH /:id/purchase for the same split.
  const canPurchase = hasRole("PURCHASE");
  // PPIC's own explicit "Send to Purchase" call — a shortfall existing
  // isn't reason enough for the system to notify Purchase by itself any
  // more. See pre-inventory.routes.ts's POST /:id/notify-purchase.
  const canNotifyPurchase = hasRole("PPIC");

  const [category, setCategory] = useState<InventoryCategory | "">("");
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  // ?status=SHORTFALL / ?status=COVERED — arrives here from a dashboard
  // tile (Purchase's "Shortfall"/"Complete" tiles, see DashboardPage.tsx)
  // so the actionable Log PO / Edit PO list opens already narrowed down,
  // not just an inert count. Read once on mount, then behaves as a
  // normal in-page filter the person can change or clear.
  const [searchParams] = useSearchParams();
  const initialStatus = searchParams.get("status");
  const [statusFilter, setStatusFilter] = useState<RequirementStatus | "">(
    initialStatus === "SHORTFALL" || initialStatus === "COVERED" || initialStatus === "ORDERED" ? initialStatus : "",
  );

  const { data: requirements, isLoading } = usePreInventoryRequirements(category ? { category } : undefined);
  const importRequirements = useImportRequirements();
  const importPurchaseLog = useImportPurchaseLog();
  const toast = useToast();

  const importFileRef = useRef<HTMLInputElement>(null);
  const importPurchaseFileRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!requirements) return requirements;
    const q = search.trim().toLowerCase();
    return requirements.filter((r) => {
      if (statusFilter === "SHORTFALL" ? !needsPi(r) : statusFilter === "ORDERED" ? !hasPiOnOrder(r) : statusFilter && requirementStatus(r) !== statusFilter) return false;
      if (q && !r.item.name.toLowerCase().includes(q) && !(r.sourcePo?.poNumber ?? "").toLowerCase().includes(q) && !r.purchaseLines.some((l) => l.vendorName.toLowerCase().includes(q) || l.piNumber.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [requirements, search, statusFilter]);

  // PO-wise (default) or the plain item list.
  // One table, grouped PO-wise: ordered by customer PO, then product, so a PO's materials sit together
  const ordered = useMemo(
    () =>
      [...(filtered ?? [])].sort(
        (x, y) =>
          (x.sourcePo?.poNumber ?? "~").localeCompare(y.sourcePo?.poNumber ?? "~", undefined, { numeric: true }) ||
          (x.sourcePo?.productName ?? "").localeCompare(y.sourcePo?.productName ?? "") ||
          x.category.localeCompare(y.category) ||
          x.item.name.localeCompare(y.item.name),
      ),
    [filtered],
  );

  const stats = useMemo(() => {
    const rows = requirements ?? [];
    return {
      total: rows.length,
      covered: rows.filter((r) => requirementStatus(r) === "COVERED").length,
      shortfall: rows.filter(needsPi).length,
      ordered: rows.filter(hasPiOnOrder).length,
    };
  }, [requirements]);

  function handleExport() {
    if (!filtered?.length) return toast.error("Nothing to export — no requirements match.");
    exportRequirementsReport(filtered);
    toast.success("Report downloaded.");
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
            ? `No usable rows in "${file.name}" — found columns [${detectedHeaders.join(", ")}], but none had a valid Item + PI Number + Vendor Name + ETA together.`
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
              <button className="btn-ghost" onClick={downloadPurchaseLogImportTemplate} title="Download a blank PI log template with the correct columns">
                <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={2.5} /> Download PI Sample
              </button>
              <button className="btn-ghost" disabled={importPurchaseLog.isPending} onClick={() => importPurchaseFileRef.current?.click()} title="Bulk-log PIs against existing open requirements, matched by item + category">
                <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> {importPurchaseLog.isPending ? "Importing…" : "Import PI Log"}
              </button>
              <input ref={importPurchaseFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportPurchaseFile} />
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <button type="button" className="block text-left" onClick={() => setStatusFilter("")}>
          <StatTile icon={ClipboardList} label="Total Requirements" value={stats.total} accent="brand" />
        </button>
        <button type="button" className="block text-left" onClick={() => setStatusFilter("COVERED")}>
          <StatTile icon={CheckCircle2} label="Complete" value={stats.covered} accent="emerald" />
        </button>
        <button type="button" className="block text-left" onClick={() => setStatusFilter("SHORTFALL")}>
          <StatTile icon={Package} label="Shortfall" value={stats.shortfall} accent="amber" />
        </button>
        <button type="button" className="block text-left" onClick={() => setStatusFilter("ORDERED")}>
          <StatTile icon={ShoppingCart} label="PI Logged" value={stats.ordered} accent="violet" />
        </button>
      </div>

      {showNew && canRequest && <NewRequirementForm onDone={() => setShowNew(false)} />}

      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[220px] flex-1">
          <SearchBar value={search} onChange={setSearch} placeholder="Search item, vendor, customer PO or PI number…" />
        </div>
        <div className="w-48">
          <ItemPicker items={CATEGORY_FILTER_ITEMS} value={category} onChange={(v) => setCategory(v as InventoryCategory | "")} clearable={false} />
        </div>
        {statusFilter && (
          <span className="pill border-slate-200 bg-slate-50 text-slate-600">
            Filtered: {REQUIREMENT_STATUS_LABEL[statusFilter]}
            <button type="button" className="ml-1.5 font-bold text-slate-400 hover:text-slate-700" onClick={() => setStatusFilter("")}>
              ✕
            </button>
          </span>
        )}
      </div>

      {isLoading ? (
        <SkeletonRows rows={4} cols={1} />
      ) : !requirements?.length ? (
        <EmptyState icon={ClipboardList} title="No requirements yet" hint={canRequest ? "Add one above to get started." : "PPIC raises requirements here before Purchase can act on a shortfall."} accent="brand" />
      ) : !filtered?.length ? (
        <EmptyState icon={Warehouse} title="No matching requirements" hint="Try a different search." accent="slate" />
      ) : (
        <ExpandTable
          rows={ordered}
          rowKey={(r) => r.id}
          openLabel={canPurchase || canNotifyPurchase ? "Open / actions" : "Open"}
          renderExpanded={(r) => <RequirementCard requirement={r} canPurchase={canPurchase} canNotifyPurchase={canNotifyPurchase} isOwner={r.requestedBy.id === user?.id} />}
          columns={[
            { header: "Customer PO", cell: (r) => r.sourcePo?.poNumber ?? "General (no PO)", className: "font-bold text-slate-700" },
            { header: "Customer", cell: (r) => r.sourcePo?.customerName ?? "-" },
            { header: "Product", cell: (r) => r.sourcePo?.productName ?? "-" },
            { header: "Item", cell: (r) => r.item.name, className: "font-bold text-slate-800" },
            { header: "Material", cell: (r) => CATEGORY_LABEL[r.category] },
            { header: "Required", cell: (r) => `${r.requiredQty} ${r.unit}`, align: "right", className: "font-mono text-slate-700" },
            { header: "In Stock", cell: (r) => r.currentStock, align: "right", className: "font-mono text-slate-600" },
            { header: "Short", cell: (r) => (r.shortQty > 0 ? `${r.shortQty} ${r.unit}` : "-"), align: "right", className: "font-mono font-bold text-amber-700" },
            { header: "On Order", cell: (r) => (r.onOrderQty > 0 ? r.onOrderQty : "-"), align: "right", className: "font-mono text-brand-700" },
            { header: "Left To Log", cell: (r) => (r.shortQty > 0 && r.remainingToLog > 0 ? r.remainingToLog : "-"), align: "right", className: "font-mono text-amber-700" },
            { header: "Status", cell: (r) => <StatusBadge status={requirementStatus(r)} /> },
            { header: "PI / Vendor", cell: (r) => (r.purchaseLines.length ? r.purchaseLines.map((l) => `${l.piNumber} (${l.vendorName})`).join(", ") : [r.poNumber, r.vendorName].filter(Boolean).join(" · ") || "-"), className: "max-w-[16rem] truncate" },
            { header: "ETA", cell: (r) => (r.purchaseLines.length ? r.purchaseLines.map((l) => new Date(l.eta).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })).join(", ") : r.eta ? new Date(r.eta).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-") },
            { header: "Requested By", cell: (r) => `${r.requestedBy.fullName} · ${new Date(r.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}` },
          ]}
        />
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
  const [forProduct, setForProduct] = useState<PickedProduct | null>(null);
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
        purchaseOrderItemId: forProduct?.itemId,
      });
      toast.success(created.shortQty > 0 ? `Added — ${created.shortQty} ${unit} short. Send it to Purchase when you're ready.` : "Added — already fully covered by current stock.");
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
          <ItemPicker items={CATEGORY_ITEMS} value={category} onChange={(v) => switchCategory(v as InventoryCategory)} clearable={false} />
        </div>
        <div className="sm:col-span-2">
          <label className="label">Item</label>
          {!showNewItem ? (
            <div className="flex flex-wrap gap-2">
              <div className="min-w-0 flex-1">
                <ItemPicker items={items ?? []} value={itemId} onChange={setItemId} />
              </div>
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
          <ItemPicker items={UNIT_ITEMS} value={unit} onChange={setUnit} clearable={false} />
        </div>
        <div>
          <label className="label">Required Qty</label>
          <input className="field font-mono" type="number" min="0" step="any" placeholder="Quantity" value={requiredQty} onChange={(e) => setRequiredQty(e.target.value)} />
        </div>
        <div>
          <label className="label">Size (optional)</label>
          <input className="field" placeholder="e.g. 25 Kg bag" value={size} onChange={(e) => setSize(e.target.value)} />
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <label className="label">For PO / Product (optional)</label>
          <PoProductPicker value={forProduct} onChange={setForProduct} />
          <p className="mt-1 text-[11px] text-slate-400">Pick the customer PO product this material is for, so it shows under that PO here and in Incoming Material.</p>
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

function RequirementCard({
  requirement,
  canPurchase,
  canNotifyPurchase,
  isOwner,
  nested = false,
}: {
  requirement: PreInventoryRequirement;
  canPurchase: boolean;
  canNotifyPurchase: boolean;
  isOwner: boolean;
  /** Inside a PO > product group: a lighter box, and no "Raw / Packaging Material" prefix (the section says it). */
  nested?: boolean;
}) {
  const toast = useToast();
  const notifyPurchase = useNotifyPurchase();
  const deleteRequirement = useDeleteRequirement();

  async function handleNotifyPurchase() {
    try {
      await notifyPurchase.mutateAsync(requirement.id);
      toast.success("Purchase has been notified.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not notify Purchase");
    }
  }

  const [showPurchase, setShowPurchase] = useState(false);

  const status = requirementStatus(requirement);

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
    <div className={nested ? "space-y-3 rounded-xl border border-slate-200/80 bg-white p-3.5" : "card space-y-3 p-4 sm:p-5"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-bold text-slate-800">{requirement.item.name}</p>
            <StatusBadge status={status} />
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {!nested && <>{CATEGORY_LABEL[requirement.category]} · </>}<span className="font-mono font-bold text-slate-700">{requirement.requiredQty}</span> {requirement.unit} required ·{" "}
            <span className="font-mono font-bold text-slate-700">{requirement.currentStock}</span> in stock
            {requirement.shortQty > 0 && (
              <>
                {" "}
                ·{" "}
                <span className="font-mono font-bold text-amber-600">
                  {requirement.shortQty} {requirement.unit} short
                </span>
                {requirement.onOrderQty > 0 && (
                  <>
                    {" "}
                    · <span className="font-mono font-bold text-brand-700">{requirement.onOrderQty}</span> on order
                    {requirement.remainingToLog > 0 && (
                      <>
                        {" "}
                        · <span className="font-mono font-bold text-amber-600">{requirement.remainingToLog}</span> {requirement.unit} left to log
                      </>
                    )}
                  </>
                )}
              </>
            )}
            {requirement.size && <> · {requirement.size}</>} · {new Date(requirement.date).toLocaleDateString()}
          </p>
          {!nested && requirement.sourcePo && (
            <p className="mt-0.5 text-tiny font-semibold text-slate-500">
              For customer PO <span className="text-slate-700">{requirement.sourcePo.poNumber ?? "—"}</span> · {requirement.sourcePo.productName}
            </p>
          )}
          {requirement.requestSource && (
            <p className="mt-0.5 text-tiny font-semibold text-violet-600">
              For {requirement.requestSource.label} material request — Warehouse was short{requirement.purchaseNotifiedAt ? "" : " · send it to Purchase when you are ready"}
            </p>
          )}
          <p className="mt-0.5 text-tiny text-slate-400">
            Requested by {requirement.requestedBy.fullName}
            {requirement.purchaseBy && <> · ordered by {requirement.purchaseBy.fullName}</>}
          </p>
          {requirement.note && <p className="mt-1.5 text-xs text-slate-600">"{requirement.note}"</p>}
          {requirement.purchaseLines.length > 0 && (
            <div className="mt-2.5">
              <PurchaseLineList requirement={requirement} canPurchase={canPurchase} />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canNotifyPurchase && (status === "SHORTFALL" || status === "PARTIAL") && (
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={notifyPurchase.isPending || !!requirement.purchaseNotifiedAt}
              title={requirement.purchaseNotifiedAt ? `Notified ${new Date(requirement.purchaseNotifiedAt).toLocaleString()}` : undefined}
              onClick={handleNotifyPurchase}
            >
              <Send className="h-3.5 w-3.5" strokeWidth={2.5} />{" "}
              {notifyPurchase.isPending ? "Sending…" : requirement.purchaseNotifiedAt ? "Notified" : "Send to Purchase"}
            </button>
          )}
          {canPurchase && needsPi(requirement) && !showPurchase && (
            <button type="button" className="btn-primary btn-sm" onClick={() => setShowPurchase(true)}>
              <Truck className="h-3.5 w-3.5" strokeWidth={2.5} /> {requirement.purchaseLines.length > 0 ? "Log another PI" : "Log PI"}
            </button>
          )}
          {canDelete && (
            <button type="button" className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" title="Remove requirement" onClick={handleDelete}>
              <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>

      {showPurchase && <PiLogForm requirement={requirement} onDone={() => setShowPurchase(false)} />}
    </div>
  );
}
