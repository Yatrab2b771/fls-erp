import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// Finance (Accounts): the short RM / PM that Purchase has logged a vendor, PO number and ETA for, and what Finance decided on each.
// See apps/api/src/modules/finance/finance.routes.ts.

export type FinanceStatus = "PENDING" | "PAID_PARTIAL" | "PAID_FULL" | "ON_HOLD" | "REJECTED";

export interface FinanceRow {
  lineId: string;
  piNumber: string;
  vendorName: string;
  eta: string;
  overdue: boolean;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  shortQty: number;
  orderedQty: number;
  customerPo: { poNumber: string | null; productName: string; customerName: string } | null;
  status: FinanceStatus;
  poAmount: number | null;
  paidTotal: number;
  balance: number | null;
  remarks: string | null;
  remarksAt: string | null;
  updatedBy: string | null;
  loggedAt: string;
  /** Finance's aging: days since Purchase logged the line, or since Finance's last remark. */
  waitingDays: number;
  payments: { id: string; amount: number; paidOn: string; remark: string | null }[];
}

export const useFinanceRows = (options?: { enabled?: boolean }) =>
  useQuery({ queryKey: ["finance", "payments"], queryFn: () => api<FinanceRow[]>("/api/finance/payments"), enabled: options?.enabled, staleTime: 10_000 });

function useFinanceAction<TVars>(call: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["finance"] });
      qc.invalidateQueries({ queryKey: ["pre-inventory"] });
    },
  });
}

export interface PaymentBody {
  kind: "PARTIAL" | "FULL";
  amount: number;
  poAmount?: number;
  paidOn?: string;
  remark?: string;
}
export const useFinancePayment = () => useFinanceAction(({ lineId, ...body }: { lineId: string } & PaymentBody) => api(`/api/finance/lines/${lineId}/payment`, { method: "POST", body }));
export const useFinanceHold = () => useFinanceAction(({ lineId, remark }: { lineId: string; remark: string }) => api(`/api/finance/lines/${lineId}/hold`, { method: "POST", body: { remark } }));
export const useFinanceReject = () => useFinanceAction(({ lineId, remark }: { lineId: string; remark: string }) => api(`/api/finance/lines/${lineId}/reject`, { method: "POST", body: { remark } }));
