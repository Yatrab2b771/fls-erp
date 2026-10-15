import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Clock, FlaskConical, Lock } from "lucide-react";
import { useAuth } from "../lib/auth";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { ApiError } from "../lib/api";
import { useGiveRecipeRequestEta, useRecipeRequests } from "../lib/hooks";
import type { RecipeRequest } from "../lib/types";
import { ExpandTable } from "../components/ExpandTable";
import { CustomerName } from "../components/CustomerName";

// R&D's home page — tracking what PPIC has asked for that has no
// Recipe/BOM yet, and giving an ETA on each. Authoring the catalog data
// itself (Import Catalog, Import Recipes, Browse & Edit Catalog) lives
// on Packaging BOM and RM Costing now, one department's own tool next
// to the plans it produces, instead of bundled onto this page.
//
// PPIC still has a real reason to land here: tracking the status of
// requests *they* raised (the same "View PO" link from a batch's stage
// history, a stale tab, a typed URL). Rather than a dead-end "restricted"
// block, PPIC gets a read-only cut of this same page — its own requests'
// status, no Give ETA control (the underlying write is RND-only
// server-side regardless). Anyone else (no real stake here at all —
// GET /api/recipe-requests itself is PPIC/RND-only) still hits the
// restricted view.
export function RndPage() {
  const { hasRole } = useAuth();
  const canManage = hasRole("RND");
  const canView = canManage || hasRole("PPIC");

  const { data: requests, isLoading } = useRecipeRequests({ enabled: canView });

  if (!canView) {
    return <EmptyState icon={Lock} title="Restricted to R&D" hint="This page belongs to the R&D department — ask an R&D team member or Admin if you need something delivered here." accent="slate" />;
  }

  const openRequests = (requests ?? []).filter((r) => r.status !== "READY");
  const readyRequests = (requests ?? []).filter((r) => r.status === "READY");

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-violet-50 text-violet-600">
          <FlaskConical className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">R&D</h1>
          <p className="text-sm text-slate-500">
            {canManage ? "Requests from PPIC for products with no Recipe/BOM yet — and where to deliver them." : "Your own Recipe/BOM requests to R&D, and where each one stands."}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <h2 className="mb-2 flex items-center gap-1.5 text-tiny font-bold uppercase tracking-wider text-slate-400">
            <Clock className="h-3.5 w-3.5" /> {canManage ? "Open Requests" : "My Open Requests"} ({openRequests.length})
          </h2>
          {isLoading ? (
            <p className="text-xs text-slate-400">Loading…</p>
          ) : openRequests.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="Nothing pending"
              hint={canManage ? "Every product PPIC has asked about has a matching Recipe/BOM." : "You have no open Recipe/BOM requests right now."}
              accent="emerald"
            />
          ) : (
            <ExpandTable
              rows={openRequests}
              rowKey={(r) => r.id}
              openLabel={canManage ? "Open / give ETA" : "Open"}
              renderExpanded={(r) => <RequestCard request={r} canManage={canManage} />}
              columns={[
                { header: "Product", cell: (r) => r.productName, className: "font-bold text-slate-800" },
                { header: "Customer", cell: (r) => r.customerName ?? "-" },
                { header: "PO", cell: (r) => r.poNumber ?? "-" },
                { header: "Needed", cell: (r) => [r.bomNeeded && "BOM/SKU", r.rmNeeded && "Recipe"].filter(Boolean).join(" + ") || "-" },
                { header: "Status", cell: (r) => <span className="pill border-amber-200 bg-amber-50 text-amber-700">{r.status === "ETA_GIVEN" ? "ETA given" : "Waiting for R&D"}</span> },
                { header: "ETA", cell: (r) => (r.etaDate ? new Date(r.etaDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-") },
                { header: "ETA Note", cell: (r) => r.etaNote ?? "-", className: "max-w-[16rem] truncate" },
                { header: "Requested By", cell: (r) => `${r.requestedByName} · ${new Date(r.requestedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}` },
              ]}
            />
          )}
        </div>

        {readyRequests.length > 0 && (
          <div>
            <h2 className="mb-2 flex items-center gap-1.5 text-tiny font-bold uppercase tracking-wider text-slate-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> Delivered ({readyRequests.length})
            </h2>
            <div className="card overflow-x-auto">
              <table className="w-full whitespace-nowrap text-xs">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Product</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">PO</th>
                    <th className="px-4 py-3">Delivered</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {readyRequests.map((r) => (
                    <tr key={r.id} className="transition hover:bg-slate-50">
                      <td className="px-4 py-3 font-bold text-slate-800">{r.productName}</td>
                      <td className="px-4 py-3">
                        <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Ready</span>
                      </td>
                      <td className="px-4 py-3 text-slate-600"><CustomerName name={r.customerName} /></td>
                      <td className="px-4 py-3 text-slate-600">{r.poNumber ?? "-"}</td>
                      <td className="px-4 py-3 text-slate-600">{r.readyAt ? new Date(r.readyAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RequestCard({ request, canManage }: { request: RecipeRequest; canManage: boolean }) {
  const toast = useToast();
  const giveEta = useGiveRecipeRequestEta();
  const [showEta, setShowEta] = useState(false);
  const [etaDate, setEtaDate] = useState(request.etaDate?.slice(0, 10) ?? "");
  const [etaNote, setEtaNote] = useState(request.etaNote ?? "");
  const [error, setError] = useState<string | null>(null);

  const needed = [request.bomNeeded && "BOM/SKU", request.rmNeeded && "Recipe"].filter(Boolean).join(" + ");

  async function handleSave() {
    setError(null);
    if (!etaDate) return setError("Pick a date.");
    try {
      await giveEta.mutateAsync({ id: request.id, etaDate, etaNote: etaNote.trim() || undefined });
      toast.success("ETA sent to PPIC.");
      setShowEta(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <div className="card space-y-2 p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-bold text-slate-700">{request.productName}</p>
          <p className="text-micro text-slate-400">
            {request.customerName && (
          <>
            <CustomerName name={request.customerName} /> ·{" "}
          </>
        )}
            Needs: {needed}
            {canManage && <> · requested by {request.requestedByName}</>}
          </p>
          <Link to={`/purchase-orders/${request.purchaseOrderId}`} className="text-micro font-bold text-violet-600 hover:underline">
            {request.poNumber ?? "View PO"}
          </Link>
        </div>
        <span className={`pill shrink-0 ${request.status === "ETA_GIVEN" ? "border-brand-200 bg-brand-50 text-brand-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
          {request.status === "ETA_GIVEN" ? "ETA Given" : "Pending"}
        </span>
      </div>

      {request.status === "ETA_GIVEN" && request.etaDate && (
        <p className="text-tiny text-slate-500">
          ETA: <span className="font-bold text-slate-700">{new Date(request.etaDate).toLocaleDateString()}</span>
          {request.etaNote && <> — {request.etaNote}</>}
        </p>
      )}

      {canManage &&
        (!showEta ? (
          <button type="button" className="btn-ghost btn-sm" onClick={() => setShowEta(true)}>
            {request.status === "ETA_GIVEN" ? "Update ETA" : "Give ETA"}
          </button>
        ) : (
          <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/60 p-2.5">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label className="label">ETA Date</label>
                <input type="date" className="field" value={etaDate} onChange={(e) => setEtaDate(e.target.value)} />
              </div>
              <div>
                <label className="label">Note (optional)</label>
                <input className="field" placeholder="e.g. Formulation in trial" value={etaNote} onChange={(e) => setEtaNote(e.target.value)} />
              </div>
            </div>
            {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost btn-sm" onClick={() => setShowEta(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary btn-sm" disabled={giveEta.isPending} onClick={handleSave}>
                {giveEta.isPending ? "Saving…" : "Save ETA"}
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}
