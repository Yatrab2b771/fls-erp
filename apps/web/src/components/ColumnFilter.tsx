import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Filter, Search } from "lucide-react";

const BLANK = "(Blanks)";
const shown = (v: string) => (v === "" ? BLANK : v);

/**
 * The filter button on a table's column header, like Excel's: a list of the values in the column to tick, with a search. Nothing selected is "no
 * filter" (every value passes); `options` are the values still in play (the rows the other columns' filters leave), blank ones as "".
 */
export function ColumnFilter({ label, options, selected, onChange }: { label: string; options: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const active = selected.length > 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || button.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggleOpen() {
    if (!open && button.current) {
      const r = button.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 272)) });
      setQ("");
    }
    setOpen((o) => !o);
  }

  // Ticking one value from "all" selects every other value, like Excel; ticking them all again is no filter
  function toggle(v: string) {
    const current = active ? selected : options;
    const next = current.includes(v) ? current.filter((x) => x !== v) : [...current, v];
    if (next.length === 0) return;
    onChange(next.length >= options.length && options.every((o) => next.includes(o)) ? [] : next);
  }

  const list = options.filter((o) => shown(o).toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggleOpen}
        aria-label={`Filter ${label}`}
        title={active ? `${label}: ${selected.map(shown).join(", ")}` : `Filter ${label}`}
        className={`ml-1.5 inline-flex h-5 w-5 items-center justify-center rounded border align-middle transition ${active ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-600"}`}
      >
        {active ? <Filter className="h-3 w-3" strokeWidth={2.5} /> : <ChevronDown className="h-3 w-3" strokeWidth={2.5} />}
      </button>
      {open &&
        createPortal(
          <div ref={panel} style={{ top: pos.top, left: pos.left }} className="fixed z-50 w-64 rounded-xl border border-slate-200 bg-white p-2 text-xs font-normal normal-case tracking-normal text-slate-700 shadow-lg">
            <p className="px-1 pb-1.5 text-micro font-bold uppercase tracking-wide text-slate-400">{label}</p>
            <div className="relative mb-1.5">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input autoFocus className="field !h-8 !py-0 !pl-7 !text-xs" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="max-h-56 overflow-y-auto">
              {list.length === 0 ? (
                <p className="px-2 py-2 text-slate-400">No match</p>
              ) : (
                list.map((o) => (
                  <label key={o} className="group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-50">
                    <input type="checkbox" className="h-3.5 w-3.5 rounded border-slate-300" checked={!active || selected.includes(o)} onChange={() => toggle(o)} />
                    <span className="min-w-0 flex-1 truncate">{shown(o)}</span>
                    <button
                      type="button"
                      className="hidden text-micro font-bold text-brand-600 hover:underline group-hover:inline"
                      onClick={(e) => {
                        e.preventDefault();
                        onChange([o]);
                      }}
                    >
                      only
                    </button>
                  </label>
                ))
              )}
            </div>
            <div className="mt-1.5 flex items-center justify-between border-t border-slate-100 pt-1.5">
              <button type="button" className="font-bold text-slate-500 hover:text-brand-600 disabled:opacity-40" disabled={!active} onClick={() => onChange([])}>
                Clear filter
              </button>
              <button type="button" className="btn-primary btn-sm" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
