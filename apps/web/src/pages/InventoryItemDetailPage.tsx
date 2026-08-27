import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ArrowDownToLine, ArrowUpFromLine, Boxes, Download, Package, Warehouse } from "lucide-react";
import { useInventoryTransactions, useItemStockByLocation } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { StatTile } from "../components/StatTile";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { exportItemHistoryReport } from "../lib/inventoryExport";
import type { InventoryTransaction } from "../lib/types";

const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };

const TYPE_LABEL: Record<string, string> = {
  RECEIVED: "Received",
  ISSUED_DAY_STORE: "Issued to Store",
  ISSUED_PRODUCTION: "Issued to Production",
};
const TYPE_COLOR: Record<string, string> = {
  RECEIVED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  ISSUED_DAY_STORE: "border-amber-200 bg-amber-50 text-amber-700",
  ISSUED_PRODUCTION: "border-amber-200 bg-amber-50 text-amber-700",
};

// One item's complete story in one place — every Material Received row
// that ever brought it in, every Issued-to-Store/Issued-to-Production
// row that ever took it back out, who logged each one and when, plus
// its live balance split across Warehouse/Day Store/Plant. Reached from
// the "View" action on the Stock on Hand table (and the per-location
// tables) — this app's negative-stock and QC-gating rules are only
// really legible when you can see one item's whole ledger at once,
// instead of piecing it together across three separate tabs.
export function InventoryItemDetailPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const toast = useToast();
  const [search, setSearch] = useState("");

  const { data: location, isLoading: locationLoading } = useItemStockByLocation(itemId);
  // No `type` filter — every RECEIVED/ISSUED_DAY_STORE/ISSUED_PRODUCTION
  // row for this one item, combined, is the whole point of this page.
  const { data: transactions, isLoading: txnLoading } = useInventoryTransactions({ itemId }, { enabled: !!itemId });

  const isLoading = locationLoading || txnLoading;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-4 w-40" />
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }
  if (!location) return <EmptyState icon={Package} title="Item not found" accent="rose" />;

  const totalReceived = transactions?.filter((t) => t.type === "RECEIVED").reduce((s, t) => s + t.quantity - (t.rejectedQty ?? 0), 0) ?? 0;
  const totalIssuedStore = transactions?.filter((t) => t.type === "ISSUED_DAY_STORE").reduce((s, t) => s + t.quantity, 0) ?? 0;
  const totalIssuedProduction = transactions?.filter((t) => t.type === "ISSUED_PRODUCTION").reduce((s, t) => s + t.quantity, 0) ?? 0;

  const q = search.trim().toLowerCase();
  const filtered = transactions?.filter(
    (t) =>
      !q ||
      (t.vendorName ?? "").toLowerCase().includes(q) ||
      (t.batchNo ?? "").toLowerCase().includes(q) ||
      (t.grnNo ?? "").toLowerCase().includes(q) ||
      (t.dayStore?.name ?? "").toLowerCase().includes(q) ||
      (t.plant?.name ?? "").toLowerCase().includes(q) ||
      t.createdBy.fullName.toLowerCase().includes(q),
  );

  function handleExport() {
    if (!filtered?.length) return toast.error("Nothing to export — no history for this item.");
    exportItemHistoryReport(location!.item, filtered);
    toast.success("Item history downloaded.");
  }

  return (
    <div className="space-y-6">
      <Link to="/inventory" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Back to Inventory
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">{location.item.name}</h1>
          <p className="text-sm text-slate-500">
            {CATEGORY_LABEL[location.item.category] ?? location.item.category} · {location.item.unit ?? "no unit set"}
          </p>
        </div>
        <button className="btn-ghost" onClick={handleExport} title="Download this item's complete history as an Excel report">
          <Download className="h-3.5 w-3.5" strokeWidth={2.5} /> Download History
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile icon={ArrowDownToLine} label="Total Received" value={totalReceived} accent="emerald" />
        <StatTile icon={ArrowUpFromLine} label="Issued to Store" value={totalIssuedStore} accent="amber" />
        <StatTile icon={ArrowUpFromLine} label="Issued to Production" value={totalIssuedProduction} accent="amber" />
        <StatTile icon={Boxes} label="Warehouse On Hand" value={location.warehouse} accent={location.warehouse < 0 ? "rose" : "brand"} />
      </div>

      <div className="card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-black text-slate-800">
          <Warehouse className="h-4 w-4" strokeWidth={2.5} /> Stock By Location
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Warehouse</p>
            <p className={`mt-1 font-mono text-2xl font-black ${location.warehouse < 0 ? "text-rose-600" : "text-slate-800"}`}>{location.warehouse}</p>
          </div>
          {location.dayStores.map((ds) => (
            <div key={ds.id} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{ds.name}</p>
              <p className={`mt-1 font-mono text-2xl font-black ${ds.onHand < 0 ? "text-rose-600" : "text-slate-800"}`}>{ds.onHand}</p>
              <p className="mt-1 text-[11px] text-slate-400">
                +{ds.receivedFromWarehouse} from warehouse · −{ds.issuedToProduction} to production
              </p>
            </div>
          ))}
          {location.plants.map((p) => (
            <div key={p.id} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{p.name}</p>
              <p className={`mt-1 font-mono text-2xl font-black ${p.onHand < 0 ? "text-rose-600" : "text-slate-800"}`}>{p.onHand}</p>
            </div>
          ))}
          {!location.dayStores.length && !location.plants.length && (
            <p className="text-xs text-slate-400 sm:col-span-2">No activity yet at any Day Store or Plant for this item.</p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-black text-slate-800">Full History — Received &amp; Issued</h2>
        <div className="w-full sm:w-72">
          <SearchBar value={search} onChange={setSearch} placeholder="Search by vendor, batch, store, plant, or who logged it…" />
        </div>
      </div>

      <ItemHistoryTable rows={filtered} empty={!transactions?.length} />
    </div>
  );
}

function ItemHistoryTable({ rows, empty }: { rows: InventoryTransaction[] | undefined; empty: boolean }) {
  if (empty) return <EmptyState icon={Package} title="No history yet" hint="Nothing has been received or issued for this item." accent="slate" />;
  if (!rows?.length) return <EmptyState icon={Package} title="No matching rows" hint="Try a different search." accent="slate" />;

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="table-modern w-full">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th className="text-right">Quantity</th>
              <th>Location</th>
              <th>Vendor</th>
              <th>Batch / GRN</th>
              <th>Logged By</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td className="text-slate-500">{new Date(t.date).toLocaleDateString()}</td>
                <td>
                  <span className={`pill ${TYPE_COLOR[t.type]}`}>{TYPE_LABEL[t.type]}</span>
                </td>
                <td className="text-right font-mono font-bold text-slate-700">
                  {t.quantity} {t.unit}
                </td>
                <td className="text-slate-600">{t.dayStore?.name ?? t.plant?.name ?? "—"}</td>
                <td className="text-slate-600">{t.vendorName ?? "—"}</td>
                <td className="text-slate-500">
                  {t.batchNo ?? "—"}
                  {t.grnNo ? ` / ${t.grnNo}` : ""}
                </td>
                <td className="text-slate-600">{t.createdBy.fullName}</td>
                <td>
                  {t.type === "RECEIVED" ? (
                    <span
                      className={`pill ${
                        t.receiptStatus === "ACCEPTED"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : t.receiptStatus === "QC_REJECTED"
                            ? "border-rose-200 bg-rose-50 text-rose-700"
                            : "border-amber-200 bg-amber-50 text-amber-700"
                      }`}
                    >
                      {t.receiptStatus === "ACCEPTED" ? "Accepted" : t.receiptStatus === "QC_REJECTED" ? "QC Rejected" : t.receiptStatus === "QC_APPROVED" ? "QC Approved" : "Pending QC"}
                      {t.rejectedQty ? ` (${t.rejectedQty} rejected)` : ""}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
