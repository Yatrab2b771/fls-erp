import { ArrowRight, CalendarDays, SlidersHorizontal, X } from "lucide-react";
import { api } from "../lib/api";
import type { TileFilters } from "../lib/tileFilters";
import { FilterControl, MultiSelectDropdown, type OptionPage } from "./MultiSelectDropdown";
import { CUSTOMER_TYPES } from "../lib/customerTags";
import { MaterialStatusDropdown, formatMaterialPick, type MaterialGroup } from "./MaterialStatusDropdown";

export interface FilterField {
  key: string;
  label: string;
  /** A server-searched list. */
  load?: (search: string) => Promise<OptionPage>;
  /** Or a fixed list. */
  options?: string[];
  /** Material Planning's Short / Covered x RM / PM picker. */
  kind?: "material";
  /** For kind "material": the status groups (default Short / Covered). */
  groups?: MaterialGroup[];
}

/** How long a row has been in the tile's list (its Aging column), in buckets. */
export const AGING_FIELD: FilterField = { key: "aging", label: "Aging", options: ["0-7 days", "8-15 days", "16-30 days", "31-60 days", "60+ days"] };

/** Material Planning's own Material filter. */
export const MATERIAL_FIELD: FilterField = { key: "mat", label: "Material", kind: "material" };

/** The PPIC tiles' shared picks - their values come from /api/ppic/filter-options for the given tile. */
export function ppicFields(tile: string, keys: ("po" | "customer" | "category" | "product")[] = ["po", "customer", "category", "product"]): FilterField[] {
  const labels = { po: "PO Number", customer: "Customer", category: "Product Category", product: "Product" } as const;
  return keys.map((key) => ({
    key,
    label: labels[key],
    load: (q: string) => api<OptionPage>(`/api/ppic/filter-options?tile=${encodeURIComponent(tile)}&field=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  }));
}

/** Each PPIC tile's own extra pick (beside PO / Customer / Category / Product). */
export function ppicTileFields(tile: string): FilterField[] {
  const serverList = (key: string, label: string): FilterField => ({
    key,
    label,
    load: (q: string) => api<OptionPage>(`/api/ppic/filter-options?tile=${encodeURIComponent(tile)}&field=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });
  switch (tile) {
    case "not-planned-pos":
      return [{ key: "pending", label: "Plan Pending", options: ["RM", "BOM"] }];
    case "plan-sent":
      return [serverList("plant", "Plant")];
    case "pending-pos":
      return [serverList("regBody", "Regulatory Body")];
    case "total-pos":
      return [{ key: "stage", label: "Stage", options: ["Draft", "Approved", "In progress", "Completed", "Rejected"] }];
    case "total-products":
      return [{ key: "stage", label: "Stage", options: ["Not planned", "Material short", "Ready for Production", "On hold", "Pre-production", "In production", "Finished goods", "With Dispatch", "Completed"] }];
    case "po-readiness":
      return [{ key: "regulatory", label: "Regulatory", options: ["Approved", "Not Approved", "Pending", "Not Sent"] }];
    default:
      return [];
  }
}

/**
 * The tile's filter card: date range + multi-select dropdowns, applied with the
 * Apply button. The chips underneath show what is applied; each can be removed on its own.
 */
export function TileFilterBar({ filters, fields: given, tileKey, dateLabel = "Date", hideDates = false }: { filters: TileFilters; fields: FilterField[]; tileKey: string; dateLabel?: string; hideDates?: boolean }) {
  const { draft, appliedRaw: applied } = filters;
  // Wherever a list can filter by Customer it can also filter by Customer type (New / Top 10 / Others), right after it
  const fields = given.flatMap((f) => (f.key === "customer" && !given.some((g) => g.key === "customerType") ? [f, { key: "customerType", label: "Customer type", options: [...CUSTOMER_TYPES] }] : [f]));
  const chips = fields.flatMap((f) => (applied.picks[f.key] ?? []).map((value) => ({ field: f, value })));
  const hasDates = !!(applied.dateFrom || applied.dateTo);
  // A chip is an applied filter - removing it applies straight away.
  const removeChip = (field: FilterField, value: string) =>
    filters.applyPick(
      field.key,
      (applied.picks[field.key] ?? []).filter((v) => v !== value),
    );

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
            <SlidersHorizontal className="h-4 w-4" strokeWidth={2.25} />
          </span>
          <h2 className="text-sm font-extrabold tracking-tight text-slate-800">Filters</h2>
          {filters.activeCount > 0 && <span className="rounded-full bg-brand-600 px-2 py-0.5 text-micro font-bold text-white">{filters.activeCount} active</span>}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={filters.clear} disabled={filters.activeCount === 0 && !filters.dirty} className="rounded-xl px-3.5 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:pointer-events-none disabled:opacity-40">
            Reset
          </button>
          <button type="button" onClick={filters.apply} disabled={!filters.dirty} className="btn-primary btn-sm disabled:pointer-events-none disabled:opacity-50">
            Apply filters
          </button>
        </div>
      </header>

      <div className="grid gap-x-4 gap-y-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {!hideDates && (
        <FilterControl label={`${dateLabel} date`} className="sm:col-span-2">
          <div className="flex h-10 items-center rounded-xl border border-slate-200 bg-white shadow-soft transition-all duration-200 focus-within:border-brand-400 focus-within:shadow-[0_0_0_4px_rgba(99,102,241,.12)] hover:border-slate-300">
            <CalendarDays className="ml-3 h-4 w-4 shrink-0 text-slate-400" strokeWidth={2} />
            <input type="date" aria-label={`${dateLabel} from`} value={draft.dateFrom} onChange={(e) => filters.setDate("dateFrom", e.target.value)} className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-body font-medium text-slate-800 outline-none" />
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-300" strokeWidth={2.5} />
            <input type="date" aria-label={`${dateLabel} to`} value={draft.dateTo} onChange={(e) => filters.setDate("dateTo", e.target.value)} className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-body font-medium text-slate-800 outline-none" />
          </div>
        </FilterControl>
        )}

        {fields.map((f) =>
          f.kind === "material" ? (
            <MaterialStatusDropdown key={f.key} label={f.label} groups={f.groups} selected={draft.picks[f.key] ?? []} onChange={(values) => filters.setPick(f.key, values)} />
          ) : (
            <MultiSelectDropdown key={f.key} label={f.label} selected={draft.picks[f.key] ?? []} onChange={(values) => filters.setPick(f.key, values)} load={f.load} options={f.options} cacheKey={`${tileKey}:${f.key}`} />
          ),
        )}
      </div>

      {(chips.length > 0 || hasDates) && (
        <div className="flex flex-wrap items-center gap-2 rounded-b-2xl border-t border-slate-100 bg-slate-50/60 px-5 py-3">
          <span className="text-micro font-bold uppercase tracking-[0.08em] text-slate-400">Applied</span>
          {hasDates && (
            <span className="inline-flex animate-scale-in items-center gap-1.5 rounded-full border border-brand-100 bg-brand-50 py-1 pl-3 pr-1.5 text-xs font-semibold text-brand-700">
              <span className="text-brand-400">{dateLabel}:</span> {applied.dateFrom || "…"} <ArrowRight className="h-3 w-3 text-brand-300" strokeWidth={2.5} /> {applied.dateTo || "…"}
              <button type="button" aria-label="Remove date filter" onClick={() => filters.applyDates("", "")} className="rounded-full p-0.5 text-brand-400 transition hover:bg-brand-100 hover:text-rose-600">
                <X className="h-3 w-3" strokeWidth={3} />
              </button>
            </span>
          )}
          {chips.map(({ field, value }) => (
            <span key={`${field.key}:${value}`} className="inline-flex max-w-[18rem] animate-scale-in items-center gap-1.5 rounded-full border border-brand-100 bg-brand-50 py-1 pl-3 pr-1.5 text-xs font-semibold text-brand-700">
              <span className="text-brand-400">{field.label}:</span>
              <span className="truncate">{field.kind === "material" ? formatMaterialPick(value, field.groups) : value}</span>
              <button type="button" aria-label={`Remove ${value}`} onClick={() => removeChip(field, value)} className="rounded-full p-0.5 text-brand-400 transition hover:bg-brand-100 hover:text-rose-600">
                <X className="h-3 w-3" strokeWidth={3} />
              </button>
            </span>
          ))}
          <button type="button" onClick={filters.clear} className="ml-auto text-xs font-bold text-slate-400 transition hover:text-rose-600">
            Clear all
          </button>
        </div>
      )}
    </section>
  );
}
