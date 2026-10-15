import { useState } from "react";
import { DropdownTrigger, FilterControl, PanelFooter, summarize, useDismiss } from "./MultiSelectDropdown";

const TYPES = ["RM", "PM"] as const;
export interface MaterialGroup {
  status: string;
  label: string;
  tone: string;
}

// Material Planning's groups. Another tile can pass its own (Material Received uses "Still to come" / "Received").
const DEFAULT_GROUPS: MaterialGroup[] = [
  { status: "SHORT", label: "Short", tone: "text-rose-700" },
  { status: "COVERED", label: "Covered", tone: "text-emerald-700" },
];

/** "SHORT:RM" -> "Short · RM" (the chip / button text). */
export function formatMaterialPick(value: string, groups: MaterialGroup[] = DEFAULT_GROUPS): string {
  const [status, type] = value.split(":");
  return `${groups.find((g) => g.status === status)?.label ?? status} · ${type}`;
}

/**
 * Material Planning's own filter: Short and Covered, each with RM / PM underneath.
 * Ticking a status ticks both of its types; a type can also be ticked alone.
 * Values are "STATUS:TYPE" (e.g. "SHORT:RM").
 */
export function MaterialStatusDropdown({ selected, onChange, groups = DEFAULT_GROUPS, label = "Material" }: { selected: string[]; onChange: (values: string[]) => void; groups?: MaterialGroup[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const root = useDismiss(open, () => setOpen(false));

  const has = (status: string, type: string) => selected.includes(`${status}:${type}`);
  const toggleType = (status: string, type: string) => {
    const value = `${status}:${type}`;
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };
  const toggleStatus = (status: string) => {
    const all = TYPES.map((t) => `${status}:${t}`);
    const everyOn = all.every((v) => selected.includes(v));
    onChange(everyOn ? selected.filter((v) => !all.includes(v)) : [...new Set([...selected, ...all])]);
  };

  return (
    <FilterControl label={label}>
      <div ref={root} className="relative">
        <DropdownTrigger open={open} active={selected.length > 0} text={summarize(selected, (v) => formatMaterialPick(v, groups))} onClick={() => setOpen((o) => !o)} />

        {open && (
          <div className="absolute left-0 z-40 mt-2 w-full min-w-[16rem] origin-top animate-scale-in overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lift">
            <div className="space-y-2 p-2.5">
              {groups.map(({ status, label, tone }) => {
                const onCount = TYPES.filter((t) => has(status, t)).length;
                return (
                  <div key={status} className="rounded-xl border border-slate-100 bg-slate-50/60 p-1.5">
                    <label className={`flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-body font-bold transition hover:bg-white ${tone}`}>
                      <input
                        type="checkbox"
                        checked={onCount === TYPES.length}
                        ref={(el) => {
                          if (el) el.indeterminate = onCount > 0 && onCount < TYPES.length;
                        }}
                        onChange={() => toggleStatus(status)}
                        className="h-4 w-4 rounded border-slate-300 accent-brand-600"
                      />
                      {label}
                    </label>
                    <div className="ml-7 grid grid-cols-2 gap-1">
                      {TYPES.map((type) => (
                        <label
                          key={type}
                          className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-body transition ${has(status, type) ? "bg-brand-50/80 font-semibold text-brand-800" : "text-slate-600 hover:bg-white"}`}
                        >
                          <input type="checkbox" checked={has(status, type)} onChange={() => toggleType(status, type)} className="h-4 w-4 rounded border-slate-300 accent-brand-600" />
                          {type}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <PanelFooter count={selected.length} onClear={() => onChange([])} onDone={() => setOpen(false)} />
          </div>
        )}
      </div>
    </FilterControl>
  );
}
