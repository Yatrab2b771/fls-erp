import { useEffect, useRef, useState } from "react";
import { Search, X, type LucideIcon } from "lucide-react";

interface ItemOption {
  id: string;
  name: string;
}

// A type-to-filter combobox for picking one item out of a real catalog —
// built once the real ~2,700-item FLS stock import made every plain
// <select> item picker in the app (Material Requests, Pre-Inventory, PO
// Readiness, Log Entry) practically unusable: scrolling a 1,000+ option
// dropdown to find one item by eye doesn't work at that scale, even
// though every item genuinely was in the list. This is the replacement —
// same value/onChange contract as a <select>, so it drops into any of
// those forms directly.
export function ItemPicker({
  items,
  value,
  onChange,
  placeholder = "— Select an item —",
  disabled = false,
  // false for a required field that must always hold one of `items`
  // (e.g. Category, Unit) — hides the clear (X) button so search can't
  // leave the field empty. Every optional-field caller keeps the
  // default: clearable, same as before this prop existed.
  clearable = true,
  // Optional leading icon per row — a plain text list of ~5 dosage-form
  // options doesn't need one, but a real named catalog (Brand, Product)
  // reads better with a mark that says what kind of thing this list is.
  icon: Icon,
}: {
  items: ItemOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  clearable?: boolean;
  icon?: LucideIcon;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = items.find((i) => i.id === value);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const q = query.trim().toLowerCase();
  // Capped at 50 rendered rows — with 1,000+ items, rendering every match
  // as the user types their first character would just recreate the
  // original problem in DOM form. A narrower query surfaces the real
  // item within a couple of keystrokes.
  const matches = (q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items).slice(0, 50);
  const totalMatchCount = q ? items.filter((i) => i.name.toLowerCase().includes(q)).length : items.length;

  function select(item: ItemOption) {
    onChange(item.id);
    setQuery("");
    setOpen(false);
  }

  return (
    <div className="relative" ref={rootRef}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" strokeWidth={2} />
        <input
          type="text"
          className="field pl-9 pr-8"
          disabled={disabled}
          placeholder={selected ? selected.name : placeholder}
          value={open ? query : (selected?.name ?? "")}
          onFocus={() => {
            setOpen(true);
            setQuery("");
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
        />
        {selected && !open && clearable && (
          <button
            type="button"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            title="Clear"
            onClick={() => onChange("")}
          >
            <X className="h-3.5 w-3.5" strokeWidth={2.25} />
          </button>
        )}
      </div>

      {open && !disabled && (
        <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          {matches.length === 0 ? (
            <p className="px-3 py-2 text-xs text-slate-400">No items match "{query}".</p>
          ) : (
            <>
              {matches.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`flex w-full items-center gap-2 truncate px-3 py-1.5 text-left text-xs hover:bg-brand-50 ${item.id === value ? "bg-brand-50 font-bold text-brand-700" : "text-slate-700"}`}
                  onClick={() => select(item)}
                  title={item.name}
                >
                  {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" strokeWidth={2.25} />}
                  <span className="truncate">{item.name}</span>
                </button>
              ))}
              {totalMatchCount > matches.length && (
                <p className="border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-400">
                  {totalMatchCount - matches.length} more — keep typing to narrow it down
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
