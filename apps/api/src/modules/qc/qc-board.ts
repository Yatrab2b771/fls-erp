import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { requireAuth, requireRole } from "../../common/middleware/auth";

// QA/QC's own stages, one list each: Line Clearance (a run, before its batches are made), then IPQC, the two QA gates and the
// finished-goods release (a batch each). Every row carries everything QA needs to decide without opening anything: the PO, customer,
// product, plant, quantities, the shift, what was filled at this stage, and how long it has been waiting.

export type QcBoardStage = "LINE_CLEARANCE" | "IPQC" | "QA_GATE_MFG" | "QA_GATE_PACKAGING" | "FG_QC_RELEASE";
export const QC_BOARD_STAGES: QcBoardStage[] = ["LINE_CLEARANCE", "IPQC", "QA_GATE_MFG", "QA_GATE_PACKAGING", "FG_QC_RELEASE"];

const STAGE_LABEL: Record<QcBoardStage, string> = {
  LINE_CLEARANCE: "Line Clearance",
  IPQC: "IPQC",
  QA_GATE_MFG: "QA Gate: Manufacturing",
  QA_GATE_PACKAGING: "QA Gate: Packaging",
  FG_QC_RELEASE: "FG QC & Release",
};

export interface QcBoardRow {
  /** RUN = a pre-production run (Line Clearance); BATCH = one production batch. Decides which stage endpoint the action calls. */
  kind: "RUN" | "BATCH";
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
  /** The stage's own QA status (and QC status, where the stage has both). */
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

const itemSelect = {
  productName: true,
  productCategory: true,
  unit: true,
  purchaseOrder: { select: { id: true, poNumber: true, orderDate: true, expectedDeliveryDate: true, customer: { select: { companyName: true } } } },
} satisfies Prisma.PurchaseOrderItemSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function runsAtLineClearance(): Promise<QcBoardRow[]> {
  const runs = await prisma.preProduction.findMany({
    where: { currentStageId: "SAMPLE_QC_APPROVAL", purchaseOrderItem: { cancelledAt: null, materialHeldAt: null }, OR: [{ sampleQcStatus: null }, { sampleQcStatus: { not: "Approved" } }] },
    select: { id: true, plannedQty: true, sampleQcStatus: true, sampleQcRemarks: true, updatedAt: true, plant: { select: { name: true } }, purchaseOrderItem: { select: itemSelect } },
    orderBy: { updatedAt: "asc" },
  });
  return runs.map((r) => ({
    kind: "RUN" as const,
    id: r.id,
    stage: "LINE_CLEARANCE" as const,
    stageLabel: STAGE_LABEL.LINE_CLEARANCE,
    poId: r.purchaseOrderItem.purchaseOrder.id,
    poNumber: r.purchaseOrderItem.purchaseOrder.poNumber,
    customerName: r.purchaseOrderItem.purchaseOrder.customer.companyName,
    productName: r.purchaseOrderItem.productName,
    productCategory: r.purchaseOrderItem.productCategory,
    unit: r.purchaseOrderItem.unit,
    plantName: r.plant?.name ?? null,
    orderDate: iso(r.purchaseOrderItem.purchaseOrder.orderDate),
    expectedDeliveryDate: iso(r.purchaseOrderItem.purchaseOrder.expectedDeliveryDate),
    batchNo: null,
    plannedQty: r.plannedQty,
    outputQty: null,
    shift: null,
    manpowerCount: null,
    manufacturingStart: null,
    manufacturingEnd: null,
    completedAt: null,
    qaStatus: r.sampleQcStatus,
    qcStatus: null,
    remarks: r.sampleQcRemarks,
    approvedQty: null,
    rejectedQty: null,
    wastageQty: null,
    isHold: r.sampleQcStatus === "Hold",
    waitingSince: r.updatedAt.toISOString(),
    link: `/pre-productions/${r.id}`,
  }));
}

const batchSelect = {
  id: true,
  batchNo: true,
  plannedQty: true,
  outputQty: true,
  shift: true,
  manpowerCount: true,
  shiftStartAt: true,
  shiftEndAt: true,
  manufacturingStartDate: true,
  manufacturingEndDate: true,
  completedAt: true,
  updatedAt: true,
  ipqcStatus: true,
  ipqcRemarks: true,
  mfgQaStatus: true,
  mfgQcStatus: true,
  mfgRemarks: true,
  mfgApprovedQty: true,
  mfgRejectedQty: true,
  mfgWastageQty: true,
  packQaStatus: true,
  packQcStatus: true,
  packRemarks: true,
  packApprovedQty: true,
  packRejectedQty: true,
  packWastageQty: true,
  fgQaStatus: true,
  fgQcStatus: true,
  fgRemarks: true,
  preProduction: { select: { plant: { select: { name: true } }, purchaseOrderItem: { select: itemSelect } } },
} satisfies Prisma.ProductionBatchSelect;

type BatchRow = Prisma.ProductionBatchGetPayload<{ select: typeof batchSelect }>;

function batchRow(b: BatchRow, stage: Exclude<QcBoardStage, "LINE_CLEARANCE">): QcBoardRow {
  const item = b.preProduction.purchaseOrderItem;
  const po = item.purchaseOrder;
  const stageFields = {
    IPQC: { qa: b.ipqcStatus, qc: null, remarks: b.ipqcRemarks, approved: null, rejected: null, wastage: null },
    QA_GATE_MFG: { qa: b.mfgQaStatus, qc: b.mfgQcStatus, remarks: b.mfgRemarks, approved: b.mfgApprovedQty, rejected: b.mfgRejectedQty, wastage: b.mfgWastageQty },
    QA_GATE_PACKAGING: { qa: b.packQaStatus, qc: b.packQcStatus, remarks: b.packRemarks, approved: b.packApprovedQty, rejected: b.packRejectedQty, wastage: b.packWastageQty },
    FG_QC_RELEASE: { qa: b.fgQaStatus, qc: b.fgQcStatus, remarks: b.fgRemarks, approved: b.packApprovedQty, rejected: null, wastage: null },
  }[stage];
  return {
    kind: "BATCH",
    id: b.id,
    stage,
    stageLabel: STAGE_LABEL[stage],
    poId: po.id,
    poNumber: po.poNumber,
    customerName: po.customer.companyName,
    productName: item.productName,
    productCategory: item.productCategory,
    unit: item.unit,
    plantName: b.preProduction.plant?.name ?? null,
    orderDate: iso(po.orderDate),
    expectedDeliveryDate: iso(po.expectedDeliveryDate),
    batchNo: b.batchNo,
    plannedQty: b.plannedQty,
    outputQty: b.outputQty,
    shift: b.shift,
    manpowerCount: b.manpowerCount,
    manufacturingStart: iso(b.shiftStartAt ?? b.manufacturingStartDate),
    manufacturingEnd: iso(b.shiftEndAt ?? b.manufacturingEndDate),
    completedAt: iso(b.completedAt),
    qaStatus: stageFields.qa,
    qcStatus: stageFields.qc,
    remarks: stageFields.remarks,
    approvedQty: stageFields.approved,
    rejectedQty: stageFields.rejected,
    wastageQty: stageFields.wastage,
    isHold: stageFields.qa === "Hold" || stageFields.qc === "Hold",
    waitingSince: b.updatedAt.toISOString(),
    link: `/production-batches/${b.id}`,
  };
}

// A batch sits at a stage only once its run is COMPLETED (an in-progress one still shows the default first stage).
async function batchesAt(stage: Exclude<QcBoardStage, "LINE_CLEARANCE">): Promise<QcBoardRow[]> {
  const batches = await prisma.productionBatch.findMany({ where: { currentStageId: stage, status: "COMPLETED" }, select: batchSelect, orderBy: { updatedAt: "asc" } });
  return batches.map((b) => batchRow(b, stage));
}

export async function loadQcStage(stage: QcBoardStage): Promise<QcBoardRow[]> {
  return stage === "LINE_CLEARANCE" ? runsAtLineClearance() : batchesAt(stage);
}

export const qcBoardRouter = Router();
qcBoardRouter.use(requireAuth, requireRole("QA_QC"));

// One QA stage's rows, or ?stage=ON_HOLD for everything held at any QA stage.
qcBoardRouter.get("/board", async (req, res, next) => {
  try {
    const stage = typeof req.query.stage === "string" ? req.query.stage : "";
    if (stage === "ON_HOLD") {
      const all = (await Promise.all(QC_BOARD_STAGES.map(loadQcStage))).flat();
      return res.json(all.filter((r) => r.isHold).sort((a, b) => a.waitingSince.localeCompare(b.waitingSince)));
    }
    if (!QC_BOARD_STAGES.includes(stage as QcBoardStage)) return res.status(400).json({ error: "Unknown QC stage" });
    res.json(await loadQcStage(stage as QcBoardStage));
  } catch (err) {
    next(err);
  }
});

// The numbers on the dashboard tiles: how many rows wait at each stage, and how many are on hold across all of them.
qcBoardRouter.get("/stage-counts", async (_req, res, next) => {
  try {
    const lists = await Promise.all(QC_BOARD_STAGES.map(loadQcStage));
    const counts = Object.fromEntries(QC_BOARD_STAGES.map((s, i) => [s, lists[i]!.length]));
    res.json({ ...counts, ON_HOLD: lists.flat().filter((r) => r.isHold).length });
  } catch (err) {
    next(err);
  }
});
