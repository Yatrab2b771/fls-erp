import { useRef, useState } from "react";
import { Copy, FilePlus, Upload } from "lucide-react";
import { ApiError } from "../lib/api";
import { useCopyBomSlot, useSaveBomSlot, type BomSlotDetail, type SlotName } from "../lib/bomSlotHooks";
import { normName, parseBomWorkbook, type ParsedPmProduct, type ParsedRmRecipe } from "../lib/bomTemplateImport";
import { useToast } from "./Toast";

// The Display | V1 | V2 switcher of the RM BOM and Packaging BOM editors. The catalog's own BOM is the Display BOM (the default, what the customer
// is shown); V1 and V2 are R&D's two other versions of the same product, each with an RM recipe and a PM component list. Choosing V1 or V2 opens
// the same editor on that version: saving it never touches the catalog.

export type SlotChoice = "DISPLAY" | SlotName;
export type Half = "rm" | "pm";

export function SlotSwitcher({ value, onChange, detail, half }: { value: SlotChoice; onChange: (v: SlotChoice) => void; detail: BomSlotDetail | undefined; half: Half }) {
  const tab = (key: SlotChoice, label: string) => {
    const filled = key === "DISPLAY" ? true : !!detail?.slots[key]?.[half];
    const on = value === key;
    return (
      <button
        key={key}
        type="button"
        onClick={() => onChange(key)}
        className={`rounded-lg border px-3 py-1 text-xs font-bold ${on ? (key === "DISPLAY" ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-violet-300 bg-violet-50 text-violet-700") : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}
        title={key === "DISPLAY" ? "The catalog's own BOM: the default, shown to the customer" : filled ? `${key}: saved` : `${key}: empty`}
      >
        {label}
        {key !== "DISPLAY" && <span className={`ml-1.5 inline-block h-1.5 w-1.5 rounded-full ${filled ? "bg-violet-500" : "bg-slate-300"}`} />}
      </button>
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-micro font-bold uppercase tracking-wide text-slate-400">Version</span>
      {tab("DISPLAY", "Display BOM")}
      {tab("V1", "V1")}
      {tab("V2", "V2")}
    </div>
  );
}

/**
 * "Load from Excel" for a V1 / V2: reads the company's own BOM sheet (the same files the catalog upload takes) and puts its rows into the editor
 * below. Nothing is saved until the editor's own Save, and the catalog is never touched. A file with several sheets loads the one named like the
 * product (or the first).
 */
export function SlotExcelLoad({ mode, productName, onLoaded }: { mode: Half; productName: string; onLoaded: (sheet: ParsedPmProduct | ParsedRmRecipe) => void }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    try {
      const parsed = parseBomWorkbook(await file.arrayBuffer());
      const sheets = mode === "pm" ? parsed.pm : parsed.rm;
      if (sheets.length === 0) {
        toast.error(mode === "pm" ? "No packaging BOM sheet found in this file." : "No RM BOM sheet found in this file.");
        return;
      }
      const named = sheets.find((s) => normName(s.productName) === normName(productName));
      const chosen = named ?? sheets[0]!;
      onLoaded(chosen);
      toast.success(sheets.length > 1 && !named ? `${sheets.length} sheets in the file: loaded "${chosen.sheet}" (${chosen.productName}). Check it, then Save.` : `Loaded "${chosen.sheet}". Check it, then Save.`);
    } catch {
      toast.error("Could not read this file. Please upload the .xlsx BOM sheet.");
    } finally {
      if (ref.current) ref.current.value = "";
    }
  }

  return (
    <label className="btn-ghost btn-sm cursor-pointer">
      <Upload className="h-3 w-3" strokeWidth={2.5} /> Load from Excel
      <input ref={ref} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
    </label>
  );
}

/** The note shown above the editor while a V1 / V2 is being edited. */
export function SlotBanner({ slot, half }: { slot: SlotName; half: Half }) {
  return (
    <p className="rounded-lg border border-violet-200 bg-violet-50/70 px-3 py-2 text-xs text-violet-800">
      You are editing <b>{slot}</b>: its own {half === "rm" ? "RM recipe" : "PM components"}. Save writes to {slot} only; the Display BOM (what the customer sees) is not changed.
    </p>
  );
}

/** V1 / V2 has no RM recipe (or PM components) yet: copy it from the Display BOM or start empty. */
export function SlotStart({ detail, slot, half, canEdit, onStartEmpty }: { detail: BomSlotDetail; slot: SlotName; half: Half; canEdit: boolean; onStartEmpty: () => void }) {
  const toast = useToast();
  const copy = useCopyBomSlot();
  const save = useSaveBomSlot();
  const [busy, setBusy] = useState(false);
  const exists = !!detail.slots[slot];
  const displayHalf = detail.display[half];
  const ref = { slot, customerId: detail.customerId, productName: detail.productName };
  const label = half === "rm" ? "RM recipe" : "PM components";

  async function copyIt() {
    setBusy(true);
    try {
      // A brand-new version starts as a copy of the whole Display BOM; one that exists keeps its other half and gets only this one.
      if (!exists) await copy.mutateAsync(ref);
      else await save.mutateAsync({ ...ref, [half]: displayHalf });
      toast.success(`${slot} now has a copy of the Display BOM's ${label}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not copy");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-dashed border-violet-300 bg-violet-50/30 p-5">
      <p className="text-sm font-bold text-slate-800">{slot} has no {label} yet.</p>
      <p className="text-xs text-slate-500">A version is for the day a plan has to be made with other material (urgent production, a change during manufacturing). Start from the Display BOM and change what has to be different.</p>
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary btn-sm" disabled={busy || !displayHalf && exists || (!exists && !detail.display.rm && !detail.display.pm)} onClick={copyIt}>
            <Copy className="h-3.5 w-3.5" strokeWidth={2.25} /> {busy ? "Copying…" : exists ? `Copy the Display ${label}` : "Start as a copy of Display (RM + PM)"}
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={onStartEmpty}>
            <FilePlus className="h-3.5 w-3.5" strokeWidth={2.25} /> Start empty
          </button>
        </div>
      ) : (
        <p className="text-micro text-slate-400">Only R&D can make a version.</p>
      )}
    </div>
  );
}
