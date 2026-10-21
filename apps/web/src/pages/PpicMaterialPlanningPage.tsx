import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, Layers } from "lucide-react";
import { usePlants, useSetItemMaterialHold } from "../lib/hooks";
import { ApiError, api, apiAll } from "../lib/api";
import { usePagedList } from "../lib/usePagedList";
import { PRODUCT_STATE_LABEL } from "../lib/materialPlanning";
import { Pagination } from "../components/Pagination";
import { AGING_FIELD, MATERIAL_FIELD, TileFilterBar, ppicFields } from "../components/TileFilterBar";
import { appendParams, useTileFilters } from "../lib/tileFilters";
import { AgingCell } from "../components/AgingCell";
import { exportMaterialPlanningReport } from "../lib/ppicPlanningReports";
import type { MaterialPlanningProduct, MaterialPlanningRow } from "../lib/types";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { ProductActions } from "./PpicPlanningDetailPage";
import { RndBomControl, SlotPill } from "../components/RndBomControl";
import { useAuth } from "../lib/auth";
import { CustomerName } from "../components/CustomerName";

// The Material Planning tile's list — one row per raw/packaging material of
// every planned product: how much is required, how much live stock covers
// under the FIFO queue, how much is short. See apps/api material-planning.ts
// for the queue rules (sent-to-Production first, then FIFO by PO date; a
// held / Regulatory-Not-Approved product doesn't claim stock and only shows
// an "if released" preview).

// A material row as the server sends it: the row itself plus the product it belongs to.
// What Purchase has on order for a short material: the PI lines still to arrive.
interface OnOrder {
  quantity: number;
  nextEta: string;
  lines: { quantity: number; piNumber: string; vendorName: string; eta: string }[];
}
type MaterialRowWithProduct = MaterialPlanningRow & { product: MaterialPlanningProduct; onOrder: OnOrder | null };

function fmt(n: number | null, unit: string): string {
  return n === null ? "—" : `${n} ${unit}`;
}

// One pill for the row: Covered, "Short · 40 Kg" (the missing quantity rides on the pill), or Not in catalog.
function StatusPill({ row, onOrder }: { row: MaterialPlanningRow; onOrder: OnOrder | null }) {
  if (row.status === "COVERED") return <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Covered</span>;
  if (row.status === "SHORT") {
    return (
      <span className="inline-flex flex-col items-start gap-1">
        <span className="pill border-rose-200 bg-rose-50 text-rose-700">
          Short · <span className="font-mono">{fmt(row.shortQty || null, row.unit)}</span>
        </span>
        {onOrder && (
          <span
            className="text-micro font-semibold text-brand-700"
            title={onOrder.lines.map((l) => `${l.quantity} ${row.unit} · ${l.piNumber} · ${l.vendorName} · ETA ${new Date(l.eta).toLocaleDateString()}`).join("\n")}
          >
            {onOrder.quantity} {row.unit} on order · next ETA {new Date(onOrder.nextEta).toLocaleDateString()}
          </span>
        )}
      </span>
    );
  }
  return <span className="pill border-slate-200 bg-slate-50 text-slate-500">Not in catalog</span>;
}

export function PpicMaterialPlanningPage() {
  const { hasRole } = useAuth();
  const setHold = useSetItemMaterialHold();
  const { data: plants } = usePlants();
  const plantName = new Map((plants ?? []).map((p) => [p.id, p.name]));
  const toast = useToast();

  const tileFilters = useTileFilters();

  // Server-side: the FIFO allocation runs over every product, then the rows are
  // filtered, grouped (products with a shortfall first) and cut into pages there.
  const serverParams = { ...tileFilters.params };
  const paged = usePagedList<MaterialRowWithProduct>({ key: ["purchase-orders", "ppic", "material-planning"], path: "/api/ppic/material-planning", params: serverParams, noSearch: true });
  const isLoading = paged.isLoading;
  const isFiltered = tileFilters.activeCount > 0;

  // The header counts describe the whole filtered view, not the page on screen.
  const filterQs = new URLSearchParams();
  appendParams(filterQs, serverParams);
  const { data: summaryData } = useQuery({
    queryKey: ["purchase-orders", "ppic", "material-planning", "summary", filterQs.toString()],
    queryFn: () => api<{ materials: number; covered: number; short: number; notInCatalog: number; onHold: number }>(`/api/ppic/material-planning/summary${filterQs.toString() ? `?${filterQs}` : ""}`),
    placeholderData: (previous) => previous,
  });
  const summary = summaryData ?? { materials: 0, covered: 0, short: 0, notInCatalog: 0, onHold: 0 };
  const [exporting, setExporting] = useState(false);

  // Download Report exports the whole filtered view (every page).
  async function exportAll() {
    setExporting(true);
    try {
      const all = await apiAll<MaterialRowWithProduct>(`/api/ppic/material-planning${filterQs.toString() ? `?${filterQs}` : ""}`);
      const products = [...new Map(all.map((r) => [r.purchaseOrderItemId, r.product])).values()];
      exportMaterialPlanningReport(all, products);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not build the report");
    } finally {
      setExporting(false);
    }
  }

  async function toggleHold(product: MaterialPlanningProduct, held: boolean) {
    try {
      await setHold.mutateAsync({ poId: product.purchaseOrderId, itemId: product.purchaseOrderItemId, held });
      toast.success(
        held
          ? `${product.productName} put on hold — it no longer claims stock and can't be sent to Production until released.`
          : `${product.productName} released — back in the queue.`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update the hold");
    }
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-brand-500/10 text-brand-600">
            <Layers className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Material Planning</h1>
            <p className="text-sm text-slate-500">
              {summary.materials.toLocaleString()} material(s){isFiltered ? " match" : ""} · <span className="font-bold text-emerald-600">{summary.covered} covered</span> ·{" "}
              <span className={summary.short ? "font-bold text-rose-600" : ""}>{summary.short} short</span>
              {summary.notInCatalog ? ` · ${summary.notInCatalog} not in catalog` : ""}
              {summary.onHold ? ` · ${summary.onHold} on hold / not approved (preview)` : ""}
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm shrink-0" disabled={paged.total === 0 || exporting} onClick={exportAll}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> {exporting ? "Preparing…" : `Download Report${isFiltered ? " (Filtered)" : ""}`}
        </button>
      </div>

      <p className="rounded-xl border border-slate-100 bg-slate-50/70 px-3.5 py-2.5 text-tiny text-slate-500">
        Stock is shared out first-come-first-served: products already sent to Production keep their claim, then the oldest PO first. A product on <b>Hold</b> or marked <b>Not Approved</b> by
        Regulatory takes no stock — its numbers (in italics) show what it would get if released now.
      </p>

      <TileFilterBar filters={tileFilters} tileKey="material-planning" fields={[...ppicFields("material-planning"), MATERIAL_FIELD, AGING_FIELD]} dateLabel="Planned" />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : paged.total === 0 && !isFiltered ? (
        <EmptyState icon={Layers} title="Nothing planned yet" hint="Products show up here once their BOM / RM plan is generated (Calculated)." accent="brand" />
      ) : paged.rows.length === 0 ? (
        <EmptyState icon={Layers} title="No matches" hint="Nothing matches these filters." accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Material</th>
                <th className="px-4 py-3 text-right">Required</th>
                <th className="px-4 py-3 text-right">Covered</th>
                <th className="px-4 py-3">Plant</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {/* Every row is self-contained (PO, customer, product... repeated on each
                  material) so any column can be filtered/searched on its own; rows of
                  the same product still sit together, products with a shortfall first. */}
              {paged.rows.map((row) => {
                const product = row.product;
                return (
                  <tr key={`${row.purchaseOrderItemId}-${row.type}-${row.material}`} className="transition hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-bold text-slate-700">
                      <Link to={`/purchase-orders/${product.purchaseOrderId}`} className="hover:text-brand-600 hover:underline">
                        {product.poNumber ?? product.purchaseOrderId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      {product.state === "ACTIVE" || product.state === "NOT_APPROVED" ? (
                        <span className="text-slate-500">{PRODUCT_STATE_LABEL.ACTIVE}</span>
                      ) : (
                        <span
                          className={`pill text-micro ${product.state === "SENT" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}
                          title={product.state === "SENT" ? "Firm claim on stock" : "Takes no stock — Covered / Short here are an if-released preview"}
                        >
                          {PRODUCT_STATE_LABEL[product.state]}
                        </span>
                      )}
                      {product.releasedQty != null && (
                        <span className="pill ml-1.5 border-amber-200 bg-amber-50 text-micro text-amber-700" title="PPIC has released only part of the order to Production so far">
                          Released {product.releasedQty} of {product.quantity}
                        </span>
                      )}
                    </td>
                    <td className={`px-4 py-2.5 ${row.isPreview ? "italic opacity-70" : ""}`} title={row.isPreview ? "If released now" : undefined}>
                      <StatusPill row={row} onOrder={row.onOrder} />
                    </td>
                    <td className="px-4 py-2.5 text-slate-600"><CustomerName name={product.customerName} /></td>
                    <td className="px-4 py-2.5 text-slate-700">
                      {product.productName}
                      {product.activeBomSlot !== "DISPLAY" && <span className="ml-1.5 align-middle"><SlotPill slot={product.activeBomSlot} /></span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-500">{product.productCategory ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      <AgingCell since={product.plannedAt} />
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`pill text-micro ${row.type === "RM" ? "border-violet-200 bg-violet-50 text-violet-700" : "border-sky-200 bg-sky-50 text-sky-700"}`}>{row.type === "RM" ? "RM" : "PM"}</span>
                    </td>
                    <td className="px-4 py-2.5 font-semibold text-slate-700">
                      {row.material}
                      {row.approvedVendors.length > 0 && (
                        <div className="mt-0.5 text-micro font-semibold text-violet-600" title="Only these vendors' stock counts for this product">
                          Approved vendor: {row.approvedVendors.join(" / ")} · {fmt(row.approvedOnHand ?? 0, row.unit)} in stock
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-600">{fmt(row.requiredQty, row.unit)}</td>
                    <td className={`px-4 py-2.5 text-right font-mono ${row.coveredQty ? "text-emerald-700" : "text-slate-300"} ${row.isPreview ? "italic opacity-70" : ""}`} title={row.isPreview ? "If released now" : undefined}>
                      {fmt(row.coveredQty || null, row.unit)}
                    </td>
                    <td className="px-4 py-2.5">
                      {product.plannedPlantId ? <span className="font-semibold text-slate-700">{plantName.get(product.plannedPlantId) ?? "—"}</span> : <span className="text-tiny font-bold text-amber-600">Not assigned</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {product.state !== "SENT" && hasRole("RND") && <RndBomControl product={product} />}
                      {product.state !== "SENT" && hasRole("PPIC") && (
                        <ProductActions
                          stage="materialPlanning"
                          poId={product.purchaseOrderId}
                          poNumber={product.poNumber ?? product.purchaseOrderId.slice(0, 8)}
                          item={{ id: product.purchaseOrderItemId, productName: product.productName, materialHeldAt: product.heldAt, shortCount: product.shortCount, regulatoryStatus: product.regulatoryStatus, plannedPlantId: product.plannedPlantId, partiallyReleased: product.releasedQty != null }}
                          onToggleHold={(_poId, _itemId, _name, held) => void toggleHold(product, held)}
                          busy={setHold.isPending}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination page={paged.page} pageSize={paged.pageSize} total={paged.total} onPage={paged.setPage} onPageSize={paged.setPageSize} isFetching={paged.isFetching} />
        </div>
      )}
    </div>
  );
}
