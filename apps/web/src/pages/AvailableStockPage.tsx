import { fmtQty } from "../lib/format";
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlarmClock, ArrowLeft, Boxes, ChevronDown, Download, PackageOpen } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api, apiAll } from "../lib/api";
import { usePagedList } from "../lib/usePagedList";
import { useItemBatches } from "../lib/hooks";
import { appendParams, useTileFilters, type QueryParams } from "../lib/tileFilters";
import * as XLSX from "xlsx";
import { exportAvailableStockReport, type AvailableLocation, type AvailableStockByItem, type ItemBatch } from "../lib/inventoryExport";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";
import { Pagination } from "../components/Pagination";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import type { OptionPage } from "../components/MultiSelectDropdown";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";

const BASE = "/api/inventory/available-stock";

/** One row of the period report: what an item held at the start, what came in, what went out and what it held at the end. */
interface StockEntry {
  date: string;
  label: string;
  from: string;
  to: string;
  qty: number;
  unit: string;
  direction: "IN" | "OUT" | "MOVED";
  batchNo: string | null;
  grnNo: string | null;
  mfgDate: string | null;
  expiryDate: string | null;
  vendorName: string | null;
  reference: string | null;
}

interface MovementRow {
  itemId: string;
  itemName: string;
  itemCode: string | null;
  category: string;
  unit: string | null;
  opening: number;
  received: number;
  issued: number;
  closing: number;
}
const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");

const BATCH_STATUS_STYLE: Record<string, string> = {
  Accepted: "border-emerald-200 bg-emerald-50 text-emerald-700",
  "Pending QC": "border-amber-200 bg-amber-50 text-amber-700",
  "On Hold": "border-orange-200 bg-orange-50 text-orange-700",
  "Lab Test": "border-rose-200 bg-rose-50 text-rose-700",
  "QC Rejected": "border-rose-200 bg-rose-50 text-rose-700",
};

/** The soonest expiry, with how close it is: red inside 30 days, amber inside 90. */
function ExpiryCell({ iso, days }: { iso: string | null; days: number | null }) {
  if (!iso) return <span className="text-slate-300">—</span>;
  const tone = days !== null && days <= 30 ? "text-rose-700" : days !== null && days <= 90 ? "text-amber-700" : "text-slate-700";
  return (
    <span className={tone}>
      <span className="font-semibold">{day(iso)}</span>
      {days !== null && (
        <span className="block text-micro font-medium">
          {days < 0 ? `${-days} day${days === -1 ? "" : "s"} ago` : days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}
        </span>
      )}
    </span>
  );
}

/** How much of the item sits in each location. */
function LocationBreakdown({ item, locations }: { item: AvailableStockByItem; locations: AvailableLocation[] }) {
  const rows = locations.filter((l) => (item.locations[l.key] ?? 0) > 0);
  if (!rows.length) return <p className="text-xs text-slate-400">Not in stock anywhere.</p>;
  return (
    <table className="w-full max-w-md text-xs">
      <thead>
        <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
          <th className="py-1.5 pr-4">Location</th>
          <th className="py-1.5 text-right">Available</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((l) => (
          <tr key={l.key}>
            <td className="py-2 pr-4 text-slate-700">{l.label}</td>
            <td className="py-2 text-right font-mono font-bold text-slate-900">
              {fmtQty(item.locations[l.key] ?? 0)} {item.unit ?? ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Every entry behind one item's row of the stock report: each delivery (with its batch, GRN, mfg and expiry dates), each issue, transfer and use,
 * dated, with where it came from and where it went. In = came from outside the chosen locations, Out = went outside, Moved = between them.
 */
function EntriesTable({ itemId, unit, from, to, locationKeys }: { itemId: string; unit: string | null; from?: string; to?: string; locationKeys: string[] }) {
  const qs = appendParams(new URLSearchParams({ itemId }), { from, to, location: locationKeys.length ? locationKeys : undefined });
  const { data, isLoading } = useQuery({ queryKey: ["inventory", "available-stock", "report-entries", itemId, from ?? "", to ?? "", locationKeys.join(",")], queryFn: () => api<StockEntry[]>(`${BASE}/report/entries?${qs}`), staleTime: 30_000 });
  if (isLoading) return <div className="skeleton h-16 w-full" />;
  if (!data?.length) return <p className="text-xs text-slate-400">No entries in this period.</p>;
  const total = (d: StockEntry["direction"]) => data.filter((e) => e.direction === d).reduce((a, e) => a + e.qty, 0);
  const hasMoved = data.some((e) => e.direction === "MOVED");
  return (
    <div>
      <table className="w-full whitespace-nowrap text-xs">
        <thead>
          <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
            <th className="py-1.5 pr-4">Date</th>
            <th className="py-1.5 pr-4">Entry</th>
            <th className="py-1.5 pr-4">From</th>
            <th className="py-1.5 pr-4">To</th>
            <th className="py-1.5 pr-4 text-right">In</th>
            <th className="py-1.5 pr-4 text-right">Out</th>
            {hasMoved && <th className="py-1.5 pr-4 text-right">Moved between</th>}
            <th className="py-1.5 pr-4">Batch No</th>
            <th className="py-1.5 pr-4">GRN No</th>
            <th className="py-1.5 pr-4">Mfg Date</th>
            <th className="py-1.5 pr-4">Expiry Date</th>
            <th className="py-1.5">Details</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map((e, i) => {
            const days = e.expiryDate ? Math.ceil((new Date(e.expiryDate).getTime() - Date.now()) / 86_400_000) : null;
            return (
              <tr key={i}>
                <td className="py-2 pr-4 text-slate-600">{day(e.date)}</td>
                <td className="py-2 pr-4 font-bold text-slate-700">{e.label}</td>
                <td className="py-2 pr-4 text-slate-600">{e.from}</td>
                <td className="py-2 pr-4 text-slate-600">{e.to}</td>
                <td className="py-2 pr-4 text-right font-mono font-bold text-emerald-700">{e.direction === "IN" ? `+${fmtQty(e.qty)}` : ""}</td>
                <td className="py-2 pr-4 text-right font-mono font-bold text-rose-700">{e.direction === "OUT" ? `-${fmtQty(e.qty)}` : ""}</td>
                {hasMoved && <td className="py-2 pr-4 text-right font-mono text-slate-500">{e.direction === "MOVED" ? fmtQty(e.qty) : ""}</td>}
                <td className="py-2 pr-4 text-slate-600">{e.batchNo ?? ""}</td>
                <td className="py-2 pr-4 text-slate-600">{e.grnNo ?? ""}</td>
                <td className="py-2 pr-4 text-slate-600">{e.mfgDate ? day(e.mfgDate) : ""}</td>
                <td className="py-2 pr-4">{e.expiryDate ? <ExpiryCell iso={e.expiryDate} days={days} /> : ""}</td>
                <td className="py-2 text-slate-500">{[e.vendorName, e.reference].filter(Boolean).join(" · ")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-xs font-bold text-slate-600">
        In {fmtQty(total("IN"))} {unit ?? ""} · Out {fmtQty(total("OUT"))} {unit ?? ""}
        {hasMoved ? ` · Moved between the chosen locations ${fmtQty(total("MOVED"))} ${unit ?? ""} (not counted in or out)` : ""}
      </p>
    </div>
  );
}

/** The receipts (batches) behind one item - what makes up its stock. */
function BatchTable({ itemId, unit, period }: { itemId: string; unit: string | null; period?: { from?: string; to?: string } }) {
  const { data, isLoading } = useItemBatches(itemId, period);
  if (isLoading) return <div className="skeleton h-16 w-full" />;
  if (!data?.length) return <p className="text-xs text-slate-400">{period ? "Nothing was received in this period." : "No receipts recorded for this item."}</p>;
  const showRate = data.some((b) => b.rate !== null);
  const showVendor = data.some((b) => b.vendorName !== null);
  return (
    <div>
      <table className="w-full whitespace-nowrap text-xs">
        <thead>
          <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
            <th className="py-1.5 pr-4">Batch No</th>
            <th className="py-1.5 pr-4">GRN No</th>
            <th className="py-1.5 pr-4">Mfg Date</th>
            <th className="py-1.5 pr-4">Expiry Date</th>
            <th className="py-1.5 pr-4">Received On</th>
            <th className="py-1.5 pr-4 text-right">Received Qty</th>
            {showVendor && <th className="py-1.5 pr-4">Vendor</th>}
            {showRate && <th className="py-1.5 pr-4 text-right">Rate</th>}
            <th className="py-1.5">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map((b: ItemBatch) => {
            const days = b.expiryDate ? Math.ceil((new Date(b.expiryDate).getTime() - Date.now()) / 86_400_000) : null;
            return (
              <tr key={b.id}>
                <td className="py-2 pr-4 font-bold text-slate-700">{b.batchNo ?? "—"}</td>
                <td className="py-2 pr-4 text-slate-600">{b.grnNo ?? "—"}</td>
                <td className="py-2 pr-4 text-slate-600">{day(b.mfgDate)}</td>
                <td className="py-2 pr-4">
                  <ExpiryCell iso={b.expiryDate} days={days} />
                </td>
                <td className="py-2 pr-4 text-slate-600">{day(b.receivedOn)}</td>
                <td className="py-2 pr-4 text-right font-mono font-bold text-slate-800">
                  {fmtQty(b.receivedQty)} {unit ?? b.unit}
                </td>
                {showVendor && <td className="py-2 pr-4 text-slate-600">{b.vendorName ?? "—"}</td>}
                {showRate && <td className="py-2 pr-4 text-right font-mono text-slate-600">{b.rate ?? "—"}</td>}
                <td className="py-2">
                  <span className={`pill ${BATCH_STATUS_STYLE[b.status] ?? ""}`}>{b.status}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-micro text-slate-400">Stock is tracked per item, not per batch — these are the quantities received in each batch, not what is left of it.</p>
    </div>
  );
}

// Every RM / PM that is on hand, wherever it sits - Warehouse, each Day Store, the R&D Store and each Plant - in
// one list, one row per item: where it sits, its earliest expiry, batches, last received, what is held in
// quarantine and what is on order. Open a row for its stock by location and (Warehouse side) its batches with mfg /
// expiry dates. The numbers come from the same stock maths as the other Store tiles.
export function AvailableStockPage() {
  const toast = useToast();
  const tileFilters = useTileFilters();
  const [includeZero, setIncludeZero] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [openItemId, setOpenItemId] = useState<string | null>(null);

  const { data: meta } = useQuery({ queryKey: ["inventory", "available-stock", "meta"], queryFn: () => api<{ locations: AvailableLocation[]; scoped: boolean }>(`${BASE}/meta`), staleTime: 60_000 });
  const locations = meta?.locations ?? [];
  const warehouseSide = meta ? !meta.scoped : false; // a Store login does not see the Warehouse's batches / quarantine / purchases

  // The filter shows location names; the server wants their keys.
  const picked = (key: string) => tileFilters.applied.picks[key] ?? [];
  const pickedLocationKeys = picked("location")
    .map((label) => locations.find((l) => l.label === label)?.key)
    .filter((k): k is string => !!k);
  // Pick a From and / or To date and the page becomes the stock report for that period (Opening, Received, Issued, Closing).
  const { dateFrom, dateTo } = tileFilters.applied;
  const report = !!(dateFrom || dateTo);
  const reportParams: QueryParams = {
    from: dateFrom || undefined,
    to: dateTo || undefined,
    location: pickedLocationKeys.length ? pickedLocationKeys : undefined,
    category: picked("category").length ? picked("category") : undefined,
    item: picked("item").length ? picked("item") : undefined,
  };
  const params: QueryParams = {
    view: "item",
    location: pickedLocationKeys.length ? pickedLocationKeys : undefined,
    category: picked("category").length ? picked("category") : undefined,
    item: picked("item").length ? picked("item") : undefined,
    expiry: picked("expiry").length ? picked("expiry") : undefined,
    hasQuarantine: picked("hasQuarantine").length ? picked("hasQuarantine") : undefined,
    hasOnOrder: picked("hasOnOrder").length ? picked("hasOnOrder") : undefined,
    includeZero: includeZero ? "true" : undefined,
  };

  const paged = usePagedList<AvailableStockByItem>({ key: ["inventory", "available-stock", "list"], path: BASE, params, noSearch: true, enabled: !report });
  const movement = usePagedList<MovementRow>({ key: ["inventory", "available-stock", "report"], path: `${BASE}/report`, params: reportParams, noSearch: true, enabled: report });
  const wholeCompany = !meta?.scoped && pickedLocationKeys.length === 0;
  const issuedLabel = wholeCompany ? "Used" : "Issued / moved out";
  const shownLocations = pickedLocationKeys.length ? locations.filter((l) => pickedLocationKeys.includes(l.key)) : locations;
  const isFiltered = tileFilters.activeCount > 0;

  const fields: FilterField[] = useMemo(
    () => [
      { key: "location", label: "Location", options: locations.map((l) => l.label) },
      { key: "category", label: "Category", options: ["RM", "PM"] },
      { key: "item", label: "Item", load: (q) => api<OptionPage>(`${BASE}/options${q ? `?q=${encodeURIComponent(q)}` : ""}`) },
      ...(report ? [] : [{ key: "expiry", label: "Expiring", options: ["Within 30 days", "Within 60 days", "Within 90 days"] }]),
      ...(warehouseSide && !report
        ? [
            { key: "hasQuarantine", label: "Has quarantine stock", options: ["Yes", "No"] },
            { key: "hasOnOrder", label: "Has stock on order", options: ["Yes", "No"] },
          ]
        : []),
    ],
    [locations, warehouseSide, report],
  );

  async function exportMovement() {
    setExporting(true);
    try {
      const rows = await apiAll<MovementRow>(`${BASE}/report?${appendParams(new URLSearchParams(), reportParams)}`);
      const where = pickedLocationKeys.length ? shownLocations.map((l) => l.label).join(", ") : meta?.scoped ? "your store and its Plant" : "Whole company";
      const lines = rows.map((r) => ({ Item: r.itemName, Code: r.itemCode ?? "", Category: CATEGORY_LABEL[r.category] ?? r.category, Unit: r.unit ?? "", Opening: r.opening, Received: r.received, [issuedLabel]: r.issued, Closing: r.closing }));
      // Every delivery behind the Received column , with its batch, GRN, mfg and expiry dates
      const deliveries = warehouseSide
        ? await api<ItemBatch[]>(`${BASE}/batches/lookup`, { method: "POST", body: { itemIds: rows.map((r) => r.itemId), accepted: "1", from: dateFrom || undefined, to: dateTo || undefined } })
        : [];
      const wb = XLSX.utils.book_new();
      addReportSheet(wb, "Stock Report", `FLS Stock Report: ${dateFrom ? day(dateFrom) : "start"} to ${dateTo ? day(dateTo) : "today"} (${where})`, describeFilters(tileFilters, fields.filter((f) => f.key !== "location"), "Period"), lines, { totals: ["Opening", "Received", issuedLabel, "Closing"] });
      if (deliveries.length) {
        const deliveryLines = deliveries.map((b) => ({
          Item: b.itemName,
          "Received On": day(b.receivedOn),
          Qty: b.receivedQty,
          Unit: b.unit,
          "Batch No": b.batchNo ?? "",
          "GRN No": b.grnNo ?? "",
          "Mfg Date": b.mfgDate ? day(b.mfgDate) : "",
          "Expiry Date": b.expiryDate ? day(b.expiryDate) : "",
          Vendor: b.vendorName ?? "",
          "Invoice No": b.invoiceNo ?? "",
        }));
        addReportSheet(wb, "Deliveries", `FLS Deliveries received: ${dateFrom ? day(dateFrom) : "start"} to ${dateTo ? day(dateTo) : "today"}`, "Only deliveries accepted by QC", deliveryLines, { totals: ["Qty"] });
      }
      XLSX.writeFile(wb, stampedName("FLS_Stock_Report"));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not build the report");
    } finally {
      setExporting(false);
    }
  }

  async function exportAll() {
    if (report) return exportMovement();
    setExporting(true);
    try {
      const qs = appendParams(new URLSearchParams(), params);
      const rows = await apiAll<AvailableStockByItem>(`${BASE}?${qs}`);
      // The batch sheet: every receipt behind the items in the report .
      const batches = await api<ItemBatch[]>(`${BASE}/batches/lookup`, { method: "POST", body: { itemIds: rows.map((r) => r.itemId) } });
      exportAvailableStockReport("item", rows, shownLocations, batches);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not build the report");
    } finally {
      setExporting(false);
    }
  }

  const colCount = 6 + (warehouseSide ? 4 : 0);

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-brand-500/10 text-brand-600">
            <Boxes className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Available Stock</h1>
            <p className="text-sm text-slate-500">
              {report ? (
                <>
                  Stock report, {dateFrom ? day(dateFrom) : "from the start"} to {dateTo ? day(dateTo) : "today"} · {movement.total.toLocaleString()} item(s) ·{" "}
                  {pickedLocationKeys.length ? shownLocations.map((l) => l.label).join(", ") : meta?.scoped ? "your store and its Plant" : "whole company"}
                </>
              ) : (
                <>
                  {paged.total.toLocaleString()} item(s){isFiltered ? " match" : " with stock"} — {meta?.scoped ? "in your store and its Plant" : "across Warehouse, Stores, R&D Store and Plants"}
                </>
              )}
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm shrink-0" disabled={(report ? movement.total : paged.total) === 0 || exporting} onClick={exportAll}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> {exporting ? "Preparing…" : `Download Report${isFiltered ? " (Filtered)" : ""}`}
        </button>
      </div>

      <TileFilterBar filters={tileFilters} tileKey="available-stock" fields={fields} dateLabel="Stock report: from / to date" />
      {report && <p className="text-xs text-slate-500">Opening = stock at the start of the From day, Closing = stock at the end of the To day. Clear the dates to see the stock as it is now.</p>}

      {!report && <label className="flex w-fit items-center gap-2 text-xs font-bold text-slate-600">
        <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} className="h-4 w-4 rounded border-slate-300 accent-brand-600" /> Include out-of-stock items
      </label>}

      {report ? (
        movement.isLoading ? (
          <div className="skeleton h-64 w-full" />
        ) : movement.total === 0 ? (
          <EmptyState icon={PackageOpen} title="No stock movement" hint="Nothing was held or moved in this period for these filters." accent="slate" />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                  <th className="w-8 px-2 py-3" />
                  <th className="min-w-[220px] px-4 py-3">Item</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3 text-right">Opening</th>
                  <th className="px-4 py-3 text-right">Received</th>
                  <th className="px-4 py-3 text-right">{issuedLabel}</th>
                  <th className="px-4 py-3 text-right">Closing</th>
                  <th className="px-4 py-3">Unit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {movement.rows.map((r) => {
                  const isOpen = openItemId === r.itemId;
                  return (
                  <Fragment key={r.itemId}>
                  <tr className="transition hover:bg-slate-50">
                    <td className="px-2 py-3">
                        <button
                          type="button"
                          onClick={() => setOpenItemId(isOpen ? null : r.itemId)}
                          aria-expanded={isOpen}
                          title="Show every entry of this item in the period: each delivery with its batch, GRN, mfg and expiry dates, and every issue, transfer and use"
                          className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-brand-600"
                        >
                          <ChevronDown className={`h-4 w-4 transition ${isOpen ? "rotate-180" : ""}`} strokeWidth={2.5} />
                        </button>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-bold text-slate-800">{r.itemName}</span>
                      {r.itemCode && <span className="block font-mono text-micro text-slate-400">{r.itemCode}</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">{fmtQty(r.opening)}</td>
                    <td className="px-4 py-3 text-right font-mono text-emerald-700">{r.received ? fmtQty(r.received) : <span className="text-slate-300">-</span>}</td>
                    <td className="px-4 py-3 text-right font-mono text-rose-700">{r.issued ? fmtQty(r.issued) : <span className="text-slate-300">-</span>}</td>
                    <td className="px-4 py-3 text-right font-mono font-bold text-slate-900">{fmtQty(r.closing)}</td>
                    <td className="px-4 py-3 text-slate-500">{r.unit ?? ""}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={8} className="border-l-2 border-brand-200 bg-slate-50/60 px-6 py-3">
                        <p className="mb-1 text-micro font-bold uppercase tracking-wide text-slate-400">Entries in this period</p>
                        <EntriesTable itemId={r.itemId} unit={r.unit} from={dateFrom || undefined} to={dateTo || undefined} locationKeys={pickedLocationKeys} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
            <Pagination page={movement.page} pageSize={movement.pageSize} total={movement.total} onPage={movement.setPage} onPageSize={movement.setPageSize} isFetching={movement.isFetching} />
          </div>
        )
      ) : paged.isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : paged.total === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "No stock on hand"} hint={isFiltered ? "Nothing matches these filters." : "Stock shows here once material is received into the Warehouse."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="w-8 px-2 py-3" />
                <th className="min-w-[200px] px-4 py-3">Item</th>
                <th className="px-4 py-3">Category</th>
                <th className="min-w-[260px] px-4 py-3">Where it is</th>
                <th className="px-4 py-3">Earliest Expiry</th>
                {warehouseSide && (
                  <>
                    <th className="px-4 py-3 text-right">Batches</th>
                    <th className="px-4 py-3">Last Received</th>
                    <th className="px-4 py-3 text-right">Quarantine</th>
                    <th className="px-4 py-3 text-right">On Order</th>
                  </>
                )}
                <th className="sticky right-0 bg-slate-50 px-4 py-3 text-right shadow-[-6px_0_8px_-6px_rgba(15,23,42,0.12)]">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paged.rows.map((r) => {
                const d = r.detail;
                const isOpen = openItemId === r.itemId;
                const chips = shownLocations.filter((l) => (r.locations[l.key] ?? 0) > 0);
                return (
                  <Fragment key={r.itemId}>
                    <tr className="group align-top transition hover:bg-slate-50">
                      <td className="px-2 py-3">
                        <button
                          type="button"
                          onClick={() => setOpenItemId(isOpen ? null : r.itemId)}
                          aria-expanded={isOpen}
                          title="Show its stock by location and its batches (mfg / expiry dates)"
                          className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-brand-600"
                        >
                          <ChevronDown className={`h-4 w-4 transition ${isOpen ? "rotate-180" : ""}`} strokeWidth={2.5} />
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-bold text-slate-800">{r.itemName}</span>
                        {r.itemCode && <span className="block font-mono text-micro text-slate-400">{r.itemCode}</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-500">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                      <td className="px-4 py-3">
                        {chips.length === 0 ? (
                          <span className="text-slate-300">Out of stock</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {chips.map((l) => (
                              <span key={l.key} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-tiny text-slate-600">
                                {l.label}
                                <span className="font-mono font-bold text-slate-900">{fmtQty(r.locations[l.key] ?? 0)}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <ExpiryCell iso={d?.earliestExpiry ?? null} days={d?.expiresInDays ?? null} />
                      </td>
                      {warehouseSide && (
                        <>
                          <td className="px-4 py-3 text-right font-mono text-slate-700">{d?.batches || <span className="text-slate-300">—</span>}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-slate-600">{day(d?.lastReceived ?? null)}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-right">
                            {d?.quarantineQty ? (
                              <span className="inline-flex items-center gap-1 font-mono font-bold text-amber-700">
                                <AlarmClock className="h-3 w-3" strokeWidth={2.5} /> {d.quarantineQty}
                              </span>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right">
                            {d?.onOrderQty ? (
                              <>
                                <span className="font-mono font-bold text-emerald-700">{d.onOrderQty}</span>
                                {d.nextEta && <span className="block text-micro text-slate-500">ETA {day(d.nextEta)}</span>}
                              </>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                        </>
                      )}
                      <td className="sticky right-0 whitespace-nowrap bg-white px-4 py-3 text-right font-mono font-bold text-slate-900 shadow-[-6px_0_8px_-6px_rgba(15,23,42,0.12)] group-hover:bg-slate-50">
                        {r.total} {r.unit ?? ""}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={colCount} className="border-l-2 border-brand-200 bg-slate-50/60 px-6 py-3">
                          <div className="space-y-5">
                            <div>
                              <p className="mb-1 text-micro font-bold uppercase tracking-wide text-slate-400">By location</p>
                              <LocationBreakdown item={r} locations={shownLocations} />
                            </div>
                            <div>
                              <p className="mb-1 text-micro font-bold uppercase tracking-wide text-slate-400">Batches</p>
                              <BatchTable itemId={r.itemId} unit={r.unit} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
