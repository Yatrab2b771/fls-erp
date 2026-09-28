import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Download, FlaskConical } from "lucide-react";
import { useMaterialConsumptionReport } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { ItemPicker } from "../components/ItemPicker";
import { exportMaterialConsumptionReport } from "../lib/inventoryExport";

const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };

// How much RM/PM actually went into each Product / Batch / PO — one flat
// table pulled from GET /plant-consumption/report (every
// BatchMaterialConsumption row, whichever stage logged it — Dispensing
// or Production's own Plant Consumption). A PreProduction run is one
// Product/Batch by construction today (see that route's own comment),
// so the Product and PO filters below are what turn the same dataset
// into "per Product" vs "per PO" answers — no separate endpoint needed.
// Deep-linkable via ?poId=/?productId=(preProductionId)/?itemId= from
// the PO detail and PreProduction detail pages.
export function MaterialConsumptionReportPage() {
  const [searchParams] = useSearchParams();
  const { data: rows, isLoading } = useMaterialConsumptionReport();

  const [poId, setPoId] = useState(searchParams.get("poId") ?? "");
  const [productId, setProductId] = useState(searchParams.get("preProductionId") ?? "");
  const [itemId, setItemId] = useState(searchParams.get("itemId") ?? "");

  const poOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows ?? []) if (!seen.has(r.poId)) seen.set(r.poId, `${r.poNumber ?? r.poId.slice(0, 8)} · ${r.customerName}`);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const productOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows ?? []) {
      if (poId && r.poId !== poId) continue;
      if (!seen.has(r.preProductionId)) seen.set(r.preProductionId, `${r.productName}${r.batchNo ? ` · ${r.batchNo}` : ""}`);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, poId]);

  const itemOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows ?? []) if (!seen.has(r.itemId)) seen.set(r.itemId, r.itemName);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const filteredRows = (rows ?? []).filter(
    (r) => (!poId || r.poId === poId) && (!productId || r.preProductionId === productId) && (!itemId || r.itemId === itemId),
  );

  const productCount = new Set(filteredRows.map((r) => r.preProductionId)).size;
  const poCount = new Set(filteredRows.map((r) => r.poId)).size;

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-brand-500/10 text-brand-600">
            <FlaskConical className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Material Consumption Report</h1>
            <p className="text-sm text-slate-500">
              {filteredRows.length} item-line(s) across {productCount} product(s) and {poCount} PO(s)
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm" onClick={() => exportMaterialConsumptionReport(filteredRows)} disabled={filteredRows.length === 0}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Report
        </button>
      </div>

      <div className="card flex flex-wrap gap-3 p-4">
        <ItemPicker
          items={poOptions}
          value={poId}
          onChange={(id) => {
            setPoId(id);
            setProductId("");
          }}
          placeholder="— Filter by PO —"
        />
        <ItemPicker items={productOptions} value={productId} onChange={setProductId} placeholder="— Filter by product / batch —" />
        <ItemPicker items={itemOptions} value={itemId} onChange={setItemId} placeholder="— Filter by item —" />
      </div>

      {isLoading || !rows ? (
        <div className="skeleton h-64 w-full" />
      ) : filteredRows.length === 0 ? (
        <EmptyState icon={FlaskConical} title="Nothing here" hint="No consumption logged yet for this filter." accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Batch No</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Consumed</th>
                <th className="px-4 py-3">Wasted</th>
                <th className="px-4 py-3">Rejected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRows.map((r) => (
                <tr key={`${r.preProductionId}-${r.itemId}`} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">{r.poNumber ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{r.customerName}</td>
                  <td className="px-4 py-3 text-slate-500">{r.productName}</td>
                  <td className="px-4 py-3 text-slate-500">{r.batchNo ?? "—"}</td>
                  <td className="px-4 py-3 font-bold text-slate-700">{r.itemName}</td>
                  <td className="px-4 py-3 text-slate-500">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {r.consumedQty} {r.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {r.wastedQty} {r.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {r.rejectedQty} {r.unit}
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
