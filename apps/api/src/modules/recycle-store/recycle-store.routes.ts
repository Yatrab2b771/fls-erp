import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { requireAuth, requireRole } from "../../common/middleware/auth";

// --- Recycle Store — a read-only report over the two, structurally
// different waste ledgers this app already writes to, per the schema.prisma
// comment blocks on InventoryTxnType.ISSUED_RECYCLE and BatchRecycleLog:
//
//   1. Real RM/PM lost right at Dispensing (BatchMaterialConsumption's
//      WASTE purpose) or a Plant -> Recycle Store spill — an
//      InventoryTransaction(type: ISSUED_RECYCLE), InventoryItem-backed,
//      same shape as every other stock movement in this app. Traced back
//      to the PreProduction run it was dispensed against (Tier 1).
//   2. A QA gate's own Wastage bucket (Phase F) — the pooled lot's
//      in-process or finished output, which has no InventoryItem to hang
//      a real stock transaction off — a BatchRecycleLog row instead.
//      Traced back to the CombinedLot it was cleared against (Tier 3).
//
// Unlike R&D Store (its own real, actionable lifecycle — send, confirm,
// consume, return), Recycle Store is a one-way sink: nothing ever comes
// back out, so there's nothing to act on here, only to see. No
// create/consume/return endpoints — everything in this module writes
// itself automatically from Dispensing and the QA gates (see
// pre-production-transition.ts / combined-lot-transition.ts); this is
// purely the combined view over both.
// ---------------------------------------------------------------------------

export const recycleStoreRouter = Router();

recycleStoreRouter.use(requireAuth);

const VISIBLE_TO = ["STORE", "PRODUCTION", "QA_QC", "PPIC"] as const;

const poItemTrace = {
  select: {
    productName: true,
    purchaseOrder: { select: { poNumber: true, customer: { select: { companyName: true } } } },
  },
} as const;

function traceLabel(t: { productName: string; purchaseOrder: { poNumber: string | null; customer: { companyName: string } } }) {
  return {
    productName: t.productName,
    poNumber: t.purchaseOrder.poNumber,
    customerName: t.purchaseOrder.customer.companyName,
  };
}

// The combined activity feed — every real RM/PM spill and every QA
// gate's Wastage entry, newest first, normalized into one shape so the
// page can render one list instead of two disconnected ones.
recycleStoreRouter.get("/transactions", requireRole(...VISIBLE_TO), async (_req, res, next) => {
  try {
    const [materialRows, lotOutputRows] = await Promise.all([
      prisma.inventoryTransaction.findMany({
        where: { type: "ISSUED_RECYCLE", deletedAt: null },
        include: {
          item: { select: { id: true, category: true, name: true } },
          plant: { select: { id: true, name: true } },
          preProduction: { select: { purchaseOrderItem: poItemTrace } },
          createdBy: { select: { fullName: true, email: true } },
        },
        orderBy: { date: "desc" },
        take: 200,
      }),
      prisma.batchRecycleLog.findMany({
        include: {
          combinedLot: { select: { preProduction: { select: { purchaseOrderItem: poItemTrace } } } },
          createdBy: { select: { fullName: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
    ]);

    const material = materialRows.map((r) => ({
      kind: "material" as const,
      id: r.id,
      itemName: r.item.name,
      category: r.item.category,
      quantity: r.quantity,
      unit: r.unit,
      plantName: r.plant?.name ?? null,
      stageLabel: null,
      ...(r.preProduction ? traceLabel(r.preProduction.purchaseOrderItem) : { productName: null, poNumber: null, customerName: null }),
      note: r.remark,
      date: r.date,
      createdByName: r.createdBy.fullName || r.createdBy.email,
    }));

    const lotOutput = lotOutputRows.map((r) => ({
      kind: "batch_output" as const,
      id: r.id,
      itemName: null,
      category: null,
      quantity: r.quantity,
      unit: r.unit,
      plantName: null,
      stageLabel: r.stageId === "QA_GATE_MFG" ? "QA Gate — Manufacturing" : "QA Gate — Packaging",
      ...traceLabel(r.combinedLot.preProduction.purchaseOrderItem),
      note: r.note,
      date: r.createdAt,
      createdByName: r.createdBy.fullName || r.createdBy.email,
    }));

    const combined = [...material, ...lotOutput].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    res.json(combined);
  } catch (err) {
    next(err);
  }
});

// Per-item totals for the real RM/PM leg — same "one representative unit
// per item" shape as rnd-store.routes.ts GET /report.
recycleStoreRouter.get("/by-item", requireRole(...VISIBLE_TO), async (_req, res, next) => {
  try {
    const rows = await prisma.inventoryTransaction.groupBy({
      by: ["itemId"],
      where: { type: "ISSUED_RECYCLE", deletedAt: null },
      _sum: { quantity: true },
      _count: { _all: true },
    });
    if (rows.length === 0) return res.json([]);

    const items = await prisma.inventoryItem.findMany({ where: { id: { in: rows.map((r) => r.itemId) } } });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const unitRows = await prisma.inventoryTransaction.findMany({
      where: { type: "ISSUED_RECYCLE", deletedAt: null, itemId: { in: rows.map((r) => r.itemId) } },
      select: { itemId: true, unit: true },
      distinct: ["itemId"],
    });
    const unitByItemId = new Map(unitRows.map((r) => [r.itemId, r.unit]));

    res.json(
      rows
        .map((r) => {
          const item = itemById.get(r.itemId);
          if (!item) return null;
          return {
            itemId: r.itemId,
            itemName: item.name,
            category: item.category,
            unit: unitByItemId.get(r.itemId) ?? item.unit ?? "",
            totalQty: r._sum.quantity ?? 0,
            entryCount: r._count._all,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null),
    );
  } catch (err) {
    next(err);
  }
});

// Per-lot totals for the QA gates' own output-wastage leg — grouped by
// CombinedLot (not by item, which doesn't apply here) and by stage, so a
// report can answer "how much of this lot's own output was wasted, and
// at which gate" rather than one lump sum per lot.
recycleStoreRouter.get("/by-batch", requireRole(...VISIBLE_TO), async (_req, res, next) => {
  try {
    const rows = await prisma.batchRecycleLog.groupBy({ by: ["combinedLotId", "stageId"], _sum: { quantity: true }, _count: { _all: true } });
    if (rows.length === 0) return res.json([]);

    const lots = await prisma.combinedLot.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.combinedLotId))] } },
      select: { id: true, preProduction: { select: { purchaseOrderItem: poItemTrace } } },
    });
    const lotById = new Map(lots.map((l) => [l.id, l]));
    const unitRows = await prisma.batchRecycleLog.findMany({ where: { combinedLotId: { in: rows.map((r) => r.combinedLotId) } }, select: { combinedLotId: true, unit: true }, distinct: ["combinedLotId"] });
    const unitByLotId = new Map(unitRows.map((r) => [r.combinedLotId, r.unit]));

    res.json(
      rows
        .map((r) => {
          const lot = lotById.get(r.combinedLotId);
          if (!lot) return null;
          return {
            combinedLotId: r.combinedLotId,
            stageId: r.stageId,
            stageLabel: r.stageId === "QA_GATE_MFG" ? "QA Gate — Manufacturing" : "QA Gate — Packaging",
            unit: unitByLotId.get(r.combinedLotId) ?? "",
            totalQty: r._sum.quantity ?? 0,
            entryCount: r._count._all,
            ...traceLabel(lot.preProduction.purchaseOrderItem),
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null),
    );
  } catch (err) {
    next(err);
  }
});
