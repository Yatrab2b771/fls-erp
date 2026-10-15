import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// BD asks PPIC to hold or cancel a product; PPIC decides (apps/api/src/modules/purchase-orders/item-change-requests.routes.ts).
export type ItemChangeKind = "HOLD" | "CANCEL";
export type ItemChangeStatus = "PENDING" | "ACCEPTED" | "REJECTED";

export interface ItemChangeRequest {
  id: string;
  kind: ItemChangeKind;
  reason: string;
  status: ItemChangeStatus;
  requestedByName: string;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  poId: string;
  poNumber: string | null;
  customerName: string;
  itemId: string;
  productName: string;
  productCategory: string | null;
  quantity: number;
  unit: string;
  plantName: string | null;
  isHeld: boolean;
  isCancelled: boolean;
  /** PPIC has already sent the plan to Production (no batch yet). */
  planSent: boolean;
  hasBatch: boolean;
}

export const ITEM_CHANGE_LABEL: Record<ItemChangeKind, string> = { HOLD: "Hold", CANCEL: "Cancel" };

export function useItemChangeRequests(status: ItemChangeStatus | "ALL" = "PENDING", options?: { enabled?: boolean }) {
  return useQuery({ queryKey: ["item-change-requests", status], queryFn: () => api<ItemChangeRequest[]>(`/api/item-change-requests?status=${status}`), enabled: options?.enabled });
}

export function useCreateItemChangeRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { purchaseOrderItemId: string; kind: ItemChangeKind; reason: string }) => api<ItemChangeRequest>("/api/item-change-requests", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["item-change-requests"] });
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
  });
}

export function useDecideItemChangeRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: "ACCEPT" | "REJECT"; note?: string }) => api<ItemChangeRequest>(`/api/item-change-requests/${id}`, { method: "PATCH", body: { action, note } }),
    onSuccess: () => {
      // Accepting changes the product (held or cancelled), so every list that shows it is stale
      qc.invalidateQueries();
    },
  });
}
