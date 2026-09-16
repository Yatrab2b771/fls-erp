import { Link } from "react-router-dom";
import { FlaskConical, Clock, CheckCircle2 } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useCreateRecipeRequest, useRecipeRequests } from "../lib/hooks";
import { useToast } from "./Toast";
import { ApiError } from "../lib/api";

// Shown wherever a PO-linked BOM/RM Costing plan came back DRAFT because
// "Generate" found no catalog match — PPIC's own call on whether this is
// worth asking R&D for (see recipe-request.routes.ts). Reused on the PO
// Detail page (next to Generate) and on the Packaging BOM / RM Costing
// pages themselves, same request, same live status either place.
export function RecipeRequestBanner({ purchaseOrderItemId }: { purchaseOrderItemId: string }) {
  const { hasRole } = useAuth();
  const toast = useToast();
  const { data: requests } = useRecipeRequests({ purchaseOrderItemId });
  const createRequest = useCreateRecipeRequest();
  const canRequest = hasRole("PPIC");
  // R&D is the one who owes this request, not the one waiting on it —
  // "Awaiting R&D" below is PPIC's framing (they're the ones waiting).
  // Shown to R&D itself (e.g. browsing RM BOM/Packaging BOM directly),
  // it should read as a to-do with a way to act on it instead.
  const isRnd = hasRole("RND");

  // Most recent one — a product could in principle have an old READY
  // request and nothing further to show once Generate has since matched.
  const request = requests?.[0];

  if (!request) {
    if (!canRequest) return null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50/60 px-3.5 py-2.5">
        <p className="flex items-center gap-1.5 text-xs font-bold text-amber-700">
          <FlaskConical className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} /> No catalog match for this product — R&D needs to add its Recipe/BOM.
        </p>
        <button
          type="button"
          className="btn-primary btn-sm shrink-0"
          disabled={createRequest.isPending}
          onClick={async () => {
            try {
              await createRequest.mutateAsync(purchaseOrderItemId);
              toast.success("Sent to R&D.");
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : "Could not send the request");
            }
          }}
        >
          {createRequest.isPending ? "Sending…" : "Request from R&D"}
        </button>
      </div>
    );
  }

  if (request.status === "READY") {
    return (
      <p className="flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50/60 px-3.5 py-2.5 text-xs font-bold text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} /> R&D delivered "{request.productName}" — click Generate again.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50/60 px-3.5 py-2.5">
      <div>
        <p className="flex items-center gap-1.5 text-xs font-bold text-amber-700">
          <Clock className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
          {isRnd
            ? request.status === "ETA_GIVEN" && request.etaDate
              ? `PPIC is waiting on this Recipe/BOM from you — ETA given ${new Date(request.etaDate).toLocaleDateString()}`
              : "PPIC is waiting on this Recipe/BOM from you — no ETA given yet"
            : request.status === "ETA_GIVEN" && request.etaDate
              ? `Awaiting R&D — ETA ${new Date(request.etaDate).toLocaleDateString()}`
              : "Awaiting R&D — no ETA given yet"}
        </p>
        {request.etaNote && <p className="mt-0.5 pl-5 text-[11px] text-amber-600">{request.etaNote}</p>}
      </div>
      {isRnd && (
        <Link to="/rnd" className="btn-primary btn-sm shrink-0">
          {request.status === "ETA_GIVEN" ? "Update ETA" : "Give ETA"}
        </Link>
      )}
    </div>
  );
}
