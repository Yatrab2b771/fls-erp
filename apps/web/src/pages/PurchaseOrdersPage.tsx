import { useState } from "react";
import { Link } from "react-router-dom";
import { Download, FileText, Package, Plus, ShoppingCart, Truck, Upload, UserPlus, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useCreateCustomer, useCreatePurchaseOrder, useCustomers, usePurchaseOrders } from "../lib/hooks";
import { api } from "../lib/api";
import type { CreatePurchaseOrderPayload } from "../lib/hooks";
import { ApiError, downloadFile } from "../lib/api";
import { StatTile } from "../components/StatTile";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { PoStatusBadge } from "../components/Badges";

const UNIT_OPTIONS = ["KG", "SKU", "Litres", "Other"];

interface LineItemDraft {
  productName: string;
  dosageForm: string;
  quantity: string;
  unit: string;
  volume: string;
  packSize: string;
  packType: string;
}

function blankItem(): LineItemDraft {
  return { productName: "", dosageForm: "", quantity: "", unit: "KG", volume: "", packSize: "", packType: "" };
}

export function PurchaseOrdersPage() {
  const { hasRole } = useAuth();
  const { data: orders, isLoading } = usePurchaseOrders();
  const canCreate = hasRole("BD");

  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");

  const totalProducts = orders?.reduce((sum, po) => sum + po.items.length, 0) ?? 0;
  const totalBatches = orders?.reduce((sum, po) => sum + po.items.reduce((s, i) => s + (i._count?.batches ?? 0), 0), 0) ?? 0;

  const q = search.trim().toLowerCase();
  const filteredOrders = orders?.filter(
    (po) => !q || (po.poNumber ?? "").toLowerCase().includes(q) || po.customer.companyName.toLowerCase().includes(q) || (po.brandName ?? "").toLowerCase().includes(q),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Order Tracking</h1>
          <p className="text-sm text-slate-500">One PO can list several products — each becomes its own production tracker.</p>
        </div>
        {canCreate && (
          <button className="btn-primary" onClick={() => setShowForm((s) => !s)}>
            {showForm ? (
              <X className="h-4 w-4" strokeWidth={2.5} />
            ) : (
              <>
                <Plus className="h-4 w-4" strokeWidth={2.5} /> New Purchase Order
              </>
            )}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile icon={ShoppingCart} label="Purchase Orders" value={orders?.length ?? 0} accent="rose" />
        <StatTile icon={Package} label="Products Queued" value={totalProducts} accent="brand" />
        <StatTile icon={Truck} label="Batches In Flight" value={totalBatches} accent="emerald" />
      </div>

      {showForm && <NewPurchaseOrderForm onDone={() => setShowForm(false)} />}

      {!isLoading && !!orders?.length && (
        <SearchBar value={search} onChange={setSearch} placeholder="Search by PO number, customer, or brand…" />
      )}

      {isLoading ? (
        <SkeletonRows rows={4} cols={5} />
      ) : !orders?.length ? (
        <EmptyState icon={ShoppingCart} title="No purchase orders yet" hint={canCreate ? "Create one above to get started." : "Ask BD to create the first one."} accent="rose" />
      ) : !filteredOrders?.length ? (
        <EmptyState icon={ShoppingCart} title="No matching purchase orders" hint="Try a different search." accent="slate" />
      ) : (
        <div className="card overflow-hidden">
          <table className="table-modern w-full">
            <thead>
              <tr>
                <th>PO Number</th>
                <th>Customer</th>
                <th>Brand</th>
                <th className="text-center">Products</th>
                <th>Order Date</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map((po) => (
                <tr key={po.id}>
                  <td className="font-bold">
                    <Link to={`/purchase-orders/${po.id}`} className="text-brand-600 hover:underline">
                      {po.poNumber ?? po.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="text-slate-600">{po.customer.companyName}</td>
                  <td className="text-slate-600">{po.brandName ?? "—"}</td>
                  <td className="text-center font-mono font-bold text-slate-700">{po.items.length}</td>
                  <td className="text-slate-500">{po.orderDate ? new Date(po.orderDate).toLocaleDateString() : "—"}</td>
                  <td>
                    <PoStatusBadge status={po.status} />
                  </td>
                  <td className="text-right">
                    <button
                      className="btn-icon hover:!bg-brand-50 hover:!text-brand-600"
                      onClick={() => downloadFile(`/api/purchase-orders/${po.id}/export.pdf`, `FLS_PO_${po.poNumber ?? po.id}.pdf`)}
                      title="Download PDF"
                    >
                      <Download className="h-3.5 w-3.5" strokeWidth={2.25} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewPurchaseOrderForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const { data: customers } = useCustomers();
  const createCustomer = useCreateCustomer();
  const createOrder = useCreatePurchaseOrder();

  const [customerId, setCustomerId] = useState("");
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");

  const [poNumber, setPoNumber] = useState("");
  const [brandName, setBrandName] = useState("");
  const [orderDate, setOrderDate] = useState("");
  const [regulatoryBody, setRegulatoryBody] = useState("");
  const [regulatoryStatus, setRegulatoryStatus] = useState("");
  const [items, setItems] = useState<LineItemDraft[]>([blankItem()]);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateItem(index: number, patch: Partial<LineItemDraft>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function removeItem(index: number) {
    setItems((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function handleSubmit() {
    setError(null);

    let finalCustomerId = customerId;
    if (showNewCustomer) {
      if (!newCustomerName.trim()) return setError("Enter the new customer's company name.");
      try {
        const created = await createCustomer.mutateAsync({ companyName: newCustomerName.trim() });
        finalCustomerId = created.id;
      } catch (err) {
        return setError(err instanceof ApiError ? err.message : "Could not create customer");
      }
    }
    if (!finalCustomerId) return setError("Select or create a customer first.");

    const cleanItems: CreatePurchaseOrderPayload["items"] = [];
    for (const item of items) {
      if (!item.productName.trim() || !item.quantity) continue;
      cleanItems.push({
        productName: item.productName.trim(),
        dosageForm: item.dosageForm.trim() || undefined,
        quantity: Number(item.quantity),
        unit: item.unit,
        volume: item.volume ? Number(item.volume) : undefined,
        packSize: item.packSize.trim() || undefined,
        packType: item.packType.trim() || undefined,
      });
    }
    if (cleanItems.length === 0) return setError("Add at least one product with a name and quantity.");

    setSubmitting(true);
    try {
      const order = await createOrder.mutateAsync({
        customerId: finalCustomerId,
        poNumber: poNumber.trim() || undefined,
        brandName: brandName.trim() || undefined,
        orderDate: orderDate || undefined,
        regulatoryBody: regulatoryBody || undefined,
        regulatoryStatus: regulatoryStatus || undefined,
        items: cleanItems,
      });

      if (file) {
        // Upload after creation — the PO needs an id to attach the file to,
        // so this can't go through useUploadPoDocument's per-PO hook here.
        const form = new FormData();
        form.append("file", file);
        await api(`/api/purchase-orders/${order.id}/documents`, { method: "POST", body: form, isFormData: true });
      }

      toast.success(`Purchase order ${order.poNumber ?? order.id.slice(0, 8)} created with ${cleanItems.length} product(s).`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create purchase order");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card animate-slide-up space-y-5 p-5 sm:p-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Customer</label>
          {!showNewCustomer ? (
            <div className="flex gap-2">
              <select className="field" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">— Select a customer —</option>
                {customers?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.companyName}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-ghost shrink-0" onClick={() => setShowNewCustomer(true)}>
                <UserPlus className="h-3.5 w-3.5" strokeWidth={2.25} /> New
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input className="field" placeholder="Company name" value={newCustomerName} onChange={(e) => setNewCustomerName(e.target.value)} />
              <button type="button" className="btn-ghost shrink-0" onClick={() => setShowNewCustomer(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
        <div>
          <label className="label">PO Number</label>
          <input className="field" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="PO-2026-XXXX" />
        </div>
        <div>
          <label className="label">Brand</label>
          <input className="field" value={brandName} onChange={(e) => setBrandName(e.target.value)} />
        </div>
        <div>
          <label className="label">Order Date</label>
          <input type="date" className="field" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
        </div>
        <div>
          <label className="label">Regulatory Body</label>
          <select className="field" value={regulatoryBody} onChange={(e) => setRegulatoryBody(e.target.value)}>
            <option value="">—</option>
            <option value="FSSAI">FSSAI</option>
            <option value="AYUSH">AYUSH</option>
          </select>
        </div>
        <div>
          <label className="label">Regulatory Status</label>
          <select className="field" value={regulatoryStatus} onChange={(e) => setRegulatoryStatus(e.target.value)}>
            <option value="">—</option>
            <option value="Applied">Applied</option>
            <option value="Not Applied">Not Applied</option>
            <option value="Issued">Issued</option>
          </select>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="label !mb-0">Products on this PO</label>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setItems((prev) => [...prev, blankItem()])}>
            <Plus className="h-3 w-3" strokeWidth={2.5} /> Add More
          </button>
        </div>
        <div className="space-y-3">
          {items.map((item, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3 sm:grid-cols-6">
              <input
                className="field sm:col-span-2"
                placeholder={`Product ${i + 1} (e.g. Medicine A)`}
                value={item.productName}
                onChange={(e) => updateItem(i, { productName: e.target.value })}
              />
              <input className="field" placeholder="Dosage form" value={item.dosageForm} onChange={(e) => updateItem(i, { dosageForm: e.target.value })} />
              <input
                className="field font-mono"
                type="number"
                min="0"
                step="any"
                placeholder="Quantity"
                value={item.quantity}
                onChange={(e) => updateItem(i, { quantity: e.target.value })}
              />
              <select className="field" value={item.unit} onChange={(e) => updateItem(i, { unit: e.target.value })}>
                {UNIT_OPTIONS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                <input
                  className="field font-mono"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="Volume (opt.)"
                  value={item.volume}
                  onChange={(e) => updateItem(i, { volume: e.target.value })}
                />
                {items.length > 1 && (
                  <button type="button" onClick={() => removeItem(i)} className="btn-icon shrink-0 hover:!bg-rose-50 hover:!text-rose-600" title="Remove product">
                    <X className="h-4 w-4" strokeWidth={2.25} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Upload the PO (photo or PDF)</label>
        <label className="btn-ghost inline-flex cursor-pointer">
          <Upload className="h-3.5 w-3.5" strokeWidth={2.25} />
          {file ? file.name : "Choose file…"}
          <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="hidden" />
        </label>
      </div>

      {error && (
        <div className="animate-fade-in flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-bold text-rose-600">
          <FileText className="h-3.5 w-3.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={submitting} onClick={handleSubmit}>
          {submitting ? "Creating…" : "Create Purchase Order"}
        </button>
      </div>
    </div>
  );
}
