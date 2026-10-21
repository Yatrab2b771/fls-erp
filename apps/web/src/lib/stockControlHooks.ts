import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// Stock corrections (adjustments), rejected stock leaving the building, and lot traceability.
// See stock-adjustments.routes.ts, rejected-stock.routes.ts and lots.routes.ts in the API.

// ---------------------------------------------------------------- stock adjustments

export type AdjustmentLocation = "WAREHOUSE" | "DAY_STORE" | "PLANT" | "RND_STORE";
export type AdjustmentReason = "COUNT_CORRECTION" | "DAMAGED" | "SPILLAGE" | "EXPIRED_DISPOSAL" | "FOUND_EXTRA" | "OTHER";
export type AdjustmentStatus = "PENDING" | "APPROVED" | "REJECTED";

export const ADJUSTMENT_REASON_LABEL: Record<AdjustmentReason, string> = {
  COUNT_CORRECTION: "Physical count differs",
  DAMAGED: "Damaged",
  SPILLAGE: "Spillage",
  EXPIRED_DISPOSAL: "Expired - thrown away",
  FOUND_EXTRA: "Found extra stock",
  OTHER: "Other",
};

export interface StockAdjustment {
  id: string;
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  locationType: AdjustmentLocation;
  locationName: string;
  dayStoreId: string | null;
  plantId: string | null;
  quantityDelta: number;
  unit: string;
  reason: AdjustmentReason;
  note: string;
  systemQty: number | null;
  countedQty: number | null;
  status: AdjustmentStatus;
  requestedAt: string;
  requestedByName: string;
  requestedById: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
}

export function useStockAdjustments(status?: AdjustmentStatus) {
  return useQuery({
    queryKey: ["stock-adjustments", "list", status ?? null],
    queryFn: () => api<StockAdjustment[]>(`/api/stock-adjustments?pageSize=200${status ? `&status=${status}` : ""}`),
  });
}

export function useStockAdjustmentSummary() {
  return useQuery({
    queryKey: ["stock-adjustments", "summary"],
    queryFn: () => api<{ pending: number; approved: number; rejected: number }>("/api/stock-adjustments/summary"),
  });
}

export interface AdjustmentPosition {
  onHand: number;
  expiredInQuarantine: number;
  unit: string | null;
}

export function useAdjustmentPosition(args: { itemId?: string; locationType?: AdjustmentLocation; dayStoreId?: string; plantId?: string }) {
  const ready = !!args.itemId && !!args.locationType && (args.locationType !== "DAY_STORE" || !!args.dayStoreId) && (args.locationType !== "PLANT" || !!args.plantId);
  const qs = new URLSearchParams();
  if (args.itemId) qs.set("itemId", args.itemId);
  if (args.locationType) qs.set("locationType", args.locationType);
  if (args.dayStoreId) qs.set("dayStoreId", args.dayStoreId);
  if (args.plantId) qs.set("plantId", args.plantId);
  return useQuery({
    queryKey: ["stock-adjustments", "position", qs.toString()],
    queryFn: () => api<AdjustmentPosition>(`/api/stock-adjustments/position?${qs.toString()}`),
    enabled: ready,
  });
}

export interface CreateAdjustmentPayload {
  itemId: string;
  locationType: AdjustmentLocation;
  dayStoreId?: string;
  plantId?: string;
  mode: "DELTA" | "COUNT";
  quantityDelta?: number;
  countedQty?: number;
  reason?: AdjustmentReason;
  unit?: string;
  note: string;
}

function invalidateStock(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["stock-adjustments"] });
  // A correction changes balances everywhere stock is shown.
  qc.invalidateQueries({ queryKey: ["inventory"] });
  qc.invalidateQueries({ queryKey: ["rejected-stock"] });
}

export function useCreateStockAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAdjustmentPayload) => api<StockAdjustment>("/api/stock-adjustments", { method: "POST", body }),
    onSuccess: () => invalidateStock(qc),
  });
}

export function useReviewStockAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: "APPROVE" | "REJECT"; note?: string }) => api<StockAdjustment>(`/api/stock-adjustments/${id}/review`, { method: "POST", body: { action, note } }),
    onSuccess: () => invalidateStock(qc),
  });
}

export function useWithdrawStockAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/stock-adjustments/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateStock(qc),
  });
}

// ---------------------------------------------------------------- rejected stock

export interface RejectedDispositionRow {
  id: string;
  kind: "RETURNED_TO_VENDOR" | "DESTROYED";
  quantity: number;
  date: string;
  challanNo: string | null;
  vehicleNo: string | null;
  note: string | null;
}

export interface RejectedStockRow {
  id: string;
  itemName: string;
  category: "RM" | "PM";
  vendorName: string | null;
  grnNo: string | null;
  batchNo: string | null;
  invoiceNo: string | null;
  receivedOn: string;
  rejectedAt: string | null;
  reason: string | null;
  unit: string;
  deliveredQty: number;
  rejectedQty: number;
  returnedQty: number;
  destroyedQty: number;
  remainingQty: number;
  debitNoted: boolean;
  dispositions: RejectedDispositionRow[];
}

export function useRejectedStock(all = false) {
  return useQuery({ queryKey: ["rejected-stock", all], queryFn: () => api<RejectedStockRow[]>(`/api/inventory/rejected-stock${all ? "?all=1" : ""}`) });
}

export function useRecordDisposition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ receiptId, ...body }: { receiptId: string; kind: "RETURNED_TO_VENDOR" | "DESTROYED"; quantity: number; challanNo?: string; vehicleNo?: string; note?: string }) =>
      api(`/api/inventory/rejected-stock/${receiptId}/dispositions`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rejected-stock"] }),
  });
}

export function useRemoveDisposition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/inventory/rejected-stock/dispositions/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rejected-stock"] }),
  });
}

// ---------------------------------------------------------------- lots & traceability

export type LotStatus = "OK" | "EXPIRING" | "EXPIRED" | "RELEASED" | "NO_EXPIRY";

export interface LotView {
  receiptId: string;
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  vendorName: string | null;
  grnNo: string | null;
  batchNo: string | null;
  invoiceNo: string | null;
  receivedOn: string;
  mfgDate: string | null;
  expiryDate: string | null;
  daysToExpiry: number | null;
  receivedQty: number;
  remaining?: number;
  status: LotStatus;
}

export interface ExpiringLot extends LotView {
  place: string;
}

export function useExpiringLots(days: number) {
  return useQuery({ queryKey: ["inventory", "lots", "expiring", days], queryFn: () => api<ExpiringLot[]>(`/api/inventory/lots/expiring?days=${days}`) });
}

export function useLotSearch(q: string) {
  return useQuery({ queryKey: ["inventory", "lots", "search", q], queryFn: () => api<LotView[]>(`/api/inventory/lots/search?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2 });
}

export interface LotMovement {
  kind: "BATCH" | "ISSUED_DAY_STORE" | "ISSUED_PRODUCTION" | "ISSUED_RND";
  at: string;
  quantity: number;
  from?: string;
  to: string;
  batchId?: string;
  batchNo?: string | null;
  productName?: string;
  poNumber?: string | null;
  customerName?: string;
}

export function useLotTrace(receiptId: string | undefined) {
  return useQuery({
    queryKey: ["inventory", "lots", "trace-lot", receiptId],
    queryFn: () => api<{ lot: LotView; movements: LotMovement[]; unaccountedQty: number }>(`/api/inventory/lots/trace/lot/${receiptId}`),
    enabled: !!receiptId,
  });
}

export interface BatchTrace {
  batch: { id: string; batchNo: string | null; productName: string; poNumber: string | null; customerName: string };
  materials: { itemId: string; itemName: string; category: "RM" | "PM"; unit: string; dispensedQty: number; lotUnknownQty: number; lots: (LotView & { usedQty: number })[] }[];
}

export function useBatchTrace(batchId: string | undefined) {
  return useQuery({ queryKey: ["inventory", "lots", "trace-batch", batchId], queryFn: () => api<BatchTrace>(`/api/inventory/lots/trace/batch/${batchId}`), enabled: !!batchId });
}

export function useMissingExpiry() {
  return useQuery({ queryKey: ["inventory", "lots", "missing-expiry"], queryFn: () => api<LotView[]>("/api/inventory/lots/missing-expiry") });
}

export interface ItemLots {
  item: { id: string; name: string; unit: string | null };
  warehouse: LotView[];
  places: { place: string; kind: "DAY_STORE" | "PLANT"; lots: LotView[] }[];
}

export function useItemLots(itemId: string | undefined) {
  return useQuery({ queryKey: ["inventory", "lots", "item", itemId], queryFn: () => api<ItemLots>(`/api/inventory/lots/item/${itemId}`), enabled: !!itemId });
}

// ---------------------------------------------------------------- approved vendors
// Which vendors a product may take a material from. See product-vendors.routes.ts in the API.

export type VendorRuleKind = "RM" | "PM";

export interface VendorProductRow {
  id: string;
  name: string;
  customerName: string | null;
  materialCount: number;
  restrictedCount: number;
}

export interface VendorProductMaterial {
  key: string;
  itemId: string | null;
  name: string;
  detail: string;
  approved: { vendorId: string; name: string }[];
}

export interface VendorProduct {
  kind: VendorRuleKind;
  id: string;
  name: string;
  customerName: string | null;
  materials: VendorProductMaterial[];
}

export interface WaitingBatch {
  batchId: string;
  batchNo: string | null;
  purchaseOrderItemId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  plantName: string;
  itemId: string;
  material: string;
  unit: string;
  neededQty: number;
  approvedQty: number;
  otherVendorsQty: number;
  approvedVendors: string[];
}

export interface VendorDeviationRow {
  id: string;
  purchaseOrderItemId: string;
  productName: string;
  poNumber: string | null;
  customerName: string;
  itemId: string;
  material: string;
  approvedVendors: string[];
  reason: string;
  approvedByName: string;
  createdAt: string;
}

export function useVendorOptions() {
  return useQuery({ queryKey: ["product-vendors", "vendors"], queryFn: () => api<{ id: string; name: string }[]>("/api/product-vendors/vendors") });
}

export function useVendorProducts(kind: VendorRuleKind, search: string) {
  return useQuery({
    queryKey: ["product-vendors", "products", kind, search],
    queryFn: () => api<VendorProductRow[]>(`/api/product-vendors/products?kind=${kind}&search=${encodeURIComponent(search)}`),
  });
}

export function useVendorProduct(kind: VendorRuleKind, id: string | null) {
  return useQuery({
    queryKey: ["product-vendors", "product", kind, id],
    queryFn: () => api<VendorProduct>(`/api/product-vendors/products/${kind}/${id}`),
    enabled: !!id,
  });
}

export function useSetMaterialVendors(kind: VendorRuleKind, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; itemId?: string; vendorIds: string[] }) => api<VendorProduct>(`/api/product-vendors/products/${kind}/${id}/materials`, { method: "PUT", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["product-vendors"] }),
  });
}

export function useWaitingForVendor() {
  return useQuery({ queryKey: ["product-vendors", "waiting"], queryFn: () => api<WaitingBatch[]>("/api/product-vendors/waiting") });
}

export function useVendorDeviations() {
  return useQuery({ queryKey: ["product-vendors", "deviations"], queryFn: () => api<VendorDeviationRow[]>("/api/product-vendors/deviations") });
}

export function useAllowOtherVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { purchaseOrderItemId: string; itemId: string; reason: string }) => api("/api/product-vendors/deviations", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["product-vendors"] }),
  });
}

export function useWithdrawDeviation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/product-vendors/deviations/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["product-vendors"] }),
  });
}
