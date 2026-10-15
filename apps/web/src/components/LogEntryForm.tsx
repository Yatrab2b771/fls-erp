import { useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, ShieldAlert, UserPlus, X } from "lucide-react";
import { ApiError } from "../lib/api";
import { useCreateDayStore, useCreateInventoryItem, useCreateInventoryTransaction, useDayStores, useInventoryItems, useInventoryVendors, useVendors } from "../lib/hooks";
import type { InventoryCategory, InventoryTxnType } from "../lib/types";
import { ItemPicker } from "./ItemPicker";
import { PickerWithAdd } from "./PickerWithAdd";
import { useToast } from "./Toast";

// Calendar bound for every Mfg Date / Expiry Date pair: Mfg Date can't be later than today, Expiry Date can't be
// before Mfg Date (or, absent that, today) - the same rule validateMfgExpiryDates enforces on the API side.
const TODAY = new Date().toISOString().slice(0, 10);

const UNIT_OPTIONS = ["Kg", "Ltr", "Count", "Inch", "Ft"];
const UNIT_ITEMS = UNIT_OPTIONS.map((u) => ({ id: u, name: u }));
const CATEGORY_LABEL: Record<InventoryCategory, string> = { RM: "Raw Material", PM: "Packaging Material" };
const CATEGORY_ITEMS = [
  { id: "RM", name: CATEGORY_LABEL.RM },
  { id: "PM", name: CATEGORY_LABEL.PM },
];
const TXN_TYPE_LABEL: Record<InventoryTxnType, string> = {
  RECEIVED: "Material Received",
  ISSUED_DAY_STORE: "Issued to Store",
  ISSUED_PRODUCTION: "Issued to Production",
  ISSUED_RND: "Sent to R&D Store",
};

/** The Log Entry form: Material Received (or an issue to a Day Store). One form, used wherever stock is logged. */
export function LogEntryForm({ initialType, onDone, lockType = false }: { initialType: Exclude<InventoryTxnType, "ISSUED_PRODUCTION">; onDone: () => void; lockType?: boolean }) {
  const toast = useToast();
  const [type, setType] = useState<Exclude<InventoryTxnType, "ISSUED_PRODUCTION">>(initialType);
  const [category, setCategory] = useState<InventoryCategory>("RM");
  const { data: items } = useInventoryItems(category);

  const [itemId, setItemId] = useState("");
  const [showNewItem, setShowNewItem] = useState(false);
  const [newItemName, setNewItemName] = useState("");

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [unit, setUnit] = useState(UNIT_OPTIONS[0]!);
  const [quantity, setQuantity] = useState("");
  const [size, setSize] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [dayStoreId, setDayStoreId] = useState("");
  const [isTransitTracked, setIsTransitTracked] = useState(false);
  const [batchNo, setBatchNo] = useState("");
  const [grnNo, setGrnNo] = useState("");
  const [mfgDate, setMfgDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [remark, setRemark] = useState("");
  // Store Before/After Report §4 — rate/invoice weren't captured on a
  // direct (non-Vendor-PO) delivery before.
  const [rate, setRate] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data: vendors } = useInventoryVendors();
  const { data: vendorDirectory } = useVendors();
  const { data: dayStores } = useDayStores();
  const createItem = useCreateInventoryItem();
  const createTxn = useCreateInventoryTransaction();
  const createDayStore = useCreateDayStore();

  // Vendor Master's own directory, plus every name ever typed on a past
  // entry (so an ad-hoc source like "Blinkit" that isn't a formal vendor
  // still shows up as a suggestion) — still free text underneath (this
  // field isn't an FK to Vendor), just a richer suggestion list.
  const vendorNameOptions = useMemo(() => {
    const names = new Set<string>();
    for (const v of vendorDirectory ?? []) names.add(v.name);
    for (const n of vendors?.vendors ?? []) names.add(n);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [vendorDirectory, vendors]);

  const sortedItems = useMemo(() => items ?? [], [items]);

  function switchCategory(next: InventoryCategory) {
    setCategory(next);
    setItemId("");
  }

  // A default suggestion only — pre-fills Vendor Name from the item's
  // own preferredVendor (see the schema.prisma comment), but only into
  // an empty field, so it never clobbers a value Store already typed or
  // changed for this real delivery.
  function handleItemChange(id: string) {
    setItemId(id);
    if (!vendorName.trim()) {
      const preferred = sortedItems.find((i) => i.id === id)?.preferredVendor;
      if (preferred) setVendorName(preferred);
    }
  }

  async function handleSubmit() {
    setError(null);

    let finalItemId = itemId;
    if (showNewItem) {
      if (!newItemName.trim()) return setError("Enter the new item's name.");
      try {
        const created = await createItem.mutateAsync({ category, name: newItemName.trim(), unit });
        finalItemId = created.id;
      } catch (err) {
        return setError(err instanceof ApiError ? err.message : "Could not create item");
      }
    }
    if (!finalItemId) return setError("Select or add an item first.");
    if (!date) return setError("Pick a date.");
    if (!quantity || Number(quantity) <= 0) return setError("Enter a quantity greater than zero.");
    // Rate is mandatory on a real delivery (Store Before/After Report §4.6).
    if (type === "RECEIVED" && (!rate || Number(rate) < 0)) return setError("Enter the rate for this delivery.");
    // Raw material without an expiry date can never expire in the system, so it is never caught. (Packaging material may have none.)
    if (type === "RECEIVED" && category === "RM" && !expiryDate) return setError("Enter the expiry date - raw material needs one so it can be caught when it expires.");

    setSubmitting(true);
    try {
      await createTxn.mutateAsync({
        itemId: finalItemId,
        type,
        date,
        unit,
        quantity: Number(quantity),
        size: size.trim() || undefined,
        vendorName: vendorName.trim() || undefined,
        dayStoreId: type === "ISSUED_DAY_STORE" && dayStoreId ? dayStoreId : undefined,
        isTransitTracked: type === "ISSUED_DAY_STORE" && isTransitTracked ? true : undefined,
        batchNo: batchNo.trim() || undefined,
        grnNo: grnNo.trim() || undefined,
        mfgDate: mfgDate || undefined,
        expiryDate: expiryDate || undefined,
        remark: remark.trim() || undefined,
        rate: type === "RECEIVED" && rate ? Number(rate) : undefined,
        invoiceNo: type === "RECEIVED" && invoiceNo.trim() ? invoiceNo.trim() : undefined,
        invoiceDate: type === "RECEIVED" && invoiceDate ? invoiceDate : undefined,
      });
      toast.success(
        type === "RECEIVED"
          ? "Entry logged — awaiting inward QC."
          : isTransitTracked
            ? `${TXN_TYPE_LABEL[type]} entry logged — in transit until confirmed at the other end.`
            : `${TXN_TYPE_LABEL[type]} entry logged.`,
      );
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not log entry");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card animate-slide-up space-y-5 p-5 sm:p-6">
      {!lockType && (
      <div className="scrollbar-none flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-slate-100/80 p-1">
        {(["RECEIVED", "ISSUED_DAY_STORE"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-body font-bold transition-all duration-150 ${
              type === t ? "bg-white text-slate-900 shadow-soft" : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {t === "RECEIVED" ? <ArrowDownToLine className="h-3.5 w-3.5" strokeWidth={2.25} /> : <ArrowUpFromLine className="h-3.5 w-3.5" strokeWidth={2.25} />}
            {TXN_TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      )}

      {type === "RECEIVED" && (
        <p className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} /> This won't count as stock until QA/QC approves it and Store accepts it.
        </p>
      )}

      {type === "ISSUED_DAY_STORE" && (
        <div className="space-y-2">
          <label className="flex w-fit cursor-pointer items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600">
            <input type="checkbox" className="h-3.5 w-3.5" checked={isTransitTracked} onChange={(e) => setIsTransitTracked(e.target.checked)} />
            Track as In-Transit — takes real travel time to get there
          </label>
          {isTransitTracked && (
            <p className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} /> Leaves the Warehouse right away, but won't count at the destination until someone there confirms it arrived (see the Transit tab).
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className="label">Category</label>
          <ItemPicker items={CATEGORY_ITEMS} value={category} onChange={(v) => switchCategory(v as InventoryCategory)} clearable={false} />
        </div>
        <div className="sm:col-span-2">
          <label className="label">Item</label>
          {!showNewItem ? (
            <div className="flex flex-wrap gap-2">
              <div className="min-w-0 flex-1">
                <ItemPicker items={sortedItems} value={itemId} onChange={handleItemChange} />
              </div>
              <button type="button" className="btn-ghost shrink-0" onClick={() => setShowNewItem(true)}>
                <UserPlus className="h-3.5 w-3.5" strokeWidth={2.25} /> New
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <input className="field min-w-0 flex-1" placeholder="Exact item name" value={newItemName} onChange={(e) => setNewItemName(e.target.value)} />
              <button type="button" className="btn-ghost shrink-0" onClick={() => setShowNewItem(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
        <div>
          <label className="label">Date</label>
          <input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label">Unit</label>
          <ItemPicker items={UNIT_ITEMS} value={unit} onChange={setUnit} clearable={false} />
        </div>
        <div>
          <label className="label">Count</label>
          <input className="field font-mono" type="number" min="0" step="any" placeholder="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <div>
          <label className="label">Size (optional)</label>
          <input className="field" placeholder="e.g. 25 Kg bag" value={size} onChange={(e) => setSize(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label">Vendor Name (optional)</label>
          <input
            className="field"
            list="vendor-name-options"
            placeholder="Vendor / supplier — pick from the list, or type one (e.g. a direct/Blinkit delivery)"
            value={vendorName}
            onChange={(e) => setVendorName(e.target.value)}
          />
          <datalist id="vendor-name-options">
            {vendorNameOptions.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
        {type === "RECEIVED" && (
          <>
            <div>
              <label className="label">Rate</label>
              <input className="field font-mono" type="number" min="0" step="any" placeholder="Per unit" value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
            <div>
              <label className="label">Invoice No (optional)</label>
              <input className="field" placeholder="Vendor's invoice number" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
            </div>
            <div>
              <label className="label">Invoice Date (optional)</label>
              <input type="date" className="field" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            </div>
          </>
        )}
        {type === "ISSUED_DAY_STORE" && (
          <PickerWithAdd
            label="Store (optional)"
            placeholder="— Which store —"
            options={dayStores ?? []}
            value={dayStoreId}
            onChange={setDayStoreId}
            onCreate={(name) => createDayStore.mutateAsync(name)}
          />
        )}
        <div>
          <label className="label">Batch No (optional)</label>
          <input className="field" placeholder="e.g. B-2026-081" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />
        </div>
        <div>
          <label className="label">GRN No (optional)</label>
          <input className="field" placeholder="e.g. GRN-1042" value={grnNo} onChange={(e) => setGrnNo(e.target.value)} />
        </div>
        <div>
          <label className="label">Mfg Date (optional)</label>
          <input type="date" className="field" max={TODAY} value={mfgDate} onChange={(e) => setMfgDate(e.target.value)} />
        </div>
        <div>
          <label className="label">
            Expiry Date {type === "RECEIVED" && category === "RM" ? <span className="text-rose-500">*</span> : "(optional)"}
          </label>
          <input type="date" className="field" min={mfgDate || TODAY} value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <label className="label">Remark (optional)</label>
          <input className="field" placeholder="Any other note for this entry" value={remark} onChange={(e) => setRemark(e.target.value)} />
        </div>
      </div>

      {error && (
        <div className="animate-fade-in flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-bold text-rose-600">
          <X className="h-3.5 w-3.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={submitting} onClick={handleSubmit}>
          {submitting ? "Logging…" : "Log Entry"}
        </button>
      </div>
    </div>
  );
}
