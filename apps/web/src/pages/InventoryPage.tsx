import { useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Boxes, FileText, Package, Plus, Send, Trash2, Truck, UserPlus, Warehouse, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useCreateDispatchTransfer,
  useCreateInventoryItem,
  useCreateInventoryTransaction,
  useCustomers,
  useDeleteDispatchTransfer,
  useDeleteInventoryTransaction,
  useDispatchTransfers,
  useInventoryItems,
  useInventoryStock,
  useInventoryTransactions,
} from "../lib/hooks";
import type { DispatchTransferType, InventoryCategory, InventoryTxnType } from "../lib/types";
import { ApiError } from "../lib/api";
import { StatTile } from "../components/StatTile";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";

const UNIT_OPTIONS = ["Kg", "Ltr", "Count", "Inch", "Ft"];
const CATEGORY_LABEL: Record<InventoryCategory, string> = { RM: "Raw Material", PM: "Packaging Material" };
const TXN_TYPE_LABEL: Record<InventoryTxnType, string> = {
  RECEIVED: "Material Received",
  ISSUED_DAY_STORE: "Issued to Day Store",
  ISSUED_PRODUCTION: "Issued to Production",
};
const DISPATCH_TYPE_LABEL: Record<DispatchTransferType, string> = {
  FG: "FG Transfer to Dispatch",
  BILL: "Bill Transfer to Dispatch",
};

type ViewTab = "stock" | InventoryTxnType | DispatchTransferType;

const MATERIAL_TABS: { key: ViewTab; label: string; icon: typeof Warehouse }[] = [
  { key: "stock", label: "Stock on Hand", icon: Warehouse },
  { key: "RECEIVED", label: "Material Received", icon: ArrowDownToLine },
  { key: "ISSUED_DAY_STORE", label: "Issued to Day Store", icon: ArrowUpFromLine },
  { key: "ISSUED_PRODUCTION", label: "Issued to Production", icon: ArrowUpFromLine },
];

const DISPATCH_TABS: { key: ViewTab; label: string; icon: typeof Warehouse }[] = [
  { key: "FG", label: "FG Transfer to Dispatch", icon: Truck },
  { key: "BILL", label: "Bill Transfer to Dispatch", icon: FileText },
];

function isDispatchTab(tab: ViewTab): tab is DispatchTransferType {
  return tab === "FG" || tab === "BILL";
}

export function InventoryPage() {
  const { hasRole } = useAuth();
  const canWrite = hasRole("STORE");

  const [tab, setTab] = useState<ViewTab>("stock");
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);

  const dispatchTab = isDispatchTab(tab);

  const { data: stock, isLoading: stockLoading } = useInventoryStock();
  const { data: transactions, isLoading: txnLoading } = useInventoryTransactions(tab === "stock" || dispatchTab ? undefined : { type: tab });
  const { data: dispatchTransfers, isLoading: dispatchLoading } = useDispatchTransfers(dispatchTab ? { type: tab } : undefined);

  const itemsTracked = stock?.length ?? 0;
  const negativeStock = stock?.filter((s) => s.onHand < 0).length ?? 0;

  const q = search.trim().toLowerCase();
  const filteredStock = stock?.filter((s) => !q || s.item.name.toLowerCase().includes(q));
  const filteredTxns = transactions?.filter((t) => !q || t.item.name.toLowerCase().includes(q) || (t.vendorName ?? "").toLowerCase().includes(q));
  const filteredDispatch = dispatchTransfers?.filter((d) => !q || d.productName.toLowerCase().includes(q) || d.customer.companyName.toLowerCase().includes(q));

  function switchTab(next: ViewTab) {
    setTab(next);
    setShowForm(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Inventory</h1>
          <p className="text-sm text-slate-500">Warehouse-level material received, material issued, and dispatch transfers.</p>
        </div>
        {canWrite && (
          <button className="btn-primary" onClick={() => setShowForm((s) => !s)}>
            {showForm ? (
              <X className="h-4 w-4" strokeWidth={2.5} />
            ) : (
              <>
                <Plus className="h-4 w-4" strokeWidth={2.5} /> Log Entry
              </>
            )}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile icon={Boxes} label="Items Tracked" value={itemsTracked} accent="brand" />
        <StatTile icon={Package} label="Negative Stock" value={negativeStock} accent={negativeStock ? "rose" : "slate"} />
        {dispatchTab ? (
          <StatTile icon={tab === "FG" ? Truck : FileText} label={`${DISPATCH_TYPE_LABEL[tab]} Entries`} value={dispatchTransfers?.length ?? 0} accent="emerald" />
        ) : (
          <StatTile icon={Truck} label="Dispatch Transfers" value="See Dispatch tabs" accent="slate" />
        )}
      </div>

      {showForm && canWrite && (dispatchTab ? <DispatchTransferForm initialType={tab} onDone={() => setShowForm(false)} /> : <LogEntryForm initialType={tab === "stock" ? "RECEIVED" : tab} onDone={() => setShowForm(false)} />)}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="scrollbar-none flex w-fit max-w-full flex-wrap gap-1 overflow-x-auto rounded-xl bg-slate-100/80 p-1">
          {[...MATERIAL_TABS, ...DISPATCH_TABS].map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => switchTab(t.key)}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-bold transition-all duration-150 sm:px-4 ${
                  active ? "bg-white text-slate-900 shadow-soft" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
                <span className="truncate">{t.label}</span>
              </button>
            );
          })}
        </div>
        <div className="w-full sm:w-72">
          <SearchBar value={search} onChange={setSearch} placeholder={dispatchTab ? "Search by product or customer…" : "Search by item or vendor…"} />
        </div>
      </div>

      {tab === "stock" ? (
        <StockTable loading={stockLoading} rows={filteredStock} empty={!stock?.length} />
      ) : dispatchTab ? (
        <DispatchTable loading={dispatchLoading} rows={filteredDispatch} empty={!dispatchTransfers?.length} type={tab} canWrite={canWrite} />
      ) : (
        <TransactionTable loading={txnLoading} rows={filteredTxns} empty={!transactions?.length} type={tab} canWrite={canWrite} />
      )}
    </div>
  );
}

function StockTable({ loading, rows, empty }: { loading: boolean; rows: ReturnType<typeof useInventoryStock>["data"]; empty: boolean }) {
  if (loading) return <SkeletonRows rows={5} cols={7} />;
  if (empty) return <EmptyState icon={Warehouse} title="No inventory items yet" hint="Log a received or issued entry to add the first item." accent="brand" />;
  if (!rows?.length) return <EmptyState icon={Warehouse} title="No matching items" hint="Try a different search." accent="slate" />;

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="table-modern w-full">
          <thead>
            <tr>
              <th>Item</th>
              <th>Category</th>
              <th>Unit</th>
              <th className="text-right">Received</th>
              <th className="text-right">Issued (Day Store)</th>
              <th className="text-right">Issued (Production)</th>
              <th className="text-right">On Hand</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.item.id}>
                <td className="font-bold text-slate-800">{s.item.name}</td>
                <td className="text-slate-600">{CATEGORY_LABEL[s.item.category]}</td>
                <td className="text-slate-500">{s.item.unit ?? "—"}</td>
                <td className="text-right font-mono text-emerald-600">{s.receivedQty}</td>
                <td className="text-right font-mono text-amber-600">{s.issuedDayStoreQty}</td>
                <td className="text-right font-mono text-amber-600">{s.issuedProductionQty}</td>
                <td className={`text-right font-mono font-bold ${s.onHand < 0 ? "text-rose-600" : "text-slate-800"}`}>{s.onHand}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TransactionTable({
  loading,
  rows,
  empty,
  type,
  canWrite,
}: {
  loading: boolean;
  rows: ReturnType<typeof useInventoryTransactions>["data"];
  empty: boolean;
  type: InventoryTxnType;
  canWrite: boolean;
}) {
  const toast = useToast();
  const deleteTxn = useDeleteInventoryTransaction();

  if (loading) return <SkeletonRows rows={5} cols={7} />;
  if (empty)
    return (
      <EmptyState
        icon={type === "RECEIVED" ? ArrowDownToLine : ArrowUpFromLine}
        title={`No ${TXN_TYPE_LABEL[type].toLowerCase()} entries yet`}
        hint={canWrite ? "Log one above to get started." : "Ask Store to log the first entry."}
        accent="brand"
      />
    );
  if (!rows?.length) return <EmptyState icon={Warehouse} title="No matching entries" hint="Try a different search." accent="slate" />;

  async function handleDelete(id: string) {
    try {
      await deleteTxn.mutateAsync(id);
      toast.success("Entry removed.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove entry");
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="table-modern w-full">
          <thead>
            <tr>
              <th>Date</th>
              <th>Item</th>
              <th>Category</th>
              <th className="text-right">Qty</th>
              <th>Unit</th>
              <th>Size</th>
              <th>{type === "RECEIVED" ? "Vendor" : "Vendor / Note"}</th>
              {canWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td className="text-slate-500">{new Date(t.date).toLocaleDateString()}</td>
                <td className="font-bold text-slate-800">{t.item.name}</td>
                <td className="text-slate-600">{CATEGORY_LABEL[t.item.category]}</td>
                <td className="text-right font-mono font-bold text-slate-700">{t.quantity}</td>
                <td className="text-slate-500">{t.unit}</td>
                <td className="text-slate-500">{t.size ?? "—"}</td>
                <td className="text-slate-500">{t.vendorName ?? "—"}</td>
                {canWrite && (
                  <td className="text-right">
                    <button onClick={() => handleDelete(t.id)} className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" title="Remove entry">
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DispatchTable({
  loading,
  rows,
  empty,
  type,
  canWrite,
}: {
  loading: boolean;
  rows: ReturnType<typeof useDispatchTransfers>["data"];
  empty: boolean;
  type: DispatchTransferType;
  canWrite: boolean;
}) {
  const toast = useToast();
  const deleteTransfer = useDeleteDispatchTransfer();

  if (loading) return <SkeletonRows rows={5} cols={5} />;
  if (empty)
    return (
      <EmptyState
        icon={type === "FG" ? Truck : FileText}
        title={`No ${DISPATCH_TYPE_LABEL[type].toLowerCase()} entries yet`}
        hint={canWrite ? "Log one above to get started." : "Ask Store to log the first entry."}
        accent="brand"
      />
    );
  if (!rows?.length) return <EmptyState icon={Warehouse} title="No matching entries" hint="Try a different search." accent="slate" />;

  async function handleDelete(id: string) {
    try {
      await deleteTransfer.mutateAsync(id);
      toast.success("Entry removed.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove entry");
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="table-modern w-full">
          <thead>
            <tr>
              <th>Date</th>
              <th>Customer</th>
              <th>Product Name</th>
              <th className="text-right">Qty</th>
              {canWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td className="text-slate-500">{new Date(d.date).toLocaleDateString()}</td>
                <td className="font-bold text-slate-800">{d.customer.companyName}</td>
                <td className="text-slate-600">{d.productName}</td>
                <td className="text-right font-mono font-bold text-slate-700">{d.quantity}</td>
                {canWrite && (
                  <td className="text-right">
                    <button onClick={() => handleDelete(d.id)} className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" title="Remove entry">
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LogEntryForm({ initialType, onDone }: { initialType: InventoryTxnType; onDone: () => void }) {
  const toast = useToast();
  const [type, setType] = useState<InventoryTxnType>(initialType);
  const [category, setCategory] = useState<InventoryCategory>("RM");
  const { data: items } = useInventoryItems(category);
  const createItem = useCreateInventoryItem();
  const createTxn = useCreateInventoryTransaction();

  const [itemId, setItemId] = useState("");
  const [showNewItem, setShowNewItem] = useState(false);
  const [newItemName, setNewItemName] = useState("");

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [unit, setUnit] = useState(UNIT_OPTIONS[0]!);
  const [quantity, setQuantity] = useState("");
  const [size, setSize] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sortedItems = useMemo(() => items ?? [], [items]);

  function switchCategory(next: InventoryCategory) {
    setCategory(next);
    setItemId("");
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
      });
      toast.success(`${TXN_TYPE_LABEL[type]} entry logged.`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not log entry");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card animate-slide-up space-y-5 p-5 sm:p-6">
      <div className="scrollbar-none flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-slate-100/80 p-1">
        {(["RECEIVED", "ISSUED_DAY_STORE", "ISSUED_PRODUCTION"] as InventoryTxnType[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-bold transition-all duration-150 ${
              type === t ? "bg-white text-slate-900 shadow-soft" : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {t === "RECEIVED" ? <ArrowDownToLine className="h-3.5 w-3.5" strokeWidth={2.25} /> : <ArrowUpFromLine className="h-3.5 w-3.5" strokeWidth={2.25} />}
            {TXN_TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="label">Category</label>
          <select className="field" value={category} onChange={(e) => switchCategory(e.target.value as InventoryCategory)}>
            <option value="RM">Raw Material</option>
            <option value="PM">Packaging Material</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label">Item</label>
          {!showNewItem ? (
            <div className="flex gap-2">
              <select className="field" value={itemId} onChange={(e) => setItemId(e.target.value)}>
                <option value="">— Select an item —</option>
                {sortedItems.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-ghost shrink-0" onClick={() => setShowNewItem(true)}>
                <UserPlus className="h-3.5 w-3.5" strokeWidth={2.25} /> New
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input className="field" placeholder="Exact item name" value={newItemName} onChange={(e) => setNewItemName(e.target.value)} />
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
          <select className="field" value={unit} onChange={(e) => setUnit(e.target.value)}>
            {UNIT_OPTIONS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
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
          <input className="field" placeholder="Vendor / supplier" value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
        </div>
      </div>

      {error && (
        <div className="animate-fade-in flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-bold text-rose-600">
          <X className="h-3.5 w-3.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
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

function DispatchTransferForm({ initialType, onDone }: { initialType: DispatchTransferType; onDone: () => void }) {
  const toast = useToast();
  const [type, setType] = useState<DispatchTransferType>(initialType);
  const { data: customers } = useCustomers();
  const createTransfer = useCreateDispatchTransfer();

  const [customerId, setCustomerId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [productName, setProductName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sortedCustomers = useMemo(() => customers ?? [], [customers]);

  async function handleSubmit() {
    setError(null);
    if (!customerId) return setError("Select a customer first.");
    if (!date) return setError("Pick a date.");
    if (!productName.trim()) return setError("Enter the product name.");
    if (!quantity || Number(quantity) <= 0) return setError("Enter a quantity greater than zero.");

    setSubmitting(true);
    try {
      await createTransfer.mutateAsync({
        type,
        date,
        customerId,
        productName: productName.trim(),
        quantity: Number(quantity),
      });
      toast.success(`${DISPATCH_TYPE_LABEL[type]} entry logged.`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not log entry");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card animate-slide-up space-y-5 p-5 sm:p-6">
      <div className="scrollbar-none flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-slate-100/80 p-1">
        {(["FG", "BILL"] as DispatchTransferType[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-bold transition-all duration-150 ${
              type === t ? "bg-white text-slate-900 shadow-soft" : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {t === "FG" ? <Truck className="h-3.5 w-3.5" strokeWidth={2.25} /> : <FileText className="h-3.5 w-3.5" strokeWidth={2.25} />}
            {DISPATCH_TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="label">Date</label>
          <input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label">Customer</label>
          <select className="field" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">— Select a customer —</option>
            {sortedCustomers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.companyName}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label">Product Name</label>
          <input className="field" placeholder="Exact product name" value={productName} onChange={(e) => setProductName(e.target.value)} />
        </div>
        <div>
          <label className="label">Qty</label>
          <input className="field font-mono" type="number" min="0" step="any" placeholder="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
      </div>

      {error && (
        <div className="animate-fade-in flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-bold text-rose-600">
          <X className="h-3.5 w-3.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={submitting} onClick={handleSubmit}>
          {submitting ? (
            "Logging…"
          ) : (
            <>
              <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> Log Entry
            </>
          )}
        </button>
      </div>
    </div>
  );
}
