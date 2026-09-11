import { Activity, AlertTriangle, CheckCircle2, Cpu, Database, RefreshCw, Users as UsersIcon } from "lucide-react";
import { useSystemHealth } from "../lib/hooks";
import { StatTile } from "../components/StatTile";
import { SkeletonRows } from "../components/Skeleton";

// A live "is this actually working" snapshot — DB connectivity, process
// vitals, a few quick row counts. Nothing here is new data; it's the
// same DB/process the API is already running against, just surfaced
// from the UI instead of a direct query/SSH session. Admin-only, same
// gate as Users/Recycle Bin (see system.routes.ts) — no separate
// "developer" tier.
export function SystemHealthPage() {
  const { data: health, isLoading, refetch, isFetching } = useSystemHealth();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">System Health</h1>
          <p className="text-sm text-slate-500">A live snapshot of the API's own database connection and process — pulled fresh on request, not cached.</p>
        </div>
        <button className="btn-ghost" disabled={isFetching} onClick={() => refetch()}>
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} strokeWidth={2.5} /> Refresh
        </button>
      </div>

      {isLoading ? (
        <SkeletonRows rows={4} cols={4} />
      ) : !health ? (
        <div className="card flex items-center gap-2.5 p-5 text-sm font-bold text-rose-600">
          <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2.5} /> Could not reach the health endpoint at all.
        </div>
      ) : (
        <>
          <div
            className={`card flex items-center gap-2.5 p-4 text-sm font-bold ${health.status === "ok" ? "border-emerald-200 bg-emerald-50/60 text-emerald-700" : "border-rose-200 bg-rose-50/60 text-rose-700"}`}
          >
            {health.status === "ok" ? <CheckCircle2 className="h-4 w-4 shrink-0" strokeWidth={2.5} /> : <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2.5} />}
            {health.status === "ok" ? "Database reachable and responding." : `Database problem: ${health.error ?? "unknown error"}`}
            <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-current/70">Checked {new Date(health.checkedAt).toLocaleTimeString()}</span>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile icon={Database} label="DB Latency" value={health.db.latencyMs !== undefined ? `${health.db.latencyMs} ms` : "—"} accent={health.status === "ok" ? "emerald" : "rose"} />
            <StatTile icon={Activity} label="Uptime" value={health.process ? formatUptime(health.process.uptimeSeconds) : "—"} accent="brand" />
            <StatTile icon={Cpu} label="Memory (RSS)" value={health.process ? `${health.process.memoryMb.rss} MB` : "—"} accent="violet" />
            <StatTile icon={Cpu} label="Node / Env" value={health.process ? `${health.process.nodeVersion} · ${health.process.env}` : "—"} accent="slate" />
          </div>

          {health.counts && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <StatTile icon={UsersIcon} label="Users" value={health.counts.users} accent="brand" />
              <StatTile icon={UsersIcon} label="Active Users" value={health.counts.activeUsers} accent="emerald" />
              <StatTile icon={Activity} label="Batches" value={health.counts.batches} accent="violet" />
              <StatTile icon={Activity} label="Purchase Orders" value={health.counts.purchaseOrders} accent="amber" />
              <StatTile icon={Activity} label="Audit Log Rows" value={health.counts.auditLogEntries} accent="slate" />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
