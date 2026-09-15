import { useState } from "react";
import { Link } from "react-router-dom";
import { Package, Plus, ShoppingBag, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useCreateVendorPurchaseOrder,
  useInventoryItems,
  useVendorPurchaseOrders,
  useVendors,
  type CreateVendorPurchaseOrderPayload,
} from "../lib/hooks";
import { ItemPicker } from "../components/ItemPicker";
import { SearchBar } from "../components/SearchBar";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { StatTile } from "../components/StatTile";
import { useToast } from "../components/Toast";
import { ApiError } from "../lib/api";

const fmtCurrency = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

interface LineItemDraft {
  itemId: string;
  quantity: string;
  unit: string;
  rate: string;
  gstPct: string;
}

function blankItem(): LineItemDraft {
  return { itemId: "", quantity: "", unit: "", rate: "", gstPct: "" };
}

// A vendor procurement order for RM/PM — NOT the customer PurchaseOrder
// (see PurchaseOrdersPage.tsx). Purchase raises this against a Vendor
// with rate/GST/amount per line; Warehouse marks items received against
// it in a later phase.
export function VendorPurchaseOrdersPage() {
  const { hasRole } = useAuth();
  const canCreate = hasRole("PURCHASE");
  const { data: orders, isLoading } = useVendorPurchaseOrders();
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);

  const q = search.trim().toLowerCase();
  const filtered = orders?.filter((po) => !q || po.poNumber.toLowerCase().includes(q) || po.vendor.name.toLowerCase().includes(q));

  const totalItems = (orders ?? []).reduce((sum, po) => sum + po.items.length, 0);
  const totalValue = (orders ?? []).reduce((sum, po) => sum + po.totalAmount, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-brand-50 text-brand-600">
            <ShoppingBag className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Vendor POs</h1>
            <p className="text-sm text-slate-500">RM/PM procurement orders raised with vendors — separate from customer Purchase Orders.</p>
          </div>
        </div>
        {canCreate && (
          <button className="btn-primary" onClick={() => setShowForm((s) => !s)}>
            {showForm ? (
              <X className="h-4 w-4" strokeWidth={2.5} />
            ) : (
              <>
                <Plus className="h-4 w-4" strokeWidth={2.5} /> New Vendor PO
              </>
            )}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile icon={ShoppingBag} label="Vendor POs" value={orders?.length ?? 0} accent="rose" />
        <StatTile icon={Package} label="Line Items" value={totalItems} accent="brand" />
        <StatTile icon={ShoppingBag} label="Total Value" value={fmtCurrency(totalValue)} accent="emerald" />
      </div>

      {showForm && <NewVendorPurchaseOrderForm onDone={() => setShowForm(false)} />}

      {!isLoading && !!orders?.length && <SearchBar value={search} onChange={setSearch} placeholder="Search by PO number or vendor…" />}

      {isLoading ? (
        <SkeletonRows rows={4} cols={5} />
      ) : !orders?.length ? (
        <EmptyState icon={ShoppingBag} title="No vendor POs yet" hint={canCreate ? "Create one above to get started." : "Ask Purchase to create the first one."} accent="rose" />
      ) : !filtered?.length ? (
        <EmptyState icon={ShoppingBag} title="No matching vendor POs" hint="Try a different search." accent="slate" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-modern w-full">
              <thead>
                <tr>
                  <th>PO Number</th>
                  <th>Vendor</th>
                  <th className="text-center">Line Items</th>
                  <th>Order Date</th>
                  <th>ETA</th>
                  <th className="text-right">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((po) => (
                  <tr key={po.id}>
                    <td className="font-bold">
                      <Link to={`/vendor-purchase-orders/${po.id}`} className="text-brand-600 hover:underline">
                        {po.poNumber}
                      </Link>
                    </td>
                    <td className="text-slate-600">{po.vendor.name}</td>
                    <td className="text-center font-mono font-bold text-slate-700">{po.items.length}</td>
                    <td className="text-slate-500">{new Date(po.orderDate).toLocaleDateString()}</td>
                    <td className="text-slate-500">{po.eta ? new Date(po.eta).toLocaleDateString() : "—"}</td>
                    <td className="text-right font-mono font-bold text-slate-700">{fmtCurrency(po.totalAmount)}</td>
                    <td>
                      <span className={`pill ${po.status === "ORDERED" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-500"}`}>
                        {po.status === "ORDERED" ? "Ordered" : "Draft"}
                      </span>
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

function NewVendorPurchaseOrderForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const { data: vendors } = useVendors();
  const { data: rmItems } = useInventoryItems("RM");
  const { data: pmItems } = useInventoryItems("PM");
  const catalogItems = [...(rmItems ?? []), ...(pmItems ?? [])];
  const createOrder = useCreateVendorPurchaseOrder();

  const [vendorId, setVendorId] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [orderDate, setOrderDate] = useState("");
  const [eta, setEta] = useState("");
  const [items, setItems] = useState<LineItemDraft[]>([blankItem()]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const hasItem = items.some((item) => item.itemId && item.quantity && item.rate);
  const missing: string[] = [];
  if (!vendorId) missing.push("a vendor");
  if (!poNumber.trim()) missing.push("a PO number");
  if (!orderDate) missing.push("an order date");
  if (!hasItem) missing.push("at least one line item with an RM/PM item, quantity, and rate");
  const canSubmit = missing.length === 0;

  function updateItem(index: number, patch: Partial<LineItemDraft>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }
  function removeItem(index: number) {
    setItems((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function lineAmount(item: LineItemDraft): number {
    const qty = Number(item.quantity) || 0;
    const rate = Number(item.rate) || 0;
    const gst = Number(item.gstPct) || 0;
    return Math.round(qty * rate * (1 + gst / 100) * 100) / 100;
  }
  const liveTotal = items.reduce((sum, item) => sum + lineAmount(item), 0);

  async function handleSubmit() {
    setError(null);
    if (!vendorId) return setError("Select a vendor.");
    if (!poNumber.trim()) return setError("Enter the PO Number.");
    if (!orderDate) return setError("Enter the Order Date.");

    const cleanItems: CreateVendorPurchaseOrderPayload["items"] = [];
    for (const item of items) {
      if (!item.itemId || !item.quantity || !item.rate) continue;
      cleanItems.push({
        itemId: item.itemId,
        quantity: Number(item.quantity),
        unit: item.unit.trim() || (catalogItems.find((i) => i.id === item.itemId)?.unit ?? ""),
        rate: Number(item.rate),
        gstPct: Number(item.gstPct) || 0,
      });
    }
    if (cleanItems.length === 0) return setError("Add at least one line item with an RM/PM item, quantity, and rate.");

    setSubmitting(true);
    try {
      const order = await createOrder.mutateAsync({
        vendorId,
        poNumber: poNumber.trim(),
        orderDate,
        eta: eta || undefined,
        items: cleanItems,
      });
      toast.success(`Vendor PO ${order.poNumber} created with ${cleanItems.length} line item(s).`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create vendor PO");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card animate-slide-up space-y-5 p-5 sm:p-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="label">
            Vendor <span className="text-rose-500">*</span>
          </label>
          <ItemPicker items={(vendors ?? []).map((v) => ({ id: v.id, name: v.name }))} value={vendorId} onChange={setVendorId} placeholder="— Select a vendor —" />
        </div>
        <div>
          <label className="label">
            PO Number <span className="text-rose-500">*</span>
          </label>
          <input className="field" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="PO-2026-XXXX" />
        </div>
        <div>
          <label className="label">
            Order Date <span className="text-rose-500">*</span>
          </label>
          <input type="date" className="field" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
        </div>
        <div>
          <label className="label">ETA</label>
          <input type="date" className="field" value={eta} onChange={(e) => setEta(e.target.value)} />
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="label !mb-0">
            Line Items <span className="text-rose-500">*</span>
          </label>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setItems((prev) => [...prev, blankItem()])}>
            <Plus className="h-3 w-3" strokeWidth={2.5} /> Add More
          </button>
        </div>
        <div className="space-y-3">
          {items.map((item, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3 sm:grid-cols-7">
              <div className="sm:col-span-2">
                <ItemPicker
                  items={catalogItems.map((it) => ({ id: it.id, name: `${it.name}${it.code ? ` (${it.code})` : ""}` }))}
                  value={item.itemId}
                  onChange={(v) => {
                    const picked = catalogItems.find((it) => it.id === v);
                    updateItem(i, { itemId: v, unit: item.unit || picked?.unit || "" });
                  }}
                  placeholder={`RM/PM Item ${i + 1}`}
                />
              </div>
              <input className="field font-mono" type="number" min="0" step="any" placeholder="Quantity" value={item.quantity} onChange={(e) => updateItem(i, { quantity: e.target.value })} />
              <input className="field" placeholder="Unit" value={item.unit} onChange={(e) => updateItem(i, { unit: e.target.value })} />
              <input className="field font-mono" type="number" min="0" step="any" placeholder="Rate/unit" value={item.rate} onChange={(e) => updateItem(i, { rate: e.target.value })} />
              <input className="field font-mono" type="number" min="0" max="100" step="any" placeholder="GST %" value={item.gstPct} onChange={(e) => updateItem(i, { gstPct: e.target.value })} />
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-bold text-slate-600">{fmtCurrency(lineAmount(item))}</span>
                {items.length > 1 && (
                  <button type="button" className="btn-icon shrink-0" onClick={() => removeItem(i)} title="Remove">
                    <X className="h-3.5 w-3.5" strokeWidth={2.25} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-right text-sm font-bold text-slate-700">Total: {fmtCurrency(liveTotal)}</p>
      </div>

      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      {!canSubmit && !error && <p className="text-xs text-slate-400">Needs: {missing.join(", ")}.</p>}

      <div className="flex gap-2">
        <button className="btn-primary" disabled={!canSubmit || submitting} onClick={handleSubmit}>
          {submitting ? "Creating…" : "Create Vendor PO"}
        </button>
        <button className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
