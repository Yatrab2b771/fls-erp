import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ChevronDown, Download, PackageOpen, Truck } from "lucide-react";
import { useHandOverBatch, useHandoverBoard, type HandoverRow } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { AgingCell, agingDays, inAgingBuckets } from "../components/AgingCell";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { fmtQty } from "../lib/format";
import { COMBINED_LOT_STAGE_LABEL } from "../lib/combinedLotStage";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";
import type { CombinedLotStageId } from "../lib/types";
import { CustomerName } from "../components/CustomerName";
import { customerTypeLabel } from "../lib/customerTags";

type BatchState = "PACKING" | "READY" | "HANDED";
const STATE_LABEL: Record<BatchState, string> = { PACKING: "Packaging running", READY: "Ready to hand over", HANDED: "Handed over" };
const STATE_PILL: Record<BatchState, string> = {
  PACKING: "border-amber-200 bg-amber-50 text-amber-700",
  READY: "border-emerald-200 bg-emerald-50 text-emerald-700",
  HANDED: "border-sky-200 bg-sky-50 text-sky-700",
};

const packagingDone = (b: HandoverRow) => String(b.packagingStatus ?? "").trim().toLowerCase() === "completed";
// Packaging running: at Packaging, not Completed yet. Ready: Packaging Completed (or already moved on) and not handed over yet.
function stateOf(b: HandoverRow): BatchState {
  if (b.handedOverAt) return "HANDED";
  if (b.currentStageId === "PACKAGING" && !packagingDone(b)) return "PACKING";
  return "READY";
}

interface ProductGroup {
  itemId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  productCategory: string | null;
  plantName: string | null;
  unit: string;
  batches: HandoverRow[];
  output: number;
  since: string;
}

function groupByProduct(rows: HandoverRow[]): ProductGroup[] {
  const map = new Map<string, HandoverRow[]>();
  for (const r of rows) map.set(r.itemId, [...(map.get(r.itemId) ?? []), r]);
  return [...map.values()].map((batches) => {
    const f = batches[0]!;
    return {
      itemId: f.itemId,
      poNumber: f.poNumber,
      customerName: f.customerName,
      productName: f.productName,
      productCategory: f.productCategory,
      plantName: f.plant?.name ?? null,
      unit: f.unit,
      batches,
      output: batches.reduce((sum, b) => sum + (b.outputQty ?? 0), 0),
      since: batches.map((b) => b.completedAt).filter((v): v is string => !!v).sort()[0] ?? new Date().toISOString(),
    };
  });
}

// Production's third tile. A product's batches whose manufacturing is complete: once a batch's packaging reads Completed, Production hands
// it over to QA with one click. After that QA's packaging gate, the Day Store (finished goods), QA's approval and Dispatch belong to other
// departments; a batch leaves this page once QA has passed the packaging gate.
export function HandoverPage() {
  const { hasRole } = useAuth();
  const canHandOver = hasRole("PRODUCTION");
  const toast = useToast();
  const { data, isLoading } = useHandoverBoard();
  const handOver = useHandOverBatch();
  const filters = useTileFilters();
  const [openId, setOpenId] = useState<string | null>(null);
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const all = groupByProduct(data ?? []);
  const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const showPlant = distinct(all.map((g) => g.plantName)).length > 1;

  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct(all.map((g) => g.poNumber)) },
    { key: "customer", label: "Customer", options: distinct(all.map((g) => g.customerName)) },
    { key: "product", label: "Product", options: distinct(all.map((g) => g.productName)) },
    { key: "type", label: "Product Type", options: distinct(all.map((g) => g.productCategory)) },
    ...(showPlant ? [{ key: "plant", label: "Plant", options: distinct(all.map((g) => g.plantName)) }] : []),
    { key: "status", label: "Status", options: Object.values(STATE_LABEL) },
    AGING_FIELD,
  ];
  const from = filters.applied.dateFrom;
  const to = filters.applied.dateTo;
  // A product shows when any of its batches is in a picked status; the dropdown then lists just those batches.
  const batchOk = (b: HandoverRow) => !picked("status").length || picked("status").includes(STATE_LABEL[stateOf(b)]);
  const groups = all
    .filter(
      (g) =>
        (!picked("po").length || picked("po").includes(g.poNumber ?? "")) &&
        (!picked("customer").length || picked("customer").includes(g.customerName)) &&
        (!picked("product").length || picked("product").includes(g.productName)) &&
        (!picked("type").length || picked("type").includes(g.productCategory ?? "")) &&
        (!picked("plant").length || picked("plant").includes(g.plantName ?? "")) &&
        (!from || g.since.slice(0, 10) >= from) &&
        (!to || g.since.slice(0, 10) <= to) &&
        inAgingBuckets(agingDays(g.since), picked("aging")),
    )
    .map((g) => ({ ...g, batches: g.batches.filter(batchOk) }))
    .filter((g) => g.batches.length > 0);
  const pg = useClientPaging(groups);
  const isFiltered = filters.activeCount > 0;
  const countState = (s: BatchState) => (data ?? []).filter((b) => stateOf(b) === s).length;

  async function hand(batches: HandoverRow[]) {
    let ok = 0;
    for (const b of batches) {
      try {
        await handOver.mutateAsync(b.batchId);
        ok += 1;
      } catch (err) {
        toast.error(`${b.batchNo ?? "Batch"}: ${err instanceof ApiError ? err.message : "could not hand over"}`);
      }
    }
    if (ok) toast.success(`${ok} batch${ok === 1 ? "" : "es"} handed over to QA.`);
  }

  function download() {
    const rows = groups.flatMap((g) => g.batches).map((b) => ({
        "PO Number": b.poNumber ?? "",
        "Packaging Status": b.packagingStatus ?? "",
        Status: STATE_LABEL[stateOf(b)],
        Customer: b.customerName,
        "Customer Type": customerTypeLabel(b.customerName),
        Product: b.productName,
        "Product Type": b.productCategory ?? "",
        Plant: b.plant?.name ?? "",
        "Batch No": b.batchNo ?? "",
        Unit: b.unit,
        "Output Qty": b.outputQty ?? "",
        "Packed Qty": b.packedQty ?? "",
        "Dispatched Qty": b.dispatchedQty,
        "Now At": COMBINED_LOT_STAGE_LABEL[b.currentStageId as CombinedLotStageId] ?? b.currentStageId,
        "Handed Over": b.handedOverAt ? new Date(b.handedOverAt).toLocaleString() : "",
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Handover", "FLS Handover to QA", describeFilters(filters, fields, "Manufactured"), rows, { totals: ["Output Qty", "Packed Qty", "Dispatched Qty"] });
    XLSX.writeFile(wb, stampedName("FLS_Handover"));
  }

  const chip = (s: BatchState) => (
    <button
      key={s}
      type="button"
      onClick={() => filters.applyPick("status", picked("status").includes(STATE_LABEL[s]) ? [] : [STATE_LABEL[s]])}
      className={`pill cursor-pointer ${STATE_PILL[s]} ${picked("status").includes(STATE_LABEL[s]) ? "ring-2 ring-brand-300" : ""}`}
    >
      {STATE_LABEL[s]} · {countState(s)}
    </button>
  );

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-emerald-500/10 text-emerald-600">
            <Truck className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{canHandOver ? "Handover" : "From Production"}</h1>
            <p className="text-sm text-slate-500">
              {groups.length.toLocaleString()} product{groups.length === 1 ? "" : "s"}
              {isFiltered ? ` of ${all.length}` : ""} —{" "}
              {canHandOver ? "when a batch's packaging is complete, hand it over to QA. After QA passes the packaging gate it goes to the Day Store as finished goods." : "batches Production has handed over to QA."}
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm shrink-0" disabled={groups.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">{(["PACKING", "READY", "HANDED"] as BatchState[]).map(chip)}</div>

      <TileFilterBar filters={filters} tileKey="handover" fields={fields} dateLabel="Manufactured" />

      {isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : groups.length === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : "Nothing here yet"} hint={isFiltered ? "Nothing matches these filters." : "Batches show here once their manufacturing is complete."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Product Type</th>
                {showPlant && <th className="px-4 py-3">Plant</th>}
                <th className="px-4 py-3">Batches</th>
                <th className="px-4 py-3 text-right">Output</th>
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3">Batch list</th>
                {canHandOver && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((g) => {
                const open = openId === g.itemId;
                const ready = g.batches.filter((b) => stateOf(b) === "READY");
                const states = (["PACKING", "READY", "HANDED"] as BatchState[]).map((s) => ({ s, n: g.batches.filter((b) => stateOf(b) === s).length })).filter((x) => x.n > 0);
                return (
                  <Fragment key={g.itemId}>
                    <tr className={`transition hover:bg-slate-50 ${open ? "bg-slate-50/70" : ""}`}>
                      <td className="px-4 py-3 font-semibold text-slate-700">{g.poNumber ?? "—"}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {states.map(({ s, n }) => (
                            <span key={s} className={`pill ${STATE_PILL[s]}`}>
                              {n} {STATE_LABEL[s].toLowerCase()}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600"><CustomerName name={g.customerName} /></td>
                      <td className="px-4 py-3 font-bold text-slate-800">{g.productName}</td>
                      <td className="px-4 py-3 text-slate-600">{g.productCategory ?? "—"}</td>
                      {showPlant && <td className="px-4 py-3 text-slate-600">{g.plantName ?? "—"}</td>}
                      <td className="px-4 py-3 font-mono font-bold text-slate-700">{g.batches.length}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-800">
                        {fmtQty(g.output)} {g.unit}
                      </td>
                      <td className="px-4 py-3">
                        <AgingCell since={g.since} />
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setOpenId(open ? null : g.itemId)}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-tiny font-bold transition ${open ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                        >
                          Batches ({g.batches.length}) <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                        </button>
                      </td>
                      {canHandOver && (
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            className="btn-primary btn-sm"
                            disabled={ready.length === 0 || handOver.isPending}
                            title={ready.length === 0 ? "No batch of this product has finished packaging yet" : `Hand over ${ready.length} ready batch${ready.length === 1 ? "" : "es"} to QA`}
                            onClick={() => {
                              if (window.confirm(`Hand over ${ready.length} batch${ready.length === 1 ? "" : "es"} of ${g.productName} to QA?`)) void hand(ready);
                            }}
                          >
                            Hand over{ready.length > 1 ? ` all ready (${ready.length})` : " to QA"}
                          </button>
                        </td>
                      )}
                    </tr>
                    {open && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={9 + (showPlant ? 1 : 0) + (canHandOver ? 1 : 0)} className="px-4 py-4">
                          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                            <table className="w-full whitespace-nowrap text-xs">
                              <thead>
                                <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                                  <th className="px-3 py-2">Batch</th>
                                  <th className="px-3 py-2 text-right">Output</th>
                                  <th className="px-3 py-2">Packaging</th>
                                  <th className="px-3 py-2">Now at</th>
                                  <th className="px-3 py-2">Status</th>
                                  <th className="px-3 py-2">Handed over</th>
                                  <th className="px-3 py-2" />
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {g.batches.map((b) => {
                                  const st = stateOf(b);
                                  return (
                                    <tr key={b.batchId}>
                                      <td className="px-3 py-2 font-bold text-slate-700">{b.batchNo ?? `Batch ${b.batchId.slice(0, 8)}`}</td>
                                      <td className="px-3 py-2 text-right font-mono text-slate-800">
                                        {b.outputQty != null ? `${fmtQty(b.outputQty)} ${b.unit}` : "—"}
                                      </td>
                                      <td className="px-3 py-2 text-slate-600">{b.packagingStatus ?? "Not started"}</td>
                                      <td className="px-3 py-2 text-slate-600">{COMBINED_LOT_STAGE_LABEL[b.currentStageId as CombinedLotStageId] ?? b.currentStageId}</td>
                                      <td className="px-3 py-2">
                                        <span className={`pill ${STATE_PILL[st]}`}>{STATE_LABEL[st]}</span>
                                      </td>
                                      <td className="px-3 py-2 text-slate-500">{b.handedOverAt ? new Date(b.handedOverAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                                      <td className="px-3 py-2 text-right">
                                        {canHandOver && st === "READY" && (
                                          <button type="button" className="btn-primary btn-sm" disabled={handOver.isPending} onClick={() => void hand([b])}>
                                            Hand over
                                          </button>
                                        )}
                                        {canHandOver && st === "PACKING" && (
                                          <Link to={`/production-batches/${b.batchId}`} className="text-tiny font-bold text-brand-600 hover:underline">
                                            Open packaging →
                                          </Link>
                                        )}
                                        {st === "HANDED" && (
                                          <Link to={`/production-batches/${b.batchId}`} className="text-tiny font-bold text-slate-500 hover:underline">
                                            View →
                                          </Link>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <ClientPager pg={pg} />
        </div>
      )}
    </div>
  );
}
