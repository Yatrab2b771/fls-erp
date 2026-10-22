import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// Production's extra material: asked outside the plan, for one batch, from its own Plant's Store. See apps/api/src/modules/inventory/extra-requests.routes.ts.

export interface ExtraRequestRow {
  id: string;
  requestedAt: string;
  itemName: string;
  category: "RM" | "PM" | "OTHER";
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
  /** The batch the material is for (null on older requests that were raised for a product only). */
  batchId: string | null;
  batchNo: string | null;
  /** Production typed this material in because it was not in the item list. */
  newMaterial: boolean;
  storeStock: number;
  askedFromWarehouse: number;
  stage: "WITH_DAY_STORE" | "REQUESTED_FROM_WAREHOUSE" | "ISSUED_TO_DAY_STORE" | "ISSUED_TO_PLANT" | "CLOSED";
  stageLabel: string;
  supplyStage: "NONE" | "WITH_PPIC" | "WITH_PURCHASE" | "ON_ORDER" | "RECEIVED" | null;
  supplyLabel: string | null;
  purchaseEta: string | null;
  purchaseEtaLate: boolean;
  /** What the Store has dispensed for it that Production has not received yet (on its way to the Plant). */
  onItsWay: { id: string; quantity: number; grnNo: string | null }[];
  /** The GRN numbers of what was dispensed for it. */
  grnNos: string[];
}

export function useExtraRequests(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["extra-requests"],
    queryFn: () => api<ExtraRequestRow[]>("/api/inventory/extra-requests"),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

/** A batch Production can ask extra material for: it has a batch number and has not yet gone to the finished-goods store. */
export interface ExtraBatchOption {
  batchId: string;
  batchNo: string;
  /** The PO item (product on a PO) the batch belongs to. */
  itemId: string;
  productName: string;
  poNumber: string | null;
  plantId: string | null;
  plantName: string | null;
}

export function useExtraBatches(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["extra-requests", "batches"],
    queryFn: () => api<ExtraBatchOption[]>("/api/inventory/extra-requests/batches"),
    enabled: options?.enabled,
    staleTime: 60_000,
  });
}

export function useCreateExtraRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { itemId?: string; newItem?: { category: "RM" | "PM" | "OTHER"; name: string; unit: string }; requestedQty: number; reason: string; neededBy?: string; productionBatchId: string }) => api<{ id: string }>("/api/inventory/extra-requests", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["extra-requests"] });
      qc.invalidateQueries({ queryKey: ["inventory", "items"] }); // a typed-in material is now in the item list
    },
  });
}

export function useWithdrawExtraRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/inventory/extra-requests/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["extra-requests"] }),
  });
}
