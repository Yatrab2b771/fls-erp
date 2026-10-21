import { useState } from "react";
import { useAuth } from "../lib/auth";
import { Link } from "react-router-dom";
import { Download, Plus } from "lucide-react";
import * as XLSX from "xlsx";
import { usePlants, usePlantStock, useDayStores, useProductionBatches, useRecordPlantConsumption, type BoardBatch, type BoardMaterial, type PlanBoardRow, type RecordPlantConsumptionPayload } from "../lib/hooks";
import { NewProductionBatchForm, ProductionBatchesTable } from "../pages/PreProductionDetailPage";
import { PRE_PRODUCTION_STAGE_LABEL, PRE_PRODUCTION_STAGE_ROLE } from "../lib/preProductionStage";
import { batchYieldPct, materialUsed, q3, sumMaterials, UTILIZATION_COLUMNS, yieldPct } from "../lib/utilization";
import { ItemPicker } from "./ItemPicker";
import { useToast } from "./Toast";
import { ApiError } from "../lib/api";
import type { PreProductionStageId, ProductionBatch, UtilizationItem } from "../lib/types";
import { fmtQty } from "../lib/format";
import { leftToPlan } from "../lib/plansBoardExport";
import { CloseShortControl } from "./CloseShortControl";

// The Batch and Utilization dropdowns of the New Plan list.

/** Whether the run has cleared Line Clearance, so batches can be made. */
export const runIsReady = (row: PlanBoardRow) => !!row.run && row.run.currentStageId === "SAMPLE_QC_APPROVAL" && row.run.sampleQcStatus === "Approved";

// ---------------------------------------------------------------- Batch dropdown

// `only`: when the Batch / Utilization filters are on, just the batches that match them.
export function BatchPanel({ row, onStart, starting, only }: { row: PlanBoardRow; onStart: () => void; starting: boolean; only?: Set<string> }) {
  const run = row.run;
  const ready = runIsReady(row);
  const { data: batches } = useProductionBatches(ready ? run!.id : undefined);

  if (!run) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">The run has not started. Start it to add batches.</p>
        <button type="button" className="btn-primary btn-sm" disabled={starting} onClick={onStart}>
          {starting ? "Starting…" : "Start run"}
        </button>
      </div>
    );
  }
  if (!ready) {
    const stage = run.currentStageId as PreProductionStageId;
    const owner = PRE_PRODUCTION_STAGE_ROLE[stage]?.[0];
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
        <p>
          Batches open once Line Clearance is approved. The run is at <b>{PRE_PRODUCTION_STAGE_LABEL[stage] ?? stage}</b>
          {owner ? <> (with {owner === "STORE" ? "the Day Store" : owner === "QA_QC" ? "QA" : "Production"})</> : null}.
        </p>
        <Link to={`/pre-productions/${run.id}`} className="font-bold text-brand-700 hover:underline">
          Open the run →
        </Link>
      </div>
    );
  }

  // Per-batch flow: the batches listed here are the ones cleared for production (their indent, batch number, Dispensing and Line Clearance
  // are done); batches are added in New Plan. Older runs keep adding batches here.
  const flow = run.batchFlow;
  const shown = (batches ?? []).filter((b) => (!flow || b.prepStageId === "READY") && (!only || only.has(b.id)));
  // PPIC may have released only part of the order: batches can be planned only up to that.
  const inProgressPlanned = (batches ?? []).filter((b) => b.status === "IN_PROGRESS").reduce((sum, b) => sum + b.plannedQty, 0);
  const remaining = Math.max(0, run.plannedQty - run.combinedQty);
  const canPlan = Math.max(0, Math.min(remaining, q3(row.releasedQty - run.combinedQty - inProgressPlanned)));

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-slate-500">
        Produced {fmtQty(run.combinedQty)} of {fmtQty(run.plannedQty)} {row.unit}
        {row.releasedQty < row.quantity - 1e-6 && <span className="ml-2 text-amber-600">· PPIC released {fmtQty(row.releasedQty)}</span>}
      </p>
      {shown.length === 0 && <p className="text-xs text-slate-400">{flow ? "No batch is cleared for production yet. A batch comes here once its indent, batch number, Dispensing and Line Clearance are done." : "No batches yet."}</p>}
      {shown.length > 0 && <ProductTotal row={row} columns={[...UTILIZATION_COLUMNS]} />}
      <ProductionBatchesTable preProductionId={run.id} batches={shown} renderUtilization={(b) => <UtilizationSheet row={row} batch={b} category="RM" />} />
      {flow && <PreparingBatches row={row} />}
      {!flow && row.unassigned.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-dashed border-slate-300 bg-white">
          <p className="border-b border-slate-100 bg-slate-50/80 px-3 py-2 text-xs font-bold text-slate-500">Given at Dispensing, not booked to a batch <span className="font-normal text-slate-400">(the material the Day Store gave this run as a whole)</span></p>
          <UtilizationTable materials={row.unassigned} columns={[...UTILIZATION_COLUMNS]} />
        </div>
      )}
      {!flow &&
        (canPlan > 0 ? (
          <NewProductionBatchForm key={canPlan} preProductionId={run.id} remainingQty={canPlan} />
        ) : (
          remaining > 0 && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">All of the {fmtQty(row.releasedQty)} {row.unit} PPIC has released is planned. More batches open when PPIC releases more.</p>
        ))}
    </div>
  );
}

const PREP_STAGE_LABEL: Record<string, string> = { INDENT_ISSUE: "Indent Issue (Production)", BATCH_NO: "Batch No (R&D)", DISPENSING: "Dispensing (Day Store)", RECEIVE: "Receive (Production)" };

// New Plan's Batches dropdown: the run is started, and Production divides the plan into batches here (just the quantity of each). Each batch
// then goes through its own Indent Issue, Batch No, Dispensing and Line Clearance on those tiles.
export function DividePanel({ row, onStart, starting }: { row: PlanBoardRow; onStart: () => void; starting: boolean }) {
  const run = row.run;
  const { data: batches } = useProductionBatches(run?.id);
  if (!run) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">The run has not started. Start it, then divide the plan into batches.</p>
        <button type="button" className="btn-primary btn-sm" disabled={starting} onClick={onStart}>
          {starting ? "Starting…" : "Start run"}
        </button>
      </div>
    );
  }
  if (!run.batchFlow) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-600">
        <p>This run uses the older run-level stages.</p>
        <Link to={`/pre-productions/${run.id}`} className="font-bold text-brand-700 hover:underline">
          Open the run →
        </Link>
      </div>
    );
  }
  const list = batches ?? [];
  const planned = list.reduce((sum, b) => sum + b.plannedQty, 0);
  // What is left to plan counts what the finished batches actually made, so a batch that made less than planned leaves a shortfall
  const left = leftToPlan(row);
  const shortfall = list.length > 0 && planned + 1e-6 >= row.releasedQty && left > 1e-6;
  const materialsOf = (b: ProductionBatch) => {
    const items = b.utilization?.items ?? [];
    if (items.length === 0) return "—";
    const shown = items.slice(0, 4).map((i) => `${i.itemName} ${fmtQty(i.requiredQty)} ${i.unit}`);
    return `${items.length} materials: ${shown.join(", ")}${items.length > 4 ? ` +${items.length - 4} more` : ""}`;
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs font-semibold text-slate-500">
        <span>
          Released <b className="text-slate-800">{fmtQty(row.releasedQty)} {row.unit}</b>
        </span>
        <span>
          Planned in batches <b className="text-slate-800">{fmtQty(planned)} {row.unit}</b>
        </span>
        {shortfall && (
          <span>
            Made so far <b className="text-slate-800">{fmtQty(run.combinedQty)} {row.unit}</b>
          </span>
        )}
        <span>
          {shortfall ? "Shortfall" : "Left to plan"} <b className={left > 0 ? "text-amber-600" : "text-emerald-600"}>{fmtQty(left)} {row.unit}</b>
        </span>
      </div>
      {list.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2.5">Batch</th>
                <th className="px-3 py-2.5">Stage</th>
                <th className="px-3 py-2.5 text-right">Quantity</th>
                <th className="px-3 py-2.5">BOM for this batch (from its quantity)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((b, i) => (
                <tr key={b.id}>
                  <td className="px-3 py-2 font-black text-slate-800">{b.batchNo ?? `Batch ${i + 1}`}</td>
                  <td className="px-3 py-2">
                    <span className={`pill ${b.prepStageId === "READY" ? (b.status === "COMPLETED" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-violet-200 bg-violet-50 text-violet-700") : "border-amber-200 bg-amber-50 text-amber-700"}`}>
                      {b.prepStageId === "READY" ? (b.status === "COMPLETED" ? "Completed" : "Ready: Batch tile") : PREP_STAGE_LABEL[b.prepStageId]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-700">
                    {fmtQty(b.plannedQty)} {row.unit}
                  </td>
                  <td className="whitespace-normal px-3 py-2 text-slate-500">{materialsOf(b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.length === 0 && <p className="text-xs text-slate-400">No batches yet. Add the first one: its quantity is all that is needed now.</p>}
      {shortfall && <CloseShortControl row={row} />}
      {left > 0 ? <NewProductionBatchForm key={left} preProductionId={run.id} remainingQty={left} shortfall={{ plannedAll: planned, released: row.releasedQty }} /> : <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">All of the {fmtQty(row.releasedQty)} {row.unit} PPIC has released is divided into batches. More batches open when PPIC releases more.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Utilization dropdown

function UtilizationTable({ materials, columns }: { materials: BoardMaterial[]; columns: typeof UTILIZATION_COLUMNS[number][] }) {
  if (materials.length === 0) return <p className="px-3 py-2.5 text-xs text-slate-400">Nothing logged yet.</p>;
  const yieldOfBatch = batchYieldPct(materials);
  return (
    <div className="overflow-x-auto">
      <table className="w-full whitespace-nowrap text-xs">
        <thead>
          <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
            <th className="px-3 py-2">Material</th>
            {columns.map((c) => (
              <th key={c.key} className="px-3 py-2 text-right">
                {c.short} · {c.label}
              </th>
            ))}
            <th className="px-3 py-2 text-right" title="A + B + C + D - E">
              Material Used
            </th>
            <th className="px-3 py-2 text-right" title="A / Material Used">
              Yield
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {materials.map((m) => {
            const y = yieldPct(m);
            return (
              <tr key={m.itemId}>
                <td className="px-3 py-2 font-bold text-slate-700">{m.itemName}</td>
                {columns.map((c) => (
                  <td key={c.key} className={`px-3 py-2 text-right font-mono ${m[c.key] ? "font-bold text-slate-800" : "text-slate-300"}`}>
                    {m[c.key] ? `${q3(m[c.key])} ${m.unit}` : "—"}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-mono font-bold text-slate-900">
                  {materialUsed(m)} {m.unit}
                </td>
                <td className="px-3 py-2 text-right font-mono font-bold text-emerald-700">{y == null ? "—" : `${y}%`}</td>
              </tr>
            );
          })}
        </tbody>
        {yieldOfBatch != null && (
          <tfoot>
            <tr className="border-t border-slate-200 bg-slate-50/70">
              <td colSpan={columns.length + 2} className="px-3 py-2 text-right text-micro font-bold uppercase tracking-wide text-slate-500">
                Batch yield (raw material)
              </td>
              <td className="px-3 py-2 text-right font-mono font-black text-emerald-700">{yieldOfBatch}%</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// Log one material's usage for one batch: A, B, C, D and E (return to store) in one go.
function UsageForm({ row, batchId, onDone, initialItemId, planItems }: { row: PlanBoardRow; batchId: string; onDone: () => void; initialItemId?: string; planItems?: UtilizationItem[] }) {
  const toast = useToast();
  const run = row.run!;
  const plantId = row.plant?.id;
  const { data: plantStock } = usePlantStock(plantId);
  const { data: plants } = usePlants();
  const { data: dayStores } = useDayStores();
  const record = useRecordPlantConsumption(run.id);
  const [itemId, setItemId] = useState(initialItemId ?? "");
  const [qty, setQty] = useState({ consumedQty: "", wastedQty: "", rejectedQty: "", sampleQty: "", returnedQty: "" });

  // The materials a batch can log: first what the Day Store gave this run at Dispensing and no batch has booked yet (a batch takes its share
  // out of that), then anything else the Plant holds (extra material, which has to be on hand).
  const pool = row.unassigned.map((m) => ({ id: m.itemId, name: `${m.itemName} (${q3(m.consumedQty)} ${m.unit} given at Dispensing, not booked)`, unit: m.unit }));
  const poolIds = new Set(row.unassigned.map((m) => m.itemId));
  // The plan's own materials come first (with what was dispensed for this batch), then the Dispensing pool of older runs, then anything
  // else the Plant holds (extra material, which has to be on hand).
  const planOptions = (planItems ?? []).map((i) => ({ id: i.itemId, name: `${i.itemName} (given ${q3(i.givenQty)} ${i.unit})`, unit: i.unit }));
  const planIds = new Set(planOptions.map((p) => p.id));
  const stock = [
    ...planOptions,
    ...pool.filter((p) => !planIds.has(p.id)),
    ...(plantStock?.stock ?? []).filter((l) => !poolIds.has(l.item.id) && !planIds.has(l.item.id)).map((l) => ({ id: l.item.id, name: `${l.item.name} (${l.onHand} ${l.item.unit ?? ""} on hand)`.trim(), unit: l.item.unit ?? "" })),
  ];
  const picked = stock.find((s) => s.id === itemId);
  const n = (v: string) => Number(v) || 0;

  async function save() {
    if (!itemId) return toast.error("Select a material.");
    const total = n(qty.consumedQty) + n(qty.wastedQty) + n(qty.rejectedQty) + n(qty.sampleQty) + n(qty.returnedQty);
    if (total <= 0) return toast.error("Enter at least one quantity.");
    // Leftover goes back to the Plant's own Day Store (each Plant is paired with one).
    const dayStoreId = (plants ?? []).find((p) => p.id === plantId)?.dayStoreId ?? (dayStores ?? [])[0]?.id;
    const body: RecordPlantConsumptionPayload = {
      itemId,
      unit: picked?.unit || "Kg",
      productionBatchId: batchId,
      consumedQty: n(qty.consumedQty),
      wastedQty: n(qty.wastedQty),
      rejectedQty: n(qty.rejectedQty),
      sampleQty: n(qty.sampleQty),
      returnedQty: n(qty.returnedQty),
      ...(n(qty.returnedQty) > 0 ? { destinationType: dayStoreId ? "DAY_STORE" : "WAREHOUSE", destDayStoreId: dayStoreId ?? undefined } : {}),
    };
    try {
      await record.mutateAsync(body);
      toast.success(n(qty.returnedQty) > 0 ? "Logged. The leftover stays in the Plant stock: send it back to the Day Store from Plant Stock." : "Logged.");
      setItemId("");
      setQty({ consumedQty: "", wastedQty: "", rejectedQty: "", sampleQty: "", returnedQty: "" });
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not log this usage");
    }
  }

  const field = (key: keyof typeof qty, label: string) => (
    <div>
      <label className="label">{label}</label>
      <input className="field !h-8 font-mono !text-xs" type="number" min="0" step="any" value={qty[key]} onChange={(e) => setQty((q) => ({ ...q, [key]: e.target.value }))} />
    </div>
  );

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        <div className="col-span-2">
          <label className="label">Material</label>
          <ItemPicker items={stock} value={itemId} onChange={setItemId} placeholder="— Select a material —" />
        </div>
        {field("consumedQty", "A · Production")}
        {field("wastedQty", "B · Wastage")}
        {field("rejectedQty", "C · Rejected")}
        {field("sampleQty", "D · Sample")}
      </div>
      <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-6">
        {field("returnedQty", "E · Leftover (stays in Plant stock)")}
        <div className="col-span-2 sm:col-span-5 sm:text-right">
          <button type="button" className="btn-primary btn-sm" disabled={record.isPending} onClick={save}>
            {record.isPending ? "Saving…" : "Save usage"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The product's other batches: planned, but not cleared for production yet (indent, batch number, Dispensing, Receive or Line Clearance still to do).
 * They are counted in "Batches" above but only the cleared ones have a row in the table, so this says where each of the others is.
 */
function PreparingBatches({ row }: { row: PlanBoardRow }) {
  const waiting = row.batches.filter((b) => b.status === "IN_PROGRESS" && b.prepStageId !== "READY");
  if (waiting.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-xl border border-dashed border-amber-300 bg-amber-50/40">
      <p className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
        {waiting.length} more batch{waiting.length === 1 ? " is" : "es are"} still being prepared. {waiting.length === 1 ? "It comes" : "They come"} to the table above once QA clears the line.
      </p>
      <table className="w-full whitespace-nowrap text-xs">
        <thead>
          <tr className="text-left text-micro font-bold uppercase tracking-wide text-slate-400">
            <th className="px-3 py-2">Batch</th>
            <th className="px-3 py-2 text-right">Quantity</th>
            <th className="px-3 py-2">Where it is now</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-amber-100">
          {waiting.map((b, i) => (
            <tr key={b.id}>
              <td className="px-3 py-2 font-bold text-slate-700">{b.batchNo ?? <span className="font-normal text-slate-400">No number yet (Batch {i + 1})</span>}</td>
              <td className="px-3 py-2 text-right font-mono text-slate-700">
                {fmtQty(b.plannedQty)} {row.unit}
              </td>
              <td className="px-3 py-2 text-slate-600">{PREP_STAGE_LABEL[b.prepStageId] ?? b.prepStageId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The product as a whole: how much of it is made so far, and every material added up over all its batches.
function ProductTotal({ row, columns }: { row: PlanBoardRow; columns: typeof UTILIZATION_COLUMNS[number][] }) {
  const run = row.run!;
  // Only what the batches used: the "not assigned" material is what the store gave the run, not yet booked to a batch (counting it too would double up).
  const total = sumMaterials(row.batches.map((b) => b.materials));
  const done = row.batches.filter((b) => b.status === "COMPLETED").length;
  const inputSum = row.batches.reduce((sum, b) => sum + (b.inputQty ?? 0), 0);
  const outputSum = row.batches.reduce((sum, b) => sum + (b.outputQty ?? 0), 0);
  const ready = row.batches.filter((b) => b.status === "IN_PROGRESS" && b.prepStageId === "READY").length;
  const preparing = row.batches.filter((b) => b.status === "IN_PROGRESS" && b.prepStageId !== "READY").length;
  const stat = (label: string, value: string, tone = "text-slate-800", sub?: string) => (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <p className="text-micro font-bold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`font-mono text-sm font-black ${tone}`}>{value}</p>
      {sub && <p className="font-sans text-micro font-semibold text-slate-400">{sub}</p>}
    </div>
  );

  function download() {
    const lines: Record<string, string | number>[] = [];
    for (const b of row.batches) {
      for (const m of b.materials) lines.push(utilizationLine(b.batchNo ?? b.id.slice(0, 8), b.status === "COMPLETED" ? "Completed" : "In Progress", b, m));
    }
    for (const m of row.unassigned) lines.push(utilizationLine("Not assigned", "", null, m));
    for (const m of total) lines.push({ ...utilizationLine("TOTAL", "", null, m), "Input qty": "", "Output qty": "", "Planned qty": "" });
    const ws = XLSX.utils.json_to_sheet(lines);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Utilization");
    XLSX.writeFile(wb, `Utilization - ${row.productName}.xlsx`);
  }

  return (
    <div className="space-y-2 rounded-xl border border-brand-100 bg-brand-50/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-black text-slate-700">{row.productName} · total so far</p>
        <button type="button" className="btn-ghost btn-sm" onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Excel
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {stat("Ordered", `${fmtQty(row.quantity)} ${row.unit}`)}
        {stat("Planned", `${fmtQty(run.plannedQty)} ${row.unit}`)}
        {stat("Made so far", `${fmtQty(run.combinedQty)} ${row.unit}`, "text-emerald-700")}
        {stat("Left to make", `${fmtQty(Math.max(0, run.plannedQty - run.combinedQty))} ${row.unit}`, "text-amber-700")}
        {stat("Batches", `${done} of ${row.batches.length} done`, "text-slate-800", run.batchFlow ? `${ready} in production · ${preparing} in preparation` : undefined)}
        {stat("Input → Output", `${fmtQty(inputSum)} → ${fmtQty(outputSum)}`)}
      </div>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <p className="border-b border-slate-100 bg-slate-50/80 px-3 py-1.5 text-micro font-bold uppercase tracking-wide text-slate-500">Material total (all batches)</p>
        <UtilizationTable materials={total} columns={columns} />
      </div>
    </div>
  );
}

function utilizationLine(batch: string, status: string, b: BoardBatch | null, m: BoardMaterial): Record<string, string | number> {
  return {
    Batch: batch,
    Status: status,
    "Planned qty": b?.plannedQty ?? "",
    "Input qty": b?.inputQty ?? "",
    "Output qty": b?.outputQty ?? "",
    Material: m.itemName,
    Unit: m.unit,
    "A · Production": q3(m.consumedQty),
    "B · Wastage": q3(m.wastedQty),
    "C · Rejected": q3(m.rejectedQty),
    "D · Sample": q3(m.sampleQty),
    "E · Return": q3(m.returnedQty),
    "Material Used": materialUsed(m),
    "Yield %": yieldPct(m) ?? "",
  };
}

// The Utilization sheet of one batch for one kind of material (RM at the Batch tile, PM at the Packaging tile): for every plan material what
// the Day Store gave the batch (Given), what Production logs (A used, B waste, C reject, D sample, E return) and the Difference (information
// only, never a rule). Materials outside the plan (extra) are listed apart. It is part of the batch: the end of the step stays shut until
// every plan material has its A.
export function UtilizationSheet({ row, batch, category }: { row: PlanBoardRow; batch: ProductionBatch; category: "RM" | "PM" }) {
  const { hasRole } = useAuth();
  const [logging, setLogging] = useState(false);
  const [pick, setPick] = useState<string | undefined>(undefined);
  const board = row.batches.find((b) => b.id === batch.id);
  const u = batch.utilization;
  const part = category === "RM" ? u : u?.pm;
  const planItems = (u?.items ?? []).filter((i) => i.category === category);
  const logged = (board?.materials ?? []).filter((m) => m.category === category);
  const loggedBy = new Map(logged.map((m) => [m.itemId, m]));
  const planIds = new Set(planItems.map((i) => i.itemId));
  const planRows = planItems.map((i) => ({ itemId: i.itemId, name: i.itemName, unit: i.unit, given: i.givenQty, m: loggedBy.get(i.itemId) ?? null }));
  const extraRows = logged.filter((m) => !planIds.has(m.itemId)).map((m) => ({ itemId: m.itemId, name: m.itemName, unit: m.unit, given: 0, m }));
  const canLog = !!row.plant && batch.status !== undefined && hasRole("PRODUCTION") && (category === "RM" ? batch.status === "IN_PROGRESS" : batch.currentStageId === "PACKAGING");
  const kindWord = category === "RM" ? "Production" : "Used";
  const opens = category === "RM" ? "End date & time, remarks and Mark Completed" : "Packaging status Completed, End date & time and remarks";

  const diff = (r: { given: number; unit: string; m: BoardMaterial | null }, inPlan: boolean) => {
    if (!r.m) return inPlan ? <span className="font-bold text-amber-700">Missing</span> : null;
    if (inPlan && r.given <= 0) return <span className="text-slate-300">—</span>;
    const net = r.m.consumedQty + r.m.wastedQty + r.m.rejectedQty + r.m.sampleQty + r.m.returnedQty;
    const d = q3(net - r.given);
    if (d > 0.0005) return <span className="font-bold text-amber-700">{inPlan ? `+${d} over plan` : `+${d} extra`}</span>;
    if (d < -0.0005) return <span className="text-slate-500">{-d} {r.unit} left</span>;
    return <span className="text-slate-400">balanced</span>;
  };
  const cell = (m: BoardMaterial | null, key: keyof BoardMaterial & ("consumedQty" | "wastedQty" | "rejectedQty" | "sampleQty" | "returnedQty")) => (
    <td key={key} className={`px-3 py-2 text-right font-mono ${m && m[key] ? (key === "consumedQty" ? "font-bold text-slate-900" : "text-slate-700") : "text-slate-300"}`}>
      {m && m[key] ? q3(m[key]) : "—"}
    </td>
  );
  const table = (rows: typeof planRows, inPlan: boolean) => (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full whitespace-nowrap text-xs">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2">Material</th>
            <th className="px-3 py-2 text-right">Given</th>
            <th className="px-3 py-2 text-right">A · {kindWord}</th>
            <th className="px-3 py-2 text-right">B · Waste</th>
            <th className="px-3 py-2 text-right">C · Reject</th>
            <th className="px-3 py-2 text-right">D · Sample</th>
            <th className="px-3 py-2 text-right" title="Leftover: stays in the Plant stock until it is sent back to the Day Store">E · Leftover</th>
            <th className="px-3 py-2 text-right">Difference</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.itemId} className={inPlan && !r.m ? "bg-amber-50/60" : ""}>
              <td className="px-3 py-2 font-bold text-slate-700">
                {r.name}
                {!inPlan && <span className="ml-1.5 rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-micro font-bold text-rose-700">Not in plan</span>}
              </td>
              <td className="px-3 py-2 text-right font-mono text-slate-500">{r.given > 0 ? `${q3(r.given)} ${r.unit}` : "—"}</td>
              {cell(r.m, "consumedQty")}
              {cell(r.m, "wastedQty")}
              {cell(r.m, "rejectedQty")}
              {cell(r.m, "sampleQty")}
              {cell(r.m, "returnedQty")}
              <td className="px-3 py-2 text-right">{diff(r, inPlan)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {part && part.required > 0 ? (
          <p className={`text-xs font-bold ${part.complete ? "text-emerald-700" : "text-amber-700"}`}>
            {part.complete ? `${category} Utilization complete: ${opens} are open.` : `Fill the ${kindWord} quantity (A) for: ${part.missing.join(", ")}. ${opens} open after that.`}
          </p>
        ) : (
          <p className="text-xs text-slate-400">This batch's plan has no {category} material to account for.</p>
        )}
        {canLog && (
          <button type="button" className="inline-flex items-center gap-1 text-tiny font-bold text-brand-600 hover:underline" onClick={() => { setPick(undefined); setLogging((o) => !o); }}>
            <Plus className="h-3 w-3" strokeWidth={2.5} /> {logging ? "Close" : "Log usage"}
          </button>
        )}
      </div>
      {canLog && part && part.missing.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {part.missing.map((name) => {
            const i = planItems.find((x) => x.itemName === name);
            return (
              <button key={name} type="button" disabled={!i} onClick={() => { setPick(i?.itemId); setLogging(true); }} className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-tiny font-bold text-amber-700 hover:bg-amber-100 disabled:opacity-60" title="Log this material's usage on the batch">
                + {name}
              </button>
            );
          })}
        </div>
      )}
      {logging && canLog && <UsageForm key={pick ?? "any"} row={row} batchId={batch.id} initialItemId={pick} planItems={planItems} onDone={() => { setLogging(false); setPick(undefined); }} />}
      <div className="space-y-1.5">
        <p className="text-micro font-bold uppercase tracking-wide text-brand-700">Plan material, {category} (given at Dispensing)</p>
        {planRows.length > 0 ? table(planRows, true) : <p className="text-xs text-slate-400">Nothing in the plan.</p>}
      </div>
      {extraRows.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-micro font-bold uppercase tracking-wide text-orange-700">Extra material (outside the plan)</p>
          {table(extraRows, false)}
        </div>
      )}
    </div>
  );
}
