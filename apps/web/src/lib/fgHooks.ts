import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// Finished goods after Packaging: the Day Store receives them, QA approves them, the Day Store hands them to Dispatch, and Dispatch ships
// them in parts to the customer or the Warehouse (the Warehouse is asked first). See apps/api/src/modules/batches/fg.routes.ts.

export type FgShipmentStatus = "REQUESTED" | "ACCEPTED" | "REJECTED" | "SENT" | "RECEIVED" | "DISPATCHED" | "WITH_ACCOUNTS" | "READY_TO_SEND" | "SENT_BACK";

export interface FgShipment {
  id: string;
  type: "CUSTOMER" | "WAREHOUSE" | "FROM_WAREHOUSE";
  status: FgShipmentStatus;
  quantity: number;
  note: string | null;
  requestedAt: string;
  acceptedAt: string | null;
  rejectedReason: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  dispatchDate: string | null;
  transportType: string | null;
  pickedBy: string | null;
  pickingDate: string | null;
  loadedBy: string | null;
  loadingDate: string | null;
  remarks: string | null;
  transportName: string | null;
  vehicleNo: string | null;
  lrNo: string | null;
  weightKg: number | null;
  cartonCount: number | null;
  goodsValue: number | null;
  freightCharge: number | null;
  insuranceCharge: number | null;
  invoiceAmount: number | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  ewayBillNo: string | null;
  ewayBillDate: string | null;
}

export interface FgBatchRow {
  batchId: string;
  batchNo: string | null;
  poId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  productCategory: string | null;
  unit: string;
  plantName: string | null;
  currentStageId: string;
  approvedQty: number;
  shippedQty: number;
  remainingQty: number;
  fgStoreReceivedDate: string | null;
  fgStoreRemarks: string | null;
  fgQaStatus: string | null;
  fgQcStatus: string | null;
  fgRemarks: string | null;
  handedOverAt: string | null;
  waitingSince: string;
  shipments: FgShipment[];
}

export interface FgWarehouseRequestRow extends FgShipment {
  batchId: string;
  batchNo: string | null;
  productName: string;
  unit: string;
  poNumber: string | null;
  customerName: string;
  plantName: string | null;
}

export type FgStoreStage = "FG_STORE" | "FG_QC_RELEASE" | "FG_HANDOVER";

export function useFgStoreBoard(stage: FgStoreStage, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["fg", "store-board", stage],
    queryFn: () => api<FgBatchRow[]>(`/api/fg/store-board?stage=${stage}`),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

export function useFgDispatchBoard(options?: { enabled?: boolean; shipped?: boolean }) {
  return useQuery({
    queryKey: ["fg", "dispatch-board", !!options?.shipped],
    queryFn: () => api<FgBatchRow[]>(`/api/fg/dispatch-board${options?.shipped ? "?shipped=1" : ""}`),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

export function useFgWarehouseRequests(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["fg", "warehouse-requests"],
    queryFn: () => api<FgWarehouseRequestRow[]>("/api/fg/warehouse-requests"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

/** Dispatch's requests to the Warehouse for finished goods it holds (to send to a customer): the Warehouse sends them, Dispatch confirms. */
export function useFgStockRequests(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["fg", "stock-requests"],
    queryFn: () => api<FgWarehouseRequestRow[]>("/api/fg/stock-requests"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

/** Customer shipments still on their way to being sent: with Accounts for the invoice, ready to send, or sent back to Dispatch. */
export function useAccountsQueue(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["fg", "accounts-queue"],
    queryFn: () => api<FgWarehouseRequestRow[]>("/api/fg/accounts-queue"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

/** Moves a batch one stage forward with that stage's fields (receive at the Day Store, QA approval, hand over to Dispatch). */
export function useFgStageForward() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ batchId, ...body }: { batchId: string } & Record<string, unknown>) => api<unknown>(`/api/production-batches/${batchId}/stage`, { method: "PATCH", body: { action: "FORWARD", ...body } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fg"] }),
  });
}

function useFgAction<TVars>(call: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fg"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export interface FgShipDetails {
  quantity: number;
  dispatchDate?: string;
  transportType?: string;
  pickedBy?: string;
  pickingDate?: string;
  loadedBy?: string;
  loadingDate?: string;
  remarks?: string;
  transportName?: string;
  vehicleNo?: string;
  lrNo?: string;
  weightKg?: number;
  cartonCount?: number;
  goodsValue?: number;
  freightCharge?: number;
  insuranceCharge?: number;
  invoiceNo?: string;
  invoiceDate?: string;
}

export const useShipToCustomer = () => useFgAction(({ batchId, ...body }: { batchId: string } & FgShipDetails) => api(`/api/fg/batches/${batchId}/customer-shipments`, { method: "POST", body }));
export const useRequestWarehouse = () => useFgAction(({ batchId, ...body }: { batchId: string; note?: string } & FgShipDetails) => api(`/api/fg/batches/${batchId}/warehouse-requests`, { method: "POST", body }));
export const useSendToWarehouse = () => useFgAction(({ id, ...body }: { id: string } & Omit<FgShipDetails, "quantity">) => api(`/api/fg/shipments/${id}/send`, { method: "POST", body }));
export const useWithdrawShipment = () => useFgAction((id: string) => api(`/api/fg/shipments/${id}`, { method: "DELETE" }));
export const useDecideWarehouseRequest = () => useFgAction(({ id, ...body }: { id: string; action: "ACCEPT" | "REJECT"; reason?: string }) => api(`/api/fg/shipments/${id}/decision`, { method: "PATCH", body }));
export const useReceiveFromDispatch = () => useFgAction((id: string) => api(`/api/fg/shipments/${id}/receive`, { method: "POST" }));
export const useAddShipmentInvoice = () => useFgAction(({ id, ...body }: { id: string; invoiceNo?: string; invoiceDate?: string; ewayBillNo?: string; ewayBillDate?: string }) => api(`/api/fg/shipments/${id}/invoice`, { method: "PATCH", body }));

export const useRequestFgStock = () => useFgAction(({ batchId, ...body }: { batchId: string; quantity: number; note?: string }) => api(`/api/fg/batches/${batchId}/stock-requests`, { method: "POST", body }));
export const useSendFgToDispatch = () => useFgAction((id: string) => api(`/api/fg/shipments/${id}/send-to-dispatch`, { method: "POST" }));
export const useRefuseFgStockRequest = () => useFgAction(({ id, reason }: { id: string; reason: string }) => api(`/api/fg/shipments/${id}/refuse-stock-request`, { method: "POST", body: { reason } }));
export const useReceiveFgFromWarehouse = () => useFgAction((id: string) => api(`/api/fg/shipments/${id}/receive-from-warehouse`, { method: "POST" }));

export interface AccountsFields {
  invoiceNo: string;
  invoiceDate?: string;
  invoiceAmount?: number;
  ewayBillNo?: string;
  ewayBillDate?: string;
}
export const useAccountsApprove = () => useFgAction(({ id, ...body }: { id: string } & AccountsFields) => api(`/api/fg/shipments/${id}/accounts-approve`, { method: "POST", body }));
export const useAccountsReturn = () => useFgAction(({ id, reason }: { id: string; reason: string }) => api(`/api/fg/shipments/${id}/accounts-return`, { method: "POST", body: { reason } }));
export const useResubmitShipment = () => useFgAction(({ id, ...body }: { id: string } & Partial<Omit<FgShipDetails, "quantity">>) => api(`/api/fg/shipments/${id}/resubmit`, { method: "POST", body }));
export const useSendToCustomer = () => useFgAction((id: string) => api(`/api/fg/shipments/${id}/send-to-customer`, { method: "POST" }));
