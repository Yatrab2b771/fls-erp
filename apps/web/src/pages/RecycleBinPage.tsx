import { useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { useRecycleBin, useRestoreFromRecycleBin } from "../lib/hooks";
import type { RecycleBinEntityType, RecycleBinRow } from "../lib/types";
import { ApiError } from "../lib/api";
import { formatEmployeeId } from "../lib/format";
import { StatTile } from "../components/StatTile";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";

const TYPE_LABEL: Record<RecycleBinEntityType, string> = {
  "inventory-transaction": "Material Received/Issued",
  "dispatch-transfer": "Dispatch Transfer",
  "inventory-request": "Material Request",
  "po-material-requirement": "PO Requirement",
  "purchase-order-item": "PO Line Item",
  "purchase-order-document": "PO Document",
  "bom-plan-item": "BOM Plan Item",
  "rm-plan-item": "RM Plan Item",
  "pre-inventory-requirement": "Pre-Inventory Requirement",
};

const TYPE_COLOR: Record<RecycleBinEntityType, string> = {
  "inventory-transaction": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "dispatch-transfer": "border-sky-200 bg-sky-50 text-sky-700",
  "inventory-request": "border-amber-200 bg-amber-50 text-amber-700",
  "po-material-requirement": "border-violet-200 bg-violet-50 text-violet-700",
  "purchase-order-item": "border-brand-200 bg-brand-50 text-brand-700",
  "purchase-order-document": "border-slate-200 bg-slate-50 text-slate-700",
  "bom-plan-item": "border-teal-200 bg-teal-50 text-teal-700",
  "rm-plan-item": "border-orange-200 bg-orange-50 text-orange-700",
  "pre-inventory-requirement": "border-rose-200 bg-rose-50 text-rose-700",
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Admin's one place to see and undo any accidental delete, across every
// module that has one — nothing in this app hard-deletes real data any
// more (see recycle-bin.routes.ts). Restoring is deliberately a single
// click with no confirmation prompt: unlike a delete, there's no
// destructive consequence to undo lightly.
export function RecycleBinPage() {
  const { data: rows, isLoading } = useRecycleBin();
  const restore = useRestoreFromRecycleBin();
  const toast = useToast();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<RecycleBinEntityType | "">("");

  const q = search.trim().toLowerCase();
  const filtered = rows?.filter(
    (r) => (!typeFilter || r.entityType === typeFilter) && (!q || r.label.toLowerCase().includes(q) || r.detail.toLowerCase().includes(q) || r.deletedBy?.fullName.toLowerCase().includes(q)),
  );

  const typesPresent = [...new Set(rows?.map((r) => r.entityType) ?? [])];
  const oldestDeletedAt = rows?.length ? rows.reduce((oldest, r) => (r.deletedAt < oldest ? r.deletedAt : oldest), rows[0]!.deletedAt) : null;

  async function handleRestore(row: RecycleBinRow) {
    try {
      await restore.mutateAsync({ entityType: row.entityType, id: row.id });
      toast.success(`Restored: ${row.label}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not restore this");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-slate-900">Recycle Bin</h1>
        <p className="text-sm text-slate-500">Nothing deleted anywhere in the system is ever gone for good — every delete lands here first, restorable in one click.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile icon={Trash2} label="Items in Bin" value={rows?.length ?? 0} accent={rows?.length ? "amber" : "slate"} />
        <StatTile icon={RotateCcw} label="Entity Types" value={typesPresent.length} accent="brand" />
        <StatTile icon={Trash2} label="Oldest Deletion" value={oldestDeletedAt ? timeAgo(oldestDeletedAt) : "—"} accent="slate" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-full sm:w-72">
          <SearchBar value={search} onChange={setSearch} placeholder="Search by name, detail, or who deleted it…" />
        </div>
        <select className="field w-auto" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as RecycleBinEntityType | "")}>
          <option value="">All types</option>
          {typesPresent.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <SkeletonRows rows={5} cols={5} />
      ) : !rows?.length ? (
        <EmptyState icon={RotateCcw} title="Recycle Bin is empty" hint="Nothing has been deleted anywhere in the system yet." accent="slate" />
      ) : !filtered?.length ? (
        <EmptyState icon={RotateCcw} title="No matching entries" hint="Try a different search or type filter." accent="slate" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-modern w-full">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>What</th>
                  <th>Details</th>
                  <th>Deleted By</th>
                  <th>Deleted</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={`${r.entityType}:${r.id}`}>
                    <td>
                      <span className={`pill ${TYPE_COLOR[r.entityType]}`}>{TYPE_LABEL[r.entityType]}</span>
                    </td>
                    <td className="font-bold text-slate-800">{r.label}</td>
                    <td className="text-slate-500">{r.detail}</td>
                    <td className="text-slate-600">{r.deletedBy ? `${r.deletedBy.fullName} (${formatEmployeeId(r.deletedBy.employeeId)})` : "—"}</td>
                    <td className="text-slate-500" title={new Date(r.deletedAt).toLocaleString()}>
                      {timeAgo(r.deletedAt)}
                    </td>
                    <td className="text-right">
                      <button
                        className="btn-ghost btn-sm inline-flex"
                        disabled={restore.isPending}
                        onClick={() => handleRestore(r)}
                        title="Restore this back into normal use"
                      >
                        <RotateCcw className="h-3.5 w-3.5" strokeWidth={2.25} /> Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
