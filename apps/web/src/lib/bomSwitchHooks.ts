import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// R&D's change of the BOM version a product's plan is made from (apps/api/src/modules/packaging-bom/bom-switch.ts).

export type PlanSlot = "DISPLAY" | "V1" | "V2";

export interface BomSwitchInfo {
  itemId: string;
  productName: string;
  customerId: string;
  /** The version the product is made from now (for a product with Production: R&D's choice for its batches). */
  activeSlot: PlanSlot;
  /** PLANNING = still with PPIC (the plan itself changes); PRODUCTION = with Production (only the batches change, PPIC is not told). */
  phase: "PLANNING" | "PRODUCTION";
  /** Why the version can't be changed any more (null = it can). */
  locked: string | null;
  planSent: boolean;
  held: boolean;
  display: { rm: boolean; pm: boolean };
  slots: Record<"V1" | "V2", { rm: boolean; pm: boolean; note: string | null } | null>;
  /** Materials Purchase already has a PI on: they stay and arrive even if the new plan does not need them. */
  onOrder: { material: string; type: string; pis: string[] }[];
  switches: { fromSlot: string; toSlot: string; reason: string; phase: string; actorName: string | null; createdAt: string }[];
}

export interface BomSwitchResult {
  ok: true;
  slot: PlanSlot;
  phase: "PLANNING" | "PRODUCTION";
  shortages: { type: string; material: string; unit: string; shortQty: number }[];
  ready: boolean;
  /** With Production: what changes in the material (whole order), and which batches follow the new version. */
  changes: { type: string; material: string; unit: string; oldQty: number; newQty: number }[];
  batches: { batchNo: string | null; dispensed: boolean }[];
  /** With Production: what was asked from the Day Store for the batches already dispensed (the new version's need beyond what they were given). */
  extraRequests: { batchNo: string | null; material: string; unit: string; qty: number }[];
}

export interface InProductionBomRow {
  purchaseOrderItemId: string;
  purchaseOrderId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  plantName: string | null;
  quantity: number;
  unit: string;
  activeBomSlot: string;
  held: boolean;
  batches: { total: number; notDispensed: number; inProduction: number; beyond: number };
}

export function useInProductionBom(enabled = true) {
  return useQuery({ queryKey: ["bom-switch", "in-production"], queryFn: () => api<InProductionBomRow[]>("/api/bom-slots/in-production"), enabled, staleTime: 15_000 });
}

export function useBomSwitchInfo(itemId: string | null) {
  return useQuery({ queryKey: ["bom-switch", "item", itemId], queryFn: () => api<BomSwitchInfo>(`/api/bom-slots/item/${itemId}`), enabled: !!itemId });
}

export function useBomPlanningSummary(enabled = true) {
  return useQuery({ queryKey: ["bom-switch", "summary"], queryFn: () => api<{ short: number; ready: number; changedByRnd: number }>("/api/bom-slots/planning-summary"), enabled, staleTime: 15_000 });
}

export function useSwitchBom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { purchaseOrderItemId: string; slot: PlanSlot; reason: string }) => api<BomSwitchResult>("/api/bom-slots/switch", { method: "POST", body: v }),
    onSuccess: () => {
      // The plan changed: Material Planning, PO Readiness, the dashboards and the Day Store's requests all follow.
      qc.invalidateQueries({ queryKey: ["bom-switch"] });
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["ppic"] });
    },
  });
}
