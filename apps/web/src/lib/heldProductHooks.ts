import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// PPIC puts a product on hold; Production holds (and releases) its batches that are still in preparation, one by one
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
