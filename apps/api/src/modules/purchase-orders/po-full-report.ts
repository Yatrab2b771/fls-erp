import { prisma } from "../../common/lib/prisma";
import { computeWastage } from "../batches/batch.engine";
import { PRE_PRODUCTION_STAGE_LABEL, type PreProductionStageId } from "../batches/pre-production-stage";
import { COMBINED_LOT_STAGE_LABEL, type CombinedLotStageId } from "../batches/combined-lot-stage";

/**
 * One PO's whole story, top to bottom — every product line, its
 * PreProduction run's Tier-1 walk, and every ProductionBatch's own
 * Tier-2 execution + Tier-3 walk, assembled once and shared by both the
 * on-screen report page (GET /:id/full-report) and the PDF export
 * (GET /:id/full-report.pdf) so the two never drift apart. Doesn't use
 * batch-report-pdf.ts's older PreProductionWithRelations/CombinedLot
 * shape — that one assumes exactly one pooled CombinedLot per run, which
 * isn't how new PreProductions work (see production-batches.routes.ts's
 * own comment on why CombinedLot creation was retired). ProductionBatch
 * has no dedicated stage-event table of its own (unlike PreProduction and
 * the legacy CombinedLot) — its step-by-step history is reconstructed
 * from AuditLog instead, same "production_batch.stage_forwarded"/
 * "stage_rejected" rows production-batch-transition.ts already records.
 */

export interface StageHistoryRow {
  action: string;
  fromLabel: string;
  toLabel: string;
  actorName: string;
  createdAt: Date;
  note: string | null;
}

export interface PoFullReportBatch {
  id: string;
  batchNo: string | null;
  plannedQty: number;
  status: string;
  manufacturingStartDate: Date | null;
  manufacturingEndDate: Date | null;
  inputQty: number | null;
  outputQty: number | null;
  wastageQty: number | null;
  currentStageId: CombinedLotStageId;
  tier3Fields: Record<string, unknown>;
  history: StageHistoryRow[];
}

export interface PoFullReportItem {
  id: string;
  productName: string;
  quantity: number;
  unit: string;
  productType: string;
  preProduction: {
    id: string;
    currentStageId: PreProductionStageId;
    plannedQty: number;
    combinedQty: number;
    tier1Fields: Record<string, unknown>;
    history: StageHistoryRow[];
  } | null;
  batches: PoFullReportBatch[];
  batchCount: number;
  dispatchedTotal: number;
}

export interface PoFullReport {
  po: {
    id: string;
    poNumber: string | null;
    customerName: string;
    orderDate: Date | null;
    expectedDeliveryDate: Date | null;
    status: string;
  };
  items: PoFullReportItem[];
  totals: { itemCount: number; batchCount: number; plannedTotal: number; dispatchedTotal: number };
}

const TIER1_FIELD_KEYS = [
  "grnNo",
  "grnDate",
  "materialReceivedRemarks",
  "prodIndentSlipSign",
  "productionPlanDate",
  "unit",
  "dispatchPlanDate",
  "lineClearanceStatus",
  "lineClearanceRemarks",
  "rmDispensingDate",
  "rmDispensingRemarks",
  "pmIssuedDate",
  "pmDispensingRemarks",
  "sampleQcStatus",
  "sampleQcRemarks",
] as const;

const TIER3_FIELD_KEYS = [
  "ipqcStatus",
  "ipqcRemarks",
  "mfgQaStatus",
  "mfgQcStatus",
  "mfgRemarks",
  "mfgApprovedQty",
  "mfgRejectedQty",
  "mfgWastageQty",
  "bulkQcStatus",
  "bulkQcRemarks",
  "packagingStartDate",
  "packagingStatus",
  "packagingEndDate",
  "packagingRemarks",
  "packQaStatus",
  "packQcStatus",
  "packRemarks",
  "packApprovedQty",
  "packRejectedQty",
  "packWastageQty",
  "invoiceNo",
  "invoiceDate",
  "ewayBillNo",
  "ewayBillDate",
  "billingRemarks",
  "dispatchDate",
  "dispatchedQty",
  "shipperQty",
  "totalShipperWeight",
  "transportType",
  "remainingQty",
  "anyRemarks",
] as const;

function pick(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = obj[k] ?? null;
  return out;
}

export async function getPoFullReport(poId: string): Promise<PoFullReport | null> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: {
      customer: { select: { companyName: true } },
      items: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
        include: {
          preProduction: {
            include: {
              stageEvents: { include: { actor: { select: { fullName: true, email: true } } }, orderBy: { createdAt: "asc" } },
              productionBatches: { orderBy: { createdAt: "asc" } },
            },
          },
        },
      },
    },
  });
  if (!po) return null;

  let totalBatchCount = 0;
  let totalPlanned = 0;
  let totalDispatched = 0;

  const items: PoFullReportItem[] = [];
  for (const item of po.items) {
    const pp = item.preProduction;
    totalPlanned += item.quantity;

    let batches: PoFullReportBatch[] = [];
    let ppHistory: StageHistoryRow[] = [];
    if (pp) {
      ppHistory = pp.stageEvents.map((e) => ({
        action: e.action,
        fromLabel: PRE_PRODUCTION_STAGE_LABEL[e.fromStageId as PreProductionStageId] ?? e.fromStageId,
        toLabel: PRE_PRODUCTION_STAGE_LABEL[e.toStageId as PreProductionStageId] ?? e.toStageId,
        actorName: e.actor.fullName || e.actor.email,
        createdAt: e.createdAt,
        note: e.note,
      }));

      const batchIds = pp.productionBatches.map((b) => b.id);
      const auditRows = batchIds.length
        ? await prisma.auditLog.findMany({
            where: { entityType: "ProductionBatch", entityId: { in: batchIds }, action: { in: ["production_batch.stage_forwarded", "production_batch.stage_rejected"] } },
            include: { actor: { select: { fullName: true, email: true } } },
            orderBy: { createdAt: "asc" },
          })
        : [];
      const auditByBatch = new Map<string, typeof auditRows>();
      for (const row of auditRows) {
        if (!row.entityId) continue;
        const list = auditByBatch.get(row.entityId) ?? [];
        list.push(row);
        auditByBatch.set(row.entityId, list);
      }

      batches = pp.productionBatches.map((b) => {
        const { wastageQty } = computeWastage(b);
        const raw = b as unknown as Record<string, unknown>;
        const history: StageHistoryRow[] = (auditByBatch.get(b.id) ?? []).map((row) => {
          const meta = (row.metadata ?? {}) as { from?: string; to?: string; note?: string };
          return {
            action: row.action === "production_batch.stage_forwarded" ? "FORWARD" : "REJECT",
            fromLabel: COMBINED_LOT_STAGE_LABEL[meta.from as CombinedLotStageId] ?? meta.from ?? "—",
            toLabel: COMBINED_LOT_STAGE_LABEL[meta.to as CombinedLotStageId] ?? meta.to ?? "—",
            actorName: row.actor ? row.actor.fullName || row.actor.email : "—",
            createdAt: row.createdAt,
            note: meta.note ?? null,
          };
        });
        return {
          id: b.id,
          batchNo: b.batchNo,
          plannedQty: b.plannedQty,
          status: b.status,
          manufacturingStartDate: b.manufacturingStartDate,
          manufacturingEndDate: b.manufacturingEndDate,
          inputQty: b.inputQty,
          outputQty: b.outputQty,
          wastageQty,
          currentStageId: b.currentStageId,
          tier3Fields: pick(raw, TIER3_FIELD_KEYS),
          history,
        };
      });

      totalBatchCount += batches.length;
      totalDispatched += batches.reduce((sum, b) => sum + (b.tier3Fields.dispatchedQty as number | null ?? 0), 0);
    }

    const dispatchedTotal = batches.reduce((sum, b) => sum + (b.tier3Fields.dispatchedQty as number | null ?? 0), 0);

    items.push({
      id: item.id,
      productName: item.productName,
      quantity: item.quantity,
      unit: item.unit,
      productType: item.productType,
      preProduction: pp
        ? {
            id: pp.id,
            currentStageId: pp.currentStageId,
            plannedQty: pp.plannedQty,
            combinedQty: pp.combinedQty,
            tier1Fields: pick(pp as unknown as Record<string, unknown>, TIER1_FIELD_KEYS),
            history: ppHistory,
          }
        : null,
      batches,
      batchCount: batches.length,
      dispatchedTotal,
    });
  }

  return {
    po: {
      id: po.id,
      poNumber: po.poNumber,
      customerName: po.customer.companyName,
      orderDate: po.orderDate,
      expectedDeliveryDate: po.expectedDeliveryDate,
      status: po.status,
    },
    items,
    totals: { itemCount: items.length, batchCount: totalBatchCount, plannedTotal: totalPlanned, dispatchedTotal: totalDispatched },
  };
}
