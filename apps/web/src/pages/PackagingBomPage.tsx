import { useState, type ChangeEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Box, Calculator, ClipboardList, FileSpreadsheet, Link2, ListPlus, Package, Pencil, Plus, Sparkles, Upload, Wand2, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { downloadFile, ApiError } from "../lib/api";
import { downloadCatalogImportTemplate, parseCatalogWorkbook } from "../lib/catalogImport";
import { findSimilarName } from "../lib/similarName";
import { EmptyState } from "../components/EmptyState";
import { ItemPicker } from "../components/ItemPicker";
import { RecipeRequestBanner } from "../components/RecipeRequestBanner";
import { useToast } from "../components/Toast";
import {
  useAddBomPlanItem,
  useBomPlan,
  useCalculateBomPlan,
  useCreateCustomer,
  useCreateSku,
  useCustomers,
  useImportCatalog,
  useRemoveBomPlanItem,
  useSendBomPlanToPreInventory,
  useSkus,
  useUpdateCustomer,
  useUpdateSku,
  useUpdateSkuPackagingComponents,
} from "../lib/hooks";
import { CATALOG_SKU_SPEC_FIELDS, KNOWN_PACKAGING_TYPES, type CatalogSku, type SuggestedSku } from "../lib/types";

// Shown instead of (well, above) RecipeRequestBanner's "no catalog
// match" framing whenever the PO's product name came close to — but
// didn't exactly match — a real SKU (see bom-plan.routes.ts
// findSkuSuggestions). Most of the time this is a typo, not a missing
// formulation: one click queues the real SKU and calculates, no trip to
// R&D needed. Not auto-applied — a human still confirms it's the right
// product before it's queued.
function SkuMatchSuggestions({ planId, suggestions }: { planId: string; suggestions: SuggestedSku[] }) {
  const toast = useToast();
  const addItem = useAddBomPlanItem(planId);
  const calculate = useCalculateBomPlan(planId);

  async function handleUse(s: SuggestedSku) {
    try {
      await addItem.mutateAsync({ skuId: s.skuId, targetYield: s.targetYield });
      calculate.mutate();
      toast.success(`Queued "${s.productName}" — calculating.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not queue this SKU");
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-brand-200 bg-brand-50/60 px-3.5 py-3">
      <p className="flex items-center gap-1.5 text-xs font-bold text-brand-700">
        <Wand2 className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} /> No exact match — did you mean one of these? (Likely a typo in the PO's product name, not a missing formulation.)
      </p>
      <div className="flex flex-wrap gap-2">
        {suggestions.map((s) => (
          <button
            key={s.skuId}
            type="button"
            disabled={addItem.isPending}
            onClick={() => handleUse(s)}
            className="rounded-lg border border-brand-300 bg-white px-3 py-1.5 text-xs font-bold text-brand-700 shadow-soft transition-colors hover:bg-brand-50"
          >
            {s.productName} <span className="font-normal text-slate-400">({s.customerName} · {Math.round(s.score * 100)}% match)</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const CATEGORY_LABEL: Record<string, string> = { "1-Primary": "Primary", "2-Secondary": "Secondary", "3-Tertiary": "Tertiary" };
const CATEGORY_COLOR: Record<string, string> = {
  "1-Primary": "bg-emerald-100 text-emerald-800",
  "2-Secondary": "bg-blue-100 text-blue-800",
  "3-Tertiary": "bg-amber-100 text-amber-800",
};

// The BOM engine itself never computes cost — it's a pure quantity
// procurement plan (see bom-engine.ts). RM Costing separately has 4 flat
// per-unit packaging rates (Jar/Scoop/Label/CCB) it uses for its own
// per-pouch cost — reusing those same rates here gives a real, editable
// cost estimate on this table without needing a whole new per-SKU cost
// catalog. Only components with an obvious match get a cost; the rest
// (Seal Wad, Silica Gel, Hologram, Cap Branding, Neck Sleeve, Inner
// Protection) are left blank rather than guessing a wrong number — see
// the note under the table.
type CostRateKey = "jarCost" | "scoopCost" | "labelCost" | "ccbCost";
const COST_RATE_LABEL: Record<CostRateKey, string> = { jarCost: "Jar Cost", scoopCost: "Scoop Cost", labelCost: "Label Cost", ccbCost: "CCB/Copp Cost" };
const DEFAULT_COST_RATES: Record<CostRateKey, number> = { jarCost: 25, scoopCost: 8, labelCost: 23, ccbCost: 8 };
function componentCostRate(component: string): CostRateKey | null {
  const c = component.toLowerCase();
  if (c.includes("jar")) return "jarCost";
  if (c.includes("scoop")) return "scoopCost";
  if (c.includes("leaflet")) return "labelCost";
  if (c.includes("corrugated") || c.includes("box")) return "ccbCost";
  return null;
}

export function PackagingBomPage() {
  const { hasRole } = useAuth();
  const canSendToPreInventory = hasRole("PPIC");
  // Authoring the Brand/SKU catalog (Import Catalog + Browse & Edit) is
  // R&D's own job, same as the plans this page produces from it — see
  // RndPage's own note on why this moved off that page.
  const canManageCatalog = hasRole("RND");

  // Deep-linkable via ?plan=<id> only — reached from a PO's "Generate"
  // pill on its detail page, never picked here (see the removed Active
  // BOM Plan panel's own history: this page is a view of one plan you
  // were sent to, not a place to browse/switch between plans by hand).
  const [searchParams] = useSearchParams();
  const selectedPlanId = searchParams.get("plan") ?? undefined;
  const { data: plan } = useBomPlan(selectedPlanId);
  const calculate = useCalculateBomPlan(selectedPlanId ?? "");
  const removeItem = useRemoveBomPlanItem(selectedPlanId ?? "");
  const sendToPreInventory = useSendBomPlanToPreInventory(selectedPlanId ?? "");

  const toast = useToast();

  const [costRates, setCostRates] = useState<Record<CostRateKey, number>>(DEFAULT_COST_RATES);

  const importCatalog = useImportCatalog();
  const [catalogStatus, setCatalogStatus] = useState("");

  async function handleImportCatalog(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setCatalogStatus("Reading file…");
    try {
      const buffer = await file.arrayBuffer();
      const customersPayload = parseCatalogWorkbook(buffer);
      if (!customersPayload.length) {
        setCatalogStatus("No recognizable SKU rows found — check the Product Name column.");
        return;
      }
      // A column the sheet has that this importer doesn't recognize yet
      // (someone added one after this was written, or spelled one
      // differently) is never dropped — see catalogImport.ts's `extra`.
      // But it's also not a real spec field yet, just JSON on the SKU
      // row, so surface it here rather than let it go unnoticed.
      const unmappedColumns = new Set<string>();
      for (const customer of customersPayload) {
        for (const sku of customer.skus) {
          if (sku.extra && typeof sku.extra === "object") Object.keys(sku.extra).forEach((k) => unmappedColumns.add(k));
        }
      }

      const result = await importCatalog.mutateAsync(customersPayload);
      const unmappedNote =
        unmappedColumns.size > 0
          ? ` ${unmappedColumns.size} column(s) weren't recognized and were kept as-is on each SKU, not lost: ${[...unmappedColumns].join(", ")}. Ask to have any of these added as a real field.`
          : "";
      // A sheet name matching more than one Customer (Customer.companyName
      // has no unique constraint) can't be resolved automatically — same
      // "ambiguous" framing as the Customers page's own bulk-update import.
      const ambiguousNote = result.ambiguous.length
        ? ` ${result.ambiguous.length} sheet(s) skipped — the Customer name matches more than one existing customer: ${result.ambiguous.map((a) => `"${a.customerName}" (${a.matchCount})`).join(", ")}. Rename the duplicates on the Customers page first.`
        : "";
      setCatalogStatus(`Imported ${result.customersTouched} customer(s), ${result.skusUpserted} SKU(s).${unmappedNote}${ambiguousNote}`);
      toast.success(`Imported ${result.customersTouched} customer(s), ${result.skusUpserted} SKU(s) — any matching PPIC request has been notified.`);
    } catch (err) {
      const msg = `Import failed: ${err instanceof ApiError ? err.message : "unknown error"}`;
      setCatalogStatus(msg);
      toast.error(msg);
    }
  }

  function handleRemoveItem(itemId: string, productName: string, remainingAfter: number) {
    if (!window.confirm(`Remove "${productName}" from this plan?`)) return;
    removeItem.mutate(itemId, { onSuccess: () => remainingAfter > 0 && calculate.mutate() });
  }

  async function handleSendToPreInventory(planName: string) {
    if (!window.confirm(`Send this plan's packaging quantities to Pre-Inventory as new requirements?`)) return;
    try {
      const result = await sendToPreInventory.mutateAsync();
      const mrNote = result.materialRequests?.rowsCreated ? ` ${result.materialRequests.rowsCreated} Material Request(s) also raised for Store — no need to re-enter these items.` : "";
      toast.success(
        `Sent ${result.requirementsCreated} requirement(s) to Pre-Inventory${result.itemsCreated ? `, ${result.itemsCreated} new item(s)` : ""} — from "${planName}".${mrNote}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send to Pre-Inventory");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-emerald-50 text-emerald-600">
          <Package className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Packaging BOM</h1>
          <p className="text-sm text-slate-500">Aggregate packaging components across SKUs into one procurement plan.</p>
        </div>
      </div>

      <div className={canManageCatalog ? "grid grid-cols-1 gap-4 lg:grid-cols-[20rem_1fr]" : "space-y-4"}>
        {canManageCatalog && (
          <div className="card h-fit p-4">
            <p className="label flex items-center gap-1.5">
              <Package className="h-3.5 w-3.5" /> Import Catalog (BOM)
            </p>
            <p className="mb-2 text-[10px] text-slate-400">One sheet per customer, one row per SKU. Columns like Jar, Wad (MM), Scoop (ML) map automatically.</p>
            <button type="button" className="btn-ghost mb-1.5 block w-full text-center" onClick={downloadCatalogImportTemplate}>
              <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Sample
            </button>
            <p className="mb-2 text-[10px] text-slate-400">Fastest way to add a brand-new customer wanting an already-known product — fill this in and upload below.</p>
            <label className="btn-ghost block w-full cursor-pointer text-center">
              <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> Choose Spreadsheet…
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportCatalog} />
            </label>
            {catalogStatus && <p className="mt-2 text-[10px] text-slate-400">{catalogStatus}</p>}
          </div>
        )}
        <div className="space-y-4">
        {!plan ? (
          <EmptyState
            icon={Box}
            title="No plan open"
            hint={'Every BOM plan is generated straight off a PO — open one via "Generate" (or the BOM pill) on the PO\'s detail page.'}
            accent="emerald"
          />
        ) : (
            <>
              {plan.status === "DRAFT" && plan.suggestedSkus && plan.suggestedSkus.length > 0 && <SkuMatchSuggestions planId={plan.id} suggestions={plan.suggestedSkus} />}
              {plan.status === "DRAFT" && plan.purchaseOrderItemId && <RecipeRequestBanner purchaseOrderItemId={plan.purchaseOrderItemId} />}
              <div className="card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-gradient-to-r from-emerald-50 to-white px-5 py-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-black text-slate-900">{plan.name}</h2>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${plan.status === "CALCULATED" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                        {plan.status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">{plan.items.length} SKU(s) queued</p>
                    {plan.linkedOrder && (
                      <Link
                        to={`/purchase-orders/${plan.linkedOrder.purchaseOrderId}`}
                        className="mt-1 inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 hover:underline"
                      >
                        <Link2 className="h-3 w-3" strokeWidth={2.5} /> {plan.linkedOrder.poNumber ?? "PO"} · {plan.linkedOrder.productName}
                      </Link>
                    )}
                  </div>
                  <button className="btn-primary" disabled={plan.items.length === 0 || calculate.isPending} onClick={() => calculate.mutate()}>
                    <Calculator className="h-4 w-4" strokeWidth={2.5} /> {calculate.isPending ? "Calculating…" : "Calculate BOM"}
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="table-modern w-full">
                    <thead>
                      <tr>
                        <th>Customer</th>
                        <th>SKU</th>
                        <th className="text-center">Target Yield</th>
                        <th className="text-center">Remove</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.items.length === 0 && (
                        <tr>
                          <td colSpan={4} className="p-8 text-center text-xs text-slate-400">
                            No SKUs queued yet.
                          </td>
                        </tr>
                      )}
                      {plan.items.map((i) => (
                        <tr key={i.id}>
                          <td className="font-semibold text-slate-700">{i.customerName}</td>
                          <td className="text-slate-600">{i.productName}</td>
                          <td className="text-center font-mono font-bold text-emerald-700">{i.targetYield}</td>
                          <td className="text-center">
                            <button className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" onClick={() => handleRemoveItem(i.id, i.productName, plan.items.length - 1)}>
                              <X className="h-3.5 w-3.5" strokeWidth={2.25} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {plan.result && (
                <div className="card overflow-hidden">
                  <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-emerald-50/60 to-white px-5 py-4">
                    <h3 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wide text-slate-700">
                      <Sparkles className="h-3.5 w-3.5 text-emerald-500" /> Consolidated Master Procurement
                    </h3>
                    <div className="flex gap-2">
                      {canSendToPreInventory && (
                        <button
                          className="btn-primary btn-sm"
                          disabled={sendToPreInventory.isPending || !!plan.sentToPreInventoryAt}
                          onClick={() => handleSendToPreInventory(plan.name)}
                          title={
                            plan.sentToPreInventoryAt
                              ? "Already sent — recalculate this plan if you need to send an updated result"
                              : "Create a Pre-Inventory requirement for each packaging line above"
                          }
                        >
                          <ClipboardList className="h-3 w-3" strokeWidth={2.5} />{" "}
                          {sendToPreInventory.isPending ? "Sending…" : plan.sentToPreInventoryAt ? "Already Sent" : "Send to Pre-Inventory"}
                        </button>
                      )}
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() => downloadFile(`/api/bom/plans/${plan.id}/export.xlsx`, `FLS_Master_BOM_${plan.id}.xlsx`)}
                      >
                        <FileSpreadsheet className="h-3 w-3" strokeWidth={2.5} /> Excel
                      </button>
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() => downloadFile(`/api/bom/plans/${plan.id}/export.pdf`, `FLS_Master_BOM_${plan.id}.pdf`)}
                      >
                        <FileSpreadsheet className="h-3 w-3" strokeWidth={2.5} /> PDF
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-3">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Est. cost rates (₹/unit)</span>
                    {(Object.keys(COST_RATE_LABEL) as CostRateKey[]).map((key) => (
                      <label key={key} className="flex items-center gap-1.5 text-[11px] text-slate-500">
                        {COST_RATE_LABEL[key]}
                        <input
                          type="number"
                          step="any"
                          className="field w-16 !py-1 font-mono text-xs"
                          value={costRates[key]}
                          onChange={(e) => setCostRates((r) => ({ ...r, [key]: Number(e.target.value) || 0 }))}
                        />
                      </label>
                    ))}
                  </div>

                  <div className="overflow-x-auto">
                    <table className="table-modern w-full">
                      <thead>
                        <tr>
                          <th>Category</th>
                          <th>Component</th>
                          <th>Specification</th>
                          <th className="text-center">Base</th>
                          <th className="text-center">Buffer</th>
                          <th className="text-center">Total</th>
                          <th className="text-center">Est. Cost (₹)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plan.result.lines.map((l, idx) => {
                          const rateKey = componentCostRate(l.component);
                          const cost = rateKey ? l.totalQty * costRates[rateKey] : null;
                          return (
                            <tr key={idx}>
                              <td>
                                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${CATEGORY_COLOR[l.category] ?? ""}`}>{CATEGORY_LABEL[l.category] ?? l.category}</span>
                              </td>
                              <td className="font-semibold text-slate-700">{l.component}</td>
                              <td className="text-slate-600">{l.spec}</td>
                              <td className="text-center font-mono">{l.baseQty}</td>
                              <td className="text-center font-mono">{l.bufferQty}</td>
                              <td className="text-center font-mono font-bold text-emerald-700">{l.totalQty}</td>
                              <td className="text-center font-mono text-slate-500">{cost === null ? "—" : `₹${cost.toFixed(0)}`}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-slate-200 bg-slate-50/60">
                          <td colSpan={6} className="px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">
                            Total estimated cost (Jar + Scoop + Label + CCB only)
                          </td>
                          <td className="text-center font-mono font-black text-emerald-700">
                            ₹
                            {plan.result.lines
                              .reduce((sum, l) => {
                                const rateKey = componentCostRate(l.component);
                                return sum + (rateKey ? l.totalQty * costRates[rateKey] : 0);
                              }, 0)
                              .toFixed(0)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <p className="border-t border-slate-100 px-5 py-2 text-[10px] text-slate-400">
                    Estimate only — Seal Wad, Silica Gel, Hologram, Cap Branding, Neck Sleeve/Shrink, and Inner Protection have no rate here (not priced in RM Costing's profile either) and are left out of the total, not assumed free.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {canManageCatalog && <CatalogBrowser />}
    </div>
  );
}

// View/edit one SKU's own spec by hand — for fixing a value Import
// Catalog got wrong, or for a column the importer didn't recognize
// (see catalogImport.ts's `extra`): add it here as a one-off custom
// field instead of waiting on a code change, or promoting it into a
// real typed field later once it turns out to matter everywhere.
function CatalogBrowser() {
  const toast = useToast();
  const { data: customers } = useCustomers();
  const updateCustomer = useUpdateCustomer();
  const createCustomer = useCreateCustomer();
  const createSku = useCreateSku();
  const [customerId, setCustomerId] = useState("");
  const { data: skus } = useSkus(customerId || undefined);
  const [selectedSkuId, setSelectedSkuId] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [addingProduct, setAddingProduct] = useState(false);
  const [newProductName, setNewProductName] = useState("");

  const selected = skus?.find((s) => s.id === selectedSkuId);
  const selectedCustomer = customers?.find((c) => c.id === customerId);

  async function handleRename() {
    if (!selectedCustomer || !renameValue.trim()) return;
    try {
      await updateCustomer.mutateAsync({ id: selectedCustomer.id, body: { companyName: renameValue.trim() } });
      toast.success(`Renamed to "${renameValue.trim()}" — matches on the new spelling from now on.`);
      setRenaming(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not rename");
    }
  }

  // Staging a Customer/Product ahead of any real PO — e.g. a new
  // customer deal is confirmed but the first PO hasn't landed yet. Bare
  // name only, same as the PO form's own "+ New"; R&D fills in real
  // specs later via Import Catalog or the editor on the right whenever
  // they're ready.
  async function handleAddCustomer() {
    if (!newCustomerName.trim()) return;
    const similar = findSimilarName(newCustomerName, (customers ?? []).map((c) => c.companyName));
    if (similar && !window.confirm(`A very similar customer already exists: "${similar}". Add "${newCustomerName.trim()}" as a new customer anyway?`)) return;
    try {
      const created = await createCustomer.mutateAsync({ companyName: newCustomerName.trim() });
      toast.success(`"${created.companyName}" added to the catalog.`);
      setCustomerId(created.id);
      setAddingCustomer(false);
      setNewCustomerName("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add customer");
    }
  }

  async function handleAddProduct() {
    if (!selectedCustomer || !newProductName.trim()) return;
    const similar = findSimilarName(newProductName, (skus ?? []).map((s) => s.productName));
    if (similar && !window.confirm(`"${selectedCustomer.companyName}" already has a very similar product: "${similar}". Add "${newProductName.trim()}" anyway?`)) return;
    try {
      const created = await createSku.mutateAsync({ customerId: selectedCustomer.id, productName: newProductName.trim() });
      toast.success(`"${created.productName}" added under "${selectedCustomer.companyName}".`);
      setSelectedSkuId(created.id);
      setAddingProduct(false);
      setNewProductName("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add product");
    }
  }

  return (
    <div>
      <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
        <Pencil className="h-3.5 w-3.5" /> Browse & Edit Catalog
      </h2>
      {/* No overflow-hidden here — the Customer picker's dropdown is an
          absolutely-positioned child that needs to escape this card's
          bounds, not get clipped by them. */}
      <div className="card grid grid-cols-1 gap-0 md:grid-cols-[16rem_1fr]">
        <div className="border-b border-slate-100 p-3.5 md:border-b-0 md:border-r">
          <div className="flex gap-1.5">
            <div className="min-w-0 flex-1">
              <ItemPicker
                items={(customers ?? []).map((c) => ({ id: c.id, name: c.companyName }))}
                value={customerId}
                onChange={(id) => {
                  setCustomerId(id);
                  setSelectedSkuId("");
                  setRenaming(false);
                }}
                placeholder="— Select a customer —"
              />
            </div>
            <button type="button" className="btn-icon shrink-0" title="Add a new customer (no PO needed yet)" onClick={() => setAddingCustomer(true)}>
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          </div>
          {/* Staging a Customer/Product for later — a new customer deal
              is confirmed but the first PO hasn't come in yet. */}
          {addingCustomer && (
            <div className="mt-2 flex gap-1.5">
              <input
                className="field !py-1.5 min-w-0 flex-1 text-xs"
                placeholder="New customer name"
                value={newCustomerName}
                onChange={(e) => setNewCustomerName(e.target.value)}
              />
              <button type="button" className="btn-primary btn-sm shrink-0" disabled={createCustomer.isPending} onClick={handleAddCustomer}>
                {createCustomer.isPending ? "…" : "Add"}
              </button>
              <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => setAddingCustomer(false)}>
                <X className="h-3 w-3" strokeWidth={2.5} />
              </button>
            </div>
          )}
          {/* Fixes a spelling mistake that came in from Import Catalog (or
              a PO's own "+ New" quick-add) — the exact scenario where "BCA"
              typed on a PO never matches a catalog Customer saved as "BAC". */}
          {selectedCustomer &&
            (!renaming ? (
              <button
                type="button"
                className="btn-ghost btn-sm mt-2 w-full"
                onClick={() => {
                  setRenaming(true);
                  setRenameValue(selectedCustomer.companyName);
                }}
              >
                <Pencil className="h-3 w-3" strokeWidth={2.5} /> Fix spelling
              </button>
            ) : (
              <div className="mt-2 flex gap-1.5">
                <input className="field !py-1.5 min-w-0 flex-1 text-xs" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
                <button type="button" className="btn-primary btn-sm shrink-0" disabled={updateCustomer.isPending} onClick={handleRename}>
                  {updateCustomer.isPending ? "…" : "Save"}
                </button>
                <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => setRenaming(false)}>
                  <X className="h-3 w-3" strokeWidth={2.5} />
                </button>
              </div>
            ))}
          <div className="mt-2 max-h-96 space-y-0.5 overflow-y-auto">
            {customerId && (skus ?? []).length === 0 && <p className="px-2 py-3 text-[11px] text-slate-400">No SKUs for this customer yet.</p>}
            {(skus ?? []).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedSkuId(s.id)}
                className={`block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-xs ${s.id === selectedSkuId ? "bg-violet-50 font-bold text-violet-700" : "text-slate-600 hover:bg-slate-50"}`}
                title={s.productName}
              >
                {s.productName}
              </button>
            ))}
          </div>
          {selectedCustomer &&
            (!addingProduct ? (
              <button type="button" className="btn-ghost btn-sm mt-1.5 w-full" onClick={() => setAddingProduct(true)}>
                <Plus className="h-3 w-3" strokeWidth={2.5} /> Add a product
              </button>
            ) : (
              <div className="mt-1.5 flex gap-1.5">
                <input
                  className="field !py-1.5 min-w-0 flex-1 text-xs"
                  placeholder="New product name"
                  value={newProductName}
                  onChange={(e) => setNewProductName(e.target.value)}
                />
                <button type="button" className="btn-primary btn-sm shrink-0" disabled={createSku.isPending} onClick={handleAddProduct}>
                  {createSku.isPending ? "…" : "Add"}
                </button>
                <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => setAddingProduct(false)}>
                  <X className="h-3 w-3" strokeWidth={2.5} />
                </button>
              </div>
            ))}
        </div>
        <div className="p-4">
          {!customerId ? (
            <p className="text-xs text-slate-400">Pick a customer to browse its SKUs.</p>
          ) : !selected ? (
            <p className="text-xs text-slate-400">Pick a SKU to view/edit its spec.</p>
          ) : (
            <SkuEditor key={selected.id} sku={selected} customerId={customerId} otherProductNames={(skus ?? []).filter((s) => s.id !== selected.id).map((s) => s.productName)} />
          )}
        </div>
      </div>
    </div>
  );
}

// One row's editable state in the Packaging BOM checklist below — a
// row exists (ticked or not) for every KNOWN_PACKAGING_TYPES entry
// always, plus one more for each custom type this Sku already has.
interface PackagingRow {
  type: string;
  checked: boolean;
  quantity: string;
  unit: string;
  pmCode: string;
}

function SkuEditor({ sku, customerId, otherProductNames }: { sku: CatalogSku; customerId: string; otherProductNames: string[] }) {
  const toast = useToast();
  const updateSku = useUpdateSku(customerId);
  const updatePackaging = useUpdateSkuPackagingComponents(customerId);
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {};
    for (const { key } of CATALOG_SKU_SPEC_FIELDS) d[key] = (sku[key] as string | undefined) ?? "";
    return d;
  });
  const [extra, setExtra] = useState<[string, string][]>(() => Object.entries(sku.extra ?? {}).map(([k, v]) => [k, String(v)]));
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldValue, setNewFieldValue] = useState("");
  const [renamingProduct, setRenamingProduct] = useState(false);
  const [productNameValue, setProductNameValue] = useState(sku.productName);

  // Starting checklist: every known type, pre-ticked and filled in where
  // this Sku already has a saved component; plus any already-saved
  // custom type (added by hand before) that isn't one of the known 21.
  const [packagingRows, setPackagingRows] = useState<PackagingRow[]>(() => {
    const saved = new Map((sku.packagingComponents ?? []).map((c) => [c.type, c]));
    const rows: PackagingRow[] = KNOWN_PACKAGING_TYPES.map((type) => {
      const existing = saved.get(type);
      return { type, checked: !!existing, quantity: existing?.quantity != null ? String(existing.quantity) : "", unit: existing?.unit ?? "Nos", pmCode: existing?.pmCode ?? "" };
    });
    for (const [type, c] of saved) {
      if (!(KNOWN_PACKAGING_TYPES as readonly string[]).includes(type)) {
        rows.push({ type, checked: true, quantity: c.quantity != null ? String(c.quantity) : "", unit: c.unit, pmCode: c.pmCode ?? "" });
      }
    }
    return rows;
  });
  const [newTypeName, setNewTypeName] = useState("");

  function updatePackagingRow(type: string, patch: Partial<PackagingRow>) {
    setPackagingRows((prev) => prev.map((r) => (r.type === type ? { ...r, ...patch } : r)));
  }
  function addPackagingType() {
    const name = newTypeName.trim();
    if (!name || packagingRows.some((r) => r.type.toLowerCase() === name.toLowerCase())) return;
    setPackagingRows((prev) => [...prev, { type: name, checked: true, quantity: "", unit: "Nos", pmCode: "" }]);
    setNewTypeName("");
  }
  async function handleSavePackaging() {
    try {
      const components = packagingRows
        .filter((r) => r.checked)
        .map((r) => ({ type: r.type, quantity: r.quantity.trim() ? Number(r.quantity) : null, unit: r.unit.trim() || "Nos", pmCode: r.pmCode.trim() || undefined }));
      await updatePackaging.mutateAsync({ id: sku.id, components });
      toast.success(`Packaging BOM saved for "${sku.productName}".`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  // Same spelling-mismatch problem as Brand rename, but for a Product
  // Name — e.g. a sheet imported "Whey Proten" and now every PO typing
  // "Whey Protein" correctly never matches it.
  async function handleRenameProduct() {
    if (!productNameValue.trim() || productNameValue.trim() === sku.productName) return setRenamingProduct(false);
    const similar = findSimilarName(productNameValue, otherProductNames);
    if (similar && !window.confirm(`"${sku.customerName}" already has a very similar product: "${similar}". Rename to "${productNameValue.trim()}" anyway?`)) return;
    try {
      await updateSku.mutateAsync({ id: sku.id, productName: productNameValue.trim() });
      toast.success(`Renamed to "${productNameValue.trim()}" — matches on the new spelling from now on.`);
      setRenamingProduct(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not rename");
    }
  }

  function updateExtraValue(idx: number, value: string) {
    setExtra((prev) => prev.map((pair, i) => (i === idx ? [pair[0], value] : pair)));
  }
  function removeExtra(idx: number) {
    setExtra((prev) => prev.filter((_, i) => i !== idx));
  }
  function addExtra() {
    if (!newFieldName.trim()) return;
    setExtra((prev) => [...prev, [newFieldName.trim(), newFieldValue.trim()]]);
    setNewFieldName("");
    setNewFieldValue("");
  }

  async function handleSave() {
    try {
      await updateSku.mutateAsync({
        id: sku.id,
        ...draft,
        extra: Object.fromEntries(extra.filter(([k]) => k.trim())),
      });
      toast.success(`Saved "${sku.productName}".`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <div className="space-y-4">
      <div>
        {!renamingProduct ? (
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-black text-slate-900">{sku.productName}</h3>
            <button
              type="button"
              className="btn-icon h-6 w-6"
              title="Fix spelling"
              onClick={() => {
                setRenamingProduct(true);
                setProductNameValue(sku.productName);
              }}
            >
              <Pencil className="h-3 w-3" strokeWidth={2.5} />
            </button>
          </div>
        ) : (
          <div className="flex gap-1.5">
            <input className="field !py-1.5 min-w-0 flex-1 text-xs" value={productNameValue} onChange={(e) => setProductNameValue(e.target.value)} />
            <button type="button" className="btn-primary btn-sm shrink-0" disabled={updateSku.isPending} onClick={handleRenameProduct}>
              {updateSku.isPending ? "…" : "Save"}
            </button>
            <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => setRenamingProduct(false)}>
              <X className="h-3 w-3" strokeWidth={2.5} />
            </button>
          </div>
        )}
        <p className="text-[10px] text-slate-400">{sku.customerName}</p>
      </div>

      <div>
        <p className="label mb-1.5">Known Spec Fields</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CATALOG_SKU_SPEC_FIELDS.map(({ key, label }) => (
            <div key={key}>
              <label className="mb-0.5 block text-[10px] text-slate-400">{label}</label>
              <input
                className="field !py-1.5 text-xs"
                value={draft[key] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="label mb-1.5">Packaging BOM</p>
        <p className="mb-2 text-[10px] text-slate-400">
          Tick whichever packaging types this product actually uses, and how many per finished unit — this is the real checklist from the PM SHEET, not the fixed fields above.
        </p>
        <div className="space-y-1 rounded-xl border border-slate-200 p-2.5">
          {packagingRows.map((row) => (
            <div key={row.type} className={`grid grid-cols-[1.5rem_1fr_5rem_4rem] items-center gap-1.5 rounded-lg px-1 py-1 ${row.checked ? "" : "opacity-50"}`}>
              <input
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={row.checked}
                onChange={(e) => updatePackagingRow(row.type, { checked: e.target.checked })}
              />
              <span className="truncate text-xs text-slate-700" title={row.type}>
                {row.type}
              </span>
              <input
                className="field !py-1 text-xs"
                type="number"
                min="0"
                step="any"
                placeholder="Qty"
                disabled={!row.checked}
                value={row.quantity}
                onChange={(e) => updatePackagingRow(row.type, { quantity: e.target.value })}
              />
              <input
                className="field !py-1 text-xs"
                placeholder="Unit"
                disabled={!row.checked}
                value={row.unit}
                onChange={(e) => updatePackagingRow(row.type, { unit: e.target.value })}
              />
            </div>
          ))}
          <div className="flex gap-1.5 pt-1">
            <input
              className="field !py-1.5 min-w-0 flex-1 text-xs"
              placeholder="Add a packaging type not listed above"
              value={newTypeName}
              onChange={(e) => setNewTypeName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addPackagingType()}
            />
            <button type="button" className="btn-icon shrink-0" title="Add this type" onClick={addPackagingType}>
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          </div>
        </div>
        <div className="mt-1.5 flex justify-end">
          <button type="button" className="btn-primary btn-sm" disabled={updatePackaging.isPending} onClick={handleSavePackaging}>
            {updatePackaging.isPending ? "Saving…" : "Save Packaging BOM"}
          </button>
        </div>
      </div>

      <div>
        <p className="label mb-1.5 flex items-center gap-1.5">
          <ListPlus className="h-3 w-3" /> Custom Fields
        </p>
        <p className="mb-2 text-[10px] text-slate-400">
          Columns the spreadsheet had that aren't one of the fields above — either left over from import, or added here by hand.
        </p>
        <div className="space-y-1.5">
          {extra.map(([key, value], idx) => (
            <div key={idx} className="flex gap-1.5">
              <input className="field !py-1.5 w-1/3 text-xs font-bold" value={key} disabled />
              <input className="field !py-1.5 flex-1 text-xs" value={value} onChange={(e) => updateExtraValue(idx, e.target.value)} />
              <button type="button" className="btn-icon shrink-0" title="Remove this field" onClick={() => removeExtra(idx)}>
                <X className="h-3.5 w-3.5" strokeWidth={2.25} />
              </button>
            </div>
          ))}
          <div className="flex gap-1.5">
            <input className="field !py-1.5 w-1/3 text-xs" placeholder="New field name" value={newFieldName} onChange={(e) => setNewFieldName(e.target.value)} />
            <input className="field !py-1.5 flex-1 text-xs" placeholder="Value" value={newFieldValue} onChange={(e) => setNewFieldValue(e.target.value)} />
            <button type="button" className="btn-icon shrink-0" title="Add this field" onClick={addExtra}>
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button type="button" className="btn-primary btn-sm" disabled={updateSku.isPending} onClick={handleSave}>
          {updateSku.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
