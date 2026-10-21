import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiAll, apiCount } from "./api";
import type {
  BatchPrepStageId,
  AppNotification,
  AuditLogEntry,
  BatchImportSummary,
  BomPlan,
  CombinedLot,
  ProductionBatch,
  PreProduction,
  CatalogSku,
  Customer,
  CustomerReconciliationRow,
  DayStore,
  DayStoreAssignment,
  DayStoreStockLine,
  DispatchTransfer,
  DispensingRequirementItem,
  PlantStockLine,
  DispatchTransferType,
  DispatchQcStatus,
  InventoryCategory,
  InventoryItem,
  InventoryReceiptStatus,
  InventoryRequest,
  InventoryRequestPurpose,
  InventoryRequestStatus,
  InventoryStockLine,
  FgStockRow,
  QuarantineRow,
  StoreDashboardSummary,
  InventoryTransaction,
  InventoryTxnType,
  ImportCustomerUpdatesResult,
  ImportPoRequirementsResult,
  ImportPurchaseOrdersResult,
  ImportVendorsResult,
  ItemStockByLocation,
  ManagedUser,
  MaterialReconciliationRow,
  Plant,
  PoReadinessRow,
  PoFullReport,
  PoReconciliation,
  PoWastageRejectionRow,
  PendingPoMaterialRow,
  MaterialPlanningResult,
  PpicSummary,
  AddOnPlanDetail,
  AddOnProduct,
  AddOnResult,
  PreInventoryRequirement,
  ProductType,
  PurchaseOrder,
  QcDashboard,
  QcSampleConsumeReason,
  QcSampleSummary,
  QcSampleTransfer,
  RecipeRequest,
  RecipeRequestStatus,
  RecipeDetail,
  RecipeSummary,
  BomVersionSummary,
  PoProduct,
  RecycleBinEntityType,
  RecycleBinRow,
  RecycleStoreByBatchRow,
  RecycleStoreByItemRow,
  RecycleStoreTransaction,
  RmPlan,
  RndConsumeReason,
  RndSampleRequest,
  RndSampleRequestStatus,
  RndStoreReportRow,
  RndStoreStockRow,
  RndStoreTransaction,
  RndTransfer,
  RndTransferDirection,
  RoleName,
  MaterialConsumptionRow,
  PlantConsumptionBalance,
  StockTransfer,
  StockTransferDestinationType,
  StockTransferSourceType,
  StockTransferStatus,
  StoreUser,
  SystemHealth,
  TransitItem,
  Vendor,
  VendorPurchaseOrder,
  VendorPurchaseOrderItem,
  Warehouse,
} from "./types";
import type { ImportCustomerCatalogPayload } from "./catalogImport";
import type { ImportDispatchTransferRow, ImportInventoryRequestRow, ImportInventoryRow, ImportItemMasterRow, ImportPurchaseLogRow, ImportRequirementRow, ImportRndSampleRequestRow } from "./inventoryImport";
import type { ImportPurchaseOrderRow } from "./purchaseOrdersImport";
import type { ImportCustomerUpdateRow } from "./customersImport";
import type { ImportVendorRow } from "./vendorsImport";

// --- Customers ---

// pageSize=200 (the server's max, see pagination.ts) — without it this
// silently truncated at the default 50, same class of bug usePurchaseOrders
// already had to work around below.
export function useCustomers() {
  // The whole directory (every page) for dropdown pickers; the Customers table
  // pages through /api/customers with usePagedList.
  return useQuery({ queryKey: ["customers", "all"], queryFn: () => apiAll<Customer>("/api/customers") });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Customer>) => api<Customer>("/api/customers", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });
}

export function useUpdateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Customer> }) => api<Customer>(`/api/customers/${id}`, { method: "PATCH", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });
}

export function useImportCustomerUpdates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: ImportCustomerUpdateRow[]) => api<ImportCustomerUpdatesResult>("/api/customers/import-updates", { method: "POST", body: { rows } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });
}

// --- Vendors ---

export function useVendors() {
  // The whole directory (every page) - dropdown pickers need all of it. The
  // Vendors table itself pages through /api/vendors with usePagedList.
  return useQuery({ queryKey: ["vendors", "all"], queryFn: () => apiAll<Vendor>("/api/vendors") });
}

export function useCreateVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Vendor>) => api<Vendor>("/api/vendors", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendors"] }),
  });
}

export function useUpdateVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Vendor> }) => api<Vendor>(`/api/vendors/${id}`, { method: "PATCH", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendors"] }),
  });
}

export function useImportVendors() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: ImportVendorRow[]) => api<ImportVendorsResult>("/api/vendors/import", { method: "POST", body: { rows } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendors"] }),
  });
}

// --- Vendor Purchase Orders (RM/PM procurement — not to be confused
// with the customer PurchaseOrder above) ---

export function useVendorPurchaseOrders() {
  return useQuery({ queryKey: ["vendor-purchase-orders"], queryFn: () => apiAll<VendorPurchaseOrder>("/api/vendor-purchase-orders") });
}

export function useVendorPurchaseOrder(id: string | undefined) {
  return useQuery({
    queryKey: ["vendor-purchase-orders", id],
    queryFn: () => api<VendorPurchaseOrder>(`/api/vendor-purchase-orders/${id}`),
    enabled: !!id,
  });
}

export interface VendorPurchaseOrderItemPayload {
  itemId: string;
  quantity: number;
  unit: string;
  rate: number;
  gstPct: number;
}

export interface CreateVendorPurchaseOrderPayload {
  vendorId: string;
  poNumber: string;
  orderDate: string;
  eta?: string;
  items: VendorPurchaseOrderItemPayload[];
}

export function useCreateVendorPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateVendorPurchaseOrderPayload) => api<VendorPurchaseOrder>("/api/vendor-purchase-orders", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor-purchase-orders"] }),
  });
}

export function useUpdateVendorPurchaseOrder(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Pick<CreateVendorPurchaseOrderPayload, "vendorId" | "poNumber" | "orderDate" | "eta">> & { status?: VendorPurchaseOrder["status"] }) =>
      api<VendorPurchaseOrder>(`/api/vendor-purchase-orders/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vendor-purchase-orders", id] });
      qc.invalidateQueries({ queryKey: ["vendor-purchase-orders"] });
    },
  });
}

export function useAddVendorPurchaseOrderItem(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: VendorPurchaseOrderItemPayload) => api<VendorPurchaseOrderItem>(`/api/vendor-purchase-orders/${poId}/items`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor-purchase-orders", poId] }),
  });
}

export function useUpdateVendorPurchaseOrderItem(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: Partial<VendorPurchaseOrderItemPayload> }) =>
      api<VendorPurchaseOrderItem>(`/api/vendor-purchase-orders/${poId}/items/${itemId}`, { method: "PATCH", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor-purchase-orders", poId] }),
  });
}

export function useRemoveVendorPurchaseOrderItem(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api(`/api/vendor-purchase-orders/${poId}/items/${itemId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor-purchase-orders", poId] }),
  });
}

export interface ReceiveVendorPurchaseOrderItemPayload {
  quantity: number;
  unit?: string;
  batchNo?: string;
  grnNo?: string;
  mfgDate?: string;
  expiryDate?: string;
  remark?: string;
}

// Warehouse "Mark Received" — rides the same InventoryTransaction(RECEIVED)
// + inward QC gate the Inventory page's own Material Received flow uses;
// this just creates that row pre-linked to the vendor PO line item.
export function useReceiveVendorPurchaseOrderItem(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: ReceiveVendorPurchaseOrderItemPayload }) =>
      api(`/api/vendor-purchase-orders/${poId}/items/${itemId}/receive`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor-purchase-orders", poId] }),
  });
}

export function useAddVendorPurchaseOrderFreight(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (freightCharges: number) => api<VendorPurchaseOrder>(`/api/vendor-purchase-orders/${poId}/freight`, { method: "POST", body: { freightCharges } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor-purchase-orders", poId] }),
  });
}

// --- Purchase Orders ---

// pageSize=200 (the server's max, see pagination.ts) — without it this
// silently truncated at the default 50, which the page's own "Download
// Report" button (and now the pending-PO-aging report) both rely on
// being the complete list, not a first page of it.
// PPIC's tiles: one server call over every PO instead of loading them all into the browser.
export function usePpicSummary(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["purchase-orders", "ppic", "summary"],
    queryFn: () => api<PpicSummary>("/api/ppic/summary"),
    enabled: options?.enabled,
    // Tiles drift behind actions made on other pages; keep them fresh without a manual refresh.
    staleTime: 15_000,
  });
}

// The five newest POs for the dashboard's "Recent Orders" box - not the whole list.
export function useRecentOrders() {
  return useQuery({ queryKey: ["purchase-orders", "recent"], queryFn: () => api<PurchaseOrder[]>("/api/purchase-orders?page=1&pageSize=5") });
}

export function usePurchaseOrders(options?: { enabled?: boolean }) {
  return useQuery({ queryKey: ["purchase-orders"], queryFn: () => apiAll<PurchaseOrder>("/api/purchase-orders"), enabled: options?.enabled });
}

export function usePoWastageRejectionReport(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["purchase-orders", "reports", "wastage-rejection"],
    queryFn: () => api<PoWastageRejectionRow[]>("/api/purchase-orders/reports/wastage-rejection"),
    enabled: options?.enabled,
  });
}

// Pending PO Report — per-product RM/PM material breakdown, only fetched
// when the Pending POs drill-down is actually open (see
// PpicPlanningDetailPage.tsx), not on every dashboard load.
export function usePendingPoMaterials(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["purchase-orders", "reports", "pending-materials"],
    queryFn: () => api<PendingPoMaterialRow[]>("/api/purchase-orders/reports/pending-materials"),
    enabled: options?.enabled,
  });
}

// Material Planning — every planned product's materials, covered vs short,
// FIFO-allocated across products (see apps/api material-planning.ts).
export function useMaterialPlanning(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["purchase-orders", "reports", "material-planning"],
    queryFn: () => api<MaterialPlanningResult>("/api/purchase-orders/reports/material-planning"),
    enabled: options?.enabled,
  });
}

// PPIC's Hold / Release on one product's materials, or on a whole PO's.
export function useSetItemMaterialHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, itemId, held }: { poId: string; itemId: string; held: boolean }) =>
      api(`/api/purchase-orders/${poId}/items/${itemId}/material-hold`, { method: "PATCH", body: { held } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-orders"] }),
  });
}

// Material Planning's "Send short material to Purchase" for one product.
export function useSendShortToPurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, itemId }: { poId: string; itemId: string }) =>
      api<{ sent: number; updated: number; skipped: number }>(`/api/purchase-orders/${poId}/items/${itemId}/send-short-to-purchase`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["pre-inventory"] });
    },
  });
}

// PPIC's Cancel on one product - permanent, reason required (see the API's
// PATCH /:id/items/:itemId/cancel).
export function useCancelPoItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, itemId, reason }: { poId: string; itemId: string; reason: string }) =>
      api(`/api/purchase-orders/${poId}/items/${itemId}/cancel`, { method: "PATCH", body: { reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-orders"] }),
  });
}

export function useSetPoMaterialHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, held }: { poId: string; held: boolean }) => api<{ updated: number }>(`/api/purchase-orders/${poId}/material-hold`, { method: "PATCH", body: { held } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-orders"] }),
  });
}

// Add on Plan — "can we get this product urgently?": PPIC picks a product, types the quantity, and sees the RM and PM it needs against stock.
/** Every product the check can work out: the Add on Plan dropdown. */
export function useAddOnPlanProducts() {
  return useQuery({ queryKey: ["add-on-plan", "products"], queryFn: () => api<AddOnProduct[]>("/api/add-on-plan/products") });
}

/** Works the material out for one product and quantity (a calculation, nothing is saved). */
export function useCalculateAddOn() {
  return useMutation({
    mutationFn: (body: { customerId: string; name: string; quantity: number; unit: "KG" | "PACKS" }) => api<AddOnResult>("/api/add-on-plan/calculate", { method: "POST", body }),
  });
}

// PPIC plan-sent list's "View" — same Add on Plan material read, resolved
// from a specific PO line item instead of a Sku/Recipe search. Only
// fetched once the panel for that row is actually opened (see poItemId).
// How far a product's run preparation has got, for the plan view: GRN, Indent, Dispensing and Line Clearance.
export interface PlanPreparation {
  stage: string;
  grnNo: string | null;
  grnDate: string | null;
  indentSlip: string | null;
  indentDate: string | null;
  rmDispensingDate: string | null;
  pmIssuedDate: string | null;
  lineClearance: string | null;
}

export function usePoItemPlan(poId: string, itemId: string | null, options?: { released?: boolean }) {
  const released = !!options?.released;
  return useQuery({
    queryKey: ["purchase-orders", poId, "items", itemId, "plan", released ? "released" : "full"],
    queryFn: () =>
      api<{ bom: AddOnPlanDetail | null; rm: AddOnPlanDetail | null; preparation?: PlanPreparation | null; release?: { orderQty: number; releasedQty: number; unit: string } }>(
        `/api/purchase-orders/${poId}/items/${itemId}/plan${released ? "?released=1" : ""}`,
      ),
    enabled: !!itemId,
  });
}

// PPIC's "Send partial" dialog: what is left to release, and a suggestion of how much the material in hand covers.
export interface ReleaseInfo {
  orderQty: number;
  releasedQty: number;
  remainingQty: number;
  unit: string;
  suggestedQty: number | null;
  limitedBy: string | null;
}

export function useReleaseInfo(poId: string, itemId: string | null) {
  return useQuery({
    queryKey: ["purchase-orders", poId, "items", itemId, "release-info"],
    queryFn: () => api<ReleaseInfo>(`/api/purchase-orders/${poId}/items/${itemId}/release-info`),
    enabled: !!itemId,
  });
}

export function useItemStockByLocation(itemId: string | undefined) {
  return useQuery({
    queryKey: ["inventory", "items", itemId, "stock-by-location"],
    queryFn: () => api<ItemStockByLocation>(`/api/inventory/items/${itemId}/stock-by-location`),
    enabled: !!itemId,
  });
}

export interface OrderConversion {
  packs: number | null;
  kg: number | null;
  packSizeText: string | null;
  packSizeSource: "PO line" | "Packaging BOM" | null;
  note: string | null;
  packsProblem: string | null;
  kgProblem: string | null;
}

// How a PO line's quantity is turned into packs (Packaging BOM) and Kg (RM BOM). `inputs` only changes the key, so it refreshes after a correction.
export function usePoItemConversion(poId: string, itemId: string, inputs: string) {
  return useQuery({ queryKey: ["purchase-orders", poId, "conversion", itemId, inputs], queryFn: () => api<OrderConversion>(`/api/purchase-orders/${poId}/items/${itemId}/conversion`) });
}

export function usePurchaseOrder(id: string | undefined) {
  return useQuery({
    queryKey: ["purchase-orders", id],
    queryFn: () => api<PurchaseOrder>(`/api/purchase-orders/${id}`),
    enabled: !!id,
  });
}

// Phase G — the PO-level combined Material Reconciliation rollup, see
// purchase-orders.routes.ts GET /:id/reconciliation.
export function usePoReconciliation(id: string | undefined) {
  return useQuery({
    queryKey: ["purchase-orders", id, "reconciliation"],
    queryFn: () => api<PoReconciliation>(`/api/purchase-orders/${id}/reconciliation`),
    enabled: !!id,
  });
}

// The step-by-step Full Report — every product line's PreProduction walk
// plus every ProductionBatch's own execution + Tier-3 walk. See
// purchase-orders.routes.ts's GET /:id/full-report.
export function usePoFullReport(id: string | undefined) {
  return useQuery({
    queryKey: ["purchase-orders", id, "full-report"],
    queryFn: () => api<PoFullReport>(`/api/purchase-orders/${id}/full-report`),
    enabled: !!id,
  });
}

// PO-level consolidated Billing — see purchase-orders.routes.ts's
// GET/POST /:id/billing. Preview (GET) is Purchase+Accounts; generating
// the saved invoice (POST) is Accounts-only.
export interface CreatePurchaseOrderPayload {
  customerId: string;
  poNumber?: string;
  orderDate?: string;
  expectedDeliveryDate?: string;
  regulatoryBody?: string;
  regulatoryStatus?: string;
  items: {
    productName: string;
    productCategory: string;
    dosageForm?: string;
    quantity: number;
    unit: string;
    volume?: number;
    packSize?: string;
    packType?: string;
    bomRef?: string;
    productType?: ProductType;
  }[];
}

// Master list behind the PO forms' Product Category dropdown (Powder,
// Gummies, Bars, ...). "+ New" on the forms adds to it for everyone.
export interface ProductCategoryOption {
  id: string;
  name: string;
}

export function useProductCategories() {
  return useQuery({
    queryKey: ["product-categories"],
    queryFn: () => api<ProductCategoryOption[]>("/api/purchase-orders/product-categories"),
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateProductCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<ProductCategoryOption>("/api/purchase-orders/product-categories", { method: "POST", body: { name } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["product-categories"] }),
  });
}

export function useCreatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePurchaseOrderPayload) => api<PurchaseOrder>("/api/purchase-orders", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-orders"] }),
  });
}

// Order Tracking's tiles, counted on the server over every PO (not the page on screen).
export function usePoSummary() {
  return useQuery({
    queryKey: ["purchase-orders", "summary"],
    queryFn: () => api<{ purchaseOrders: number; products: number; inProduction: number }>("/api/purchase-orders/summary"),
  });
}

export function useImportPurchaseOrders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: ImportPurchaseOrderRow[]) => api<ImportPurchaseOrdersResult>("/api/purchase-orders/import", { method: "POST", body: { rows } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

// BD's own correction of the PO header — PO Number, Order Date,
// Expected Delivery Date, Regulatory Body/Status. Not customerId or
// items — those have their own dedicated routes/hooks. Works at any PO
// status, same as the backend route itself (no DRAFT-only gate here).
export function useUpdatePurchaseOrder(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { poNumber?: string; orderDate?: string; expectedDeliveryDate?: string; regulatoryBody?: string; regulatoryStatus?: string }) =>
      api<PurchaseOrder>(`/api/purchase-orders/${poId}`, { method: "PATCH", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["purchase-orders", poId] });
    },
  });
}

// Draft → BD Approve/Reject. Production can't be started off any of this
// PO's line items until it's approved (see useCreatePreProduction below).
export function useReviewPurchaseOrder(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { status: "APPROVED" | "REJECTED"; rejectionReason?: string }) => api<PurchaseOrder>(`/api/purchase-orders/${poId}/review`, { method: "PATCH", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["purchase-orders", poId] });
    },
  });
}

export function useAddPurchaseOrderItem(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePurchaseOrderPayload["items"][number]) => api(`/api/purchase-orders/${poId}/items`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-orders", poId] }),
  });
}

// BD-only correction of a line item already on the PO — most commonly
// productName, once a naming mismatch turns up downstream (see
// findSimilarName). Stays allowed even once production has started
// against the item (see the PATCH route's own comment); every other
// field on PurchaseOrderItemSchema is technically accepted too, but the
// UI only ever sends productName today.
export function useUpdatePurchaseOrderItem(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, ...body }: { itemId: string; productName: string }) => api(`/api/purchase-orders/${poId}/items/${itemId}`, { method: "PATCH", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-orders", poId] }),
  });
}

// PPIC's own planning call — which Plant this product's production will
// happen at, set ahead of Production ever creating a run. See
// purchase-orders.routes.ts PATCH /:id/items/:itemId/planned-plant.
export function useAssignPlannedPlant(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, plantId }: { itemId: string; plantId: string | null }) =>
      api(`/api/purchase-orders/${poId}/items/${itemId}/planned-plant`, { method: "PATCH", body: { plantId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-orders", poId] }),
  });
}

// Regulatory's own per-item review — see PurchaseOrderItem.regulatoryStatus's own schema comment.
// Regulatory's own narrow-scope edit of just regulatoryBody/
// regulatoryStatus (BD can also set this, via useUpdatePurchaseOrder ->
// PATCH /:id, but that route is BD-only — this hits the dedicated
// REGULATORY-allowed route instead). See purchase-orders.routes.ts's
// PATCH /:id/regulatory-body.
export function useSetRegulatoryBody(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { regulatoryBody?: string; regulatoryStatus?: string }) => api<PurchaseOrder>(`/api/purchase-orders/${poId}/regulatory-body`, { method: "PATCH", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["purchase-orders", poId] });
    },
  });
}

export function useRegulatoryReview(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, status, remarks }: { itemId: string; status: "Approved" | "Not Approved"; remarks?: string }) =>
      api(`/api/purchase-orders/${poId}/items/${itemId}/regulatory-review`, { method: "PATCH", body: { status, remarks } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-orders", poId] }),
  });
}

// PPIC's hand-off — see purchase-orders.routes.ts's POST
// /:id/items/:itemId/send-plan-to-production for the preconditions.
export function useSendPlanToProduction(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    // Pass an item id for a full release, or { itemId, quantity } to release only part of the order.
    mutationFn: (arg: string | { itemId: string; quantity?: number }) => {
      const { itemId, quantity } = typeof arg === "string" ? { itemId: arg, quantity: undefined } : arg;
      return api(`/api/purchase-orders/${poId}/items/${itemId}/send-plan-to-production`, { method: "POST", body: quantity === undefined ? undefined : { quantity } });
    },
    // The whole purchase-orders family: also refreshes the Material Planning /
    // PO Readiness lists, which a sent product leaves.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-orders"] }),
  });
}

// --- PO Material Readiness — see PoMaterialRequirement in schema.prisma.
// pageSize is pinned at the API's max (200) rather than paginated in the
// UI — matches the scale the requirement was raised for (hundreds of
// POs at once), and this is a live "what's ready right now" view, not a
// browsable archive that needs real pagination. ---

export function usePoReadiness(readyOnly?: boolean, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["po-readiness", readyOnly ?? false],
    queryFn: () => apiAll<PoReadinessRow>(`/api/po-readiness${readyOnly ? "?ready=true" : ""}`),
    enabled: options?.enabled,
  });
}

export function usePoReadinessDetail(purchaseOrderId: string | undefined) {
  return useQuery({
    queryKey: ["po-readiness", "detail", purchaseOrderId],
    queryFn: () => api<PoReadinessRow>(`/api/po-readiness/${purchaseOrderId}`),
    enabled: !!purchaseOrderId,
  });
}

export interface ImportPoRequirementRow {
  poNumber: string;
  category: "RM" | "PM";
  itemName: string;
  requiredQty: number;
  unit: string;
}

export function useImportPoRequirements() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: ImportPoRequirementRow[]) => api<ImportPoRequirementsResult>("/api/po-readiness/import", { method: "POST", body: { rows } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["po-readiness"] }),
  });
}

export interface CreatePoRequirementPayload {
  purchaseOrderId: string;
  itemId: string;
  category: "RM" | "PM";
  requiredQty: number;
  unit: string;
}

// The "Add Manually" form next to Import Excel — same pair as every
// other module's manual-entry-plus-bulk-import (Pre-Inventory, Material
// Requests, ...).
export function useCreatePoRequirement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePoRequirementPayload) => api("/api/po-readiness", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["po-readiness"] }),
  });
}

export function useDeletePoRequirementItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ purchaseOrderId, itemId }: { purchaseOrderId: string; itemId: string }) =>
      api<void>(`/api/po-readiness/${purchaseOrderId}/items/${itemId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["po-readiness"] }),
  });
}

export function useRemovePurchaseOrderItem(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api(`/api/purchase-orders/${poId}/items/${itemId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-orders", poId] }),
  });
}

export function useUploadPoDocument(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api(`/api/purchase-orders/${poId}/documents`, { method: "POST", body: form, isFormData: true });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-orders", poId] }),
  });
}

// --- Three-tier production pipeline (see types.ts's own comment block
// above PreProduction/ProductionBatch/CombinedLot) ---

// --- Tier 1 — PreProduction ---

export function usePreProductions(purchaseOrderItemId?: string) {
  return useQuery({
    queryKey: ["pre-productions", { purchaseOrderItemId }],
    queryFn: () => apiAll<PreProduction>(`/api/pre-productions${purchaseOrderItemId ? `?purchaseOrderItemId=${purchaseOrderItemId}` : ""}`),
  });
}

export function usePreProduction(id: string | undefined) {
  return useQuery({ queryKey: ["pre-productions", "detail", id], queryFn: () => api<PreProduction>(`/api/pre-productions/${id}`), enabled: !!id });
}

// What this run's product needs (per its linked, calculated RmPlan/
// BomPlan) versus what's logged so far — drives the Dispensing checklist
// so Store sees what's still short before attempting to forward. Empty
// `items` means nothing to check against (no linked plan).
export function useDispensingRequirements(preProductionId: string | undefined) {
  return useQuery({
    queryKey: ["pre-productions", "dispensing-requirements", preProductionId],
    queryFn: () => api<{ items: DispensingRequirementItem[] }>(`/api/pre-productions/${preProductionId}/dispensing-requirements`),
    enabled: !!preProductionId,
  });
}

// Stage 1's panel: what the released quantity needs, what has reached the Plant, what is on its way.
export interface MaterialCoverageLine {
  material: string;
  category: "RM" | "PM";
  unit: string;
  requiredQty: number;
  receivedQty: number;
  atDayStoreQty: number;
  inTransitQty: number;
  shortQty: number;
  covered: boolean;
}
export interface MaterialCoverage {
  releasedQty: number;
  orderQty: number;
  unit: string;
  lines: MaterialCoverageLine[];
  allCovered: boolean;
}
export function useMaterialCoverage(preProductionId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["pre-productions", "material-coverage", preProductionId],
    queryFn: () => api<MaterialCoverage | null>(`/api/pre-productions/${preProductionId}/material-coverage`),
    enabled: !!preProductionId && (options?.enabled ?? true),
    staleTime: 10_000,
  });
}

export function useCreatePreProduction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { purchaseOrderItemId: string; plantId?: string; confirmNotReady?: boolean; batchFlow?: boolean }) => api<PreProduction>("/api/pre-productions", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pre-productions"] }),
  });
}

// Assign/change which Plant a run runs at — separate from the stage
// transition, PPIC's call any time (e.g. fixing a run created before a
// Plant was picked). null explicitly clears it.
export function useAssignPreProductionPlant(preProductionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (plantId: string | null) => api<PreProduction>(`/api/pre-productions/${preProductionId}/plant`, { method: "PATCH", body: { plantId } }),
    onSuccess: (updated) => {
      qc.setQueryData(["pre-productions", "detail", preProductionId], updated);
      qc.invalidateQueries({ queryKey: ["pre-productions"] });
    },
  });
}

// The one transition endpoint for this tier's pipeline: fill in the
// current stage's fields (if it has any), then either forward the run or
// send it back to the previous stage (REJECT requires a note). JUMP is
// the admin-only override — moves the run straight to any stage via
// targetStageId, no fields required.
export function useTransitionPreProductionStage(preProductionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: "FORWARD" | "REJECT" | "JUMP"; note?: string; targetStageId?: string } & Record<string, unknown>) =>
      api<PreProduction>(`/api/pre-productions/${preProductionId}/stage`, { method: "PATCH", body }),
    onSuccess: (updated) => {
      qc.setQueryData(["pre-productions", "detail", preProductionId], updated);
      qc.invalidateQueries({ queryKey: ["pre-productions"] });
    },
  });
}

// QA's own per-line "Verified By" sign-off on a Dispensing Sheet
// consumption row (BMR-1.docx 3.0) — separate from the pipeline's Sample
// QC Approval gate. Append-only: the API 409s on a second call.
export function useVerifyConsumption(preProductionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (consumptionId: string) => api<PreProduction>(`/api/pre-productions/${preProductionId}/consumptions/${consumptionId}/verify`, { method: "POST" }),
    onSuccess: (updated) => {
      qc.setQueryData(["pre-productions", "detail", preProductionId], updated);
      qc.invalidateQueries({ queryKey: ["pre-productions"] });
    },
  });
}

// The dispensing-area Line Clearance checklist — matches BMR-1.docx's
// real paper form item for item. Each save writes only the caller's own
// column (DEPT — Store — or QA), same "you can only touch your own
// department's part of the record" shape as the rest of this pipeline.
export function useUpdatePreProductionChecklist(preProductionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { column: "DEPT" | "QA"; items: { itemKey: string; ok: boolean }[] }) =>
      api<PreProduction>(`/api/pre-productions/${preProductionId}/checklist`, { method: "PATCH", body }),
    onSuccess: (updated) => {
      qc.setQueryData(["pre-productions", "detail", preProductionId], updated);
      qc.invalidateQueries({ queryKey: ["pre-productions"] });
    },
  });
}

// Bulk "forward the current stage" import — one row per (PO Number,
// Product Name), each run through the exact same gating a manual Forward
// would (see batch-import.ts on the API side). Rows type comes from
// batchStageImport.ts's parser, not imported here to avoid a cycle —
// callers pass whatever parseBatchStageWorkbook returned.
export function useImportBatchStages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: { poNumber: string; productName: string; note?: string; fields: Record<string, unknown> }[]) =>
      api<BatchImportSummary>("/api/pre-productions/import", { method: "POST", body: { rows } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pre-productions"] });
      qc.invalidateQueries({ queryKey: ["combined-lots"] });
    },
  });
}

// --- Tier 2 — ProductionBatch ---

export function useProductionBatches(preProductionId: string | undefined) {
  return useQuery({
    queryKey: ["pre-productions", preProductionId, "production-batches"],
    queryFn: () => api<ProductionBatch[]>(`/api/pre-productions/${preProductionId}/production-batches`),
    enabled: !!preProductionId,
  });
}

export function useCreateProductionBatch(preProductionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { batchNo?: string; plannedQty: number; reason?: string }) => api<ProductionBatch>(`/api/pre-productions/${preProductionId}/production-batches`, { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pre-productions", preProductionId, "production-batches"] });
      qc.invalidateQueries({ queryKey: ["pre-productions", "plans-board"] });
      qc.invalidateQueries({ queryKey: ["pre-productions", "detail", preProductionId] });
    },
  });
}

// Saves this run's own execution fields — dates/status/remarks and
// input/output qty. Doesn't itself complete the run — see
// useCompleteProductionBatch below.
export function useUpdateProductionBatch(preProductionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) => api<ProductionBatch>(`/api/production-batches/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pre-productions", preProductionId, "production-batches"] });
      qc.invalidateQueries({ queryKey: ["pre-productions", "plans-board"] });
    },
  });
}

// Marks the run COMPLETED and adds its outputQty to the parent's running
// combinedQty (a progress figure only) — doesn't pool into anything any
// more, the batch just becomes eligible for its own pipeline (see
// useTransitionProductionBatchStage above).
export function useCompleteProductionBatch(preProductionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ productionBatch: ProductionBatch }>(`/api/production-batches/${id}/complete`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pre-productions", preProductionId, "production-batches"] });
      qc.invalidateQueries({ queryKey: ["pre-productions", "plans-board"] });
      qc.invalidateQueries({ queryKey: ["pre-productions", "detail", preProductionId] });
      qc.invalidateQueries({ queryKey: ["production-batches"] });
    },
  });
}

// Every COMPLETED batch, across every PreProduction — the Dashboard's
// own "my queue" source for a batch's own pipeline, same shape
// useCombinedLots() below has for its tier.
export function useAllProductionBatches() {
  return useQuery({ queryKey: ["production-batches"], queryFn: () => api<ProductionBatch[]>("/api/production-batches") });
}

// Single-run detail fetch — used by this batch's own Tier-3 pipeline
// page, same shape useCombinedLot(id) below has for its tier.
export function useProductionBatch(id: string | undefined) {
  return useQuery({ queryKey: ["production-batches", "detail", id], queryFn: () => api<ProductionBatch>(`/api/production-batches/${id}`), enabled: !!id });
}

// QC's own call — assigns/corrects the real batch number. Not
// Production's any more, see ProductionBatch.batchNo's schema comment.
export function useAssignProductionBatchNo(preProductionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, batchNo }: { id: string; batchNo: string }) => api<ProductionBatch>(`/api/production-batches/${id}/batch-no`, { method: "PATCH", body: { batchNo } }),
    onSuccess: (updated) => {
      qc.setQueryData(["production-batches", "detail", updated.id], updated);
      if (preProductionId) qc.invalidateQueries({ queryKey: ["pre-productions", preProductionId, "production-batches"] });
    },
  });
}

// This batch's OWN Tier-3 pipeline transition — same FORWARD/REJECT
// shape as useTransitionCombinedLotStage below, just no
// confirmPartialDispatch (a batch dispatching on its own is the normal
// case here, not an exception to confirm).
export function useTransitionProductionBatchStage(batchId: string, preProductionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: "FORWARD" | "REJECT"; note?: string } & Record<string, unknown>) => api<ProductionBatch>(`/api/production-batches/${batchId}/stage`, { method: "PATCH", body }),
    onSuccess: (updated) => {
      qc.setQueryData(["production-batches", "detail", batchId], updated);
      if (preProductionId) qc.invalidateQueries({ queryKey: ["pre-productions", preProductionId, "production-batches"] });
    },
  });
}

// --- Tier 3 — CombinedLot ---

// Every pooled lot, across every PO item — used by the Dashboard's
// org-wide view (delay, stage counts, "my queue") alongside
// usePreProductions() above.
export function useCombinedLots() {
  return useQuery({ queryKey: ["combined-lots"], queryFn: () => api<CombinedLot[]>("/api/combined-lots") });
}

export function useCombinedLot(id: string | undefined) {
  return useQuery({ queryKey: ["combined-lots", "detail", id], queryFn: () => api<CombinedLot>(`/api/combined-lots/${id}`), enabled: !!id });
}

// The one transition endpoint for this tier's pipeline — same shape as
// useTransitionPreProductionStage above, plus confirmPartialDispatch (the
// combined-shipment override) at Dispatch Plan.
export function useTransitionCombinedLotStage(combinedLotId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: "FORWARD" | "REJECT" | "JUMP"; note?: string; targetStageId?: string; confirmPartialDispatch?: boolean } & Record<string, unknown>) =>
      api<CombinedLot>(`/api/combined-lots/${combinedLotId}/stage`, { method: "PATCH", body }),
    onSuccess: (updated) => {
      qc.setQueryData(["combined-lots", "detail", combinedLotId], updated);
      qc.invalidateQueries({ queryKey: ["combined-lots"] });
    },
  });
}

// The bulk-mfg-area Line Clearance checklist — Production's own column
// instead of Store's, otherwise the same shape as
// useUpdatePreProductionChecklist above.
export function useUpdateCombinedLotChecklist(combinedLotId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { column: "DEPT" | "QA"; items: { itemKey: string; ok: boolean }[] }) =>
      api<CombinedLot>(`/api/combined-lots/${combinedLotId}/checklist`, { method: "PATCH", body }),
    onSuccess: (updated) => {
      qc.setQueryData(["combined-lots", "detail", combinedLotId], updated);
      qc.invalidateQueries({ queryKey: ["combined-lots"] });
    },
  });
}

// Certificate of Analysis — matches COA format.docx. A full replace each
// save (which tests apply varies by product, so there's no fixed key set
// to upsert against — see checklists above for the contrast).
export function useReplaceCoaResults(combinedLotId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (results: { testName: string; specification?: string; observation?: string }[]) =>
      api<CombinedLot>(`/api/combined-lots/${combinedLotId}/coa/results`, { method: "PUT", body: { results } }),
    onSuccess: (updated) => {
      qc.setQueryData(["combined-lots", "detail", combinedLotId], updated);
      qc.invalidateQueries({ queryKey: ["combined-lots"] });
    },
  });
}

// The COA's three sequential sign-offs (Analyzed -> Reviewed -> Approved)
// — each settable once, in order; the API 409s otherwise.
export function useSignCoa(combinedLotId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (step: "ANALYZED" | "REVIEWED" | "APPROVED") => api<CombinedLot>(`/api/combined-lots/${combinedLotId}/coa/sign`, { method: "POST", body: { step } }),
    onSuccess: (updated) => {
      qc.setQueryData(["combined-lots", "detail", combinedLotId], updated);
      qc.invalidateQueries({ queryKey: ["combined-lots"] });
    },
  });
}

// --- Packaging BOM module ---
//
// There's no separate "Brand" catalog anymore — the SKU spec catalog
// hangs directly off Customer (useCustomers/useCreateCustomer/
// useUpdateCustomer above cover picking, quick-adding, and renaming one;
// see the Sku model's own schema comment for why).

export function useSkus(customerId?: string) {
  return useQuery({
    queryKey: ["catalog", "skus", customerId],
    // pageSize=200 (the API's own cap) — a real customer can carry 100+
    // SKUs (see the real Packaging Material import), and every caller of
    // this hook wants the whole list at once (a suggestion dropdown, a
    // Generate match), never a paged table.
    queryFn: () => apiAll<CatalogSku>(`/api/catalog/skus${customerId ? `?customerId=${customerId}` : ""}`),
    enabled: !!customerId,
  });
}

// Every distinct Product Name across the whole catalog (every customer),
// not scoped to one — feeds the "Add Product" picker on the PO form so a
// product already made for a different customer shows up as a suggestion,
// not just the selected customer's own (possibly empty) SKU list.
export function useAllProductNames() {
  return useQuery({
    queryKey: ["catalog", "product-names"],
    queryFn: () => api<string[]>("/api/catalog/product-names"),
    staleTime: 60_000,
  });
}

export function useReportCatalogMismatch() {
  return useMutation({
    mutationFn: (input: { kind: "customer" | "product"; typedName: string; matchedName: string; customerName?: string }) =>
      api<{ ok: boolean }>("/api/catalog/mismatch-reports", { method: "POST", body: input }),
  });
}

export function useCreateSku() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { customerId: string; productName: string }) => api<CatalogSku>("/api/catalog/skus", { method: "POST", body: input }),
    onSuccess: (_data, variables) => qc.invalidateQueries({ queryKey: ["catalog", "skus", variables.customerId] }),
  });
}

export function useUpdateSku(customerId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<CatalogSku> & { id: string }) => api<CatalogSku>(`/api/catalog/skus/${id}`, { method: "PATCH", body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog", "skus", customerId] }),
  });
}

export interface PmComponentPayload {
  type: string;
  quantity: number | null;
  unit: string;
  pmCode?: string;
  pmItemId?: string | null;
  overagePct?: number | null;
  spec?: string | null;
  make?: string | null;
  packingLevel?: "Primary" | "Secondary" | "Tertiary" | null;
}
export interface PmHeaderPayload {
  productCode?: string | null;
  packSize?: string | null;
  packingConfig?: string | null;
  batchPacks?: number | null;
}

// Product names BD has put on POs (names only), so R&D sees which products still need a BOM.
export function usePoProducts(enabled = true) {
  return useQuery({ queryKey: ["catalog", "po-products"], queryFn: () => api<PoProduct[]>("/api/catalog/po-products"), enabled });
}

export function useBomVersions(kind: "PM" | "RM", entityId: string | undefined) {
  return useQuery({ queryKey: ["bom-versions", kind, entityId], queryFn: () => api<BomVersionSummary[]>(`/api/bom-versions/${kind}/${entityId}`), enabled: !!entityId });
}

export function fetchBomVersion<T>(kind: "PM" | "RM", entityId: string, version: number) {
  return api<{ version: number; note: string | null; createdAt: string; snapshot: T }>(`/api/bom-versions/${kind}/${entityId}/${version}`);
}

export function useRestoreBomVersion(kind: "PM" | "RM", entityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) => api<{ version: number }>(`/api/bom-versions/${kind}/${entityId}/${version}/restore`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bom-versions"] });
      qc.invalidateQueries({ queryKey: ["catalog", "skus"] });
      qc.invalidateQueries({ queryKey: ["rm-costing", "recipes"] });
    },
  });
}

export function useUpdateSkuPackagingComponents(customerId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, components, header, note }: { id: string; components: PmComponentPayload[]; header?: PmHeaderPayload; note?: string }) =>
      api<CatalogSku>(`/api/catalog/skus/${id}/packaging-components`, { method: "PUT", body: { components, header, note } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["catalog", "skus", customerId] });
      qc.invalidateQueries({ queryKey: ["bom-versions"] });
    },
  });
}

export function useImportCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (customers: ImportCustomerCatalogPayload[]) =>
      api<{ customersTouched: number; skusUpserted: number; ambiguous: { customerName: string; matchCount: number }[] }>("/api/catalog/import", {
        method: "POST",
        body: { customers },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog"] }),
  });
}

export function useBomPlans() {
  return useQuery({ queryKey: ["bom-plans"], queryFn: () => apiAll<BomPlan>("/api/bom/plans") });
}

export function useBomPlan(id: string | undefined) {
  return useQuery({ queryKey: ["bom-plans", id], queryFn: () => api<BomPlan>(`/api/bom/plans/${id}`), enabled: !!id });
}

export function useCreateBomPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; purchaseOrderItemId?: string }) => api<BomPlan>("/api/bom/plans", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bom-plans"] });
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
  });
}

export function useAddBomPlanItem(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { skuId: string; targetYield: number }) => api<BomPlan>(`/api/bom/plans/${planId}/items`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bom-plans", planId] }),
  });
}

export function useRemoveBomPlanItem(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api<BomPlan>(`/api/bom/plans/${planId}/items/${itemId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bom-plans", planId] }),
  });
}

export function useCalculateBomPlan(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ plan: BomPlan; result: BomPlan["result"] }>(`/api/bom/plans/${planId}/calculate`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bom-plans", planId] }),
  });
}

// Turns a calculated plan straight into Pre-Inventory requirements (S1)
// — one PM requirement per component/spec line.
// --- Recipe Requests (R&D) — PPIC's "we don't have a Recipe/SKU for
// this product yet" ask, see recipe-request.routes.ts. ---

export function useRecipeRequests(filter?: { status?: RecipeRequestStatus; purchaseOrderItemId?: string; enabled?: boolean }) {
  const params = new URLSearchParams();
  if (filter?.status) params.set("status", filter.status);
  if (filter?.purchaseOrderItemId) params.set("purchaseOrderItemId", filter.purchaseOrderItemId);
  const qs = params.toString();
  return useQuery({
    queryKey: ["recipe-requests", filter?.status ?? null, filter?.purchaseOrderItemId ?? null],
    queryFn: () => api<RecipeRequest[]>(`/api/recipe-requests${qs ? `?${qs}` : ""}`),
    enabled: filter?.enabled ?? true,
  });
}

export function useCreateRecipeRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (purchaseOrderItemId: string) => api<RecipeRequest>("/api/recipe-requests", { method: "POST", body: { purchaseOrderItemId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recipe-requests"] }),
  });
}

export function useGiveRecipeRequestEta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, etaDate, etaNote }: { id: string; etaDate: string; etaNote?: string }) =>
      api<RecipeRequest>(`/api/recipe-requests/${id}/eta`, { method: "PATCH", body: { etaDate, etaNote } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recipe-requests"] }),
  });
}

// --- RM Costing module ---

export function useRecipes(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["rm-costing", "recipes"],
    queryFn: () => apiAll<RecipeSummary>("/api/rm-costing/recipes"),
    enabled: options?.enabled ?? true,
  });
}

// Company-wide catalog size (every customer, not one) — just the count,
// for a reference stat tile. GET /api/catalog/skus is open to any
// authenticated role, same as useRecipes above; pageSize=1 keeps the
// actual row payload negligible, the X-Total-Count header is the point.
export function useCatalogSkuCount(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["catalog", "skus", "count"],
    queryFn: () => apiCount("/api/catalog/skus?pageSize=1"),
    enabled: options?.enabled ?? true,
  });
}

export interface RecipeImportPayload {
  name: string;
  customerId?: string | null;
  kind?: "PER_KG" | "PER_UNIT";
  productCode?: string | null;
  versionLabel?: string | null;
  batchSize?: number | null;
  avgUnitWeightMg?: number | null;
  note?: string;
  ingredients: { name: string; brand: string; itemCode?: string; gPerServing: number; proteinPct: number; uom?: string }[];
}

export function useImportRecipes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (recipes: RecipeImportPayload[]) =>
      api<{ recipesUpserted: number; ingredientsUpserted: number }>("/api/rm-costing/recipes/import", { method: "POST", body: { recipes } }),
    // Prefix match — also catches any cached single-recipe detail (see
    // useRecipe below), since the manual editor (RecipeEditor) saves
    // through this same mutation and needs its own detail view refreshed.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rm-costing", "recipes"] });
      qc.invalidateQueries({ queryKey: ["bom-versions"] });
    },
  });
}

// Full detail (every ingredient row) for one Recipe — used by the manual
// "Browse & Edit Recipe" editor, same shape convention as Packaging BOM's
// SkuEditor reading a single Sku's full spec.
export function useRecipe(id: string | undefined) {
  return useQuery({ queryKey: ["rm-costing", "recipes", "detail", id], queryFn: () => api<RecipeDetail>(`/api/rm-costing/recipes/${id}`), enabled: !!id });
}

export function useRmPlans() {
  return useQuery({ queryKey: ["rm-plans"], queryFn: () => apiAll<RmPlan>("/api/rm-costing/plans") });
}

export function useRmPlan(id: string | undefined) {
  return useQuery({ queryKey: ["rm-plans", id], queryFn: () => api<RmPlan>(`/api/rm-costing/plans/${id}`), enabled: !!id });
}

export function useCreateRmPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; purchaseOrderItemId?: string }) => api<RmPlan>("/api/rm-costing/plans", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rm-plans"] });
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
  });
}

export function useAddRmPlanItem(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { recipeId: string; batchSizeKg: number }) => api<RmPlan>(`/api/rm-costing/plans/${planId}/items`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rm-plans", planId] }),
  });
}

export function useRemoveRmPlanItem(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api<RmPlan>(`/api/rm-costing/plans/${planId}/items/${itemId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rm-plans", planId] }),
  });
}

export function useCalculateRmPlan(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ plan: RmPlan; result: RmPlan["result"] }>(`/api/rm-costing/plans/${planId}/calculate`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rm-plans", planId] }),
  });
}

// Turns a calculated plan's procurement rollup straight into
// Pre-Inventory requirements (S1) — one RM requirement per ingredient.
// The old separate "MPS Pipeline" hooks have been retired along with the
// module — see useTransitionPreProductionStage/useTransitionCombinedLotStage above.

// --- Inventory module ---

export function useInventoryItems(category?: InventoryCategory) {
  return useQuery({
    queryKey: ["inventory", "items", category],
    queryFn: () => api<InventoryItem[]>(`/api/inventory/items${category ? `?category=${category}` : ""}`),
  });
}

export function useCreateInventoryItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { category: InventoryCategory; name: string; unit?: string }) => api<InventoryItem>("/api/inventory/items", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "items"] }),
  });
}

// Pricing/costing — Purchase/Accounts only; the API 403s for every other
// role. See item-pricing.ts on the API side for why GET /items strips
// these fields for everyone else instead of returning them as null.
export function useUpdateInventoryItemPricing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; costPrice?: number | null; mrp?: number | null; purchasePrice?: number | null; salesPrice?: number | null }) =>
      api<InventoryItem>(`/api/inventory/items/${id}/pricing`, { method: "PATCH", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "items"] });
      qc.invalidateQueries({ queryKey: ["inventory", "stock"] });
    },
  });
}

export function useInventoryStock(category?: InventoryCategory, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "stock", category],
    queryFn: () => api<InventoryStockLine[]>(`/api/inventory/stock${category ? `?category=${category}` : ""}`),
    enabled: options?.enabled,
  });
}

// The Stock on Hand tiles over every item (not just the page on screen).
export function useInventoryStockSummary(category?: InventoryCategory, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "stock-summary", category],
    queryFn: () => api<{ itemsTracked: number; negativeStock: number }>(`/api/inventory/stock/summary${category ? `?category=${category}` : ""}`),
    enabled: options?.enabled,
  });
}

export function useFgStock(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "fg-stock"],
    queryFn: () => api<FgStockRow[]>("/api/inventory/fg-stock"),
    enabled: options?.enabled,
  });
}

export function useStoreDashboardSummary(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "dashboard-summary"],
    queryFn: () => api<StoreDashboardSummary>("/api/inventory/dashboard-summary"),
    enabled: options?.enabled,
  });
}

export function useInventoryTransactions(
  filters?: { type?: InventoryTxnType; category?: InventoryCategory; itemId?: string; receiptStatus?: InventoryReceiptStatus },
  options?: { enabled?: boolean },
) {
  const params = new URLSearchParams();
  if (filters?.type) params.set("type", filters.type);
  if (filters?.category) params.set("category", filters.category);
  if (filters?.itemId) params.set("itemId", filters.itemId);
  if (filters?.receiptStatus) params.set("receiptStatus", filters.receiptStatus);
  // Every page - an item's full history (the item detail page) must see
  // everything, not the first 200. The Material ledger tables page through
  // usePagedList instead.
  const qs = params.toString();
  return useQuery({
    queryKey: ["inventory", "transactions", filters],
    queryFn: () => apiAll<InventoryTransaction>(`/api/inventory/transactions${qs ? `?${qs}` : ""}`),
    enabled: options?.enabled,
  });
}

export interface CreateInventoryTransactionPayload {
  itemId: string;
  type: InventoryTxnType;
  date: string;
  unit: string;
  quantity: number;
  size?: string;
  vendorName?: string;
  dayStoreId?: string;
  // Transit tracking — ISSUED_DAY_STORE/ISSUED_PRODUCTION only. See
  // useConfirmDelivery/useTransit below.
  isTransitTracked?: boolean;
  batchNo?: string;
  grnNo?: string;
  mfgDate?: string;
  expiryDate?: string;
  remark?: string;
  // RECEIVED only — see schema.prisma's comment on InventoryTransaction.rate.
  rate?: number;
  invoiceNo?: string;
  invoiceDate?: string;
}

export function useCreateInventoryTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInventoryTransactionPayload) => api<InventoryTransaction>("/api/inventory/transactions", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "transactions"] });
      qc.invalidateQueries({ queryKey: ["inventory", "stock"] });
      qc.invalidateQueries({ queryKey: ["inventory", "vendors"] });
      // The Store dashboard's lists / tiles that read the ledger
      for (const key of ["stock-received", "stock-issued", "quarantine-list", "available-stock", "my-store"]) qc.invalidateQueries({ queryKey: ["inventory", key] });
    },
  });
}

export function useImportInventoryTransactions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { type: InventoryTxnType; rows: ImportInventoryRow[]; dayStoreId?: string; isTransitTracked?: boolean }) =>
      api<{ transactionsCreated: number; itemsCreated: number; dayStoresCreated: number }>("/api/inventory/transactions/import", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "transactions"] });
      qc.invalidateQueries({ queryKey: ["inventory", "stock"] });
      qc.invalidateQueries({ queryKey: ["inventory", "items"] });
      qc.invalidateQueries({ queryKey: ["inventory", "vendors"] });
      qc.invalidateQueries({ queryKey: ["inventory", "day-stores"] });
    },
  });
}

// Item Master import ("SKU Namkaran") — reference data only, no stock
// touched: real code + standardized name for every item, so every other
// module's exact-name lookup (Material Received, Requests, Dispensing)
// resolves to the one real item instead of a naming-drift duplicate.
export function useImportItemMaster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { rows: ImportItemMasterRow[] }) =>
      api<{ itemsCreated: number; itemsUpdated: number; skipped: number; skippedCodes: string[] }>("/api/inventory/items/import-master", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "items"] });
    },
  });
}

// Editing paperwork on an existing entry — GRN No./Batch No./Mfg &
// Expiry Date/Vendor/Remark only, never quantity/item/date/type. See
// updateInventoryTransactionSchema for why those are excluded.
export interface UpdateInventoryTransactionPayload {
  batchNo?: string;
  grnNo?: string;
  mfgDate?: string;
  expiryDate?: string;
  vendorName?: string;
  size?: string;
  remark?: string;
  rate?: number;
  invoiceNo?: string;
  invoiceDate?: string;
}

export function useUpdateInventoryTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateInventoryTransactionPayload & { id: string }) => api<InventoryTransaction>(`/api/inventory/transactions/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "transactions"] });
      qc.invalidateQueries({ queryKey: ["inventory", "vendors"] });
    },
  });
}

export function useDeleteInventoryTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/inventory/transactions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "transactions"] });
      qc.invalidateQueries({ queryKey: ["inventory", "stock"] });
    },
  });
}

export interface InventoryVendors {
  vendors: string[];
  // Whoever most recently supplied this item, when `itemId` was passed — null otherwise.
  suggested: string | null;
}

export function useInventoryVendors(options?: { enabled?: boolean; itemId?: string }) {
  return useQuery({
    queryKey: ["inventory", "vendors", options?.itemId ?? null],
    queryFn: () => api<InventoryVendors>(`/api/inventory/vendors${options?.itemId ? `?itemId=${options.itemId}` : ""}`),
    enabled: options?.enabled,
  });
}

// --- Inward QC gate — a RECEIVED row starts PENDING_QC; QA_QC reviews
// it here, then Store accepts it before it counts toward stock. ---

function invalidateInventoryLedger(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["inventory", "transactions"] });
  qc.invalidateQueries({ queryKey: ["inventory", "stock"] });
  qc.invalidateQueries({ queryKey: ["inventory", "quarantine"] });
  qc.invalidateQueries({ queryKey: ["inventory", "quarantine-list"] });
  qc.invalidateQueries({ queryKey: ["inventory", "stock-received"] });
  qc.invalidateQueries({ queryKey: ["inventory", "stock-issued"] });
  qc.invalidateQueries({ queryKey: ["inventory", "my-store"] });
  qc.invalidateQueries({ queryKey: ["inventory", "available-stock"] });
  // The QC Dashboard's counts/worklist are a live aggregate over this
  // same data — a review made from either place has to refresh both.
  qc.invalidateQueries({ queryKey: ["qc", "dashboard"] });
}

export function useQcReviewTransaction() {
  const qc = useQueryClient();
  return useMutation({
    // samplingDate (yyyy-mm-dd) is required: R&D records when the material was sampled with every inward QC decision.
    mutationFn: ({ id, ...body }: { id: string; action: "APPROVE" | "REJECT" | "HOLD" | "TEST"; samplingDate: string; note?: string }) =>
      api<InventoryTransaction>(`/api/inventory/transactions/${id}/qc`, { method: "PATCH", body }),
    onSuccess: () => invalidateInventoryLedger(qc),
  });
}

export function useAcceptTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<InventoryTransaction>(`/api/inventory/transactions/${id}/accept`, { method: "POST" }),
    onSuccess: () => invalidateInventoryLedger(qc),
  });
}

// Quarantine Store — GET /inventory/quarantine's combined list (awaiting
// first QC + expired-and-not-yet-released), and QA/QC's plain-approve
// release action for the expired half. See inventory.routes.ts's own
// comment on both.
export function useQuarantineStock(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "quarantine"],
    queryFn: () => api<QuarantineRow[]>("/api/inventory/quarantine"),
    enabled: options?.enabled,
  });
}

export function useReleaseExpiry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<InventoryTransaction>(`/api/inventory/transactions/${id}/release-expiry`, { method: "PATCH" }),
    onSuccess: () => invalidateInventoryLedger(qc),
  });
}

// Debit Note Issue — Accounts' paper trail on a QC-rejected Material
// Received row. See POST /inventory/transactions/:id/debit-notes.
export function useRaiseDebitNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      debitNoteNo?: string;
      date?: string;
      quantity: number;
      unit: string;
      amount?: number;
      reason?: string;
    }) => api<InventoryTransaction>(`/api/inventory/transactions/${id}/debit-notes`, { method: "POST", body }),
    onSuccess: () => invalidateInventoryLedger(qc),
  });
}

// --- Material Requests — the department-wise gate: PPIC requests,
// Store approves/rejects/issues. See inventory.routes.ts. ---

export function useInventoryRequests(status?: InventoryRequestStatus, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "requests", status],
    queryFn: () => apiAll<InventoryRequest>(`/api/inventory/requests${status ? `?status=${status}` : ""}`),
    enabled: options?.enabled,
  });
}

export interface CreateInventoryRequestPayload {
  itemId: string;
  category: InventoryCategory;
  requestedQty: number;
  purpose: InventoryRequestPurpose;
  neededBy?: string;
  note?: string;
  plantId?: string;
}

function invalidateRequests(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["inventory", "requests"] });
  qc.invalidateQueries({ queryKey: ["inventory", "transactions"] });
  qc.invalidateQueries({ queryKey: ["inventory", "stock"] });
}

export function useCreateInventoryRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInventoryRequestPayload) => api<InventoryRequest>("/api/inventory/requests", { method: "POST", body }),
    onSuccess: () => invalidateRequests(qc),
  });
}

export function useImportInventoryRequests() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { rows: ImportInventoryRequestRow[] }) => api<{ requestsCreated: number; itemsCreated: number }>("/api/inventory/requests/import", { method: "POST", body }),
    onSuccess: () => invalidateRequests(qc),
  });
}

export function useReviewInventoryRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; action: "APPROVE" | "REJECT"; rejectionReason?: string }) =>
      api<InventoryRequest>(`/api/inventory/requests/${id}/review`, { method: "PATCH", body }),
    onSuccess: () => invalidateRequests(qc),
  });
}

export function useIssueInventoryRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; date: string; unit: string; quantity: number; size?: string; dayStoreId: string | null; isTransitTracked?: boolean }) =>
      api<InventoryTransaction>(`/api/inventory/requests/${id}/issue`, { method: "POST", body }),
    onSuccess: (_data, { isTransitTracked }) => {
      invalidateRequests(qc);
      if (isTransitTracked) qc.invalidateQueries({ queryKey: ["inventory", "transit"] });
    },
  });
}

// --- Material Reconciliation — see GET /inventory/reconciliation. ---

export function useMaterialReconciliation(category?: InventoryCategory, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "reconciliation", category],
    queryFn: () => api<MaterialReconciliationRow[]>(`/api/inventory/reconciliation${category ? `?category=${category}` : ""}`),
    enabled: options?.enabled,
  });
}

// --- Transit — every open shipment across Day Store/Plant transit-
// tracked entries, R&D transfers awaiting confirmation, and Material
// Received rows still in the inward QC queue. See GET /inventory/transit. ---

export function useTransit(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "transit"],
    queryFn: () => api<TransitItem[]>("/api/inventory/transit"),
    enabled: options?.enabled,
    // Live-ish without a full page reload — the whole point of this list
    // is "how long has this been sitting," so a stale number here is
    // more misleading than on most other screens.
    refetchInterval: 60_000,
  });
}

function invalidateTransit(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["inventory", "transit"] });
  qc.invalidateQueries({ queryKey: ["inventory", "transactions"] });
  qc.invalidateQueries({ queryKey: ["inventory", "stock"] });
  qc.invalidateQueries({ queryKey: ["inventory", "day-stores"] });
  qc.invalidateQueries({ queryKey: ["inventory", "plants"] });
}

// receivedQty: what actually arrived, when it is less than was sent (then a note saying why is required).
export function useConfirmDelivery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note, receivedQty }: { id: string; note?: string; receivedQty?: number }) => api<InventoryTransaction>(`/api/inventory/transactions/${id}/confirm-delivery`, { method: "POST", body: { note, receivedQty } }),
    onSuccess: () => invalidateTransit(qc),
  });
}

// The receiver refuses a transit-tracked issue: it goes back to the sender's stock.
export function useRejectDelivery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api(`/api/inventory/transactions/${id}/reject-delivery`, { method: "POST", body: { reason } }),
    onSuccess: () => invalidateTransit(qc),
  });
}

export function useDeleteInventoryRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/inventory/requests/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateRequests(qc),
  });
}

// --- Dispatch transfer log — "FG transfer to Dispatch" / "Bill transfer
// to Dispatch from Accounts" ---

export function useDispatchTransfers(filters?: { type?: DispatchTransferType; customerId?: string; qcStatus?: DispatchQcStatus }, options?: { enabled?: boolean }) {
  const params = new URLSearchParams();
  if (filters?.type) params.set("type", filters.type);
  if (filters?.customerId) params.set("customerId", filters.customerId);
  if (filters?.qcStatus) params.set("qcStatus", filters.qcStatus);
  // Every page, not just the first 200.
  const qs = params.toString();
  return useQuery({
    queryKey: ["inventory", "dispatch-transfers", filters],
    queryFn: () => apiAll<DispatchTransfer>(`/api/inventory/dispatch-transfers${qs ? `?${qs}` : ""}`),
    enabled: options?.enabled,
  });
}

export function useCustomerReconciliationReport(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "reports", "customer-reconciliation"],
    queryFn: () => api<CustomerReconciliationRow[]>("/api/inventory/reports/customer-reconciliation"),
    enabled: options?.enabled,
  });
}

// Outward QC gate — FG rows only; BILL rows have no qcStatus.
export function useQcReviewDispatchTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; action: "APPROVE" | "REJECT" | "HOLD"; note?: string }) =>
      api<DispatchTransfer>(`/api/inventory/dispatch-transfers/${id}/qc`, { method: "PATCH", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "dispatch-transfers"] });
      qc.invalidateQueries({ queryKey: ["qc", "dashboard"] });
    },
  });
}

// --- QC Dashboard — read-only aggregate over every QC checkpoint in the
// app; every actual review action still happens where it already did
// (useQcReviewTransaction/useQcReviewDispatchTransfer above, or a
// batch's own stage PATCH), so this just needs to be re-fetched whenever
// any of those succeed — invalidated alongside the ledger/dispatch/batch
// query keys those hooks already touch. ---
export function useQcDashboard(options?: { enabled?: boolean }) {
  return useQuery({ queryKey: ["qc", "dashboard"], queryFn: () => api<QcDashboard>("/api/qc/dashboard"), enabled: options?.enabled });
}

export interface CreateDispatchTransferPayload {
  type: DispatchTransferType;
  date: string;
  customerId: string;
  productName: string;
  quantity: number;
  sourceRequestId?: string;
  plantId?: string;
}

export function useCreateDispatchTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDispatchTransferPayload) => api<DispatchTransfer>("/api/inventory/dispatch-transfers", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "dispatch-transfers"] }),
  });
}

export function useImportDispatchTransfers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { type: DispatchTransferType; rows: ImportDispatchTransferRow[] }) =>
      api<{ transfersCreated: number; unknownCustomers: string[] }>("/api/inventory/dispatch-transfers/import", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "dispatch-transfers"] }),
  });
}

export function useDeleteDispatchTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/inventory/dispatch-transfers/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "dispatch-transfers"] }),
  });
}

// S9 — Dispatch confirms the shipment actually went out; Finance
// (Accounts) then raises the invoice. Both FG-only, both one-shot.
export function useConfirmDispatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, dispatchNote }: { id: string; dispatchNote?: string }) =>
      api<DispatchTransfer>(`/api/inventory/dispatch-transfers/${id}/dispatch`, { method: "PATCH", body: { dispatchNote } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "dispatch-transfers"] }),
  });
}

export function useInvoiceDispatchTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, invoiceNumber }: { id: string; invoiceNumber: string }) =>
      api<DispatchTransfer>(`/api/inventory/dispatch-transfers/${id}/invoice`, { method: "PATCH", body: { invoiceNumber } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "dispatch-transfers"] }),
  });
}

// --- Day Stores / Plants — named, growable identities Store/Admin can
// add to. See locations.routes.ts. ---

export function useDayStores(options?: { enabled?: boolean }) {
  return useQuery({ queryKey: ["inventory", "day-stores"], queryFn: () => api<DayStore[]>("/api/inventory/day-stores"), enabled: options?.enabled });
}

export function useCreateDayStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<DayStore>("/api/inventory/day-stores", { method: "POST", body: { name } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "day-stores"] }),
  });
}

export function useRenameDayStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api<DayStore>(`/api/inventory/day-stores/${id}`, { method: "PATCH", body: { name } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "day-stores"] });
      // Every transaction/request list that shows a Day Store's name
      // needs to pick up the new name too, not just the picker list.
      qc.invalidateQueries({ queryKey: ["inventory", "transactions"] });
      qc.invalidateQueries({ queryKey: ["inventory", "requests"] });
    },
  });
}

// --- Store assignment — which STORE users are scoped to which store(s).
// See DayStoreAssignment in schema.prisma / day-store-access.ts. ---

export function useDayStoreAssignments(dayStoreId: string | undefined) {
  return useQuery({
    queryKey: ["inventory", "day-stores", dayStoreId, "assignments"],
    queryFn: () => api<DayStoreAssignment[]>(`/api/inventory/day-stores/${dayStoreId}/assignments`),
    enabled: !!dayStoreId,
  });
}

// The assignable pool — every user holding the STORE role. Shared across
// every store's assignment picker, so it's one cached query, not
// refetched per store.
export function useStoreUsers() {
  return useQuery({ queryKey: ["inventory", "day-stores", "store-users"], queryFn: () => api<StoreUser[]>("/api/inventory/day-stores/store-users") });
}

export function useAssignDayStoreUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ dayStoreId, userId }: { dayStoreId: string; userId: string }) =>
      api<DayStoreAssignment>(`/api/inventory/day-stores/${dayStoreId}/assignments`, { method: "POST", body: { userId } }),
    onSuccess: (_data, { dayStoreId }) => qc.invalidateQueries({ queryKey: ["inventory", "day-stores", dayStoreId, "assignments"] }),
  });
}

export function useUnassignDayStoreUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ dayStoreId, userId }: { dayStoreId: string; userId: string }) =>
      api<void>(`/api/inventory/day-stores/${dayStoreId}/assignments/${userId}`, { method: "DELETE" }),
    onSuccess: (_data, { dayStoreId }) => qc.invalidateQueries({ queryKey: ["inventory", "day-stores", dayStoreId, "assignments"] }),
  });
}

// Real-time balance for one Day Store — see locations.routes.ts
// GET /:id/stock. Disabled until a store is actually picked.
export function useDayStoreStock(dayStoreId: string | undefined, category?: InventoryCategory) {
  return useQuery({
    queryKey: ["inventory", "day-stores", dayStoreId, "stock", category],
    queryFn: () => api<{ dayStore: DayStore; stock: DayStoreStockLine[] }>(`/api/inventory/day-stores/${dayStoreId}/stock${category ? `?category=${category}` : ""}`),
    enabled: !!dayStoreId,
  });
}

// Real-time balance for one Plant — see locations.routes.ts
// GET /plants/:id/stock. Same shape/usage as useDayStoreStock above.
export function usePlantStock(plantId: string | undefined, category?: InventoryCategory) {
  return useQuery({
    queryKey: ["inventory", "plants", plantId, "stock", category],
    queryFn: () => api<{ plant: Plant; stock: PlantStockLine[] }>(`/api/inventory/plants/${plantId}/stock${category ? `?category=${category}` : ""}`),
    enabled: !!plantId,
  });
}

export function usePlants() {
  return useQuery({ queryKey: ["inventory", "plants"], queryFn: () => api<Plant[]>("/api/inventory/plants") });
}

export function useCreatePlant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<Plant>("/api/inventory/plants", { method: "POST", body: { name } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "plants"] }),
  });
}

export function useRenamePlant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api<Plant>(`/api/inventory/plants/${id}`, { method: "PATCH", body: { name } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "plants"] });
      qc.invalidateQueries({ queryKey: ["inventory", "transactions"] });
      qc.invalidateQueries({ queryKey: ["inventory", "requests"] });
      qc.invalidateQueries({ queryKey: ["inventory", "dispatch-transfers"] });
    },
  });
}

// RM Warehouse / PM Warehouse — always exactly two rows (one per
// InventoryCategory), no create/delete. Its "stock" is just
// useInventoryStock(warehouse.category) — a Warehouse doesn't get its own
// on-hand endpoint since it's nothing more than the existing category
// filter given a real, renameable name. See warehouses.routes.ts.
export function useWarehouses() {
  return useQuery({ queryKey: ["inventory", "warehouses"], queryFn: () => api<Warehouse[]>("/api/inventory/warehouses") });
}

export function useRenameWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api<Warehouse>(`/api/inventory/warehouses/${id}`, { method: "PATCH", body: { name } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "warehouses"] }),
  });
}

// --- Pre-Inventory — S1-S4: PPIC states a requirement, Warehouse says
// what's available, Purchase logs a PO for the shortfall, Finance reads
// the resulting vendor list. See pre-inventory.routes.ts. ---

export function usePreInventoryRequirements(filters?: { category?: InventoryCategory; short?: boolean }, options?: { enabled?: boolean }) {
  const params = new URLSearchParams();
  if (filters?.category) params.set("category", filters.category);
  if (filters?.short) params.set("short", "true");
  // Every page - the Download Report button and the PO-aging report need the
  // whole list, not the first 200.
  const qs = params.toString();
  return useQuery({
    queryKey: ["pre-inventory", "requirements", filters],
    queryFn: () => apiAll<PreInventoryRequirement>(`/api/inventory/requirements${qs ? `?${qs}` : ""}`),
    enabled: options?.enabled,
  });
}

export interface CreateRequirementPayload {
  date: string;
  category: InventoryCategory;
  itemId: string;
  unit: string;
  requiredQty: number;
  size?: string;
  note?: string;
  // The customer PO product this requirement is for (optional).
  purchaseOrderItemId?: string;
}

function invalidateRequirements(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["pre-inventory", "requirements"] });
}

export function useCreateRequirement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRequirementPayload) => api<PreInventoryRequirement>("/api/inventory/requirements", { method: "POST", body }),
    onSuccess: () => invalidateRequirements(qc),
  });
}

// PPIC's own explicit "Send to Purchase" — a shortfall existing isn't
// reason enough for the system to notify Purchase on its own any more;
// PPIC decides when it's worth raising. See pre-inventory.routes.ts's
// POST /:id/notify-purchase.
export function useNotifyPurchase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<PreInventoryRequirement>(`/api/inventory/requirements/${id}/notify-purchase`, { method: "POST" }),
    onSuccess: () => invalidateRequirements(qc),
  });
}

export function useImportRequirements() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { rows: ImportRequirementRow[] }) => api<{ requirementsCreated: number; itemsCreated: number }>("/api/inventory/requirements/import", { method: "POST", body }),
    onSuccess: () => invalidateRequirements(qc),
  });
}

export function useSetRequirementPurchase() {
  const qc = useQueryClient();
  return useMutation({
    // `quantity` adds a PI line for that much of the shortfall; without it the PI covers everything
    // still to log (or corrects the latest line when the requirement already has some).
    mutationFn: ({ id, ...body }: { id: string; poNumber: string; vendorName: string; eta: string; quantity?: number }) =>
      api<PreInventoryRequirement>(`/api/inventory/requirements/${id}/purchase`, { method: "PATCH", body }),
    onSuccess: () => {
      invalidateRequirements(qc);
      qc.invalidateQueries({ queryKey: ["inventory", "vendors"] });
    },
  });
}

// The receipts (batch, GRN, mfg / expiry date, qty received) behind one item - the Available Stock row's expand.
// With `period`, only the deliveries QC accepted between those receipt dates (the stock report Received column).
export function useItemBatches(itemId: string | null, period?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: ["inventory", "available-stock", "batches", itemId, period?.from ?? "", period?.to ?? ""],
    queryFn: () => api<import("./inventoryExport").ItemBatch[]>(`/api/inventory/available-stock/batches?itemId=${itemId}${period ? `&accepted=1${period.from ? `&from=${period.from}` : ""}${period.to ? `&to=${period.to}` : ""}` : ""}`),
    enabled: !!itemId,
    staleTime: 30_000,
  });
}

// The Store dashboard's first tile: how many RM / PM items have stock somewhere.
export function useAvailableStockSummary(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "available-stock", "summary"],
    queryFn: () => api<{ itemsInStock: number; rmItems: number; pmItems: number; locations: number }>("/api/inventory/available-stock/summary"),
    enabled: options?.enabled,
    staleTime: 15_000,
  });
}

// --- Material requests: Day Stores / R&D asking the Warehouse, and the short -> PPIC -> Purchase trail. ---

export function useMaterialRequestsSummary(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "material-requests", "summary"],
    queryFn: () => api<{ open: number; dayStore: number; rnd: number; plan: number; planOverdue: number }>("/api/inventory/material-requests/summary"),
    enabled: options?.enabled,
    staleTime: 15_000,
  });
}

export function useEscalateMaterialRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ source, id }: { source: "store" | "rnd"; id: string }) => api<{ requirementId: string }>(`/api/inventory/material-requests/${source}/${id}/escalate`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "material-requests"] });
      qc.invalidateQueries({ queryKey: ["pre-inventory"] });
    },
  });
}

export function useCreateStoreRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { itemId: string; requestedQty: number; neededBy?: string; note?: string; dayStoreId?: string }) => api<{ id: string }>("/api/inventory/my-store/requests", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "my-store"] });
      qc.invalidateQueries({ queryKey: ["inventory", "material-requests"] });
    },
  });
}

// A Day Store login: which store(s) it is limited to (scoped=false for the Warehouse-side Store seat).
export function useMyStoreInfo(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "my-store", "info"],
    queryFn: () => api<{ scoped: boolean; stores: { id: string; name: string; plantId: string | null; plantName: string | null }[] }>("/api/inventory/my-store/info"),
    enabled: options?.enabled,
    staleTime: 60_000,
  });
}

// A Day Store dashboard's tiles: entries received from the Warehouse, entries issued on to its Plant.
export function useMyStoreSummary(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "my-store", "summary"],
    queryFn: () => api<{ received: number; issuedToPlant: number; requests: number; productionRequests: number; productsCovered: number; productsShort: number }>("/api/inventory/my-store/summary"),
    enabled: options?.enabled,
    staleTime: 15_000,
  });
}

// New Plans: products PPIC sent to Production whose run has not started - ready-filled from the PO.
export interface NewPlan {
  itemId: string;
  poId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  productCategory: string | null;
  productType: "EXISTING" | "NEW";
  quantity: number;
  unit: string;
  volume: number | null;
  packSize: string | null;
  plant: { id: string; name: string } | null;
  sentAt: string;
  // How much of the order PPIC has released to Production (less than `quantity` = a partial release).
  releasedQty: number;
  // Set once Production has started the run (status "running").
  run: { id: string; currentStageId: string; plannedQty: number; combinedQty: number } | null;
}

export function useNewPlans(options?: { enabled?: boolean; status?: "new" | "running" }) {
  const status = options?.status ?? "new";
  return useQuery({
    queryKey: ["pre-productions", "new-plans", status],
    queryFn: () => api<NewPlan[]>(`/api/pre-productions/new-plans${status === "running" ? "?status=running" : ""}`),
    enabled: options?.enabled,
    staleTime: 15_000,
  });
}

// The New Plan page's list: every plan PPIC sent to Production (run started or not), with the run, its batches (shift / manpower /
// times) and, per batch, the Material Utilization: A used in production, B wastage, C rejected, D sample, E returned to store.
export interface BoardMaterial {
  itemId: string;
  itemName: string;
  category: string;
  unit: string;
  consumedQty: number;
  wastedQty: number;
  rejectedQty: number;
  sampleQty: number;
  returnedQty: number;
}

export interface BoardBatch {
  id: string;
  batchNo: string | null;
  status: "IN_PROGRESS" | "COMPLETED";
  prepStageId: BatchPrepStageId;
  plannedQty: number;
  inputQty: number | null;
  outputQty: number | null;
  shift: "Day" | "Night" | null;
  manpowerCount: number | null;
  shiftStartAt: string | null;
  shiftEndAt: string | null;
  materials: BoardMaterial[];
}

export interface PlanBoardRow {
  itemId: string;
  poId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  productCategory: string | null;
  productType: "EXISTING" | "NEW";
  quantity: number;
  releasedQty: number;
  unit: string;
  plant: { id: string; name: string } | null;
  sentAt: string;
  /** Production closed the product short: it ends at `qty`, not at the ordered quantity. */
  closedShort: { at: string; qty: number | null; reason: string | null } | null;
  run: { id: string; currentStageId: string; sampleQcStatus: string | null; batchFlow: boolean; plannedQty: number; combinedQty: number } | null;
  batches: BoardBatch[];
  // Usage logged for the run without a batch (older entries, or logged for the run as a whole)
  unassigned: BoardMaterial[];
}

// R&D's Received Material: its requests to the Warehouse and the receipt of what was issued.
export interface ReceivedMaterialVendor {
  vendorName: string | null;
  batchNo: string | null;
  grnNo: string | null;
  mfgDate: string | null;
  expiryDate: string | null;
  quantity: number;
  unit: string;
  receivedAt: string;
}

export type ReceivedMaterialStatus = "REQUESTED" | "ISSUED" | "RECEIVED" | "REJECTED" | "CANCELLED";

export interface ReceivedMaterialRow {
  key: string;
  requestId: string | null;
  transferId: string | null;
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  quantity: number;
  unit: string;
  note: string | null;
  status: ReceivedMaterialStatus;
  requestedAt: string;
  requestedByName: string | null;
  issuedAt: string | null;
  issuedByName: string | null;
  receivedAt: string | null;
  receivedByName: string | null;
  rejectionReason: string | null;
  vendors: ReceivedMaterialVendor[];
  warehouseOnHand: number;
}

export function useReceivedMaterial(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["rnd-store", "received-material"],
    queryFn: () => api<ReceivedMaterialRow[]>("/api/rnd-store/received-material"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

export function useRndItemInfo(itemId: string | null) {
  return useQuery({
    queryKey: ["rnd-store", "item-info", itemId],
    queryFn: () => api<{ id: string; name: string; category: "RM" | "PM"; unit: string | null; warehouseOnHand: number; vendors: ReceivedMaterialVendor[] }>(`/api/rnd-store/item-info/${itemId}`),
    enabled: !!itemId,
  });
}

// R&D's Material Utilization: per material that reached the R&D Store, what became of it.
export interface RndUtilizationLot {
  id: string;
  receivedAt: string;
  quantity: number;
  unit: string;
  source: "Warehouse" | "Direct purchase";
  vendorName: string | null;
  invoiceNo: string | null;
  batchNo: string | null;
  expiryDate: string | null;
}

export interface RndUtilizationLog {
  id: string;
  kind: "TESTING" | "FORMULATION_TRIAL" | "WASTAGE" | "REJECTED" | "CUSTOMER_SAMPLE" | "RETURN";
  quantity: number;
  unit: string;
  date: string;
  projectName: string | null;
  formulationRef: string | null;
  batchNo: string | null;
  customerName: string | null;
  brandName: string | null;
  note: string | null;
}

export interface RndUtilizationRow {
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  receivedQty: number;
  firstReceivedAt: string | null;
  lastReceivedAt: string | null;
  lots: RndUtilizationLot[];
  warehouseVendors: ReceivedMaterialVendor[];
  testingQty: number;
  formulationQty: number;
  customerSampleQty: number;
  rejectedQty: number;
  returnedQty: number;
  wastageQty: number;
  stockQty: number;
  log: RndUtilizationLog[];
}

export function useRndUtilization(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["rnd-store", "utilization"],
    queryFn: () => api<RndUtilizationRow[]>("/api/rnd-store/utilization"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

// R&D's Return Material: what R&D sent back to the Warehouse and whether the Warehouse has confirmed it.
export type RndReturnStatus = "SENT" | "RETURNED";
export interface RndReturnRow {
  id: string;
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  quantity: number;
  unit: string;
  reason: string | null;
  status: RndReturnStatus;
  sentAt: string;
  sentByName: string | null;
  returnedAt: string | null;
  confirmedByName: string | null;
  rndOnHand: number;
  warehouseOnHand: number;
  vendors: ReceivedMaterialVendor[];
}

export function useRndReturns(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["rnd-store", "returns"],
    queryFn: () => api<RndReturnRow[]>("/api/rnd-store/returns"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

// R&D's Quarantine: material received that is not usable stock (not approved yet, rejected, or expired).
export type RndQuarantineReason = "PENDING_QC" | "TESTING" | "ON_HOLD" | "REJECTED" | "EXPIRED";
export interface RndQuarantineRow {
  id: string;
  vendorName: string | null;
  itemName: string;
  category: "RM" | "PM";
  quantity: number;
  rejectedQty: number | null;
  unit: string;
  batchNo: string | null;
  grnNo: string | null;
  invoiceNo: string | null;
  receivedAt: string;
  samplingDate: string | null;
  expiryDate: string | null;
  reason: RndQuarantineReason;
  statusAt: string | null;
  note: string | null;
}

export function useRndQuarantine(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "new-material", "quarantine"],
    queryFn: () => api<RndQuarantineRow[]>("/api/inventory/new-material/quarantine"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

// R&D's New Material list: what the Warehouse received from vendors and where it stands in R&D's inward QC.
export type NewMaterialStatus = "PENDING_QC" | "TESTING" | "ON_HOLD" | "ACCEPTED" | "QC_REJECTED" | "QC_APPROVED";
export interface NewMaterialRow {
  id: string;
  vendorName: string | null;
  itemName: string;
  category: "RM" | "PM";
  quantity: number;
  unit: string;
  batchNo: string | null;
  grnNo: string | null;
  invoiceNo: string | null;
  receivedAt: string;
  samplingDate: string | null;
  status: NewMaterialStatus;
  /** When the status was last set (what Aging runs to). Null while still pending. */
  statusAt: string | null;
  note: string | null;
}

export function useNewMaterial(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "new-material"],
    queryFn: () => api<NewMaterialRow[]>("/api/inventory/new-material"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

// Production's Handover page: batches whose manufacturing is complete, and where each is on its way to Dispatch.
export interface HandoverRow {
  batchId: string;
  batchNo: string | null;
  itemId: string;
  poId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  productCategory: string | null;
  unit: string;
  plant: { id: string; name: string } | null;
  currentStageId: string;
  packagingStatus: string | null;
  outputQty: number | null;
  packedQty: number | null;
  dispatchedQty: number;
  completedAt: string | null;
  fgStoreAt: string | null;
  handedOverAt: string | null;
}

export function useHandoverBoard(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["production-batches", "handover-board"],
    queryFn: () => api<HandoverRow[]>("/api/production-batches/handover-board"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

export function useHandOverBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => api(`/api/production-batches/${batchId}/handover`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-batches"] });
      qc.invalidateQueries({ queryKey: ["pre-productions"] });
    },
  });
}

// Production's "Material Received" page: one row per product and material of its plan.
// NOT_DISPENSED: the Day Store has not dispensed this material to Production yet (Production sees material only after Dispensing).
export type MaterialBoardStatus = "NOT_DISPENSED" | "NOT_RECEIVED" | "IN_TRANSIT" | "PARTIAL" | "FULL" | "NOT_IN_CATALOG";

export interface MaterialBoardRow {
  itemId: string;
  poId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  productCategory: string | null;
  plant: { id: string; name: string } | null;
  releasedQty: number;
  orderQty: number;
  productUnit: string;
  material: string;
  category: "RM" | "PM";
  unit: string;
  requiredQty: number;
  receivedQty: number;
  inTransitQty: number;
  balanceQty: number;
  usedQty: number;
  leftQty: number;
  availableQty: number | null;
  status: MaterialBoardStatus;
  sentAt: string;
  // Only on the batch-wise lines (a batch of a run that works batch by batch): which batch, and what went to waste / rejected / sample.
  batchId?: string;
  batchNo?: string | null;
  batchQty?: number;
  prepStageId?: string;
  batchStatus?: string;
  wastedQty?: number;
  rejectedQty?: number;
  sampleQty?: number;
}

// Production's Indent Issue tile: runs waiting at Indent Issue, with the plan's materials (nothing is typed per material).
export interface IndentBoardRow {
  id: string;
  purchaseOrderItemId: string;
  poId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  productCategory: string | null;
  plantName: string | null;
  orderQty: number;
  releasedQty: number;
  productUnit: string;
  grnNo: string | null;
  grnDate: string | null;
  prodIndentSlipSign: string | null;
  productionPlanDate: string | null;
  dispatchPlanDate: string | null;
  unit: string | null;
  waitingSince: string;
  materials: MaterialCoverageLine[];
  allCovered: boolean;
}

export function useIndentBoard(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["pre-productions", "indent-board"],
    queryFn: () => api<IndentBoardRow[]>("/api/pre-productions/indent-board"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

export function useForwardIndent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...fields }: { id: string; prodIndentSlipSign: string; productionPlanDate?: string; dispatchPlanDate?: string; unit?: string }) =>
      api<PreProduction>(`/api/pre-productions/${id}/stage`, { method: "PATCH", body: { action: "FORWARD", ...fields } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pre-productions"] }),
  });
}

// The Day Store's tiles: runs at Material Received & GRN, or at Dispensing, at the logged-in Day Store's Plant.
export interface StoreBoardRequired {
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  requiredQty: number;
  consumedQty: number;
  covered: boolean;
  dayStoreQty: number;
  plantQty: number;
}
export interface StoreBoardRow {
  id: string;
  purchaseOrderItemId: string;
  poId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  productCategory: string | null;
  plantName: string | null;
  orderQty: number;
  releasedQty: number;
  productUnit: string;
  grnNo: string | null;
  grnDate: string | null;
  materialReceivedRemarks: string | null;
  prodIndentSlipSign: string | null;
  rmDispensingDate: string | null;
  pmIssuedDate: string | null;
  rmDispensingRemarks: string | null;
  pmDispensingRemarks: string | null;
  waitingSince: string;
  materials: MaterialCoverageLine[];
  allCovered: boolean;
  required: StoreBoardRequired[];
}
export type StoreBoardStage = "MATERIAL_RECEIVED" | "DISPENSING";

export function useStoreBoard(stage: StoreBoardStage, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["pre-productions", "store-board", stage],
    queryFn: () => api<StoreBoardRow[]>(`/api/pre-productions/store-board?stage=${stage}`),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

// Moves a run one stage forward with that stage's fields (GRN, or the dispensing lines). A short Dispensing saves what was logged and
// stays put; `dispensingShortfall` lists what is still to dispense.
export function useStoreStageForward() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      api<PreProduction & { dispensingShortfall?: { itemName: string; requiredQty: number; consumedQty: number; unit: string }[] }>(`/api/pre-productions/${id}/stage`, { method: "PATCH", body: { action: "FORWARD", ...body } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pre-productions"] }),
  });
}

// legacyOnly: leave out the products whose run works batch by batch (the batch-wise board lists those).
export function useMaterialBoard(options?: { enabled?: boolean; legacyOnly?: boolean }) {
  return useQuery({
    queryKey: ["pre-productions", "material-board", options?.legacyOnly ? "legacy" : "all"],
    queryFn: () => api<MaterialBoardRow[]>(`/api/pre-productions/material-board${options?.legacyOnly ? "?legacyOnly=1" : ""}`),
    enabled: options?.enabled,
    staleTime: 15_000,
  });
}

/** Material Received, batch by batch: one line per batch and material of its plan. */
export function useBatchMaterialBoard(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["production-batches", "material-board"],
    queryFn: () => api<MaterialBoardRow[]>("/api/production-batches/material-board"),
    enabled: options?.enabled,
    staleTime: 15_000,
  });
}

export function usePlansBoard(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["pre-productions", "plans-board"],
    queryFn: () => api<PlanBoardRow[]>("/api/pre-productions/plans-board"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

// The Store dashboard's Stock Issued tile: how many issue entries the Warehouse has made.
export function useStockIssuedSummary(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "stock-issued", "summary"],
    queryFn: () => api<{ total: number }>("/api/inventory/stock-issued/summary"),
    enabled: options?.enabled,
    staleTime: 15_000,
  });
}

// The Store dashboard's Stock Received tile: how many vendor deliveries the Warehouse has taken in.
export function useStockReceivedSummary(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "stock-received", "summary"],
    queryFn: () => api<{ total: number }>("/api/inventory/stock-received/summary"),
    enabled: options?.enabled,
    staleTime: 15_000,
  });
}

// The Incoming Material tile: PI lines still to arrive, how many are late / due within a week.
export function useIncomingSummary(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["pre-inventory", "requirements", "incoming-summary"],
    queryFn: () => api<{ lines: number; materials: number; overdue: number; dueThisWeek: number }>("/api/inventory/requirements/incoming/summary"),
    enabled: options?.enabled,
    staleTime: 15_000,
  });
}

// Edit one logged PI line (PI Number / Vendor / ETA, and its quantity within the shortfall).
export function useUpdatePurchaseLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ requirementId, lineId, ...body }: { requirementId: string; lineId: string; poNumber: string; vendorName: string; eta: string; quantity?: number }) =>
      api<PreInventoryRequirement>(`/api/inventory/requirements/${requirementId}/lines/${lineId}`, { method: "PATCH", body }),
    onSuccess: () => {
      invalidateRequirements(qc);
      qc.invalidateQueries({ queryKey: ["inventory", "vendors"] });
    },
  });
}

// Remove a PI line (only while nothing of it has arrived).
export function useDeletePurchaseLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ requirementId, lineId }: { requirementId: string; lineId: string }) => api<PreInventoryRequirement>(`/api/inventory/requirements/${requirementId}/lines/${lineId}`, { method: "DELETE" }),
    onSuccess: () => invalidateRequirements(qc),
  });
}

export function useImportPurchaseLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { rows: ImportPurchaseLogRow[] }) => api<{ posLogged: number; unmatched: string[] }>("/api/inventory/requirements/purchase/import", { method: "POST", body }),
    onSuccess: () => {
      invalidateRequirements(qc);
      qc.invalidateQueries({ queryKey: ["inventory", "vendors"] });
    },
  });
}

export function useDeleteRequirement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/inventory/requirements/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateRequirements(qc),
  });
}

// --- User management (admin only) ---

export function useUsers() {
  return useQuery({ queryKey: ["users"], queryFn: () => apiAll<ManagedUser>("/api/users") });
}

/** Creates a login. The department admin gets it in his own department; the System Admin picks the department. */
export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    // The admin types the login ID and the password; the server makes the account (in the admin's own department, or any for the System Admin).
    mutationFn: (body: { fullName: string; loginId: string; password: string; email?: string; role?: RoleName }) => api<ManagedUser>("/api/users", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useGrantRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: RoleName }) => api(`/api/users/${userId}/roles`, { method: "POST", body: { role } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useRevokeRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: RoleName }) => api(`/api/users/${userId}/roles/${role}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useSetUserActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, isActive }: { userId: string; isActive: boolean }) => api(`/api/users/${userId}`, { method: "PATCH", body: { isActive } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

// fullName, login ID and/or email — same PATCH /:userId (see users.routes.ts).
// A login ID or email change bumps the target's tokenVersion server-side, so
// their existing session (if any) stops working immediately.
export function useRenameUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, fullName, email, loginId }: { userId: string; fullName?: string; email?: string; loginId?: string }) => api(`/api/users/${userId}`, { method: "PATCH", body: { fullName, email, loginId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

/** System Admin only: makes a person the one admin of a department (the earlier one is replaced), or takes it away. */
export function useSetDeptAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role, isDeptAdmin }: { userId: string; role: RoleName; isDeptAdmin: boolean }) => api(`/api/users/${userId}/dept-admin`, { method: "PATCH", body: { role, isDeptAdmin } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

// --- System Health / Audit Log — Admin-only, see system.routes.ts. ---

export function useSystemHealth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["system", "health"],
    queryFn: () => api<SystemHealth>("/api/system/health"),
    enabled: options?.enabled,
    refetchOnWindowFocus: false,
  });
}

// Same "request the server's 200-row max, no real page-by-page UI" shape
// every other list hook in this app uses (see inventory.routes.ts's own
// comments on this) — narrow with the filters instead of paging back.
export function useAuditLog(filters?: { action?: string; entityType?: string; actorId?: string }, options?: { enabled?: boolean }) {
  const params = new URLSearchParams();
  if (filters?.action) params.set("action", filters.action);
  if (filters?.entityType) params.set("entityType", filters.entityType);
  if (filters?.actorId) params.set("actorId", filters.actorId);
  params.set("pageSize", "200");
  return useQuery({
    queryKey: ["system", "audit-log", filters],
    queryFn: () => api<AuditLogEntry[]>(`/api/system/audit-log?${params.toString()}`),
    enabled: options?.enabled,
  });
}

export function useResetPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, newPassword }: { userId: string; newPassword: string }) => api(`/api/users/${userId}/reset-password`, { method: "POST", body: { newPassword } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

// --- Notifications ---

interface NotificationsResponse {
  notifications: AppNotification[];
  unreadCount: number;
}

// Polls every 30s so the bell badge stays current without a websocket —
// cheap enough given the payload is capped at 30 rows, and matches the
// "good enough" freshness bar the rest of the app uses.
export function useNotifications() {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () => api<NotificationsResponse>("/api/notifications"),
    refetchInterval: 30_000,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<AppNotification>(`/api/notifications/${id}/read`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ markedRead: number }>("/api/notifications/read-all", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

// --- Recycle Bin (Admin only) ---

export function useRecycleBin(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["recycle-bin"],
    queryFn: () => api<RecycleBinRow[]>("/api/recycle-bin"),
    enabled: options?.enabled,
  });
}

export function useRestoreFromRecycleBin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ entityType, id }: { entityType: RecycleBinEntityType; id: string }) => api(`/api/recycle-bin/${entityType}/${id}/restore`, { method: "POST" }),
    onSuccess: () => {
      // Broad invalidation on purpose — a restored row can affect almost
      // any list/stock number in the app depending on which of the nine
      // entity types it was, and this action is rare enough that a full
      // refetch costs nothing compared to guessing wrong about scope.
      qc.invalidateQueries();
    },
  });
}

// --- R&D Store — Warehouse<->R&D sample transfers + R&D's own
// consume/dispatch/report, see rnd-store.routes.ts. ---

function invalidateRndStore(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["rnd-store"] });
  // A transfer/consume/dispatch also moves the Warehouse-side ledger
  // (ISSUED_RND / isRndReturn) or the Warehouse's own /stock view.
  qc.invalidateQueries({ queryKey: ["inventory"] });
}

export function useRndTransfers(status?: "PENDING" | "CONFIRMED", options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["rnd-store", "transfers", status ?? null],
    queryFn: () => api<RndTransfer[]>(`/api/rnd-store/transfers${status ? `?status=${status}` : ""}`),
    enabled: options?.enabled ?? true,
  });
}

// TO_WAREHOUSE only in practice — Store can no longer push TO_RND
// directly (403 for non-ADMIN); that side now goes through the sample
// request flow below (R&D asks, Store fulfills).
export function useCreateRndTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { direction: RndTransferDirection; itemId: string; quantity: number; unit: string; note?: string }) =>
      api<RndTransfer>("/api/rnd-store/transfers", { method: "POST", body }),
    onSuccess: () => invalidateRndStore(qc),
  });
}

export function useRndSampleRequests(status?: RndSampleRequestStatus, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["rnd-store", "requests", status ?? null],
    queryFn: () => api<RndSampleRequest[]>(`/api/rnd-store/requests${status ? `?status=${status}` : ""}`),
    enabled: options?.enabled ?? true,
  });
}

export function useImportRndSampleRequests() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { rows: ImportRndSampleRequestRow[] }) => api<{ requestsCreated: number; itemsCreated: number }>("/api/rnd-store/requests/import", { method: "POST", body }),
    onSuccess: () => invalidateRndStore(qc),
  });
}

export function useCreateRndSampleRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { itemId: string; quantity: number; unit: string; note?: string; sampleRequestId?: string }) => api<RndSampleRequest>("/api/rnd-store/requests", { method: "POST", body }),
    onSuccess: () => invalidateRndStore(qc),
  });
}

export function useFulfillRndSampleRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<RndSampleRequest>(`/api/rnd-store/requests/${id}/fulfill`, { method: "POST" }),
    onSuccess: () => invalidateRndStore(qc),
  });
}

export function useRejectRndSampleRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api<RndSampleRequest>(`/api/rnd-store/requests/${id}/reject`, { method: "POST", body: { reason } }),
    onSuccess: () => invalidateRndStore(qc),
  });
}

export function useCancelRndSampleRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<RndSampleRequest>(`/api/rnd-store/requests/${id}/cancel`, { method: "POST" }),
    onSuccess: () => invalidateRndStore(qc),
  });
}

export function useConfirmRndTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (arg: string | { id: string; receivedQty?: number; note?: string }) => {
      const { id, ...body } = typeof arg === "string" ? { id: arg } : arg;
      return api<RndTransfer>(`/api/rnd-store/transfers/${id}/confirm`, { method: "POST", body });
    },
    onSuccess: () => invalidateRndStore(qc),
  });
}

// The receiver refuses a transfer (the material goes back to the sender), or the sender takes back one nobody has confirmed yet.
export function useRejectRndTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api(`/api/rnd-store/transfers/${id}/reject`, { method: "POST", body: { reason } }),
    onSuccess: () => invalidateRndStore(qc),
  });
}

export function useCancelRndTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/rnd-store/transfers/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateRndStore(qc),
  });
}

export function useConsumeAtRnd() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { itemId: string; quantity: number; unit: string; reason: RndConsumeReason; date?: string; projectName?: string; formulationRef?: string; batchNo?: string; note?: string }) =>
      api<RndStoreTransaction>("/api/rnd-store/consume", { method: "POST", body }),
    onSuccess: () => invalidateRndStore(qc),
  });
}

export function useDispatchRndToCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { itemId: string; quantity: number; unit: string; customerId: string; brandName?: string; date?: string; courierDetails?: string; note?: string }) =>
      api<RndStoreTransaction>("/api/rnd-store/dispatch", { method: "POST", body }),
    onSuccess: () => invalidateRndStore(qc),
  });
}

export function useRndStoreStock() {
  return useQuery({ queryKey: ["rnd-store", "stock"], queryFn: () => api<RndStoreStockRow[]>("/api/rnd-store/stock") });
}

export function useRndStoreTransactions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["rnd-store", "transactions"],
    queryFn: () => api<RndStoreTransaction[]>("/api/rnd-store/transactions"),
    enabled: options?.enabled ?? true,
  });
}

export function useRndStoreReport(filters?: { dateFrom?: string; dateTo?: string }, options?: { enabled?: boolean }) {
  const params = new URLSearchParams();
  if (filters?.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters?.dateTo) params.set("dateTo", filters.dateTo);
  const qs = params.toString();
  return useQuery({
    queryKey: ["rnd-store", "report", filters ?? {}],
    queryFn: () => api<RndStoreReportRow[]>(`/api/rnd-store/report${qs ? `?${qs}` : ""}`),
    enabled: options?.enabled,
  });
}

// --- Stock Transfers — Day Store -> Day Store / Warehouse / Plant, see
// stock-transfers.routes.ts. Same sender-creates/receiver-confirms shape
// as RndTransfer above.

function invalidateStockTransfers(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["stock-transfers"] });
  // A send/confirm moves a Day Store's, Plant's, or the Warehouse's own
  // on-hand — every one of those views reads through ["inventory"].
  qc.invalidateQueries({ queryKey: ["inventory"] });
}

export function useStockTransfers(status?: StockTransferStatus) {
  return useQuery({
    queryKey: ["stock-transfers", status ?? null],
    queryFn: () => api<StockTransfer[]>(`/api/stock-transfers${status ? `?status=${status}` : ""}`),
  });
}

export interface CreateStockTransferPayload {
  itemId: string;
  quantity: number;
  unit: string;
  note?: string;
  sourceType: StockTransferSourceType;
  sourceDayStoreId?: string;
  sourcePlantId?: string;
  destinationType: StockTransferDestinationType;
  destDayStoreId?: string;
  destPlantId?: string;
}

export function useCreateStockTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateStockTransferPayload) => api<StockTransfer>("/api/stock-transfers", { method: "POST", body }),
    onSuccess: () => invalidateStockTransfers(qc),
  });
}

export function useConfirmStockTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (arg: string | { id: string; receivedQty?: number; note?: string }) => {
      const { id, ...body } = typeof arg === "string" ? { id: arg } : arg;
      return api<StockTransfer>(`/api/stock-transfers/${id}/confirm`, { method: "POST", body });
    },
    onSuccess: () => invalidateStockTransfers(qc),
  });
}

// The receiving side refuses the transfer: the material goes back to the sender.
export function useRejectStockTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api(`/api/stock-transfers/${id}/reject`, { method: "POST", body: { reason } }),
    onSuccess: () => invalidateStockTransfers(qc),
  });
}

export function useCancelStockTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/stock-transfers/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateStockTransfers(qc),
  });
}

// --- Plant Consumption — requirement I, see plant-consumption.routes.ts.

// Which runs are at a given Plant — Plant Consumption's own "pick a run"
// list, a plantId filter on the same GET /api/pre-productions the rest
// of the Batches module already uses.
export function usePreProductionsByPlant(plantId: string | undefined) {
  return useQuery({
    queryKey: ["pre-productions", { plantId }],
    queryFn: () => apiAll<PreProduction>(`/api/pre-productions?plantId=${plantId}`),
    enabled: !!plantId,
  });
}

export function usePlantConsumptionBalance(preProductionId: string | undefined) {
  return useQuery({
    queryKey: ["plant-consumption", preProductionId, "balance"],
    queryFn: () => api<PlantConsumptionBalance>(`/api/plant-consumption/${preProductionId}/balance`),
    enabled: !!preProductionId,
  });
}

export function useMaterialConsumptionReport(
  filters?: { poId?: string; preProductionId?: string; itemId?: string; dateFrom?: string; dateTo?: string },
  options?: { enabled?: boolean },
) {
  const params = new URLSearchParams();
  if (filters?.poId) params.set("poId", filters.poId);
  if (filters?.preProductionId) params.set("preProductionId", filters.preProductionId);
  if (filters?.itemId) params.set("itemId", filters.itemId);
  if (filters?.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters?.dateTo) params.set("dateTo", filters.dateTo);
  const qs = params.toString();
  return useQuery({
    queryKey: ["plant-consumption", "report", filters ?? {}],
    queryFn: () => api<MaterialConsumptionRow[]>(`/api/plant-consumption/report${qs ? `?${qs}` : ""}`),
    enabled: options?.enabled,
  });
}

export interface RecordPlantConsumptionPayload {
  itemId: string;
  consumedQty?: number;
  wastedQty?: number;
  rejectedQty?: number;
  returnedQty?: number;
  sampleQty?: number;
  productionBatchId?: string;
  unit: string;
  destinationType?: "DAY_STORE" | "WAREHOUSE";
  destDayStoreId?: string;
  note?: string;
}

export function useRecordPlantConsumption(preProductionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RecordPlantConsumptionPayload) => api(`/api/plant-consumption/${preProductionId}/entries`, { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plant-consumption", preProductionId] });
      qc.invalidateQueries({ queryKey: ["stock-transfers"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["pre-productions"] });
      // The batch lists (Packaging, Batch tile) carry each batch's Utilization status ("0 of 3", the end fields locked until it is complete).
      qc.invalidateQueries({ queryKey: ["production-batches"] });
    },
  });
}

// --- QC Sample Store — the pre-production sample lifecycle scoped to one
// PreProduction run, see qc-sample.routes.ts. The TO_QC send itself
// happens as part of logging Dispensing's SAMPLE-purpose consumption
// (see useTransitionPreProductionStage above), so there's no "create
// transfer" hook here — only confirm/consume/return. ---

function invalidateQcSample(qc: ReturnType<typeof useQueryClient>, preProductionId: string) {
  qc.invalidateQueries({ queryKey: ["qc-sample", preProductionId] });
  // usePreProduction's own key is ["pre-productions", "detail", id] —
  // invalidating the shared ["pre-productions"] root (same as
  // useTransitionPreProductionStage/useAssignPreProductionPlant above) is
  // what actually matches it; ["pre-productions", preProductionId] alone
  // does not, since "detail" sits between them.
  qc.invalidateQueries({ queryKey: ["pre-productions"] });
}

export function useQcSampleSummary(preProductionId: string) {
  return useQuery({ queryKey: ["qc-sample", preProductionId, "summary"], queryFn: () => api<QcSampleSummary>(`/api/qc-sample/pre-productions/${preProductionId}/summary`) });
}

export function useConfirmQcSampleTransfer(preProductionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (transferId: string) => api<QcSampleTransfer>(`/api/qc-sample/pre-productions/${preProductionId}/transfers/${transferId}/confirm`, { method: "POST" }),
    onSuccess: () => invalidateQcSample(qc, preProductionId),
  });
}

export function useConsumeQcSample(preProductionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { itemId: string; quantity: number; unit: string; consumeReason: QcSampleConsumeReason; note?: string }) =>
      api(`/api/qc-sample/pre-productions/${preProductionId}/consume`, { method: "POST", body }),
    onSuccess: () => invalidateQcSample(qc, preProductionId),
  });
}

// --- Recycle Store — read-only, see recycle-store.routes.ts. No
// mutations: both ledgers this reports on are written automatically by
// the pipeline (Dispensing's WASTE-purpose consumption, a CombinedLot's
// QA gates' Wastage field — see useTransitionPreProductionStage/
// useTransitionCombinedLotStage above). ---

export function useRecycleStoreTransactions() {
  return useQuery({ queryKey: ["recycle-store", "transactions"], queryFn: () => api<RecycleStoreTransaction[]>("/api/recycle-store/transactions") });
}

export function useRecycleSummary(options?: { enabled?: boolean }) {
  return useQuery({ queryKey: ["recycle-store", "summary"], queryFn: () => api<{ toDecide: number }>("/api/recycle-store/summary"), enabled: options?.enabled, staleTime: 15_000 });
}

/** QA decides about rejected raw / packaging material: REUSE puts it back into the Plant's stock, DESTROY writes it off (with a certificate no.). */
export function useRecycleDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; decision: "REUSE" | "DESTROY"; quantity: number; note?: string; certificateNo?: string }) => api<{ id: string; left: number }>(`/api/recycle-store/entries/${id}/decision`, { method: "POST", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["recycle-store"] });
      void qc.invalidateQueries({ queryKey: ["inventory"] });
      void qc.invalidateQueries({ queryKey: ["plant-stock"] });
    },
  });
}

export function useRecycleStoreByItem() {
  return useQuery({ queryKey: ["recycle-store", "by-item"], queryFn: () => api<RecycleStoreByItemRow[]>("/api/recycle-store/by-item") });
}

export function useRecycleStoreByBatch() {
  return useQuery({ queryKey: ["recycle-store", "by-batch"], queryFn: () => api<RecycleStoreByBatchRow[]>("/api/recycle-store/by-batch") });
}

export function useReturnQcSample(preProductionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { itemId: string; quantity: number; unit: string; note?: string }) => api<QcSampleTransfer>(`/api/qc-sample/pre-productions/${preProductionId}/return`, { method: "POST", body }),
    onSuccess: () => invalidateQcSample(qc, preProductionId),
  });
}

// ---------------------------------------------------------------------------
// The per-batch flow: Indent (Production) -> Batch No (R&D) -> Dispensing (Day Store) -> Line Clearance (QA) -> production -> Packaging.
// ---------------------------------------------------------------------------

export interface BatchPrepRow {
  id: string;
  batchNo: string | null;
  plannedQty: number;
  unit: string;
  prepStageId: BatchPrepStageId;
  batchStatus: "IN_PROGRESS" | "COMPLETED";
  runId: string;
  itemId: string;
  poId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  plant: { id: string; name: string } | null;
  createdAt: string;
  prodIndentSlipSign: string | null;
  productionPlanDate: string | null;
  indentSignedAt: string | null;
  batchNoAllocatedAt: string | null;
  rmDispensingDate: string | null;
  pmIssuedDate: string | null;
  dispensingRemarks: string | null;
  dispensedAt: string | null;
  grnNo: string | null;
  /** Dispensing only: this batch's materials and whether the Plant and its Day Store hold them. */
  requirements?: { itemId: string; itemName: string; category: string; unit: string; requiredQty: number; dayStoreQty: number; plantFreeQty: number; enough: boolean; dispensed: boolean; refusedNote: string | null }[];
  /** Receive only: what the Day Store sent to the Plant for this batch and Production has not confirmed yet, material by material. */
  receiveLines?: { lineId: string; itemId: string; itemName: string; category: string; unit: string; plannedQty: number | null; givenQty: number; sentQty: number }[];
}

export function usePrepBoard(stage: BatchPrepStageId, options?: { enabled?: boolean; all?: boolean }) {
  return useQuery({
    queryKey: ["production-batches", "prep-board", stage, options?.all ? "all" : "waiting"],
    queryFn: () => api<BatchPrepRow[]>(`/api/production-batches/prep-board?stage=${stage}${options?.all ? "&all=1" : ""}`),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

export function usePrepSummary(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["production-batches", "prep-summary"],
    queryFn: () => api<Record<BatchPrepStageId, number>>("/api/production-batches/prep-summary"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

/** One step of a batch's preparation (indent, batch-no/allocate, dispense, receive). */
export function useBatchPrepAction(step: "indent" | "batch-no/allocate" | "dispense" | "receive") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) => api<BatchPrepRow>(`/api/production-batches/${id}/${step}`, { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-batches"] });
      qc.invalidateQueries({ queryKey: ["pre-productions"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function usePackagingBoard(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["production-batches", "packaging-board"],
    queryFn: () => api<ProductionBatch[]>("/api/production-batches/packaging-board"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

export function useUpdatePackaging() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) => api<ProductionBatch>(`/api/production-batches/${id}/packaging`, { method: "PATCH", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-batches"] });
      qc.invalidateQueries({ queryKey: ["pre-productions"] });
    },
  });
}

/** The Utilization of a whole batch, RM (before Packaging) or PM (after): the four batch numbers and the lines worked out from them. Saving replaces the earlier one. */
export interface SaveUtilizationPayload {
  producedQty: number;
  wasteQty: number;
  rejectQty: number;
  sampleQty: number;
  lines: { itemId: string; consumedQty: number; wastedQty: number; rejectedQty: number; sampleQty: number }[];
}
export function useSaveUtilization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, category, ...body }: { id: string; category: "RM" | "PM" } & SaveUtilizationPayload) => api<ProductionBatch>(`/api/production-batches/${id}/utilization/${category}`, { method: "PUT", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-batches"] });
      qc.invalidateQueries({ queryKey: ["pre-productions"] });
      qc.invalidateQueries({ queryKey: ["plant-consumption"] });
      qc.invalidateQueries({ queryKey: ["plant-stock"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

/** R&D corrects a batch number (until the batch is dispensed). */
export function useCorrectBatchNo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, batchNo }: { id: string; batchNo: string }) => api<ProductionBatch>(`/api/production-batches/${id}/batch-no`, { method: "PATCH", body: { batchNo } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["production-batches"] }),
  });
}

// ---------------------------------------------------------------------------
// Plant Stock: what a Plant holds, what is reserved for batches, what is free, and the leftover to send back to the Day Store.
// ---------------------------------------------------------------------------

export interface PlantStockRow {
  plantId: string;
  plantName: string;
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  onHand: number;
  reserved: number;
  free: number;
  pendingReturn: number;
  batches: { batchId: string; batchNo: string | null; given: number; used: number; leftover: number; reserved: number }[];
}

export function usePlantStockBoard(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["plant-stock"],
    queryFn: () => api<{ plants: { id: string; name: string }[]; rows: PlantStockRow[] }>("/api/plant-stock"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

export function useReturnFromPlant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { plantId: string; itemId: string; quantity: number; note?: string }) => api<{ id: string }>("/api/plant-stock/return", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plant-stock"] });
      qc.invalidateQueries({ queryKey: ["stock-transfers"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["pre-productions"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Production Report, batch level: a batch's timeline, Packaging's own sheet and the RM / PM Utilization (what the plan needs, what the Day
// Store gave, A used, B wastage, C rejected, D sample, E leftover). Material used outside the plan comes back with inPlan false.
// ---------------------------------------------------------------------------

export interface BatchReportMaterial extends BoardMaterial {
  category: "RM" | "PM";
  inPlan: boolean;
  requiredQty: number;
  givenQty: number;
  /** Extra material asked from the Day Store for this product (not per batch), and how much of it was issued. */
  extraRequestedQty: number;
  extraIssuedQty: number;
}

export interface BatchReportDetail {
  batchId: string;
  batchNo: string | null;
  /** The BOM version the batch was made from (Display BOM, V1 or V2) and, for a V1 / V2, who changed it, when and why. */
  bomVersion: string;
  bomVersionNote: string | null;
  plannedQty: number;
  status: "IN_PROGRESS" | "COMPLETED";
  prepStageId: BatchPrepStageId;
  currentStageId: string;
  createdAt: string;
  productionPlanDate: string | null;
  indentSignedAt: string | null;
  batchNoAllocatedAt: string | null;
  rmDispensingDate: string | null;
  pmIssuedDate: string | null;
  dispensedAt: string | null;
  grnNo: string | null;
  lineClearanceStatus: string | null;
  lineClearanceAt: string | null;
  lineClearanceChecks: Record<string, boolean> | null;
  shift: "Day" | "Night" | null;
  manpowerCount: number | null;
  shiftStartAt: string | null;
  shiftEndAt: string | null;
  manufacturingStatus: string | null;
  manufacturingRemarks: string | null;
  inputQty: number | null;
  outputQty: number | null;
  completedAt: string | null;
  ipqcStatus: string | null;
  mfgQaStatus: string | null;
  mfgApprovedQty: number | null;
  mfgRejectedQty: number | null;
  mfgWastageQty: number | null;
  bulkQcStatus: string | null;
  packagingShift: "Day" | "Night" | null;
  packagingManpowerCount: number | null;
  packagingStartAt: string | null;
  packagingEndAt: string | null;
  packagingStatus: string | null;
  packagingRemarks: string | null;
  packApprovedQty: number | null;
  packRejectedQty: number | null;
  packWastageQty: number | null;
  fgStoreReceivedDate: string | null;
  fgQaStatus: string | null;
  handedOverToDispatchAt: string | null;
  invoiceDate: string | null;
  dispatchDate: string | null;
  dispatchedQty: number | null;
  materials: BatchReportMaterial[];
}

export function useBatchReportBoard(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["production-batches", "report-board"],
    queryFn: () => api<BatchReportDetail[]>("/api/production-batches/report-board"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}
