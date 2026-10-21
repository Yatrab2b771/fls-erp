import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// A product's BOM versions (apps/api/src/modules/packaging-bom/bom-slots.ts): the catalog's own BOM is the Display BOM; R&D can keep V1 and V2.

export type SlotName = "V1" | "V2";

export interface RmSlotIngredient {
  name: string;
  brand: string;
  itemCode?: string | null;
  gPerServing: number;
  uom?: string;
  /** A 0-1 fraction (or a 0-100 percentage). */
  proteinPct: number;
}
export interface RmSlotSnapshot {
  kind?: "PER_KG" | "PER_UNIT";
  productCode?: string | null;
  versionLabel?: string | null;
  batchSize?: number | null;
  avgUnitWeightMg?: number | null;
  ingredients: RmSlotIngredient[];
}
export interface PmSlotComponent {
  type: string;
  quantity?: number | null;
  unit?: string;
  pmCode?: string | null;
  pmItemId?: string | null;
  /** A fraction: 0.02 = 2%. */
  overagePct?: number | null;
  spec?: string | null;
  make?: string | null;
  packingLevel?: string | null;
}
export interface PmSlotHeader {
  productCode?: string | null;
  packSize?: string | null;
  packingConfig?: string | null;
  batchPacks?: number | null;
}
export interface PmSlotSnapshot {
  header?: PmSlotHeader;
  components: PmSlotComponent[];
}

export interface BomSlotVersion {
  slot: SlotName;
  rm: RmSlotSnapshot | null;
  pm: PmSlotSnapshot | null;
  note: string | null;
  updatedAt: string;
  updatedByName: string | null;
}
export interface BomSlotDetail {
  customerId: string;
  customerName: string | null;
  productName: string;
  display: { rm: RmSlotSnapshot | null; pm: PmSlotSnapshot | null };
  slots: Record<SlotName, BomSlotVersion | null>;
}
export interface BomSlotProduct {
  customerId: string;
  customerName: string;
  productName: string;
  hasRm: boolean;
  hasPm: boolean;
  slots: Record<SlotName, { rm: boolean; pm: boolean; updatedAt: string } | null>;
}

export function useBomSlotProducts(search: string) {
  return useQuery({ queryKey: ["bom-slots", "products", search], queryFn: () => api<BomSlotProduct[]>(`/api/bom-slots/products?search=${encodeURIComponent(search)}`) });
}

export function useBomSlotDetail(customerId: string | undefined, productName: string | undefined) {
  return useQuery({
    queryKey: ["bom-slots", "detail", customerId, productName],
    queryFn: () => api<BomSlotDetail>(`/api/bom-slots?customerId=${encodeURIComponent(customerId!)}&productName=${encodeURIComponent(productName!)}`),
    enabled: !!customerId && !!productName,
  });
}

function useSlotMutation<V>(fn: (v: V) => Promise<BomSlotDetail>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ["bom-slots"] }) });
}

export function useSaveBomSlot() {
  return useSlotMutation((v: { slot: SlotName; customerId: string; productName: string; rm?: RmSlotSnapshot | null; pm?: PmSlotSnapshot | null; note?: string }) => {
    const { slot, ...body } = v;
    return api<BomSlotDetail>(`/api/bom-slots/${slot}`, { method: "PUT", body });
  });
}

export function useCopyBomSlot() {
  return useSlotMutation((v: { slot: SlotName; customerId: string; productName: string }) => {
    const { slot, ...body } = v;
    return api<BomSlotDetail>(`/api/bom-slots/${slot}/copy-from-display`, { method: "POST", body });
  });
}

export function useEmptyBomSlot() {
  return useSlotMutation((v: { slot: SlotName; customerId: string; productName: string }) =>
    api<BomSlotDetail>(`/api/bom-slots/${v.slot}?customerId=${encodeURIComponent(v.customerId)}&productName=${encodeURIComponent(v.productName)}`, { method: "DELETE" }),
  );
}
