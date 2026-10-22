import { useState } from "react";
import { Plus, RotateCcw, Save, X } from "lucide-react";
import { ApiError } from "../lib/api";
import { usePlantStock, useSaveUtilization } from "../lib/hooks";
import type { ProductionBatch } from "../lib/types";
import { fmtQty } from "../lib/format";
import { useToast } from "./Toast";

// The Utilization of a whole batch. Production gives the four numbers of the batch (Produced, Waste, Reject, Sample); every plan material's
// row fills itself from them (that material's share of the batch plan x what was entered). Each cell can still be edited and extra materials
// added BEFORE saving; the totals, the Difference and the yield follow whatever is in the table. RM is filled while the batch is in production (before its end time); a batch that reached Packaging without it fills it there
// starts; PM after Packaging. Both can be edited again until the batch is sent to QA.

type Cells = { a: string; b: string; c: string; d: string };
type Row = Cells & { itemId: string; name: string; unit: string; given: number; required: number; inPlan: boolean; edited: boolean };
type Top = { produced: string; waste: string; reject: string; sample: string };

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: string) => Number(v) || 0;
const show = (n: number) => (n > 0 ? String(r3(n)) : "");
const FILLED_CLOSE = 0.0015;

function worked(required: number, basis: number, top: Top): Cells {
  const produced = num(top.produced);
  if (!(produced > 0) || !(basis > 0)) return { a: "", b: "", c: "", d: "" };
  const share = required / basis;
  return { a: show(share * produced), b: show(share * num(top.waste)), c: show(share * num(top.reject)), d: show(share * num(top.sample)) };
}

export function UtilizationFillForm({ batch, category, plantId, canEdit }: { batch: ProductionBatch; category: "RM" | "PM"; plantId: string | undefined; canEdit: boolean }) {
  const toast = useToast();
  const save = useSaveUtilization();
  const util = batch.utilization!;
  const isRm = category === "RM";
  const planItems = util.items.filter((i) => i.category === category);
  // What the plan's quantities are measured against: the batch's quantity (RM, in the order's unit) or the finished packs it makes (PM, counts).
  const basis = isRm ? batch.plannedQty : util.pmPacks ?? batch.plannedQty;
  const unitLabel = isRm ? batch.preProduction.purchaseOrderItem.unit : "packs";
  const part = isRm ? util : util.pm;
  const sheet = util.sheets[category];
  const entries = util.entries.filter((e) => e.category === category);

  const [top, setTop] = useState<Top>({ produced: show(sheet?.producedQty ?? 0), waste: show(sheet?.wasteQty ?? 0), reject: show(sheet?.rejectQty ?? 0), sample: show(sheet?.sampleQty ?? 0) });
  const [rows, setRows] = useState<Row[]>(() => {
    const t: Top = { produced: show(sheet?.producedQty ?? 0), waste: show(sheet?.wasteQty ?? 0), reject: show(sheet?.rejectQty ?? 0), sample: show(sheet?.sampleQty ?? 0) };
    const entryOf = (id: string) => entries.find((e) => e.itemId === id);
    const planRows = planItems.map((i): Row => {
      const e = entryOf(i.itemId);
      const auto = worked(i.requiredQty, basis, t);
      if (!e) return { itemId: i.itemId, name: i.itemName, unit: i.unit, given: i.givenQty, required: i.requiredQty, inPlan: true, edited: false, ...auto };
      const cells: Cells = { a: show(e.consumedQty), b: show(e.wastedQty), c: show(e.rejectedQty), d: show(e.sampleQty) };
      const differs = (x: string, y: string) => Math.abs(num(x) - num(y)) > FILLED_CLOSE;
      return { itemId: i.itemId, name: i.itemName, unit: i.unit, given: i.givenQty, required: i.requiredQty, inPlan: true, edited: sheet ? differs(cells.a, auto.a) || differs(cells.b, auto.b) || differs(cells.c, auto.c) || differs(cells.d, auto.d) : true, ...cells };
    });
    const planIds = new Set(planItems.map((i) => i.itemId));
    // Extra material: what was saved on the batch, plus what the Store issued for it as an extra request (listed even before any of it is used)
    const askedExtra = util.extraItems.filter((x) => x.category === category && !planIds.has(x.itemId));
    const givenExtra = (id: string) => askedExtra.find((x) => x.itemId === id)?.givenQty ?? 0;
    const extraRows = entries.filter((e) => !planIds.has(e.itemId)).map((e): Row => ({ itemId: e.itemId, name: e.itemName, unit: e.unit, given: givenExtra(e.itemId), required: 0, inPlan: false, edited: true, a: show(e.consumedQty), b: show(e.wastedQty), c: show(e.rejectedQty), d: show(e.sampleQty) }));
    const savedIds = new Set(entries.map((e) => e.itemId));
    const issuedOnly = askedExtra.filter((x) => !savedIds.has(x.itemId)).map((x): Row => ({ itemId: x.itemId, name: x.itemName, unit: x.unit, given: x.givenQty, required: 0, inPlan: false, edited: true, a: "", b: "", c: "", d: "" }));
    return [...planRows, ...extraRows, ...issuedOnly];
  });
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: plantStock } = usePlantStock(canEdit ? plantId : undefined, category);

  const setTopField = (key: keyof Top) => (e: { target: { value: string } }) => {
    const next = { ...top, [key]: e.target.value };
    setTop(next);
    setRows((cur) => cur.map((r) => (r.inPlan && !r.edited ? { ...r, ...worked(r.required, basis, next) } : r)));
  };
  const setCell = (itemId: string, key: keyof Cells) => (e: { target: { value: string } }) => setRows((cur) => cur.map((r) => (r.itemId === itemId ? { ...r, [key]: e.target.value, edited: true } : r)));
  const recalcAll = () => setRows((cur) => cur.map((r) => (r.inPlan ? { ...r, edited: false, ...worked(r.required, basis, top) } : r)));
  const hasEdited = rows.some((r) => r.inPlan && r.edited);

  const addable = (plantStock?.stock ?? []).filter((l) => !rows.some((r) => r.itemId === l.item.id));
  function addExtra() {
    const line = addable.find((l) => l.item.id === pick);
    if (!line) return;
    setRows((cur) => [...cur, { itemId: line.item.id, name: line.item.name, unit: line.item.unit ?? (isRm ? "Kg" : "Count"), given: 0, required: 0, inPlan: false, edited: true, a: "", b: "", c: "", d: "" }]);
    setPick("");
  }

  const total = (key: keyof Cells) => r3(rows.reduce((t, r) => t + num(r[key]), 0));
  const produced = num(top.produced);
  const accounted = produced + num(top.waste) + num(top.reject) + num(top.sample);
  const diffOf = (r: Row) => {
    if (r.given <= 0) return null;
    return r3(r.given - (num(r.a) + num(r.b) + num(r.c) + num(r.d)));
  };

  async function submit() {
    setError(null);
    if (!(produced > 0)) return setError(`Enter how much was ${isRm ? "produced" : "packed"} for the batch.`);
    const noA = rows.filter((r) => r.inPlan && !(num(r.a) > 0));
    if (noA.length > 0) return setError(`Every plan material needs its Used quantity (A): ${noA.slice(0, 4).map((r) => r.name).join(", ")}${noA.length > 4 ? ", ..." : ""}.`);
    try {
      await save.mutateAsync({
        id: batch.id,
        category,
        producedQty: produced,
        wasteQty: num(top.waste),
        rejectQty: num(top.reject),
        sampleQty: num(top.sample),
        lines: rows.map((r) => ({ itemId: r.itemId, consumedQty: num(r.a), wastedQty: num(r.b), rejectedQty: num(r.c), sampleQty: num(r.d) })),
      });
      toast.success(`${category} Utilization saved.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  const cellInput = (r: Row, key: keyof Cells) => (
    <input
      className={`field !h-7 !w-24 !px-2 !py-0 text-right font-mono !text-xs ${r.inPlan && key === "a" && !(num(r.a) > 0) && canEdit ? "!border-amber-300" : ""}`}
      type="number"
      min="0"
      step="any"
      value={r[key]}
      disabled={!canEdit}
      onChange={setCell(r.itemId, key)}
    />
  );
  const topField = (key: keyof Top, label: string) => (
    <div>
      <label className="mb-0.5 block text-micro text-slate-400">{label}</label>
      <input className="field !h-8 !w-32 !py-0 font-mono !text-xs" type="number" min="0" step="any" value={top[key]} disabled={!canEdit} onChange={setTopField(key)} />
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`text-xs font-bold ${part.complete && sheet ? "text-emerald-700" : "text-amber-700"}`}>
          {part.complete && sheet
            ? `${category} Utilization is saved. ${isRm ? "The end date and time, status, remarks and Send to Packaging are open now." : "Packaging status Completed and Handover are open now."} You can edit it until the batch is handed over to QA.`
            : isRm
              ? "Enter what the whole batch produced, wasted, rejected and gave as sample. Every material fills itself from the plan; change anything or add an extra material, then Save. The end date and time open after this."
              : "Enter the packs made, wasted, rejected and given as sample. Every packaging material fills itself from the plan; change anything or add an extra material, then Save."}
        </p>
        {canEdit && hasEdited && (
          <button type="button" className="inline-flex items-center gap-1 text-tiny font-bold text-brand-600 hover:underline" onClick={recalcAll} title="Work every plan material out again from the four numbers above (your edited cells are replaced)">
            <RotateCcw className="h-3 w-3" strokeWidth={2.5} /> Recalculate all rows
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {topField("produced", `${isRm ? "Produced" : "Packed"} (${unitLabel})`)}
        {topField("waste", `Waste (${unitLabel})`)}
        {topField("reject", `Reject (${unitLabel})`)}
        {topField("sample", `Sample (${unitLabel})`)}
        <div className="pb-1.5 text-micro text-slate-500">
          {produced > 0 && basis > 0 ? (
            <>
              <span className="font-bold text-slate-700">Yield {r3((produced / basis) * 100)}%</span> of {fmtQty(basis)} {unitLabel} planned
              {accounted > basis + 1e-6 && <span className="ml-2 font-bold text-amber-700">Total {r3(accounted)} is more than the plan</span>}
            </>
          ) : (
            <>Plan: {fmtQty(basis)} {unitLabel}</>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Material</th>
              <th className="px-3 py-2 text-right">Given</th>
              <th className="px-3 py-2 text-right">A · Used</th>
              <th className="px-3 py-2 text-right">B · Waste</th>
              <th className="px-3 py-2 text-right">C · Reject</th>
              <th className="px-3 py-2 text-right">D · Sample</th>
              <th className="px-3 py-2 text-right">Difference</th>
              {canEdit && <th className="w-8 px-2 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const diff = diffOf(r);
              return (
                <tr key={r.itemId} className={r.inPlan ? "" : "bg-orange-50/40"}>
                  <td className="px-3 py-1.5 font-bold text-slate-700">
                    {r.name}
                    {!r.inPlan && <span className="ml-1.5 rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-micro font-bold text-rose-700">{r.given > 0 ? "Extra · asked for this batch" : "Extra · not in plan"}</span>}
                    {r.inPlan && r.edited && <span className="ml-1.5 text-micro font-normal text-slate-400">edited</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-500">{r.given > 0 ? `${r3(r.given)} ${r.unit}` : "—"}</td>
                  <td className="px-3 py-1.5 text-right">{cellInput(r, "a")}</td>
                  <td className="px-3 py-1.5 text-right">{cellInput(r, "b")}</td>
                  <td className="px-3 py-1.5 text-right">{cellInput(r, "c")}</td>
                  <td className="px-3 py-1.5 text-right">{cellInput(r, "d")}</td>
                  <td className="px-3 py-1.5 text-right">
                    {diff === null ? (
                      <span className="text-slate-300">—</span>
                    ) : Math.abs(diff) <= 0.0005 ? (
                      <span className="text-slate-400">balanced</span>
                    ) : diff < 0 ? (
                      <span className="font-bold text-amber-700">+{r3(-diff)} over given</span>
                    ) : (
                      <span className="text-slate-500">{diff} {r.unit} left</span>
                    )}
                  </td>
                  {canEdit && (
                    <td className="px-2 py-1.5 text-right">
                      {!r.inPlan && (
                        <button type="button" className="text-slate-400 hover:text-rose-600" title="Take this extra material out" onClick={() => setRows((cur) => cur.filter((x) => x.itemId !== r.itemId))}>
                          <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200 bg-slate-50/80 font-mono font-bold text-slate-700">
              <td className="px-3 py-2 font-sans text-micro uppercase tracking-wide text-slate-500">Total</td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2 text-right">{total("a")}</td>
              <td className="px-3 py-2 text-right">{total("b")}</td>
              <td className="px-3 py-2 text-right">{total("c")}</td>
              <td className="px-3 py-2 text-right">{total("d")}</td>
              <td className="px-3 py-2" />
              {canEdit && <td />}
            </tr>
          </tfoot>
        </table>
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex items-end gap-2">
            <div>
              <label className="mb-0.5 block text-micro text-slate-400">Add extra material (used, but not in the plan)</label>
              <select className="field !h-8 !w-72 !py-0 !text-xs" value={pick} onChange={(e) => setPick(e.target.value)} disabled={!plantId}>
                <option value="">{plantId ? "Select a material the Plant holds…" : "Plant not known"}</option>
                {addable.map((l) => (
                  <option key={l.item.id} value={l.item.id}>
                    {l.item.name} ({l.onHand} {l.item.unit ?? ""} on hand)
                  </option>
                ))}
              </select>
            </div>
            <button type="button" className="btn-ghost btn-sm" disabled={!pick} onClick={addExtra}>
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Add
            </button>
          </div>
          <button type="button" className="btn-primary btn-sm" disabled={save.isPending} onClick={submit}>
            <Save className="h-3.5 w-3.5" strokeWidth={2.5} /> {save.isPending ? "Saving…" : sheet ? "Save changes" : "Save"}
          </button>
        </div>
      )}
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
    </div>
  );
}
