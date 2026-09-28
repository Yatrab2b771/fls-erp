import { useEffect, useRef, useState } from "react";
import { Search, X, type LucideIcon } from "lucide-react";

interface ItemOption {
  id: string;
  name: string;
  // Optional group label — when set, a plain sticky header is printed
  // above the first row of each consecutive run sharing the same group
  // (callers should already sort items by group), so a mixed list (e.g.
  // Warehouse rows vs Store rows) reads as sections instead of one flat
  // list. Ignored entirely when no item sets it, same flat look as
  // before this existed.
  group?: string;
  // The RM/PM item's own code (e.g. "RM00292"), when the option is a
  // real InventoryItem — shown alongside the name everywhere this picker
  // is used for one, and searchable too (typing a code narrows the list
  // same as typing a name). Absent for pickers over non-inventory lists
  // (Category, Unit, Customer, ...), which just don't set it.
  code?: string | null;
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
  const displayName = (i: ItemOption) => (i.code ? `${i.code} — ${i.name}` : i.name);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const q = query.trim().toLowerCase();
  const matchesQuery = (i: ItemOption) => i.name.toLowerCase().includes(q) || !!i.code?.toLowerCase().includes(q);
  // Capped at 200 rendered rows — with 1,000+ items (the RM/PM catalog),
  // rendering every match as the user types their first character would
  // just recreate the original problem in DOM form. A narrower query
  // surfaces the real item within a couple of keystrokes. 200 comfortably
  // covers small-to-medium lists (Customers, Vendors, ...) in full, so
  // scrolling never appears to "get stuck" for those — only genuinely
  // huge catalogs ever hit the cap and need a search term.
  const matches = (q ? items.filter(matchesQuery) : items).slice(0, 200);
  const totalMatchCount = q ? items.filter(matchesQuery).length : items.length;

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
          placeholder={selected ? displayName(selected) : placeholder}
          value={open ? query : (selected ? displayName(selected) : "")}
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
              {matches.map((item, i) => (
                <div key={item.id}>
                  {item.group && item.group !== matches[i - 1]?.group && (
                    <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 first:pt-1">{item.group}</p>
                  )}
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2 truncate px-3 py-1.5 text-left text-xs hover:bg-brand-50 ${item.id === value ? "bg-brand-50 font-bold text-brand-700" : "text-slate-700"}`}
                    onClick={() => select(item)}
                    title={displayName(item)}
                  >
                    {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" strokeWidth={2.25} />}
                    {item.code && <span className="shrink-0 font-mono text-[10px] text-slate-400">{item.code}</span>}
                    <span className="truncate">{item.name}</span>
                  </button>
                </div>
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
