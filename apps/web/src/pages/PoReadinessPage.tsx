import { useState, useRef, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CheckCircle2, ChevronDown, ClipboardCheck, Download, FileSpreadsheet, PackageSearch, Plus, Trash2, Upload, Users, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useCreatePoRequirement, useDeletePoRequirementItem, useImportPoRequirements, useInventoryItems, usePoReadiness, usePurchaseOrders } from "../lib/hooks";
import type { InventoryCategory, PoReadinessRow } from "../lib/types";
import { downloadPoRequirementImportTemplate, exportPoReadinessReport, parsePoRequirementWorkbook } from "../lib/poReadinessImport";
import { exportCustomerShortfallReport, exportOverallShortfallReport } from "../lib/poReadinessReports";
import { ApiError } from "../lib/api";
import { StatTile } from "../components/StatTile";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { SearchBar } from "../components/SearchBar";
import { ItemPicker } from "../components/ItemPicker";
import { useToast } from "../components/Toast";

const UNIT_OPTIONS = ["Kg", "Ltr", "Count", "Inch", "Ft"];
const UNIT_ITEMS = UNIT_OPTIONS.map((u) => ({ id: u, name: u }));
const CATEGORY_ITEMS = [
  { id: "RM", name: "Raw Material" },
  { id: "PM", name: "Packaging Material" },
];

const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };

export function PoReadinessPage() {
  const { hasRole } = useAuth();
  const canImport = hasRole("PPIC");
  const toast = useToast();

  const [search, setSearch] = useState("");
  const [readyOnly, setReadyOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showManualForm, setShowManualForm] = useState(false);
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [pickedCustomerIds, setPickedCustomerIds] = useState<string[]>([]);
  const importFileRef = useRef<HTMLInputElement>(null);
  const importRequirements = useImportPoRequirements();
  const deleteItem = useDeletePoRequirementItem();

  const { data: allRows, isLoading } = usePoReadiness(false);
  const rows = readyOnly ? (allRows ?? []).filter((r) => r.isReady) : allRows;

  const q = search.trim().toLowerCase();
  const filtered = rows?.filter(
    (r) => !q || (r.purchaseOrder.poNumber ?? "").toLowerCase().includes(q) || r.purchaseOrder.customer.companyName.toLowerCase().includes(q),
  );

  const readyCount = allRows?.filter((r) => r.isReady).length ?? 0;
  const totalTracked = allRows?.length ?? 0;

  function handleExport() {
    if (!filtered?.length) return toast.error("Nothing to export — no POs match.");
    exportPoReadinessReport(filtered);
    toast.success("Report downloaded — one row per PO × required item.");
  }

  // Distinct customers across every tracked PO — the picker's list for
  // report #4, and where report #2's "every customer" scope comes from.
  const customers = [...new Map((allRows ?? []).map((r) => [r.purchaseOrder.customer.id, r.purchaseOrder.customer])).values()].sort((a, b) =>
    a.companyName.localeCompare(b.companyName),
  );

  // Report #2 — customer-wise pending RM/PM list, every customer.
  function handleExportShortfallByCustomer() {
    if (!allRows?.length) return toast.error("Nothing to export — no PO requirements tracked yet.");
    const { lineCount } = exportCustomerShortfallReport(allRows);
    if (!lineCount) return toast.error("Nothing short right now — every tracked PO is fully covered.");
    toast.success(`Shortfall by customer downloaded — ${lineCount} short line(s).`);
  }

  // Report #3 — overall RM/PM shortfall, one row per item across every PO.
  function handleExportOverallShortfall() {
    if (!allRows?.length) return toast.error("Nothing to export — no PO requirements tracked yet.");
    exportOverallShortfallReport(allRows);
    toast.success("Overall shortfall downloaded, one row per item.");
  }

  // Report #4 — same as #2, scoped to the customers picked in the panel.
  function handleExportSelectedCustomers() {
    if (!pickedCustomerIds.length) return toast.error("Pick at least one customer first.");
    const { lineCount } = exportCustomerShortfallReport(allRows ?? [], pickedCustomerIds);
    if (!lineCount) return toast.error("Nothing short for the selected customer(s) right now.");
    toast.success(`Shortfall downloaded for ${pickedCustomerIds.length} customer(s) — ${lineCount} short line(s).`);
    setShowCustomerPicker(false);
  }

  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const { rows: parsedRows, skipped, sheetNames, detectedHeaders } = parsePoRequirementWorkbook(buffer);
      if (!parsedRows.length) {
        // eslint-disable-next-line no-console
        console.error("[PO Readiness import] No usable rows.", { fileName: file.name, sheetNames, detectedHeaders, skipped });
        return toast.error(
          detectedHeaders.length
            ? `No usable rows in "${file.name}" — found columns [${detectedHeaders.join(", ")}], but none had a valid PO Number + Category + Item + Qty + Unit together.`
            : `"${file.name}" has no data rows on any sheet (${sheetNames.join(", ") || "no sheets"}).`,
        );
      }

      const result = await importRequirements.mutateAsync(parsedRows);
      const skippedNote = skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped — missing a required field)` : "";
      const unmatchedNote = result.unmatchedPoNumbers.length
        ? ` — ${result.unmatchedPoNumbers.length} PO number${result.unmatchedPoNumbers.length === 1 ? "" : "s"} didn't match an existing order: ${result.unmatchedPoNumbers.slice(0, 5).join(", ")}${result.unmatchedPoNumbers.length > 5 ? ", …" : ""}`
        : "";
      toast.success(`Imported ${result.rowsImported} requirement row(s)${result.itemsCreated ? `, ${result.itemsCreated} new item(s) added` : ""}${skippedNote}.${unmatchedNote}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Import failed — check the file and try again.");
    }
  }

  async function handleRemoveItem(purchaseOrderId: string, itemId: string) {
    if (!window.confirm("Remove this RM/PM requirement from the PO? This can't be undone.")) return;
    try {
      await deleteItem.mutateAsync({ purchaseOrderId, itemId });
      toast.success("Requirement removed.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove that requirement.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tight text-slate-900">PO Readiness</h1>
          <p className="text-sm text-slate-500">Which purchase orders have every required RM/PM item in stock right now — no more checking a consolidated sheet PO by PO.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" onClick={handleExport} title="Download the current list (respecting search/Ready-only) as an Excel report">
            <Download className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Report
          </button>
          <button className="btn-ghost" onClick={handleExportShortfallByCustomer} title="Every customer's still-short RM/PM items, grouped by customer">
            <Users className="h-3.5 w-3.5" strokeWidth={2.5} /> Shortfall by Customer
          </button>
          <button className="btn-ghost" onClick={handleExportOverallShortfall} title="One row per RM/PM item, total shortfall across every PO">
            <ClipboardCheck className="h-3.5 w-3.5" strokeWidth={2.5} /> Overall Shortfall
          </button>
          <div className="relative">
            <button className="btn-ghost" onClick={() => setShowCustomerPicker((s) => !s)} title="Pick specific customers and download just their shortfall">
              <Users className="h-3.5 w-3.5" strokeWidth={2.5} /> Select Customers <ChevronDown className="h-3 w-3" strokeWidth={2.5} />
            </button>
            {showCustomerPicker && (
              <div className="animate-fade-in absolute right-0 top-full z-20 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
                <p className="mb-2 text-xs font-bold text-slate-500">Pick customers ({pickedCustomerIds.length} selected)</p>
                <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                  {customers.length === 0 ? (
                    <p className="text-xs text-slate-400">No customers tracked yet.</p>
                  ) : (
                    customers.map((c) => (
                      <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5"
                          checked={pickedCustomerIds.includes(c.id)}
                          onChange={(e) =>
                            setPickedCustomerIds((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id)))
                          }
                        />
                        {c.companyName}
                      </label>
                    ))
                  )}
                </div>
                <button className="btn-primary mt-3 w-full justify-center" onClick={handleExportSelectedCustomers}>
                  <Download className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Selected
                </button>
              </div>
            )}
          </div>
          {canImport && (
            <>
              <button className="btn-ghost" onClick={downloadPoRequirementImportTemplate} title="Download a blank template with the correct columns">
                <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Sample
              </button>
              <button className="btn-ghost" onClick={() => setShowManualForm((s) => !s)}>
                {showManualForm ? <X className="h-3.5 w-3.5" strokeWidth={2.5} /> : <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />} {showManualForm ? "Cancel" : "Add Manually"}
              </button>
              <button className="btn-primary" disabled={importRequirements.isPending} onClick={() => importFileRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> {importRequirements.isPending ? "Importing…" : "Import Excel"}
              </button>
              <input ref={importFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
            </>
          )}
        </div>
      </div>

      {showManualForm && canImport && <ManualAddForm onDone={() => setShowManualForm(false)} />}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile icon={PackageSearch} label="POs Tracked" value={totalTracked} accent="brand" />
        <StatTile icon={CheckCircle2} label="Ready to Execute" value={readyCount} accent={readyCount ? "emerald" : "slate"} />
        <StatTile icon={ClipboardCheck} label="Still Short" value={totalTracked - readyCount} accent={totalTracked - readyCount ? "amber" : "slate"} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-full sm:w-72">
          <SearchBar value={search} onChange={setSearch} placeholder="Search by PO number, brand, or customer…" />
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600">
          <input type="checkbox" className="h-3 w-3" checked={readyOnly} onChange={(e) => setReadyOnly(e.target.checked)} />
          Ready only
        </label>
      </div>

      {isLoading ? (
        <SkeletonRows rows={5} cols={4} />
      ) : !filtered?.length ? (
        <EmptyState
          icon={PackageSearch}
          title={totalTracked === 0 ? "No PO requirements uploaded yet" : "No matching POs"}
          hint={totalTracked === 0 ? "Import an Excel sheet of PO-wise RM/PM requirements to get started." : "Try a different search or turn off the Ready-only filter."}
          accent="brand"
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((row) => (
            <PoReadinessCard
              key={row.purchaseOrder.id}
              row={row}
              expanded={expanded === row.purchaseOrder.id}
              onToggle={() => setExpanded((e) => (e === row.purchaseOrder.id ? null : row.purchaseOrder.id))}
              canManage={canImport}
              onRemoveItem={handleRemoveItem}
              removing={deleteItem.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// "Add Manually" next to Import Excel — same manual-entry-plus-bulk-import
// pair every other module in this app has (Pre-Inventory, Material
// Requests, ...). Unlike the bulk import, both the PO and the item are
// picked from real dropdowns here, not typed as free text — a manual
// form has no reason to risk a typo the way a pasted-in sheet does.
function ManualAddForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const { data: purchaseOrders } = usePurchaseOrders();
  const [category, setCategory] = useState<InventoryCategory>("RM");
  const { data: items } = useInventoryItems(category);
  const createRequirement = useCreatePoRequirement();

  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [itemId, setItemId] = useState("");
  const [requiredQty, setRequiredQty] = useState("");
  const [unit, setUnit] = useState(UNIT_OPTIONS[0]!);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function switchCategory(next: InventoryCategory) {
    setCategory(next);
    setItemId("");
  }

  async function handleSubmit() {
    setError(null);
    if (!purchaseOrderId) return setError("Select a purchase order.");
    if (!itemId) return setError("Select an item.");
    if (!requiredQty || Number(requiredQty) <= 0) return setError("Enter a required quantity greater than zero.");

    setSubmitting(true);
    try {
      await createRequirement.mutateAsync({ purchaseOrderId, itemId, category, requiredQty: Number(requiredQty), unit });
      toast.success("Requirement added.");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add that requirement.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card animate-slide-up space-y-5 p-5 sm:p-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-2">
          <label className="label">Purchase Order</label>
          <ItemPicker
            items={(purchaseOrders ?? []).map((po) => ({ id: po.id, name: `${po.poNumber ?? po.id.slice(0, 8)} — ${po.customer.companyName}` }))}
            value={purchaseOrderId}
            onChange={setPurchaseOrderId}
            placeholder="— Select a PO —"
          />
        </div>
        <div>
          <label className="label">Category</label>
          <ItemPicker items={CATEGORY_ITEMS} value={category} onChange={(v) => switchCategory(v as InventoryCategory)} clearable={false} />
        </div>
        <div>
          <label className="label">Item</label>
          <ItemPicker items={items ?? []} value={itemId} onChange={setItemId} />
        </div>
        <div>
          <label className="label">Required Qty</label>
          <input type="number" min="0" step="any" className="field" value={requiredQty} onChange={(e) => setRequiredQty(e.target.value)} />
        </div>
        <div>
          <label className="label">Unit</label>
          <ItemPicker items={UNIT_ITEMS} value={unit} onChange={setUnit} clearable={false} />
        </div>
      </div>
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="button" className="btn-primary" disabled={submitting} onClick={handleSubmit}>
          {submitting ? "Adding…" : "Add Requirement"}
        </button>
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function PoReadinessCard({
  row,
  expanded,
  onToggle,
  canManage,
  onRemoveItem,
  removing,
}: {
  row: PoReadinessRow;
  expanded: boolean;
  onToggle: () => void;
  canManage: boolean;
  onRemoveItem: (purchaseOrderId: string, itemId: string) => void;
  removing: boolean;
}) {
  const { purchaseOrder, items, totalItems, readyItems, isReady } = row;
  return (
    <div className="card overflow-hidden">
      <div className="flex w-full items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span className={`pill shrink-0 ${isReady ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
            {isReady ? <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} /> : <ClipboardCheck className="h-3 w-3" strokeWidth={2.5} />}
            {isReady ? "Ready" : `${readyItems}/${totalItems} items`}
          </span>
          <div className="min-w-0">
            <p className="truncate font-bold text-slate-800">{purchaseOrder.poNumber ?? purchaseOrder.id.slice(0, 8)}</p>
            <p className="truncate text-xs text-slate-500">{purchaseOrder.customer.companyName}</p>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {/* Closes the loop the readiness check exists for — "ready" is
              only useful if PPIC can act on it immediately, not just see
              a badge and go hunt for the PO in Order Tracking by hand. */}
          <Link
            to={`/purchase-orders/${purchaseOrder.id}`}
            className={`pill transition-colors ${isReady ? "border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100" : "border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100"}`}
            title="Open this PO in Order Tracking to plan/create a batch"
          >
            {isReady ? "Send to Production" : "View PO"} <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
          </Link>
          <button type="button" onClick={onToggle} className="btn-icon" title={expanded ? "Collapse" : "Show item breakdown"}>
            <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-slate-100">
          <table className="table-modern w-full">
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th className="text-right">Required</th>
                <th className="text-right" title="Warehouse + every Day Store + every Plant, combined">On Hand</th>
                <th></th>
                {canManage && <th></th>}
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.itemId}>
                  <td className="font-bold text-slate-800">{it.itemName}</td>
                  <td className="text-slate-600">{CATEGORY_LABEL[it.category] ?? it.category}</td>
                  <td className="text-right font-mono text-slate-600">
                    {it.requiredQty} {it.unit}
                  </td>
                  <td className={`text-right font-mono font-bold ${it.covered ? "text-emerald-600" : "text-rose-600"}`}>
                    {it.onHand} {it.unit}
                  </td>
                  <td>{it.covered ? <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Covered</span> : <span className="pill border-rose-200 bg-rose-50 text-rose-700">Short</span>}</td>
                  {canManage && (
                    <td>
                      <button type="button" className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" disabled={removing} onClick={() => onRemoveItem(purchaseOrder.id, it.itemId)} title="Remove this requirement row">
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
