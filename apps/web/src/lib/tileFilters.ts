import { useMemo, useState } from "react";
import { matchesCustomerType, useCustomerTags } from "./customerTags";

/**
 * The filter bar every tile list shares: a From / To date plus any number of
 * multi-select picks (PO Number, Customer, Category, Product, and each tile's own).
 * Edits are held as a draft and only reach the list when Apply is pressed.
 */
export interface TileFilterState {
  dateFrom: string;
  dateTo: string;
  picks: Record<string, string[]>;
}

export type QueryParams = Record<string, string | string[] | undefined>;

export const EMPTY_TILE_FILTERS: TileFilterState = { dateFrom: "", dateTo: "", picks: {} };

// Compared by value, and without empty picks, so "nothing picked" equals "never touched".
const normalise = (f: TileFilterState) => JSON.stringify({ dateFrom: f.dateFrom, dateTo: f.dateTo, picks: Object.fromEntries(Object.entries(f.picks).filter(([, v]) => v.length > 0).sort(([a], [b]) => a.localeCompare(b))) });

export function countActive(f: TileFilterState): number {
  return (f.dateFrom || f.dateTo ? 1 : 0) + Object.values(f.picks).filter((v) => v.length > 0).length;
}

/** The applied filters as server query params - repeated keys for the multi-selects. */
export function filterParams(f: TileFilterState): QueryParams {
  const params: QueryParams = { dateFrom: f.dateFrom || undefined, dateTo: f.dateTo || undefined };
  for (const [key, values] of Object.entries(f.picks)) if (values.length) params[key] = values;
  return params;
}

/** Appends params to a URLSearchParams; arrays become repeated keys. */
export function appendParams(qs: URLSearchParams, params: QueryParams | undefined): URLSearchParams {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (Array.isArray(value)) for (const v of value) qs.append(key, v);
    else if (value) qs.set(key, value);
  }
  return qs;
}

export function useTileFilters() {
  const [draft, setDraft] = useState<TileFilterState>(EMPTY_TILE_FILTERS);
  const [appliedRaw, setApplied] = useState<TileFilterState>(EMPTY_TILE_FILTERS);
  const { data: tags } = useCustomerTags();

  // "Customer type" (New / Top 10 / Others) is turned into the customers it stands for, so every list that already filters by Customer
  // (client side or on the server) honours it without further work. The bar itself shows what was picked (appliedRaw).
  const applied = useMemo<TileFilterState>(() => {
    const types = appliedRaw.picks.customerType ?? [];
    if (types.length === 0) return appliedRaw;
    const { customerType: _types, ...picks } = appliedRaw.picks;
    void _types;
    const ofType = (tags ?? []).filter((t) => matchesCustomerType(t, types)).map((t) => t.companyName);
    const chosen = picks.customer ?? [];
    const customers = chosen.length ? chosen.filter((n) => ofType.includes(n)) : ofType;
    return { ...appliedRaw, picks: { ...picks, customer: customers.length ? customers : ["(no customer of this type)"] } };
  }, [appliedRaw, tags]);

  return {
    draft,
    applied,
    appliedRaw,
    params: filterParams(applied),
    activeCount: countActive(appliedRaw),
    dirty: normalise(draft) !== normalise(appliedRaw),
    setDate: (which: "dateFrom" | "dateTo", value: string) => setDraft((d) => ({ ...d, [which]: value })),
    setPick: (key: string, values: string[]) => setDraft((d) => ({ ...d, picks: { ...d.picks, [key]: values } })),
    apply: () => setApplied(draft),
    // Removing a chip edits the applied filter directly (and the draft with it).
    applyPick: (key: string, values: string[]) => {
      setApplied((a) => ({ ...a, picks: { ...a.picks, [key]: values } }));
      setDraft((d) => ({ ...d, picks: { ...d.picks, [key]: values } }));
    },
    applyDates: (dateFrom: string, dateTo: string) => {
      setApplied((a) => ({ ...a, dateFrom, dateTo }));
      setDraft((d) => ({ ...d, dateFrom, dateTo }));
    },
    clear: () => {
      setDraft(EMPTY_TILE_FILTERS);
      setApplied(EMPTY_TILE_FILTERS);
    },
  };
}

export type TileFilters = ReturnType<typeof useTileFilters>;
