import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, GitBranch, Search } from "lucide-react";
import { useInProductionBom } from "../lib/bomSwitchHooks";
import { EmptyState } from "../components/EmptyState";
import { RndBomControl } from "../components/RndBomControl";
import { CustomerName } from "../components/CustomerName";

// R&D's "In Production: BOM change": the products that are with Production and still have batches R&D can change (not past Bulk QC). R&D picks
// another BOM version for a product (Display, V1 or V2): the batches not dispensed yet follow it, the ones already dispensed keep their material.
// Production and the Day Store are told; PPIC is not, and PPIC's plan and lists are not touched.

export function RndProductionBomPage() {
  const { data, isLoading } = useInProductionBom();
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const rows = (data ?? []).filter((r) => !q || [r.productName, r.customerName, r.poNumber ?? "", r.plantName ?? ""].some((v) => v.toLowerCase().includes(q)));

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-violet-500/10 text-violet-600">
          <GitBranch className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">In Production: BOM change</h1>
          <p className="text-sm text-slate-500">
            Products with Production whose batches can still change. A new version applies to the batches not dispensed yet; a dispensed batch keeps its material and the Day Store is asked for what the new version still needs for it. PPIC is not told.
          </p>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" strokeWidth={2.25} />
        <input className="field !pl-8 !text-xs" placeholder="Search product, customer, PO or Plant" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={GitBranch} title={q ? "No matches" : "No product to change"} hint="A product shows here once it is with Production and still has a batch before Bulk QC has passed." accent="slate" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Plant</th>
                <th className="px-4 py-3 text-right">Qty</th>
                <th className="px-4 py-3 text-right" title="Batches still to be dispensed: they follow a new version">Not dispensed</th>
                <th className="px-4 py-3 text-right" title="Dispensed, before Bulk QC has passed: they keep their material">In production</th>
                <th className="px-4 py-3 text-right" title="Past Bulk QC: nothing to change">Past Bulk QC</th>
                <th className="px-4 py-3 text-right">BOM version</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.purchaseOrderItemId} className="transition hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-bold text-slate-700">
                    <Link to={`/purchase-orders/${r.purchaseOrderId}`} className="hover:text-brand-600 hover:underline">
                      {r.poNumber ?? r.purchaseOrderId.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600"><CustomerName name={r.customerName} /></td>
                  <td className="px-4 py-2.5 text-slate-700">{r.productName}</td>
                  <td className="px-4 py-2.5 text-slate-500">{r.plantName ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-600">
                    {r.quantity} {r.unit}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-700">{r.batches.notDispensed}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-700">{r.batches.inProduction}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-400">{r.batches.beyond}</td>
                  <td className="px-4 py-2.5 text-right">
                    <RndBomControl product={{ purchaseOrderItemId: r.purchaseOrderItemId, purchaseOrderId: r.purchaseOrderId, productName: r.productName, activeBomSlot: r.activeBomSlot }} />
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
