import { useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  Check,
  CheckCircle2,
  ClipboardList,
  Download,
  FileText,
  Package,
  PackageCheck,
  Plus,
  Send,
  ShieldAlert,
  Trash2,
  Truck,
  Upload,
  UserPlus,
  Warehouse,
  X,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useAcceptTransaction,
  useCreateDispatchTransfer,
  useCreateInventoryItem,
  useCreateInventoryRequest,
  useCreateInventoryTransaction,
  useCustomers,
  useDeleteDispatchTransfer,
  useDeleteInventoryRequest,
  useDeleteInventoryTransaction,
  useDispatchTransfers,
  useImportInventoryTransactions,
  useInventoryItems,
  useInventoryRequests,
  useInventoryStock,
  useInventoryTransactions,
  useInventoryVendors,
  useIssueInventoryRequest,
  useQcReviewDispatchTransfer,
  useQcReviewTransaction,
  useReviewInventoryRequest,
} from "../lib/hooks";
import type { DispatchTransfer, DispatchTransferType, InventoryCategory, InventoryRequest, InventoryRequestPurpose, InventoryTransaction, InventoryTxnType } from "../lib/types";
import { parseInventoryTransactionWorkbook } from "../lib/inventoryImport";
import { exportDispatchReport, exportRequestsReport, exportStockReport, exportTransactionReport } from "../lib/inventoryExport";
import { ApiError } from "../lib/api";
import { StatTile } from "../components/StatTile";
import { EmptyState } from "../components/EmptyState";
import { SkeletonRows } from "../components/Skeleton";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { RequestStatusBadge } from "../components/Badges";

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
const REQUEST_PURPOSE_LABEL: Record<InventoryRequestPurpose, string> = {
  ISSUED_DAY_STORE: "Issued to Day Store",
  ISSUED_PRODUCTION: "Issued to Production",
};

// Same visual language as RequestStatusBadge — a colored pill with a dot.
const QC_STATUS_STYLE: Record<string, string> = {
  PENDING_QC: "bg-amber-50 text-amber-700 border-amber-200",
  QC_APPROVED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  QC_REJECTED: "bg-rose-50 text-rose-700 border-rose-200",
  ACCEPTED: "bg-brand-50 text-brand-700 border-brand-200",
};
const QC_STATUS_DOT: Record<string, string> = {
  PENDING_QC: "animate-pulse bg-amber-500",
  QC_APPROVED: "bg-emerald-500",
  QC_REJECTED: "bg-rose-500",
  ACCEPTED: "bg-brand-500",
};
const QC_STATUS_LABEL: Record<string, string> = {
  PENDING_QC: "Pending QC",
  QC_APPROVED: "QC Approved",
  QC_REJECTED: "QC Rejected",
  ACCEPTED: "Accepted",
};

function QcStatusBadge({ status }: { status: string }) {
  return (
    <span className={`pill ${QC_STATUS_STYLE[status] ?? "border-slate-200 bg-slate-100 text-slate-500"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${QC_STATUS_DOT[status] ?? "bg-slate-400"}`} />
      {QC_STATUS_LABEL[status] ?? status}
    </span>
  );
}

type ViewTab = "stock" | InventoryTxnType | DispatchTransferType | "requests";

const MATERIAL_TABS: { key: ViewTab; label: string; icon: typeof Warehouse }[] = [
  { key: "stock", label: "Stock on Hand", icon: Warehouse },
  { key: "RECEIVED", label: "Material Received", icon: ArrowDownToLine },
  { key: "ISSUED_DAY_STORE", label: "Issued to Day Store", icon: ArrowUpFromLine },
  { key: "ISSUED_PRODUCTION", label: "Issued to Production", icon: ArrowUpFromLine },
  { key: "requests", label: "Material Requests", icon: ClipboardList },
];

const DISPATCH_TABS: { key: ViewTab; label: string; icon: typeof Warehouse }[] = [
  { key: "FG", label: "FG Transfer to Dispatch", icon: Truck },
  { key: "BILL", label: "Bill Transfer to Dispatch", icon: FileText },
];

function isDispatchTab(tab: ViewTab): tab is DispatchTransferType {
  return tab === "FG" || tab === "BILL";
}

export function InventoryPage() {
  const { hasRole, user } = useAuth();
  const canWrite = hasRole("STORE"); // Store or Admin — owns the full ledger + dispatch log + request review/issue/accept
  const canRequest = hasRole("PPIC"); // PPIC or Admin — can raise a Material Request
  const canQc = hasRole("QA_QC"); // QA/QC or Admin — inward QC on Received, outward QC on FG transfers

  // Per-tab visibility — each department only gets the slice of this
  // module its role actually has API access to (see inventory.routes.ts).
  const tabVisible: Record<ViewTab, boolean> = {
    stock: canWrite || canRequest,
    RECEIVED: canWrite || canQc,
    ISSUED_DAY_STORE: canWrite,
    ISSUED_PRODUCTION: canWrite,
    requests: canWrite || canRequest,
    FG: canWrite || canQc,
    BILL: canWrite,
  };
  const visibleMaterialTabs = MATERIAL_TABS.filter((t) => tabVisible[t.key]);
  const visibleDispatchTabs = DISPATCH_TABS.filter((t) => tabVisible[t.key]);

  const toast = useToast();
  const importFileRef = useRef<HTMLInputElement>(null);
  const importTxns = useImportInventoryTransactions();

  // Land on the first tab this role can actually see — "stock" 403s for
  // a QA_QC-only account, so it can't be a blind default.
  const [tab, setTab] = useState<ViewTab>(() => [...visibleMaterialTabs, ...visibleDispatchTabs][0]?.key ?? "stock");
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);

  const dispatchTab = isDispatchTab(tab);
  const isRequestsTab = tab === "requests";
  const materialTab = !dispatchTab && !isRequestsTab && tab !== "stock";
  const canLogDirectly = materialTab && tab !== "ISSUED_PRODUCTION" && tab !== "RECEIVED"; // Issued to Day Store only — Received now goes through the QC/accept flow too, but Store still logs the initial entry via this same form

  const { data: stock, isLoading: stockLoading } = useInventoryStock(undefined, { enabled: tabVisible.stock });
  const { data: transactions, isLoading: txnLoading } = useInventoryTransactions(materialTab ? { type: tab as InventoryTxnType } : undefined, {
    enabled: materialTab && (tab === "RECEIVED" ? canWrite || canQc : canWrite),
  });
  const { data: dispatchTransfers, isLoading: dispatchLoading } = useDispatchTransfers(dispatchTab ? { type: tab } : undefined, {
    enabled: dispatchTab && (tab === "FG" ? canWrite || canQc : canWrite),
  });
  const { data: dispatchTotal } = useDispatchTransfers(undefined, { enabled: canWrite });
  const { data: pendingRequests } = useInventoryRequests("PENDING", { enabled: tabVisible.stock });
  const { data: approvedRequests } = useInventoryRequests("APPROVED", { enabled: canRequest && !canWrite });
  const { data: allRequests, isLoading: requestsLoading } = useInventoryRequests(undefined, { enabled: isRequestsTab });
  const { data: pendingReceiptQc } = useInventoryTransactions({ type: "RECEIVED", receiptStatus: "PENDING_QC" }, { enabled: canQc });
  const { data: pendingDispatchQc } = useDispatchTransfers({ type: "FG", qcStatus: "PENDING_QC" }, { enabled: canQc });

  const itemsTracked = stock?.length ?? 0;
  const negativeStock = stock?.filter((s) => s.onHand < 0).length ?? 0;

  const q = search.trim().toLowerCase();
  const filteredStock = stock?.filter((s) => !q || s.item.name.toLowerCase().includes(q));
  const filteredTxns = transactions?.filter((t) => !q || t.item.name.toLowerCase().includes(q) || (t.vendorName ?? "").toLowerCase().includes(q));
  const filteredDispatch = dispatchTransfers?.filter((d) => !q || d.productName.toLowerCase().includes(q) || d.customer.companyName.toLowerCase().includes(q));
  const filteredRequests = allRequests?.filter((r) => !q || r.item.name.toLowerCase().includes(q) || r.requestedBy.fullName.toLowerCase().includes(q));

  function switchTab(next: ViewTab) {
    setTab(next);
    setShowForm(false);
  }

  function handleExport() {
    if (tab === "stock") {
      if (!filteredStock?.length) return toast.error("Nothing to export — no stock rows match.");
      exportStockReport(filteredStock);
    } else if (dispatchTab) {
      if (!filteredDispatch?.length) return toast.error("Nothing to export — no entries match.");
      exportDispatchReport(filteredDispatch, DISPATCH_TYPE_LABEL[tab], DISPATCH_TYPE_LABEL[tab].replace(/\s+/g, "_"));
    } else if (isRequestsTab) {
      if (!filteredRequests?.length) return toast.error("Nothing to export — no requests match.");
      exportRequestsReport(filteredRequests);
    } else {
      if (!filteredTxns?.length) return toast.error("Nothing to export — no entries match.");
      exportTransactionReport(filteredTxns, TXN_TYPE_LABEL[tab as InventoryTxnType], TXN_TYPE_LABEL[tab as InventoryTxnType].replace(/\s+/g, "_"));
    }
    toast.success("Report downloaded — ready to share with the department.");
  }

  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file next time
    if (!file || !canLogDirectly) return;

    try {
      const buffer = await file.arrayBuffer();
      const { rows, skipped } = parseInventoryTransactionWorkbook(buffer, "RM");
      if (!rows.length) return toast.error("No usable rows found — check the Item, Date, Unit, and Count/Quantity columns.");

      const result = await importTxns.mutateAsync({ type: tab as InventoryTxnType, rows });
      const skippedNote = skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped — missing a required field)` : "";
      toast.success(`Imported ${result.transactionsCreated} ${TXN_TYPE_LABEL[tab as InventoryTxnType].toLowerCase()} entr${result.transactionsCreated === 1 ? "y" : "ies"}${result.itemsCreated ? `, ${result.itemsCreated} new item(s)` : ""}${skippedNote}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not import spreadsheet");
    }
  }

  // Received also opens the manual Log Entry form — Store still logs the
  // initial arrival by hand (or Excel import), it's what happens *after*
  // that changed (QC gate before it counts as stock).
  const canLogReceived = tab === "RECEIVED" && canWrite;
  const showPrimaryButton = (dispatchTab && canWrite) || (isRequestsTab && canRequest) || (canLogDirectly && canWrite) || canLogReceived;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Inventory</h1>
          <p className="text-sm text-slate-500">Warehouse-level material received, material issued, and dispatch transfers.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" onClick={handleExport} title="Download this tab as an Excel report">
            <Download className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Report
          </button>
          {canWrite && (canLogDirectly || tab === "RECEIVED") && (
            <>
              <button className="btn-ghost" disabled={importTxns.isPending} onClick={() => importFileRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> {importTxns.isPending ? "Importing…" : "Import Excel"}
              </button>
              <input ref={importFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
            </>
          )}
          {tab === "ISSUED_PRODUCTION" && canWrite && (
            <button className="btn-ghost" onClick={() => switchTab("requests")}>
              <ClipboardList className="h-3.5 w-3.5" strokeWidth={2.5} /> Go to Material Requests
            </button>
          )}
          {showPrimaryButton && (
            <button className="btn-primary" onClick={() => setShowForm((s) => !s)}>
              {showForm ? (
                <X className="h-4 w-4" strokeWidth={2.5} />
              ) : (
                <>
                  <Plus className="h-4 w-4" strokeWidth={2.5} /> {isRequestsTab ? "New Request" : "Log Entry"}
                </>
              )}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tabVisible.stock ? (
          <>
            <StatTile icon={Boxes} label="Items Tracked" value={itemsTracked} accent="brand" />
            <StatTile icon={Package} label="Negative Stock" value={negativeStock} accent={negativeStock ? "rose" : "slate"} />
            <StatTile icon={ClipboardList} label="Pending Requests" value={pendingRequests?.length ?? 0} accent={pendingRequests?.length ? "amber" : "slate"} />
            {canWrite ? (
              <StatTile icon={Truck} label="Dispatch Transfers" value={dispatchTotal?.length ?? 0} accent="emerald" />
            ) : (
              <StatTile icon={CheckCircle2} label="Approved, Ready to Issue" value={approvedRequests?.length ?? 0} accent={approvedRequests?.length ? "emerald" : "slate"} />
            )}
          </>
        ) : (
          // QA/QC-only view — no stock/request visibility, just their own queue.
          <>
            <StatTile icon={ArrowDownToLine} label="Pending Inward QC" value={pendingReceiptQc?.length ?? 0} accent={pendingReceiptQc?.length ? "amber" : "slate"} />
            <StatTile icon={Truck} label="Pending Outward QC" value={pendingDispatchQc?.length ?? 0} accent={pendingDispatchQc?.length ? "amber" : "slate"} />
          </>
        )}
      </div>

      {showForm &&
        (dispatchTab && canWrite ? (
          <DispatchTransferForm initialType={tab} onDone={() => setShowForm(false)} />
        ) : isRequestsTab && canRequest ? (
          <NewInventoryRequestForm onDone={() => setShowForm(false)} />
        ) : (canLogDirectly || canLogReceived) && canWrite ? (
          // canLogDirectly/canLogReceived guarantee tab is "RECEIVED" | "ISSUED_DAY_STORE" here.
          <LogEntryForm initialType={tab as Exclude<InventoryTxnType, "ISSUED_PRODUCTION">} onDone={() => setShowForm(false)} />
        ) : null)}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="scrollbar-none flex w-fit max-w-full flex-wrap gap-1 overflow-x-auto rounded-xl bg-slate-100/80 p-1">
          {[...visibleMaterialTabs, ...visibleDispatchTabs].map((t) => {
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
          <SearchBar value={search} onChange={setSearch} placeholder={dispatchTab ? "Search by product or customer…" : isRequestsTab ? "Search by item or requester…" : "Search by item or vendor…"} />
        </div>
      </div>

      {tab === "stock" ? (
        <StockTable loading={stockLoading} rows={filteredStock} empty={!stock?.length} />
      ) : tab === "RECEIVED" ? (
        <ReceivedList loading={txnLoading} rows={filteredTxns} empty={!transactions?.length} canQc={canQc} canWrite={canWrite} />
      ) : tab === "FG" ? (
        <FgTransferList loading={dispatchLoading} rows={filteredDispatch} empty={!dispatchTransfers?.length} canQc={canQc} canWrite={canWrite} />
      ) : dispatchTab ? (
        <DispatchTable loading={dispatchLoading} rows={filteredDispatch} empty={!dispatchTransfers?.length} type={tab} canWrite={canWrite} />
      ) : isRequestsTab ? (
        <MaterialRequestsPanel loading={requestsLoading} rows={filteredRequests} empty={!allRequests?.length} canReview={canWrite} currentUserId={user?.id} />
      ) : (
        <TransactionTable loading={txnLoading} rows={filteredTxns} empty={!transactions?.length} type={tab as InventoryTxnType} canWrite={canWrite} />
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
        icon={ArrowUpFromLine}
        title={`No ${TXN_TYPE_LABEL[type].toLowerCase()} entries yet`}
        hint={type === "ISSUED_PRODUCTION" ? "Approved Material Requests land here once Store issues them." : canWrite ? "Log one above to get started." : "Ask Store to log the first entry."}
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
              <th>Vendor / Note</th>
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
        icon={FileText}
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

function LogEntryForm({ initialType, onDone }: { initialType: Exclude<InventoryTxnType, "ISSUED_PRODUCTION">; onDone: () => void }) {
  const toast = useToast();
  const [type, setType] = useState<Exclude<InventoryTxnType, "ISSUED_PRODUCTION">>(initialType);
  const [category, setCategory] = useState<InventoryCategory>("RM");
  const { data: items } = useInventoryItems(category);
  const { data: vendors } = useInventoryVendors();
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
      toast.success(type === "RECEIVED" ? "Entry logged — awaiting inward QC." : `${TXN_TYPE_LABEL[type]} entry logged.`);
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
        {(["RECEIVED", "ISSUED_DAY_STORE"] as const).map((t) => (
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

      {type === "RECEIVED" && (
        <p className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} /> This won't count as stock until QA/QC approves it and Store accepts it.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
            <div className="flex flex-wrap gap-2">
              <select className="field min-w-0 flex-1" value={itemId} onChange={(e) => setItemId(e.target.value)}>
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
          <input className="field" list="vendor-name-options" placeholder="Vendor / supplier" value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
          <datalist id="vendor-name-options">
            {vendors?.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
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
      toast.success(type === "FG" ? "FG transfer logged — awaiting outward QC." : `${DISPATCH_TYPE_LABEL[type]} entry logged.`);
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

      {type === "FG" && (
        <p className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} /> Goes to QA/QC for outward check before it's cleared for Dispatch.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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

      <div className="flex flex-wrap justify-end gap-2">
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

// --- Inward QC — a RECEIVED row starts PENDING_QC (see LogEntryForm),
// QA/QC reviews it here, then Store accepts it before it's real stock. ---

function ReceivedList({
  loading,
  rows,
  empty,
  canQc,
  canWrite,
}: {
  loading: boolean;
  rows: InventoryTransaction[] | undefined;
  empty: boolean;
  canQc: boolean;
  canWrite: boolean;
}) {
  if (loading) return <SkeletonRows rows={4} cols={1} />;
  if (empty)
    return (
      <EmptyState icon={ArrowDownToLine} title="No material received entries yet" hint={canWrite ? "Log one above to get started." : "Ask Store to log the first entry."} accent="brand" />
    );
  if (!rows?.length) return <EmptyState icon={Warehouse} title="No matching entries" hint="Try a different search." accent="slate" />;

  return (
    <div className="space-y-3">
      {rows.map((t) => (
        <ReceivedCard key={t.id} txn={t} canQc={canQc} canWrite={canWrite} />
      ))}
    </div>
  );
}

function ReceivedCard({ txn, canQc, canWrite }: { txn: InventoryTransaction; canQc: boolean; canWrite: boolean }) {
  const toast = useToast();
  const qcReview = useQcReviewTransaction();
  const accept = useAcceptTransaction();
  const deleteTxn = useDeleteInventoryTransaction();

  const [showReject, setShowReject] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleApprove() {
    try {
      await qcReview.mutateAsync({ id: txn.id, action: "APPROVE" });
      toast.success("QC approved — ready for Store to accept.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not approve QC");
    }
  }

  async function handleReject() {
    if (!note.trim()) return setError("A note is required when rejecting QC.");
    try {
      await qcReview.mutateAsync({ id: txn.id, action: "REJECT", note: note.trim() });
      toast.success("QC rejected.");
      setShowReject(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reject QC");
    }
  }

  async function handleAccept() {
    try {
      await accept.mutateAsync(txn.id);
      toast.success("Accepted — now counted in stock on hand.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not accept");
    }
  }

  async function handleDelete() {
    try {
      await deleteTxn.mutateAsync(txn.id);
      toast.success("Entry removed.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove entry");
    }
  }

  return (
    <div className="card space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-bold text-slate-800">{txn.item.name}</p>
            {txn.receiptStatus && <QcStatusBadge status={txn.receiptStatus} />}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {CATEGORY_LABEL[txn.item.category]} · <span className="font-mono font-bold text-slate-700">{txn.quantity}</span> {txn.unit}
            {txn.size && <> · {txn.size}</>}
            {txn.vendorName && <> · {txn.vendorName}</>} · {new Date(txn.date).toLocaleDateString()}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Logged by {txn.createdBy.fullName}
            {txn.qcCheckedBy && <> · QC by {txn.qcCheckedBy.fullName}</>}
            {txn.acceptedBy && <> · accepted by {txn.acceptedBy.fullName}</>}
          </p>
          {txn.receiptStatus === "QC_REJECTED" && txn.qcNote && <p className="mt-1.5 text-xs font-bold text-rose-600">Reason: {txn.qcNote}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canQc && txn.receiptStatus === "PENDING_QC" && !showReject && (
            <>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setShowReject(true)}>
                <X className="h-3 w-3" strokeWidth={2.5} /> Reject
              </button>
              <button type="button" className="btn-primary btn-sm" disabled={qcReview.isPending} onClick={handleApprove}>
                <Check className="h-3 w-3" strokeWidth={2.5} /> {qcReview.isPending ? "Approving…" : "Approve QC"}
              </button>
            </>
          )}
          {canWrite && txn.receiptStatus === "QC_APPROVED" && (
            <button type="button" className="btn-primary btn-sm" disabled={accept.isPending} onClick={handleAccept}>
              <PackageCheck className="h-3.5 w-3.5" strokeWidth={2.5} /> {accept.isPending ? "Accepting…" : "Accept into Stock"}
            </button>
          )}
          {canWrite && !showReject && (
            <button type="button" className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" title="Remove entry" onClick={handleDelete}>
              <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>

      {showReject && (
        <div className="animate-fade-in rounded-xl border border-rose-200 bg-rose-50/60 p-3">
          <textarea className="field min-h-[3rem] resize-y" placeholder="Required — why is this failing inward QC?" value={note} onChange={(e) => setNote(e.target.value)} />
          {error && <p className="mt-1.5 text-xs font-bold text-rose-600">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setShowReject(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn-danger btn-sm" disabled={qcReview.isPending} onClick={handleReject}>
              {qcReview.isPending ? "Rejecting…" : "Confirm Reject"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Outward QC — an FG transfer starts PENDING_QC (see
// DispatchTransferForm); QA/QC reviews it here before it's cleared to
// hand off to Dispatch. Doesn't affect stock either way. ---

function FgTransferList({
  loading,
  rows,
  empty,
  canQc,
  canWrite,
}: {
  loading: boolean;
  rows: DispatchTransfer[] | undefined;
  empty: boolean;
  canQc: boolean;
  canWrite: boolean;
}) {
  if (loading) return <SkeletonRows rows={4} cols={1} />;
  if (empty) return <EmptyState icon={Truck} title="No FG transfer entries yet" hint={canWrite ? "Log one above to get started." : "Ask Store to log the first entry."} accent="brand" />;
  if (!rows?.length) return <EmptyState icon={Warehouse} title="No matching entries" hint="Try a different search." accent="slate" />;

  return (
    <div className="space-y-3">
      {rows.map((d) => (
        <FgTransferCard key={d.id} transfer={d} canQc={canQc} canWrite={canWrite} />
      ))}
    </div>
  );
}

function FgTransferCard({ transfer, canQc, canWrite }: { transfer: DispatchTransfer; canQc: boolean; canWrite: boolean }) {
  const toast = useToast();
  const qcReview = useQcReviewDispatchTransfer();
  const deleteTransfer = useDeleteDispatchTransfer();

  const [showReject, setShowReject] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleApprove() {
    try {
      await qcReview.mutateAsync({ id: transfer.id, action: "APPROVE" });
      toast.success("Outward QC approved.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not approve QC");
    }
  }

  async function handleReject() {
    if (!note.trim()) return setError("A note is required when rejecting QC.");
    try {
      await qcReview.mutateAsync({ id: transfer.id, action: "REJECT", note: note.trim() });
      toast.success("Outward QC rejected.");
      setShowReject(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reject QC");
    }
  }

  async function handleDelete() {
    try {
      await deleteTransfer.mutateAsync(transfer.id);
      toast.success("Entry removed.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove entry");
    }
  }

  return (
    <div className="card space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-bold text-slate-800">{transfer.productName}</p>
            {transfer.qcStatus && <QcStatusBadge status={transfer.qcStatus} />}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {transfer.customer.companyName} · <span className="font-mono font-bold text-slate-700">{transfer.quantity}</span> · {new Date(transfer.date).toLocaleDateString()}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Logged by {transfer.createdBy.fullName}
            {transfer.qcCheckedBy && <> · QC by {transfer.qcCheckedBy.fullName}</>}
          </p>
          {transfer.qcStatus === "QC_REJECTED" && transfer.qcNote && <p className="mt-1.5 text-xs font-bold text-rose-600">Reason: {transfer.qcNote}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canQc && transfer.qcStatus === "PENDING_QC" && !showReject && (
            <>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setShowReject(true)}>
                <X className="h-3 w-3" strokeWidth={2.5} /> Reject
              </button>
              <button type="button" className="btn-primary btn-sm" disabled={qcReview.isPending} onClick={handleApprove}>
                <Check className="h-3 w-3" strokeWidth={2.5} /> {qcReview.isPending ? "Approving…" : "Approve QC"}
              </button>
            </>
          )}
          {canWrite && !showReject && (
            <button type="button" className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" title="Remove entry" onClick={handleDelete}>
              <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>

      {showReject && (
        <div className="animate-fade-in rounded-xl border border-rose-200 bg-rose-50/60 p-3">
          <textarea className="field min-h-[3rem] resize-y" placeholder="Required — why is this failing outward QC?" value={note} onChange={(e) => setNote(e.target.value)} />
          {error && <p className="mt-1.5 text-xs font-bold text-rose-600">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setShowReject(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn-danger btn-sm" disabled={qcReview.isPending} onClick={handleReject}>
              {qcReview.isPending ? "Rejecting…" : "Confirm Reject"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Material Requests — PPIC raises one, Store approves/rejects it,
// then issues it (which is what actually creates the ISSUED_* ledger
// row). This is the department-wise gate: Store can no longer decide on
// its own what leaves the shelf for Production. ---

function NewInventoryRequestForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [category, setCategory] = useState<InventoryCategory>("RM");
  const { data: items } = useInventoryItems(category);
  const createRequest = useCreateInventoryRequest();

  const [itemId, setItemId] = useState("");
  const [purpose, setPurpose] = useState<InventoryRequestPurpose>("ISSUED_PRODUCTION");
  const [requestedQty, setRequestedQty] = useState("");
  const [neededBy, setNeededBy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sortedItems = useMemo(() => items ?? [], [items]);

  function switchCategory(next: InventoryCategory) {
    setCategory(next);
    setItemId("");
  }

  async function handleSubmit() {
    setError(null);
    if (!itemId) return setError("Select an item first.");
    if (!requestedQty || Number(requestedQty) <= 0) return setError("Enter a quantity greater than zero.");

    setSubmitting(true);
    try {
      await createRequest.mutateAsync({
        itemId,
        category,
        purpose,
        requestedQty: Number(requestedQty),
        neededBy: neededBy || undefined,
        note: note.trim() || undefined,
      });
      toast.success("Request sent to Store for approval.");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit request");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card animate-slide-up space-y-5 p-5 sm:p-6">
      <div>
        <h3 className="text-sm font-bold text-slate-800">Raise a Material Request</h3>
        <p className="mt-0.5 text-xs text-slate-500">Store reviews this before it becomes an issue — nothing leaves the shelf until it's approved.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className="label">Category</label>
          <select className="field" value={category} onChange={(e) => switchCategory(e.target.value as InventoryCategory)}>
            <option value="RM">Raw Material</option>
            <option value="PM">Packaging Material</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label">Item</label>
          <select className="field" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">— Select an item —</option>
            {sortedItems.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Purpose</label>
          <select className="field" value={purpose} onChange={(e) => setPurpose(e.target.value as InventoryRequestPurpose)}>
            <option value="ISSUED_PRODUCTION">Issued to Production</option>
            <option value="ISSUED_DAY_STORE">Issued to Day Store</option>
          </select>
        </div>
        <div>
          <label className="label">Requested Qty</label>
          <input className="field font-mono" type="number" min="0" step="any" placeholder="Quantity" value={requestedQty} onChange={(e) => setRequestedQty(e.target.value)} />
        </div>
        <div>
          <label className="label">Needed By (optional)</label>
          <input type="date" className="field" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <label className="label">Note (optional)</label>
          <input className="field" placeholder="e.g. Batch GB-BCAA-0098, urgent" value={note} onChange={(e) => setNote(e.target.value)} />
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
          {submitting ? "Sending…" : "Send Request"}
        </button>
      </div>
    </div>
  );
}

function MaterialRequestsPanel({
  loading,
  rows,
  empty,
  canReview,
  currentUserId,
}: {
  loading: boolean;
  rows: InventoryRequest[] | undefined;
  empty: boolean;
  canReview: boolean;
  currentUserId: string | undefined;
}) {
  if (loading) return <SkeletonRows rows={4} cols={1} />;
  if (empty)
    return (
      <EmptyState
        icon={ClipboardList}
        title="No material requests yet"
        hint={canReview ? "PPIC raises a request before stock can be issued to Production." : "Raise one above to request stock from Store."}
        accent="brand"
      />
    );
  if (!rows?.length) return <EmptyState icon={Warehouse} title="No matching requests" hint="Try a different search." accent="slate" />;

  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <RequestCard key={r.id} request={r} canReview={canReview} isOwner={r.requestedBy.id === currentUserId} />
      ))}
    </div>
  );
}

function RequestCard({ request, canReview, isOwner }: { request: InventoryRequest; canReview: boolean; isOwner: boolean }) {
  const toast = useToast();
  const review = useReviewInventoryRequest();
  const issue = useIssueInventoryRequest();
  const deleteRequest = useDeleteInventoryRequest();

  const [showReject, setShowReject] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [showIssue, setShowIssue] = useState(false);
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [issueUnit, setIssueUnit] = useState(UNIT_OPTIONS[0]!);
  const [issueQty, setIssueQty] = useState(String(request.requestedQty));
  const [issueSize, setIssueSize] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleApprove() {
    try {
      await review.mutateAsync({ id: request.id, action: "APPROVE" });
      toast.success("Request approved.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not approve request");
    }
  }

  async function handleReject() {
    if (!rejectionReason.trim()) return setError("A reason is required to reject a request.");
    try {
      await review.mutateAsync({ id: request.id, action: "REJECT", rejectionReason: rejectionReason.trim() });
      toast.success("Request rejected.");
      setShowReject(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reject request");
    }
  }

  async function handleIssue() {
    setError(null);
    if (!issueQty || Number(issueQty) <= 0) return setError("Enter a quantity greater than zero.");
    try {
      await issue.mutateAsync({ id: request.id, date: issueDate, unit: issueUnit, quantity: Number(issueQty), size: issueSize.trim() || undefined });
      toast.success("Stock issued — added to the ledger.");
      setShowIssue(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not issue stock");
    }
  }

  async function handleWithdraw() {
    try {
      await deleteRequest.mutateAsync(request.id);
      toast.success("Request withdrawn.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not withdraw request");
    }
  }

  const canWithdraw = request.status === "PENDING" && (isOwner || canReview);

  return (
    <div className="card space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-bold text-slate-800">{request.item.name}</p>
            <RequestStatusBadge status={request.status} />
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {CATEGORY_LABEL[request.category]} · {REQUEST_PURPOSE_LABEL[request.purpose]} · <span className="font-mono font-bold text-slate-700">{request.requestedQty}</span> requested
            {request.neededBy && <> · needed by {new Date(request.neededBy).toLocaleDateString()}</>}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Requested by {request.requestedBy.fullName} · {new Date(request.createdAt).toLocaleDateString()}
            {request.reviewedBy && <> · reviewed by {request.reviewedBy.fullName}</>}
          </p>
          {request.note && <p className="mt-1.5 text-xs text-slate-600">"{request.note}"</p>}
          {request.status === "REJECTED" && request.rejectionReason && <p className="mt-1.5 text-xs font-bold text-rose-600">Reason: {request.rejectionReason}</p>}
          {request.status === "ISSUED" && request.fulfillment && (
            <p className="mt-1.5 flex items-center gap-1 text-xs font-bold text-brand-700">
              <PackageCheck className="h-3.5 w-3.5" strokeWidth={2.5} /> Issued {request.fulfillment.quantity} {request.fulfillment.unit} on {new Date(request.fulfillment.date).toLocaleDateString()}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canReview && request.status === "PENDING" && !showReject && (
            <>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setShowReject(true)}>
                <X className="h-3 w-3" strokeWidth={2.5} /> Reject
              </button>
              <button type="button" className="btn-primary btn-sm" disabled={review.isPending} onClick={handleApprove}>
                <Check className="h-3 w-3" strokeWidth={2.5} /> {review.isPending ? "Approving…" : "Approve"}
              </button>
            </>
          )}
          {canReview && request.status === "APPROVED" && !showIssue && (
            <button type="button" className="btn-primary btn-sm" onClick={() => setShowIssue(true)}>
              <PackageCheck className="h-3.5 w-3.5" strokeWidth={2.5} /> Issue Stock
            </button>
          )}
          {canWithdraw && !showReject && (
            <button type="button" className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" title="Withdraw request" onClick={handleWithdraw}>
              <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>

      {showReject && (
        <div className="animate-fade-in rounded-xl border border-rose-200 bg-rose-50/60 p-3">
          <textarea
            className="field min-h-[3rem] resize-y"
            placeholder="Required — why is this request being rejected?"
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value)}
          />
          {error && <p className="mt-1.5 text-xs font-bold text-rose-600">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setShowReject(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn-danger btn-sm" disabled={review.isPending} onClick={handleReject}>
              {review.isPending ? "Rejecting…" : "Confirm Reject"}
            </button>
          </div>
        </div>
      )}

      {showIssue && (
        <div className="animate-fade-in space-y-3 rounded-xl border border-brand-200 bg-brand-50/50 p-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className="label">Date</label>
              <input type="date" className="field" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
            </div>
            <div>
              <label className="label">Unit</label>
              <select className="field" value={issueUnit} onChange={(e) => setIssueUnit(e.target.value)}>
                {UNIT_OPTIONS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Qty Issued</label>
              <input className="field font-mono" type="number" min="0" step="any" value={issueQty} onChange={(e) => setIssueQty(e.target.value)} />
            </div>
            <div>
              <label className="label">Size (optional)</label>
              <input className="field" placeholder="e.g. 25 Kg bag" value={issueSize} onChange={(e) => setIssueSize(e.target.value)} />
            </div>
          </div>
          {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setShowIssue(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={issue.isPending} onClick={handleIssue}>
              {issue.isPending ? "Issuing…" : "Confirm Issue"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
