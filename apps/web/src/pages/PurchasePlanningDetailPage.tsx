import { Fragment, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ClipboardList, Download, Truck } from "lucide-react";
import { useAuth } from "../lib/auth";
import { usePreInventoryRequirements, useSetRequirementPurchase, useInventoryVendors } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { exportRequirementsReport } from "../lib/inventoryExport";
import { useToast } from "../components/Toast";
import { ApiError } from "../lib/api";
import {
  filterPurchasePlanningRows,
  getPurchasePlanningRows,
  PURCHASE_PLANNING_METRIC_LABEL,
  REQUIREMENT_STATUS_LABEL,
  requirementStatus,
  type PurchasePlanningMetric,
} from "../lib/purchasePlanning";
import type { PreInventoryRequirement } from "../lib/types";

const VALID_METRICS = new Set(Object.keys(PURCHASE_PLANNING_METRIC_LABEL));

const STATUS_PILL_CLASS: Record<string, string> = {
  COVERED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  SHORTFALL: "border-amber-200 bg-amber-50 text-amber-700",
  ORDERED: "border-brand-200 bg-brand-50 text-brand-700",
};

// A starting point, not a real numbering scheme — same as
// PreInventoryPage's own suggestPoNumber, duplicated here rather than
// exported since it's a one-line convenience, not shared logic.
function suggestPoNumber(r: PreInventoryRequirement): string {
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PO-${r.category}-${datePart}-${suffix}`;
}

// The drill-down behind every Purchase dashboard tile — clicking a tile
// lands here with the exact list of Pre-Inventory requirements behind
// that number (see purchasePlanning.ts, the shared filter both the tile
// and this page read from), plus a one-click Excel export reusing
// PreInventoryPage's own exportRequirementsReport. Purchase can Log/Edit
// a PO right from this list too — same mutation PreInventoryPage uses,
// so they never have to leave this filtered view to act on it.
export function PurchasePlanningDetailPage() {
  const { metric } = useParams<{ metric: string }>();
  const { data: requirements, isLoading } = usePreInventoryRequirements();

  if (!metric || !VALID_METRICS.has(metric)) {
    return <EmptyState icon={ClipboardList} title="Unknown report" hint="That planning tile doesn't exist." accent="rose" />;
  }
  const m = metric as PurchasePlanningMetric;
  const label = PURCHASE_PLANNING_METRIC_LABEL[m];

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      {isLoading || !requirements ? (
        <div className="skeleton h-64 w-full" />
      ) : (
        <PurchasePlanningTable metric={m} label={label} requirements={requirements} />
      )}
    </div>
  );
}

function PurchasePlanningTable({
  metric,
  label,
  requirements,
}: {
  metric: PurchasePlanningMetric;
  label: string;
  requirements: NonNullable<ReturnType<typeof usePreInventoryRequirements>["data"]>;
}) {
  const { hasRole } = useAuth();
  const canPurchase = hasRole("PURCHASE");
  const fullRows = getPurchasePlanningRows(metric, requirements);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"" | "RM" | "PM">("");
  const [etaFrom, setEtaFrom] = useState("");
  const [etaTo, setEtaTo] = useState("");
  const rows = filterPurchasePlanningRows(fullRows, { search, category: category || undefined, etaFrom, etaTo });
  const isFiltered = search.trim().length > 0 || !!category || !!etaFrom || !!etaTo;

  // Which row's Log/Edit PO form is currently open — at most one at a
  // time, same "click to expand, click Cancel/Save to close" shape as
  // PreInventoryPage's own RequirementCard.
  const [openRowId, setOpenRowId] = useState<string | null>(null);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-brand-500/10 text-brand-600">
            <ClipboardList className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{label}</h1>
            <p className="text-sm text-slate-500">
              {rows.length} requirement(s)
              {isFiltered ? ` of ${fullRows.length}` : ""}
            </p>
          </div>
        </div>
        <button className="btn-primary btn-sm" onClick={() => exportRequirementsReport(rows)} disabled={rows.length === 0}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Report{isFiltered ? " (Filtered)" : ""}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by Item, PO Number or Vendor…"
          className="field w-full max-w-sm text-xs"
        />
        <label className="flex flex-col gap-1 text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value as "" | "RM" | "PM")} className="field text-xs">
            <option value="">All</option>
            <option value="RM">Raw Material</option>
            <option value="PM">Packaging Material</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
          ETA From
          <input type="date" value={etaFrom} onChange={(e) => setEtaFrom(e.target.value)} className="field text-xs" />
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
          ETA To
          <input type="date" value={etaTo} onChange={(e) => setEtaTo(e.target.value)} className="field text-xs" />
        </label>
        {(category || etaFrom || etaTo) && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => {
              setCategory("");
              setEtaFrom("");
              setEtaTo("");
            }}
          >
            Clear Filters
          </button>
        )}
      </div>

      {fullRows.length === 0 ? (
        <EmptyState icon={ClipboardList} title="Nothing here" hint="No records match this tile right now." accent="brand" />
      ) : rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No matches" hint="Nothing matches these filters." accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Required</th>
                <th className="px-4 py-3">On Hand</th>
                <th className="px-4 py-3">Short By</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">PO / Vendor</th>
                <th className="px-4 py-3">ETA</th>
                <th className="px-4 py-3"></th>
                {canPurchase && <th className="px-4 py-3">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                const status = requirementStatus(r);
                const isOpen = openRowId === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr className="transition hover:bg-slate-50">
                      <td className="px-4 py-3 font-bold text-slate-700">{r.item.name}</td>
                      <td className="px-4 py-3 text-slate-500">{r.category === "RM" ? "Raw Material" : "Packaging Material"}</td>
                      <td className="px-4 py-3 text-slate-500">
                        {r.requiredQty} {r.unit}
                      </td>
                      <td className="px-4 py-3 text-slate-500">{r.currentStock}</td>
                      <td className="px-4 py-3 text-slate-500">{r.shortQty > 0 ? r.shortQty : "—"}</td>
                      <td className="px-4 py-3">
                        <span className={`pill ${STATUS_PILL_CLASS[status]}`}>{REQUIREMENT_STATUS_LABEL[status]}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-500">{r.poNumber ? `${r.poNumber} · ${r.vendorName ?? "—"}` : "—"}</td>
                      <td className="px-4 py-3">
                        {r.eta ? (
                          <span className={new Date(r.eta) < new Date() ? "font-semibold text-rose-700" : "text-slate-500"}>
                            {new Date(r.eta).toLocaleDateString()}
                            {new Date(r.eta) < new Date() ? " (Overdue)" : ""}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {r.purchaseCorrectedAt && (
                          <span className="pill border-blue-200 bg-blue-50 text-blue-700" title={`Corrected ${new Date(r.purchaseCorrectedAt).toLocaleString()}`}>
                            Updated
                          </span>
                        )}
                      </td>
                      {canPurchase && (
                        <td className="px-4 py-3">
                          {status === "SHORTFALL" || r.poNumber ? (
                            <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenRowId(isOpen ? null : r.id)}>
                              <Truck className="h-3.5 w-3.5" strokeWidth={2.5} /> {r.poNumber ? "Edit PO" : "Log PO"}
                            </button>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={canPurchase ? 10 : 9} className="bg-slate-50/60 px-4 py-3">
                          <LogPoForm requirement={r} onDone={() => setOpenRowId(null)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// Same Log/Edit PO form as PreInventoryPage's RequirementCard, laid out
// for a table row instead of a card — same mutation, same validation,
// so Purchase never has to leave this filtered list to act on it.
function LogPoForm({ requirement, onDone }: { requirement: PreInventoryRequirement; onDone: () => void }) {
  const toast = useToast();
  const setPurchase = useSetRequirementPurchase();
  const { data: vendors } = useInventoryVendors();
  const isEditing = !!requirement.poNumber;

  const [poNumber, setPoNumber] = useState(requirement.poNumber ?? suggestPoNumber(requirement));
  const [vendorName, setVendorName] = useState(requirement.vendorName ?? "");
  const [eta, setEta] = useState(requirement.eta ? requirement.eta.slice(0, 10) : "");
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    if (!poNumber.trim() || !vendorName.trim() || !eta) return setError("PO Number, Vendor Name, and ETA are all required.");
    try {
      await setPurchase.mutateAsync({ id: requirement.id, poNumber: poNumber.trim(), vendorName: vendorName.trim(), eta });
      toast.success(isEditing ? "PO details updated." : "PO logged — Finance has been notified.");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the PO");
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div>
        <label className="label">PO Number</label>
        <input className="field font-mono" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
      </div>
      <div>
        <label className="label">Vendor Name</label>
        <input className="field" list={`po-vendor-options-${requirement.id}`} placeholder="Pick a known vendor or type a new one" value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
        <datalist id={`po-vendor-options-${requirement.id}`}>
          {vendors?.vendors.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </div>
      <div>
        <label className="label">ETA</label>
        <input type="date" className="field" value={eta} onChange={(e) => setEta(e.target.value)} />
      </div>
      {error && <p className="text-xs font-bold text-rose-600 sm:col-span-3">{error}</p>}
      <div className="flex justify-end gap-2 sm:col-span-3">
        <button type="button" className="btn-ghost btn-sm" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="btn-primary btn-sm" disabled={setPurchase.isPending} onClick={handleSave}>
          {setPurchase.isPending ? "Saving…" : isEditing ? "Update PO" : "Save PO"}
        </button>
      </div>
    </div>
  );
}
