import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Download, Warehouse } from "lucide-react";
import { useDayStoreStock, useFgStock, useInventoryStock, useQuarantineStock, useStoreDashboardSummary } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { exportDayStoreStockReport, exportFgStockReport, exportStockReport, exportTransactionReport } from "../lib/inventoryExport";

const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };

// The drill-down behind every Store dashboard tile (RM/PM/each Day
// Store/FG/Quarantine) — clicking a tile lands here with the full list
// behind that tile's count, plus a Download Report button, same
// list-first-then-download shape as PurchasePlanningDetailPage /
// RegulatoryPlanningDetailPage. Unlike those, Store's tiles aren't all
// backed by one shared fetch (RM/PM/FG/Quarantine/each Day Store are
// each their own endpoint), so the metric switch below just picks
// which hook this page's data comes from instead of filtering one array.
export function StorePlanningDetailPage() {
  const { metric } = useParams<{ metric: string }>();
  const isDayStore = !!metric?.startsWith("store-");
  const dayStoreId = isDayStore ? metric!.slice("store-".length) : undefined;
  const { data: summary } = useStoreDashboardSummary({ enabled: isDayStore });
  const dayStoreName = summary?.dayStores.find((d) => d.id === dayStoreId)?.name ?? "Day Store";

  if (!metric || !["rm", "pm", "fg", "quarantine"].includes(metric) && !isDayStore) {
    return <EmptyState icon={Warehouse} title="Unknown report" hint="That dashboard tile doesn't exist." accent="rose" />;
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      {metric === "rm" && <CategoryStockTable category="RM" label="RM Stock on Hand" />}
      {metric === "pm" && <CategoryStockTable category="PM" label="PM Stock on Hand" />}
      {metric === "fg" && <FgTable />}
      {metric === "quarantine" && <QuarantineTable />}
      {isDayStore && dayStoreId && <DayStoreTable dayStoreId={dayStoreId} dayStoreName={dayStoreName} />}
    </div>
  );
}

function TileHeader({ label, count, unitLabel, onDownload, disabled }: { label: string; count: number; unitLabel: string; onDownload: () => void; disabled: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-brand-500/10 text-brand-600">
          <Warehouse className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">{label}</h1>
          <p className="text-sm text-slate-500">
            {count} {unitLabel}
          </p>
        </div>
      </div>
      <button className="btn-primary btn-sm" onClick={onDownload} disabled={disabled}>
        <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Report
      </button>
    </div>
  );
}

function CategoryStockTable({ category, label }: { category: "RM" | "PM"; label: string }) {
  const { data: rows, isLoading } = useInventoryStock(category);
  const onHandRows = (rows ?? []).filter((r) => r.onHand > 1e-6);

  if (isLoading || !rows) return <div className="skeleton h-64 w-full" />;

  return (
    <>
      <TileHeader label={label} count={onHandRows.length} unitLabel="item(s) in stock" onDownload={() => exportStockReport(onHandRows)} disabled={onHandRows.length === 0} />
      {onHandRows.length === 0 ? (
        <EmptyState icon={Warehouse} title="Nothing here" hint="No items currently in stock for this category." accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Received</th>
                <th className="px-4 py-3">Issued</th>
                <th className="px-4 py-3">On Hand</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {onHandRows.map((r) => (
                <tr key={r.item.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">{r.item.name}</td>
                  <td className="px-4 py-3 text-slate-500">{CATEGORY_LABEL[r.item.category] ?? r.item.category}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {r.receivedQty} {r.item.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {r.issuedQty} {r.item.unit}
                  </td>
                  <td className="px-4 py-3 font-bold text-slate-700">
                    {r.onHand} {r.item.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function FgTable() {
  const { data: rows, isLoading } = useFgStock();
  const onHandRows = (rows ?? []).filter((r) => r.onHandQty > 1e-6);

  if (isLoading || !rows) return <div className="skeleton h-64 w-full" />;

  return (
    <>
      <TileHeader label="FG Stock on Hand" count={onHandRows.length} unitLabel="batch/lot(s) in stock" onDownload={() => exportFgStockReport(onHandRows)} disabled={onHandRows.length === 0} />
      {onHandRows.length === 0 ? (
        <EmptyState icon={Warehouse} title="Nothing here" hint="No finished goods currently at the FG Store." accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Batch / Lot</th>
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">On Hand</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {onHandRows.map((r) => (
                <tr key={r.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">{r.customerName}</td>
                  <td className="px-4 py-3 text-slate-500">{r.productName}</td>
                  <td className="px-4 py-3 text-slate-500">{r.label}</td>
                  <td className="px-4 py-3 text-slate-500">{r.poNumber ?? "—"}</td>
                  <td className="px-4 py-3 font-bold text-slate-700">
                    {r.onHandQty} {r.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function QuarantineTable() {
  const { data: rows, isLoading } = useQuarantineStock();

  if (isLoading || !rows) return <div className="skeleton h-64 w-full" />;

  const REASON_LABEL: Record<string, string> = { PENDING_QC: "Awaiting QC", ON_HOLD: "On Hold", EXPIRED: "Expired" };

  return (
    <>
      <TileHeader
        label="Quarantine Store"
        count={rows.length}
        unitLabel="entry(ies) in quarantine"
        onDownload={() => exportTransactionReport(rows, "Quarantine", "Quarantine")}
        disabled={rows.length === 0}
      />
      {rows.length === 0 ? (
        <EmptyState icon={Warehouse} title="Nothing here" hint="No stock currently in quarantine." accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Quantity</th>
                <th className="px-4 py-3">GRN No</th>
                <th className="px-4 py-3">Expiry Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">{r.item.name}</td>
                  <td className="px-4 py-3 text-slate-500">{REASON_LABEL[r.quarantineReason] ?? r.quarantineReason}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {r.quantity} {r.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{r.grnNo ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{r.expiryDate ? new Date(r.expiryDate).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-400">Releasing expired stock is done from Inventory → Quarantine Store.</p>
    </>
  );
}

function DayStoreTable({ dayStoreId, dayStoreName }: { dayStoreId: string; dayStoreName: string }) {
  const { data, isLoading } = useDayStoreStock(dayStoreId);
  const rows = (data?.stock ?? []).filter((r) => r.onHand > 1e-6);
  const name = data?.dayStore.name ?? dayStoreName;

  if (isLoading || !data) return <div className="skeleton h-64 w-full" />;

  return (
    <>
      <TileHeader label={`${name} — Stock on Hand`} count={rows.length} unitLabel="item(s) in stock" onDownload={() => exportDayStoreStockReport(name, rows)} disabled={rows.length === 0} />
      {rows.length === 0 ? (
        <EmptyState icon={Warehouse} title="Nothing here" hint="No items currently in stock at this store." accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Received</th>
                <th className="px-4 py-3">Issued</th>
                <th className="px-4 py-3">On Hand</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.item.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-700">{r.item.name}</td>
                  <td className="px-4 py-3 text-slate-500">{CATEGORY_LABEL[r.item.category] ?? r.item.category}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {r.receivedFromWarehouse} {r.item.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {r.issuedToProduction} {r.item.unit}
                  </td>
                  <td className="px-4 py-3 font-bold text-slate-700">
                    {r.onHand} {r.item.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
