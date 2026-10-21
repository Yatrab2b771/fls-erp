import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// Customer returns: the Warehouse records them, QA decides, Production reworks, Dispatch places them, Accounts raises the credit note.
// See customer-returns.routes.ts in the API.

export type CustomerReturnStatus = "WITH_QA" | "IN_REWORK" | "AWAITING_DISPATCH" | "STORED" | "TO_BE_RESENT" | "SCRAPPED";

export const RETURN_STATUS_LABEL: Record<CustomerReturnStatus, string> = {
  WITH_QA: "With QA",
  IN_REWORK: "In rework",
  AWAITING_DISPATCH: "Waiting for Dispatch",
  STORED: "Stored in Warehouse",
  TO_BE_RESENT: "To be sent again",
  SCRAPPED: "Scrapped",
};

export const RETURN_STATUS_PILL: Record<CustomerReturnStatus, string> = {
  WITH_QA: "border-violet-200 bg-violet-50 text-violet-700",
  IN_REWORK: "border-amber-200 bg-amber-50 text-amber-700",
  AWAITING_DISPATCH: "border-sky-200 bg-sky-50 text-sky-700",
  STORED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  TO_BE_RESENT: "border-emerald-200 bg-emerald-50 text-emerald-700",
  SCRAPPED: "border-rose-200 bg-rose-50 text-rose-700",
};

export interface CustomerReturn {
  id: string;
  status: CustomerReturnStatus;
  batchId: string;
  batchNo: string | null;
  poId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  plantName: string | null;
  unit: string;
  quantity: number;
  returnedAt: string;
  reason: string;
  condition: string | null;
  receivedAt: string;
  qa: { decision: string; note: string | null; at: string | null; passedQty: number | null; scrapQty: number } | null;
  rework: { note: string | null; reworkedQty: number | null; doneAt: string } | null;
  reworked: boolean;
  dispatch: { choice: string; note: string | null; at: string | null } | null;
  creditNote: { id: string; no: string; date: string; amount: number | null; note: string | null } | null;
  /** The reworks sent to New Plan for this return (each with its sub-number), and how much of it is not in New Plan yet. */
  reworks: { id: string; reworkNo: string; status: string; quantity: number; outputQty: number | null }[];
  reworkLeft: number;
  suggestedAmount: number | null;
}

export interface ReturnableBatch {
  batchId: string;
  batchNo: string | null;
  poNumber: string | null;
  customerName: string;
  productName: string;
  unit: string;
  withCustomerQty: number;
  invoiceNos: string[];
}

export interface CustomerReturnSummary {
  withQa: number;
  inRework: number;
  awaitingDispatch: number;
  open: number;
  noCreditNote: number;
}

export function useCustomerReturns(options?: { enabled?: boolean }) {
  return useQuery({ queryKey: ["customer-returns", "list"], queryFn: () => api<CustomerReturn[]>("/api/customer-returns"), enabled: options?.enabled, staleTime: 10_000 });
}

export function useCustomerReturnSummary(options?: { enabled?: boolean }) {
  return useQuery({ queryKey: ["customer-returns", "summary"], queryFn: () => api<CustomerReturnSummary>("/api/customer-returns/summary"), enabled: options?.enabled, staleTime: 15_000 });
}

export function useReturnableBatches(options?: { enabled?: boolean }) {
  return useQuery({ queryKey: ["customer-returns", "returnable"], queryFn: () => api<ReturnableBatch[]>("/api/customer-returns/returnable"), enabled: options?.enabled });
}

function useReturnMutation<TBody extends object>(path: (body: TBody) => string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) => api<CustomerReturn>(path(body), { method: "POST", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["customer-returns"] });
      // The stock and the Dispatch board follow a return
      void qc.invalidateQueries({ queryKey: ["inventory"] });
      void qc.invalidateQueries({ queryKey: ["fg"] });
      void qc.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
  });
}

export const useRecordCustomerReturn = () => useReturnMutation<{ batchId: string; quantity: number; reason: string; condition?: string; returnedAt?: string }>(() => "/api/customer-returns");
export const useQaDecision = () => useReturnMutation<{ id: string; decision: "PASS" | "REWORK" | "SCRAP"; passedQty?: number; note?: string }>((b) => `/api/customer-returns/${b.id}/qa`);
export const useReworkDone = () => useReturnMutation<{ id: string; reworkedQty: number; note?: string }>((b) => `/api/customer-returns/${b.id}/rework-done`);
export const useDispatchChoice = () => useReturnMutation<{ id: string; choice: "STORE" | "REDISPATCH"; note?: string }>((b) => `/api/customer-returns/${b.id}/dispatch`);
export const useCreditNote = () => useReturnMutation<{ id: string; creditNoteNo: string; date?: string; amount?: number; note?: string }>((b) => `/api/customer-returns/${b.id}/credit-note`);
