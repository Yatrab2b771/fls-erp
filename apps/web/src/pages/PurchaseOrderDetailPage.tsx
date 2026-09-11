import { useMemo, useState, type ChangeEvent } from "react";
import { Link, useParams } from "react-router-dom";
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
  FileSpreadsheet,
  FileStack,
  FlaskConical,
  Lock,
  Package,
  Plus,
  Receipt,
  Scale,
  ShieldCheck,
  Sparkles,
  Truck,
  Upload,
  X,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useAddPurchaseOrderItem,
  useAllProductNames,
  usePreProductions,
  useCreatePreProduction,
  useCreateBomPlan,
  useCreatePlant,
  useCreateRmPlan,
  useCreateSku,
  useGeneratePoInvoice,
  usePlants,
  usePoBilling,
  usePoReconciliation,
  usePurchaseOrder,
  useRemovePurchaseOrderItem,
  useReportCatalogMismatch,
  useReviewPurchaseOrder,
  useSkus,
  useUploadPoDocument,
} from "../lib/hooks";
import { StageBadge, DelayBadge, PoStatusBadge } from "../components/Badges";
import { EmptyState } from "../components/EmptyState";
import { ItemPicker } from "../components/ItemPicker";
import { PickerWithAdd } from "../components/PickerWithAdd";
import { downloadFile, ApiError } from "../lib/api";
import { findSimilarName } from "../lib/similarName";
import { useToast } from "../components/Toast";
import type { BomPlan, PoReadinessItem, ProductType, PurchaseOrder, PurchaseOrderItem, RmPlan } from "../lib/types";

const UNIT_ITEMS = [
  { id: "KG", name: "KG" },
  { id: "SKU", name: "SKU" },
  { id: "Litres", name: "Litres" },
  { id: "Other", name: "Other" },
];

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
                {po.completion.isCompleted && (
                  <span
                    className="pill border-emerald-200 bg-emerald-50 text-emerald-700"
                    title={po.completion.completionDate ? `Every batch shipped & customer-confirmed by ${new Date(po.completion.completionDate).toLocaleDateString()}` : undefined}
                  >
                    {po.completion.daysTaken !== null ? `Completed in ${po.completion.daysTaken} day${po.completion.daysTaken === 1 ? "" : "s"}` : "Completed"}
                  </span>
                )}
              </div>
              <p className="text-sm text-slate-500">{po.customer.companyName}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="pill border-slate-200 bg-slate-50 text-slate-600">
              <ShieldCheck className="h-3 w-3" /> {po.regulatoryBody ?? "No body"} · {po.regulatoryStatus ?? "—"}
            </span>
            <span className="pill border-slate-200 bg-slate-50 text-slate-600">
              <Calendar className="h-3 w-3" /> {po.orderDate ? new Date(po.orderDate).toLocaleDateString() : "No date"}
            </span>
            <span className="pill border-slate-200 bg-slate-50 text-slate-600">
              <Calendar className="h-3 w-3" /> Delivery: {po.expectedDeliveryDate ? new Date(po.expectedDeliveryDate).toLocaleDateString() : "No date"}
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
        {hasRole("BD") && <AddLineItemForm poId={po.id} customerId={po.customerId} customerName={po.customer.companyName} />}
      </div>

      <PoReconciliationPanel poId={po.id} />
      {hasRole("PURCHASE", "ACCOUNTS") && <PoBillingPanel poId={po.id} canGenerate={hasRole("ACCOUNTS")} />}
    </div>
  );
}

// One small labeled number — the building block of PoReconciliationPanel
// below. A flat grid of these (instead of one wide table) is what
// actually stays readable on a phone: each metric wraps onto its own
// line with its label right above it, nothing needs a horizontal
// scrollbar to be read.
function MiniStat({ label, value, unit, accent = "slate" }: { label: string; value: number; unit?: string; accent?: "slate" | "sky" | "amber" | "rose" | "violet" | "emerald" }) {
  const color: Record<string, string> = {
    slate: "text-slate-700",
    sky: "text-sky-700",
    amber: "text-amber-700",
    rose: "text-rose-600",
    violet: "text-violet-700",
    emerald: "text-emerald-700",
  };
  return (
    <div className="rounded-lg bg-slate-50/70 px-2.5 py-2">
      <p className="truncate text-[9.5px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-0.5 font-mono text-sm font-bold ${color[accent]}`}>
        {value}
        {unit ? <span className="ml-1 text-[10px] font-normal text-slate-400">{unit}</span> : null}
      </p>
    </div>
  );
}

// Phase G — one PO-level rollup combining every one of this PO's line
// items' batches: how much is planned vs ordered, RM/PM dispensed three
// ways, what went to QC and what it resolved to, Production's own
// recorded output, both QA gates' Rejected/Wastage split (Phase F), and
// what Dispatch Plan shipped. See purchase-orders.routes.ts GET
// /:id/reconciliation. Rendered as grouped metric cards, not one wide
// table — a 14-column table has no readable mobile layout even with
// horizontal scroll; a grid of small labeled numbers wraps naturally at
// any width instead.
function PoReconciliationPanel({ poId }: { poId: string }) {
  const { data, isLoading } = usePoReconciliation(poId);
  const [open, setOpen] = useState(false);

  if (isLoading) return null;
  if (!data || data.items.every((r) => r.plannedQtyTotal === 0)) return null; // nothing planned yet — no production started, nothing to reconcile

  return (
    <div className="card overflow-hidden">
      <button type="button" className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left" onClick={() => setOpen((o) => !o)}>
        <h2 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
          <Scale className="h-3.5 w-3.5" /> Material Reconciliation — this PO
        </h2>
        <ArrowRight className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 p-3.5 sm:p-4">
          <ReconciliationRowCard title="All products" subtitle="Combined across every line item" row={data.totals} unit="" highlight />
          {data.items.map((item) => (
            <ReconciliationRowCard
              key={item.purchaseOrderItemId}
              title={item.productName}
              subtitle={`Ordered ${item.orderedQty} ${item.unit}${item.productionBatches.length > 0 ? ` · ${item.productionBatches.length} production run${item.productionBatches.length === 1 ? "" : "s"}` : ""}`}
              row={item}
              unit={item.unit}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReconciliationRowCard({
  title,
  subtitle,
  row,
  unit,
  highlight = false,
}: {
  title: string;
  subtitle: string;
  row: {
    plannedQtyTotal: number;
    dispensedProduction: number;
    dispensedSample: number;
    dispensedWaste: number;
    sampleSentToQc: number;
    sampleTestingQty: number;
    sampleWastageQty: number;
    sampleRejectedQty: number;
    outputQty: number;
    mfgRejectedQty: number;
    mfgWastageQty: number;
    packRejectedQty: number;
    packWastageQty: number;
    dispatchedQty: number;
  };
  unit: string;
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-3 ${highlight ? "border-brand-200 bg-brand-50/40" : "border-slate-200 bg-white"}`}>
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="font-bold text-slate-800">{title}</p>
        <p className="text-[11px] text-slate-500">{subtitle}</p>
      </div>

      <div className="space-y-2.5">
        <MetricGroup label="Dispensing">
          <MiniStat label="Planned" value={row.plannedQtyTotal} unit={unit} />
          <MiniStat label="To Production" value={row.dispensedProduction} unit={unit} />
          <MiniStat label="To QC Sample" value={row.dispensedSample} unit={unit} accent="sky" />
          <MiniStat label="Wasted" value={row.dispensedWaste} unit={unit} accent="amber" />
        </MetricGroup>

        <MetricGroup label="QC Sample">
          <MiniStat label="Sent to QC" value={row.sampleSentToQc} unit={unit} accent="sky" />
          <MiniStat label="Testing" value={row.sampleTestingQty} unit={unit} accent="violet" />
          <MiniStat label="Wastage" value={row.sampleWastageQty} unit={unit} accent="amber" />
          <MiniStat label="Rejected" value={row.sampleRejectedQty} unit={unit} accent="rose" />
        </MetricGroup>

        <MetricGroup label="Production & QA Gates">
          <MiniStat label="Output" value={row.outputQty} unit={unit} />
          <MiniStat label="Mfg Rejected" value={row.mfgRejectedQty} unit={unit} accent="rose" />
          <MiniStat label="Mfg Wastage" value={row.mfgWastageQty} unit={unit} accent="amber" />
          <MiniStat label="Pack Rejected" value={row.packRejectedQty} unit={unit} accent="rose" />
          <MiniStat label="Pack Wastage" value={row.packWastageQty} unit={unit} accent="amber" />
        </MetricGroup>

        <MetricGroup label="Dispatch">
          <MiniStat label="Dispatched" value={row.dispatchedQty} unit={unit} accent="emerald" />
        </MetricGroup>
      </div>
    </div>
  );
}

// PO-level consolidated Billing — one commercial invoice for the whole
// PO, separate from each Batch's own per-shipment Billing & E-Way Bill
// stage. See purchase-orders.routes.ts GET/POST /:id/billing and its own
// comment on the Price-per-Pouch x estimated-pouches-shipped formula.
// Purchase can see the live preview; only Accounts can commit it as a
// saved invoice.
function PoBillingPanel({ poId, canGenerate }: { poId: string; canGenerate: boolean }) {
  const { data, isLoading } = usePoBilling(poId);
  const generate = useGeneratePoInvoice(poId);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");

  if (isLoading) return null;
  if (!data || data.lines.every((l) => l.dispatchedQtyKg === 0)) return null; // nothing dispatched yet — nothing to bill

  async function handleGenerate() {
    try {
      await generate.mutateAsync({ invoiceNo: invoiceNo.trim() || undefined, invoiceDate: invoiceDate || undefined });
      toast.success("Invoice generated.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not generate the invoice");
    }
  }

  const fmt = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

  return (
    <div className="card overflow-hidden">
      <button type="button" className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left" onClick={() => setOpen((o) => !o)}>
        <h2 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
          <Receipt className="h-3.5 w-3.5" /> Billing — this PO
        </h2>
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-bold text-brand-700">{fmt(data.totalAmount)}</span>
          <ArrowRight className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`} />
        </div>
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 p-3.5 sm:p-4">
          {data.invoice && (
            <p className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">
              <Receipt className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
              Saved — {data.invoice.invoiceNo || "no invoice no. yet"}
              {data.invoice.invoiceDate && <> · {new Date(data.invoice.invoiceDate).toLocaleDateString()}</>} · by {data.invoice.generatedBy.fullName}
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] font-bold uppercase tracking-wide text-slate-400">
                  <th className="pb-1.5 pr-2">Product</th>
                  <th className="pb-1.5 pr-2">Dispatched</th>
                  <th className="pb-1.5 pr-2">Price/Pouch</th>
                  <th className="pb-1.5 pr-2">Est. Pouches</th>
                  <th className="pb-1.5 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.purchaseOrderItemId} className="border-t border-slate-100">
                    <td className="py-1.5 pr-2 font-bold text-slate-700">{l.productName}</td>
                    <td className="py-1.5 pr-2 font-mono text-slate-600">
                      {l.dispatchedQtyKg} {l.unit}
                    </td>
                    {l.priced ? (
                      <>
                        <td className="py-1.5 pr-2 font-mono text-slate-600">{fmt(l.pricePerPouch!)}</td>
                        <td className="py-1.5 pr-2 font-mono text-slate-600">{l.estimatedPouches}</td>
                        <td className="py-1.5 text-right font-mono font-bold text-slate-700">{fmt(l.amount!)}</td>
                      </>
                    ) : (
                      <td className="py-1.5 text-right text-slate-400" colSpan={3}>
                        No RM Costing plan yet — can't be priced this way
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-200">
                  <td colSpan={4} className="pt-1.5 text-right text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    Total
                  </td>
                  <td className="pt-1.5 text-right font-mono text-sm font-bold text-brand-700">{fmt(data.totalAmount)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {canGenerate && (
            <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
              <div>
                <label className="label">Invoice No.</label>
                <input className="field font-mono" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder={data.invoice?.invoiceNo ?? "INV-…"} />
              </div>
              <div>
                <label className="label">Invoice Date</label>
                <input type="date" className="field" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
              </div>
              <button type="button" className="btn-primary btn-sm" disabled={generate.isPending} onClick={handleGenerate}>
                {generate.isPending ? "Generating…" : data.invoice ? "Regenerate Invoice" : "Generate Invoice"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One labeled cluster of MiniStats — the grid itself wraps at
// grid-cols-2 on phones up to grid-cols-4/5 on wider screens, so a
// cluster never needs its own horizontal scroll at any width.
function MetricGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-5">{children}</div>
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
// — Order Tracking through Dispatch, one flow, see BatchDetailPage). BD's
// job ends at Approve/Reject — planning is PPIC's department from there
// (matches the reference flow: "Hand-off: Approved PO becomes visible to
// PPIC"), so Generate is PPIC-only (BOM also lets PURCHASE trigger it,
// same as the rest of the Packaging BOM module). BD still sees the
// resulting pills/breakdown once PPIC has generated them — visibility,
// not the trigger.
function ProductionPipeline({ item, hasStarted }: { item: PurchaseOrderItem; hasStarted: boolean }) {
  const { hasRole } = useAuth();
  const toast = useToast();
  const createBomPlan = useCreateBomPlan();
  const createRmPlan = useCreateRmPlan();
  // Freshly-generated results, held locally so a match that calculates
  // instantly shows its numbers right here the moment Generate resolves
  // — no navigation, no waiting for the PO to refetch. Once a plan
  // already exists (bomPlan/rmPlan below, from the PO's own data) its
  // pill takes over as the source of truth across reloads.
  const [justGenerated, setJustGenerated] = useState<{ bom?: BomPlan; rm?: RmPlan }>({});
  const bomResult = justGenerated.bom?.result;
  const batch = justGenerated.rm?.result?.batches[0];

  const bomPlan = item.bomPlans?.[0];
  const rmPlan = item.rmPlans?.[0];
  // Who can SEE a plan's pill/result once it exists — BD included, so
  // they can check status after approving. Separate from who can
  // GENERATE one — BD can view, not trigger.
  const canSeeBom = hasRole("PPIC", "PURCHASE", "BD");
  const canSeeRm = hasRole("PPIC", "BD");
  const canGenerateBom = hasRole("PPIC", "PURCHASE");
  const canGenerateRm = hasRole("PPIC");

  const needsBom = canGenerateBom && !bomPlan;
  const needsRm = canGenerateRm && !rmPlan;
  const generating = createBomPlan.isPending || createRmPlan.isPending;

  // One click, both engines: creates whichever of the two links doesn't
  // exist yet for this product. Each one auto-matches the PO product's
  // name against the BOM/Recipe catalog server-side and calculates
  // immediately when it finds exactly one match — see bom-plan.routes.ts
  // / rm-plan.routes.ts POST /plans. No match just leaves that one as an
  // empty Draft, same as before this existed — nothing to show inline
  // for it yet, only its pill (below) linking to the full page to finish
  // by hand.
  async function handleGenerate() {
    try {
      const [bom, rm] = await Promise.all([
        needsBom ? createBomPlan.mutateAsync({ name: `${item.productName} — BOM`, purchaseOrderItemId: item.id }) : Promise.resolve(undefined),
        needsRm ? createRmPlan.mutateAsync({ name: `${item.productName} — RM Costing`, purchaseOrderItemId: item.id }) : Promise.resolve(undefined),
      ]);
      setJustGenerated({ bom, rm });
      const calculated = [bom?.status === "CALCULATED" && "BOM", rm?.status === "CALCULATED" && "RM Costing"].filter(Boolean);
      toast.success(calculated.length ? `Generated — ${calculated.join(" + ")} calculated instantly.` : "Plan(s) created — no catalog match yet, add the SKU/Recipe by hand.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not generate");
    }
  }

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
        {canSeeBom && (
          <>
            {bomPlan ? (
              <Link to={`/packaging-bom?plan=${bomPlan.id}`} className="pill shrink-0 border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100">
                <Package className="h-3 w-3" strokeWidth={2.5} /> BOM · {bomPlan.status === "CALCULATED" ? "Calculated" : "Draft"}
              </Link>
            ) : justGenerated.bom ? (
              <Link to={`/packaging-bom?plan=${justGenerated.bom.id}`} className="pill shrink-0 border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100">
                <Package className="h-3 w-3" strokeWidth={2.5} /> BOM · {justGenerated.bom.status === "CALCULATED" ? "Calculated" : "Draft"}
              </Link>
            ) : null}
            {(bomPlan || justGenerated.bom) && <ArrowRight className="h-3 w-3 shrink-0 text-slate-300" strokeWidth={2.5} />}
          </>
        )}

        {canSeeRm && (
          <>
            {rmPlan ? (
              <Link to={`/rm-costing?plan=${rmPlan.id}`} className="pill shrink-0 border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100">
                <FlaskConical className="h-3 w-3" strokeWidth={2.5} /> RM Costing · {rmPlan.status === "CALCULATED" ? "Calculated" : "Draft"}
              </Link>
            ) : justGenerated.rm ? (
              <Link to={`/rm-costing?plan=${justGenerated.rm.id}`} className="pill shrink-0 border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100">
                <FlaskConical className="h-3 w-3" strokeWidth={2.5} /> RM Costing · {justGenerated.rm.status === "CALCULATED" ? "Calculated" : "Draft"}
              </Link>
            ) : null}
            {(rmPlan || justGenerated.rm) && <ArrowRight className="h-3 w-3 shrink-0 text-slate-300" strokeWidth={2.5} />}
          </>
        )}

        {(needsBom && !justGenerated.bom) || (needsRm && !justGenerated.rm) ? (
          <button
            className="pill shrink-0 border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100"
            disabled={generating}
            onClick={handleGenerate}
          >
            <Sparkles className="h-3 w-3" strokeWidth={2.5} /> {generating ? "Generating…" : "Generate"}
          </button>
        ) : null}
        {((needsBom && !justGenerated.bom) || (needsRm && !justGenerated.rm)) && <ArrowRight className="h-3 w-3 shrink-0 text-slate-300" strokeWidth={2.5} />}

        {hasStarted ? (
          <span className="pill shrink-0 border-blue-200 bg-blue-50 text-blue-700">
            <Truck className="h-3 w-3" strokeWidth={2.5} /> In Production
          </span>
        ) : (
          <span className="pill shrink-0 border-slate-200 bg-slate-50 text-slate-400">
            <Circle className="h-3 w-3" strokeWidth={2.5} /> Not Started
          </span>
        )}
      </div>

      {/* "Show instantly at this place" — the full materials + cost
          breakdown from both engines, right under the pipeline pills, no
          navigation required. RM's ingredient list is the real per-batch
          usage the RM Costing engine computed; BOM's component list is
          the real per-batch packaging quantities the BOM engine
          computed — packagingTotal (₹) below is a separate thing, RM
          Costing's own flat Jar/Scoop/Label/... cost inputs, not derived
          from BOM's actual component list (the two modules don't share a
          cost figure today), so it's labeled accordingly rather than
          implied to be the same number. */}
      {(bomResult || batch) && (
        <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wide text-slate-500">
            <Sparkles className="h-3.5 w-3.5 text-brand-500" strokeWidth={2.5} /> Generated — Materials &amp; Cost Breakdown
          </p>

          {batch && justGenerated.rm && (
            <div>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] font-bold text-amber-700">
                  Raw Material (RM) used — {batch.batchSizeKg} Kg batch, {batch.servingsPerBatch.toFixed(0)} pouches
                </p>
                <div className="flex gap-1.5">
                  <button
                    className="btn-ghost btn-sm !py-1 !text-[10px]"
                    onClick={() => downloadFile(`/api/rm-costing/plans/${justGenerated.rm!.id}/export.xlsx`, `FLS_RM_Costing_${justGenerated.rm!.id}.xlsx`)}
                  >
                    <FileSpreadsheet className="h-3 w-3" strokeWidth={2.5} /> Excel
                  </button>
                  <button
                    className="btn-ghost btn-sm !py-1 !text-[10px]"
                    onClick={() => downloadFile(`/api/rm-costing/plans/${justGenerated.rm!.id}/export.pdf`, `FLS_RM_Master_${justGenerated.rm!.id}.pdf`)}
                  >
                    <FileSpreadsheet className="h-3 w-3" strokeWidth={2.5} /> PDF
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto rounded-lg border border-amber-100 bg-white">
                <table className="w-full text-[11px]">
                  <thead className="bg-amber-50 text-amber-800">
                    <tr>
                      <th className="px-2 py-1 text-left font-bold">Ingredient</th>
                      <th className="px-2 py-1 text-left font-bold">Brand</th>
                      <th className="px-2 py-1 text-right font-bold">Qty (Kg)</th>
                      <th className="px-2 py-1 text-right font-bold">Cost (₹)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batch.ingredients.map((ing, idx) => (
                      <tr key={idx} className="border-t border-amber-50">
                        <td className="px-2 py-1 font-semibold text-slate-700">{ing.name}</td>
                        <td className="px-2 py-1 text-slate-500">{ing.brand}</td>
                        <td className="px-2 py-1 text-right font-mono">{ing.qtyInKg.toFixed(3)}</td>
                        <td className="px-2 py-1 text-right font-mono">₹{ing.amount.toFixed(0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {bomResult && justGenerated.bom && (
            <div>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] font-bold text-emerald-700">Packaging (PM) needed — target yield {bomResult.totalYield}</p>
                <div className="flex gap-1.5">
                  <button
                    className="btn-ghost btn-sm !py-1 !text-[10px]"
                    onClick={() => downloadFile(`/api/bom/plans/${justGenerated.bom!.id}/export.xlsx`, `FLS_Master_BOM_${justGenerated.bom!.id}.xlsx`)}
                  >
                    <FileSpreadsheet className="h-3 w-3" strokeWidth={2.5} /> Excel
                  </button>
                  <button
                    className="btn-ghost btn-sm !py-1 !text-[10px]"
                    onClick={() => downloadFile(`/api/bom/plans/${justGenerated.bom!.id}/export.pdf`, `FLS_Master_BOM_${justGenerated.bom!.id}.pdf`)}
                  >
                    <FileSpreadsheet className="h-3 w-3" strokeWidth={2.5} /> PDF
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto rounded-lg border border-emerald-100 bg-white">
                <table className="w-full text-[11px]">
                  <thead className="bg-emerald-50 text-emerald-800">
                    <tr>
                      <th className="px-2 py-1 text-left font-bold">Component</th>
                      <th className="px-2 py-1 text-left font-bold">Spec</th>
                      <th className="px-2 py-1 text-right font-bold">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bomResult.lines.map((l, idx) => (
                      <tr key={idx} className="border-t border-emerald-50">
                        <td className="px-2 py-1 font-semibold text-slate-700">{l.component}</td>
                        <td className="px-2 py-1 text-slate-500">{l.spec}</td>
                        <td className="px-2 py-1 text-right font-mono">{l.totalQty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {batch && (
            <div className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2">
              <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-brand-700">End-to-End Cost — RM → Testing → Mfg Loss → Packaging → Profit → GST</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-slate-600 sm:grid-cols-3">
                <p>
                  RM Cost: <span className="font-mono font-bold text-slate-800">₹{batch.totalRmCost.toFixed(0)}</span>
                </p>
                <p>
                  + Testing: <span className="font-mono font-bold text-slate-800">₹{batch.testCost.toFixed(0)}</span>
                </p>
                <p>
                  + Mfg Loss: <span className="font-mono font-bold text-slate-800">₹{batch.mfgLossAmount.toFixed(0)}</span>
                </p>
                <p>
                  + Packaging<sup>*</sup>: <span className="font-mono font-bold text-slate-800">₹{batch.packagingTotal.toFixed(0)}</span>
                </p>
                <p>
                  + Profit: <span className="font-mono font-bold text-slate-800">₹{batch.profitAmount.toFixed(0)}</span>
                </p>
                <p>
                  + GST: <span className="font-mono font-bold text-slate-800">₹{batch.gstAmount.toFixed(0)}</span>
                </p>
              </div>
              <p className="mt-1 text-[9px] text-slate-400">*From the Costing Profile's Jar/Scoop/Label/Conversion/CCB inputs — a flat estimate, not derived from the packaging table above.</p>
              <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 border-t border-brand-200 pt-2">
                <p className="text-xs text-slate-600">
                  Price / Pouch: <span className="font-mono font-black text-brand-700">₹{batch.pricePerPouch.toFixed(2)}</span>
                </p>
                <p className="text-sm text-slate-700">
                  Total for this batch ({batch.servingsPerBatch.toFixed(0)} pouches):{" "}
                  <span className="font-mono font-black text-brand-700">₹{(batch.pricePerPouch * batch.servingsPerBatch).toFixed(0)}</span>
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProductLineItem({ poId, item, poStatus }: { poId: string; item: PurchaseOrderItem; poStatus: PurchaseOrder["status"] }) {
  const { hasRole } = useAuth();
  const { data: preProductions } = usePreProductions(item.id);
  const run = preProductions?.[0];
  const { data: plants } = usePlants();
  const createPlant = useCreatePlant();
  const createPreProduction = useCreatePreProduction();
  const removeItem = useRemovePurchaseOrderItem(poId);
  const toast = useToast();
  const [plantId, setPlantId] = useState("");
  const [showStart, setShowStart] = useState(false);
  const isApproved = poStatus === "APPROVED";

  async function handleStartProduction(confirmNotReady = false) {
    try {
      await createPreProduction.mutateAsync({ purchaseOrderItemId: item.id, plantId: plantId || undefined, confirmNotReady });
      setPlantId("");
      setShowStart(false);
      toast.success("Production started.");
    } catch (err) {
      // The PO Readiness soft-block — some tracked RM/PM items are short
      // of stock. Not final: offer the explicit override instead of just
      // failing, same shape as Dispatch Plan's partial-shipment 409.
      const shortItems = (err instanceof ApiError && (err.details as { items?: PoReadinessItem[] } | undefined)?.items) || null;
      if (shortItems && shortItems.length > 0) {
        const list = shortItems.map((i) => `• ${i.itemName} — needs ${i.requiredQty} ${i.unit}, only ${i.onHand} on hand`).join("\n");
        const proceed = window.confirm(`This PO isn't showing as material-ready yet:\n\n${list}\n\nStart production anyway?`);
        if (proceed) return handleStartProduction(true);
        return;
      }
      toast.error(err instanceof ApiError ? err.message : "Could not start production");
    }
  }

  return (
    <div className="card-hover card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="stat-icon h-9 w-9 bg-violet-50 text-violet-600">
            <Beaker className="h-4 w-4" strokeWidth={2} />
          </div>
          <div>
            <p className="flex items-center gap-1.5 font-bold text-slate-800">
              {item.productName}
              {item.productType === "NEW" && (
                <span className="pill border-violet-200 bg-violet-50 text-[10px] text-violet-700" title="New product or a formulation change — R&D needs to add it before BOM/RM Costing can run.">
                  New Product
                </span>
              )}
            </p>
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
          {/* Starting production is Production's alone — PPIC gets no
              part of this section, not even the locked "Awaiting PO
              Approval" pill. See pre-production.routes.ts's POST / role
              gate. */}
          {hasRole("PRODUCTION") && !run && (isApproved ? (
            <button className="btn-ghost btn-sm" onClick={() => setShowStart((s) => !s)}>
              <Plus className="h-3 w-3" strokeWidth={2.5} /> Start Production
            </button>
          ) : (
            <span className="pill border-slate-200 bg-slate-50 text-slate-400" title="This PO needs BD approval before production can start.">
              <Lock className="h-3 w-3" strokeWidth={2.5} /> Awaiting PO Approval
            </span>
          ))}
          {hasRole("BD") && !run && (
            <button
              className="btn-icon hover:!bg-rose-50 hover:!text-rose-600"
              onClick={async () => {
                if (!window.confirm(`Remove "${item.productName}" from this PO? This can't be undone.`)) return;
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

      <ProductionPipeline item={item} hasStarted={!!run} />

      {showStart && !run && (
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          <p className="text-[11px] text-slate-500">
            Starts one production run covering this item's full ordered quantity — <span className="font-mono font-bold text-slate-600">{item.quantity} {item.unit}</span>.
          </p>
          <PickerWithAdd label="Plant (optional — can be set later)" placeholder="— Which plant runs this —" options={plants ?? []} value={plantId} onChange={setPlantId} onCreate={(name) => createPlant.mutateAsync(name)} />
          <div className="flex justify-end">
            <button className="btn-primary btn-sm" disabled={createPreProduction.isPending} onClick={() => handleStartProduction()}>
              {createPreProduction.isPending ? "Starting…" : "Start Production"}
            </button>
          </div>
        </div>
      )}

      {run && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <Link to={`/pre-productions/${run.id}`} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs transition-all hover:border-brand-300 hover:shadow-soft">
            <span className="font-bold text-slate-700">
              Combined {run.combinedQty} / {run.plannedQty} {item.unit}
            </span>
            <span className="flex items-center gap-2">
              <DelayBadge delay={run.delay} />
              {run.combinedLot ? <StageBadge stage={run.combinedLot.currentStageId} /> : <StageBadge stage={run.currentStageId} />}
            </span>
          </Link>
        </div>
      )}
    </div>
  );
}

function AddLineItemForm({ poId, customerId, customerName }: { poId: string; customerId: string; customerName: string }) {
  const addItem = useAddPurchaseOrderItem(poId);
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [productName, setProductName] = useState("");
  // Strict picker — this PO's own Customer (a real id, set on the
  // header) narrows the options to that customer's real catalog products.
  const createSku = useCreateSku();
  const reportMismatch = useReportCatalogMismatch();
  const { data: customerSkus } = useSkus(customerId);
  // Every product name across the whole catalog, not just this
  // customer's own — same "brand-new customer wants an already-made
  // product" case as the New PO form's own picker.
  const { data: allProductNames } = useAllProductNames();
  const productOptions = useMemo(() => {
    const ownNames = (customerSkus ?? []).map((s) => s.productName);
    const merged = Array.from(new Set([...ownNames, ...(allProductNames ?? [])]));
    return merged.map((name) => ({ id: name, name }));
  }, [customerSkus, allProductNames]);
  const [dosageForm, setDosageForm] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("KG");
  const [volume, setVolume] = useState("");
  const [packSize, setPackSize] = useState("");
  // No longer a form choice — BD doesn't classify this upfront anymore.
  // Always sent as EXISTING; PPIC's Generate button does the real
  // catalog match itself and only then discovers whether it's genuinely new.
  const productType: ProductType = "EXISTING";

  if (!show) {
    return (
      <button className="btn-ghost mt-3" onClick={() => setShow(true)}>
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Add More Products To This PO
      </button>
    );
  }

  return (
    <div className="card animate-slide-up mt-3 grid grid-cols-2 gap-2 p-4 sm:grid-cols-6">
      <div className="sm:col-span-2">
        <PickerWithAdd
          label="Product"
          placeholder="— Select a product —"
          options={productOptions}
          value={productName}
          onChange={setProductName}
          icon={Package}
          addIcon={Plus}
          onCreate={async (name) => {
            const similar = findSimilarName(name, (customerSkus ?? []).map((s) => s.productName));
            if (similar && !window.confirm(`Did you mean the existing product "${similar}"? Click Cancel to use that one, or OK to create "${name}" anyway.`)) {
              reportMismatch.mutate({ kind: "product", typedName: name, matchedName: similar, customerName });
              return { id: similar };
            }
            await createSku.mutateAsync({ customerId, productName: name });
            return { id: name };
          }}
        />
      </div>
      <div>
        <label className="label">Dosage Form (opt.)</label>
        <input className="field" value={dosageForm} onChange={(e) => setDosageForm(e.target.value)} />
      </div>
      <div>
        <label className="label">Quantity</label>
        <input className="field font-mono" type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </div>
      <div>
        <label className="label">Unit</label>
        <ItemPicker items={UNIT_ITEMS} value={unit} onChange={setUnit} clearable={false} />
      </div>
      <div>
        <label className="label">Volume (opt.)</label>
        <input className="field font-mono" type="number" value={volume} onChange={(e) => setVolume(e.target.value)} />
      </div>
      <div className="sm:col-span-6">
        <label className="label">Pack Size (opt., e.g. 1kg)</label>
        <input className="field" value={packSize} onChange={(e) => setPackSize(e.target.value)} />
      </div>
      <div className="flex items-end gap-2 sm:col-span-6">
        <button
          className="btn-primary"
          onClick={async () => {
            if (!productName.trim() || !quantity) return;
            await addItem.mutateAsync({
              productName: productName.trim(),
              dosageForm: dosageForm.trim() || undefined,
              quantity: Number(quantity),
              unit,
              volume: volume ? Number(volume) : undefined,
              packSize: packSize.trim() || undefined,
              productType,
            });
            setProductName("");
            setDosageForm("");
            setQuantity("");
            setVolume("");
            setPackSize("");
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
    </div>
  );
}
