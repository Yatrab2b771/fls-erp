import { useMemo, useState } from "react";
import { Calculator, Download, PackageSearch } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAddOnPlanProducts, useCalculateAddOn } from "../lib/hooks";
import { exportAddOnPlan } from "../lib/addOnPlanExport";
import type { AddOnPlanMaterialLine, AddOnResult, AddOnSection } from "../lib/types";
import { EmptyState } from "../components/EmptyState";
import { ItemPicker } from "../components/ItemPicker";
import { CustomerName } from "../components/CustomerName";
import { useToast } from "../components/Toast";

// PPIC's quick check, before a PO exists. BD gets a call: "can we get this product urgently?". PPIC picks the product, types the quantity
// and sees the raw material and packaging it needs against live stock, and can download it. Worked out fresh for that quantity (the same
// engines and Kg / packs conversion a PO line uses); nothing is saved.

function StatusPill({ line }: { line: AddOnPlanMaterialLine }) {
  if (line.onHand === null) return <span className="pill border-slate-200 bg-slate-50 text-slate-500" title="No matching item in the catalog, so stock cannot be checked">Not in catalog</span>;
  if (line.short) return <span className="pill border-rose-200 bg-rose-50 text-rose-700">Short</span>;
  return <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Complete</span>;
}

function MaterialTable({ title, section, withLevel }: { title: string; section: AddOnSection; withLevel: boolean }) {
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-black text-slate-800">{title}</h2>
      </div>
      {!section.available ? (
        <p className="px-4 py-5 text-sm text-amber-700">{section.problem}</p>
      ) : section.lines.length === 0 ? (
        <p className="px-4 py-5 text-sm text-slate-500">This product needs no {title.toLowerCase()}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5">Material</th>
                {withLevel && <th className="px-3 py-2.5">Level</th>}
                <th className="px-3 py-2.5 text-right">Required</th>
                <th className="px-3 py-2.5 text-right">In Stock</th>
                <th className="px-3 py-2.5 text-right">Short</th>
                <th className="px-3 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {section.lines.map((l) => (
                <tr key={`${l.name}-${l.detail ?? ""}`} className="border-b border-slate-50">
                  <td className={`px-4 py-2.5 ${l.short ? "font-bold text-rose-700" : "font-bold text-slate-800"}`}>
                    {l.name}
                    {l.detail && <span className="ml-1.5 font-normal text-slate-400">{l.detail}</span>}
                  </td>
                  {withLevel && <td className="px-3 py-2.5 text-slate-600">{l.group ?? "-"}</td>}
                  <td className="px-3 py-2.5 text-right font-mono text-slate-700">
                    {l.requiredQty} {l.unit}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-slate-600">{l.onHand === null ? "-" : l.onHand}</td>
                  <td className="px-3 py-2.5 text-right font-mono font-bold text-rose-600">{l.short ? `${l.shortfallQty} ${l.unit}` : "-"}</td>
                  <td className="px-3 py-2.5">
                    <StatusPill line={l} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AddOnPlanPage() {
  const toast = useToast();
  const { data: products, isLoading: loadingProducts } = useAddOnPlanProducts();
  const calculate = useCalculateAddOn();
  const [productKey, setProductKey] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState<"KG" | "PACKS">("KG");
  const [result, setResult] = useState<AddOnResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The dropdown: only products that have both a Packaging BOM and an RM formulation (type to filter)
  const options = useMemo(() => (products ?? []).map((p) => ({ id: p.key, name: `${p.name} · ${p.customerName}` })), [products]);
  const product = (products ?? []).find((p) => p.key === productKey) ?? null;

  async function run() {
    setError(null);
    const qty = Number(quantity);
    if (!product) return setError("Pick a product.");
    if (!(qty > 0)) return setError("Enter the quantity.");
    try {
      setResult(await calculate.mutateAsync({ customerId: product.customerId, name: product.name, quantity: qty, unit }));
    } catch (err) {
      setResult(null);
      setError(err instanceof ApiError ? err.message : "Could not work it out");
    }
  }

  const s = result?.summary;
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-brand-500/10 text-brand-600">
          <PackageSearch className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Add on Plan</h1>
          <p className="text-sm text-slate-500">BD asks if a product can be had urgently: pick it, enter the quantity, and see the raw material and packaging it needs against stock.</p>
        </div>
      </div>

      <div className="card space-y-3 p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_8rem_auto] sm:items-end">
          <div>
            <label className="label">Product</label>
            <ItemPicker
              items={options}
              value={productKey}
              onChange={(v) => {
                setProductKey(v);
                setResult(null);
              }}
              placeholder={loadingProducts ? "Loading products…" : "— Pick a product (or type to search) —"}
              icon={PackageSearch}
            />
          </div>
          <div>
            <label className="label">Quantity</label>
            <input
              className="field"
              type="number"
              min="0"
              step="any"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void run()}
              placeholder="e.g. 500"
            />
          </div>
          <div>
            <label className="label">Unit</label>
            <select className="field" value={unit} onChange={(e) => setUnit(e.target.value as "KG" | "PACKS")}>
              <option value="KG">Kg</option>
              <option value="PACKS">Packs</option>
            </select>
          </div>
          <button type="button" className="btn-primary" disabled={calculate.isPending} onClick={() => void run()}>
            <Calculator className="h-4 w-4" strokeWidth={2.5} /> {calculate.isPending ? "Working…" : "Calculate"}
          </button>
        </div>
        {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      </div>

      {!loadingProducts && products?.length === 0 && <EmptyState icon={PackageSearch} title="No product to check yet" hint="A product shows here once R&D has added both its Packaging BOM and its RM formulation." accent="brand" />}

      {result && s && (
        <div className="space-y-4">
          <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
            <div className="min-w-0">
              <p className="text-lg font-black text-slate-900">
                {result.productName} <span className="text-sm font-normal text-slate-400">· <CustomerName name={result.customerName} /></span>
              </p>
              <p className="text-sm text-slate-600">
                For <b>{result.quantity} {result.unit === "KG" ? "Kg" : "Packs"}</b>
                {result.note && <span className="text-slate-400"> ({result.note})</span>}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {s.total === 0 ? (
                  <span className="pill border-slate-200 bg-slate-50 text-slate-500">Nothing could be worked out</span>
                ) : s.short > 0 ? (
                  <span className="pill border-rose-200 bg-rose-50 text-rose-700">{s.short} of {s.total} materials short</span>
                ) : (
                  <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">All checked materials are in stock</span>
                )}
                {s.notInCatalog > 0 && <span className="pill border-slate-200 bg-slate-50 text-slate-500">{s.notInCatalog} not in catalog (stock not checked)</span>}
              </div>
            </div>
            <button type="button" className="btn-ghost" onClick={() => { exportAddOnPlan(result); toast.success("Excel downloaded."); }}>
              <Download className="h-4 w-4" strokeWidth={2.5} /> Download Excel
            </button>
          </div>

          <MaterialTable title="Raw Material" section={result.rm} withLevel={false} />
          <MaterialTable title="Packaging Material" section={result.pm} withLevel />
        </div>
      )}
    </div>
  );
}
