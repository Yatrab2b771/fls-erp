import { useState, type ChangeEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Beaker,
  Boxes,
  Building2,
  Calendar,
  Check,
  Circle,
  Download,
  FileStack,
  FlaskConical,
  Lock,
  Package,
  Plus,
  ShieldCheck,
  Truck,
  Upload,
  X,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useAddPurchaseOrderItem,
  useBatches,
  useCreateBatch,
  useCreateBomPlan,
  useCreateRmPlan,
  usePurchaseOrder,
  useRemovePurchaseOrderItem,
  useReviewPurchaseOrder,
  useUploadPoDocument,
} from "../lib/hooks";
import { StageBadge, DelayBadge, PoStatusBadge } from "../components/Badges";
import { EmptyState } from "../components/EmptyState";
import { downloadFile, ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import type { Batch, PurchaseOrder, PurchaseOrderItem } from "../lib/types";

export function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: po, isLoading } = usePurchaseOrder(id);
  const { hasRole } = useAuth();
  const toast = useToast();
  const upload = useUploadPoDocument(id!);
  const [error, setError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-4 w-40" />
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-24 w-full" />
      </div>
    );
  }
  if (!po) return <EmptyState icon={Building2} title="Purchase order not found" accent="rose" />;

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      await upload.mutateAsync(file);
      toast.success(`${file.name} attached to this PO.`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Upload failed";
      setError(msg);
      toast.error(msg);
    }
  }

  return (
    <div className="space-y-6">
      <Link to="/purchase-orders" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> All Purchase Orders
      </Link>

      <div className="card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="stat-icon bg-brand-50 text-brand-600">
              <Building2 className="h-5 w-5" strokeWidth={2} />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-black tracking-tight text-slate-900">{po.poNumber ?? po.id.slice(0, 8)}</h1>
                <PoStatusBadge status={po.status} />
              </div>
              <p className="text-sm text-slate-500">
                {po.customer.companyName} {po.brandName && `· ${po.brandName}`}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="pill border-slate-200 bg-slate-50 text-slate-600">
              <ShieldCheck className="h-3 w-3" /> {po.regulatoryBody ?? "No body"} · {po.regulatoryStatus ?? "—"}
            </span>
            <span className="pill border-slate-200 bg-slate-50 text-slate-600">
              <Calendar className="h-3 w-3" /> {po.orderDate ? new Date(po.orderDate).toLocaleDateString() : "No date"}
            </span>
            <button
              className="btn-ghost btn-sm"
              onClick={() => downloadFile(`/api/purchase-orders/${po.id}/export.pdf`, `FLS_PO_${po.poNumber ?? po.id}.pdf`)}
            >
              <Download className="h-3 w-3" strokeWidth={2.5} /> Download PDF
            </button>
          </div>
        </div>

        <ReviewPanel po={po} />

        <div className="mt-5 border-t border-slate-100 pt-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="label !mb-0 flex items-center gap-1.5">
              <FileStack className="h-3.5 w-3.5" /> Documents
            </p>
            {hasRole("BD") && (
              <label className="btn-ghost btn-sm cursor-pointer">
                <Upload className="h-3 w-3" strokeWidth={2.5} />
                {upload.isPending ? "Uploading…" : "Upload PO"}
                <input type="file" accept="image/*,application/pdf" className="hidden" onChange={handleUpload} />
              </label>
            )}
          </div>
          {error && <p className="mb-2 text-xs font-bold text-rose-600">{error}</p>}
          {po.documents.length === 0 ? (
            <p className="text-xs text-slate-400">No documents uploaded yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {po.documents.map((d) => (
                <li key={d.id} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/60 px-3.5 py-2 text-xs">
                  <span className="truncate font-bold text-slate-700">{d.filename}</span>
                  <button
                    className="btn-icon shrink-0 hover:!bg-brand-50 hover:!text-brand-600"
                    onClick={() => downloadFile(`/api/purchase-orders/${po.id}/documents/${d.id}/download`, d.filename)}
                    title="Download"
                  >
                    <Download className="h-3.5 w-3.5" strokeWidth={2.25} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div>
        <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
          <Boxes className="h-3.5 w-3.5" /> Products on this PO
        </h2>
        <div className="space-y-3">
          {po.items.map((item) => (
            <ProductLineItem key={item.id} poId={po.id} item={item} poStatus={po.status} />
          ))}
        </div>
        {hasRole("BD") && <AddLineItemForm poId={po.id} />}
      </div>
    </div>
  );
}

// BD's Approve/Reject action on a still-Draft PO — the one review step
// before it's forwarded to PPIC/RM to release and plan against. Once
// reviewed, shows the decision (and reason, if rejected) instead.
function ReviewPanel({ po }: { po: PurchaseOrder }) {
  const { hasRole } = useAuth();
  const review = useReviewPurchaseOrder(po.id);
  const toast = useToast();
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (po.status === "APPROVED") {
    return (
      <div className="mt-4 flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs font-bold text-emerald-700">
        <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} /> Approved by {po.reviewedBy?.fullName ?? "BD"}
        {po.reviewedAt && ` · ${new Date(po.reviewedAt).toLocaleDateString()}`} — PPIC can release batches against this PO.
      </div>
    );
  }
  if (po.status === "REJECTED") {
    return (
      <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-bold text-rose-700">
        <p className="flex items-center gap-1.5">
          <X className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} /> Rejected by {po.reviewedBy?.fullName ?? "BD"}
          {po.reviewedAt && ` · ${new Date(po.reviewedAt).toLocaleDateString()}`}
        </p>
        {po.rejectionReason && <p className="mt-1 font-medium text-rose-600">{po.rejectionReason}</p>}
      </div>
    );
  }

  // status === "DRAFT"
  if (!hasRole("BD")) {
    return (
      <div className="mt-4 flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs font-bold text-slate-500">
        <Lock className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} /> Awaiting BD approval — batches can't be released until this PO is approved.
      </div>
    );
  }

  async function handleReview(status: "APPROVED" | "REJECTED") {
    setError(null);
    if (status === "REJECTED" && !reason.trim()) {
      setError("A reason is required when rejecting a PO.");
      return;
    }
    try {
      await review.mutateAsync({ status, rejectionReason: status === "REJECTED" ? reason.trim() : undefined });
      toast.success(status === "APPROVED" ? "PO approved — forwarded to PPIC/RM." : "PO rejected.");
      setShowReject(false);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not save review";
      setError(msg);
      toast.error(msg);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-3.5">
      <p className="text-xs font-bold text-amber-800">Draft — approve to forward this PO to PPIC/RM, or reject it.</p>
      {showReject ? (
        <div className="mt-2">
          <textarea
            className="field min-h-[3.5rem] resize-y"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Required — why is this PO being rejected?"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setShowReject(false)}>
              Cancel
            </button>
            <button type="button" className="btn-danger btn-sm" disabled={review.isPending} onClick={() => handleReview("REJECTED")}>
              {review.isPending ? "Rejecting…" : "Confirm Reject"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" className="btn-ghost btn-sm" onClick={() => setShowReject(true)}>
            <X className="h-3 w-3" strokeWidth={2.5} /> Reject
          </button>
          <button type="button" className="btn-primary btn-sm" disabled={review.isPending} onClick={() => handleReview("APPROVED")}>
            <Check className="h-3 w-3" strokeWidth={2.5} /> {review.isPending ? "Approving…" : "Approve"}
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs font-bold text-rose-600">{error}</p>}
    </div>
  );
}

// The real-world flow, made visible: every product on a PO moves through
// BOM planning, RM costing, and Batch execution (the batch's own pipeline
// — Order Tracking through Dispatch, one flow, see BatchDetailPage) — this
// strip is the one place that shows both planning modules at once, with a
// one-click way to start whichever hasn't happened yet. BOM/RM Costing
// nodes are only shown to roles that actually have those modules (same
// gate AppLayout's nav tabs already use) — a department with no route to
// Packaging BOM or RM Costing shouldn't see their status here either.
function ProductionPipeline({ item, batches }: { item: PurchaseOrderItem; batches: Batch[] }) {
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const createBomPlan = useCreateBomPlan();
  const createRmPlan = useCreateRmPlan();

  const bomPlan = item.bomPlans?.[0];
  const rmPlan = item.rmPlans?.[0];
  const canSeeBom = hasRole("PPIC", "PURCHASE");
  const canSeeRm = hasRole("PPIC", "BD");

  return (
    <div className="mt-3 flex items-center gap-1.5 overflow-x-auto border-t border-slate-100 pt-3 scrollbar-none">
      {canSeeBom && (
        <>
          {bomPlan ? (
            <Link to={`/packaging-bom?plan=${bomPlan.id}`} className="pill shrink-0 border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100">
              <Package className="h-3 w-3" strokeWidth={2.5} /> BOM · {bomPlan.status === "CALCULATED" ? "Calculated" : "Draft"}
            </Link>
          ) : (
            <button
              className="pill shrink-0 border-slate-200 bg-slate-50 text-slate-400 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-600"
              disabled={createBomPlan.isPending}
              onClick={async () => {
                const plan = await createBomPlan.mutateAsync({ name: `${item.productName} — BOM`, purchaseOrderItemId: item.id });
                toast.success("BOM plan created and linked.");
                navigate(`/packaging-bom?plan=${plan.id}`);
              }}
            >
              <Circle className="h-3 w-3" strokeWidth={2.5} /> Start BOM Plan
            </button>
          )}
          <ArrowRight className="h-3 w-3 shrink-0 text-slate-300" strokeWidth={2.5} />
        </>
      )}

      {canSeeRm && (
        <>
          {rmPlan ? (
            <Link to={`/rm-costing?plan=${rmPlan.id}`} className="pill shrink-0 border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100">
              <FlaskConical className="h-3 w-3" strokeWidth={2.5} /> RM Costing · {rmPlan.status === "CALCULATED" ? "Calculated" : "Draft"}
            </Link>
          ) : (
            <button
              className="pill shrink-0 border-slate-200 bg-slate-50 text-slate-400 hover:border-amber-200 hover:bg-amber-50 hover:text-amber-600"
              disabled={createRmPlan.isPending}
              onClick={async () => {
                const plan = await createRmPlan.mutateAsync({ name: `${item.productName} — RM Costing`, purchaseOrderItemId: item.id });
                toast.success("RM plan created and linked.");
                navigate(`/rm-costing?plan=${plan.id}`);
              }}
            >
              <Circle className="h-3 w-3" strokeWidth={2.5} /> Start RM Costing
            </button>
          )}
          <ArrowRight className="h-3 w-3 shrink-0 text-slate-300" strokeWidth={2.5} />
        </>
      )}

      {batches.length > 0 ? (
        <span className="pill shrink-0 border-blue-200 bg-blue-50 text-blue-700">
          <Truck className="h-3 w-3" strokeWidth={2.5} /> {batches.length} Batch{batches.length > 1 ? "es" : ""}
        </span>
      ) : (
        <span className="pill shrink-0 border-slate-200 bg-slate-50 text-slate-400">
          <Circle className="h-3 w-3" strokeWidth={2.5} /> No Batches Yet
        </span>
      )}
    </div>
  );
}

function ProductLineItem({ poId, item, poStatus }: { poId: string; item: PurchaseOrderItem; poStatus: PurchaseOrder["status"] }) {
  const { hasRole } = useAuth();
  const { data: batches } = useBatches(item.id);
  const createBatch = useCreateBatch();
  const removeItem = useRemovePurchaseOrderItem(poId);
  const toast = useToast();
  const [batchNo, setBatchNo] = useState("");
  const [showNewBatch, setShowNewBatch] = useState(false);
  const isApproved = poStatus === "APPROVED";

  return (
    <div className="card-hover card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="stat-icon h-9 w-9 bg-violet-50 text-violet-600">
            <Beaker className="h-4 w-4" strokeWidth={2} />
          </div>
          <div>
            <p className="font-bold text-slate-800">{item.productName}</p>
            <p className="text-xs text-slate-500">
              {item.dosageForm && `${item.dosageForm} · `}
              <span className="font-mono font-bold text-slate-600">
                {item.quantity} {item.unit}
              </span>
              {item.volume ? ` · Vol ${item.volume}` : ""}
              {item.packSize && ` · ${item.packSize} ${item.packType ?? ""}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasRole("PPIC") &&
            (isApproved ? (
              <button className="btn-ghost btn-sm" onClick={() => setShowNewBatch((s) => !s)}>
                <Plus className="h-3 w-3" strokeWidth={2.5} /> New Batch
              </button>
            ) : (
              <span className="pill border-slate-200 bg-slate-50 text-slate-400" title="This PO needs BD approval before a batch can be released.">
                <Lock className="h-3 w-3" strokeWidth={2.5} /> Awaiting PO Approval
              </span>
            ))}
          {hasRole("BD") && (batches?.length ?? 0) === 0 && (
            <button
              className="btn-icon hover:!bg-rose-50 hover:!text-rose-600"
              onClick={async () => {
                await removeItem.mutateAsync(item.id);
                toast.success(`${item.productName} removed from this PO.`);
              }}
              title="Remove product"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>

      <ProductionPipeline item={item} batches={batches ?? []} />

      {showNewBatch && (
        <div className="mt-3 flex gap-2 border-t border-slate-100 pt-3">
          <input className="field" placeholder="Batch No. (optional)" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />
          <button
            className="btn-primary shrink-0"
            onClick={async () => {
              await createBatch.mutateAsync({ purchaseOrderItemId: item.id, batchNo: batchNo || undefined });
              setBatchNo("");
              setShowNewBatch(false);
              toast.success("Batch created.");
            }}
          >
            Create
          </button>
        </div>
      )}

      {(batches?.length ?? 0) > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
          {batches!.map((b) => (
            <Link
              key={b.id}
              to={`/batches/${b.id}`}
              className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs transition-all hover:border-brand-300 hover:shadow-soft"
            >
              <span className="font-bold text-slate-700">{b.batchNo ?? b.id.slice(0, 8)}</span>
              <span className="flex items-center gap-2">
                <DelayBadge delay={b.delay} />
                <StageBadge stage={b.currentStageId} />
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function AddLineItemForm({ poId }: { poId: string }) {
  const addItem = useAddPurchaseOrderItem(poId);
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [productName, setProductName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("KG");

  if (!show) {
    return (
      <button className="btn-ghost mt-3" onClick={() => setShow(true)}>
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Add More Products To This PO
      </button>
    );
  }

  return (
    <div className="card animate-slide-up mt-3 flex flex-wrap items-end gap-2 p-4">
      <div className="min-w-[10rem] flex-1">
        <label className="label">Product</label>
        <input className="field" value={productName} onChange={(e) => setProductName(e.target.value)} />
      </div>
      <div className="w-28">
        <label className="label">Quantity</label>
        <input className="field font-mono" type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </div>
      <div className="w-24">
        <label className="label">Unit</label>
        <select className="field" value={unit} onChange={(e) => setUnit(e.target.value)}>
          <option>KG</option>
          <option>SKU</option>
          <option>Litres</option>
          <option>Other</option>
        </select>
      </div>
      <button
        className="btn-primary"
        onClick={async () => {
          if (!productName.trim() || !quantity) return;
          await addItem.mutateAsync({ productName: productName.trim(), quantity: Number(quantity), unit });
          setProductName("");
          setQuantity("");
          setShow(false);
          toast.success(`${productName.trim()} added to this PO.`);
        }}
      >
        Add
      </button>
      <button className="btn-ghost" onClick={() => setShow(false)}>
        Cancel
      </button>
    </div>
  );
}
