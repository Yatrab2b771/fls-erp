import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Package, Pencil, PackageCheck, Plus, ShoppingBag, Trash2, Truck, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useAddVendorPurchaseOrderFreight,
  useAddVendorPurchaseOrderItem,
  useInventoryItems,
  useReceiveVendorPurchaseOrderItem,
  useRemoveVendorPurchaseOrderItem,
  useUpdateVendorPurchaseOrderItem,
  useVendorPurchaseOrder,
} from "../lib/hooks";
import { ItemPicker } from "../components/ItemPicker";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { ApiError } from "../lib/api";
import type { VendorPurchaseOrder, VendorPurchaseOrderItem } from "../lib/types";

const fmtCurrency = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function VendorPurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: po, isLoading } = useVendorPurchaseOrder(id);
  const { hasRole } = useAuth();
  const canWrite = hasRole("PURCHASE");
  // Warehouse's own narrow write access — marking items received and
  // adding freight, nothing else on this page (header/line-item edits
  // stay Purchase-only).
  const canReceive = hasRole("STORE");

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-4 w-40" />
        <div className="skeleton h-32 w-full" />
      </div>
    );
  }
  if (!po) return <EmptyState icon={ShoppingBag} title="Vendor PO not found" accent="rose" />;

  return (
    <div className="space-y-6">
      <Link to="/vendor-purchase-orders" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> All Vendor POs
      </Link>

      <div className="card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="stat-icon bg-brand-50 text-brand-600">
              <ShoppingBag className="h-5 w-5" strokeWidth={2} />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-black tracking-tight text-slate-900">{po.poNumber}</h1>
                <span className={`pill ${po.status === "ORDERED" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-500"}`}>
                  {po.status === "ORDERED" ? "Ordered" : "Draft"}
                </span>
                {po.completion.isCompleted && (
                  <span
                    className="pill border-emerald-200 bg-emerald-50 text-emerald-700"
                    title={po.completion.completionDate ? `Every line item QC-accepted by ${new Date(po.completion.completionDate).toLocaleDateString()}` : undefined}
                  >
                    <PackageCheck className="h-3 w-3" strokeWidth={2.5} />{" "}
                    {po.completion.daysTaken !== null ? `Completed in ${po.completion.daysTaken} day${po.completion.daysTaken === 1 ? "" : "s"}` : "Completed"}
                  </span>
                )}
              </div>
              <p className="text-sm text-slate-500">{po.vendor.name}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="pill border-slate-200 bg-slate-50 text-slate-600">Order Date: {new Date(po.orderDate).toLocaleDateString()}</span>
            <span className="pill border-slate-200 bg-slate-50 text-slate-600">ETA: {po.eta ? new Date(po.eta).toLocaleDateString() : "—"}</span>
            <span className="pill border-emerald-200 bg-emerald-50 font-bold text-emerald-700">Total: {fmtCurrency(po.totalAmount)}</span>
          </div>
        </div>

        <FreightSection po={po} canReceive={canReceive} />
      </div>

      <div>
        <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
          <Package className="h-3.5 w-3.5" /> Line Items
        </h2>
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-modern w-full">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th className="text-right">Ordered</th>
                  <th className="text-right">Received</th>
                  <th>Unit</th>
                  <th className="text-right">Rate</th>
                  <th className="text-right">GST %</th>
                  <th className="text-right">Amount</th>
                  {(canWrite || canReceive) && <th className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {po.items.map((item) => (
                  <LineItemRow key={item.id} poId={po.id} item={item} canWrite={canWrite} canReceive={canReceive} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {canWrite && <AddLineItemForm poId={po.id} />}
      </div>
    </div>
  );
}

function FreightSection({ po, canReceive }: { po: VendorPurchaseOrder; canReceive: boolean }) {
  const toast = useToast();
  const addFreight = useAddVendorPurchaseOrderFreight(po.id);
  const [editing, setEditing] = useState(false);
  const [freightCharges, setFreightCharges] = useState(po.freightCharges != null ? String(po.freightCharges) : "");

  async function save() {
    const value = Number(freightCharges);
    if (!freightCharges || Number.isNaN(value) || value < 0) {
      toast.error("Enter a valid freight amount.");
      return;
    }
    try {
      await addFreight.mutateAsync(value);
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save freight charges");
    }
  }

  if (!canReceive && po.freightCharges == null) return null;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 text-xs">
      <Truck className="h-3.5 w-3.5 text-slate-400" strokeWidth={2.25} />
      <span className="font-bold text-slate-500">Freight (optional):</span>
      {editing ? (
        <>
          <input className="field w-28 font-mono" type="number" min="0" step="any" value={freightCharges} onChange={(e) => setFreightCharges(e.target.value)} />
          <button className="btn-primary btn-sm" disabled={addFreight.isPending} onClick={save}>
            {addFreight.isPending ? "Saving…" : "Save"}
          </button>
          <button className="btn-ghost btn-sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </>
      ) : po.freightCharges != null ? (
        <>
          <span className="font-mono font-bold text-slate-700">{fmtCurrency(po.freightCharges)}</span>
          {po.freightAddedBy && <span className="text-slate-400">— added by {po.freightAddedBy.fullName}</span>}
          {canReceive && (
            <button className="btn-ghost btn-sm" onClick={() => setEditing(true)}>
              <Pencil className="h-3 w-3" strokeWidth={2.5} /> Edit
            </button>
          )}
        </>
      ) : (
        canReceive && (
          <button className="btn-ghost btn-sm" onClick={() => setEditing(true)}>
            <Plus className="h-3 w-3" strokeWidth={2.5} /> Add Freight
          </button>
        )
      )}
    </div>
  );
}

function LineItemRow({ poId, item, canWrite, canReceive }: { poId: string; item: VendorPurchaseOrderItem; canWrite: boolean; canReceive: boolean }) {
  const toast = useToast();
  const updateItem = useUpdateVendorPurchaseOrderItem(poId);
  const removeItem = useRemoveVendorPurchaseOrderItem(poId);
  const [editing, setEditing] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [quantity, setQuantity] = useState(String(item.quantity));
  const [rate, setRate] = useState(String(item.rate));
  const [gstPct, setGstPct] = useState(String(item.gstPct));

  const isFullyReceived = item.receivedQty >= item.quantity - 1e-6;
  const colCount = 8 + (canWrite || canReceive ? 1 : 0);

  async function save() {
    try {
      await updateItem.mutateAsync({ itemId: item.id, body: { quantity: Number(quantity), rate: Number(rate), gstPct: Number(gstPct) } });
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update line item");
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${item.item.name} from this vendor PO?`)) return;
    try {
      await removeItem.mutateAsync(item.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove line item");
    }
  }

  if (editing) {
    return (
      <tr>
        <td className="font-bold text-slate-800">{item.item.name}</td>
        <td className="text-slate-500">{item.item.category}</td>
        <td className="text-right">
          <input className="field w-24 text-right font-mono" type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </td>
        <td className="text-right font-mono text-slate-500">{item.receivedQty}</td>
        <td className="text-slate-600">{item.unit}</td>
        <td className="text-right">
          <input className="field w-24 text-right font-mono" type="number" min="0" step="any" value={rate} onChange={(e) => setRate(e.target.value)} />
        </td>
        <td className="text-right">
          <input className="field w-20 text-right font-mono" type="number" min="0" max="100" step="any" value={gstPct} onChange={(e) => setGstPct(e.target.value)} />
        </td>
        <td className="text-right font-mono text-slate-400">recalculated on save</td>
        <td className="text-right">
          <div className="flex justify-end gap-1">
            <button className="btn-icon" disabled={updateItem.isPending} onClick={save} title="Save">
              {updateItem.isPending ? "…" : "Save"}
            </button>
            <button className="btn-icon" onClick={() => setEditing(false)} title="Cancel">
              <X className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <>
      <tr>
        <td className="font-bold text-slate-800">
          {item.item.name}
          {item.item.code && <span className="ml-1.5 font-mono text-[10px] font-normal text-slate-400">{item.item.code}</span>}
        </td>
        <td className="text-slate-500">{item.item.category}</td>
        <td className="text-right font-mono text-slate-700">{item.quantity}</td>
        <td className="text-right font-mono">
          <span className={isFullyReceived ? "font-bold text-emerald-600" : "text-slate-600"}>{item.receivedQty}</span>
        </td>
        <td className="text-slate-600">{item.unit}</td>
        <td className="text-right font-mono text-slate-700">{fmtCurrency(item.rate)}</td>
        <td className="text-right font-mono text-slate-700">{item.gstPct}%</td>
        <td className="text-right font-mono font-bold text-slate-800">{fmtCurrency(item.amount)}</td>
        {(canWrite || canReceive) && (
          <td className="text-right">
            <div className="flex justify-end gap-1">
              {canReceive && (
                <button className="btn-icon" onClick={() => setReceiving((s) => !s)} title="Mark Received">
                  <Truck className="h-3.5 w-3.5" strokeWidth={2.25} />
                </button>
              )}
              {canWrite && (
                <>
                  <button className="btn-icon" onClick={() => setEditing(true)} title="Edit">
                    <Pencil className="h-3.5 w-3.5" strokeWidth={2.25} />
                  </button>
                  <button className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" disabled={removeItem.isPending} onClick={remove} title="Remove">
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
                  </button>
                </>
              )}
            </div>
          </td>
        )}
      </tr>
      {receiving && (
        <tr>
          <td colSpan={colCount} className="bg-slate-50/60 p-0">
            <ReceiveItemForm poId={poId} item={item} onDone={() => setReceiving(false)} />
          </td>
        </tr>
      )}
    </>
  );
}

function ReceiveItemForm({ poId, item, onDone }: { poId: string; item: VendorPurchaseOrderItem; onDone: () => void }) {
  const toast = useToast();
  const receiveItem = useReceiveVendorPurchaseOrderItem(poId);
  const remaining = Math.max(0, item.quantity - item.receivedQty);

  const [quantity, setQuantity] = useState(remaining > 0 ? String(remaining) : "");
  const [batchNo, setBatchNo] = useState("");
  const [grnNo, setGrnNo] = useState("");
  const [mfgDate, setMfgDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [remark, setRemark] = useState("");

  async function submit() {
    const qty = Number(quantity);
    if (!quantity || Number.isNaN(qty) || qty <= 0) {
      toast.error("Enter how much actually arrived.");
      return;
    }
    try {
      await receiveItem.mutateAsync({
        itemId: item.id,
        body: {
          quantity: qty,
          batchNo: batchNo.trim() || undefined,
          grnNo: grnNo.trim() || undefined,
          mfgDate: mfgDate || undefined,
          expiryDate: expiryDate || undefined,
          remark: remark.trim() || undefined,
        },
      });
      toast.success(`Logged ${qty} ${item.unit} of ${item.item.name} — awaiting inward QC.`);
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not log receipt");
    }
  }

  return (
    <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-6">
      <div>
        <label className="label !mb-1 text-[10px]">Qty Received</label>
        <input className="field font-mono" type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={`of ${remaining} left`} />
      </div>
      <div>
        <label className="label !mb-1 text-[10px]">Batch No.</label>
        <input className="field" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />
      </div>
      <div>
        <label className="label !mb-1 text-[10px]">GRN No.</label>
        <input className="field" value={grnNo} onChange={(e) => setGrnNo(e.target.value)} />
      </div>
      <div>
        <label className="label !mb-1 text-[10px]">Mfg. Date</label>
        <input className="field" type="date" value={mfgDate} onChange={(e) => setMfgDate(e.target.value)} />
      </div>
      <div>
        <label className="label !mb-1 text-[10px]">Expiry Date</label>
        <input className="field" type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
      </div>
      <div className="flex items-end gap-2">
        <button className="btn-primary btn-sm" disabled={receiveItem.isPending} onClick={submit}>
          {receiveItem.isPending ? "Logging…" : "Log Receipt"}
        </button>
        <button className="btn-ghost btn-sm" onClick={onDone}>
          Cancel
        </button>
      </div>
      <div className="col-span-2 sm:col-span-6">
        <label className="label !mb-1 text-[10px]">Remark (optional)</label>
        <input className="field" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="Any note for this delivery" />
      </div>
      <p className="col-span-2 text-[10px] text-slate-400 sm:col-span-6">Goes to Inward QC for approval before it counts toward stock or completion — see the Inventory page.</p>
    </div>
  );
}

function AddLineItemForm({ poId }: { poId: string }) {
  const toast = useToast();
  const { data: rmItems } = useInventoryItems("RM");
  const { data: pmItems } = useInventoryItems("PM");
  const catalogItems = [...(rmItems ?? []), ...(pmItems ?? [])];
  const addItem = useAddVendorPurchaseOrderItem(poId);

  const [show, setShow] = useState(false);
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [rate, setRate] = useState("");
  const [gstPct, setGstPct] = useState("");

  function reset() {
    setItemId("");
    setQuantity("");
    setUnit("");
    setRate("");
    setGstPct("");
  }

  async function submit() {
    if (!itemId || !quantity || !rate) {
      toast.error("Select an item, quantity, and rate.");
      return;
    }
    try {
      await addItem.mutateAsync({ itemId, quantity: Number(quantity), unit: unit.trim() || (catalogItems.find((i) => i.id === itemId)?.unit ?? ""), rate: Number(rate), gstPct: Number(gstPct) || 0 });
      reset();
      setShow(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add line item");
    }
  }

  if (!show) {
    return (
      <button className="btn-ghost btn-sm mt-3" onClick={() => setShow(true)}>
        <Plus className="h-3 w-3" strokeWidth={2.5} /> Add Line Item
      </button>
    );
  }

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3 sm:grid-cols-6">
      <div className="sm:col-span-2">
        <ItemPicker
          items={catalogItems.map((it) => ({ id: it.id, name: `${it.name}${it.code ? ` (${it.code})` : ""}` }))}
          value={itemId}
          onChange={(v) => {
            const picked = catalogItems.find((it) => it.id === v);
            setItemId(v);
            if (!unit && picked?.unit) setUnit(picked.unit);
          }}
          placeholder="RM/PM Item"
        />
      </div>
      <input className="field font-mono" type="number" min="0" step="any" placeholder="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      <input className="field" placeholder="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
      <input className="field font-mono" type="number" min="0" step="any" placeholder="Rate/unit" value={rate} onChange={(e) => setRate(e.target.value)} />
      <input className="field font-mono" type="number" min="0" max="100" step="any" placeholder="GST %" value={gstPct} onChange={(e) => setGstPct(e.target.value)} />
      <div className="flex gap-2">
        <button className="btn-primary btn-sm" disabled={addItem.isPending} onClick={submit}>
          {addItem.isPending ? "Adding…" : "Add"}
        </button>
        <button className="btn-ghost btn-sm" onClick={() => { reset(); setShow(false); }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
