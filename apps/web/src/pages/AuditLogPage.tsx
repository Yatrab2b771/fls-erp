import { useState } from "react";
import { ClipboardList, History } from "lucide-react";
import { useAuditLog } from "../lib/hooks";
import { formatEmployeeId } from "../lib/format";
import { StatTile } from "../components/StatTile";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";

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

// Read-only view onto AuditLog — every mutating action in this app
// already writes one of these rows via recordAudit(); this is just the
// first place they're visible from the UI instead of a direct DB query.
// Admin-only, same gate as Users/Recycle Bin (see system.routes.ts) —
// nothing narrower, no separate "developer" tier.
export function AuditLogPage() {
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const { data: entries, isLoading } = useAuditLog({ action: action.trim() || undefined, entityType: entityType.trim() || undefined });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-slate-900">Audit Log</h1>
        <p className="text-sm text-slate-500">Append-only — who did what, when, across every module. The 200 most recent matches; narrow with the filters to reach further back.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile icon={History} label="Showing" value={entries?.length ?? 0} accent="brand" />
        <StatTile icon={ClipboardList} label="Newest" value={entries?.[0] ? timeAgo(entries[0].createdAt) : "—"} accent="slate" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input className="field w-full sm:w-64" placeholder="Filter by action (e.g. batch.stage_forwarded)…" value={action} onChange={(e) => setAction(e.target.value)} />
        <input className="field w-full sm:w-48" placeholder="Filter by entity (e.g. Batch)…" value={entityType} onChange={(e) => setEntityType(e.target.value)} />
      </div>

      {isLoading ? (
        <SkeletonRows rows={6} cols={5} />
      ) : !entries?.length ? (
        <EmptyState icon={History} title="No matching entries" hint="Try a different action/entity filter, or clear both to see the most recent activity." accent="slate" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-modern w-full">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap text-slate-500" title={new Date(e.createdAt).toLocaleString()}>
                      {timeAgo(e.createdAt)}
                    </td>
                    <td className="text-slate-600">{e.actor ? `${e.actor.fullName} (${formatEmployeeId(e.actor.employeeId)})` : "System"}</td>
                    <td className="font-mono text-[11px] font-bold text-slate-800">{e.action}</td>
                    <td className="text-slate-500">
                      {e.entityType}
                      {e.entityId && <span className="ml-1 font-mono text-[10px] text-slate-400">{e.entityId.slice(0, 8)}</span>}
                    </td>
                    <td className="max-w-xs truncate font-mono text-[10.5px] text-slate-400" title={e.metadata ? JSON.stringify(e.metadata) : ""}>
                      {e.metadata ? JSON.stringify(e.metadata) : "—"}
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
