import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// QA/QC's own stages, one list each (see apps/api/src/modules/qc/qc-board.ts): IPQC, the two QA gates and
// the finished-goods release are batches.

export type QcBoardStage = "IPQC" | "QA_GATE_MFG" | "QA_GATE_PACKAGING" | "FG_QC_RELEASE";
export type QcBoardView = QcBoardStage | "ON_HOLD";

export interface QcBoardRow {
  kind: "BATCH";
  id: string;
  stage: QcBoardStage;
  stageLabel: string;
  poId: string;
  poNumber: string | null;
  customerName: string;
  productName: string;
  productCategory: string | null;
  unit: string;
  plantName: string | null;
  orderDate: string | null;
  expectedDeliveryDate: string | null;
  batchNo: string | null;
  plannedQty: number;
  outputQty: number | null;
  shift: string | null;
  manpowerCount: number | null;
  manufacturingStart: string | null;
  manufacturingEnd: string | null;
  completedAt: string | null;
  qaStatus: string | null;
  qcStatus: string | null;
  remarks: string | null;
  approvedQty: number | null;
  rejectedQty: number | null;
  wastageQty: number | null;
  isHold: boolean;
  waitingSince: string;
  link: string;
}

export type QcStageCounts = Record<QcBoardView, number>;

export function useQcBoard(view: QcBoardView, options?: { enabled?: boolean }) {
  return useQuery({ queryKey: ["qc-board", view], queryFn: () => api<QcBoardRow[]>(`/api/qc/board?stage=${view}`), enabled: options?.enabled });
}

export function useQcStageCounts(options?: { enabled?: boolean }) {
  return useQuery({ queryKey: ["qc-board", "counts"], queryFn: () => api<QcStageCounts>("/api/qc/stage-counts"), enabled: options?.enabled });
}

export type QcDecision = "APPROVE" | "HOLD" | "REJECT";

export interface QcActInput {
  row: QcBoardRow;
  decision: QcDecision;
  remarks: string;
  approvedQty?: number;
  rejectedQty?: number;
  wastageQty?: number;
}

// Builds the body the stage endpoint already understands. Approve and Hold both move through the stage's FORWARD action with the status
// filled in: only a real Approved moves the item on, Hold keeps it at the stage. Reject sends it back to the stage before, with a reason.
export function buildQcStageBody(i: QcActInput): Record<string, unknown> {
  const { row, decision, remarks } = i;
  if (decision === "REJECT") return { action: "REJECT", note: remarks };
  const status = decision === "APPROVE" ? "Approved" : "Hold";
  const note = remarks.trim() || undefined;
  switch (row.stage) {
    case "IPQC":
      return { action: "FORWARD", ipqcStatus: status, ipqcRemarks: note };
    case "QA_GATE_MFG":
      return { action: "FORWARD", mfgQaStatus: status, mfgQcStatus: status, mfgRemarks: note, mfgApprovedQty: i.approvedQty, mfgRejectedQty: i.rejectedQty, mfgWastageQty: i.wastageQty };
    case "QA_GATE_PACKAGING":
      return { action: "FORWARD", packQaStatus: status, packQcStatus: status, packRemarks: note, packApprovedQty: i.approvedQty, packRejectedQty: i.rejectedQty, packWastageQty: i.wastageQty };
    case "FG_QC_RELEASE":
      return { action: "FORWARD", fgQaStatus: status, fgQcStatus: status, fgRemarks: note };
  }
}

export function useQcAct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (i: QcActInput) => api(`/api/production-batches/${i.row.id}/stage`, { method: "PATCH", body: buildQcStageBody(i) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["qc-board"] });
      qc.invalidateQueries({ queryKey: ["qc"] });
      qc.invalidateQueries({ queryKey: ["fg"] });
    },
  });
}
