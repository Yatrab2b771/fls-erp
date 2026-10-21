import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { requireAuth, requireRole } from "../../common/middleware/auth";
import { txnInclude, dispatchTransferInclude } from "../inventory/inventory.routes";
import { preProductionInclude, serializePreProduction, combinedLotInclude, serializeCombinedLot } from "../batches/batch-include";

export const qcRouter = Router();
qcRouter.use(requireAuth);

// One cross-cutting view over every QC checkpoint in the app — QA/QC's
// work today is scattered across two Inventory tabs (inward Material
// Received, outward FG Dispatch) and whichever individual PreProduction
// run/CombinedLot happens to be sitting at a QA gate, with no single
// place to see how much is actually parked on hold. This endpoint is
// read-only; every action still happens where it already did (the
// Inventory QC routes, and a run/lot's own stage PATCH) — this just
// aggregates the same state, live.
qcRouter.get("/dashboard", requireRole("QA_QC"), async (_req, res, next) => {
  try {
    const [
      pendingReceipts,
      heldReceipts,
      pendingDispatches,
      heldDispatches,
      heldMfgLotsRaw,
      heldPackLotsRaw,
      pendingIpqcLotsRaw,
      pendingBulkQcLotsRaw,
    ] = await Promise.all([
      prisma.inventoryTransaction.findMany({ where: { type: "RECEIVED", receiptStatus: "PENDING_QC", deletedAt: null }, include: txnInclude, orderBy: { date: "asc" } }),
      prisma.inventoryTransaction.findMany({ where: { type: "RECEIVED", receiptStatus: "ON_HOLD", deletedAt: null }, include: txnInclude, orderBy: { date: "asc" } }),
      prisma.dispatchTransfer.findMany({ where: { type: "FG", qcStatus: "PENDING_QC", deletedAt: null }, include: dispatchTransferInclude, orderBy: { date: "asc" } }),
      prisma.dispatchTransfer.findMany({ where: { type: "FG", qcStatus: "ON_HOLD", deletedAt: null }, include: dispatchTransferInclude, orderBy: { date: "asc" } }),
      // mfgQaStatus/packQaStatus are plain strings that never get reset
      // when a lot advances past its QA gate — a lot that was held, then
      // later resolved and moved on, still has "Hold" sitting in the
      // column. Scoping to the lot's *current* stage is what keeps that
      // stale history from being miscounted as a live hold.
      prisma.combinedLot.findMany({ where: { currentStageId: "QA_GATE_MFG", OR: [{ mfgQaStatus: "Hold" }, { mfgQcStatus: "Hold" }] }, include: combinedLotInclude }),
      prisma.combinedLot.findMany({ where: { currentStageId: "QA_GATE_PACKAGING", OR: [{ packQaStatus: "Hold" }, { packQcStatus: "Hold" }] }, include: combinedLotInclude }),
      // Same rule again, for the CombinedLot side's own hard gates.
      prisma.combinedLot.findMany({ where: { currentStageId: "IPQC" }, include: combinedLotInclude }),
      prisma.combinedLot.findMany({ where: { currentStageId: "BULK_QC" }, include: combinedLotInclude }),
    ]);

    const heldMfgLots = heldMfgLotsRaw.map(serializeCombinedLot);
    const heldPackLots = heldPackLotsRaw.map(serializeCombinedLot);
    const pendingIpqcLots = pendingIpqcLotsRaw.map(serializeCombinedLot);
    const pendingBulkQcLots = pendingBulkQcLotsRaw.map(serializeCombinedLot);

    res.json({
      counts: {
        onHoldTotal: heldReceipts.length + heldDispatches.length + heldMfgLots.length + heldPackLots.length,
        pendingReceiptQc: pendingReceipts.length,
        onHoldReceiptQc: heldReceipts.length,
        pendingDispatchQc: pendingDispatches.length,
        onHoldDispatchQc: heldDispatches.length,
        onHoldMfgBatches: heldMfgLots.length,
        onHoldPackBatches: heldPackLots.length,
        pendingIpqcBatches: pendingIpqcLots.length,
        pendingBulkQcBatches: pendingBulkQcLots.length,
      },
      receipts: { pending: pendingReceipts, onHold: heldReceipts },
      dispatches: { pending: pendingDispatches, onHold: heldDispatches },
      batches: {
        onHoldMfg: heldMfgLots,
        onHoldPack: heldPackLots,
        pendingIpqc: pendingIpqcLots,
        pendingBulkQc: pendingBulkQcLots,
      },
    });
  } catch (err) {
    next(err);
  }
});
