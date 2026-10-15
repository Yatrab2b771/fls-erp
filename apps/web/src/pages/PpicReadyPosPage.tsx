import { Link } from "react-router-dom";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { useSetItemMaterialHold } from "../lib/hooks";
import { ApiError } from "../lib/api";
import { usePagedList } from "../lib/usePagedList";
import { useToast } from "../components/Toast";
import { Pagination } from "../components/Pagination";
import { AGING_FIELD, TileFilterBar, ppicFields, ppicTileFields } from "../components/TileFilterBar";
import { useTileFilters } from "../lib/tileFilters";
import { AgingCell } from "../components/AgingCell";
import { EmptyState } from "../components/EmptyState";
import { ProductActions } from "./PpicPlanningDetailPage";
import type { MaterialPlanningProduct } from "../lib/types";
import { CustomerName } from "../components/CustomerName";

// One product of the PO Readiness list, as the server sends it.
interface ReadyRow {
  product: MaterialPlanningProduct;
  materials: number;
  orderDate: string | null;
  expectedDeliveryDate: string | null;
  // When the product became fully planned (both plans calculated) - its Aging.
  sinceAt: string | null;
}

// PO Readiness tile's list, product by product: every product whose raw and
// packaging material is ALL covered by live stock (FIFO-allocated, see Material
// Planning). A product doesn't wait for the other products on its PO. Computed,
// searched and paged on the server; only the page on screen is loaded here.
export function PpicReadyPosPage() {
  const tileFilters = useTileFilters();
  const paged = usePagedList<ReadyRow>({ key: ["purchase-orders", "ppic", "ready-products"], path: "/api/ppic/ready-products", params: tileFilters.params, noSearch: true });
  const setHold = useSetItemMaterialHold();
  const toast = useToast();

  async function toggleHold(poId: string, itemId: string, productName: string, held: boolean) {
    try {
      await setHold.mutateAsync({ poId, itemId, held });
      toast.success(held ? `${productName} put on hold - it leaves this list and stops claiming stock.` : `${productName} released.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update the hold");
    }
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-emerald-500/10 text-emerald-600">
          <CheckCircle2 className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">PO Readiness</h1>
          <p className="text-sm text-slate-500">
            {paged.total.toLocaleString()} product(s){tileFilters.activeCount > 0 ? " match" : ""} whose raw and packaging material is all covered.
          </p>
        </div>
      </div>

      <TileFilterBar filters={tileFilters} tileKey="po-readiness" fields={[...ppicFields("po-readiness"), ...ppicTileFields("po-readiness"), AGING_FIELD]} dateLabel="Planned" />

      {paged.isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : paged.total === 0 && tileFilters.activeCount === 0 ? (
        <EmptyState icon={CheckCircle2} title="No product is fully covered yet" hint="A product shows here once both its plans are calculated and every material is covered by stock." accent="brand" />
      ) : paged.rows.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="No matches" hint="Nothing matches these filters." accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="whitespace-nowrap px-3 py-3">PO Number</th>
                <th className="px-3 py-3">Customer</th>
                <th className="px-3 py-3">Product</th>
                <th className="px-3 py-3">Category</th>
                <th className="whitespace-nowrap px-3 py-3">Aging</th>
                <th className="whitespace-nowrap px-3 py-3">Qty</th>
                <th className="whitespace-nowrap px-3 py-3 text-right">Materials</th>
                <th className="whitespace-nowrap px-3 py-3">Regulatory</th>
                <th className="whitespace-nowrap px-3 py-3">Order Date</th>
                <th className="whitespace-nowrap px-3 py-3">Expected Delivery</th>
                {/* Stays in view while the table scrolls sideways. */}
                <th className="sticky right-0 whitespace-nowrap bg-slate-50 px-3 py-3 text-right shadow-[-6px_0_8px_-6px_rgba(15,23,42,0.12)]">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.rows.map(({ product, materials, orderDate, expectedDeliveryDate, sinceAt }) => (
                <tr key={product.purchaseOrderItemId} className="group transition hover:bg-slate-50">
                  <td className="whitespace-nowrap px-3 py-2.5 font-bold text-slate-700">
                    <Link to={`/purchase-orders/${product.purchaseOrderId}`} className="hover:text-brand-600 hover:underline">
                      {product.poNumber ?? product.purchaseOrderId.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="min-w-[120px] px-3 py-2.5 text-slate-600"><CustomerName name={product.customerName} /></td>
                  <td className="min-w-[150px] px-3 py-2.5 text-slate-700">{product.productName}</td>
                  <td className="px-3 py-2.5 text-slate-500">{product.productCategory ?? "—"}</td>
                  <td className="px-3 py-2.5">
                    <AgingCell since={sinceAt} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">
                    {product.quantity} {product.unit}
                    {product.releasedQty != null && <span className="block text-micro font-bold text-amber-600">Released {product.releasedQty} of {product.quantity}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-emerald-700">{materials}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    {product.regulatoryStatus === "Approved" ? (
                      <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Approved</span>
                    ) : product.regulatoryStatus === "Not Approved" ? (
                      <span className="pill border-rose-200 bg-rose-50 text-rose-700">Not Approved</span>
                    ) : product.sentToRegulatoryAt ? (
                      <span className="pill border-amber-200 bg-amber-50 text-amber-700">Pending</span>
                    ) : (
                      <span className="pill border-slate-200 bg-slate-50 text-slate-500">Not Sent</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{orderDate?.slice(0, 10) ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{expectedDeliveryDate?.slice(0, 10) ?? "—"}</td>
                  <td className="sticky right-0 bg-white px-3 py-2.5 text-right shadow-[-6px_0_8px_-6px_rgba(15,23,42,0.12)] group-hover:bg-slate-50">
                    <ProductActions
                      stage="ready"
                      poId={product.purchaseOrderId}
                      poNumber={product.poNumber ?? product.purchaseOrderId.slice(0, 8)}
                      item={{
                        id: product.purchaseOrderItemId,
                        productName: product.productName,
                        materialHeldAt: product.heldAt,
                        regulatoryStatus: product.regulatoryStatus,
                        plannedPlantId: product.plannedPlantId,
                        partiallyReleased: product.releasedQty != null,
                      }}
                      onToggleHold={toggleHold}
                      busy={setHold.isPending}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={paged.page} pageSize={paged.pageSize} total={paged.total} onPage={paged.setPage} onPageSize={paged.setPageSize} isFetching={paged.isFetching} />
        </div>
      )}
    </div>
  );
}
