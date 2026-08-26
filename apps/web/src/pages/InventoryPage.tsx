import { useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  Check,
  CheckCircle2,
  ClipboardList,
  Download,
  FileSpreadsheet,
  FileText,
  Landmark,
  Package,
  PackageCheck,
  Pencil,
  Plus,
  Send,
  ShieldAlert,
  Trash2,
  Truck,
  Upload,
  UserPlus,
  Users,
  Warehouse,
  X,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useAcceptTransaction,
  useAssignDayStoreUser,
  useConfirmDispatch,
  useCreateDayStore,
  useCreateDispatchTransfer,
  useCreateInventoryItem,
  useCreateInventoryRequest,
  useCreateInventoryTransaction,
  useCreatePlant,
  useCustomers,
  useDayStoreAssignments,
  useDayStores,
  useDayStoreStock,
  useDeleteDispatchTransfer,
  useDeleteInventoryRequest,
  useDeleteInventoryTransaction,
  useDispatchTransfers,
  useImportDispatchTransfers,
  useImportInventoryRequests,
  useImportInventoryTransactions,
  useInventoryItems,
  useInventoryRequests,
  useInventoryStock,
  useInventoryTransactions,
  useInventoryVendors,
  useInvoiceDispatchTransfer,
  useIssueInventoryRequest,
  usePlants,
  usePlantStock,
  useQcReviewDispatchTransfer,
  useQcReviewTransaction,
  useRenameDayStore,
  useRenamePlant,
  useReviewInventoryRequest,
  useStoreUsers,
  useUnassignDayStoreUser,
} from "../lib/hooks";
import type {
  DayStore,
  DayStoreStockLine,
  DispatchTransfer,
  DispatchTransferType,
  InventoryCategory,
  InventoryRequest,
  InventoryRequestPurpose,
  InventoryTransaction,
  InventoryTxnType,
  Plant,
  PlantStockLine,
} from "../lib/types";
import { PickerWithAdd } from "../components/PickerWithAdd";
import { parseDispatchTransferWorkbook, parseInventoryRequestWorkbook, parseInventoryTransactionWorkbook } from "../lib/inventoryImport";
import {
  downloadDispatchImportTemplate,
  downloadInventoryImportTemplate,
  downloadInventoryRequestImportTemplate,
  exportCustomerReconciliationReport,
  exportDayStoreStockReport,
  exportDispatchReport,
  exportItemStockByLocation,
  exportPlantStockReport,
  exportRequestsReport,
  exportStockReport,
  exportTransactionReport,
} from "../lib/inventoryExport";
import { ApiError, api } from "../lib/api";
import type { CustomerReconciliationRow, ItemStockByLocation } from "../lib/types";
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
  ISSUED_DAY_STORE: "Issued to Store",
  ISSUED_PRODUCTION: "Issued to Production",
};
const DISPATCH_TYPE_LABEL: Record<DispatchTransferType, string> = {
  FG: "FG Transfer to Dispatch",
  BILL: "Bill Transfer to Dispatch",
};
const REQUEST_PURPOSE_LABEL: Record<InventoryRequestPurpose, string> = {
  ISSUED_DAY_STORE: "Issued to Store",
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

// Compact "+ New Store" affordance for toolbars — the two places you'd
// actually reach for a new Day Store (the Stock on Hand Location
// dropdown, and the Import Excel Day Store dropdown) previously had no
// create option at all; you had to go find one in the Log Entry or
// Issue Stock forms first. Same create call as PickerWithAdd, just a
// smaller footprint to fit a toolbar row instead of a form field.
function QuickAddDayStore({ onCreated }: { onCreated: (id: string) => void }) {
  const toast = useToast();
  const createDayStore = useCreateDayStore();
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");

  async function handleCreate() {
    if (!name.trim()) return;
    try {
      const created = await createDayStore.mutateAsync(name.trim());
      onCreated(created.id);
      setShow(false);
      setName("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not create store — it may already exist.");
    }
  }

  if (!show) {
    return (
      <button type="button" className="btn-ghost btn-sm" onClick={() => setShow(true)} title="Add a new Store">
        <UserPlus className="h-3.5 w-3.5" strokeWidth={2.25} /> New Store
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <input
        autoFocus
        className="field w-36 px-2 py-1.5 text-[11px]"
        placeholder="Store name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleCreate()}
      />
      <button type="button" className="btn-primary btn-sm" disabled={createDayStore.isPending} onClick={handleCreate}>
        {createDayStore.isPending ? "…" : "Add"}
      </button>
      <button
        type="button"
        className="btn-ghost btn-sm"
        onClick={() => {
          setShow(false);
          setName("");
        }}
      >
        Cancel
      </button>
    </div>
  );
}

// Same as QuickAddDayStore, for Plants — the Stock on Hand Location
// dropdown covers both, so both need their own quick-create.
function QuickAddPlant({ onCreated }: { onCreated: (id: string) => void }) {
  const toast = useToast();
  const createPlant = useCreatePlant();
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");

  async function handleCreate() {
    if (!name.trim()) return;
    try {
      const created = await createPlant.mutateAsync(name.trim());
      onCreated(created.id);
      setShow(false);
      setName("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not create plant — it may already exist.");
    }
  }

  if (!show) {
    return (
      <button type="button" className="btn-ghost btn-sm" onClick={() => setShow(true)} title="Add a new Plant">
        <UserPlus className="h-3.5 w-3.5" strokeWidth={2.25} /> New Plant
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <input
        autoFocus
        className="field w-36 px-2 py-1.5 text-[11px]"
        placeholder="Plant name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleCreate()}
      />
      <button type="button" className="btn-primary btn-sm" disabled={createPlant.isPending} onClick={handleCreate}>
        {createPlant.isPending ? "…" : "Add"}
      </button>
      <button
        type="button"
        className="btn-ghost btn-sm"
        onClick={() => {
          setShow(false);
          setName("");
        }}
      >
        Cancel
      </button>
    </div>
  );
}

// Rename one Day Store in place — "Store 1" etc. often start as
// placeholders before a real name/ID is assigned later (see the S6/S7
// call this whole feature traces back to). Same inline-edit pattern as
// QuickAddDayStore, pre-filled with the current name and PATCHing
// instead of POSTing.
function RenameDayStore({ dayStore }: { dayStore: DayStore }) {
  const toast = useToast();
  const renameDayStore = useRenameDayStore();
  const [show, setShow] = useState(false);
  const [name, setName] = useState(dayStore.name);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === dayStore.name) return setShow(false);
    try {
      await renameDayStore.mutateAsync({ id: dayStore.id, name: trimmed });
      toast.success(`Renamed to "${trimmed}".`);
      setShow(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not rename — that name may already be taken.");
    }
  }

  if (!show) {
    return (
      <button
        type="button"
        className="btn-icon"
        title={`Rename "${dayStore.name}"`}
        onClick={() => {
          setName(dayStore.name);
          setShow(true);
        }}
      >
        <Pencil className="h-3.5 w-3.5" strokeWidth={2.25} />
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <input autoFocus className="field w-36 px-2 py-1.5 text-[11px]" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSave()} />
      <button type="button" className="btn-primary btn-sm" disabled={renameDayStore.isPending} onClick={handleSave}>
        {renameDayStore.isPending ? "…" : "Save"}
      </button>
      <button type="button" className="btn-ghost btn-sm" onClick={() => setShow(false)}>
        Cancel
      </button>
    </div>
  );
}

// Who's scoped to this Store — see DayStoreAssignment in schema.prisma.
// No assignments at all means unrestricted (every STORE user can still
// manage this store); this panel is purely additive narrowing, so an
// empty list reads as "open to everyone" rather than "nobody."
function StoreAssignmentPanel({ dayStore }: { dayStore: DayStore }) {
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [pickUserId, setPickUserId] = useState("");
  // Not gated on `show` — this panel only ever exists for the one
  // currently-selected store, so there's no N+1 risk from fetching
  // eagerly, and the button badge below stays accurate before it's
  // even opened.
  const { data: assignments } = useDayStoreAssignments(dayStore.id);
  const { data: storeUsers } = useStoreUsers();
  const assignUser = useAssignDayStoreUser();
  const unassignUser = useUnassignDayStoreUser();

  const assignedIds = new Set((assignments ?? []).map((a) => a.userId));
  const assignable = (storeUsers ?? []).filter((u) => !assignedIds.has(u.id));

  async function handleAssign() {
    if (!pickUserId) return;
    try {
      await assignUser.mutateAsync({ dayStoreId: dayStore.id, userId: pickUserId });
      setPickUserId("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not assign that user.");
    }
  }

  async function handleUnassign(userId: string) {
    try {
      await unassignUser.mutateAsync({ dayStoreId: dayStore.id, userId });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove that assignment.");
    }
  }

  return (
    <div className="relative">
      <button type="button" className="btn-ghost btn-sm" onClick={() => setShow((s) => !s)} title="Restrict which Store users can manage this store">
        <Users className="h-3.5 w-3.5" strokeWidth={2.25} />
        {assignments?.length ? `Assigned (${assignments.length})` : "Assign Users"}
      </button>

      {show && (
        <div className="animate-scale-in absolute left-0 top-full z-40 mt-2 w-72 rounded-2xl border border-slate-200/80 bg-white p-3 shadow-lift">
          <p className="mb-2 text-[11px] font-bold text-slate-500">
            {assignments?.length ? "Only these users can manage this store:" : "Nobody's assigned yet — every Store user can manage this store."}
          </p>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {(assignments ?? []).map((a) => (
              <span key={a.userId} className="flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 px-2 py-1 text-[11px] font-bold text-brand-700">
                {a.user.fullName}
                <button type="button" onClick={() => handleUnassign(a.userId)} title="Remove" className="hover:text-rose-600">
                  <X className="h-3 w-3" strokeWidth={2.5} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <select className="field flex-1 px-2 py-1.5 text-[11px]" value={pickUserId} onChange={(e) => setPickUserId(e.target.value)}>
              <option value="">— Add a Store user —</option>
              {assignable.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
            </select>
            <button type="button" className="btn-primary btn-sm" disabled={!pickUserId || assignUser.isPending} onClick={handleAssign}>
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Same idea as RenameDayStore, for Plants — plants scale just as
// independently as Day Stores (a large company can have several of
// each, unrelated counts), so they get the same rename affordance.
function RenamePlant({ plant }: { plant: Plant }) {
  const toast = useToast();
  const renamePlant = useRenamePlant();
  const [show, setShow] = useState(false);
  const [name, setName] = useState(plant.name);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === plant.name) return setShow(false);
    try {
      await renamePlant.mutateAsync({ id: plant.id, name: trimmed });
      toast.success(`Renamed to "${trimmed}".`);
      setShow(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not rename — that name may already be taken.");
    }
  }

  if (!show) {
    return (
      <button
        type="button"
        className="btn-icon"
        title={`Rename "${plant.name}"`}
        onClick={() => {
          setName(plant.name);
          setShow(true);
        }}
      >
        <Pencil className="h-3.5 w-3.5" strokeWidth={2.25} />
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <input autoFocus className="field w-36 px-2 py-1.5 text-[11px]" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSave()} />
      <button type="button" className="btn-primary btn-sm" disabled={renamePlant.isPending} onClick={handleSave}>
        {renamePlant.isPending ? "…" : "Save"}
      </button>
      <button type="button" className="btn-ghost btn-sm" onClick={() => setShow(false)}>
        Cancel
      </button>
    </div>
  );
}

type ViewTab = "stock" | InventoryTxnType | DispatchTransferType | "requests";

const MATERIAL_TABS: { key: ViewTab; label: string; icon: typeof Warehouse }[] = [
  { key: "stock", label: "Stock on Hand", icon: Warehouse },
  { key: "RECEIVED", label: "Material Received", icon: ArrowDownToLine },
  { key: "ISSUED_DAY_STORE", label: "Issued to Store", icon: ArrowUpFromLine },
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
  const canDispatch = hasRole("DISPATCH"); // S9 — confirms an FG transfer actually went out
  const canInvoice = hasRole("ACCOUNTS"); // S9 — Finance raises the invoice once Dispatch confirms

  // Per-tab visibility — each department only gets the slice of this
  // module its role actually has API access to (see inventory.routes.ts).
  const tabVisible: Record<ViewTab, boolean> = {
    stock: canWrite || canRequest,
    RECEIVED: canWrite || canQc,
    ISSUED_DAY_STORE: canWrite,
    ISSUED_PRODUCTION: canWrite,
    requests: canWrite || canRequest,
    FG: canWrite || canQc || canDispatch || canInvoice,
    BILL: canWrite,
  };
  const visibleMaterialTabs = MATERIAL_TABS.filter((t) => tabVisible[t.key]);
  const visibleDispatchTabs = DISPATCH_TABS.filter((t) => tabVisible[t.key]);

  const toast = useToast();
  const importFileRef = useRef<HTMLInputElement>(null);
  const importRequestsFileRef = useRef<HTMLInputElement>(null);
  const importDispatchFileRef = useRef<HTMLInputElement>(null);
  const importTxns = useImportInventoryTransactions();
  const importRequests = useImportInventoryRequests();
  const importDispatch = useImportDispatchTransfers();

  // Land on the first tab this role can actually see — "stock" 403s for
  // a QA_QC-only account, so it can't be a blind default.
  const [tab, setTab] = useState<ViewTab>(() => [...visibleMaterialTabs, ...visibleDispatchTabs][0]?.key ?? "stock");
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  // Bulk-import counterpart of LogEntryForm's Opening Stock checkbox —
  // Received tab only. A toolbar-level toggle since the import button
  // has no per-row form of its own.
  const [importOpeningStock, setImportOpeningStock] = useState(false);
  // Same idea for Issued to Day Store — which Day Store this sheet's
  // stock belongs to, picked once for the whole batch (a real sheet from
  // Sanjay's side is one Day Store's count, not several mixed together).
  const [importDayStoreId, setImportDayStoreId] = useState("");
  const { data: dayStores } = useDayStores();
  const { data: plants } = usePlants();
  // Stock on Hand's location switch — "" is the existing Warehouse-wide
  // view (untouched); "ds:<id>"/"pl:<id>" switch to that Day Store's or
  // Plant's own real-time balance (see stock.ts
  // getOnHandByDayStoreAndItem / getOnHandByPlantAndItem). One select,
  // prefixed values, since a Day Store id and a Plant id could collide.
  const [stockLocation, setStockLocation] = useState("");
  const stockDayStoreId = stockLocation.startsWith("ds:") ? stockLocation.slice(3) : "";
  const stockPlantId = stockLocation.startsWith("pl:") ? stockLocation.slice(3) : "";
  const { data: dayStoreStock, isLoading: dayStoreStockLoading } = useDayStoreStock(stockDayStoreId || undefined);
  const { data: plantStock, isLoading: plantStockLoading } = usePlantStock(stockPlantId || undefined);
  // Report #5 — one item, every location side by side. A separate
  // control from the Location switch above (which re-scopes the whole
  // table to one place); this instead picks one item and fetches its
  // breakdown across all of them at once.
  const [locationReportItemId, setLocationReportItemId] = useState("");
  const [locationReportLoading, setLocationReportLoading] = useState(false);
  const [reconciliationLoading, setReconciliationLoading] = useState(false);

  const dispatchTab = isDispatchTab(tab);
  const isRequestsTab = tab === "requests";
  const materialTab = !dispatchTab && !isRequestsTab && tab !== "stock";
  const canLogDirectly = materialTab && tab !== "ISSUED_PRODUCTION" && tab !== "RECEIVED"; // Issued to Day Store only — Received now goes through the QC/accept flow too, but Store still logs the initial entry via this same form

  const { data: stock, isLoading: stockLoading } = useInventoryStock(undefined, { enabled: tabVisible.stock });
  const { data: transactions, isLoading: txnLoading } = useInventoryTransactions(materialTab ? { type: tab as InventoryTxnType } : undefined, {
    enabled: materialTab && (tab === "RECEIVED" ? canWrite || canQc : canWrite),
  });
  const { data: dispatchTransfers, isLoading: dispatchLoading } = useDispatchTransfers(dispatchTab ? { type: tab } : undefined, {
    enabled: dispatchTab && (tab === "FG" ? canWrite || canQc || canDispatch || canInvoice : canWrite),
  });
  const { data: dispatchTotal } = useDispatchTransfers(undefined, { enabled: canWrite });
  const { data: pendingRequests } = useInventoryRequests("PENDING", { enabled: tabVisible.stock });
  const { data: approvedRequests } = useInventoryRequests("APPROVED", { enabled: canRequest && !canWrite });
  const { data: partiallyIssuedRequests } = useInventoryRequests("PARTIALLY_ISSUED", { enabled: canRequest && !canWrite });
  const { data: allRequests, isLoading: requestsLoading } = useInventoryRequests(undefined, { enabled: isRequestsTab });
  const { data: pendingReceiptQc } = useInventoryTransactions({ type: "RECEIVED", receiptStatus: "PENDING_QC" }, { enabled: canQc });
  const { data: pendingDispatchQc } = useDispatchTransfers({ type: "FG", qcStatus: "PENDING_QC" }, { enabled: canQc });

  const itemsTracked = stock?.length ?? 0;
  const negativeStock = stock?.filter((s) => s.onHand < 0).length ?? 0;

  const q = search.trim().toLowerCase();
  const filteredStock = stock?.filter((s) => !q || s.item.name.toLowerCase().includes(q));
  const filteredDayStoreStock = dayStoreStock?.stock.filter((s) => !q || s.item.name.toLowerCase().includes(q));
  const filteredPlantStock = plantStock?.stock.filter((s) => !q || s.item.name.toLowerCase().includes(q));
  const filteredTxns = transactions?.filter((t) => !q || t.item.name.toLowerCase().includes(q) || (t.vendorName ?? "").toLowerCase().includes(q));
  const filteredDispatch = dispatchTransfers?.filter((d) => !q || d.productName.toLowerCase().includes(q) || d.customer.companyName.toLowerCase().includes(q));
  const filteredRequests = allRequests?.filter((r) => !q || r.item.name.toLowerCase().includes(q) || r.requestedBy.fullName.toLowerCase().includes(q));

  function switchTab(next: ViewTab) {
    setTab(next);
    setShowForm(false);
  }

  function handleExport() {
    if (tab === "stock" && stockDayStoreId) {
      const storeName = dayStores?.find((d) => d.id === stockDayStoreId)?.name ?? "Store";
      if (!filteredDayStoreStock?.length) return toast.error(`Nothing to export — ${storeName} has no stock activity yet.`);
      exportDayStoreStockReport(storeName, filteredDayStoreStock);
    } else if (tab === "stock" && stockPlantId) {
      const plantName = plants?.find((p) => p.id === stockPlantId)?.name ?? "Plant";
      if (!filteredPlantStock?.length) return toast.error(`Nothing to export — ${plantName} has no stock activity yet.`);
      exportPlantStockReport(plantName, filteredPlantStock);
    } else if (tab === "stock") {
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

  async function handleExportItemLocation() {
    if (!locationReportItemId) return toast.error("Pick an item first.");
    setLocationReportLoading(true);
    try {
      const data = await api<ItemStockByLocation>(`/api/inventory/items/${locationReportItemId}/stock-by-location`);
      exportItemStockByLocation(data);
      toast.success(`Location breakdown downloaded for ${data.item.name}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not load that item's location breakdown");
    } finally {
      setLocationReportLoading(false);
    }
  }

  async function handleExportReconciliation() {
    setReconciliationLoading(true);
    try {
      const rows = await api<CustomerReconciliationRow[]>("/api/inventory/reports/customer-reconciliation");
      if (!rows.length) return toast.error("Nothing to export — no FG shipment has been dispatched yet.");
      exportCustomerReconciliationReport(rows);
      toast.success(`Customer reconciliation downloaded — ${rows.length} customer(s).`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not load the reconciliation report");
    } finally {
      setReconciliationLoading(false);
    }
  }

  // Import Excel is offered on Received and Issued to Day Store — the
  // same two tabs the manual Log Entry form covers directly.
  const canImport = canLogDirectly || tab === "RECEIVED";

  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file next time
    if (!file || !canImport) return;

    try {
      const buffer = await file.arrayBuffer();
      const { rows, skipped, sheetNames, detectedHeaders } = parseInventoryTransactionWorkbook(buffer, "RM");
      if (!rows.length) {
        // eslint-disable-next-line no-console
        console.error("[Inventory import] No usable rows.", { fileName: file.name, fileSize: file.size, sheetNames, detectedHeaders, skipped });
        return toast.error(
          detectedHeaders.length
            ? `No usable rows in "${file.name}" — found columns [${detectedHeaders.join(", ")}], but none had a valid Item + Date + Unit + Count together. Check DevTools console for details.`
            : `"${file.name}" has no data rows on any sheet (${sheetNames.join(", ") || "no sheets"}) — is this the right file?`,
        );
      }

      const openingStock = tab === "RECEIVED" && importOpeningStock;
      const dayStoreId = tab === "ISSUED_DAY_STORE" && importDayStoreId ? importDayStoreId : undefined;
      const result = await importTxns.mutateAsync({ type: tab as InventoryTxnType, rows, isOpeningStock: openingStock || undefined, dayStoreId });
      const skippedNote = skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped — missing a required field)` : "";
      const hasPerRowStores = tab === "ISSUED_DAY_STORE" && rows.some((r) => r.dayStoreName);
      const dayStoreNote = hasPerRowStores
        ? ` — Store read per row from the sheet${result.dayStoresCreated ? `, ${result.dayStoresCreated} new store(s) added` : ""}.`
        : dayStoreId
          ? ` — tagged to ${dayStores?.find((d) => d.id === dayStoreId)?.name ?? "the selected Store"}.`
          : "";
      toast.success(
        `${openingStock ? "Loaded" : "Imported"} ${result.transactionsCreated} ${TXN_TYPE_LABEL[tab as InventoryTxnType].toLowerCase()} entr${result.transactionsCreated === 1 ? "y" : "ies"}${result.itemsCreated ? `, ${result.itemsCreated} new item(s)` : ""}${skippedNote}${openingStock ? " — counted immediately, no QC needed." : ""}${dayStoreNote}`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not import spreadsheet");
    }
  }

  async function handleImportRequestsFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !canRequest) return;

    try {
      const buffer = await file.arrayBuffer();
      const { rows, skipped, sheetNames, detectedHeaders } = parseInventoryRequestWorkbook(buffer, "RM");
      if (!rows.length) {
        // eslint-disable-next-line no-console
        console.error("[Inventory request import] No usable rows.", { fileName: file.name, fileSize: file.size, sheetNames, detectedHeaders, skipped });
        return toast.error(
          detectedHeaders.length
            ? `No usable rows in "${file.name}" — found columns [${detectedHeaders.join(", ")}], but none had a valid Item + Requested Qty together. Check DevTools console for details.`
            : `"${file.name}" has no data rows on any sheet (${sheetNames.join(", ") || "no sheets"}) — is this the right file?`,
        );
      }

      const result = await importRequests.mutateAsync({ rows });
      const skippedNote = skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped — missing a required field)` : "";
      toast.success(`Sent ${result.requestsCreated} request${result.requestsCreated === 1 ? "" : "s"} to Store for approval${result.itemsCreated ? `, ${result.itemsCreated} new item(s)` : ""}${skippedNote}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not import spreadsheet");
    }
  }

  async function handleImportDispatchFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !dispatchTab || !canWrite) return;

    try {
      const buffer = await file.arrayBuffer();
      const { rows, skipped, sheetNames, detectedHeaders } = parseDispatchTransferWorkbook(buffer);
      if (!rows.length) {
        // eslint-disable-next-line no-console
        console.error("[Dispatch transfer import] No usable rows.", { fileName: file.name, fileSize: file.size, sheetNames, detectedHeaders, skipped });
        return toast.error(
          detectedHeaders.length
            ? `No usable rows in "${file.name}" — found columns [${detectedHeaders.join(", ")}], but none had a valid Customer + Date + Product + Qty together. Check DevTools console for details.`
            : `"${file.name}" has no data rows on any sheet (${sheetNames.join(", ") || "no sheets"}) — is this the right file?`,
        );
      }

      const result = await importDispatch.mutateAsync({ type: tab as DispatchTransferType, rows });
      const skippedNote = skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped — missing a required field)` : "";
      const unknownNote = result.unknownCustomers.length
        ? ` — ${result.unknownCustomers.length} row(s) skipped, unknown customer(s): ${result.unknownCustomers.join(", ")}. Ask BD to add them first.`
        : "";
      toast.success(`Imported ${result.transfersCreated} ${DISPATCH_TYPE_LABEL[tab as DispatchTransferType].toLowerCase()} entr${result.transfersCreated === 1 ? "y" : "ies"}${skippedNote}${unknownNote}.`);
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
          {canWrite && canImport && (
            <>
              <button className="btn-ghost" onClick={downloadInventoryImportTemplate} title="Download a blank template with the correct columns">
                <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Sample
              </button>
              <button className="btn-ghost" disabled={importTxns.isPending} onClick={() => importFileRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> {importTxns.isPending ? "Importing…" : "Import Excel"}
              </button>
              <input ref={importFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
              {tab === "RECEIVED" && (
                <label className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600" title="Existing warehouse stock, not a new delivery — skips QC and counts immediately.">
                  <input type="checkbox" className="h-3 w-3" checked={importOpeningStock} onChange={(e) => setImportOpeningStock(e.target.checked)} />
                  Opening Stock
                </label>
              )}
              {tab === "ISSUED_DAY_STORE" && (
                <select
                  className="rounded-lg border border-slate-200 bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600"
                  value={importDayStoreId}
                  onChange={(e) => setImportDayStoreId(e.target.value)}
                  title="Which Store this sheet's stock is for — tags every row on import, same as Sanjay's separate Store sheets."
                >
                  <option value="">No Store tag</option>
                  {dayStores?.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              )}
              {tab === "ISSUED_DAY_STORE" && <QuickAddDayStore onCreated={setImportDayStoreId} />}
            </>
          )}
          {isRequestsTab && canRequest && (
            <>
              <button className="btn-ghost" onClick={downloadInventoryRequestImportTemplate} title="Download a blank template with the correct columns">
                <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Sample
              </button>
              <button className="btn-ghost" disabled={importRequests.isPending} onClick={() => importRequestsFileRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> {importRequests.isPending ? "Importing…" : "Import Excel"}
              </button>
              <input ref={importRequestsFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportRequestsFile} />
            </>
          )}
          {dispatchTab && (canWrite || canInvoice) && (
            <button className="btn-ghost" disabled={reconciliationLoading} onClick={handleExportReconciliation} title="Customer-wise: FG dispatched, invoiced, and still outstanding">
              <Landmark className="h-3.5 w-3.5" strokeWidth={2.5} /> {reconciliationLoading ? "Loading…" : "Customer Reconciliation"}
            </button>
          )}
          {dispatchTab && canWrite && (
            <>
              <button className="btn-ghost" onClick={() => downloadDispatchImportTemplate(tab as DispatchTransferType)} title="Download a blank template with the correct columns">
                <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Sample
              </button>
              <button className="btn-ghost" disabled={importDispatch.isPending} onClick={() => importDispatchFileRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> {importDispatch.isPending ? "Importing…" : "Import Excel"}
              </button>
              <input ref={importDispatchFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportDispatchFile} />
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
              <StatTile
                icon={CheckCircle2}
                label="Approved / Awaiting Issue"
                value={(approvedRequests?.length ?? 0) + (partiallyIssuedRequests?.length ?? 0)}
                accent={approvedRequests?.length || partiallyIssuedRequests?.length ? "emerald" : "slate"}
              />
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

      {tab === "stock" && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs font-bold text-slate-500">Location</label>
          <select className="field w-auto" value={stockLocation} onChange={(e) => setStockLocation(e.target.value)}>
            <option value="">Warehouse</option>
            {dayStores?.length ? (
              <optgroup label="Stores">
                {dayStores.map((d) => (
                  <option key={d.id} value={`ds:${d.id}`}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {plants?.length ? (
              <optgroup label="Plants">
                {plants.map((p) => (
                  <option key={p.id} value={`pl:${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          {stockDayStoreId && dayStores?.find((d) => d.id === stockDayStoreId) && <RenameDayStore dayStore={dayStores.find((d) => d.id === stockDayStoreId)!} />}
          {stockDayStoreId && canWrite && dayStores?.find((d) => d.id === stockDayStoreId) && <StoreAssignmentPanel dayStore={dayStores.find((d) => d.id === stockDayStoreId)!} />}
          {stockPlantId && plants?.find((p) => p.id === stockPlantId) && <RenamePlant plant={plants.find((p) => p.id === stockPlantId)!} />}
          <QuickAddDayStore onCreated={(id) => setStockLocation(`ds:${id}`)} />
          <QuickAddPlant onCreated={(id) => setStockLocation(`pl:${id}`)} />

          <span className="mx-1 hidden h-4 w-px bg-slate-200 sm:block" />
          <label className="text-xs font-bold text-slate-500">Item breakdown</label>
          <select className="field w-auto" value={locationReportItemId} onChange={(e) => setLocationReportItemId(e.target.value)}>
            <option value="">— Pick an RM/PM item —</option>
            {stock?.map((s) => (
              <option key={s.item.id} value={s.item.id}>
                {s.item.name}
              </option>
            ))}
          </select>
          <button className="btn-ghost" disabled={locationReportLoading} onClick={handleExportItemLocation} title="Download this item's stock split across Warehouse, every Day Store, and every Plant">
            <Download className="h-3.5 w-3.5" strokeWidth={2.5} /> {locationReportLoading ? "Loading…" : "By Location"}
          </button>
        </div>
      )}

      {tab === "stock" ? (
        stockDayStoreId ? (
          <DayStoreStockTable loading={dayStoreStockLoading} rows={filteredDayStoreStock} empty={!dayStoreStock?.stock.length} />
        ) : stockPlantId ? (
          <PlantStockTable loading={plantStockLoading} rows={filteredPlantStock} empty={!plantStock?.stock.length} />
        ) : (
          <StockTable loading={stockLoading} rows={filteredStock} empty={!stock?.length} />
        )
      ) : tab === "RECEIVED" ? (
        <ReceivedList loading={txnLoading} rows={filteredTxns} empty={!transactions?.length} canQc={canQc} canWrite={canWrite} />
      ) : tab === "FG" ? (
        <FgTransferList loading={dispatchLoading} rows={filteredDispatch} empty={!dispatchTransfers?.length} canQc={canQc} canWrite={canWrite} canDispatch={canDispatch} canInvoice={canInvoice} />
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
  if (loading) return <SkeletonRows rows={5} cols={8} />;
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
              <th className="text-right">Rejected</th>
              <th className="text-right">Issued (Store)</th>
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
                <td className="text-right font-mono text-slate-400">{s.rejectedQty || "—"}</td>
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

// Real-time balance for one Day Store — simpler columns than Warehouse's
// StockTable above (no Received/Rejected breakdown; a store never
// receives directly, see stock.ts getOnHandByDayStoreAndItem). Rows with
// nothing ever issued to/from this store don't show at all — the API
// only returns items that actually have activity here.
function DayStoreStockTable({ loading, rows, empty }: { loading: boolean; rows: DayStoreStockLine[] | undefined; empty: boolean }) {
  if (loading) return <SkeletonRows rows={5} cols={6} />;
  if (empty) return <EmptyState icon={Warehouse} title="Nothing issued to this store yet" hint="Issue stock to it from the Issued to Store tab, or import a sheet tagged to it." accent="brand" />;
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
              <th className="text-right">Received (from Warehouse)</th>
              <th className="text-right">Issued (to Production)</th>
              <th className="text-right">On Hand (this store)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.item.id}>
                <td className="font-bold text-slate-800">{s.item.name}</td>
                <td className="text-slate-600">{CATEGORY_LABEL[s.item.category]}</td>
                <td className="text-slate-500">{s.item.unit ?? "—"}</td>
                <td className="text-right font-mono text-slate-600">{s.receivedFromWarehouse}</td>
                <td className="text-right font-mono text-slate-600">{s.issuedToProduction}</td>
                <td className={`text-right font-mono font-bold ${s.onHand < 0 ? "text-rose-600" : "text-slate-800"}`}>{s.onHand}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Real-time balance for one Plant — same shape as DayStoreStockTable
// above; the outflow behind these numbers comes from the Batches module
// (RM/PM consumption logged at Dispensing) instead of another Inventory
// transaction type, but the display is identical.
function PlantStockTable({ loading, rows, empty }: { loading: boolean; rows: PlantStockLine[] | undefined; empty: boolean }) {
  if (loading) return <SkeletonRows rows={5} cols={4} />;
  if (empty) return <EmptyState icon={Warehouse} title="Nothing issued to this plant yet" hint="Issue stock to it from Issued to Production, or log RM/PM consumption at a batch's Dispensing stage." accent="brand" />;
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
              <th className="text-right">On Hand (this plant)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.item.id}>
                <td className="font-bold text-slate-800">{s.item.name}</td>
                <td className="text-slate-600">{CATEGORY_LABEL[s.item.category]}</td>
                <td className="text-slate-500">{s.item.unit ?? "—"}</td>
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

  if (loading) return <SkeletonRows rows={5} cols={12} />;
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
              {type === "ISSUED_DAY_STORE" && <th>Store</th>}
              {type === "ISSUED_PRODUCTION" && <th>Plant</th>}
              <th>Batch No</th>
              <th>GRN No</th>
              <th>Mfg Date</th>
              <th>Expiry Date</th>
              <th>Remark</th>
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
                {type === "ISSUED_DAY_STORE" && <td className="text-slate-500">{t.dayStore?.name ?? "—"}</td>}
                {type === "ISSUED_PRODUCTION" && <td className="text-slate-500">{t.plant?.name ?? "—"}</td>}
                <td className="text-slate-500">{t.batchNo ?? "—"}</td>
                <td className="text-slate-500">{t.grnNo ?? "—"}</td>
                <td className="text-slate-500">{t.mfgDate ? new Date(t.mfgDate).toLocaleDateString() : "—"}</td>
                <td className="text-slate-500">{t.expiryDate ? new Date(t.expiryDate).toLocaleDateString() : "—"}</td>
                <td className="text-slate-500">{t.remark ?? "—"}</td>
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

  const [itemId, setItemId] = useState("");
  const [showNewItem, setShowNewItem] = useState(false);
  const [newItemName, setNewItemName] = useState("");

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [unit, setUnit] = useState(UNIT_OPTIONS[0]!);
  const [quantity, setQuantity] = useState("");
  const [size, setSize] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [dayStoreId, setDayStoreId] = useState("");
  const [isOpeningStock, setIsOpeningStock] = useState(false);
  const [batchNo, setBatchNo] = useState("");
  const [grnNo, setGrnNo] = useState("");
  const [mfgDate, setMfgDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [remark, setRemark] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data: vendors } = useInventoryVendors();
  const { data: dayStores } = useDayStores();
  const createItem = useCreateInventoryItem();
  const createTxn = useCreateInventoryTransaction();
  const createDayStore = useCreateDayStore();

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
        dayStoreId: type === "ISSUED_DAY_STORE" && dayStoreId ? dayStoreId : undefined,
        isOpeningStock: type === "RECEIVED" && isOpeningStock ? true : undefined,
        batchNo: batchNo.trim() || undefined,
        grnNo: grnNo.trim() || undefined,
        mfgDate: mfgDate || undefined,
        expiryDate: expiryDate || undefined,
        remark: remark.trim() || undefined,
      });
      toast.success(type === "RECEIVED" ? (isOpeningStock ? "Opening stock logged — counted immediately, no QC needed." : "Entry logged — awaiting inward QC.") : `${TXN_TYPE_LABEL[type]} entry logged.`);
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
        <div className="space-y-2">
          <label className="flex w-fit cursor-pointer items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600">
            <input type="checkbox" className="h-3.5 w-3.5" checked={isOpeningStock} onChange={(e) => setIsOpeningStock(e.target.checked)} />
            Opening Stock — existing warehouse stock, not a new delivery
          </label>
          {isOpeningStock ? (
            <p className="flex items-center gap-1.5 rounded-lg bg-brand-50 px-3 py-2 text-xs font-bold text-brand-700">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} /> Counted as stock immediately — no QC step, since nothing is actually being delivered today.
            </p>
          ) : (
            <p className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} /> This won't count as stock until QA/QC approves it and Store accepts it.
            </p>
          )}
        </div>
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
            {vendors?.vendors.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
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
          <input type="date" className="field" value={mfgDate} onChange={(e) => setMfgDate(e.target.value)} />
        </div>
        <div>
          <label className="label">Expiry Date (optional)</label>
          <input type="date" className="field" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
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

function DispatchTransferForm({ initialType, onDone }: { initialType: DispatchTransferType; onDone: () => void }) {
  const toast = useToast();
  const [type, setType] = useState<DispatchTransferType>(initialType);
  const { data: customers } = useCustomers();
  // Only ISSUED requests represent material that actually left the
  // shelf — those are the only ones worth tracing an FG shipment back
  // to. Fetched regardless of `type` so switching to FG doesn't need a
  // fresh round trip.
  const { data: issuedRequests } = useInventoryRequests("ISSUED");
  const { data: plants } = usePlants();
  const createTransfer = useCreateDispatchTransfer();
  const createPlant = useCreatePlant();

  const [customerId, setCustomerId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [productName, setProductName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [sourceRequestId, setSourceRequestId] = useState("");
  const [plantId, setPlantId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sortedCustomers = useMemo(() => customers ?? [], [customers]);

  function switchType(next: DispatchTransferType) {
    setType(next);
    if (next !== "FG") setSourceRequestId("");
  }

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
        sourceRequestId: type === "FG" && sourceRequestId ? sourceRequestId : undefined,
        plantId: type === "FG" && plantId ? plantId : undefined,
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
            onClick={() => switchType(t)}
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
        {type === "FG" && (
          <div className="sm:col-span-2 lg:col-span-3">
            <label className="label">Traces Back to Material Request (optional)</label>
            <select className="field" value={sourceRequestId} onChange={(e) => setSourceRequestId(e.target.value)}>
              <option value="">— Not linked —</option>
              {issuedRequests?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.item.name} · {r.requestedQty} · issued {r.fulfillments.length ? new Date(r.fulfillments[r.fulfillments.length - 1]!.date).toLocaleDateString() : ""}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-400">A manual tag, not a calculation — pick the request this shipment's material came from, if you know it.</p>
          </div>
        )}
        {type === "FG" && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <PickerWithAdd
                label="Plant (optional)"
                placeholder="— Which plant is this from —"
                options={plants ?? []}
                value={plantId}
                onChange={setPlantId}
                onCreate={(name) => createPlant.mutateAsync(name)}
              />
            </div>
            {plantId && plants?.find((p) => p.id === plantId) && <RenamePlant plant={plants.find((p) => p.id === plantId)!} />}
          </div>
        )}
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
  const [showPartial, setShowPartial] = useState(false);
  const [partialQty, setPartialQty] = useState("");
  const [partialNote, setPartialNote] = useState("");
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

  async function handlePartialReject() {
    setError(null);
    const qty = Number(partialQty);
    if (!partialQty || qty <= 0) return setError("Enter how much of this delivery failed inspection.");
    if (qty >= txn.quantity) return setError("That's the whole delivery — use Reject instead.");
    if (!partialNote.trim()) return setError("A note is required when rejecting part of a delivery.");
    try {
      await qcReview.mutateAsync({ id: txn.id, action: "APPROVE", rejectedQty: qty, note: partialNote.trim() });
      toast.success(`Approved — ${txn.quantity - qty} ${txn.unit} accepted, ${qty} ${txn.unit} rejected.`);
      setShowPartial(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
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
            {txn.isOpeningStock ? (
              <span className="pill border-slate-300 bg-slate-100 text-slate-600" title="Existing warehouse stock loaded at go-live, not a vendor delivery">
                Opening Stock
              </span>
            ) : (
              txn.receiptStatus && <QcStatusBadge status={txn.receiptStatus} />
            )}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {CATEGORY_LABEL[txn.item.category]} · <span className="font-mono font-bold text-slate-700">{txn.quantity}</span> {txn.unit}
            {txn.size && <> · {txn.size}</>}
            {txn.vendorName && <> · {txn.vendorName}</>} · {new Date(txn.date).toLocaleDateString()}
          </p>
          {(txn.batchNo || txn.grnNo || txn.mfgDate || txn.expiryDate) && (
            <p className="mt-0.5 text-[11px] text-slate-500">
              {txn.batchNo && <>Batch {txn.batchNo}</>}
              {txn.grnNo && <> · GRN {txn.grnNo}</>}
              {txn.mfgDate && <> · Mfg {new Date(txn.mfgDate).toLocaleDateString()}</>}
              {txn.expiryDate && <> · Exp {new Date(txn.expiryDate).toLocaleDateString()}</>}
            </p>
          )}
          {txn.remark && <p className="mt-0.5 text-[11px] text-slate-500">Remark: {txn.remark}</p>}
          <p className="mt-0.5 text-[11px] text-slate-400">
            Logged by {txn.createdBy.fullName}
            {txn.qcCheckedBy && <> · QC by {txn.qcCheckedBy.fullName}</>}
            {txn.acceptedBy && <> · accepted by {txn.acceptedBy.fullName}</>}
          </p>
          {txn.receiptStatus === "QC_REJECTED" && txn.qcNote && <p className="mt-1.5 text-xs font-bold text-rose-600">Reason: {txn.qcNote}</p>}
          {!!txn.rejectedQty && (
            <p className="mt-1.5 text-xs font-bold text-amber-600">
              {txn.quantity - txn.rejectedQty} {txn.unit} accepted, {txn.rejectedQty} {txn.unit} rejected
              {txn.qcNote && <> — {txn.qcNote}</>}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canQc && txn.receiptStatus === "PENDING_QC" && !showReject && !showPartial && (
            <>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setShowReject(true)}>
                <X className="h-3 w-3" strokeWidth={2.5} /> Reject
              </button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setShowPartial(true)}>
                Partial Reject
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
          {canWrite && !showReject && !showPartial && (
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

      {showPartial && (
        <div className="animate-fade-in space-y-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
          <p className="text-[11px] font-bold text-amber-700">Part of this delivery failed inspection — the rest still clears QC and counts toward stock.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Rejected Qty ({txn.unit}, out of {txn.quantity})</label>
              <input className="field font-mono" type="number" min="0" step="any" value={partialQty} onChange={(e) => setPartialQty(e.target.value)} />
            </div>
            <div>
              <label className="label">Reason</label>
              <input className="field" placeholder="e.g. Damaged packaging" value={partialNote} onChange={(e) => setPartialNote(e.target.value)} />
            </div>
          </div>
          {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setShowPartial(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={qcReview.isPending} onClick={handlePartialReject}>
              {qcReview.isPending ? "Saving…" : "Confirm Partial Reject"}
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
  canDispatch,
  canInvoice,
}: {
  loading: boolean;
  rows: DispatchTransfer[] | undefined;
  empty: boolean;
  canQc: boolean;
  canWrite: boolean;
  canDispatch: boolean;
  canInvoice: boolean;
}) {
  if (loading) return <SkeletonRows rows={4} cols={1} />;
  if (empty) return <EmptyState icon={Truck} title="No FG transfer entries yet" hint={canWrite ? "Log one above to get started." : "Ask Store to log the first entry."} accent="brand" />;
  if (!rows?.length) return <EmptyState icon={Warehouse} title="No matching entries" hint="Try a different search." accent="slate" />;

  return (
    <div className="space-y-3">
      {rows.map((d) => (
        <FgTransferCard key={d.id} transfer={d} canQc={canQc} canWrite={canWrite} canDispatch={canDispatch} canInvoice={canInvoice} />
      ))}
    </div>
  );
}

function FgTransferCard({
  transfer,
  canQc,
  canWrite,
  canDispatch,
  canInvoice,
}: {
  transfer: DispatchTransfer;
  canQc: boolean;
  canWrite: boolean;
  canDispatch: boolean;
  canInvoice: boolean;
}) {
  const toast = useToast();
  const qcReview = useQcReviewDispatchTransfer();
  const deleteTransfer = useDeleteDispatchTransfer();
  const confirmDispatch = useConfirmDispatch();
  const invoiceTransfer = useInvoiceDispatchTransfer();

  const [showReject, setShowReject] = useState(false);
  const [note, setNote] = useState("");
  const [showDispatch, setShowDispatch] = useState(false);
  const [dispatchNote, setDispatchNote] = useState("");
  const [showInvoice, setShowInvoice] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState("");
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

  async function handleConfirmDispatch() {
    try {
      await confirmDispatch.mutateAsync({ id: transfer.id, dispatchNote: dispatchNote.trim() || undefined });
      toast.success("Dispatch confirmed — Finance notified to invoice.");
      setShowDispatch(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not confirm dispatch");
    }
  }

  async function handleInvoice() {
    if (!invoiceNumber.trim()) return setError("Enter the invoice number.");
    try {
      await invoiceTransfer.mutateAsync({ id: transfer.id, invoiceNumber: invoiceNumber.trim() });
      toast.success("Invoice logged.");
      setShowInvoice(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not log the invoice");
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
            {transfer.plant && <> · from {transfer.plant.name}</>}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Logged by {transfer.createdBy.fullName}
            {transfer.qcCheckedBy && <> · QC by {transfer.qcCheckedBy.fullName}</>}
            {transfer.dispatchedBy && <> · dispatched by {transfer.dispatchedBy.fullName}</>}
            {transfer.invoicedBy && <> · invoiced by {transfer.invoicedBy.fullName}</>}
          </p>
          {transfer.qcStatus === "QC_REJECTED" && transfer.qcNote && <p className="mt-1.5 text-xs font-bold text-rose-600">Reason: {transfer.qcNote}</p>}
          {transfer.sourceRequest && (
            <p className="mt-1.5 flex items-center gap-1 text-xs font-bold text-brand-700">
              <ClipboardList className="h-3.5 w-3.5" strokeWidth={2.5} /> Traces to request: {transfer.sourceRequest.item.name} · {transfer.sourceRequest.requestedQty}
            </p>
          )}
          {transfer.dispatchedAt && (
            <p className="mt-1.5 flex items-center gap-1 text-xs font-bold text-violet-700">
              <Truck className="h-3.5 w-3.5" strokeWidth={2.5} /> Dispatched {new Date(transfer.dispatchedAt).toLocaleDateString()}
              {transfer.dispatchNote && <> — {transfer.dispatchNote}</>}
            </p>
          )}
          {transfer.invoiceNumber && (
            <p className="mt-1.5 flex items-center gap-1 text-xs font-bold text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.5} /> Invoiced {transfer.invoiceNumber}
            </p>
          )}
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
          {canDispatch && transfer.qcStatus === "QC_APPROVED" && !transfer.dispatchedAt && !showDispatch && (
            <button type="button" className="btn-primary btn-sm" onClick={() => setShowDispatch(true)}>
              <Truck className="h-3.5 w-3.5" strokeWidth={2.5} /> Confirm Dispatch
            </button>
          )}
          {canInvoice && transfer.dispatchedAt && !transfer.invoiceNumber && !showInvoice && (
            <button type="button" className="btn-primary btn-sm" onClick={() => setShowInvoice(true)}>
              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.5} /> Log Invoice
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

      {showDispatch && (
        <div className="animate-fade-in rounded-xl border border-violet-200 bg-violet-50/60 p-3">
          <label className="label">Dispatch Note (optional)</label>
          <input className="field" placeholder="e.g. Transporter, LR / docket number" value={dispatchNote} onChange={(e) => setDispatchNote(e.target.value)} />
          {error && <p className="mt-1.5 text-xs font-bold text-rose-600">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setShowDispatch(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={confirmDispatch.isPending} onClick={handleConfirmDispatch}>
              {confirmDispatch.isPending ? "Confirming…" : "Confirm Dispatch"}
            </button>
          </div>
        </div>
      )}

      {showInvoice && (
        <div className="animate-fade-in rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
          <label className="label">Invoice Number</label>
          <input className="field" placeholder="Invoice number" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
          {error && <p className="mt-1.5 text-xs font-bold text-rose-600">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setShowInvoice(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={invoiceTransfer.isPending} onClick={handleInvoice}>
              {invoiceTransfer.isPending ? "Saving…" : "Save Invoice"}
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
  const { data: plants } = usePlants();
  const createRequest = useCreateInventoryRequest();
  const createPlant = useCreatePlant();

  const [itemId, setItemId] = useState("");
  const [purpose, setPurpose] = useState<InventoryRequestPurpose>("ISSUED_PRODUCTION");
  const [requestedQty, setRequestedQty] = useState("");
  const [neededBy, setNeededBy] = useState("");
  const [note, setNote] = useState("");
  const [plantId, setPlantId] = useState("");
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
        plantId: purpose === "ISSUED_PRODUCTION" && plantId ? plantId : undefined,
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
            <option value="ISSUED_DAY_STORE">Issued to Store</option>
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
        {purpose === "ISSUED_PRODUCTION" && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <PickerWithAdd label="Plant (optional)" placeholder="— Which plant is this for —" options={plants ?? []} value={plantId} onChange={setPlantId} onCreate={(name) => createPlant.mutateAsync(name)} />
            </div>
            {plantId && plants?.find((p) => p.id === plantId) && <RenamePlant plant={plants.find((p) => p.id === plantId)!} />}
          </div>
        )}
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
  const { data: dayStores } = useDayStores();
  const createDayStore = useCreateDayStore();

  const [showReject, setShowReject] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [showIssue, setShowIssue] = useState(false);
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [issueUnit, setIssueUnit] = useState(UNIT_OPTIONS[0]!);
  const [issueQty, setIssueQty] = useState(String(request.remainingQty));
  const [issueSize, setIssueSize] = useState("");
  // No default — an explicit choice is required (see
  // issueInventoryRequestSchema: dayStoreId is now a required, nullable
  // key, not an optional one). "" means nothing picked yet and blocks
  // submit; "CENTRAL" means null on purpose; "STORE" needs issueDayStoreId too.
  const [issueSource, setIssueSource] = useState<"" | "CENTRAL" | "STORE">("");
  const [issueDayStoreId, setIssueDayStoreId] = useState("");
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
    if (Number(issueQty) > request.remainingQty) return setError(`Only ${request.remainingQty} remaining on this request.`);
    if (!issueSource) return setError("Choose whether this is coming from a Store or Central / Warehouse Stock.");
    if (issueSource === "STORE" && !issueDayStoreId) return setError("Select which Store this is coming from.");
    try {
      const qty = Number(issueQty);
      const dayStoreId = issueSource === "STORE" ? issueDayStoreId : null;
      await issue.mutateAsync({ id: request.id, date: issueDate, unit: issueUnit, quantity: qty, size: issueSize.trim() || undefined, dayStoreId });
      toast.success(qty >= request.remainingQty ? "Stock issued — request complete." : `${qty} issued — ${request.remainingQty - qty} still remaining on this request.`);
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
            {(request.status === "PARTIALLY_ISSUED" || request.status === "ISSUED") && (
              <>
                {" "}
                · <span className="font-mono font-bold text-brand-700">{request.issuedQty}</span> issued so far
                {request.remainingQty > 0 && (
                  <>
                    {" "}
                    · <span className="font-mono font-bold text-amber-600">{request.remainingQty}</span> remaining
                  </>
                )}
              </>
            )}
            {request.plant && <> · for {request.plant.name}</>}
            {request.neededBy && <> · needed by {new Date(request.neededBy).toLocaleDateString()}</>}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Requested by {request.requestedBy.fullName} · {new Date(request.createdAt).toLocaleDateString()}
            {request.reviewedBy && <> · reviewed by {request.reviewedBy.fullName}</>}
          </p>
          {request.note && <p className="mt-1.5 text-xs text-slate-600">"{request.note}"</p>}
          {request.status === "REJECTED" && request.rejectionReason && <p className="mt-1.5 text-xs font-bold text-rose-600">Reason: {request.rejectionReason}</p>}
          {request.fulfillments.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {request.fulfillments.map((f) => (
                <p key={f.id} className="flex items-center gap-1 text-xs font-bold text-brand-700">
                  <PackageCheck className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} /> Issued {f.quantity} {f.unit} on {new Date(f.date).toLocaleDateString()}
                  {f.dayStore && <> · {f.dayStore.name}</>}
                </p>
              ))}
            </div>
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
          {canReview && (request.status === "APPROVED" || request.status === "PARTIALLY_ISSUED") && !showIssue && (
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={() => {
                setIssueQty(String(request.remainingQty));
                setIssueSource("");
                setIssueDayStoreId("");
                setShowIssue(true);
              }}
            >
              <PackageCheck className="h-3.5 w-3.5" strokeWidth={2.5} /> {request.status === "PARTIALLY_ISSUED" ? "Issue Remaining" : "Issue Stock"}
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
              <label className="label">Qty Issued (of {request.remainingQty} remaining)</label>
              <input className="field font-mono" type="number" min="0" max={request.remainingQty} step="any" value={issueQty} onChange={(e) => setIssueQty(e.target.value)} />
            </div>
            <div>
              <label className="label">Size (optional)</label>
              <input className="field" placeholder="e.g. 25 Kg bag" value={issueSize} onChange={(e) => setIssueSize(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">Coming from</label>
            <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100/80 p-1">
              {(["CENTRAL", "STORE"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setIssueSource(s)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all duration-150 ${
                    issueSource === s ? "bg-white text-slate-900 shadow-soft" : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {s === "CENTRAL" ? "Central / Warehouse Stock" : "A Store"}
                </button>
              ))}
            </div>
          </div>
          {issueSource === "STORE" && (
            <PickerWithAdd
              label="Which Store"
              placeholder="— Select —"
              options={dayStores ?? []}
              value={issueDayStoreId}
              onChange={setIssueDayStoreId}
              onCreate={(name) => createDayStore.mutateAsync(name)}
            />
          )}
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
