import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Plus, Trash2, Wrench } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { usePlantStock } from "../lib/hooks";
import { useAddReworkMaterial, useCompleteRework, useRemoveRework, useRemoveReworkMaterial, useSaveReworkSheet, type Rework } from "../lib/reworkHooks";
import { fmtQty } from "../lib/format";
import { AgingCell } from "./AgingCell";
import { CustomerName } from "./CustomerName";
import { ItemPicker } from "./ItemPicker";
import { useToast } from "./Toast";

// The reworks in New Plan: goods a customer returned that QA wants reprocessed. Each is a row with a "Rework" tag and a sub-number of the original
// batch (FLS-26-0006-R1); it opens a sheet like a batch's (shift, manpower, start, material used, end, how much came out). A rework is not part of
// the product's order: it does not change planned / made / shortfall.

const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const STATUS_PILL: Record<Rework["status"], { text: string; tone: string }> = {
  PLANNED: { text: "Rework · not started", tone: "border-amber-300 bg-amber-100 text-amber-800" },
  IN_PROGRESS: { text: "Rework · in progress", tone: "border-violet-300 bg-violet-100 text-violet-800" },
  COMPLETED: { text: "Rework · done", tone: "border-emerald-300 bg-emerald-100 text-emerald-800" },
};

/** The open reworks as table rows, in the same columns as New Plan's list. */
export function ReworkRows({ rows, showPlant, columns }: { rows: Rework[]; showPlant: boolean; columns: number }) {
  const { hasRole } = useAuth();
  const canAct = hasRole("PRODUCTION", "ADMIN");
  const toast = useToast();
  const remove = useRemoveRework();
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      {rows.map((r) => {
        const open = openId === r.id;
        const st = STATUS_PILL[r.status];
        return (
          <Fragment key={r.id}>
            <tr className={`bg-amber-50/50 transition hover:bg-amber-50 ${open ? "bg-amber-50" : ""}`}>
              <td className="px-4 py-3 font-semibold text-slate-700">{r.poNumber ?? "—"}</td>
              <td className="px-4 py-3">
                <span className={`pill ${st.tone}`}>{st.text}</span>
              </td>
              <td className="px-4 py-3 text-slate-600"><CustomerName name={r.customerName} /></td>
              <td className="whitespace-normal px-4 py-3 font-bold text-slate-800">
                <span className="mr-2 inline-flex items-center gap-1 rounded-md bg-amber-500 px-1.5 py-0.5 text-micro font-black uppercase tracking-wide text-white">
                  <Wrench className="h-3 w-3" strokeWidth={2.5} /> Rework
                </span>
                {r.productName}
                <span className="mt-0.5 block font-mono text-micro font-bold text-amber-700">Batch {r.reworkNo}</span>
                <span className="block text-micro font-normal text-slate-500">
                  Rework of {r.batchNo ?? "the batch"} · {r.returnReason}
                </span>
              </td>
              <td className="px-4 py-3 text-slate-600">{r.productCategory ?? "—"}</td>
              <td className="px-4 py-3 text-right font-mono text-slate-800">
                {fmtQty(r.quantity)} {r.unit}
              </td>
              {showPlant && <td className="px-4 py-3">{r.plantName ? <span className="font-semibold text-slate-700">{r.plantName}</span> : <span className="text-rose-600">—</span>}</td>}
              <td className="px-4 py-3">
                <AgingCell since={r.createdAt} />
              </td>
              <td className="px-4 py-3 text-slate-400">—</td>
              <td className="px-4 py-3">
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : r.id)}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-tiny font-bold transition ${open ? "border-amber-400 bg-amber-100 text-amber-800" : "border-amber-300 bg-white text-amber-800 hover:bg-amber-50"}`}
                >
                  Rework sheet <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                </button>
              </td>
              {canAct && (
                <td className="px-4 py-3 text-right">
                  {r.status === "PLANNED" && r.materials.length === 0 ? (
                    <button
                      type="button"
                      className="btn-ghost btn-sm text-rose-700"
                      disabled={remove.isPending}
                      title="Take it out of New Plan: its quantity can be sent again"
                      onClick={() => remove.mutate({ id: r.id }, { onSuccess: () => toast.success(`${r.reworkNo} taken out of New Plan.`), onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not do this") })}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </button>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
              )}
            </tr>
            {open && (
              <tr className="bg-amber-50/40">
                <td colSpan={columns} className="whitespace-normal px-4 py-4">
                  <ReworkSheet r={r} canAct={canAct} />
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function ReworkSheet({ r, canAct }: { r: Rework; canAct: boolean }) {
  const toast = useToast();
  const save = useSaveReworkSheet();
  const addMat = useAddReworkMaterial();
  const delMat = useRemoveReworkMaterial();
  const complete = useCompleteRework();
  const { data: plantStock } = usePlantStock(r.plantId ?? undefined);
  const [shift, setShift] = useState<string>(r.shift ?? "");
  const [manpower, setManpower] = useState(r.manpowerCount ? String(r.manpowerCount) : "");
  const [startAt, setStartAt] = useState(toLocalInput(r.startAt));
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState("");
  const [endAt, setEndAt] = useState(toLocalInput(r.endAt));
  const [output, setOutput] = useState("");
  const [note, setNote] = useState(r.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : "Could not save");
  const startSaved = !!r.shift && !!r.manpowerCount && !!r.startAt;
  const stock = (plantStock?.stock ?? []).map((l) => ({ id: l.item.id, name: `${l.item.name} (${fmtQty(l.onHand)} ${l.item.unit ?? ""} at the Plant)`, code: l.item.code }));

  async function saveStart() {
    setError(null);
    try {
      await save.mutateAsync({ id: r.id, shift: shift as "Day" | "Night", manpowerCount: Number(manpower), startAt: new Date(startAt).toISOString() });
      toast.success("Start saved.");
    } catch (err) {
      fail(err);
    }
  }
  async function addMaterial() {
    setError(null);
    try {
      await addMat.mutateAsync({ id: r.id, itemId, quantity: Number(qty) });
      setItemId("");
      setQty("");
    } catch (err) {
      fail(err);
    }
  }
  async function finish() {
    setError(null);
    try {
      if (endAt) await save.mutateAsync({ id: r.id, endAt: new Date(endAt).toISOString() });
      const res = await complete.mutateAsync({ id: r.id, endAt: new Date(endAt).toISOString(), outputQty: Number(output), note: note.trim() || undefined });
      toast.success(res.sentToQa ? `${r.reworkNo} is done. The goods go back to QA.` : `${r.reworkNo} is done.`);
    } catch (err) {
      fail(err);
    }
  }

  const locked = !canAct;
  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-600">
        <b>QA asked for:</b> {r.qaNote ?? "rework"} · {fmtQty(r.quantity)} {r.unit} of batch <b>{r.batchNo ?? "—"}</b> ({r.customerName}, {r.returnReason}).
      </p>

      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className="label">Shift</label>
          <select className="field" disabled={locked} value={shift} onChange={(e) => setShift(e.target.value)}>
            <option value="">—</option>
            <option value="Day">Day</option>
            <option value="Night">Night</option>
          </select>
        </div>
        <div>
          <label className="label">Manpower</label>
          <input className="field font-mono" type="number" min="1" disabled={locked} value={manpower} onChange={(e) => setManpower(e.target.value)} />
        </div>
        <div>
          <label className="label">Start date &amp; time</label>
          <input className="field" type="datetime-local" disabled={locked} value={startAt} onChange={(e) => setStartAt(e.target.value)} />
        </div>
        <div className="flex items-end">
          <button type="button" className="btn-primary btn-sm" disabled={locked || !shift || !(Number(manpower) > 0) || !startAt || save.isPending} onClick={saveStart}>
            {startSaved ? "Update start" : "Save start"}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <p className="label">Material used (optional: leave empty if the rework needs none)</p>
        {r.materials.length > 0 && (
          <table className="mb-2 w-full text-xs">
            <tbody className="divide-y divide-slate-100">
              {r.materials.map((m) => (
                <tr key={m.id}>
                  <td className="py-1.5 font-semibold text-slate-700">{m.itemName}</td>
                  <td className="py-1.5 text-right font-mono">
                    {fmtQty(m.quantity)} {m.unit}
                  </td>
                  <td className="py-1.5 text-right">
                    {!locked && (
                      <button type="button" className="text-rose-500 hover:text-rose-700" title="Take it back into the Plant's stock" onClick={() => delMat.mutate({ id: r.id, lineId: m.id }, { onError: fail })}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!locked && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[16rem] flex-1">
              <ItemPicker items={stock} value={itemId} onChange={setItemId} placeholder="— Material from the Plant's stock —" />
            </div>
            <div className="w-32">
              <input className="field font-mono" type="number" min="0" step="any" placeholder="Quantity" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <button type="button" className="btn-ghost btn-sm" disabled={!itemId || !(Number(qty) > 0) || addMat.isPending} onClick={addMaterial}>
              <Plus className="h-3.5 w-3.5" /> Add
            </button>
          </div>
        )}
        <p className="mt-2 text-micro text-slate-400">
          It comes out of the Plant's free stock. Short of something?{" "}
          <Link to="/extra-material" className="font-bold text-brand-700 hover:underline">
            Request extra material
          </Link>{" "}
          (write “Rework {r.reworkNo}” as the reason): the Store gives what it has, then asks the Warehouse, and PPIC only when the Warehouse is short too.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className="label">End date &amp; time</label>
          <input className="field" type="datetime-local" disabled={locked || !startSaved} value={endAt} onChange={(e) => setEndAt(e.target.value)} />
        </div>
        <div>
          <label className="label">
            How much came out? (max {fmtQty(r.quantity)} {r.unit})
          </label>
          <input className="field font-mono" type="number" min="0" step="any" disabled={locked || !startSaved} value={output} onChange={(e) => setOutput(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label">What was done / what was lost</label>
          <input className="field" disabled={locked || !startSaved} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. re-sieved and re-packed, 1 Kg lost in sieving" />
        </div>
      </div>
      {!startSaved && <p className="text-micro text-slate-400">Fill and save the start (shift, manpower, start date and time) first.</p>}
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      <div className="flex justify-end">
        <button type="button" className="btn-primary btn-sm" disabled={locked || !startSaved || !endAt || output === "" || Number(output) < 0 || Number(output) > r.quantity + 1e-9 || complete.isPending} onClick={finish}>
          {complete.isPending ? "Saving…" : "Mark Completed"}
        </button>
      </div>
    </div>
  );
}
