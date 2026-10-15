import { useEffect, useState, type ChangeEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Download, FileText, Lock, Pencil, Upload, X } from "lucide-react";
import { api, ApiError, API_BASE, downloadFile, getToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useReviewPurchaseOrder, usePurchaseOrder, useUpdatePurchaseOrder, useUploadPoDocument } from "../lib/hooks";
import { EmptyState } from "../components/EmptyState";
import { ItemPicker } from "../components/ItemPicker";
import { ProductCategoryPicker } from "../components/ProductCategoryPicker";
import { PoStatusBadge } from "../components/Badges";
import { useToast } from "../components/Toast";
import type { PurchaseOrder, PurchaseOrderItem } from "../lib/types";
import { CustomerName } from "../components/CustomerName";

// The PO as a form: the entered details on the left (editable until the PO is approved), the uploaded PO
// document beside it, and Approve / Reject on top. Opened from BD's "View" - it is not the order tracking page.

const UNIT_ITEMS = [
  { id: "KG", name: "KG" },
  { id: "SKU", name: "SKU" },
];
const BODY_ITEMS = [
  { id: "FSSAI", name: "FSSAI" },
  { id: "AYUSH", name: "AYUSH" },
];
const REG_STATUS_ITEMS = [
  { id: "Applied", name: "Applied" },
  { id: "Not Applied", name: "Not Applied" },
  { id: "Issued", name: "Issued" },
];

interface ItemDraft {
  id: string;
  productName: string;
  productCategory: string;
  quantity: string;
  unit: string;
  packSize: string;
}

function useUpdateItemFields(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, ...body }: { itemId: string; productName?: string; productCategory?: string; quantity?: number; unit?: string; packSize?: string }) =>
      api(`/api/purchase-orders/${poId}/items/${itemId}`, { method: "PATCH", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["purchase-orders", poId] });
    },
  });
}

const dateOnly = (v: string | null) => (v ? v.slice(0, 10) : "");
const showDate = (v: string | null) => (v ? new Date(v).toLocaleDateString("en-IN") : "-");

export function PoReviewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: po, isLoading } = usePurchaseOrder(id);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-6 w-48" />
        <div className="skeleton h-96 w-full" />
      </div>
    );
  }
  if (!po) return <EmptyState icon={FileText} title="Purchase order not found" accent="rose" />;
  return <PoReview po={po} onBack={() => (location.key !== "default" ? navigate(-1) : navigate("/"))} />;
}

function PoReview({ po, onBack }: { po: PurchaseOrder; onBack: () => void }) {
  const toast = useToast();
  const { hasRole } = useAuth();
  const isBd = hasRole("BD");
  const canEdit = isBd && po.status !== "APPROVED";
  const review = useReviewPurchaseOrder(po.id);
  const updatePo = useUpdatePurchaseOrder(po.id);
  const updateItem = useUpdateItemFields(po.id);
  const upload = useUploadPoDocument(po.id);

  const [editing, setEditing] = useState(false);
  const [head, setHead] = useState({ poNumber: "", orderDate: "", expectedDeliveryDate: "", regulatoryBody: "", regulatoryStatus: "" });
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [docId, setDocId] = useState<string>(po.documents[0]?.id ?? "");

  function startEdit() {
    setHead({ poNumber: po.poNumber ?? "", orderDate: dateOnly(po.orderDate), expectedDeliveryDate: dateOnly(po.expectedDeliveryDate), regulatoryBody: po.regulatoryBody ?? "", regulatoryStatus: po.regulatoryStatus ?? "" });
    setItems(po.items.map((i) => ({ id: i.id, productName: i.productName, productCategory: i.productCategory ?? "", quantity: String(i.quantity), unit: i.unit, packSize: i.packSize ?? "" })));
    setEditing(true);
  }

  async function save() {
    for (const d of items) {
      if (!d.productName.trim()) return toast.error("Every product needs a name.");
      if (!(Number(d.quantity) > 0)) return toast.error(`Quantity of "${d.productName}" must be more than 0.`);
      if (d.unit === "SKU" && !d.packSize.trim()) return toast.error(`Enter the pack size of "${d.productName}" (for example 120 g): a SKU order needs it.`);
    }
    try {
      await updatePo.mutateAsync({
        poNumber: head.poNumber.trim() || undefined,
        orderDate: head.orderDate || undefined,
        expectedDeliveryDate: head.expectedDeliveryDate || undefined,
        regulatoryBody: head.regulatoryBody || undefined,
        regulatoryStatus: head.regulatoryStatus || undefined,
      });
      for (const d of items) {
        const old = po.items.find((i) => i.id === d.id);
        if (!old) continue;
        const patch: { productName?: string; productCategory?: string; quantity?: number; unit?: string; packSize?: string } = {};
        if (d.productName.trim() !== old.productName) patch.productName = d.productName.trim();
        if (d.productCategory && d.productCategory !== (old.productCategory ?? "")) patch.productCategory = d.productCategory;
        if (Number(d.quantity) !== old.quantity) patch.quantity = Number(d.quantity);
        if (d.unit !== old.unit) patch.unit = d.unit;
        if (d.packSize.trim() !== (old.packSize ?? "") && d.packSize.trim()) patch.packSize = d.packSize.trim();
        if (Object.keys(patch).length) await updateItem.mutateAsync({ itemId: d.id, ...patch });
      }
      toast.success("PO updated.");
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save the PO");
    }
  }

  async function decide(status: "APPROVED" | "REJECTED") {
    if (status === "REJECTED" && !reason.trim()) return toast.error("Write the reason for rejecting this PO.");
    try {
      await review.mutateAsync({ status, rejectionReason: status === "REJECTED" ? reason.trim() : undefined });
      toast.success(status === "APPROVED" ? "PO approved - forwarded to PPIC." : "PO rejected.");
      setRejecting(false);
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save the decision");
    }
  }

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      await upload.mutateAsync(file);
      toast.success(`${file.name} attached to this PO.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Upload failed");
    }
  }

  const activeDoc = po.documents.find((d) => d.id === docId) ?? po.documents[0];

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Back
      </button>

      {/* Title + decision */}
      <div className="card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-black tracking-tight text-slate-900">{po.poNumber ?? `PO ${po.id.slice(0, 8)}`}</h1>
              <PoStatusBadge status={po.status} />
            </div>
            <p className="text-sm text-slate-500"><CustomerName name={po.customer.companyName} /></p>
          </div>
          {po.status === "DRAFT" && isBd && !rejecting && (
            <div className="flex items-center gap-2">
              <button type="button" className="btn-ghost" disabled={review.isPending} onClick={() => setRejecting(true)}>
                <X className="h-4 w-4" strokeWidth={2.5} /> Reject
              </button>
              <button type="button" className="btn-primary" disabled={review.isPending || editing} title={editing ? "Save or cancel your edits first" : undefined} onClick={() => decide("APPROVED")}>
                <Check className="h-4 w-4" strokeWidth={2.5} /> {review.isPending ? "Approving..." : "Approve"}
              </button>
            </div>
          )}
        </div>

        {rejecting && (
          <div className="mt-3 space-y-2 rounded-xl border border-rose-200 bg-rose-50/60 p-3">
            <label className="label">Reason for rejecting (required)</label>
            <textarea className="field min-h-[4.5rem]" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this PO being rejected?" />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost btn-sm" onClick={() => setRejecting(false)}>Cancel</button>
              <button type="button" className="btn-danger btn-sm" disabled={review.isPending} onClick={() => decide("REJECTED")}>
                {review.isPending ? "Rejecting..." : "Confirm Reject"}
              </button>
            </div>
          </div>
        )}
        {po.status === "APPROVED" && (
          <p className="mt-3 flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">
            <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> Approved by {po.reviewedBy?.fullName ?? "BD"}
            {po.reviewedAt && ` on ${showDate(po.reviewedAt)}`}. PPIC can plan against this PO.
          </p>
        )}
        {po.status === "REJECTED" && (
          <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            <p>Rejected by {po.reviewedBy?.fullName ?? "BD"}{po.reviewedAt && ` on ${showDate(po.reviewedAt)}`}</p>
            {po.rejectionReason && <p className="mt-0.5 font-medium text-rose-600">{po.rejectionReason}</p>}
          </div>
        )}
        {po.status === "DRAFT" && !isBd && (
          <p className="mt-3 flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">
            <Lock className="h-3.5 w-3.5" strokeWidth={2.25} /> Waiting for BD to approve this PO.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* The form */}
        <div className="card p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-tiny font-bold uppercase tracking-wider text-slate-400">PO details</h2>
            {canEdit && !editing && (
              <button type="button" className="btn-ghost btn-sm" onClick={startEdit}>
                <Pencil className="h-3 w-3" strokeWidth={2.5} /> Edit
              </button>
            )}
            {editing && (
              <div className="flex gap-2">
                <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
                <button type="button" className="btn-primary btn-sm" disabled={updatePo.isPending || updateItem.isPending} onClick={save}>
                  {updatePo.isPending || updateItem.isPending ? "Saving..." : "Save"}
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Customer" value={po.customer.companyName} />
            <Field label="PO Number" value={po.poNumber ?? "-"} edit={editing} input={<input className="field" value={head.poNumber} onChange={(e) => setHead({ ...head, poNumber: e.target.value })} />} />
            <Field label="Order Date" value={showDate(po.orderDate)} edit={editing} input={<input type="date" className="field" value={head.orderDate} onChange={(e) => setHead({ ...head, orderDate: e.target.value })} />} />
            <Field label="Expected Delivery" value={showDate(po.expectedDeliveryDate)} edit={editing} input={<input type="date" className="field" value={head.expectedDeliveryDate} onChange={(e) => setHead({ ...head, expectedDeliveryDate: e.target.value })} />} />
            <Field label="Regulatory Body" value={po.regulatoryBody ?? "-"} edit={editing} input={<ItemPicker items={withCurrent(BODY_ITEMS, head.regulatoryBody)} value={head.regulatoryBody} onChange={(v) => setHead({ ...head, regulatoryBody: v })} />} />
            <Field label="Regulatory Status" value={po.regulatoryStatus ?? "-"} edit={editing} input={<ItemPicker items={REG_STATUS_ITEMS} value={head.regulatoryStatus} onChange={(v) => setHead({ ...head, regulatoryStatus: v })} />} />
          </div>

          <h2 className="mb-2 mt-5 text-tiny font-bold uppercase tracking-wider text-slate-400">Products ({po.items.length})</h2>
          <div className="space-y-2">
            {po.items.map((it) => {
              const d = items.find((x) => x.id === it.id);
              return editing && d ? (
                <div key={it.id} className="space-y-2 rounded-xl border border-brand-200 bg-brand-50/30 p-3">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_11rem]">
                    <input className="field" placeholder="Product name" value={d.productName} onChange={(e) => setItems((p) => p.map((x) => (x.id === d.id ? { ...x, productName: e.target.value } : x)))} />
                    <ProductCategoryPicker value={d.productCategory} onChange={(v) => setItems((p) => p.map((x) => (x.id === d.id ? { ...x, productCategory: v } : x)))} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input className="field font-mono" type="number" min="0" step="any" placeholder="Quantity" value={d.quantity} onChange={(e) => setItems((p) => p.map((x) => (x.id === d.id ? { ...x, quantity: e.target.value } : x)))} />
                    <ItemPicker items={withCurrent(UNIT_ITEMS, d.unit)} value={d.unit} clearable={false} onChange={(v) => setItems((p) => p.map((x) => (x.id === d.id ? { ...x, unit: v } : x)))} />
                  </div>
                  <input className="field" placeholder="Pack size (e.g. 120 g or 1 kg)" value={d.packSize} onChange={(e) => setItems((p) => p.map((x) => (x.id === d.id ? { ...x, packSize: e.target.value } : x)))} />
                </div>
              ) : (
                <ItemRow key={it.id} item={it} />
              );
            })}
          </div>
          {!canEdit && po.status === "APPROVED" && <p className="mt-3 text-tiny text-slate-400">This PO is approved, so the form is read-only.</p>}
        </div>

        {/* The uploaded PO */}
        <div className="card flex min-h-[32rem] flex-col p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-tiny font-bold uppercase tracking-wider text-slate-400">Uploaded PO</h2>
            <div className="flex flex-wrap items-center gap-2">
              {po.documents.length > 1 && (
                <select className="field !h-8 !w-auto !py-0 text-xs" value={activeDoc?.id ?? ""} onChange={(e) => setDocId(e.target.value)}>
                  {po.documents.map((d) => (
                    <option key={d.id} value={d.id}>{d.filename}</option>
                  ))}
                </select>
              )}
              {activeDoc && (
                <button type="button" className="btn-ghost btn-sm" onClick={() => downloadFile(`/api/purchase-orders/${po.id}/documents/${activeDoc.id}/download`, activeDoc.filename)}>
                  <Download className="h-3 w-3" strokeWidth={2.5} /> Download
                </button>
              )}
              {isBd && (
                <label className="btn-ghost btn-sm cursor-pointer">
                  <Upload className="h-3 w-3" strokeWidth={2.5} /> {upload.isPending ? "Uploading..." : "Upload PO"}
                  <input type="file" className="hidden" onChange={onUpload} />
                </label>
              )}
            </div>
          </div>
          {activeDoc ? <DocPreview key={activeDoc.id} poId={po.id} doc={activeDoc} /> : <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-200 text-xs text-slate-400">No PO document uploaded yet.</div>}
        </div>
      </div>
    </div>
  );
}

function withCurrent(base: { id: string; name: string }[], current: string) {
  return current && !base.some((o) => o.id.toLowerCase() === current.toLowerCase()) ? [...base, { id: current, name: current }] : base;
}

function Field({ label, value, edit, input }: { label: string; value: string; edit?: boolean; input?: React.ReactNode }) {
  return (
    <div>
      <label className="mb-0.5 block text-micro font-bold uppercase tracking-wide text-slate-400">{label}</label>
      {edit && input ? input : <p className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2 text-sm font-semibold text-slate-800">{value}</p>}
    </div>
  );
}

function ItemRow({ item }: { item: PurchaseOrderItem }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/40 px-3 py-2.5">
      <p className="text-sm font-bold text-slate-900">{item.productName}</p>
      <p className="text-xs text-slate-500">
        {item.productCategory ?? "No category"} - <span className="font-mono font-bold text-slate-700">{item.quantity.toLocaleString("en-IN")} {item.unit}</span>{item.packSize ? ` - pack ${item.packSize}` : ""}
      </p>
    </div>
  );
}

// The document is behind a login, so it is fetched with the token and shown from a temporary local URL.
function DocPreview({ poId, doc }: { poId: string; doc: { id: string; filename: string; mimeType: string } }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked = false;
    let made: string | null = null;
    const token = getToken();
    fetch(`${API_BASE}/api/purchase-orders/${poId}/documents/${doc.id}/download`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("failed"))))
      .then((b) => {
        if (revoked) return;
        made = URL.createObjectURL(new Blob([b], { type: doc.mimeType }));
        setUrl(made);
      })
      .catch(() => setFailed(true));
    return () => {
      revoked = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [poId, doc.id, doc.mimeType]);

  const canShow = doc.mimeType === "application/pdf" || doc.mimeType.startsWith("image/");
  const box = "flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400";
  if (failed) return <div className={box}>Could not load the document. Use Download.</div>;
  if (!url) return <div className={box}>Loading document...</div>;
  if (!canShow) return <div className={box}>{doc.filename} cannot be previewed here. Use Download to open it.</div>;
  return doc.mimeType === "application/pdf" ? (
    <iframe title={doc.filename} src={url} className="min-h-[30rem] w-full flex-1 rounded-xl border border-slate-200" />
  ) : (
    <div className="flex-1 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
      <img src={url} alt={doc.filename} className="mx-auto max-w-full" />
    </div>
  );
}

