import { computeBulkReconciliation, computeDelay, computeWastage } from "./batch.engine";
import { LINE_CLEARANCE_BULK_MFG_ITEMS, LINE_CLEARANCE_DISPENSING_ITEMS } from "./batch-checklists";
import type { CombinedLot, Prisma, PreProduction, ProductionBatch } from "@prisma/client";

// Split three ways to match the three-tier pipeline (PreProduction /
// ProductionBatch / CombinedLot — see schema.prisma's own comment block
// above each model). Each tier gets its own include/serialize pair so
// pre-production-routes.ts, production-batches.routes.ts and
// combined-lot-routes.ts (plus transition.ts, reused by all three) can
// pull exactly the relations that tier actually has.

// ---------------------------------------------------------------------------
// Tier 1 — PreProduction
// ---------------------------------------------------------------------------

export const preProductionInclude = {
  purchaseOrderItem: {
    select: {
      id: true,
      productName: true,
      quantity: true,
      unit: true,
      purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { id: true, companyName: true } } } },
    },
  },
  stageEvents: {
    include: { actor: { select: { fullName: true, email: true } } },
    orderBy: { createdAt: "asc" },
  },
  plant: true,
  consumptions: {
    include: { item: true, createdBy: { select: { fullName: true, email: true } }, qaVerifiedBy: { select: { fullName: true, email: true } } },
    orderBy: { createdAt: "asc" },
  },
  // The two cross-module traceability links still scoped to
  // PreProduction — see schema.prisma's comments on
  // InventoryRequest.preProductionId / PreProduction.sourceReceiptId.
  indentRequests: {
    select: { id: true, itemId: true, category: true, requestedQty: true, status: true, createdAt: true, item: { select: { name: true, unit: true } } },
    orderBy: { createdAt: "asc" },
  },
  sourceReceipt: {
    select: { id: true, grnNo: true, date: true, quantity: true, unit: true, item: { select: { name: true } } },
  },
  // The checklist's itemized detail (Line Clearance — Dispensing area) —
  // see batch-checklists.ts and schema.prisma's comment on
  // PreProductionChecklistItem.
  checklistItems: true,
  // Every small manufacturing run against this item, plus the pooled lot
  // they combine into once combinedQty reaches plannedQty — the
  // "remaining quantity" tracking the client asked for is
  // plannedQty - combinedQty, computed in serializePreProduction below.
  productionBatches: {
    include: { createdBy: { select: { fullName: true, email: true } }, completedBy: { select: { fullName: true, email: true } } },
    orderBy: { createdAt: "asc" },
  },
  combinedLot: { select: { id: true, currentStageId: true } },
} satisfies Prisma.PreProductionInclude;

export type PreProductionWithRelations = PreProduction & {
  purchaseOrderItem: {
    id: string;
    productName: string;
    quantity: number;
    unit: string;
    purchaseOrder: { id: string; poNumber: string | null; customer: { id: string; companyName: string } };
  };
  stageEvents: {
    id: string;
    fromStageId: string;
    toStageId: string;
    action: string;
    note: string | null;
    actorId: string;
    actor: { fullName: string; email: string };
    createdAt: Date;
  }[];
  plant: { id: string; name: string } | null;
  consumptions: {
    id: string;
    itemId: string;
    quantity: number;
    unit: string;
    purpose: string;
    createdAt: Date;
    item: { id: string; category: string; name: string; unit: string | null };
    createdBy: { fullName: string; email: string };
    grossWeight: number | null;
    tareWeight: number | null;
    arNo: string | null;
    qaVerifiedById: string | null;
    qaVerifiedAt: Date | null;
    qaVerifiedBy: { fullName: string; email: string } | null;
  }[];
  indentRequests: {
    id: string;
    itemId: string;
    category: string;
    requestedQty: number;
    status: string;
    createdAt: Date;
    item: { name: string; unit: string | null };
  }[];
  sourceReceipt: { id: string; grnNo: string | null; date: Date; quantity: number; unit: string; item: { name: string } } | null;
  checklistItems: { id: string; itemKey: string; deptOk: boolean | null; qaOk: boolean | null }[];
  productionBatches: {
    id: string;
    batchNo: string | null;
    plannedQty: number;
    status: string;
    manufacturingStartDate: Date | null;
    manufacturingStatus: string | null;
    manufacturingEndDate: Date | null;
    manufacturingRemarks: string | null;
    inputQty: number | null;
    outputQty: number | null;
    completedAt: Date | null;
    createdAt: Date;
    createdBy: { fullName: string; email: string };
    completedBy: { fullName: string; email: string } | null;
  }[];
  combinedLot: { id: string; currentStageId: string } | null;
};

function buildPreProductionChecklist(rows: PreProductionWithRelations["checklistItems"]) {
  const byKey = new Map(rows.map((r) => [r.itemKey, r]));
  return LINE_CLEARANCE_DISPENSING_ITEMS.map((item) => ({
    itemKey: item.key,
    label: item.label,
    deptOk: byKey.get(item.key)?.deptOk ?? null,
    qaOk: byKey.get(item.key)?.qaOk ?? null,
  }));
}

export function serializePreProduction(run: PreProductionWithRelations) {
  const { checklistItems, ...rest } = run;
  const remainingQty = Math.max(0, Math.round((run.plannedQty - run.combinedQty) * 1000) / 1000);
  return {
    ...rest,
    remainingQty,
    // Delay against this run's own production plan date — only
    // meaningful before manufacturing has actually started (once a
    // ProductionBatch exists, whether it's "late" is a manufacturing
    // question, not a pre-production one).
    delay: computeDelay({
      dispatchDate: null,
      dispatchPlanDate: null,
      manufacturingStartDate: run.productionBatches.length > 0 ? run.productionBatches[0]!.createdAt : null,
      productionPlanDate: run.productionPlanDate,
    }),
    stageEvents: run.stageEvents.map((e) => ({
      id: e.id,
      fromStageId: e.fromStageId,
      toStageId: e.toStageId,
      action: e.action,
      note: e.note,
      actorId: e.actorId,
      actorName: e.actor.fullName || e.actor.email,
      createdAt: e.createdAt,
    })),
    // Net weight is derived (gross - tare), never stored — same
    // "computed, not entered" rule as ProductionBatch.wastageQty. Null
    // unless both gross and tare were actually recorded for this line.
    consumptions: run.consumptions.map((c) => ({
      ...c,
      netWeight: c.grossWeight != null && c.tareWeight != null ? c.grossWeight - c.tareWeight : null,
      qaVerifiedByName: c.qaVerifiedBy ? c.qaVerifiedBy.fullName || c.qaVerifiedBy.email : null,
    })),
    // Every small manufacturing run, each with its own wastage computed
    // from its own input/output — see computeWastage.
    productionBatches: run.productionBatches.map((b) => ({
      ...b,
      wastage: computeWastage(b),
      createdByName: b.createdBy.fullName || b.createdBy.email,
      completedByName: b.completedBy ? b.completedBy.fullName || b.completedBy.email : null,
    })),
    // Always every fixed row, in the paper form's own order — items
    // nobody has checked yet still show up as unchecked, not missing.
    lineClearanceChecklist: buildPreProductionChecklist(checklistItems),
  };
}

// ---------------------------------------------------------------------------
// Tier 2 — ProductionBatch
// ---------------------------------------------------------------------------

export const productionBatchInclude = {
  createdBy: { select: { fullName: true, email: true } },
  completedBy: { select: { fullName: true, email: true } },
} satisfies Prisma.ProductionBatchInclude;

export type ProductionBatchWithRelations = ProductionBatch & {
  createdBy: { fullName: string; email: string };
  completedBy: { fullName: string; email: string } | null;
};

export function serializeProductionBatch(batch: ProductionBatchWithRelations) {
  return {
    ...batch,
    wastage: computeWastage(batch),
    createdByName: batch.createdBy.fullName || batch.createdBy.email,
    completedByName: batch.completedBy ? batch.completedBy.fullName || batch.completedBy.email : null,
  };
}

// ---------------------------------------------------------------------------
// Tier 3 — CombinedLot
// ---------------------------------------------------------------------------

export const combinedLotInclude = {
  preProduction: {
    select: {
      id: true,
      plannedQty: true,
      combinedQty: true,
      dispatchPlanDate: true,
      productionPlanDate: true,
      purchaseOrderItem: {
        select: {
          id: true,
          productName: true,
          quantity: true,
          unit: true,
          purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { id: true, companyName: true } } } },
        },
      },
    },
  },
  stageEvents: {
    include: { actor: { select: { fullName: true, email: true } } },
    orderBy: { createdAt: "asc" },
  },
  dispatchTransfer: {
    select: { id: true, productName: true, quantity: true, qcStatus: true, dispatchedAt: true, invoiceNumber: true, invoicedAt: true },
  },
  // Phase F — the QA gates' own Wastage-routed-to-Recycle-Store trail.
  recycleLogs: {
    orderBy: { createdAt: "asc" },
  },
  // The checklist's itemized detail (Line Clearance — bulk mfg area) —
  // see batch-checklists.ts and schema.prisma's comment on
  // CombinedLotChecklistItem.
  checklistItems: true,
  // The Certificate of Analysis's per-test-parameter list and its three
  // sequential sign-offs — see schema.prisma's comment on
  // BatchCoaTestResult.
  coaResults: { orderBy: { sortOrder: "asc" } },
  coaAnalyzedBy: { select: { fullName: true, email: true } },
  coaReviewedBy: { select: { fullName: true, email: true } },
  coaApprovedBy: { select: { fullName: true, email: true } },
} satisfies Prisma.CombinedLotInclude;

export type CombinedLotWithRelations = CombinedLot & {
  preProduction: {
    id: string;
    plannedQty: number;
    combinedQty: number;
    dispatchPlanDate: Date | null;
    productionPlanDate: Date | null;
    purchaseOrderItem: {
      id: string;
      productName: string;
      quantity: number;
      unit: string;
      purchaseOrder: { id: string; poNumber: string | null; customer: { id: string; companyName: string } };
    };
  };
  stageEvents: {
    id: string;
    fromStageId: string;
    toStageId: string;
    action: string;
    note: string | null;
    actorId: string;
    actor: { fullName: string; email: string };
    createdAt: Date;
  }[];
  dispatchTransfer: {
    id: string;
    productName: string;
    quantity: number;
    qcStatus: string | null;
    dispatchedAt: Date | null;
    invoiceNumber: string | null;
    invoicedAt: Date | null;
  } | null;
  recycleLogs: {
    id: string;
    stageId: string;
    quantity: number;
    unit: string;
    note: string | null;
    createdAt: Date;
  }[];
  checklistItems: { id: string; itemKey: string; deptOk: boolean | null; qaOk: boolean | null }[];
  coaResults: { id: string; testName: string; specification: string | null; observation: string | null; sortOrder: number }[];
  coaAnalyzedBy: { fullName: string; email: string } | null;
  coaReviewedBy: { fullName: string; email: string } | null;
  coaApprovedBy: { fullName: string; email: string } | null;
};

function buildCombinedLotChecklist(rows: CombinedLotWithRelations["checklistItems"]) {
  const byKey = new Map(rows.map((r) => [r.itemKey, r]));
  return LINE_CLEARANCE_BULK_MFG_ITEMS.map((item) => ({
    itemKey: item.key,
    label: item.label,
    deptOk: byKey.get(item.key)?.deptOk ?? null,
    qaOk: byKey.get(item.key)?.qaOk ?? null,
  }));
}

export function serializeCombinedLot(lot: CombinedLotWithRelations) {
  const { checklistItems, ...rest } = lot;
  return {
    ...rest,
    delay: computeDelay({
      dispatchDate: lot.dispatchDate,
      dispatchPlanDate: lot.preProduction.dispatchPlanDate,
      manufacturingStartDate: lot.createdAt, // the lot only exists once manufacturing has actually finished pooling in
      productionPlanDate: lot.preProduction.productionPlanDate,
    }),
    bulkReconciliation: computeBulkReconciliation(lot),
    stageEvents: lot.stageEvents.map((e) => ({
      id: e.id,
      fromStageId: e.fromStageId,
      toStageId: e.toStageId,
      action: e.action,
      note: e.note,
      actorId: e.actorId,
      actorName: e.actor.fullName || e.actor.email,
      createdAt: e.createdAt,
    })),
    lineClearanceChecklist: buildCombinedLotChecklist(checklistItems),
    coaAnalyzedByName: lot.coaAnalyzedBy ? lot.coaAnalyzedBy.fullName || lot.coaAnalyzedBy.email : null,
    coaReviewedByName: lot.coaReviewedBy ? lot.coaReviewedBy.fullName || lot.coaReviewedBy.email : null,
    coaApprovedByName: lot.coaApprovedBy ? lot.coaApprovedBy.fullName || lot.coaApprovedBy.email : null,
  };
}
