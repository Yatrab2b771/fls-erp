import { useEffect, useState } from "react";
import { Search, PackageSearch } from "lucide-react";
import { useAddOnPlanSearch, useAddOnPlanDetail } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import type { AddOnPlanCandidate } from "../lib/types";

// Debounce the search box — one request per pause in typing, not one
// per keystroke.
function useDebounced(value: string, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

// One material's Complete/Short line — same shape as the Pending PO
// Report's own MaterialLine (PpicPlanningDetailPage.tsx).
function MaterialLine({ name, requiredQty, unit, onHand, short, shortfallQty }: { name: string; requiredQty: number; unit: string; onHand: number | null; short: boolean; shortfallQty: number }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
      <span className={short ? "font-semibold text-rose-700" : "text-slate-700"}>
        {name} <span className="font-normal text-slate-400">({requiredQty} {unit})</span>
      </span>
      {onHand === null ? (
        <span className="pill border-slate-200 bg-slate-50 text-slate-400" title="No matching catalog item — can't check stock">
          Not in Catalog
        </span>
      ) : short ? (
        <span className="pill border-rose-200 bg-rose-50 text-rose-700">Short {shortfallQty} {unit}</span>
      ) : (
        <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Complete</span>
      )}
    </div>
  );
}

// PPIC's PO-independent material check — "before BD even raises an
// urgent PO, is this existing product's RM/PM already in Store?" Reads
// whatever BOM/RM Plan was already calculated for the searched product
// (see apps/api's add-on-plan.ts), nothing recalculated here.
export function AddOnPlanPage() {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounced(query, 300);
  const { data: candidates, isLoading: searching } = useAddOnPlanSearch(debouncedQuery);
  const [selected, setSelected] = useState<AddOnPlanCandidate | null>(null);
  const { data: detail, isLoading: loadingDetail, error: detailError } = useAddOnPlanDetail(selected);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-brand-500/10 text-brand-600">
          <PackageSearch className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Add on Plan</h1>
          <p className="text-sm text-slate-500">Search a product that already has a calculated BOM/RM Plan — check its RM/PM availability before raising a PO.</p>
        </div>
      </div>

      <div className="relative max-w-lg">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" strokeWidth={2.5} />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(null);
          }}
          placeholder="Search by product name…"
          className="field w-full pl-9 text-sm"
        />
      </div>

      {query.trim().length > 0 && query.trim().length < 2 && <p className="text-xs text-slate-400">Keep typing — at least 2 characters.</p>}

      {searching && debouncedQuery.trim().length >= 2 && <div className="skeleton h-10 w-full max-w-lg" />}

      {candidates && candidates.length > 0 && !selected && (
        <div className="card max-w-lg divide-y divide-slate-100 overflow-hidden">
          {candidates.map((c) => (
            <button
              key={`${c.type}-${c.id}`}
              type="button"
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm transition hover:bg-slate-50"
              onClick={() => setSelected(c)}
            >
              <span className="font-bold text-slate-700">
                {c.name}
                {c.customerName && <span className="ml-1.5 font-normal text-slate-400">· {c.customerName}</span>}
              </span>
              <span className={`pill ${c.type === "SKU" ? "border-violet-200 bg-violet-50 text-violet-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
                {c.type === "SKU" ? "Packaging (PM)" : "RM Formulation"}
              </span>
            </button>
          ))}
        </div>
      )}

      {candidates && candidates.length === 0 && debouncedQuery.trim().length >= 2 && !searching && (
        <EmptyState icon={PackageSearch} title="No matches" hint="No Sku or Recipe catalog entry matches that name." accent="brand" />
      )}

      {selected && (
        <div className="card max-w-2xl space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-lg font-black text-slate-900">
                {selected.name}
                {selected.customerName && <span className="ml-1.5 text-sm font-normal text-slate-400">· {selected.customerName}</span>}
              </p>
              <p className="text-xs text-slate-500">{selected.type === "SKU" ? "Packaging BOM (PM)" : "RM Costing (RM)"}</p>
            </div>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setSelected(null)}>
              Back to results
            </button>
          </div>

          {loadingDetail ? (
            <div className="skeleton h-32 w-full" />
          ) : detailError ? (
            <EmptyState
              icon={PackageSearch}
              title="No plan found"
              hint={`No calculated ${selected.type === "SKU" ? "Packaging BOM" : "RM Costing"} plan exists yet for this product — generate one first.`}
              accent="amber"
            />
          ) : detail ? (
            <>
              <p className="text-[11px] text-slate-400">
                From plan "{detail.planName}" — calculated {new Date(detail.planCalculatedAt).toLocaleString()}
              </p>
              {detail.materials.length === 0 ? (
                <p className="text-sm text-slate-500">This plan doesn't call for any {detail.category === "PM" ? "packaging" : "raw"} material.</p>
              ) : (
                <div className="space-y-2">
                  {detail.materials.map((m) => (
                    <MaterialLine key={m.name} {...m} />
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
