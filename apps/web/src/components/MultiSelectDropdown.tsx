import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Search } from "lucide-react";
import { useDebounced } from "../lib/useDebounced";

export interface OptionPage {
  values: string[];
  hasMore: boolean;
}

/** What the closed dropdown shows: "All", the one value, or "first +N". */
export function summarize(selected: string[], format: (v: string) => string = (v) => v): string {
  if (selected.length === 0) return "All";
  if (selected.length === 1) return format(selected[0]!);
  return `${format(selected[0]!)} +${selected.length - 1}`;
}

/** Closes a popover on an outside click or Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return root;
}

/** The label-above-control wrapper every filter control shares. */
export function FilterControl({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <span className="mb-1.5 block text-micro font-bold uppercase tracking-[0.08em] text-slate-400">{label}</span>
      {children}
    </div>
  );
}

/** The closed dropdown button, and the panel chrome (footer) both dropdowns share. */
export function DropdownTrigger({ open, active, text, onClick }: { open: boolean; active: boolean; text: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className={`group flex h-10 w-full items-center justify-between gap-2 rounded-xl border bg-white px-3 text-left text-body font-medium shadow-soft outline-none transition-all duration-200 hover:border-slate-300 ${
        open ? "border-brand-400 shadow-[0_0_0_4px_rgba(99,102,241,.12)]" : active ? "border-brand-300" : "border-slate-200"
      }`}
    >
      <span className={`min-w-0 truncate ${active ? "font-semibold text-slate-800" : "text-slate-400"}`}>{text}</span>
      <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 ${open ? "rotate-180 text-brand-500" : ""}`} strokeWidth={2.25} />
    </button>
  );
}

export function PanelFooter({ count, onClear, onDone }: { count: number; onClear: () => void; onDone: () => void }) {
  return (
    <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/80 px-3.5 py-2.5 text-xs">
      <span className="font-medium text-slate-500">{count === 0 ? "Nothing selected" : `${count} selected`}</span>
      <span className="flex items-center gap-3">
        <button type="button" onClick={onClear} disabled={count === 0} className="font-semibold text-slate-500 transition hover:text-rose-600 disabled:opacity-40">
          Clear
        </button>
        <button type="button" onClick={onDone} className="rounded-lg bg-brand-600 px-3 py-1 font-bold text-white shadow-sm transition hover:bg-brand-700">
          Done
        </button>
      </span>
    </div>
  );
}

/**
 * A dropdown of checkboxes with a search box: pick one, several or all.
 * The values come from `load(search)` (the server, for long lists) or from
 * a fixed `options` array. Picked values stay ticked while the search changes.
 */
export function MultiSelectDropdown({
  label,
  selected,
  onChange,
  load,
  options,
  cacheKey,
}: {
  label: string;
  selected: string[];
  onChange: (values: string[]) => void;
  load?: (search: string) => Promise<OptionPage>;
  options?: string[];
  cacheKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search.trim(), 250);
  const root = useDismiss(open, () => setOpen(false));

  const remote = useQuery({
    // Under "purchase-orders" so anything that refreshes POs (a new PO, an approval) refreshes
    // these too; never stale, so every time the dropdown opens it asks the server again.
    queryKey: ["purchase-orders", "tile-filter-options", cacheKey, debounced],
    queryFn: () => load!(debounced),
    enabled: open && !!load,
    staleTime: 0,
    placeholderData: (previous) => previous,
  });

  const fixed = options?.filter((o) => !debounced || o.toLowerCase().includes(debounced.toLowerCase()));
  const shown: string[] = load ? (remote.data?.values ?? []) : (fixed ?? []);
  const hasMore = load ? (remote.data?.hasMore ?? false) : false;
  const loading = !!load && remote.isLoading;

  // Picked values that the current search doesn't list stay visible at the top.
  const hiddenPicked = selected.filter((v) => !shown.includes(v) && (!debounced || v.toLowerCase().includes(debounced.toLowerCase())));
  const list = [...hiddenPicked, ...shown];
  const allShownPicked = shown.length > 0 && shown.every((v) => selected.includes(v));

  const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  const toggleAllShown = () => onChange(allShownPicked ? selected.filter((v) => !shown.includes(v)) : [...new Set([...selected, ...shown])]);

  return (
    <FilterControl label={label}>
      <div ref={root} className="relative">
        <DropdownTrigger open={open} active={selected.length > 0} text={summarize(selected)} onClick={() => setOpen((o) => !o)} />

        {open && (
          <div className="absolute left-0 z-40 mt-2 w-full min-w-[17rem] origin-top animate-scale-in overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lift">
            <div className="border-b border-slate-100 p-2.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${label.toLowerCase()}…`}
                  className="h-9 w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-3 text-xs font-medium outline-none transition focus:border-brand-400 focus:bg-white focus:shadow-[0_0_0_3px_rgba(99,102,241,.12)]"
                />
              </div>
            </div>

            <div className="max-h-64 overflow-y-auto p-1.5">
              {shown.length > 0 && (
                <label className="mb-0.5 flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-50">
                  <input type="checkbox" checked={allShownPicked} onChange={toggleAllShown} className="h-4 w-4 rounded border-slate-300 accent-brand-600" />
                  {debounced ? "Select all matching" : "Select all"}
                </label>
              )}
              {loading ? (
                <div className="space-y-2 p-2">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="skeleton h-6 w-full" />
                  ))}
                </div>
              ) : list.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs font-medium text-slate-400">Nothing found</p>
              ) : (
                list.map((value) => {
                  const checked = selected.includes(value);
                  return (
                    <label
                      key={value}
                      className={`flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-body transition ${checked ? "bg-brand-50/70 font-semibold text-brand-800" : "text-slate-700 hover:bg-slate-50"}`}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggle(value)} className="h-4 w-4 rounded border-slate-300 accent-brand-600" />
                      <span className="min-w-0 flex-1 truncate" title={value}>
                        {value}
                      </span>
                      {checked && <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" strokeWidth={3} />}
                    </label>
                  );
                })
              )}
              {hasMore && <p className="px-3 py-2.5 text-center text-tiny font-medium text-slate-400">Showing the first {shown.length} — type to narrow down</p>}
            </div>

            <PanelFooter count={selected.length} onClear={() => onChange([])} onDone={() => setOpen(false)} />
          </div>
        )}
      </div>
    </FilterControl>
  );
}
