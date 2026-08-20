import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type {
  Batch,
  BomPlan,
  CatalogBrand,
  CatalogSku,
  Customer,
  DispatchTransfer,
  DispatchTransferType,
  InventoryCategory,
  InventoryItem,
  InventoryRequest,
  InventoryRequestPurpose,
  InventoryRequestStatus,
  InventoryStockLine,
  InventoryTransaction,
  InventoryTxnType,
  ManagedUser,
  PurchaseOrder,
  RecipeSummary,
  RmPlan,
  RoleName,
} from "./types";
import type { ImportBrandPayload } from "./catalogImport";
import type { ImportInventoryRow } from "./inventoryImport";

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

export function usePurchaseOrders() {
  return useQuery({ queryKey: ["purchase-orders"], queryFn: () => api<PurchaseOrder[]>("/api/purchase-orders") });
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
    mutationFn: (body: { purchaseOrderItemId: string; batchNo?: string }) => api<Batch>("/api/batches", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["batches"] }),
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

export function useInventoryStock(category?: InventoryCategory) {
  return useQuery({
    queryKey: ["inventory", "stock", category],
    queryFn: () => api<InventoryStockLine[]>(`/api/inventory/stock${category ? `?category=${category}` : ""}`),
  });
}

export function useInventoryTransactions(filters?: { type?: InventoryTxnType; category?: InventoryCategory; itemId?: string }, options?: { enabled?: boolean }) {
  const params = new URLSearchParams();
  if (filters?.type) params.set("type", filters.type);
  if (filters?.category) params.set("category", filters.category);
  if (filters?.itemId) params.set("itemId", filters.itemId);
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
}

export function useCreateInventoryTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInventoryTransactionPayload) => api<InventoryTransaction>("/api/inventory/transactions", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "transactions"] });
      qc.invalidateQueries({ queryKey: ["inventory", "stock"] });
    },
  });
}

export function useImportInventoryTransactions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { type: InventoryTxnType; rows: ImportInventoryRow[] }) =>
      api<{ transactionsCreated: number; itemsCreated: number }>("/api/inventory/transactions/import", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "transactions"] });
      qc.invalidateQueries({ queryKey: ["inventory", "stock"] });
      qc.invalidateQueries({ queryKey: ["inventory", "items"] });
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

export function useInventoryVendors() {
  return useQuery({ queryKey: ["inventory", "vendors"], queryFn: () => api<string[]>("/api/inventory/vendors") });
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
    mutationFn: ({ id, ...body }: { id: string; date: string; unit: string; quantity: number; size?: string }) =>
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

export function useDispatchTransfers(filters?: { type?: DispatchTransferType; customerId?: string }, options?: { enabled?: boolean }) {
  const params = new URLSearchParams();
  if (filters?.type) params.set("type", filters.type);
  if (filters?.customerId) params.set("customerId", filters.customerId);
  const qs = params.toString();
  return useQuery({
    queryKey: ["inventory", "dispatch-transfers", filters],
    queryFn: () => api<DispatchTransfer[]>(`/api/inventory/dispatch-transfers${qs ? `?${qs}` : ""}`),
    enabled: options?.enabled,
  });
}

export interface CreateDispatchTransferPayload {
  type: DispatchTransferType;
  date: string;
  customerId: string;
  productName: string;
  quantity: number;
}

export function useCreateDispatchTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDispatchTransferPayload) => api<DispatchTransfer>("/api/inventory/dispatch-transfers", { method: "POST", body }),
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

export function useResetPassword() {
  return useMutation({
    mutationFn: ({ userId, newPassword }: { userId: string; newPassword: string }) => api(`/api/users/${userId}/reset-password`, { method: "POST", body: { newPassword } }),
  });
}
