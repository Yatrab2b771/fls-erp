import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Beaker,
  Boxes,
  Check,
  CheckCircle2,
  ClipboardList,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  Landmark,
  Lock,
  Package,
  PackageCheck,
  PauseCircle,
  Pencil,
  Plus,
  Receipt,
  Route,
  Scale,
  Send,
  ShieldAlert,
  Timer,
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
  useConfirmDelivery,
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
  useImportItemMaster,
  useInventoryItems,
  useInventoryRequests,
  useInventoryStock,
  useInventoryTransactions,
  useInventoryVendors,
  useInvoiceDispatchTransfer,
  useIssueInventoryRequest,
  useMaterialReconciliation,
  usePlants,
  usePlantStock,
  useQcReviewDispatchTransfer,
  useQcReviewTransaction,
  useRaiseDebitNote,
  useRenameDayStore,
  useRenamePlant,
  useRenameWarehouse,
  useReviewInventoryRequest,
  useStoreUsers,
  useTransit,
  useUnassignDayStoreUser,
  useUpdateInventoryTransaction,
  useWarehouses,
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
  InventoryStockLine,
  InventoryTxnType,
  MaterialReconciliationRow,
  Plant,
  PlantStockLine,
  TransitItem,
  Warehouse as WarehouseLocation,
} from "../lib/types";
import { PickerWithAdd } from "../components/PickerWithAdd";
import { ItemPicker } from "../components/ItemPicker";
import { parseDispatchTransferWorkbook, parseInventoryRequestWorkbook, parseInventoryTransactionWorkbook, parseItemMasterWorkbook } from "../lib/inventoryImport";
import {
  downloadDispatchImportTemplate,
  downloadInventoryImportTemplate,
  downloadInventoryRequestImportTemplate,
  downloadItemMasterImportTemplate,
  exportCustomerReconciliationReport,
  exportDayStoreStockReport,
  exportDispatchReport,
  exportItemStockByLocation,
  exportMaterialReconciliationReport,
  exportPlantStockReport,
  exportRequestsReport,
  exportStockReport,
  exportTransactionReport,
  exportTransitReport,
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
  ON_HOLD: "bg-orange-50 text-orange-700 border-orange-200",
  QC_APPROVED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  QC_REJECTED: "bg-rose-50 text-rose-700 border-rose-200",
  ACCEPTED: "bg-brand-50 text-brand-700 border-brand-200",
};
const QC_STATUS_DOT: Record<string, string> = {
  PENDING_QC: "animate-pulse bg-amber-500",
  ON_HOLD: "bg-orange-500",
  QC_APPROVED: "bg-emerald-500",
  QC_REJECTED: "bg-rose-500",
  ACCEPTED: "bg-brand-500",
};
const QC_STATUS_LABEL: Record<string, string> = {
  PENDING_QC: "Pending QC",
  ON_HOLD: "On Hold",
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

  async function handleUnassign(userId: string, userName: string) {
    if (!window.confirm(`Remove ${userName}'s access to this store?`)) return;
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
                <button type="button" onClick={() => handleUnassign(a.userId, a.user.fullName)} title="Remove" className="hover:text-rose-600">
                  <X className="h-3 w-3" strokeWidth={2.5} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <ItemPicker items={assignable.map((u) => ({ id: u.id, name: u.fullName }))} value={pickUserId} onChange={setPickUserId} placeholder="— Add a Store user —" />
            </div>
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

// Same idea again, for the two Warehouses — rename only, no create (a
// third can't exist: Warehouse.category is @unique, and the seed already
// bootstraps both rows). Category isn't editable here — it's what
// determines which items' stock this warehouse shows, not a label.
function RenameWarehouse({ warehouse }: { warehouse: WarehouseLocation }) {
  const toast = useToast();
  const renameWarehouse = useRenameWarehouse();
  const [show, setShow] = useState(false);
  const [name, setName] = useState(warehouse.name);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === warehouse.name) return setShow(false);
    try {
      await renameWarehouse.mutateAsync({ id: warehouse.id, name: trimmed });
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
        title={`Rename "${warehouse.name}"`}
        onClick={() => {
          setName(warehouse.name);
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
      <button type="button" className="btn-primary btn-sm" disabled={renameWarehouse.isPending} onClick={handleSave}>
        {renameWarehouse.isPending ? "…" : "Save"}
      </button>
      <button type="button" className="btn-ghost btn-sm" onClick={() => setShow(false)}>
        Cancel
      </button>
    </div>
  );
}

// ISSUED_RND deliberately excluded — that ledger has its own page
// (/rnd-store), not a tab here.
type ViewTab = "stock" | Exclude<InventoryTxnType, "ISSUED_RND"> | DispatchTransferType | "requests" | "transit" | "reconciliation";

const MATERIAL_TABS: { key: ViewTab; label: string; icon: typeof Warehouse }[] = [
  { key: "stock", label: "Stock on Hand", icon: Warehouse },
  { key: "RECEIVED", label: "Material Received", icon: ArrowDownToLine },
  { key: "ISSUED_DAY_STORE", label: "Issued to Store", icon: ArrowUpFromLine },
  { key: "ISSUED_PRODUCTION", label: "Issued to Production", icon: ArrowUpFromLine },
  { key: "requests", label: "Material Requests", icon: ClipboardList },
  { key: "transit", label: "Transit", icon: Route },
  { key: "reconciliation", label: "Reconciliation", icon: Scale },
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
  const canQc = hasRole("QA_QC"); // QA/QC or Admin — outward QC on FG transfers
  // Inward QC (Material Received) is QA_QC or RND — Production Process
  // Flow.docx tags QC Sampling/Testing on incoming material as R&D's own
  // work, not generic QA. Outward FG QC above stays QA_QC-only — the doc
  // doesn't tag that one R&D. See inventory.routes.ts's PATCH /transactions/:id/qc.
  const canInwardQc = hasRole("QA_QC", "RND");
  const canDispatch = hasRole("DISPATCH"); // S9 — confirms an FG transfer actually went out
  const canInvoice = hasRole("ACCOUNTS"); // S9 — Finance raises the invoice once Dispatch confirms
  // Same role list as the "Inventory" nav tab in AppLayout.tsx — the tab
  // being hidden doesn't stop a direct URL (or a stale route left over
  // from switching users in the same tab) from rendering this page, so
  // the page itself has to refuse too, same as RndPage/RndStorePage. The
  // actual early return sits at the bottom of this component, after
  // every hook below has run — an early return here would call those
  // hooks conditionally.
  const canAccessInventory = canWrite || canRequest || canQc || canInwardQc || canDispatch || canInvoice;

  // Per-tab visibility — each department only gets the slice of this
  // module its role actually has API access to (see inventory.routes.ts).
  const tabVisible: Record<ViewTab, boolean> = {
    // ACCOUNTS on both: they can edit item pricing (needs Stock on Hand
    // to browse into an item) and raise a debit note against a Received
    // row (needs to actually see that row) — see inventory.routes.ts.
    stock: canWrite || canRequest || canInvoice,
    RECEIVED: canWrite || canInwardQc || canInvoice,
    ISSUED_DAY_STORE: canWrite,
    ISSUED_PRODUCTION: canWrite,
    requests: canWrite || canRequest,
    transit: canWrite || canRequest || canQc,
    // STORE-only — the ₹ reconciliation view is an internal accounting
    // tool, same audience as the API route itself.
    reconciliation: canWrite,
    FG: canWrite || canQc || canDispatch || canInvoice,
    BILL: canWrite,
  };
  const visibleMaterialTabs = MATERIAL_TABS.filter((t) => tabVisible[t.key]);
  const visibleDispatchTabs = DISPATCH_TABS.filter((t) => tabVisible[t.key]);

  const toast = useToast();
  const importFileRef = useRef<HTMLInputElement>(null);
  const importRequestsFileRef = useRef<HTMLInputElement>(null);
  const importDispatchFileRef = useRef<HTMLInputElement>(null);
  const importItemMasterFileRef = useRef<HTMLInputElement>(null);
  const importTxns = useImportInventoryTransactions();
  const importRequests = useImportInventoryRequests();
  const importDispatch = useImportDispatchTransfers();
  const importItemMaster = useImportItemMaster();

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
  // Same toggle as LogEntryForm's own, applied to the whole sheet —
  // Issued to Store only.
  const [importTransitTracked, setImportTransitTracked] = useState(false);
  const { data: dayStores } = useDayStores();
  const { data: plants } = usePlants();
  const { data: warehouses } = useWarehouses();
  // Stock on Hand's location switch — "" is the company-wide view across
  // both categories (untouched); "ds:<id>"/"pl:<id>" switch to that Day
  // Store's or Plant's own real-time balance (see stock.ts
  // getOnHandByDayStoreAndItem / getOnHandByPlantAndItem); "wh:<id>"
  // switches to one Warehouse — nothing more than useInventoryStock
  // filtered to that warehouse's own category, since a Warehouse doesn't
  // have its own on-hand endpoint (see useWarehouses in hooks.ts). One
  // select, prefixed values, since these three kinds of id could collide.
  const [stockLocation, setStockLocation] = useState("");
  const stockDayStoreId = stockLocation.startsWith("ds:") ? stockLocation.slice(3) : "";
  const stockPlantId = stockLocation.startsWith("pl:") ? stockLocation.slice(3) : "";
  const stockWarehouseId = stockLocation.startsWith("wh:") ? stockLocation.slice(3) : "";
  const selectedWarehouse = warehouses?.find((w) => w.id === stockWarehouseId);
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
  const isTransitTab = tab === "transit";
  const isReconciliationTab = tab === "reconciliation";
  const materialTab = !dispatchTab && !isRequestsTab && !isTransitTab && !isReconciliationTab && tab !== "stock";
  const canLogDirectly = materialTab && tab !== "ISSUED_PRODUCTION" && tab !== "RECEIVED"; // Issued to Day Store only — Received now goes through the QC/accept flow too, but Store still logs the initial entry via this same form

  const { data: transit, isLoading: transitLoading } = useTransit({ enabled: isTransitTab });
  const confirmDelivery = useConfirmDelivery();
  const { data: materialReconciliation, isLoading: materialReconciliationLoading } = useMaterialReconciliation(undefined, { enabled: isReconciliationTab });

  const { data: stock, isLoading: stockLoading } = useInventoryStock(undefined, { enabled: tabVisible.stock });
  // A Warehouse's "stock" is just this same query, filtered to its own
  // category — kept as a separate call (rather than reusing `stock`
  // above) so the StatTiles above stay company-wide even while a
  // Warehouse is selected in the Location picker.
  const { data: warehouseStock, isLoading: warehouseStockLoading } = useInventoryStock(selectedWarehouse?.category, {
    enabled: tabVisible.stock && !!stockWarehouseId,
  });
  const { data: transactions, isLoading: txnLoading } = useInventoryTransactions(materialTab ? { type: tab as InventoryTxnType } : undefined, {
    enabled: materialTab && (tab === "RECEIVED" ? canWrite || canInwardQc : canWrite),
  });
  const { data: dispatchTransfers, isLoading: dispatchLoading } = useDispatchTransfers(dispatchTab ? { type: tab } : undefined, {
    enabled: dispatchTab && (tab === "FG" ? canWrite || canQc || canDispatch || canInvoice : canWrite),
  });
  const { data: dispatchTotal } = useDispatchTransfers(undefined, { enabled: canWrite });
  const { data: pendingRequests } = useInventoryRequests("PENDING", { enabled: tabVisible.stock });
  const { data: approvedRequests } = useInventoryRequests("APPROVED", { enabled: canRequest && !canWrite });
  const { data: partiallyIssuedRequests } = useInventoryRequests("PARTIALLY_ISSUED", { enabled: canRequest && !canWrite });
  const { data: allRequests, isLoading: requestsLoading } = useInventoryRequests(undefined, { enabled: isRequestsTab });
  const { data: pendingReceiptQc } = useInventoryTransactions({ type: "RECEIVED", receiptStatus: "PENDING_QC" }, { enabled: canInwardQc });
  const { data: pendingDispatchQc } = useDispatchTransfers({ type: "FG", qcStatus: "PENDING_QC" }, { enabled: canQc });

  // The stat tiles above scope to whichever Location is currently picked
  // in the Stock on Hand tab (Warehouse/Plant/Day Store), same as the
  // table below it — "2237" company-wide no longer shows once a specific
  // Warehouse is selected; it becomes that Warehouse's own item count.
  const activeOnHands: number[] = stockDayStoreId
    ? (dayStoreStock?.stock.map((s) => s.onHand) ?? [])
    : stockPlantId
      ? (plantStock?.stock.map((s) => s.onHand) ?? [])
      : stockWarehouseId
        ? (warehouseStock?.map((s) => s.onHand) ?? [])
        : (stock?.map((s) => s.onHand) ?? []);
  const itemsTracked = activeOnHands.length;
  const negativeStock = activeOnHands.filter((v) => v < 0).length;
  const itemsTrackedLabel = stockDayStoreId
    ? `Items — ${dayStores?.find((d) => d.id === stockDayStoreId)?.name ?? "Store"}`
    : stockPlantId
      ? `Items — ${plants?.find((p) => p.id === stockPlantId)?.name ?? "Plant"}`
      : stockWarehouseId
        ? `Items — ${selectedWarehouse?.name ?? "Warehouse"}`
        : "Items Tracked";

  const q = search.trim().toLowerCase();
  const filteredStock = stock?.filter((s) => !q || s.item.name.toLowerCase().includes(q));
  const filteredWarehouseStock = warehouseStock?.filter((s) => !q || s.item.name.toLowerCase().includes(q));
  const filteredDayStoreStock = dayStoreStock?.stock.filter((s) => !q || s.item.name.toLowerCase().includes(q));
  const filteredPlantStock = plantStock?.stock.filter((s) => !q || s.item.name.toLowerCase().includes(q));
  const filteredTxns = transactions?.filter((t) => !q || t.item.name.toLowerCase().includes(q) || (t.vendorName ?? "").toLowerCase().includes(q));
  const filteredDispatch = dispatchTransfers?.filter((d) => !q || d.productName.toLowerCase().includes(q) || d.customer.companyName.toLowerCase().includes(q));
  const filteredRequests = allRequests?.filter((r) => !q || r.item.name.toLowerCase().includes(q) || r.requestedBy.fullName.toLowerCase().includes(q));
  const filteredTransit = transit?.filter((t) => !q || t.item.name.toLowerCase().includes(q) || t.from.toLowerCase().includes(q) || t.to.toLowerCase().includes(q));
  // Worst mismatches first — that's the whole point of this report, a
  // clean item (variance 0) shouldn't bury the ones actually worth
  // looking at.
  const filteredMaterialReconciliation = materialReconciliation
    ?.filter((r) => !q || r.item.name.toLowerCase().includes(q))
    .slice()
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));

  async function handleConfirmDelivery(id: string) {
    try {
      await confirmDelivery.mutateAsync({ id });
      toast.success("Confirmed delivered.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not confirm delivery");
    }
  }

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
    } else if (tab === "stock" && stockWarehouseId) {
      if (!filteredWarehouseStock?.length) return toast.error(`Nothing to export — ${selectedWarehouse?.name ?? "this warehouse"} has no stock yet.`);
      exportStockReport(filteredWarehouseStock);
    } else if (tab === "stock") {
      if (!filteredStock?.length) return toast.error("Nothing to export — no stock rows match.");
      exportStockReport(filteredStock);
    } else if (dispatchTab) {
      if (!filteredDispatch?.length) return toast.error("Nothing to export — no entries match.");
      exportDispatchReport(filteredDispatch, DISPATCH_TYPE_LABEL[tab], DISPATCH_TYPE_LABEL[tab].replace(/\s+/g, "_"));
    } else if (isRequestsTab) {
      if (!filteredRequests?.length) return toast.error("Nothing to export — no requests match.");
      exportRequestsReport(filteredRequests);
    } else if (isTransitTab) {
      if (!filteredTransit?.length) return toast.error("Nothing to export — nothing currently in transit.");
      exportTransitReport(filteredTransit);
    } else if (isReconciliationTab) {
      if (!filteredMaterialReconciliation?.length) return toast.error("Nothing to export — no items match.");
      exportMaterialReconciliationReport(filteredMaterialReconciliation);
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
      const transitTracked = tab === "ISSUED_DAY_STORE" && importTransitTracked;
      const result = await importTxns.mutateAsync({ type: tab as InventoryTxnType, rows, isOpeningStock: openingStock || undefined, dayStoreId, isTransitTracked: transitTracked || undefined });
      const skippedNote = skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped — missing a required field)` : "";
      const hasPerRowStores = tab === "ISSUED_DAY_STORE" && rows.some((r) => r.dayStoreName);
      const dayStoreNote = hasPerRowStores
        ? ` — Store read per row from the sheet${result.dayStoresCreated ? `, ${result.dayStoresCreated} new store(s) added` : ""}.`
        : dayStoreId
          ? ` — tagged to ${dayStores?.find((d) => d.id === dayStoreId)?.name ?? "the selected Store"}.`
          : "";
      toast.success(
        `${openingStock ? "Loaded" : "Imported"} ${result.transactionsCreated} ${TXN_TYPE_LABEL[tab as InventoryTxnType].toLowerCase()} entr${result.transactionsCreated === 1 ? "y" : "ies"}${result.itemsCreated ? `, ${result.itemsCreated} new item(s)` : ""}${skippedNote}${openingStock ? " — counted immediately, no QC needed." : ""}${transitTracked ? " — in transit until confirmed at the other end." : ""}${dayStoreNote}`,
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

  // Item Master ("SKU Namkaran") — reference data only, no stock touched:
  // resolves every row's real code + standardized name into the item
  // catalog so every other module's exact-name lookup can match it.
  async function handleImportItemMasterFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !canWrite) return;

    try {
      const buffer = await file.arrayBuffer();
      const { rows, skipped, sheetNames, detectedHeaders } = parseItemMasterWorkbook(buffer);
      if (!rows.length) {
        // eslint-disable-next-line no-console
        console.error("[Item Master import] No usable rows.", { fileName: file.name, fileSize: file.size, sheetNames, detectedHeaders, skipped });
        return toast.error(
          detectedHeaders.length
            ? `No usable rows in "${file.name}" — found columns [${detectedHeaders.join(", ")}], but none had an SKU Code. Check DevTools console for details.`
            : `"${file.name}" has no data rows on any sheet (${sheetNames.join(", ") || "no sheets"}) — is this the right file?`,
        );
      }

      const result = await importItemMaster.mutateAsync({ rows });
      const skippedNote = skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped — missing an SKU Code)` : "";
      const namelessNote = result.skipped ? ` (${result.skipped} more skipped — no Correct Name, Name from Lab, or Store Name to seed from)` : "";
      toast.success(`Imported ${result.itemsCreated} new item(s), updated ${result.itemsUpdated} existing item(s)${skippedNote}${namelessNote}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not import spreadsheet");
    }
  }

  // Received also opens the manual Log Entry form — Store still logs the
  // initial arrival by hand (or Excel import), it's what happens *after*
  // that changed (QC gate before it counts as stock).
  const canLogReceived = tab === "RECEIVED" && canWrite;
  const showPrimaryButton = (dispatchTab && canWrite) || (isRequestsTab && canRequest) || (canLogDirectly && canWrite) || canLogReceived;

  if (!canAccessInventory) {
    return (
      <EmptyState
        icon={Lock}
        title="Restricted to Store / PPIC / QA-QC / R&D / Dispatch / Accounts"
        hint="This page belongs to the departments that touch the Warehouse ledger — ask one of them if you need something here."
        accent="slate"
      />
    );
  }

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
                <div className="w-40" title="Which Store this sheet's stock is for — tags every row on import, same as Sanjay's separate Store sheets.">
                  <ItemPicker items={(dayStores ?? []).map((d) => ({ id: d.id, name: d.name }))} value={importDayStoreId} onChange={setImportDayStoreId} placeholder="No Store tag" />
                </div>
              )}
              {tab === "ISSUED_DAY_STORE" && <QuickAddDayStore onCreated={setImportDayStoreId} />}
              {tab === "ISSUED_DAY_STORE" && (
                <label className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600" title="Won't count at the Store until confirmed arrived — see the Transit tab.">
                  <input type="checkbox" className="h-3 w-3" checked={importTransitTracked} onChange={(e) => setImportTransitTracked(e.target.checked)} />
                  Track as In-Transit
                </label>
              )}
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
          {canWrite && (
            <>
              <button className="btn-ghost" onClick={downloadItemMasterImportTemplate} title="Item Master ('SKU Namkaran') — real code + standardized name per item, reconciled across Store/Lab naming.">
                <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={2.5} /> Download Item Master Sample
              </button>
              <button className="btn-ghost" disabled={importItemMaster.isPending} onClick={() => importItemMasterFileRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" strokeWidth={2.5} /> {importItemMaster.isPending ? "Importing…" : "Import Item Master"}
              </button>
              <input ref={importItemMasterFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportItemMasterFile} />
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

      <div className={`grid grid-cols-2 gap-3 ${isTransitTab ? "sm:grid-cols-3 lg:grid-cols-5" : "sm:grid-cols-4"}`}>
        {isTransitTab ? (
          // Scoped to what's actually on this tab — the five legs GET
          // /inventory/transit already normalizes everything into, not
          // the whole-warehouse numbers every other tab shares.
          <>
            <StatTile icon={Route} label="To a Store" value={transit?.filter((t) => t.kind === "day_store").length ?? 0} accent="brand" />
            <StatTile icon={Route} label="To Production" value={transit?.filter((t) => t.kind === "plant").length ?? 0} accent="brand" />
            <StatTile icon={ArrowDownToLine} label="Vendor — Awaiting QC" value={transit?.filter((t) => t.kind === "vendor_qc").length ?? 0} accent="amber" />
            <StatTile icon={FlaskConical} label="R&D Transfers" value={transit?.filter((t) => t.kind === "rnd").length ?? 0} accent="violet" />
            <StatTile icon={Beaker} label="QC Sample Transfers" value={transit?.filter((t) => t.kind === "qc_sample").length ?? 0} accent="sky" />
          </>
        ) : isReconciliationTab ? (
          <>
            <StatTile icon={Boxes} label="Items Checked" value={materialReconciliation?.length ?? 0} accent="brand" />
            <StatTile icon={CheckCircle2} label="Fully Reconciled" value={materialReconciliation?.filter((r) => r.variance === 0).length ?? 0} accent="emerald" />
            <StatTile
              icon={Scale}
              label="With Variance"
              value={materialReconciliation?.filter((r) => r.variance !== 0).length ?? 0}
              accent={materialReconciliation?.some((r) => r.variance !== 0) ? "rose" : "slate"}
            />
            <StatTile
              icon={Package}
              label="Total Unaccounted"
              value={Math.round((materialReconciliation?.reduce((sum, r) => sum + Math.abs(r.variance), 0) ?? 0) * 100) / 100}
              accent={materialReconciliation?.some((r) => r.variance !== 0) ? "rose" : "slate"}
            />
          </>
        ) : tabVisible.stock ? (
          <>
            <StatTile icon={Boxes} label={itemsTrackedLabel} value={itemsTracked} accent="brand" />
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
          <div className="w-56">
            <ItemPicker
              items={[
                ...(warehouses ?? []).map((w) => ({ id: `wh:${w.id}`, name: w.name })),
                ...(dayStores ?? []).map((d) => ({ id: `ds:${d.id}`, name: `Store — ${d.name}` })),
                ...(plants ?? []).map((p) => ({ id: `pl:${p.id}`, name: `Plant — ${p.name}` })),
              ]}
              value={stockLocation}
              onChange={setStockLocation}
              placeholder="All Warehouses (RM + PM)"
            />
          </div>
          {selectedWarehouse && <RenameWarehouse warehouse={selectedWarehouse} />}
          {stockDayStoreId && dayStores?.find((d) => d.id === stockDayStoreId) && <RenameDayStore dayStore={dayStores.find((d) => d.id === stockDayStoreId)!} />}
          {stockDayStoreId && canWrite && dayStores?.find((d) => d.id === stockDayStoreId) && <StoreAssignmentPanel dayStore={dayStores.find((d) => d.id === stockDayStoreId)!} />}
          {stockPlantId && plants?.find((p) => p.id === stockPlantId) && <RenamePlant plant={plants.find((p) => p.id === stockPlantId)!} />}
          <QuickAddDayStore onCreated={(id) => setStockLocation(`ds:${id}`)} />
          <QuickAddPlant onCreated={(id) => setStockLocation(`pl:${id}`)} />

          <span className="mx-1 hidden h-4 w-px bg-slate-200 sm:block" />
          <label className="text-xs font-bold text-slate-500">Item breakdown</label>
          <div className="w-56">
            <ItemPicker items={(stock ?? []).map((s) => ({ id: s.item.id, name: s.item.name }))} value={locationReportItemId} onChange={setLocationReportItemId} placeholder="— Pick an RM/PM item —" />
          </div>
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
        ) : stockWarehouseId ? (
          <WarehouseStockTable loading={warehouseStockLoading} rows={filteredWarehouseStock} empty={!warehouseStock?.length} />
        ) : (
          <StockTable loading={stockLoading} rows={filteredStock} empty={!stock?.length} />
        )
      ) : tab === "RECEIVED" ? (
        <ReceivedList loading={txnLoading} rows={filteredTxns} empty={!transactions?.length} canQc={canInwardQc} canWrite={canWrite} canDebitNote={canInvoice} />
      ) : tab === "FG" ? (
        <FgTransferList loading={dispatchLoading} rows={filteredDispatch} empty={!dispatchTransfers?.length} canQc={canQc} canWrite={canWrite} canDispatch={canDispatch} canInvoice={canInvoice} />
      ) : dispatchTab ? (
        <DispatchTable loading={dispatchLoading} rows={filteredDispatch} empty={!dispatchTransfers?.length} type={tab} canWrite={canWrite} />
      ) : isRequestsTab ? (
        <MaterialRequestsPanel loading={requestsLoading} rows={filteredRequests} empty={!allRequests?.length} canReview={canWrite} currentUserId={user?.id} />
      ) : isTransitTab ? (
        <TransitPanel loading={transitLoading} rows={filteredTransit} empty={!transit?.length} canConfirm={canWrite} onConfirm={handleConfirmDelivery} confirming={confirmDelivery.isPending} />
      ) : isReconciliationTab ? (
        <MaterialReconciliationPanel loading={materialReconciliationLoading} rows={filteredMaterialReconciliation} empty={!materialReconciliation?.length} />
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
              <th />
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
                <td className="text-right">
                  <Link to={`/inventory/items/${s.item.id}`} className="btn-ghost btn-sm inline-flex" title="See everything received/issued for this item">
                    <Eye className="h-3.5 w-3.5" strokeWidth={2.25} /> View
                  </Link>
                </td>
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
              <th />
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
                <td className="text-right">
                  <Link to={`/inventory/items/${s.item.id}`} className="btn-ghost btn-sm inline-flex" title="See everything received/issued for this item">
                    <Eye className="h-3.5 w-3.5" strokeWidth={2.25} /> View
                  </Link>
                </td>
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
// A Warehouse's own view — deliberately NOT the full StockTable (Received/
// Rejected/Issued Store/Issued Production). Those columns are the item's
// TOTAL activity across every location (a RECEIVED row carries no
// location tag at all — only its paired ISSUED_* leg does), so showing
// them next to "Location: RM Warehouse" reads as "this happened at the
// Warehouse" when most of it may have moved straight to a Plant/Day
// Store instead. Only On Hand is genuinely Warehouse-scoped (it already
// nets out anything moved out), so that's the only number shown — same
// restraint PlantStockTable/DayStoreStockTable already use below.
function WarehouseStockTable({ loading, rows, empty }: { loading: boolean; rows: InventoryStockLine[] | undefined; empty: boolean }) {
  if (loading) return <SkeletonRows rows={5} cols={4} />;
  if (empty) return <EmptyState icon={Warehouse} title="Nothing on hand at this warehouse yet" hint="Log a received entry, or import Opening Stock." accent="brand" />;
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
              <th className="text-right">On Hand (this warehouse)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.item.id}>
                <td className="font-bold text-slate-800">{s.item.name}</td>
                <td className="text-slate-600">{CATEGORY_LABEL[s.item.category]}</td>
                <td className="text-slate-500">{s.item.unit ?? "—"}</td>
                <td className={`text-right font-mono font-bold ${s.onHand < 0 ? "text-rose-600" : "text-slate-800"}`}>{s.onHand}</td>
                <td className="text-right">
                  <Link to={`/inventory/items/${s.item.id}`} className="btn-ghost btn-sm inline-flex" title="See everything received/issued for this item">
                    <Eye className="h-3.5 w-3.5" strokeWidth={2.25} /> View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.item.id}>
                <td className="font-bold text-slate-800">{s.item.name}</td>
                <td className="text-slate-600">{CATEGORY_LABEL[s.item.category]}</td>
                <td className="text-slate-500">{s.item.unit ?? "—"}</td>
                <td className={`text-right font-mono font-bold ${s.onHand < 0 ? "text-rose-600" : "text-slate-800"}`}>{s.onHand}</td>
                <td className="text-right">
                  <Link to={`/inventory/items/${s.item.id}`} className="btn-ghost btn-sm inline-flex" title="See everything received/issued for this item">
                    <Eye className="h-3.5 w-3.5" strokeWidth={2.25} /> View
                  </Link>
                </td>
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
    if (!window.confirm("Remove this entry? This can't be undone.")) return;
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
    if (!window.confirm("Remove this dispatch transfer entry? This can't be undone.")) return;
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
  const [isTransitTracked, setIsTransitTracked] = useState(false);
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
        isTransitTracked: type === "ISSUED_DAY_STORE" && isTransitTracked ? true : undefined,
        batchNo: batchNo.trim() || undefined,
        grnNo: grnNo.trim() || undefined,
        mfgDate: mfgDate || undefined,
        expiryDate: expiryDate || undefined,
        remark: remark.trim() || undefined,
      });
      toast.success(
        type === "RECEIVED"
          ? isOpeningStock
            ? "Opening stock logged — counted immediately, no QC needed."
            : "Entry logged — awaiting inward QC."
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
          <ItemPicker items={sortedCustomers.map((c) => ({ id: c.id, name: c.companyName }))} value={customerId} onChange={setCustomerId} placeholder="— Select a customer —" />
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
            <ItemPicker
              items={(issuedRequests ?? []).map((r) => ({
                id: r.id,
                name: `${r.item.name} · ${r.requestedQty} · issued ${r.fulfillments.length ? new Date(r.fulfillments[r.fulfillments.length - 1]!.date).toLocaleDateString() : ""}`,
              }))}
              value={sourceRequestId}
              onChange={setSourceRequestId}
              placeholder="— Not linked —"
            />
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
  canDebitNote,
}: {
  loading: boolean;
  rows: InventoryTransaction[] | undefined;
  empty: boolean;
  canQc: boolean;
  canWrite: boolean;
  canDebitNote: boolean;
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
        <ReceivedCard key={t.id} txn={t} canQc={canQc} canWrite={canWrite} canDebitNote={canDebitNote} />
      ))}
    </div>
  );
}

// yyyy-mm-dd for a date <input>, or "" if unset — same shape the create
// form's own date fields already use.
function dateInputValue(value: string | null | undefined) {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

export function ReceivedCard({ txn, canQc, canWrite, canDebitNote = false }: { txn: InventoryTransaction; canQc: boolean; canWrite: boolean; canDebitNote?: boolean }) {
  const toast = useToast();
  const qcReview = useQcReviewTransaction();
  const accept = useAcceptTransaction();
  const updateTxn = useUpdateInventoryTransaction();
  const deleteTxn = useDeleteInventoryTransaction();
  const raiseDebitNote = useRaiseDebitNote();
  const [showDebitNoteForm, setShowDebitNoteForm] = useState(false);
  const [debitNoteDraft, setDebitNoteDraft] = useState({ debitNoteNo: "", quantity: "", unit: txn.unit, amount: "", reason: "" });

  // Debit Note Issue is reachable whenever this row carries a QC
  // rejection to point at — a full reject (QC_REJECTED) or a partial one
  // (rejectedQty > 0). Mirrors the same dual condition the API route
  // itself enforces (see inventory.routes.ts).
  const canRaiseDebitNoteHere = canDebitNote && (txn.receiptStatus === "QC_REJECTED" || !!txn.rejectedQty);

  async function handleRaiseDebitNote() {
    const quantity = Number(debitNoteDraft.quantity);
    if (!quantity || quantity <= 0) {
      toast.error("Enter a valid quantity");
      return;
    }
    try {
      await raiseDebitNote.mutateAsync({
        id: txn.id,
        debitNoteNo: debitNoteDraft.debitNoteNo.trim() || undefined,
        quantity,
        unit: debitNoteDraft.unit,
        amount: debitNoteDraft.amount ? Number(debitNoteDraft.amount) : undefined,
        reason: debitNoteDraft.reason.trim() || undefined,
      });
      toast.success("Debit Note raised.");
      setShowDebitNoteForm(false);
      setDebitNoteDraft({ debitNoteNo: "", quantity: "", unit: txn.unit, amount: "", reason: "" });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not raise Debit Note");
    }
  }

  // REJECT and HOLD share the same "explain why" note form — one piece of
  // state for which of the two (if either) is open, instead of a second
  // boolean forking the whole block.
  const [showNoteForm, setShowNoteForm] = useState<"REJECT" | "HOLD" | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Editing paperwork after the fact — GRN No. is the common case (the
  // physical GRN sometimes isn't cut yet when Store first logs the
  // delivery). Allowed at any QC status, on purpose — see
  // updateInventoryTransactionSchema.
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(() => ({
    grnNo: txn.grnNo ?? "",
    batchNo: txn.batchNo ?? "",
    mfgDate: dateInputValue(txn.mfgDate),
    expiryDate: dateInputValue(txn.expiryDate),
    vendorName: txn.vendorName ?? "",
    size: txn.size ?? "",
    remark: txn.remark ?? "",
  }));

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
      setShowNoteForm(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reject QC");
    }
  }

  async function handleHold() {
    if (!note.trim()) return setError("A note is required when holding QC.");
    try {
      await qcReview.mutateAsync({ id: txn.id, action: "HOLD", note: note.trim() });
      toast.success("Parked on hold — Store's been notified.");
      setShowNoteForm(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not hold QC");
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
    if (!window.confirm(`Remove this ${txn.quantity} ${txn.unit} ${txn.item.name} entry? This can't be undone.`)) return;
    try {
      await deleteTxn.mutateAsync(txn.id);
      toast.success("Entry removed.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not remove entry");
    }
  }

  function startEdit() {
    setEditDraft({
      grnNo: txn.grnNo ?? "",
      batchNo: txn.batchNo ?? "",
      mfgDate: dateInputValue(txn.mfgDate),
      expiryDate: dateInputValue(txn.expiryDate),
      vendorName: txn.vendorName ?? "",
      size: txn.size ?? "",
      remark: txn.remark ?? "",
    });
    setEditing(true);
  }

  async function handleSaveEdit() {
    try {
      await updateTxn.mutateAsync({
        id: txn.id,
        grnNo: editDraft.grnNo.trim() || undefined,
        batchNo: editDraft.batchNo.trim() || undefined,
        mfgDate: editDraft.mfgDate || undefined,
        expiryDate: editDraft.expiryDate || undefined,
        vendorName: editDraft.vendorName.trim() || undefined,
        size: editDraft.size.trim() || undefined,
        remark: editDraft.remark.trim() || undefined,
      });
      toast.success("Entry updated.");
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update entry");
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
          {(txn.receiptStatus === "QC_REJECTED" || txn.receiptStatus === "ON_HOLD") && txn.qcNote && (
            <p className={`mt-1.5 text-xs font-bold ${txn.receiptStatus === "ON_HOLD" ? "text-orange-600" : "text-rose-600"}`}>Reason: {txn.qcNote}</p>
          )}
          {!!txn.rejectedQty && (
            <p className="mt-1.5 text-xs font-bold text-amber-600">
              {txn.quantity - txn.rejectedQty} {txn.unit} accepted, {txn.rejectedQty} {txn.unit} rejected
              {txn.qcNote && <> — {txn.qcNote}</>}
            </p>
          )}
          {/* ERP Diagram doc's reject branch: "Debit Note Issue (Accounts)".
              Any note already raised shows here regardless of role — it's
              part of this entry's own paper trail, same as QC notes above. */}
          {txn.debitNotes.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {txn.debitNotes.map((dn) => (
                <p key={dn.id} className="text-xs font-bold text-slate-600">
                  Debit Note{dn.debitNoteNo && <> {dn.debitNoteNo}</>}: {dn.quantity} {dn.unit}
                  {dn.amount != null && <> · ₹{dn.amount.toLocaleString("en-IN")}</>} · raised by {dn.createdBy.fullName}
                  {dn.reason && <> — {dn.reason}</>}
                </p>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canRaiseDebitNoteHere && txn.debitNotes.length === 0 && !showDebitNoteForm && (
            <button type="button" className="btn-ghost btn-sm !text-slate-700" onClick={() => setShowDebitNoteForm(true)}>
              <Receipt className="h-3 w-3" strokeWidth={2.5} /> Raise Debit Note
            </button>
          )}
          {canQc && (txn.receiptStatus === "PENDING_QC" || txn.receiptStatus === "ON_HOLD") && !showNoteForm && !editing && (
            <>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setShowNoteForm("REJECT")}>
                <X className="h-3 w-3" strokeWidth={2.5} /> Reject
              </button>
              <button type="button" className="btn-ghost btn-sm !text-orange-600" onClick={() => setShowNoteForm("HOLD")}>
                <PauseCircle className="h-3 w-3" strokeWidth={2.5} /> Hold
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
          {canWrite && !showNoteForm && !editing && (
            <button type="button" className="btn-icon" title="Edit GRN No. / Batch No. / dates / vendor / remark" onClick={startEdit}>
              <Pencil className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          )}
          {canWrite && !showNoteForm && !editing && (
            <button type="button" className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" title="Remove entry" onClick={handleDelete}>
              <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="animate-fade-in rounded-xl border border-brand-200 bg-brand-50/40 p-3">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <div>
              <label className="label">GRN No.</label>
              <input className="field" value={editDraft.grnNo} onChange={(e) => setEditDraft((d) => ({ ...d, grnNo: e.target.value }))} />
            </div>
            <div>
              <label className="label">Batch No.</label>
              <input className="field" value={editDraft.batchNo} onChange={(e) => setEditDraft((d) => ({ ...d, batchNo: e.target.value }))} />
            </div>
            <div>
              <label className="label">Mfg Date</label>
              <input type="date" className="field" value={editDraft.mfgDate} onChange={(e) => setEditDraft((d) => ({ ...d, mfgDate: e.target.value }))} />
            </div>
            <div>
              <label className="label">Expiry Date</label>
              <input type="date" className="field" value={editDraft.expiryDate} onChange={(e) => setEditDraft((d) => ({ ...d, expiryDate: e.target.value }))} />
            </div>
            <div>
              <label className="label">Vendor</label>
              <input className="field" value={editDraft.vendorName} onChange={(e) => setEditDraft((d) => ({ ...d, vendorName: e.target.value }))} />
            </div>
            <div>
              <label className="label">Size</label>
              <input className="field" value={editDraft.size} onChange={(e) => setEditDraft((d) => ({ ...d, size: e.target.value }))} />
            </div>
            <div className="col-span-2">
              <label className="label">Remark</label>
              <input className="field" value={editDraft.remark} onChange={(e) => setEditDraft((d) => ({ ...d, remark: e.target.value }))} />
            </div>
          </div>
          <div className="mt-2.5 flex justify-end gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={updateTxn.isPending} onClick={handleSaveEdit}>
              {updateTxn.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {showNoteForm && (
        <div className={`animate-fade-in rounded-xl border p-3 ${showNoteForm === "HOLD" ? "border-orange-200 bg-orange-50/60" : "border-rose-200 bg-rose-50/60"}`}>
          <textarea
            className="field min-h-[3rem] resize-y"
            placeholder={showNoteForm === "HOLD" ? "Required — why is this being held?" : "Required — why is this failing inward QC?"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {error && <p className="mt-1.5 text-xs font-bold text-rose-600">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setShowNoteForm(null);
                setError(null);
              }}
            >
              Cancel
            </button>
            {showNoteForm === "HOLD" ? (
              <button type="button" className="btn-sm bg-orange-600 text-white hover:bg-orange-700" disabled={qcReview.isPending} onClick={handleHold}>
                {qcReview.isPending ? "Holding…" : "Confirm Hold"}
              </button>
            ) : (
              <button type="button" className="btn-danger btn-sm" disabled={qcReview.isPending} onClick={handleReject}>
                {qcReview.isPending ? "Rejecting…" : "Confirm Reject"}
              </button>
            )}
          </div>
        </div>
      )}

      {showDebitNoteForm && (
        <div className="animate-fade-in rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <div>
              <label className="label">Debit Note No.</label>
              <input className="field" value={debitNoteDraft.debitNoteNo} onChange={(e) => setDebitNoteDraft((d) => ({ ...d, debitNoteNo: e.target.value }))} />
            </div>
            <div>
              <label className="label">Quantity *</label>
              <input
                type="number"
                className="field"
                value={debitNoteDraft.quantity}
                onChange={(e) => setDebitNoteDraft((d) => ({ ...d, quantity: e.target.value }))}
                placeholder={txn.rejectedQty ? String(txn.rejectedQty) : String(txn.quantity)}
              />
            </div>
            <div>
              <label className="label">Unit</label>
              <input className="field" value={debitNoteDraft.unit} onChange={(e) => setDebitNoteDraft((d) => ({ ...d, unit: e.target.value }))} />
            </div>
            <div>
              <label className="label">Amount (₹)</label>
              <input type="number" className="field" value={debitNoteDraft.amount} onChange={(e) => setDebitNoteDraft((d) => ({ ...d, amount: e.target.value }))} />
            </div>
            <div className="col-span-2 sm:col-span-4">
              <label className="label">Reason</label>
              <input className="field" value={debitNoteDraft.reason} onChange={(e) => setDebitNoteDraft((d) => ({ ...d, reason: e.target.value }))} placeholder={txn.qcNote ?? "Why is Accounts debiting the vendor?"} />
            </div>
          </div>
          <div className="mt-2.5 flex justify-end gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setShowDebitNoteForm(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={raiseDebitNote.isPending} onClick={handleRaiseDebitNote}>
              {raiseDebitNote.isPending ? "Raising…" : "Raise Debit Note"}
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

export function FgTransferCard({
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

  // REJECT and HOLD share the same note form — see ReceivedCard above.
  const [showNoteForm, setShowNoteForm] = useState<"REJECT" | "HOLD" | null>(null);
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
      setShowNoteForm(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reject QC");
    }
  }

  async function handleHold() {
    if (!note.trim()) return setError("A note is required when holding QC.");
    try {
      await qcReview.mutateAsync({ id: transfer.id, action: "HOLD", note: note.trim() });
      toast.success("Parked on hold — Store's been notified.");
      setShowNoteForm(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not hold QC");
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Remove this ${transfer.quantity} ${transfer.productName} transfer to ${transfer.customer.companyName}? This can't be undone.`)) return;
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
          {(transfer.qcStatus === "QC_REJECTED" || transfer.qcStatus === "ON_HOLD") && transfer.qcNote && (
            <p className={`mt-1.5 text-xs font-bold ${transfer.qcStatus === "ON_HOLD" ? "text-orange-600" : "text-rose-600"}`}>Reason: {transfer.qcNote}</p>
          )}
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
          {canQc && (transfer.qcStatus === "PENDING_QC" || transfer.qcStatus === "ON_HOLD") && !showNoteForm && (
            <>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setShowNoteForm("REJECT")}>
                <X className="h-3 w-3" strokeWidth={2.5} /> Reject
              </button>
              <button type="button" className="btn-ghost btn-sm !text-orange-600" onClick={() => setShowNoteForm("HOLD")}>
                <PauseCircle className="h-3 w-3" strokeWidth={2.5} /> Hold
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
          {canWrite && !showNoteForm && (
            <button type="button" className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" title="Remove entry" onClick={handleDelete}>
              <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>

      {showNoteForm && (
        <div className={`animate-fade-in rounded-xl border p-3 ${showNoteForm === "HOLD" ? "border-orange-200 bg-orange-50/60" : "border-rose-200 bg-rose-50/60"}`}>
          <textarea
            className="field min-h-[3rem] resize-y"
            placeholder={showNoteForm === "HOLD" ? "Required — why is this being held?" : "Required — why is this failing outward QC?"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {error && <p className="mt-1.5 text-xs font-bold text-rose-600">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setShowNoteForm(null);
                setError(null);
              }}
            >
              Cancel
            </button>
            {showNoteForm === "HOLD" ? (
              <button type="button" className="btn-sm bg-orange-600 text-white hover:bg-orange-700" disabled={qcReview.isPending} onClick={handleHold}>
                {qcReview.isPending ? "Holding…" : "Confirm Hold"}
              </button>
            ) : (
              <button type="button" className="btn-danger btn-sm" disabled={qcReview.isPending} onClick={handleReject}>
                {qcReview.isPending ? "Rejecting…" : "Confirm Reject"}
              </button>
            )}
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
          <ItemPicker items={CATEGORY_ITEMS} value={category} onChange={(v) => switchCategory(v as InventoryCategory)} clearable={false} />
        </div>
        <div className="sm:col-span-2">
          <label className="label">Item</label>
          <ItemPicker items={sortedItems} value={itemId} onChange={setItemId} />
        </div>
        <div>
          <label className="label">Purpose</label>
          <ItemPicker
            items={[
              { id: "ISSUED_PRODUCTION", name: "Issued to Production" },
              { id: "ISSUED_DAY_STORE", name: "Issued to Store" },
            ]}
            value={purpose}
            onChange={(v) => setPurpose(v as InventoryRequestPurpose)}
            clearable={false}
          />
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

// "2h 14m", "3d 4h", "just now" — the whole point of this list is "how
// long has this been sitting," so this needs to read at a glance, not as
// a raw timestamp. Rendered fresh on every load and every 60s refetch
// (see useTransit) — close enough to live without a client-side ticking
// clock.
function formatElapsed(fromIso: string): string {
  const ms = Date.now() - new Date(fromIso).getTime();
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

const TRANSIT_KIND_LABEL: Record<TransitItem["kind"], string> = {
  day_store: "To a Store",
  plant: "To Production",
  vendor_qc: "Vendor delivery",
  rnd: "R&D transfer",
  qc_sample: "QC Sample transfer",
};

// One open shipment across every kind of internal movement — see GET
// /inventory/transit. Only day_store/plant rows get a Confirm button
// here; vendor_qc (inward QC queue) and rnd (R&D Store) rows are acted
// on through their own existing screens, so those get a View link
// instead (confirmPath is null for both).
function TransitPanel({
  loading,
  rows,
  empty,
  canConfirm,
  onConfirm,
  confirming,
}: {
  loading: boolean;
  rows: TransitItem[] | undefined;
  empty: boolean;
  canConfirm: boolean;
  onConfirm: (id: string) => void;
  confirming: boolean;
}) {
  if (loading) return <SkeletonRows rows={5} cols={7} />;
  if (empty) return <EmptyState icon={Route} title="Nothing in transit right now" hint="Tick “Track as In-Transit” when logging a Store/Production issue to see it here." accent="brand" />;
  if (!rows?.length) return <EmptyState icon={Route} title="No matching shipments" hint="Try a different search." accent="slate" />;

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="table-modern w-full">
          <thead>
            <tr>
              <th>Item</th>
              <th>Kind</th>
              <th>From → To</th>
              <th className="text-right">Qty</th>
              <th>Dispatched</th>
              <th>
                <span className="inline-flex items-center gap-1">
                  <Timer className="h-3 w-3" strokeWidth={2.5} /> In Transit
                </span>
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={`${t.kind}-${t.id}`}>
                <td className="font-bold text-slate-800">
                  {t.item.name}
                  {t.kind === "qc_sample" && <div className="text-[11px] font-normal text-slate-400">{t.productName}</div>}
                </td>
                <td className="text-slate-600">{TRANSIT_KIND_LABEL[t.kind]}</td>
                <td className="text-slate-600">
                  {t.from} → {t.to}
                </td>
                <td className="text-right font-mono font-bold text-slate-800">
                  {t.quantity} {t.unit}
                </td>
                <td className="text-slate-500">
                  {new Date(t.dispatchedAt).toLocaleString()}
                  <div className="text-[11px] text-slate-400">by {t.dispatchedBy.fullName}</div>
                </td>
                <td className="font-mono font-bold text-amber-600">{formatElapsed(t.dispatchedAt)}</td>
                <td className="text-right">
                  {t.confirmPath && canConfirm ? (
                    <button type="button" className="btn-primary btn-sm" disabled={confirming} onClick={() => onConfirm(t.id)}>
                      <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> Confirm Received
                    </button>
                  ) : (
                    <Link to={t.linkPath} className="btn-ghost btn-sm inline-flex" title="Act on this from its own screen">
                      <Eye className="h-3.5 w-3.5" strokeWidth={2.25} /> View
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// "Of everything ever received, where did it all go" — see GET
// /inventory/reconciliation. Sorted worst-mismatch-first by the caller
// (filteredMaterialReconciliation) so a clean item never buries one
// actually worth a look. Variance is highlighted rose the instant it's
// nonzero — that's the whole point of this screen.
function MaterialReconciliationPanel({ loading, rows, empty }: { loading: boolean; rows: MaterialReconciliationRow[] | undefined; empty: boolean }) {
  if (loading) return <SkeletonRows rows={6} cols={12} />;
  if (empty) return <EmptyState icon={Scale} title="Nothing received yet" hint="This report only covers items that have at least one accepted Material Received entry." accent="brand" />;
  if (!rows?.length) return <EmptyState icon={Scale} title="No matching items" hint="Try a different search." accent="slate" />;

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="table-modern w-full">
          <thead>
            <tr>
              <th>Item</th>
              <th className="text-right">Received</th>
              <th className="text-right">On Hand — Warehouse</th>
              <th className="text-right">On Hand — Stores</th>
              <th className="text-right">On Hand — Plants</th>
              <th className="text-right">Consumed in Production</th>
              <th className="text-right">Sent as QC Sample</th>
              <th className="text-right">Wastage at Dispensing</th>
              <th className="text-right">R&D — Testing</th>
              <th className="text-right">R&D — Formulation Trial</th>
              <th className="text-right">R&D — Wastage/Rejected</th>
              <th className="text-right">R&D — To Customer</th>
              <th className="text-right">Accounted For</th>
              <th className="text-right">Variance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.item.id}>
                <td className="font-bold text-slate-800">{r.item.name}</td>
                <td className="text-right font-mono text-slate-700">{r.receivedQty}</td>
                <td className="text-right font-mono text-slate-600">{r.onHandWarehouse}</td>
                <td className="text-right font-mono text-slate-600">{r.onHandDayStores}</td>
                <td className="text-right font-mono text-slate-600">{r.onHandPlants}</td>
                <td className="text-right font-mono text-slate-600">{r.consumedProduction}</td>
                <td className="text-right font-mono text-sky-700">{r.consumedSample}</td>
                <td className="text-right font-mono text-amber-700">{r.consumedWaste}</td>
                <td className="text-right font-mono text-violet-700">{r.rndTesting}</td>
                <td className="text-right font-mono text-violet-700">{r.rndFormulationTrial}</td>
                <td className="text-right font-mono text-amber-700">{r.rndWastage + r.rndRejected}</td>
                <td className="text-right font-mono text-violet-700">{r.rndDispatchedCustomer}</td>
                <td className="text-right font-mono font-bold text-slate-700">{r.accountedFor}</td>
                <td className={`text-right font-mono font-bold ${r.variance !== 0 ? "text-rose-600" : "text-emerald-600"}`}>{r.variance}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
  const [issueTransitTracked, setIssueTransitTracked] = useState(false);
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
      await issue.mutateAsync({ id: request.id, date: issueDate, unit: issueUnit, quantity: qty, size: issueSize.trim() || undefined, dayStoreId, isTransitTracked: issueTransitTracked || undefined });
      toast.success(
        (qty >= request.remainingQty ? "Stock issued — request complete." : `${qty} issued — ${request.remainingQty - qty} still remaining on this request.`) +
          (issueTransitTracked ? " In transit until confirmed at the other end." : ""),
      );
      setShowIssue(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not issue stock");
    }
  }

  async function handleWithdraw() {
    if (!window.confirm(`Withdraw this request for ${request.requestedQty} ${request.item.name}? This can't be undone.`)) return;
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
                setIssueTransitTracked(false);
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
              <ItemPicker items={UNIT_ITEMS} value={issueUnit} onChange={setIssueUnit} clearable={false} />
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
          <label className="flex w-fit cursor-pointer items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600" title="Won't count at the other end until confirmed arrived — see the Transit tab.">
            <input type="checkbox" className="h-3.5 w-3.5" checked={issueTransitTracked} onChange={(e) => setIssueTransitTracked(e.target.checked)} />
            Track as In-Transit — takes real travel time to get there
          </label>
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
