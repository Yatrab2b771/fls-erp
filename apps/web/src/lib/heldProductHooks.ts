import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// PPIC puts a product on hold; Production holds (and releases) its batches that are still in preparation, one by one.
// Production can also hold a whole product itself, or cancel it (both from New Plan)
// (apps/api/src/modules/batches/batch-prep.routes.ts: held-products and :id/hold).

export interface HeldBatch {
  id: string;
  batchNo: string | null;
  plannedQty: number;
  /** Indent Issue, Batch No, Dispensing, Line Clearance, In production or Manufacturing done. */
  stageLabel: string;
  /** Already in production (or past it): it follows the whole pipeline and cannot be held. */
  inProduction: boolean;
  held: boolean;
  heldAt: string | null;
  heldByName: string | null;
  holdReason: string | null;
  canHold: boolean;
  canRelease: boolean;
}

export interface HeldProduct {
  itemId: string;
  poId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  quantity: number;
  unit: string;
  plantName: string | null;
  runId: string | null;
  /** PPIC's hold is on now (false: PPIC released it, but a batch of it is still held by Production). */
  productHeld: boolean;
  productHeldAt: string | null;
  /** Production's own hold on the whole product (released only by Production, from here). */
  productionHeld: boolean;
  productionHeldAt: string | null;
  productionHoldReason: string | null;
  productionHeldByName: string | null;
  batches: HeldBatch[];
}

export function useHeldProducts(options?: { enabled?: boolean }) {
  return useQuery({ queryKey: ["production-batches", "held-products"], queryFn: () => api<HeldProduct[]>("/api/production-batches/held-products"), enabled: options?.enabled });
}

export function useSetBatchHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, held, reason }: { id: string; held: boolean; reason?: string }) => api(`/api/production-batches/${id}/hold`, { method: "PATCH", body: { held, reason } }),
    // A held batch leaves its step's board and the counts, so every production-batches list is stale
    onSuccess: () => qc.invalidateQueries({ queryKey: ["production-batches"] }),
  });
}

export function useSetProductHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, held, reason }: { itemId: string; held: boolean; reason?: string }) => api(`/api/production-batches/products/${itemId}/hold`, { method: "PATCH", body: { held, reason } }),
    // A held product leaves New Plan (and its steps) for Held Products, and comes back when released
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["production-batches"] });
      void qc.invalidateQueries({ queryKey: ["pre-productions"] });
    },
  });
}

export function useCancelProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, reason }: { itemId: string; reason: string }) => api(`/api/production-batches/products/${itemId}/cancel`, { method: "POST", body: { reason } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["production-batches"] });
      void qc.invalidateQueries({ queryKey: ["pre-productions"] });
      void qc.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
  });
}

// Close short: the batches made less than was ordered and no more will be made, so the product ends at what it made (see close-short.ts in the API).
export function useCloseShort() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, reason }: { itemId: string; reason: string }) => api(`/api/production-batches/products/${itemId}/close-short`, { method: "POST", body: { reason } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["production-batches"] });
      void qc.invalidateQueries({ queryKey: ["pre-productions"] });
      void qc.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
  });
}

export function useReopenShort() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId }: { itemId: string }) => api(`/api/production-batches/products/${itemId}/reopen-short`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["production-batches"] });
      void qc.invalidateQueries({ queryKey: ["pre-productions"] });
      void qc.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
  });
}
