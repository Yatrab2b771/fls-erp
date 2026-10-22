import { useState } from "react";
import { LEAD_SOURCES, useLeadOptions } from "../lib/leadHooks";

// The chip pickers a lead uses: several at a time (customer type, product format, powder type) or one at a time.

export function ChipMulti({ options, value, onChange, disabled, small }: { options: readonly string[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; small?: boolean }) {
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o]);
  // "Others" opens a box to type a name that is not in the list: each name added becomes a chip of its own (as many as needed), and joins the
  // list for everyone once the lead is saved. "Others" itself stays selected only while nothing has been typed.
  const hasOthers = options.includes("Others");
  const listed = options.filter((o) => o !== "Others");
  const typed = value.filter((v) => v !== "Others" && !listed.includes(v)); // chosen, but not in the list yet
  const [open, setOpen] = useState(() => value.includes("Others"));
  const [text, setText] = useState("");
  function toggleOthers() {
    if (open) {
      setOpen(false);
      onChange(value.filter((v) => v !== "Others"));
    } else {
      setOpen(true);
      if (typed.length === 0 && !value.includes("Others")) onChange([...value, "Others"]);
    }
  }
  function add() {
    const name = text.trim().replace(/\s+/g, " ");
    if (name.length < 2) return;
    const same = (a: string) => a.toLowerCase() === name.toLowerCase();
    const pick = listed.find(same) ?? typed.find(same) ?? name.charAt(0).toUpperCase() + name.slice(1);
    onChange([...value.filter((v) => v !== "Others" && v !== pick), pick]);
    setText("");
  }
  return (
    <div>
    <div className="flex flex-wrap gap-1.5">
      {[...listed, ...typed, ...(hasOthers ? ["Others"] : [])].map((o) => {
        const isOthers = hasOthers && o === "Others";
        const on = isOthers ? open : value.includes(o);
        return (
          <button
            key={o}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => (isOthers ? toggleOthers() : toggle(o))}
            className={`rounded-full border font-bold transition ${small ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-xs"} ${on ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"} ${disabled ? "cursor-default opacity-80" : ""}`}
          >
            {on && "✓ "}
            {o}
          </button>
        );
      })}
    </div>
    {hasOthers && open && !disabled && (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          className="field !h-8 !w-64 !py-0 text-xs"
          placeholder="Type the name, then Add (as many as you need)"
          maxLength={40}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn-primary btn-sm" disabled={text.trim().length < 2} onClick={add}>
          Add
        </button>
      </div>
    )}
    </div>
  );
}

/** Customer type, product formats and (only when Powder is chosen) its powder types, as one block. */
export function LeadKindFields({
  customerTypes,
  productFormats,
  powderTypes,
  onChange,
  disabled,
}: {
  customerTypes: string[];
  productFormats: string[];
  powderTypes: string[];
  onChange: (next: { customerTypes: string[]; productFormats: string[]; powderTypes: string[] }) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<{ customerTypes: string[]; productFormats: string[]; powderTypes: string[] }>) => onChange({ customerTypes, productFormats, powderTypes, ...patch });
  const lists = useLeadOptions();
  const hasPowder = productFormats.includes("Powder");
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-700">
          Customer type <span className="font-medium text-slate-400">· select all that apply</span>
        </p>
        <ChipMulti options={lists.customerTypes} value={customerTypes} onChange={(v) => set({ customerTypes: v })} disabled={disabled} />
      </div>
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-700">
          Product formats <span className="font-medium text-slate-400">· select all that apply</span>
        </p>
        <ChipMulti options={lists.productFormats} value={productFormats} onChange={(v) => set({ productFormats: v, powderTypes: v.includes("Powder") ? powderTypes : [] })} disabled={disabled} />
        {hasPowder && (
          <div className="mt-2 rounded-xl border border-dashed border-brand-300 bg-brand-50/40 px-3 py-2.5">
            <p className="mb-1.5 text-xs font-bold text-brand-800">
              Powder type <span className="font-medium">· only for Powder</span>
            </p>
            <ChipMulti options={lists.powderTypes} value={powderTypes} onChange={(v) => set({ powderTypes: v })} disabled={disabled} small />
          </div>
        )}
      </div>
    </div>
  );
}

export function LeadSourceSelect({ value, onChange, disabled }: { value: string | null; onChange: (v: string | null) => void; disabled?: boolean }) {
  return (
    <select className="field" value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Not set</option>
      {LEAD_SOURCES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
