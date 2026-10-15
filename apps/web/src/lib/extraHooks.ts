import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// Production's extra material: asked outside any plan, from its own Plant's Day Store. See apps/api/src/modules/inventory/extra-requests.routes.ts.

export interface ExtraRequestRow {
  id: string;
  requestedAt: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  requestedQty: number;
  issuedQty: number;
  remainingQty: number;
  neededBy: string | null;
  overdue: boolean;
  statusKey: string;
  status: string;
  open: boolean;
  plantName: string | null;
  storeName: string | null;
  requestedBy: string;
  note: string | null;
  refProduct: string | null;
  refPoNumber: string | null;
  storeStock: number;
  askedFromWarehouse: number;
  stage: "WITH_DAY_STORE" | "REQUESTED_FROM_WAREHOUSE" | "ISSUED_TO_DAY_STORE" | "ISSUED_TO_PLANT" | "CLOSED";
  stageLabel: string;
  supplyStage: "NONE" | "WITH_PPIC" | "WITH_PURCHASE" | "ON_ORDER" | "RECEIVED" | null;
  supplyLabel: string | null;
  purchaseEta: string | null;
  purchaseEtaLate: boolean;
}

export function useExtraRequests(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["extra-requests"],
    queryFn: () => api<ExtraRequestRow[]>("/api/inventory/extra-requests"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

export function useExtraRequestOptions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["extra-requests", "options"],
    queryFn: () => api<{ plants: { id: string; name: string }[] }>("/api/inventory/extra-requests/options"),
    enabled: options?.enabled,
    staleTime: 60_000,
  });
}

export function useCreateExtraRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { itemId: string; requestedQty: number; reason: string; neededBy?: string; plantId?: string; purchaseOrderItemId?: string }) => api<{ id: string }>("/api/inventory/extra-requests", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["extra-requests"] }),
  });
}

export function useWithdrawExtraRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/inventory/extra-requests/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["extra-requests"] }),
  });
}
