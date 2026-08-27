import { useEffect, useState, type ChangeEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Beaker, Calculator, ClipboardList, FileSpreadsheet, FlaskConical, Link2, Plus, Upload, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { downloadFile } from "../lib/api";
import { parseRecipeWorkbook } from "../lib/recipeImport";
import { EmptyState } from "../components/EmptyState";
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
import type { CostingParams } from "../lib/types";

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
  const canImport = hasRole("PPIC");

  const { data: plans } = useRmPlans();
  const [planSearch, setPlanSearch] = useState("");
  const filteredPlans = plans?.filter((p) => p.name.toLowerCase().includes(planSearch.trim().toLowerCase()));
  // Deep-linkable via ?plan=<id> — e.g. from an order's Production
  // Pipeline strip — so "View RM Plan" actually opens that plan.
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedPlanId, setSelectedPlanId] = useState<string | undefined>(searchParams.get("plan") ?? undefined);
  const { data: plan } = useRmPlan(selectedPlanId);
  function selectPlan(id: string | undefined) {
    setSelectedPlanId(id);
    setSearchParams(id ? { plan: id } : {}, { replace: true });
  }
  const createPlan = useCreateRmPlan();
  const calculate = useCalculateRmPlan(selectedPlanId ?? "");
  const removeItem = useRemoveRmPlanItem(selectedPlanId ?? "");
  const updateCosting = useUpdateRmCosting(selectedPlanId ?? "");
  const sendToPreInventory = useSendRmPlanToPreInventory(selectedPlanId ?? "");

  const { data: recipes } = useRecipes();
  const [recipeId, setRecipeId] = useState("");
  const [batchSizeKg, setBatchSizeKg] = useState("");
  const addItem = useAddRmPlanItem(selectedPlanId ?? "");

  const importRecipes = useImportRecipes();
  const [importStatus, setImportStatus] = useState("");
  const toast = useToast();

  const [newPlanName, setNewPlanName] = useState("");
  const [showNewPlan, setShowNewPlan] = useState(false);

  const [costingDraft, setCostingDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (plan) setCostingDraft(Object.fromEntries(Object.entries(plan.costingParams).map(([k, v]) => [k, String(v)])));
  }, [plan?.id, plan?.costingParams]);

  async function handleSendToPreInventory(planName: string) {
    if (!window.confirm(`Send this plan's RM procurement quantities to Pre-Inventory as new requirements?`)) return;
    try {
      const result = await sendToPreInventory.mutateAsync();
      toast.success(`Sent ${result.requirementsCreated} requirement(s) to Pre-Inventory${result.itemsCreated ? `, ${result.itemsCreated} new item(s)` : ""} — from "${planName}".`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send to Pre-Inventory");
    }
  }

  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportStatus("Reading file…");
    try {
      const buffer = await file.arrayBuffer();
      const recipesPayload = parseRecipeWorkbook(buffer);
      if (!recipesPayload.length) {
        setImportStatus("No recognizable ingredient rows found — each sheet needs an Ingredient and a g/serving column.");
        return;
      }
      const result = await importRecipes.mutateAsync(recipesPayload);
      setImportStatus(`Imported ${result.recipesUpserted} recipe(s), ${result.ingredientsUpserted} ingredient row(s).`);
      toast.success(`Imported ${result.recipesUpserted} recipe(s), ${result.ingredientsUpserted} ingredient row(s).`);
    } catch (err) {
      const msg = `Import failed: ${err instanceof Error ? err.message : "unknown error"}`;
      setImportStatus(msg);
      toast.error(msg);
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_1fr]">
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
                  await addItem.mutateAsync({ recipeId, batchSizeKg: Number(batchSizeKg) });
                  setBatchSizeKg("");
                }}
              >
                Add
              </button>
            </div>
          </div>

          {canImport && (
            <div className="card p-4">
              <p className="label">Import Recipes</p>
              <p className="mb-2 text-[10px] text-slate-400">One sheet per recipe. Any row with an Ingredient/Material and a g/serving or Quantity column is picked up automatically.</p>
              <label className="btn-ghost block w-full cursor-pointer text-center">
                <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> Choose Spreadsheet…
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
              </label>
              {importStatus && <p className="mt-2 text-[10px] text-slate-400">{importStatus}</p>}
            </div>
          )}

          {plan && (
            <div className="card p-4">
              <p className="label">Costing Profile</p>
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
                    />
                  </div>
                ))}
              </div>
              <button
                className="btn-primary mt-2 w-full text-xs"
                onClick={() => updateCosting.mutate(Object.fromEntries(Object.entries(costingDraft).map(([k, v]) => [k, Number(v)])))}
              >
                {updateCosting.isPending ? "Saving…" : "Save Costing Profile"}
              </button>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {!plan ? (
            <EmptyState icon={Beaker} title="Select or create a plan" hint="Choose an existing RM plan or start a new one to queue batches." accent="amber" />
          ) : (
            <>
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
                  <button className="btn-primary" disabled={plan.items.length === 0 || calculate.isPending} onClick={() => calculate.mutate()}>
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
                            <button
                              className="btn-icon hover:!bg-rose-50 hover:!text-rose-600"
                              onClick={() => window.confirm(`Remove "${i.recipeName}" from this plan?`) && removeItem.mutate(i.id)}
                            >
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
                        {canImport && (
                          <button
                            className="btn-primary btn-sm"
                            disabled={sendToPreInventory.isPending}
                            onClick={() => handleSendToPreInventory(plan.name)}
                            title="Create a Pre-Inventory requirement for each ingredient above"
                          >
                            <ClipboardList className="h-3 w-3" strokeWidth={2.5} /> {sendToPreInventory.isPending ? "Sending…" : "Send to Pre-Inventory"}
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
