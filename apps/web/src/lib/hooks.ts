import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type {
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
  InventoryTransaction,
  InventoryTxnType,
  ImportCustomerUpdatesResult,
  ImportPoRequirementsResult,
  ImportPurchaseOrdersResult,
  ItemStockByLocation,
  ManagedUser,
  MaterialReconciliationRow,
  Plant,
  PoBilling,
  PoReadinessRow,
  PoReconciliation,
  PoWastageRejectionRow,
  PreInventoryRequirement,
  ProductType,
  PurchaseOrder,
  QcDashboard,
  QcSampleConsumeReason,
  QcSampleSummary,
  QcSampleTransfer,
  RecipeRequest,
  RecipeRequestStatus,
  RecipeSummary,
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
  StoreUser,
  SystemHealth,
  TransitItem,
  Warehouse,
} from "./types";
import type { ImportCustomerCatalogPayload } from "./catalogImport";
import type { ImportDispatchTransferRow, ImportInventoryRequestRow, ImportInventoryRow, ImportItemMasterRow, ImportPurchaseLogRow, ImportRequirementRow, ImportRndSampleRequestRow } from "./inventoryImport";
import type { ImportPurchaseOrderRow } from "./purchaseOrdersImport";
import type { ImportCustomerUpdateRow } from "./customersImport";

// --- Customers ---

// pageSize=200 (the server's max, see pagination.ts) — without it this
// silently truncated at the default 50, same class of bug usePurchaseOrders
// already had to work around below.
export function useCustomers() {
  return useQuery({ queryKey: ["customers"], queryFn: () => api<Customer[]>("/api/customers?pageSize=200") });
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

// Phase G — the PO-level combined Material Reconciliation rollup, see
// purchase-orders.routes.ts GET /:id/reconciliation.
export function usePoReconciliation(id: string | undefined) {
  return useQuery({
    queryKey: ["purchase-orders", id, "reconciliation"],
    queryFn: () => api<PoReconciliation>(`/api/purchase-orders/${id}/reconciliation`),
    enabled: !!id,
  });
}

// PO-level consolidated Billing — see purchase-orders.routes.ts's
// GET/POST /:id/billing. Preview (GET) is Purchase+Accounts; generating
// the saved invoice (POST) is Accounts-only.
export function usePoBilling(id: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["purchase-orders", id, "billing"],
    queryFn: () => api<PoBilling>(`/api/purchase-orders/${id}/billing`),
    enabled: !!id && (options?.enabled ?? true),
  });
}

export function useGeneratePoInvoice(poId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { invoiceNo?: string; invoiceDate?: string }) => api<PoBilling>(`/api/purchase-orders/${poId}/billing`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-orders", poId, "billing"] }),
  });
}

export interface CreatePurchaseOrderPayload {
  customerId: string;
  poNumber?: string;
  orderDate?: string;
  expectedDeliveryDate?: string;
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
    productType?: ProductType;
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

// --- Three-tier production pipeline (see types.ts's own comment block
// above PreProduction/ProductionBatch/CombinedLot) ---

// --- Tier 1 — PreProduction ---

export function usePreProductions(purchaseOrderItemId?: string) {
  return useQuery({
    queryKey: ["pre-productions", { purchaseOrderItemId }],
    queryFn: () => api<PreProduction[]>(`/api/pre-productions${purchaseOrderItemId ? `?purchaseOrderItemId=${purchaseOrderItemId}` : ""}`),
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

export function useCreatePreProduction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { purchaseOrderItemId: string; plantId?: string; confirmNotReady?: boolean }) => api<PreProduction>("/api/pre-productions", { method: "POST", body }),
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
    mutationFn: (body: { batchNo?: string; plannedQty: number }) => api<ProductionBatch>(`/api/pre-productions/${preProductionId}/production-batches`, { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pre-productions", preProductionId, "production-batches"] });
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pre-productions", preProductionId, "production-batches"] }),
  });
}

// The one action with real side effects: marks the run COMPLETED, adds
// its outputQty to the parent's running combinedQty, and — only once
// that total reaches the parent's plannedQty — creates the CombinedLot
// every downstream stage happens against. Returns both the completed run
// and the lot, if one was just created (null otherwise).
export function useCompleteProductionBatch(preProductionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ productionBatch: ProductionBatch; combinedLot: CombinedLot | null }>(`/api/production-batches/${id}/complete`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pre-productions", preProductionId, "production-batches"] });
      qc.invalidateQueries({ queryKey: ["pre-productions", "detail", preProductionId] });
      qc.invalidateQueries({ queryKey: ["combined-lots"] });
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
    queryFn: () => api<CatalogSku[]>(`/api/catalog/skus?pageSize=200${customerId ? `&customerId=${customerId}` : ""}`),
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

export function useUpdateSkuPackagingComponents(customerId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, components }: { id: string; components: { type: string; quantity: number | null; unit: string; pmCode?: string }[] }) =>
      api<CatalogSku>(`/api/catalog/skus/${id}/packaging-components`, { method: "PUT", body: { components } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog", "skus", customerId] }),
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
    mutationFn: () =>
      api<{ requirementsCreated: number; itemsCreated: number; materialRequests: { rowsCreated: number } | null }>(`/api/bom/plans/${planId}/send-to-pre-inventory`, {
        method: "POST",
      }),
  });
}

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
    mutationFn: () =>
      api<{ requirementsCreated: number; itemsCreated: number; materialRequests: { rowsCreated: number } | null }>(`/api/rm-costing/plans/${planId}/send-to-pre-inventory`, {
        method: "POST",
      }),
  });
}

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

export function useInventoryTransactions(
  filters?: { type?: InventoryTxnType; category?: InventoryCategory; itemId?: string; receiptStatus?: InventoryReceiptStatus },
  options?: { enabled?: boolean },
) {
  const params = new URLSearchParams();
  if (filters?.type) params.set("type", filters.type);
  if (filters?.category) params.set("category", filters.category);
  if (filters?.itemId) params.set("itemId", filters.itemId);
  if (filters?.receiptStatus) params.set("receiptStatus", filters.receiptStatus);
  // Server max (see pagination.ts) — without it this silently truncated
  // at the default 50, same gap as every other list hook fixed earlier —
  // an item's full history (the item detail page) especially needs to
  // see everything, not a first page of it.
  params.set("pageSize", "200");
  const qs = params.toString();
  return useQuery({
    queryKey: ["inventory", "transactions", filters],
    queryFn: () => api<InventoryTransaction[]>(`/api/inventory/transactions?${qs}`),
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
  // Transit tracking — ISSUED_DAY_STORE/ISSUED_PRODUCTION only. See
  // useConfirmDelivery/useTransit below.
  isTransitTracked?: boolean;
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
    mutationFn: (body: { type: InventoryTxnType; rows: ImportInventoryRow[]; isOpeningStock?: boolean; dayStoreId?: string; isTransitTracked?: boolean }) =>
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
  // The QC Dashboard's counts/worklist are a live aggregate over this
  // same data — a review made from either place has to refresh both.
  qc.invalidateQueries({ queryKey: ["qc", "dashboard"] });
}

export function useQcReviewTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; action: "APPROVE" | "REJECT" | "HOLD"; note?: string }) =>
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

export function useConfirmDelivery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => api<InventoryTransaction>(`/api/inventory/transactions/${id}/confirm-delivery`, { method: "POST", body: { note } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory", "transit"] });
      qc.invalidateQueries({ queryKey: ["inventory", "transactions"] });
      qc.invalidateQueries({ queryKey: ["inventory", "stock"] });
      qc.invalidateQueries({ queryKey: ["inventory", "day-stores"] });
      qc.invalidateQueries({ queryKey: ["inventory", "plants"] });
    },
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
export function useQcDashboard() {
  return useQuery({ queryKey: ["qc", "dashboard"], queryFn: () => api<QcDashboard>("/api/qc/dashboard") });
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

// fullName and/or email — same PATCH /:userId either edit goes through
// (see users.routes.ts's updateUserSchema). An email change bumps the
// target's tokenVersion server-side, so their existing session (if any)
// stops working immediately — same "why doesn't my change apply" gap
// deactivate/role-revoke already close.
export function useRenameUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, fullName, email }: { userId: string; fullName?: string; email?: string }) => api(`/api/users/${userId}`, { method: "PATCH", body: { fullName, email } }),
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

export function useRndTransfers(status?: "PENDING" | "CONFIRMED") {
  return useQuery({
    queryKey: ["rnd-store", "transfers", status ?? null],
    queryFn: () => api<RndTransfer[]>(`/api/rnd-store/transfers${status ? `?status=${status}` : ""}`),
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

export function useRndSampleRequests(status?: RndSampleRequestStatus) {
  return useQuery({
    queryKey: ["rnd-store", "requests", status ?? null],
    queryFn: () => api<RndSampleRequest[]>(`/api/rnd-store/requests${status ? `?status=${status}` : ""}`),
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
    mutationFn: (body: { itemId: string; quantity: number; unit: string; note?: string }) => api<RndSampleRequest>("/api/rnd-store/requests", { method: "POST", body }),
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
    mutationFn: (id: string) => api<RndTransfer>(`/api/rnd-store/transfers/${id}/confirm`, { method: "POST" }),
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

export function useRndStoreTransactions() {
  return useQuery({ queryKey: ["rnd-store", "transactions"], queryFn: () => api<RndStoreTransaction[]>("/api/rnd-store/transactions") });
}

export function useRndStoreReport() {
  return useQuery({ queryKey: ["rnd-store", "report"], queryFn: () => api<RndStoreReportRow[]>("/api/rnd-store/report") });
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
