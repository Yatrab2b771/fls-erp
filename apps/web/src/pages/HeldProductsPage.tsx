import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, PauseCircle, Play } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useHeldProducts, useSetBatchHold, useSetProductHold, type HeldBatch, type HeldProduct } from "../lib/heldProductHooks";
import { useTileFilters } from "../lib/tileFilters";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CustomerName } from "../components/CustomerName";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";

// Products PPIC has put on hold, with every batch of them. Production holds the batches that are still in preparation (Indent Issue to
// Line Clearance) one by one, and releases them later. A batch already in production follows the whole pipeline.

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-");
const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

function batchStatus(b: HeldBatch): { label: string; tone: string } {
  if (b.held) return { label: "Held by Production", tone: "border-rose-200 bg-rose-50 text-rose-700" };
  if (b.inProduction) return { label: "In production", tone: "border-sky-200 bg-sky-50 text-sky-700" };
  return { label: "Still moving", tone: "border-amber-200 bg-amber-50 text-amber-700" };
}

export function HeldProductsPage() {
  const { hasRole } = useAuth();
  const canAct = hasRole("PRODUCTION");
  const toast = useToast();
  const { data, isLoading } = useHeldProducts();
  const setHold = useSetBatchHold();
  const setProductHold = useSetProductHold();
  const [releasing, setReleasing] = useState<HeldProduct | null>(null);
  const filters = useTileFilters();
  const [asking, setAsking] = useState<{ product: HeldProduct; batch: HeldBatch; held: boolean } | null>(null);
  const every = data ?? [];
  const picked = (key: string) => filters.applied.picks[key] ?? [];

  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct(every.map((p) => p.poNumber)) },
    { key: "customer", label: "Customer", options: distinct(every.map((p) => p.customerName)) },
    { key: "product", label: "Product", options: distinct(every.map((p) => p.productName)) },
  ];

  const rows = useMemo(() => {
    const { dateFrom, dateTo } = filters.applied;
    return every.filter(
      (p) =>
        (!picked("po").length || picked("po").includes(p.poNumber ?? "")) &&
        (!picked("customer").length || picked("customer").includes(p.customerName)) &&
        (!picked("product").length || picked("product").includes(p.productName)) &&
        (!dateFrom || (p.productHeldAt ?? p.productionHeldAt ?? "").slice(0, 10) >= dateFrom) &&
        (!dateTo || (p.productHeldAt ?? p.productionHeldAt ?? "").slice(0, 10) <= dateTo),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [every, filters.applied]);

  async function releaseProduct() {
    if (!releasing) return;
    try {
      await setProductHold.mutateAsync({ itemId: releasing.itemId, held: false });
      toast.success(`${releasing.productName} is released: it is back in New Plan.`);
      setReleasing(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function run(reason?: string) {
    if (!asking) return;
    try {
      await setHold.mutateAsync({ id: asking.batch.id, held: asking.held, reason });
      toast.success(asking.held ? `${asking.batch.batchNo ?? "Batch"} is on hold.` : `${asking.batch.batchNo ?? "Batch"} is released: it goes on.`);
      setAsking(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-amber-500/10 text-amber-600">
          <PauseCircle className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Held Products</h1>
          <p className="text-sm text-slate-500">
            Products on hold: PPIC's holds, and the ones Production put on hold from New Plan (release those here). {canAct ? "Hold the batches that should not go on" : "Production holds the batches that should not go on"} while they are still in preparation (Indent Issue to Line Clearance). A batch already in production follows the whole pipeline.
          </p>
        </div>
      </div>

      <TileFilterBar filters={filters} tileKey="held-products" fields={fields} dateLabel="PPIC held on" />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={PauseCircle} title={filters.activeCount > 0 ? "Nothing matches these filters" : "No product is on hold"} hint="When PPIC puts a product that is with Production on hold, it shows here and Production is told." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2.5">PO Number</th>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="px-3 py-2.5">Product</th>
                  <th className="px-3 py-2.5">Hold</th>
                  <th className="px-3 py-2.5">Batch</th>
                  <th className="px-3 py-2.5">Qty</th>
                  <th className="px-3 py-2.5">Stage</th>
                  <th className="px-3 py-2.5">Batch status</th>
                  <th className="px-3 py-2.5">Production's note</th>
                  {canAct && <th className="px-3 py-2.5 text-right">Action</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <Fragment key={p.itemId}>
                    {p.batches.length === 0 ? (
                      <tr className="border-b border-slate-50">
                        <ProductCells p={p} canAct={canAct} onRelease={setReleasing} />
                        <td className="px-3 py-2.5 text-slate-400" colSpan={canAct ? 6 : 5}>
                          No batch made yet. No new batch can be made until {p.productionHeld && !p.productHeld ? "Production releases it" : "it is released"}.
                        </td>
                      </tr>
                    ) : (
                      p.batches.map((b, i) => {
                        const st = batchStatus(b);
                        return (
                          <tr key={b.id} className="border-b border-slate-50">
                            {i === 0 ? <ProductCells p={p} rowSpan={p.batches.length} canAct={canAct} onRelease={setReleasing} /> : null}
                            <td className="px-3 py-2.5 font-bold text-slate-700">{b.batchNo ?? "Not numbered yet"}</td>
                            <td className="px-3 py-2.5 text-slate-600">
                              {b.plannedQty} {p.unit}
                            </td>
                            <td className="px-3 py-2.5 text-slate-600">{b.stageLabel}</td>
                            <td className="px-3 py-2.5">
                              <span className={`pill ${st.tone}`}>{st.label}</span>
                            </td>
                            <td className="max-w-[18rem] truncate px-3 py-2.5 text-slate-600" title={b.holdReason ?? ""}>
                              {b.held ? `${b.holdReason ?? ""} (${b.heldByName ?? "Production"}, ${day(b.heldAt)})` : "-"}
                            </td>
                            {canAct && (
                              <td className="px-3 py-2.5 text-right">
                                {b.canRelease ? (
                                  <button type="button" className="btn-primary btn-sm" onClick={() => setAsking({ product: p, batch: b, held: false })}>
                                    <Play className="h-3.5 w-3.5" strokeWidth={2.5} /> Release
                                  </button>
                                ) : b.canHold ? (
                                  <button type="button" className="btn-ghost btn-sm text-amber-700" onClick={() => setAsking({ product: p, batch: b, held: true })}>
                                    <PauseCircle className="h-3.5 w-3.5" strokeWidth={2.5} /> Hold
                                  </button>
                                ) : (
                                  <span className="text-slate-400" title={b.inProduction ? "Already in production: it follows the whole pipeline" : "PPIC has released the product"}>
                                    -
                                  </span>
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!releasing}
        tone="brand"
        title="Release this product?"
        message={releasing && <>{releasing.productName} ({releasing.poNumber ?? "PO"}) goes back to New Plan and Production can carry on with it.</>}
        confirmLabel="Release product"
        busy={setProductHold.isPending}
        onConfirm={() => void releaseProduct()}
        onCancel={() => setReleasing(null)}
      />
      <ConfirmDialog
        open={asking?.held === true}
        tone="brand"
        title="Hold this batch?"
        message={
          asking && (
            <>
              <b>
                {asking.batch.batchNo ?? "Batch"} of {asking.product.productName} ({asking.product.poNumber ?? "PO"})
              </b>{" "}
              will stop at {asking.batch.stageLabel}: Indent, Batch No, Dispensing and Line Clearance cannot go on until you release it.
            </>
          )
        }
        requireReason
        reasonLabel="Why are you holding it?"
        confirmLabel="Hold batch"
        busy={setHold.isPending}
        onConfirm={(reason) => void run(reason ?? "")}
        onCancel={() => setAsking(null)}
      />
      <ConfirmDialog
        open={asking?.held === false}
        tone="brand"
        title="Release this batch?"
        message={asking && <>{asking.batch.batchNo ?? "Batch"} of {asking.product.productName} goes on from {asking.batch.stageLabel}.</>}
        confirmLabel="Release batch"
        busy={setHold.isPending}
        onConfirm={() => void run()}
        onCancel={() => setAsking(null)}
      />
    </div>
  );
}

/** The product's own cells (PO, customer, product, PPIC's hold), shared by all its batch rows. */
function ProductCells({ p, rowSpan, canAct, onRelease }: { p: HeldProduct; rowSpan?: number; canAct: boolean; onRelease: (p: HeldProduct) => void }) {
  return (
    <>
      <td className="px-3 py-2.5 align-top font-bold text-slate-700" rowSpan={rowSpan}>
        <Link to={`/purchase-orders/${p.poId}`} className="hover:text-brand-600 hover:underline">
          {p.poNumber ?? p.poId.slice(0, 8)}
        </Link>
      </td>
      <td className="px-3 py-2.5 align-top text-slate-600" rowSpan={rowSpan}>
        <CustomerName name={p.customerName} />
      </td>
      <td className="px-3 py-2.5 align-top font-bold text-slate-800" rowSpan={rowSpan}>
        {p.productName}
        <p className="font-normal text-slate-500">
          {p.quantity} {p.unit}
          {p.plantName ? ` · ${p.plantName}` : ""}
        </p>
      </td>
      <td className="px-3 py-2.5 align-top" rowSpan={rowSpan}>
        <div className="flex flex-col items-start gap-1">
          {p.productHeld && <span className="pill border-amber-200 bg-amber-50 text-amber-700">PPIC hold since {day(p.productHeldAt)}</span>}
          {p.productionHeld && (
            <>
              <span className="pill border-rose-200 bg-rose-50 text-rose-700">Production hold since {day(p.productionHeldAt)}</span>
              <span className="max-w-[14rem] truncate font-normal text-slate-500" title={p.productionHoldReason ?? ""}>
                {p.productionHoldReason ?? ""}
                {p.productionHeldByName ? ` (${p.productionHeldByName})` : ""}
              </span>
              {canAct && (
                <button type="button" className="btn-primary btn-sm" onClick={() => onRelease(p)}>
                  <Play className="h-3.5 w-3.5" strokeWidth={2.5} /> Release product
                </button>
              )}
            </>
          )}
          {!p.productHeld && !p.productionHeld && <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Released by PPIC</span>}
        </div>
      </td>
    </>
  );
}
