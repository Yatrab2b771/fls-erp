import { History } from "lucide-react";
import { ApiError } from "../lib/api";
import { useBomVersions, useRestoreBomVersion } from "../lib/hooks";
import { useToast } from "./Toast";

// Version history of one BOM. The newest version is the Active one (the only one new plans use). An older
// one can be opened read-only to look at, or made Active again; that is saved as a new version on top, so
// nothing is ever deleted.

export function BomVersionBar({
  kind,
  entityId,
  viewing,
  onView,
  canRestore,
}: {
  kind: "PM" | "RM";
  entityId: string;
  /** The version shown in the table right now; null = the Active (latest). */
  viewing: number | null;
  onView: (version: number | null) => void;
  canRestore: boolean;
}) {
  const toast = useToast();
  const { data: versions } = useBomVersions(kind, entityId);
  const restore = useRestoreBomVersion(kind, entityId);
  if (!versions || versions.length === 0) return null;
  const active = versions[0]!;
  const shown = viewing ?? active.version;
  const current = versions.find((v) => v.version === shown);

  async function makeActive() {
    if (viewing == null) return;
    if (!window.confirm(`Make v${viewing} the Active BOM again? It is saved as a new version on top; v${active.version} stays in the list.`)) return;
    try {
      const r = await restore.mutateAsync(viewing);
      toast.success(`v${viewing} is Active again (saved as v${r.version}).`);
      onView(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not restore");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-1.5 text-tiny">
      <History className="h-3 w-3 text-slate-400" />
      <span className="text-slate-500">Version</span>
      <select className="field !h-7 !w-auto !py-0 text-xs" value={shown} onChange={(e) => onView(Number(e.target.value) === active.version ? null : Number(e.target.value))}>
        {versions.map((v) => (
          <option key={v.version} value={v.version}>
            v{v.version}{v.active ? " (Active)" : ""} - {new Date(v.createdAt).toLocaleDateString("en-IN")}
          </option>
        ))}
      </select>
      {current && (
        <span className="text-slate-400">
          {current.createdByName ? `by ${current.createdByName}` : ""}
          {current.note ? ` - ${current.note}` : ""}
        </span>
      )}
      {viewing != null && (
        <>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 font-bold text-amber-700">Old version, view only</span>
          {canRestore && (
            <button type="button" className="btn-primary btn-sm" disabled={restore.isPending} onClick={makeActive}>
              Make this Active
            </button>
          )}
          <button type="button" className="btn-ghost btn-sm" onClick={() => onView(null)}>Back to Active</button>
        </>
      )}
    </div>
  );
}
