import { useEffect, useState, type ChangeEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Beaker, Calculator, ClipboardList, FileSpreadsheet, FlaskConical, Link2, Plus, Upload, Wand2, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { downloadFile, ApiError } from "../lib/api";
import { downloadRecipeImportTemplate, parseRecipeWorkbook } from "../lib/recipeImport";
import { EmptyState } from "../components/EmptyState";
import { RecipeRequestBanner } from "../components/RecipeRequestBanner";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import {
  useAddRmPlanItem,
  useCalculateRmPlan,
  useCreateRmPlan,
  useImportRecipes,
  useRecipes,
  useRemoveRmPlanItem,
  useRmPlan,
  useRmPlans,
  useSendRmPlanToPreInventory,
  useUpdateRmCosting,
} from "../lib/hooks";
import type { CostingParams, SuggestedRecipe } from "../lib/types";

// Same idea as Packaging BOM's SkuMatchSuggestions — shown above
// RecipeRequestBanner's "no catalog match" framing when the PO's product
// name came close to a real Recipe. Batch size is editable here (unlike
// BOM's target yield) since the suggestion's default is just the PO
// line's raw quantity, which is only meaningful as a Kg batch size when
// the PO was actually recorded in Kg — see rm-plan.routes.ts's own note.
function RecipeMatchSuggestions({ planId, suggestions }: { planId: string; suggestions: SuggestedRecipe[] }) {
  const toast = useToast();
  const addItem = useAddRmPlanItem(planId);
  const calculate = useCalculateRmPlan(planId);
  const [batchSizes, setBatchSizes] = useState<Record<string, string>>(() => Object.fromEntries(suggestions.map((s) => [s.recipeId, String(s.defaultBatchSizeKg)])));

  async function handleUse(s: SuggestedRecipe) {
    const batchSizeKg = Number(batchSizes[s.recipeId]);
    if (!Number.isFinite(batchSizeKg) || batchSizeKg <= 0) return toast.error("Enter a valid batch size (Kg) first.");
    try {
      await addItem.mutateAsync({ recipeId: s.recipeId, batchSizeKg });
      calculate.mutate(undefined, { onError: (err) => toast.error(err instanceof ApiError ? err.message : "Queued, but couldn't calculate — check this Recipe's ingredients.") });
      toast.success(`Queued "${s.recipeName}" — calculating.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not queue this Recipe");
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-brand-200 bg-brand-50/60 px-3.5 py-3">
      <p className="flex items-center gap-1.5 text-xs font-bold text-brand-700">
        <Wand2 className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} /> No exact match — did you mean one of these? (Likely a typo in the PO's product name, not a missing formulation.)
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {suggestions.map((s) => (
          <div key={s.recipeId} className="flex items-center gap-1.5 rounded-lg border border-brand-300 bg-white px-2.5 py-1.5 shadow-soft">
            <span className="text-xs font-bold text-brand-700">
              {s.recipeName} <span className="font-normal text-slate-400">({Math.round(s.score * 100)}% match)</span>
            </span>
            <input
              className="field w-20 px-2 py-1 text-[11px]"
              type="number"
              min="0"
              step="any"
              value={batchSizes[s.recipeId] ?? ""}
              onChange={(e) => setBatchSizes((prev) => ({ ...prev, [s.recipeId]: e.target.value }))}
              title="Batch size (Kg)"
            />
            <button type="button" className="btn-primary btn-sm" disabled={addItem.isPending} onClick={() => handleUse(s)}>
              Use
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// The manufacturing/packaging cost inputs behind every RM Costing plan —
// R&D's own domain, same reasoning as Recipe formulation itself (see
// PATCH /plans/:id/costing's own comment): PPIC consumes this, doesn't
// set it.
const COSTING_FIELDS: { key: keyof CostingParams; label: string }[] = [
  { key: "mfgLossPct", label: "Mfg Loss %" },
  { key: "packSizeG", label: "Pack Size (g)" },
  { key: "testCost", label: "Testing Cost" },
  { key: "jarCost", label: "Jar Cost" },
  { key: "scoopCost", label: "Scoop Cost" },
  { key: "labelCost", label: "Label Cost" },
  { key: "convCost", label: "Conversion Cost" },
  { key: "ccbCost", label: "CCB/Copp Cost" },
  { key: "profitPct", label: "Profit %" },
  { key: "gstPct", label: "GST %" },
];

export function RmCostingPage() {
  const { hasRole } = useAuth();
  const canSendToPreInventory = hasRole("PPIC");

  // Deep-linkable via ?plan=<id> — reached from a PO's "Generate" pill on
  // its detail page (the common case), but R&D can also browse/create a
  // plan by hand below (Active RM Plan card) for a plan that isn't tied
  // to any one PO — e.g. costing a formulation ahead of a customer's PO.
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedPlanId = searchParams.get("plan") ?? undefined;
  function selectPlan(id: string | undefined) {
    setSearchParams(id ? { plan: id } : {}, { replace: true });
  }
  const { data: plan } = useRmPlan(selectedPlanId);
  const calculate = useCalculateRmPlan(selectedPlanId ?? "");
  const removeItem = useRemoveRmPlanItem(selectedPlanId ?? "");
  const updateCosting = useUpdateRmCosting(selectedPlanId ?? "");
  const sendToPreInventory = useSendRmPlanToPreInventory(selectedPlanId ?? "");

  const toast = useToast();

  const canEditCosting = hasRole("RND");

  // Active RM Plan — search/select any existing plan, or start a
  // brand-new one not tied to a PO. R&D-only, same reasoning as
  // Costing Profile/Import Recipes below.
  const { data: plans } = useRmPlans();
  const [planSearch, setPlanSearch] = useState("");
  const filteredPlans = plans?.filter((p) => p.name.toLowerCase().includes(planSearch.trim().toLowerCase()));
  const createPlan = useCreateRmPlan();
  const [newPlanName, setNewPlanName] = useState("");
  const [showNewPlan, setShowNewPlan] = useState(false);

  // Recipe Catalog — manually queue any known Recipe straight into the
  // open plan, without waiting on a PO's own auto-match.
  const { data: recipes } = useRecipes();
  const [recipeId, setRecipeId] = useState("");
  const [batchSizeKg, setBatchSizeKg] = useState("");
  const addItem = useAddRmPlanItem(selectedPlanId ?? "");

  const importRecipes = useImportRecipes();
  const [recipeStatus, setRecipeStatus] = useState("");

  async function handleImportRecipes(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setRecipeStatus("Reading file…");
    try {
      const buffer = await file.arrayBuffer();
      const recipesPayload = parseRecipeWorkbook(buffer);
      if (!recipesPayload.length) {
        setRecipeStatus("No recognizable ingredient rows found — each sheet needs an Ingredient and a g/serving column.");
        return;
      }
      const result = await importRecipes.mutateAsync(recipesPayload);
      setRecipeStatus(`Imported ${result.recipesUpserted} recipe(s), ${result.ingredientsUpserted} ingredient row(s).`);
      toast.success(`Imported ${result.recipesUpserted} recipe(s), ${result.ingredientsUpserted} ingredient row(s) — any matching PPIC request has been notified.`);
    } catch (err) {
      const msg = `Import failed: ${err instanceof ApiError ? err.message : "unknown error"}`;
      setRecipeStatus(msg);
      toast.error(msg);
    }
  }

  const [costingDraft, setCostingDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (plan) setCostingDraft(Object.fromEntries(Object.entries(plan.costingParams).map(([k, v]) => [k, String(v)])));
  }, [plan?.id, plan?.costingParams]);

  function handleSaveCosting() {
    const parsed = Object.fromEntries(Object.entries(costingDraft).map(([k, v]) => [k, Number(v)]));
    if (!plan || plan.items.length === 0) {
      updateCosting.mutate(parsed);
      return;
    }
    updateCosting.mutate(parsed, {
      onSuccess: () => calculate.mutate(undefined, { onError: (err) => toast.error(err instanceof ApiError ? err.message : "Saved, but couldn't recalculate the plan.") }),
    });
  }

  function handleRemoveItem(itemId: string, recipeName: string, remainingAfter: number) {
    if (!window.confirm(`Remove "${recipeName}" from this plan?`)) return;
    removeItem.mutate(itemId, {
      onSuccess: () =>
        remainingAfter > 0 &&
        calculate.mutate(undefined, { onError: (err) => toast.error(err instanceof ApiError ? err.message : "Removed, but couldn't recalculate the rest of the plan.") }),
    });
  }

  async function handleSendToPreInventory(planName: string) {
    if (!window.confirm(`Send this plan's RM procurement quantities to Pre-Inventory as new requirements?`)) return;
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
        <div className="stat-icon bg-amber-50 text-amber-600">
          <FlaskConical className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">RM Costing</h1>
          <p className="text-sm text-slate-500">Scale a formulation to a batch size and cost it end to end, RM through GST.</p>
        </div>
      </div>

      <div className={canEditCosting ? "grid grid-cols-1 gap-4 lg:grid-cols-[20rem_1fr]" : "space-y-4"}>
        {canEditCosting && (
          <div className="space-y-4">
            <div className="card p-4">
              <p className="label">Active RM Plan</p>
              <div className="mb-2">
                <SearchBar value={planSearch} onChange={setPlanSearch} placeholder="Search plans…" />
              </div>
              <select className="field" value={selectedPlanId ?? ""} onChange={(e) => selectPlan(e.target.value || undefined)}>
                <option value="">— Select a plan —</option>
                {filteredPlans?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.status})
                  </option>
                ))}
              </select>
              <button className="btn-ghost mt-2 w-full" onClick={() => setShowNewPlan((s) => !s)}>
                <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> New Plan
              </button>
              {showNewPlan && (
                <div className="mt-2 flex gap-2">
                  <input className="field text-xs" placeholder="Plan name" value={newPlanName} onChange={(e) => setNewPlanName(e.target.value)} />
                  <button
                    className="btn-primary shrink-0 text-xs"
                    onClick={async () => {
                      if (!newPlanName.trim()) return;
                      const p = await createPlan.mutateAsync({ name: newPlanName.trim() });
                      setNewPlanName("");
                      setShowNewPlan(false);
                      selectPlan(p.id);
                    }}
                  >
                    Create
                  </button>
                </div>
              )}
            </div>

            <div className="card p-4">
              <p className="label">Recipe Catalog</p>
              <select className="field mb-2" value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
                <option value="">— Select a recipe —</option>
                {recipes?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.ingredientCount} ingredients)
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                <input type="number" step="any" placeholder="Batch KG" className="field font-mono" value={batchSizeKg} onChange={(e) => setBatchSizeKg(e.target.value)} />
                <button
                  className="btn-primary shrink-0"
                  disabled={!selectedPlanId}
                  onClick={async () => {
                    if (!recipeId || !batchSizeKg) return;
                    try {
                      await addItem.mutateAsync({ recipeId, batchSizeKg: Number(batchSizeKg) });
                      setRecipeId("");
                      setBatchSizeKg("");
                      calculate.mutate(undefined, { onError: (err) => toast.error(err instanceof ApiError ? err.message : "Added, but couldn't calculate — check this Recipe's ingredients.") });
                    } catch (err) {
                      toast.error(err instanceof ApiError ? err.message : "Could not add this Recipe");
                    }
                  }}
                >
                  Add
                </button>
              </div>
            </div>

            <div className="card p-4">
              <p className="label flex items-center gap-1.5">
                <Beaker className="h-3.5 w-3.5" /> Import Recipes (RM Costing)
              </p>
              <p className="mb-2 text-[10px] text-slate-400">One sheet per recipe. Any row with an Ingredient/Material and a g/serving or Quantity column is picked up automatically.</p>
              <button type="button" className="btn-ghost mb-1.5 block w-full text-center" onClick={downloadRecipeImportTemplate}>
                <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Sample
              </button>
              <label className="btn-ghost block w-full cursor-pointer text-center">
                <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> Choose Spreadsheet…
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportRecipes} />
              </label>
              {recipeStatus && <p className="mt-2 text-[10px] text-slate-400">{recipeStatus}</p>}
            </div>

            {plan && (
              <div className="card h-fit p-4">
                <p className="label">Costing Profile</p>
                <p className="mb-2 text-[10px] text-slate-400">R&D's own inputs — mfg loss, testing, and per-unit packaging costs behind this plan's pricing.</p>
                <div className="grid grid-cols-2 gap-2">
                  {COSTING_FIELDS.map((f) => (
                    <div key={f.key}>
                      <label className="mb-0.5 block text-[9px] font-bold text-slate-400">{f.label}</label>
                      <input
                        type="number"
                        step="any"
                        className="field !py-1.5 text-xs"
                        value={costingDraft[f.key] ?? ""}
                        onChange={(e) => setCostingDraft((v) => ({ ...v, [f.key]: e.target.value }))}
                        onKeyDown={(e) => e.key === "Enter" && handleSaveCosting()}
                      />
                    </div>
                  ))}
                </div>
                <button className="btn-primary mt-2 w-full text-xs" disabled={updateCosting.isPending} onClick={handleSaveCosting}>
                  {updateCosting.isPending ? "Saving…" : "Save Costing Profile"}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="space-y-4">
        {!plan ? (
          <EmptyState
            icon={Beaker}
            title="No plan open"
            hint={'Every RM Costing plan is generated straight off a PO — open one via "Generate" (or the RM Costing pill) on the PO\'s detail page.'}
            accent="amber"
          />
        ) : (
            <>
              {plan.status === "DRAFT" && plan.suggestedRecipes && plan.suggestedRecipes.length > 0 && <RecipeMatchSuggestions planId={plan.id} suggestions={plan.suggestedRecipes} />}
              {plan.status === "DRAFT" && plan.purchaseOrderItemId && <RecipeRequestBanner purchaseOrderItemId={plan.purchaseOrderItemId} />}
              <div className="card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-gradient-to-r from-amber-50 to-white px-5 py-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-black text-slate-900">{plan.name}</h2>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${plan.status === "CALCULATED" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                        {plan.status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">{plan.items.length} batch(es) queued</p>
                    {plan.linkedOrder && (
                      <Link
                        to={`/purchase-orders/${plan.linkedOrder.purchaseOrderId}`}
                        className="mt-1 inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 hover:underline"
                      >
                        <Link2 className="h-3 w-3" strokeWidth={2.5} /> {plan.linkedOrder.poNumber ?? "PO"} · {plan.linkedOrder.productName}
                      </Link>
                    )}
                  </div>
                  <button
                    className="btn-primary"
                    disabled={plan.items.length === 0 || calculate.isPending}
                    onClick={() => calculate.mutate(undefined, { onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not calculate this plan") })}
                  >
                    <Calculator className="h-4 w-4" strokeWidth={2.5} /> {calculate.isPending ? "Calculating…" : "Calculate Costing"}
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="table-modern w-full">
                    <thead>
                      <tr>
                        <th>Recipe</th>
                        <th className="text-center">Batch Size (KG)</th>
                        <th className="text-center">Remove</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.items.length === 0 && (
                        <tr>
                          <td colSpan={3} className="p-8 text-center text-xs text-slate-400">
                            No batches queued yet.
                          </td>
                        </tr>
                      )}
                      {plan.items.map((i) => (
                        <tr key={i.id}>
                          <td className="font-semibold text-slate-700">{i.recipeName}</td>
                          <td className="text-center font-mono font-bold text-amber-700">{i.batchSizeKg}</td>
                          <td className="text-center">
                            <button className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" onClick={() => handleRemoveItem(i.id, i.recipeName, plan.items.length - 1)}>
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
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {plan.result.batches.map((b, idx) => {
                      const item = plan.items.find((i) => i.recipeName === b.recipeName);
                      return (
                        <div key={idx} className="card-hover card p-4">
                          <div className="mb-2 flex items-center justify-between">
                            <p className="font-bold text-slate-800">{b.recipeName}</p>
                            {item && (
                              <button
                                className="flex items-center gap-1 text-[10px] font-bold text-amber-600 hover:underline"
                                onClick={() => downloadFile(`/api/rm-costing/plans/${plan.id}/items/${item.id}/dispensing.pdf`, `BMR_${b.recipeName}.pdf`)}
                              >
                                <FileSpreadsheet className="h-3 w-3" strokeWidth={2.5} /> Dispensing PDF
                              </button>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-1 text-[11px] text-slate-500">
                            <p>Batch Size: <span className="font-mono font-bold text-slate-700">{b.batchSizeKg} Kg</span></p>
                            <p>Servings: <span className="font-mono font-bold text-slate-700">{b.servingsPerBatch.toFixed(1)}</span></p>
                            <p>Protein %: <span className="font-mono font-bold text-slate-700">{b.proteinPctInBatch.toFixed(1)}%</span></p>
                            <p>RM Cost: <span className="font-mono font-bold text-slate-700">₹{b.totalRmCost.toFixed(0)}</span></p>
                            <p className="col-span-2 mt-1 border-t border-slate-100 pt-1 text-sm">
                              Price / Pouch: <span className="font-mono font-black text-amber-700">₹{b.pricePerPouch.toFixed(2)}</span>
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="card overflow-hidden">
                    <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-amber-50/60 to-white px-5 py-4">
                      <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">Consolidated Master Procurement</h3>
                      <div className="flex gap-2">
                        {canSendToPreInventory && (
                          <button
                            className="btn-primary btn-sm"
                            disabled={sendToPreInventory.isPending || !!plan.sentToPreInventoryAt}
                            onClick={() => handleSendToPreInventory(plan.name)}
                            title={
                              plan.sentToPreInventoryAt
                                ? "Already sent — recalculate this plan if you need to send an updated result"
                                : "Create a Pre-Inventory requirement for each ingredient above"
                            }
                          >
                            <ClipboardList className="h-3 w-3" strokeWidth={2.5} />{" "}
                            {sendToPreInventory.isPending ? "Sending…" : plan.sentToPreInventoryAt ? "Already Sent" : "Send to Pre-Inventory"}
                          </button>
                        )}
                        <button className="btn-ghost btn-sm" onClick={() => downloadFile(`/api/rm-costing/plans/${plan.id}/export.xlsx`, `FLS_RM_Costing_${plan.id}.xlsx`)}>
                          <FileSpreadsheet className="h-3 w-3" strokeWidth={2.5} /> Excel
                        </button>
                        <button className="btn-ghost btn-sm" onClick={() => downloadFile(`/api/rm-costing/plans/${plan.id}/export.pdf`, `FLS_RM_Master_${plan.id}.pdf`)}>
                          <FileSpreadsheet className="h-3 w-3" strokeWidth={2.5} /> PDF
                        </button>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="table-modern w-full">
                        <thead>
                          <tr>
                            <th>Ingredient</th>
                            <th>Brand</th>
                            <th className="text-center">Total (KG)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.result.procurement.map((line, idx) => (
                            <tr key={idx}>
                              <td className="font-semibold text-slate-700">{line.name}</td>
                              <td className="text-slate-600">{line.brand}</td>
                              <td className="text-center font-mono font-bold text-amber-700">{line.totalKg.toFixed(3)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
