import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type {
  AppNotification,
  Batch,
  BomPlan,
  CatalogBrand,
  CatalogSku,
  Customer,
  CustomerReconciliationRow,
  DayStore,
  DayStoreAssignment,
  DayStoreStockLine,
  DispatchTransfer,
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
  InventoryTransaction,
  InventoryTxnType,
  ImportPoRequirementsResult,
  ImportPurchaseOrdersResult,
  ItemStockByLocation,
  ManagedUser,
  Plant,
  PoReadinessRow,
  PoWastageRejectionRow,
  PreInventoryRequirement,
  PurchaseOrder,
  RecipeSummary,
  RmPlan,
  RoleName,
  StoreUser,
} from "./types";
import type { ImportBrandPayload } from "./catalogImport";
import type { ImportDispatchTransferRow, ImportInventoryRequestRow, ImportInventoryRow, ImportPurchaseLogRow, ImportRequirementRow } from "./inventoryImport";
import type { ImportPurchaseOrderRow } from "./purchaseOrdersImport";

// --- Customers ---

export function useCustomers() {
  return useQuery({ queryKey: ["customers"], queryFn: () => api<Customer[]>("/api/customers") });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Customer>) => api<Customer>("/api/customers", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });
}

// --- Purchase Orders ---

// pageSize=200 (the server's max, see pagination.ts) — without it this
// silently truncated at the default 50, which the page's own "Download
// Report" button (and now the pending-PO-aging report) both rely on
// being the complete list, not a first page of it.
export function usePurchaseOrders() {
  return useQuery({ queryKey: ["purchase-orders"], queryFn: () => api<PurchaseOrder[]>("/api/purchase-orders?pageSize=200") });
}

export function usePoWastageRejectionReport(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["purchase-orders", "reports", "wastage-rejection"],
    queryFn: () => api<PoWastageRejectionRow[]>("/api/purchase-orders/reports/wastage-rejection"),
    enabled: options?.enabled,
  });
}

export function useItemStockByLocation(itemId: string | undefined) {
  return useQuery({
    queryKey: ["inventory", "items", itemId, "stock-by-location"],
    queryFn: () => api<ItemStockByLocation>(`/api/inventory/items/${itemId}/stock-by-location`),
    enabled: !!itemId,
  });
}

export function usePurchaseOrder(id: string | undefined) {
  return useQuery({
    queryKey: ["purchase-orders", id],
    queryFn: () => api<PurchaseOrder>(`/api/purchase-orders/${id}`),
    enabled: !!id,
  });
}

export interface CreatePurchaseOrderPayload {
  customerId: string;
  poNumber?: string;
  brandName?: string;
  orderDate?: string;
  regulatoryBody?: string;
  regulatoryStatus?: string;
  items: {
    productName: string;
    dosageForm?: string;
    quantity: number;
    unit: string;
    volume?: number;
    packSize?: string;
    packType?: string;
    bomRef?: string;
  }[];
}

export function useCreatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePurchaseOrderPayload) => api<PurchaseOrder>("/api/purchase-orders", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-orders"] }),
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

// Draft → BD Approve/Reject. A batch can't be created off any of this
// PO's line items until it's approved (see useCreateBatch below).
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

// --- PO Material Readiness — see PoMaterialRequirement in schema.prisma.
// pageSize is pinned at the API's max (200) rather than paginated in the
// UI — matches the scale the requirement was raised for (hundreds of
// POs at once), and this is a live "what's ready right now" view, not a
// browsable archive that needs real pagination. ---

export function usePoReadiness(readyOnly?: boolean, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["po-readiness", readyOnly ?? false],
    queryFn: () => api<PoReadinessRow[]>(`/api/po-readiness?pageSize=200${readyOnly ? "&ready=true" : ""}`),
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

// --- Batches ---

export function useBatches(purchaseOrderItemId?: string) {
  return useQuery({
    queryKey: ["batches", { purchaseOrderItemId }],
    queryFn: () => api<Batch[]>(`/api/batches${purchaseOrderItemId ? `?purchaseOrderItemId=${purchaseOrderItemId}` : ""}`),
  });
}

export function useBatch(id: string | undefined) {
  return useQuery({ queryKey: ["batches", "detail", id], queryFn: () => api<Batch>(`/api/batches/${id}`), enabled: !!id });
}

export function useCreateBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { purchaseOrderItemId: string; batchNo?: string; plantId?: string }) => api<Batch>("/api/batches", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["batches"] }),
  });
}

// Assign/change which Plant a batch runs at — separate from the stage
// transition, PPIC's call any time (e.g. fixing a batch created before a
// Plant was picked). null explicitly clears it.
export function useAssignBatchPlant(batchId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (plantId: string | null) => api<Batch>(`/api/batches/${batchId}/plant`, { method: "PATCH", body: { plantId } }),
    onSuccess: (updated) => {
      qc.setQueryData(["batches", "detail", batchId], updated);
      qc.invalidateQueries({ queryKey: ["batches"] });
    },
  });
}

// The one transition endpoint for the whole pipeline: fill in the current
// stage's fields (if it has any), then either forward the batch or send
// it back to the previous stage (REJECT requires a note). JUMP is the
// admin-only override — moves the batch straight to any stage via
// targetStageId, no fields required.
export function useTransitionBatchStage(batchId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: "FORWARD" | "REJECT" | "JUMP"; note?: string; targetStageId?: string } & Record<string, unknown>) =>
      api<Batch>(`/api/batches/${batchId}/stage`, { method: "PATCH", body }),
    onSuccess: (updated) => {
      qc.setQueryData(["batches", "detail", batchId], updated);
      qc.invalidateQueries({ queryKey: ["batches"] });
    },
  });
}

// --- Packaging BOM module ---

export function useBrands() {
  return useQuery({ queryKey: ["catalog", "brands"], queryFn: () => api<CatalogBrand[]>("/api/catalog/brands") });
}

export function useSkus(brandId?: string) {
  return useQuery({
    queryKey: ["catalog", "skus", brandId],
    queryFn: () => api<CatalogSku[]>(`/api/catalog/skus${brandId ? `?brandId=${brandId}` : ""}`),
    enabled: !!brandId,
  });
}

export function useImportCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (brands: ImportBrandPayload[]) => api<{ brandsTouched: number; skusUpserted: number }>("/api/catalog/import", { method: "POST", body: { brands } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog"] }),
  });
}

export function useBomPlans() {
  return useQuery({ queryKey: ["bom-plans"], queryFn: () => api<BomPlan[]>("/api/bom/plans") });
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
export function useSendBomPlanToPreInventory(planId: string) {
  return useMutation({
    mutationFn: () => api<{ requirementsCreated: number; itemsCreated: number }>(`/api/bom/plans/${planId}/send-to-pre-inventory`, { method: "POST" }),
  });
}

// --- RM Costing module ---

export function useRecipes() {
  return useQuery({ queryKey: ["rm-costing", "recipes"], queryFn: () => api<RecipeSummary[]>("/api/rm-costing/recipes") });
}

export function useImportRecipes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (recipes: { name: string; ingredients: { name: string; brand: string; costPerKg: number; gPerServing: number; proteinPct: number }[] }[]) =>
      api<{ recipesUpserted: number; ingredientsUpserted: number }>("/api/rm-costing/recipes/import", { method: "POST", body: { recipes } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rm-costing", "recipes"] }),
  });
}

export function useRmPlans() {
  return useQuery({ queryKey: ["rm-plans"], queryFn: () => api<RmPlan[]>("/api/rm-costing/plans") });
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

export function useUpdateRmCosting(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (costingParams: Record<string, number>) => api<RmPlan>(`/api/rm-costing/plans/${planId}/costing`, { method: "PATCH", body: { costingParams } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rm-plans", planId] }),
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
export function useSendRmPlanToPreInventory(planId: string) {
  return useMutation({
    mutationFn: () => api<{ requirementsCreated: number; itemsCreated: number }>(`/api/rm-costing/plans/${planId}/send-to-pre-inventory`, { method: "POST" }),
  });
}

// The old separate "MPS Pipeline" hooks have been retired along with the
// module — see useTransitionBatchStage above.

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

export function useInventoryStock(category?: InventoryCategory, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "stock", category],
    queryFn: () => api<InventoryStockLine[]>(`/api/inventory/stock${category ? `?category=${category}` : ""}`),
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
  const qs = params.toString();
  return useQuery({
    queryKey: ["inventory", "transactions", filters],
    queryFn: () => api<InventoryTransaction[]>(`/api/inventory/transactions${qs ? `?${qs}` : ""}`),
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
  isOpeningStock?: boolean;
  batchNo?: string;
  grnNo?: string;
  mfgDate?: string;
  expiryDate?: string;
  remark?: string;
}

export function useCreateInventoryTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInventoryTransactionPayload) => api<InventoryTransaction>("/api/inventory/transactions", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "transactions"] });
      qc.invalidateQueries({ queryKey: ["inventory", "stock"] });
      qc.invalidateQueries({ queryKey: ["inventory", "vendors"] });
    },
  });
}

export function useImportInventoryTransactions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { type: InventoryTxnType; rows: ImportInventoryRow[]; isOpeningStock?: boolean; dayStoreId?: string }) =>
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
}

export function useQcReviewTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; action: "APPROVE" | "REJECT"; note?: string; rejectedQty?: number }) =>
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

// --- Material Requests — the department-wise gate: PPIC requests,
// Store approves/rejects/issues. See inventory.routes.ts. ---

export function useInventoryRequests(status?: InventoryRequestStatus, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["inventory", "requests", status],
    queryFn: () => api<InventoryRequest[]>(`/api/inventory/requests${status ? `?status=${status}` : ""}`),
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
    mutationFn: ({ id, ...body }: { id: string; date: string; unit: string; quantity: number; size?: string; dayStoreId: string | null }) =>
      api<InventoryTransaction>(`/api/inventory/requests/${id}/issue`, { method: "POST", body }),
    onSuccess: () => invalidateRequests(qc),
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
  // Server max (see pagination.ts) — without it this silently truncated
  // at the default 50, same gap as usePurchaseOrders/
  // usePreInventoryRequirements had before those were fixed.
  params.set("pageSize", "200");
  const qs = params.toString();
  return useQuery({
    queryKey: ["inventory", "dispatch-transfers", filters],
    queryFn: () => api<DispatchTransfer[]>(`/api/inventory/dispatch-transfers?${qs}`),
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
    mutationFn: ({ id, ...body }: { id: string; action: "APPROVE" | "REJECT"; note?: string }) =>
      api<DispatchTransfer>(`/api/inventory/dispatch-transfers/${id}/qc`, { method: "PATCH", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "dispatch-transfers"] });
    },
  });
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

export function useDayStores() {
  return useQuery({ queryKey: ["inventory", "day-stores"], queryFn: () => api<DayStore[]>("/api/inventory/day-stores") });
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

// --- Pre-Inventory — S1-S4: PPIC states a requirement, Warehouse says
// what's available, Purchase logs a PO for the shortfall, Finance reads
// the resulting vendor list. See pre-inventory.routes.ts. ---

export function usePreInventoryRequirements(filters?: { category?: InventoryCategory; short?: boolean }) {
  const params = new URLSearchParams();
  if (filters?.category) params.set("category", filters.category);
  if (filters?.short) params.set("short", "true");
  // Server max (see pagination.ts) — without it this silently truncated
  // at the default 50, which both the existing "Download Report" button
  // and the new PO-aging report (#7) need to see the full list, not a
  // first page of it.
  params.set("pageSize", "200");
  const qs = params.toString();
  return useQuery({
    queryKey: ["pre-inventory", "requirements", filters],
    queryFn: () => api<PreInventoryRequirement[]>(`/api/inventory/requirements?${qs}`),
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
    mutationFn: ({ id, ...body }: { id: string; poNumber: string; vendorName: string; eta: string }) =>
      api<PreInventoryRequirement>(`/api/inventory/requirements/${id}/purchase`, { method: "PATCH", body }),
    onSuccess: () => {
      invalidateRequirements(qc);
      qc.invalidateQueries({ queryKey: ["inventory", "vendors"] });
    },
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
  return useQuery({ queryKey: ["users"], queryFn: () => api<ManagedUser[]>("/api/users") });
}

/** Creates a roleless account via the public register endpoint, then (optionally) grants it a role — the two-step flow the API actually exposes, done in one admin action. */
export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { email: string; password: string; fullName: string; role?: RoleName }) => {
      const user = await api<{ id: string; email: string; fullName: string }>("/api/auth/register", {
        method: "POST",
        body: { email: body.email, password: body.password, fullName: body.fullName },
      });
      if (body.role) await api(`/api/users/${user.id}/roles`, { method: "POST", body: { role: body.role } });
      return user;
    },
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

export function useRenameUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, fullName }: { userId: string; fullName: string }) => api(`/api/users/${userId}`, { method: "PATCH", body: { fullName } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: ({ userId, newPassword }: { userId: string; newPassword: string }) => api(`/api/users/${userId}/reset-password`, { method: "POST", body: { newPassword } }),
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
