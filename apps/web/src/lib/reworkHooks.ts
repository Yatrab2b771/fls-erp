import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// Reworks of goods a customer returned: shown in New Plan with a "Rework" tag and a sub-number of the original batch (see reworks.routes.ts).

export type ReworkStatus = "PLANNED" | "IN_PROGRESS" | "COMPLETED";

export interface Rework {
  id: string;
  reworkNo: string;
  status: ReworkStatus;
  quantity: number;
  unit: string;
  shift: "Day" | "Night" | null;
  manpowerCount: number | null;
  startAt: string | null;
  endAt: string | null;
  outputQty: number | null;
  note: string | null;
  createdAt: string;
  completedAt: string | null;
  returnId: string;
  returnStatus: string;
  returnQty: number;
  returnReason: string;
  qaNote: string | null;
  batchId: string;
  batchNo: string | null;
  poId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  productCategory: string | null;
  plantId: string | null;
  plantName: string | null;
  materials: { id: string; itemId: string; itemName: string; category: string; quantity: number; unit: string }[];
}

export function useReworks(options?: { enabled?: boolean }) {
  return useQuery({ queryKey: ["reworks", "list"], queryFn: () => api<Rework[]>("/api/reworks"), enabled: options?.enabled, staleTime: 10_000 });
}

function useReworkMutation<TBody, TRes>(run: (body: TBody) => Promise<TRes>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["reworks"] });
      void qc.invalidateQueries({ queryKey: ["customer-returns"] });
      // The material used comes out of the Plant's stock
      void qc.invalidateQueries({ queryKey: ["plant-stock"] });
      void qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export const useSendToNewPlan = () => useReworkMutation((b: { customerReturnId: string; quantity?: number }) => api<Rework>("/api/reworks", { method: "POST", body: b }));
export const useSaveReworkSheet = () => useReworkMutation((b: { id: string; shift?: "Day" | "Night"; manpowerCount?: number; startAt?: string; endAt?: string }) => {
  const { id, ...body } = b;
  return api<Rework>(`/api/reworks/${id}`, { method: "PATCH", body });
});
export const useAddReworkMaterial = () => useReworkMutation((b: { id: string; itemId: string; quantity: number }) => api<Rework>(`/api/reworks/${b.id}/materials`, { method: "POST", body: { itemId: b.itemId, quantity: b.quantity } }));
export const useRemoveReworkMaterial = () => useReworkMutation((b: { id: string; lineId: string }) => api<Rework>(`/api/reworks/${b.id}/materials/${b.lineId}`, { method: "DELETE" }));
export const useCompleteRework = () => useReworkMutation((b: { id: string; endAt: string; outputQty: number; note?: string }) => api<Rework & { sentToQa: boolean }>(`/api/reworks/${b.id}/complete`, { method: "POST", body: { endAt: b.endAt, outputQty: b.outputQty, note: b.note } }));
export const useSendReturnToQa = () => useReworkMutation((b: { returnId: string }) => api<{ sentToQa: boolean }>(`/api/reworks/for-return/${b.returnId}/send-to-qa`, { method: "POST" }));
export const useRemoveRework = () => useReworkMutation((b: { id: string }) => api(`/api/reworks/${b.id}`, { method: "DELETE" }));
