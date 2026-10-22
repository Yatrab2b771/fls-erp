import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { AlarmClock, ArrowLeft, Check, Download, PackageOpen, Send, X } from "lucide-react";
import { useReviewInventoryRequest } from "../lib/hooks";
import { ApiError, api, apiAll } from "../lib/api";
import { appendParams, useTileFilters } from "../lib/tileFilters";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";
import { groupBundles, type Bundle, type BundleLine } from "../lib/bundles";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { BundleCard } from "../components/BundleCard";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import type { OptionPage } from "../components/MultiSelectDropdown";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";

const BASE = "/api/inventory/my-store/production-requests";
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");

interface ProductionRequestRow extends BundleLine {
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  requestedQty: number;
  issuedQty: number;
  remainingQty: number;
  statusKey: string;
  status: string;
  storeId: string | null;
  storeName: string | null;
  requestedBy: string;
  storeStock: number; // the whole pile on the shelf
  storeShare: number; // the part of it that covers this request (the pile is shared by the plans that need the same material)
  // What the Warehouse holds now, and what Purchase is doing about a short material.
  warehouseStock: number;
  purchaseState: "ON_ORDER" | "NOT_ORDERED" | null;
  purchaseEta: string | null;
  purchaseEtaLate: boolean;
  // Production's extra material (outside any plan): why it was asked, and where its purchase need stands (With PPIC / With Purchase / On order).
  isExtra: boolean;
  supplyLabel: string | null;
  refProduct: string | null;
  /** The batch an extra request is for. */
  batchNo?: string | null;
  /** Production typed the material in (it was not in the item list). */
  newMaterial?: boolean;
  short: boolean;
  askedFromWarehouse: number;
  toAsk: number;
  stage: "WITH_DAY_STORE" | "REQUESTED_FROM_WAREHOUSE" | "ISSUED_TO_DAY_STORE" | "ISSUED_TO_PLANT" | "CLOSED";
  stageLabel: string;
  note: string | null;
}

const serverList = (key: string, label: string): FilterField => ({
  key,
  label,
  load: (q) => api<OptionPage>(`${BASE}/options?field=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
});
const FIELDS: FilterField[] = [
  serverList("product", "Product"),
  serverList("po", "PO Number"),
  serverList("item", "Item"),
  { key: "short", label: "Short at my store", options: ["Yes", "No"] },
];

const TRAIL_STYLE: Record<ProductionRequestRow["stage"], string> = {
  WITH_DAY_STORE: "border-violet-200 bg-violet-50 text-violet-700",
  REQUESTED_FROM_WAREHOUSE: "border-blue-200 bg-blue-50 text-blue-700",
  ISSUED_TO_DAY_STORE: "border-sky-200 bg-sky-50 text-sky-700",
  ISSUED_TO_PLANT: "border-emerald-200 bg-emerald-50 text-emerald-700",
  CLOSED: "border-slate-200 bg-slate-50 text-slate-500",
};

const isAskable = (r: ProductionRequestRow) => r.open && r.toAsk > 0 && r.askedFromWarehouse === 0;

// The material a production plan needs, one card per product, and whether the Store has it. This page only SHOWS that (and where the rest is: the
// Warehouse's stock, Purchase's ETA) and lets the Store ask the Warehouse for what it is short of - for a whole product at once or line by line. The
// requests are approved from the start, and the material goes on to the Plant at Dispensing (which closes these lines as it goes), not from here.
// Trail: With Store -> Requested from Warehouse -> Issued to Store -> Issued to Plant.
export function MyStoreProductionRequestsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const tileFilters = useTileFilters();
  const review = useReviewInventoryRequest();
  const askWarehouse = useMutation({ mutationFn: (id: string) => api<{ id: string; requestedQty: number }>(`${BASE}/${id}/request-from-warehouse`, { method: "POST" }) });
  const qs = appendParams(new URLSearchParams(), tileFilters.params).toString();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["inventory", "my-store", "production-requests", "all", qs],
    queryFn: () => apiAll<ProductionRequestRow>(`${BASE}${qs ? `?${qs}` : ""}`),
  });
  const bundles = groupBundles(rows ?? [], (r) => r.storeId ?? "");
  const pg = useClientPaging(bundles);
  const isFiltered = tileFilters.activeCount > 0;

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["inventory", "my-store"] });
    await qc.invalidateQueries({ queryKey: ["inventory", "material-requests"] });
  };
  // Runs one call per line, one after the other, and says how many went through.
  async function runAll(key: string, lines: ProductionRequestRow[], doOne: (r: ProductionRequestRow) => Promise<unknown>, doneWord: string) {
    setBusyKey(key);
    let ok = 0;
    let failed = 0;
    let lastError = "";
    for (const line of lines) {
      try {
        await doOne(line);
        ok += 1;
      } catch (err) {
        failed += 1;
        lastError = err instanceof ApiError ? err.message : "failed";
      }
    }
    await refresh();
    setBusyKey(null);
    if (failed === 0) toast.success(`${ok} material${ok === 1 ? "" : "s"} ${doneWord}.`);
    else toast.error(`${ok} ${doneWord}, ${failed} could not be done — ${lastError}`);
  }

  const askLine = (r: ProductionRequestRow) => askWarehouse.mutateAsync(r.id);
  const toggle = (id: string) => setSelected((cur) => (cur.has(id) ? new Set([...cur].filter((x) => x !== id)) : new Set([...cur, id])));
  // Bulk request: every short material across the plans, or just the ticked ones. The Warehouse sees them together, material by material.
  const askableAll = (rows ?? []).filter(isAskable);
  const askableTicked = askableAll.filter((r) => selected.has(r.id));
  const bulkAsk = async (lines: ProductionRequestRow[]) => {
    await runAll("page", lines, askLine, "asked from the Warehouse");
    setSelected(new Set());
  };

  // An extra request is the Store's call (is it justified?): approve it, or reject it with a reason. Approved, it is dispensed from Dispensing.
  async function approveOne(r: ProductionRequestRow) {
    try {
      await review.mutateAsync({ id: r.id, action: "APPROVE" });
      await refresh();
      toast.success("Approved. Dispense it from Dispensing.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not approve this request");
    }
  }
  async function rejectOne(r: ProductionRequestRow) {
    const reason = window.prompt(`Why do you reject ${r.itemName}?`)?.trim();
    if (!reason) return;
    try {
      await review.mutateAsync({ id: r.id, action: "REJECT", rejectionReason: reason });
      await refresh();
      toast.success("Request rejected.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not reject this request");
    }
  }
  async function approveAllExtra(lines: ProductionRequestRow[]) {
    await runAll("page", lines, (r) => review.mutateAsync({ id: r.id, action: "APPROVE" }), "approved");
  }
  async function askOne(r: ProductionRequestRow) {
    try {
      const res = await askLine(r);
      await refresh();
      toast.success(`Asked the Warehouse for ${fmtQty((res as { requestedQty: number }).requestedQty)} ${r.unit} — marked urgent.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not ask the Warehouse");
    }
  }

  // The Excel follows the filters that are applied: all requests (one row per material, products together), a one-row-per-product
  // summary, and the short items (what the store must ask the Warehouse for, with what the Warehouse holds and Purchase's ETA).
  function download() {
    const all = [...(rows ?? [])].sort((a, b) => (a.productName ?? "").localeCompare(b.productName ?? "") || (a.poNumber ?? "").localeCompare(b.poNumber ?? "") || a.itemName.localeCompare(b.itemName));
    const etaText = (r: ProductionRequestRow) => (r.purchaseState === "ON_ORDER" ? day(r.purchaseEta) : r.purchaseState === "NOT_ORDERED" ? "No ETA yet" : "");
    const shortQtyOf = (r: ProductionRequestRow) => (r.open ? Math.max(0, Math.round((r.remainingQty - r.storeShare) * 1000) / 1000) : 0);
    const requests = all.map((r) => ({
      Product: r.productName ?? "",
      Status: r.status,
      "PO Number": r.poNumber ?? "",
      Plant: r.plantName ?? "",
      Item: r.itemName,
      "RM / PM": r.category,
      Unit: r.unit,
      Requested: r.requestedQty,
      Issued: r.issuedQty,
      Remaining: r.remainingQty,
      "My Store Stock": r.storeStock,
      "In Warehouse": r.warehouseStock,
      Short: shortQtyOf(r),
      "Purchase ETA": etaText(r),
      "Needed By": r.neededBy ? day(r.neededBy) : "",
      Trail: r.stageLabel,
    }));
    const summary = groupBundles(all, (r) => r.storeId ?? "").map((b) => ({
      Product: b.title,
      "PO Number": b.lines[0]?.poNumber ?? "",
      Plant: b.lines[0]?.plantName ?? "",
      Materials: b.lines.length,
      Covered: b.lines.filter((l) => !l.short).length,
      Short: b.lines.filter((l) => l.short).length,
      Overdue: b.overdue ? "Yes" : "No",
      "Needed By": b.neededBy ? day(b.neededBy) : "",
    }));
    const shortItems = all
      .filter((r) => r.short)
      .map((r) => {
        const short = shortQtyOf(r);
        return {
          Product: r.productName ?? "",
          "PO Number": r.poNumber ?? "",
          Item: r.itemName,
          Unit: r.unit,
          Short: short,
          "In Warehouse": r.warehouseStock,
          "Warehouse can cover": r.warehouseStock >= short ? "Yes" : r.warehouseStock > 0 ? "Partly" : "No",
          "Already asked": r.askedFromWarehouse,
          "Purchase ETA": etaText(r),
          "Needed By": r.neededBy ? day(r.neededBy) : "",
        };
      });
    const filterText = describeFilters(tileFilters, FIELDS);
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "All requests", "FLS Production Requests", filterText, requests);
    addReportSheet(wb, "Product summary", "FLS Production Requests: product summary", filterText, summary, { totals: ["Materials", "Covered", "Short"] });
    addReportSheet(wb, "Short items", "FLS Production Requests: short items", filterText, shortItems, { headers: ["Product", "PO Number", "Item", "Unit", "Short", "In Warehouse", "Warehouse can cover", "Already asked", "Purchase ETA", "Needed By"] });
    XLSX.writeFile(wb, stampedName("FLS_Production_Requests"));
  }

  function renderBundle(b: Bundle<ProductionRequestRow>) {
    const lines = b.lines;
    const askable = lines.filter(isAskable);
    const pendingExtra = lines.filter((l) => l.isExtra && l.statusKey === "PENDING");
    const done = lines.filter((l) => !l.open).length;
    const shortLines = lines.filter((l) => l.short).length;
    const openLines = lines.filter((l) => l.open);
    const coveredLines = openLines.filter((l) => !l.short).length;
    const busy = busyKey === b.key;
    return (
      <BundleCard
        key={b.key}
        title={b.title}
        subtitle={b.subtitle}
        neededBy={b.neededBy ? day(b.neededBy) : null}
        overdue={b.overdue}
        chips={[
          { label: `${lines.length} material${lines.length === 1 ? "" : "s"}` },
          ...(done ? [{ label: `${done} done`, tone: "good" as const }] : []),
          ...(openLines.length > 0 && shortLines === 0 ? [{ label: "All covered at my store", tone: "good" as const }] : coveredLines > 0 ? [{ label: `${coveredLines} covered`, tone: "good" as const }] : []),
          ...(shortLines ? [{ label: `${shortLines} short at my store`, tone: "bad" as const }] : []),
        ]}
        actions={
          <>
            {pendingExtra.length > 0 && (
              <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void approveAllExtra(pendingExtra)}>
                <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> Approve all ({pendingExtra.length})
              </button>
            )}
            {askable.length > 0 && (
              <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => runAll(b.key, askable, askLine, "asked from the Warehouse")} title="Asks the Warehouse (urgent) for every material your store is short of">
                <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> Request short items ({askable.length})
              </button>
            )}
          </>
        }
      >
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
              <th className="w-8 px-3 py-2.5"></th>
              <th className="px-4 py-2.5">Item</th>
              <th className="px-4 py-2.5 text-right">Plan needs</th>
              <th className="px-4 py-2.5 text-right" title="Sent on to the Plant (at Dispensing)">Given to Plant</th>
              <th className="px-4 py-2.5 text-right">At my Store</th>
              <th className="px-4 py-2.5 text-right">In Warehouse</th>
              <th className="px-4 py-2.5">Purchase ETA</th>
              <th className="px-4 py-2.5">Trail</th>
              <th className="px-4 py-2.5">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((r) => (
              <Fragment key={r.id}>
                <tr className="align-top transition hover:bg-slate-50">
                  <td className="px-3 py-2.5">
                    {isAskable(r) && <input type="checkbox" className="h-3.5 w-3.5" checked={selected.has(r.id)} onChange={() => toggle(r.id)} title="Tick to ask the Warehouse for it in bulk" />}
                  </td>
                  <td className="whitespace-normal px-4 py-2.5 font-bold text-slate-800">
                    {r.itemName}
                    {r.open && !r.short && <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 py-0.5 align-middle text-micro font-bold uppercase text-emerald-700">Covered</span>}
                    {r.isExtra && <span className="ml-1.5 rounded-full bg-violet-100 px-1.5 py-0.5 align-middle text-micro font-bold uppercase text-violet-700">{r.newMaterial ? "New material" : "Extra"}</span>}
                    {r.isExtra && r.batchNo && <span className="block text-micro font-bold text-orange-800">For batch {r.batchNo}</span>}
                    {r.isExtra && r.note && <span className="block text-micro font-normal text-slate-500">{r.note} · asked by {r.requestedBy}</span>}
                    {r.isExtra && r.supplyLabel && r.supplyLabel !== "—" && <span className="block text-micro font-bold text-amber-600">{r.supplyLabel}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                    {fmtQty(r.requestedQty)} {r.unit}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-emerald-700">{r.issuedQty ? fmtQty(r.issuedQty) : "—"}</td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="font-mono text-slate-700">{fmtQty(r.storeStock)}</span>
                    {r.short && <span className="block text-micro font-bold text-rose-600">{fmtQty(Math.max(0, r.remainingQty - r.storeShare))} short</span>}
                    {r.open && r.storeStock > 0 && r.storeShare < r.storeStock - 1e-6 && <span className="block text-micro text-slate-400">{fmtQty(r.storeShare)} for this plan</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className={`font-mono ${r.warehouseStock > 0 ? "font-bold text-emerald-700" : "text-slate-300"}`}>{r.warehouseStock > 0 ? fmtQty(r.warehouseStock) : "—"}</span>
                    {r.short && r.open && (
                      <span className={`block text-micro font-bold ${r.warehouseStock > 0 ? "text-emerald-600" : "text-amber-600"}`}>
                        {r.warehouseStock >= r.toAsk && r.toAsk > 0 ? "Ask the Warehouse now" : r.warehouseStock > 0 ? "Partly in Warehouse" : "Not in Warehouse yet"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.purchaseState === "ON_ORDER" ? (
                      <span className={`text-xs font-bold ${r.purchaseEtaLate ? "text-rose-600" : "text-slate-700"}`}>
                        {day(r.purchaseEta)}
                        {r.purchaseEtaLate && <span className="block text-micro font-bold">Late</span>}
                      </span>
                    ) : r.purchaseState === "NOT_ORDERED" ? (
                      <span className="text-micro font-bold text-amber-600">With Purchase, no ETA yet</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`pill ${TRAIL_STYLE[r.stage]}`}>{r.stageLabel}</span>
                    {r.askedFromWarehouse > 0 && (
                      <span className="block text-micro text-slate-500">
                        {fmtQty(r.askedFromWarehouse)} {r.unit} asked
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.isExtra && r.statusKey === "PENDING" && (
                      <div className="mb-1 flex gap-1.5">
                        <button type="button" className="btn-primary btn-sm" disabled={review.isPending || busy} onClick={() => approveOne(r)}>
                          <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> Approve
                        </button>
                        <button type="button" className="btn-ghost btn-sm text-rose-600" disabled={review.isPending || busy} onClick={() => rejectOne(r)}>
                          <X className="h-3.5 w-3.5" strokeWidth={2.5} /> Reject
                        </button>
                      </div>
                    )}
                    {r.isExtra && r.open && r.statusKey !== "PENDING" && r.storeStock > 0 && <p className="mb-1 text-micro font-bold text-violet-700">Dispense it from Dispensing</p>}
                    {isAskable(r) && (
                      <button type="button" className="btn-ghost btn-sm" disabled={askWarehouse.isPending || busy} onClick={() => askOne(r)} title="Your store is short - ask the Warehouse (urgent)">
                        <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> Request from Warehouse
                      </button>
                    )}
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </BundleCard>
    );
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
       <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <div className="stat-icon bg-amber-500/10 text-amber-600">
          <AlarmClock className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Production Requests</h1>
          <p className="text-sm text-slate-500">
            {bundles.length.toLocaleString()} product{bundles.length === 1 ? "" : "s"} ({(rows ?? []).length.toLocaleString()} material request{(rows ?? []).length === 1 ? "" : "s"}){isFiltered ? " match" : ""} for your Plant — one card per product, with whether your store has the material. Late ones come first.
          </p>
        </div>
       </div>
       <button type="button" className="btn-primary btn-sm shrink-0" disabled={(rows ?? []).length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <TileFilterBar filters={tileFilters} tileKey="my-store-production-requests" fields={FIELDS} dateLabel="Requested" hideDates />

      {askableAll.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5">
          <p className="text-xs font-semibold text-amber-800">
            {askableAll.length} material{askableAll.length === 1 ? "" : "s"} short at your store across your plans. Ask the Warehouse for all of them together, or tick some rows below.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {askableTicked.length > 0 && (
              <button type="button" className="btn-primary btn-sm" disabled={busyKey === "page"} onClick={() => bulkAsk(askableTicked)}>
                <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> Request ticked ({askableTicked.length})
              </button>
            )}
            <button type="button" className={askableTicked.length > 0 ? "btn-ghost btn-sm" : "btn-primary btn-sm"} disabled={busyKey === "page"} onClick={() => bulkAsk(askableAll)}>
              <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> Request all short items ({askableAll.length})
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : bundles.length === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "No production requests"} hint={isFiltered ? "Nothing matches these filters." : "Material a production plan needs at your Plant shows here."} accent="brand" />
      ) : (
        <div className="space-y-4">
          {pg.rows.map(renderBundle)}
          <div className="overflow-hidden rounded-2xl">
            <ClientPager pg={pg} />
          </div>
        </div>
      )}
    </div>
  );
}
