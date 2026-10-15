import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

// R&D's BOM tile: for each product on an approved PO, is its RM BOM and its Packaging BOM ready? (apps/api/src/modules/packaging-bom/bom-board.ts)
export type BomPartStatus = "READY" | "MISSING" | "COMMON" | "OLD_SPEC" | "NOT_APPLICABLE";

export interface BomBoardRow {
  itemId: string;
  poId: string;
  poNumber: string | null;
  customerId: string;
  customerName: string;
  productName: string;
  productCategory: string | null;
  quantity: number;
  unit: string;
  orderDate: string | null;
  expectedDeliveryDate: string | null;
  rm: BomPartStatus;
  rmVersion: number | null;
  pm: BomPartStatus;
  pmVersion: number | null;
  packSizeKnown: boolean;
  needsWork: boolean;
  waitingSince: string;
}

export function useBomBoard(options?: { enabled?: boolean }) {
  return useQuery({ queryKey: ["bom-board"], queryFn: () => api<BomBoardRow[]>("/api/bom-board"), enabled: options?.enabled });
}
