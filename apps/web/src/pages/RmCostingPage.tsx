import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Calculator, FileSpreadsheet, FlaskConical, Link2, Wand2, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { downloadFile, ApiError } from "../lib/api";
import { RmBomCatalog } from "../components/RmBomCatalog";
import { RecipeRequestBanner } from "../components/RecipeRequestBanner";
import { useToast } from "../components/Toast";
import {
  useAddRmPlanItem,
  useCalculateRmPlan,
  useRemoveRmPlanItem,
  useRmPlan,
} from "../lib/hooks";
import type { SuggestedRecipe } from "../lib/types";

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
              className="field w-20 px-2 py-1 text-tiny"
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

export function RmCostingPage() {
  const { hasRole } = useAuth();

  // Deep-linkable via ?plan=<id> — reached from a PO's "Generate" pill on its detail page.
  const [searchParams] = useSearchParams();
  const selectedPlanId = searchParams.get("plan") ?? undefined;
  const { data: plan } = useRmPlan(selectedPlanId);
  const calculate = useCalculateRmPlan(selectedPlanId ?? "");
  const removeItem = useRemoveRmPlanItem(selectedPlanId ?? "");

  const toast = useToast();

  const canEditCosting = hasRole("RND");
  const canViewRecipes = hasRole("PPIC");

  // With many batches on one plan, showing every recipe's full ingredient
  // table at once makes the page scroll forever — instead, show a compact
  // picker row of every recipe and only render the selected one's table.
  const [selectedBatchIdx, setSelectedBatchIdx] = useState(0);
  useEffect(() => setSelectedBatchIdx(0), [selectedPlanId]);

  function handleRemoveItem(itemId: string, recipeName: string, remainingAfter: number) {
    if (!window.confirm(`Remove "${recipeName}" from this plan?`)) return;
    removeItem.mutate(itemId, {
      onSuccess: () =>
        remainingAfter > 0 &&
        calculate.mutate(undefined, { onError: (err) => toast.error(err instanceof ApiError ? err.message : "Removed, but couldn't recalculate the rest of the plan.") }),
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-amber-50 text-amber-600">
          <FlaskConical className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">RM BOM</h1>
          <p className="text-sm text-slate-500">Scale a formulation to a batch size and get the RM quantity to procure.</p>
        </div>
      </div>

      {(canEditCosting || canViewRecipes) && <RmBomCatalog canEdit={canEditCosting} />}

      {/* A plan only shows here when it was opened from a PO's "Generate"; plans are never made by hand any more. */}
      <div className="space-y-4">
        {!plan ? null : (
            <>
              {plan.status === "DRAFT" && plan.suggestedRecipes && plan.suggestedRecipes.length > 0 && <RecipeMatchSuggestions planId={plan.id} suggestions={plan.suggestedRecipes} />}
              {plan.status === "DRAFT" && plan.purchaseOrderItemId && <RecipeRequestBanner purchaseOrderItemId={plan.purchaseOrderItemId} />}
              <div className="card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-gradient-to-r from-amber-50 to-white px-5 py-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-black text-slate-900">{plan.name}</h2>
                      <span className={`rounded-full px-2 py-0.5 text-micro font-bold uppercase ${plan.status === "CALCULATED" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                        {plan.status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">{plan.items.length} batch(es) queued</p>
                    {plan.linkedOrder && (
                      <Link
                        to={`/purchase-orders/${plan.linkedOrder.purchaseOrderId}`}
                        className="mt-1 inline-flex items-center gap-1 text-micro font-bold text-amber-700 hover:underline"
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
                    <Calculator className="h-4 w-4" strokeWidth={2.5} /> {calculate.isPending ? "Calculating…" : "Calculate RM BOM"}
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
                  <div className="flex flex-wrap gap-1.5">
                    {plan.result.batches.map((b, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition ${
                          idx === selectedBatchIdx
                            ? "border-amber-400 bg-amber-50 text-amber-800"
                            : "border-slate-200 bg-white text-slate-600 hover:border-amber-300 hover:text-amber-700"
                        }`}
                        onClick={() => setSelectedBatchIdx(idx)}
                      >
                        {b.recipeName}
                      </button>
                    ))}
                  </div>

                  {plan.result.batches[selectedBatchIdx] && (
                    <div className="card overflow-hidden">
                      {(() => {
                        const b = plan.result.batches[selectedBatchIdx]!;
                        const item = plan.items.find((i) => i.recipeName === b.recipeName);
                        return (
                          <>
                            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-amber-50/50 px-4 py-2.5">
                              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                                <p className="font-bold text-slate-800">{b.recipeName}</p>
                                <span className="font-mono text-tiny text-slate-500">Batch {b.batchSizeKg} Kg</span>
                              </div>
                              {item && (
                                <button
                                  className="flex items-center gap-1 text-micro font-bold text-amber-600 hover:underline"
                                  onClick={() => downloadFile(`/api/rm-costing/plans/${plan.id}/items/${item.id}/dispensing.pdf`, `BMR_${b.recipeName}.pdf`)}
                                >
                                  <FileSpreadsheet className="h-3 w-3" strokeWidth={2.5} /> Dispensing PDF
                                </button>
                              )}
                            </div>
                            {/* Same S.No/Item Code/Ingredients/Make/UOM/Qty.Kg/Req.Batch
                                shape as the downloaded Dispensing PDF (rm-pdf.ts) — shown
                                on screen too now, not just in the PDF. */}
                            <div className="overflow-x-auto">
                              <table className="table-modern w-full text-xs">
                                <thead>
                                  <tr>
                                    <th className="text-center">S.No</th>
                                    <th>Item Code</th>
                                    <th>Ingredients</th>
                                    <th>Make</th>
                                    <th className="text-center">UOM</th>
                                    <th className="text-right">Qty./Kg</th>
                                    <th className="text-right">Req./Batch</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {b.ingredients.map((ing, i) => {
                                    const propPerKg = ing.gPerServing / b.gmPerServing;
                                    return (
                                      <tr key={i}>
                                        <td className="text-center font-mono text-slate-400">{i + 1}</td>
                                        <td className="font-mono text-slate-600">{ing.itemCode || "—"}</td>
                                        <td className="font-semibold text-slate-700">{ing.name}</td>
                                        <td className="text-slate-500">{ing.brand}</td>
                                        <td className="text-center text-slate-400">Kg</td>
                                        <td className="text-right font-mono">{propPerKg.toFixed(4)}</td>
                                        <td className="text-right font-mono font-bold text-amber-700">{ing.qtyInKg.toFixed(3)}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}

                  <div className="card overflow-hidden">
                    <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-amber-50/60 to-white px-5 py-4">
                      <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">Consolidated Master Procurement</h3>
                      <div className="flex gap-2">
                                                <button className="btn-ghost btn-sm" onClick={() => downloadFile(`/api/rm-costing/plans/${plan.id}/export.xlsx`, `FLS_RM_Plan_${plan.id}.xlsx`)}>
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
                            <th>Item Code</th>
                            <th>Ingredient</th>
                            <th>Brand</th>
                            <th className="text-center">Total (KG)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.result.procurement.map((line, idx) => (
                            <tr key={idx}>
                              <td className="font-mono text-slate-500">{line.itemCode || "—"}</td>
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
  );
}
