import { Link, useSearchParams } from "react-router-dom";
import { Calculator, FileSpreadsheet, Link2, Package, Sparkles, Wand2, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { downloadFile, ApiError } from "../lib/api";
import { BomCatalog } from "../components/BomCatalog";
import { RecipeRequestBanner } from "../components/RecipeRequestBanner";
import { useToast } from "../components/Toast";
import {
  useAddBomPlanItem,
  useBomPlan,
  useCalculateBomPlan,
  useRemoveBomPlanItem,
} from "../lib/hooks";
import { type SuggestedSku } from "../lib/types";
import { CustomerName } from "../components/CustomerName";

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
      calculate.mutate(undefined, { onError: (err) => toast.error(err instanceof ApiError ? err.message : "Queued, but couldn't calculate — check this SKU's packaging spec.") });
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

  const toast = useToast();

  function handleRemoveItem(itemId: string, productName: string, remainingAfter: number) {
    if (!window.confirm(`Remove "${productName}" from this plan?`)) return;
    removeItem.mutate(itemId, {
      onSuccess: () =>
        remainingAfter > 0 &&
        calculate.mutate(undefined, { onError: (err) => toast.error(err instanceof ApiError ? err.message : "Removed, but couldn't recalculate the rest of the plan.") }),
    });
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

      {(canManageCatalog || canSendToPreInventory) && <BomCatalog canEdit={canManageCatalog} />}

      <div className="space-y-4">
        {!plan ? null : (
            <>
              {plan.status === "DRAFT" && plan.suggestedSkus && plan.suggestedSkus.length > 0 && <SkuMatchSuggestions planId={plan.id} suggestions={plan.suggestedSkus} />}
              {plan.status === "DRAFT" && plan.purchaseOrderItemId && <RecipeRequestBanner purchaseOrderItemId={plan.purchaseOrderItemId} />}
              <div className="card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-gradient-to-r from-emerald-50 to-white px-5 py-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-black text-slate-900">{plan.name}</h2>
                      <span className={`rounded-full px-2 py-0.5 text-micro font-bold uppercase ${plan.status === "CALCULATED" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                        {plan.status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">{plan.items.length} SKU(s) queued</p>
                    {plan.linkedOrder && (
                      <Link
                        to={`/purchase-orders/${plan.linkedOrder.purchaseOrderId}`}
                        className="mt-1 inline-flex items-center gap-1 text-micro font-bold text-emerald-700 hover:underline"
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
                          <td className="font-semibold text-slate-700"><CustomerName name={i.customerName} /></td>
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
                        </tr>
                      </thead>
                      <tbody>
                        {plan.result.lines.map((l, idx) => {
                          return (
                            <tr key={idx}>
                              <td>
                                <span className={`rounded-full px-2 py-0.5 text-micro font-bold uppercase ${CATEGORY_COLOR[l.category] ?? ""}`}>{CATEGORY_LABEL[l.category] ?? l.category}</span>
                              </td>
                              <td className="font-semibold text-slate-700">{l.component}</td>
                              <td className="text-slate-600">{l.spec}</td>
                              <td className="text-center font-mono">{l.baseQty}</td>
                              <td className="text-center font-mono">{l.bufferQty}</td>
                              <td className="text-center font-mono font-bold text-emerald-700">{l.totalQty}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
      </div>

    </div>
  );
}
