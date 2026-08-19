import { useState, type ChangeEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Box, Calculator, FileSpreadsheet, Link2, Package, Plus, Sparkles, Upload, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { downloadFile } from "../lib/api";
import { parseCatalogWorkbook } from "../lib/catalogImport";
import { EmptyState } from "../components/EmptyState";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import {
  useAddBomPlanItem,
  useBomPlan,
  useBomPlans,
  useBrands,
  useCalculateBomPlan,
  useCreateBomPlan,
  useImportCatalog,
  useRemoveBomPlanItem,
  useSkus,
} from "../lib/hooks";

const CATEGORY_LABEL: Record<string, string> = { "1-Primary": "Primary", "2-Secondary": "Secondary", "3-Tertiary": "Tertiary" };
const CATEGORY_COLOR: Record<string, string> = {
  "1-Primary": "bg-emerald-100 text-emerald-800",
  "2-Secondary": "bg-blue-100 text-blue-800",
  "3-Tertiary": "bg-amber-100 text-amber-800",
};

export function PackagingBomPage() {
  const { hasRole } = useAuth();
  const canImport = hasRole("PPIC", "PURCHASE");

  const { data: plans } = useBomPlans();
  const [planSearch, setPlanSearch] = useState("");
  const filteredPlans = plans?.filter((p) => p.name.toLowerCase().includes(planSearch.trim().toLowerCase()));
  // Deep-linkable via ?plan=<id> — e.g. from an order's Production
  // Pipeline strip — so "View BOM Plan" actually opens that plan.
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedPlanId, setSelectedPlanId] = useState<string | undefined>(searchParams.get("plan") ?? undefined);
  const { data: plan } = useBomPlan(selectedPlanId);
  function selectPlan(id: string | undefined) {
    setSelectedPlanId(id);
    setSearchParams(id ? { plan: id } : {}, { replace: true });
  }
  const createPlan = useCreateBomPlan();
  const calculate = useCalculateBomPlan(selectedPlanId ?? "");
  const removeItem = useRemoveBomPlanItem(selectedPlanId ?? "");

  const { data: brands } = useBrands();
  const [brandId, setBrandId] = useState("");
  const { data: skus } = useSkus(brandId);
  const [yieldBySkuId, setYieldBySkuId] = useState<Record<string, string>>({});
  const addItem = useAddBomPlanItem(selectedPlanId ?? "");

  const importCatalog = useImportCatalog();
  const [importStatus, setImportStatus] = useState("");
  const toast = useToast();

  const [newPlanName, setNewPlanName] = useState("");
  const [showNewPlan, setShowNewPlan] = useState(false);

  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportStatus("Reading file…");
    try {
      const buffer = await file.arrayBuffer();
      const brandsPayload = parseCatalogWorkbook(buffer);
      if (!brandsPayload.length) {
        setImportStatus("No recognizable SKU rows found — check the Product Name column.");
        return;
      }
      const result = await importCatalog.mutateAsync(brandsPayload);
      setImportStatus(`Imported ${result.brandsTouched} brand(s), ${result.skusUpserted} SKU(s).`);
      toast.success(`Imported ${result.brandsTouched} brand(s), ${result.skusUpserted} SKU(s).`);
    } catch (err) {
      const msg = `Import failed: ${err instanceof Error ? err.message : "unknown error"}`;
      setImportStatus(msg);
      toast.error(msg);
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_1fr]">
        <div className="space-y-4">
          <div className="card p-4">
            <p className="label">Active BOM Plan</p>
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
            <p className="label">Catalog</p>
            <select className="field mb-2" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              <option value="">— Select a brand —</option>
              {brands?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.skuCount} SKUs)
                </option>
              ))}
            </select>
            <div className="max-h-72 space-y-1.5 overflow-y-auto pr-0.5">
              {skus?.map((s) => (
                <div key={s.id} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-2">
                  <span className="flex-1 truncate text-xs font-bold text-slate-700">{s.productName}</span>
                  <input
                    type="number"
                    min="1"
                    placeholder="Yield"
                    className="field w-20 !py-1.5 font-mono text-xs"
                    value={yieldBySkuId[s.id] ?? ""}
                    onChange={(e) => setYieldBySkuId((v) => ({ ...v, [s.id]: e.target.value }))}
                  />
                  <button
                    className="btn-primary btn-sm"
                    disabled={!selectedPlanId}
                    onClick={async () => {
                      const targetYield = Number(yieldBySkuId[s.id]);
                      if (!targetYield) return;
                      await addItem.mutateAsync({ skuId: s.id, targetYield });
                      setYieldBySkuId((v) => ({ ...v, [s.id]: "" }));
                    }}
                  >
                    Add
                  </button>
                </div>
              ))}
            </div>
          </div>

          {canImport && (
            <div className="card p-4">
              <p className="label">Import Catalog</p>
              <p className="mb-2 text-[10px] text-slate-400">One sheet per brand, one row per SKU. Columns like Jar, Wad (MM), Scoop (ML) map automatically.</p>
              <label className="btn-ghost block w-full cursor-pointer text-center">
                <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> Choose Spreadsheet…
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
              </label>
              {importStatus && <p className="mt-2 text-[10px] text-slate-400">{importStatus}</p>}
            </div>
          )}
        </div>

        <div className="space-y-4">
          {!plan ? (
            <EmptyState icon={Box} title="Select or create a plan" hint="Choose an existing BOM plan or start a new one to queue SKUs." accent="emerald" />
          ) : (
            <>
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
                        <th>Brand</th>
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
                          <td className="font-semibold text-slate-700">{i.brandName}</td>
                          <td className="text-slate-600">{i.productName}</td>
                          <td className="text-center font-mono font-bold text-emerald-700">{i.targetYield}</td>
                          <td className="text-center">
                            <button className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" onClick={() => removeItem.mutate(i.id)}>
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
                        {plan.result.lines.map((l, idx) => (
                          <tr key={idx}>
                            <td>
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${CATEGORY_COLOR[l.category] ?? ""}`}>{CATEGORY_LABEL[l.category] ?? l.category}</span>
                            </td>
                            <td className="font-semibold text-slate-700">{l.component}</td>
                            <td className="text-slate-600">{l.spec}</td>
                            <td className="text-center font-mono">{l.baseQty}</td>
                            <td className="text-center font-mono">{l.bufferQty}</td>
                            <td className="text-center font-mono font-bold text-emerald-700">{l.totalQty}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
