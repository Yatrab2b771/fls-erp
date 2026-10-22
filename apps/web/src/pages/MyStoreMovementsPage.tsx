import { fmtQty } from "../lib/format";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownToLine, ArrowLeft, Check, Download, PackageOpen, Route, Send } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, apiAll, apiPage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { usePagedList } from "../lib/usePagedList";
import { appendParams, useTileFilters } from "../lib/tileFilters";
import { exportMyStoreReport, type MyStoreRow } from "../lib/inventoryExport";
import { useConfirmDelivery, useMyStoreInfo, useRejectDelivery } from "../lib/hooks";
import { ReceiveDialog, type ReceiveResult } from "../components/ReceiveDialog";
import { Pagination } from "../components/Pagination";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import type { OptionPage } from "../components/MultiSelectDropdown";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";

const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

const COPY = {
  received: {
    title: "Stock Received",
    icon: ArrowDownToLine,
    dateLabel: "Received",
    by: "Issued By (Warehouse)",
    empty: "Material shows here once the Warehouse issues it to your store. Receive it here: it counts in your stock only after you do.",
  },
  "issued-to-plant": {
    title: "Dispensed to Plant",
    icon: Send,
    dateLabel: "Issued",
    by: "Issued By",
    empty: "What your store dispenses to its Plant shows here, batch and GRN wise (extra material too).",
  },
} as const;

// A Day Store login's own movements - what the Warehouse issued into its store, or what the store issued
// on to its own Plant. A login that is not limited to a store (Warehouse seat, Admin) sees every Day Store.
export function MyStoreMovementsPage({ kind }: { kind: "received" | "issued-to-plant" }) {
  const copy = COPY[kind];
  const Icon = copy.icon;
  const BASE = `/api/inventory/my-store/${kind}`;
  const toast = useToast();
  const { hasRole } = useAuth();
  const qc = useQueryClient();
  const confirmDelivery = useConfirmDelivery();
  const rejectDelivery = useRejectDelivery();
  // What the Warehouse issues to a store is in transit until the store receives it, here: how much, or that it is refused (back to the Warehouse)
  const canReceive = kind === "received" && hasRole("STORE");
  const [receivingId, setReceivingId] = useState<string | null>(null);
  const { data: info } = useMyStoreInfo();
  const tileFilters = useTileFilters();
  const [exporting, setExporting] = useState(false);
  const paged = usePagedList<MyStoreRow>({ key: ["inventory", "my-store", kind, "list"], path: BASE, params: tileFilters.params, noSearch: true });
  const isFiltered = tileFilters.activeCount > 0;
  // How many are still on the way to the store(s) this login sees (the same list, filtered to In Transit)
  const { data: waiting } = useQuery({
    queryKey: ["inventory", "my-store", kind, "in-transit-count"],
    queryFn: async () => (await apiPage<MyStoreRow>(`${BASE}?status=In%20Transit&pageSize=1`)).total,
    enabled: canReceive,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["inventory"] });
  const storeNames = (info?.stores ?? []).map((s) => s.name).join(", ");

  const serverList = (key: string, label: string): FilterField => ({
    key,
    label,
    load: (q) => api<OptionPage>(`${BASE}/options?field=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });
  const fields: FilterField[] = [
    ...(info?.scoped && info.stores.length === 1 ? [] : [serverList("store", "Store")]),
    { key: "category", label: "Category", options: ["RM", "PM"] },
    serverList("item", "Item"),
    { key: "status", label: "Status", options: ["Delivered", "In Transit"] },
    serverList("batchNo", "Batch No"),
    serverList("grnNo", "GRN No"),
  ];

  async function receive(id: string, got: ReceiveResult) {
    try {
      await confirmDelivery.mutateAsync({ id, note: got.note, receivedQty: got.receivedQty });
      await refresh();
      toast.success(got.receivedQty ? "Received. The shortage is recorded." : "Received. It now counts in your stock.");
      setReceivingId(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not receive it");
    }
  }

  async function refuse(id: string, reason: string) {
    try {
      await rejectDelivery.mutateAsync({ id, reason });
      await refresh();
      toast.success("Refused. It is back with the Warehouse.");
      setReceivingId(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not refuse it");
    }
  }

  async function exportAll() {
    setExporting(true);
    try {
      const qs = appendParams(new URLSearchParams(), tileFilters.params);
      exportMyStoreReport(kind, await apiAll<MyStoreRow>(`${BASE}${qs.toString() ? `?${qs}` : ""}`));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not build the report");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-violet-500/10 text-violet-600">
            <Icon className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{copy.title}</h1>
            <p className="text-sm text-slate-500">
              {paged.total.toLocaleString()} {paged.total === 1 ? "entry" : "entries"}
              {isFiltered ? " match" : ""} {kind === "received" ? `received from the Warehouse into ${storeNames || "your store"}` : `issued from ${storeNames || "your store"} to its Plant`}
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm shrink-0" disabled={paged.total === 0 || exporting} onClick={exportAll}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> {exporting ? "Preparing…" : `Download Report${isFiltered ? " (Filtered)" : ""}`}
        </button>
      </div>

      {canReceive && !!waiting && (
        <button
          type="button"
          onClick={() => tileFilters.applyPick("status", ["In Transit"])}
          className="flex w-full items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left text-sm font-bold text-amber-800 hover:bg-amber-100"
        >
          <Route className="h-4 w-4 shrink-0" strokeWidth={2.5} /> {waiting} entr{waiting === 1 ? "y is" : "ies are"} in transit: waiting for you to receive. Tap to show them.
        </button>
      )}

      <TileFilterBar filters={tileFilters} tileKey={`my-store-${kind}`} fields={fields} dateLabel={copy.dateLabel} />

      {paged.isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : paged.total === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "Nothing yet"} hint={isFiltered ? "Nothing matches these filters." : copy.empty} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">Quantity</th>
                <th className="px-4 py-3">Store</th>
                {kind === "issued-to-plant" && <th className="px-4 py-3">Plant</th>}
                <th className="px-4 py-3">Batch No</th>
                <th className="px-4 py-3">GRN No</th>
                <th className="px-4 py-3">Against</th>
                <th className="px-4 py-3">{copy.by}</th>
                {canReceive && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.rows.map((r) => (
                <tr key={r.id} className="transition hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-600">{day(r.date)}</td>
                  <td className="px-4 py-3">
                    <span className={`pill ${r.status === "In Transit" ? "border-amber-200 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>{r.status}</span>
                  </td>
                  <td className="whitespace-normal px-4 py-3 font-bold text-slate-800">{r.itemName}</td>
                  <td className="px-4 py-3 text-slate-500">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                  <td className="px-4 py-3 text-right font-mono font-bold text-slate-900">
                    {fmtQty(r.quantity)} {r.unit}
                  </td>
                  <td className="px-4 py-3 text-slate-700">{r.storeName ?? "—"}</td>
                  {kind === "issued-to-plant" && <td className="px-4 py-3 text-slate-700">{r.plantName ?? "—"}</td>}
                  <td className="px-4 py-3 text-slate-600">{r.batchNo ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{r.grnNo ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{r.isExtra ? "Extra material" : r.viaRequest ? "Material Request" : "Direct"}</td>
                  <td className="px-4 py-3 text-slate-500">{r.issuedBy}</td>
                  {canReceive && (
                    <td className="px-4 py-3 text-right">
                      {r.status === "In Transit" && (
                        <>
                          <button type="button" className="btn-primary btn-sm" disabled={confirmDelivery.isPending || rejectDelivery.isPending} onClick={() => setReceivingId(r.id)}>
                            <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> Receive
                          </button>
                          <ReceiveDialog
                            open={receivingId === r.id}
                            itemName={r.itemName}
                            sentQty={r.quantity}
                            unit={r.unit}
                            from="the Warehouse"
                            busy={confirmDelivery.isPending || rejectDelivery.isPending}
                            onReceive={(got) => void receive(r.id, got)}
                            onRefuse={(reason) => void refuse(r.id, reason)}
                            onCancel={() => setReceivingId(null)}
                          />
                        </>
                      )}
                    </td>
                  )}
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
