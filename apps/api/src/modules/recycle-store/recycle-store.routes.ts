import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { RouteError } from "../../common/lib/route-error";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";

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
// Entries write themselves from Dispensing, the Plant and the QA gates. Wastage is gone for good. Raw / packaging material REJECTED at the
// Plant waits for QA's decision: put it back into the Plant's stock (REUSE) or destroy it (DESTROY); see POST /entries/:id/decision.
// What a QA gate rejected of a batch's own output (BatchRecycleLog) has no decision yet - it is reported only.
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

const EPS = 1e-6;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
/** What QA still has to decide about an entry: all of a REJECTED one, less what has been decided; wastage needs no decision. */
const toDecideOf = (t: { recycleKind: string | null; quantity: number; recycleDecisions: { quantity: number }[] }) =>
  t.recycleKind === "REJECTED" ? Math.max(0, round3(t.quantity - t.recycleDecisions.reduce((s, d) => s + d.quantity, 0))) : 0;

/** How many rejected entries wait for QA (the dashboard tile). */
recycleStoreRouter.get("/summary", requireRole(...VISIBLE_TO), async (_req, res, next) => {
  try {
    const rows = await prisma.inventoryTransaction.findMany({ where: { type: "ISSUED_RECYCLE", recycleKind: "REJECTED", deletedAt: null }, select: { recycleKind: true, quantity: true, recycleDecisions: { select: { quantity: true } } } });
    res.json({ toDecide: rows.filter((r) => toDecideOf(r) > EPS).length });
  } catch (err) {
    next(err);
  }
});

const decisionSchema = z.object({
  decision: z.enum(["REUSE", "DESTROY"]),
  quantity: z.coerce.number().positive(),
  note: z.string().trim().max(500).optional(),
  /** For DESTROY: the destruction certificate no. */
  certificateNo: z.string().trim().max(120).optional(),
});

/** QA decides what happens to rejected raw / packaging material: back into the Plant's stock, or destroyed. */
recycleStoreRouter.post("/entries/:id/decision", requireRole("QA_QC"), validateBody(decisionSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const input = req.body as z.infer<typeof decisionSchema>;
    const entry = await prisma.inventoryTransaction.findUnique({
      where: { id: req.params.id },
      include: { item: { select: { name: true } }, recycleDecisions: { select: { quantity: true } } },
    });
    if (!entry || entry.type !== "ISSUED_RECYCLE" || entry.deletedAt) throw new RouteError(404, "Recycle Store entry not found");
    if (entry.recycleKind !== "REJECTED") throw new RouteError(409, "Wastage is gone for good: it needs no decision.");
    const left = toDecideOf(entry);
    if (left <= EPS) throw new RouteError(409, "Everything of this entry has been decided.");
    if (input.quantity > left + EPS) throw new RouteError(409, `Only ${left} ${entry.unit} of this entry is still waiting for a decision.`);
    if (input.decision === "REUSE" && !entry.plantId) throw new RouteError(409, "This entry has no Plant to put the material back into.");

    const decision = await prisma.$transaction(async (tx) => {
      let adjustmentId: string | null = null;
      if (input.decision === "REUSE") {
        // The quantity goes back into the Plant's stock as a stock correction QA itself approves (it is QA's own decision)
        const adj = await tx.stockAdjustment.create({
          data: {
            itemId: entry.itemId,
            locationType: "PLANT",
            plantId: entry.plantId,
            quantityDelta: input.quantity,
            unit: entry.unit,
            reason: "OTHER",
            note: `Reused from the Recycle Store: ${entry.remark ?? "rejected material"}`.slice(0, 480),
            status: "APPROVED",
            requestedById: req.user!.id,
            reviewedById: req.user!.id,
            reviewedAt: new Date(),
            reviewNote: "QA decided to reuse it",
          },
        });
        adjustmentId = adj.id;
      }
      return tx.recycleDecision.create({
        data: { transactionId: entry.id, decision: input.decision, quantity: input.quantity, unit: entry.unit, note: input.note || null, certificateNo: input.certificateNo || null, stockAdjustmentId: adjustmentId, decidedById: req.user!.id },
      });
    });
    await recordAudit({ actorId: req.user!.id, action: input.decision === "REUSE" ? "recycle.reused" : "recycle.destroyed", entityType: "InventoryTransaction", entityId: entry.id, metadata: { decisionId: decision.id, quantity: input.quantity, item: entry.item.name, certificateNo: input.certificateNo } });
    if (input.decision === "REUSE") await notifyRoles(["PRODUCTION"], { title: `${input.quantity} ${entry.unit} of ${entry.item.name} is back in the Plant's stock`, body: "QA decided the rejected material can be reused.", link: "/plant-stock" }, req.user!.id).catch(() => undefined);
    res.status(201).json({ id: decision.id, left: round3(left - input.quantity) });
  } catch (err) {
    next(err);
  }
});

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
          recycleDecisions: { orderBy: { decidedAt: "asc" } },
        },
        orderBy: { date: "desc" },
        take: 200,
      }),
      prisma.batchRecycleLog.findMany({
        include: {
          combinedLot: { select: { preProduction: { select: { purchaseOrderItem: poItemTrace } } } },
          productionBatch: { select: { id: true, batchNo: true, preProduction: { select: { purchaseOrderItem: poItemTrace } } } },
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
      recycleKind: (r.recycleKind ?? "WASTAGE") as "WASTAGE" | "REJECTED",
      toDecide: toDecideOf(r),
      decisions: r.recycleDecisions.map((d) => ({ id: d.id, decision: d.decision, quantity: d.quantity, note: d.note, certificateNo: d.certificateNo, at: d.decidedAt })),
    }));

    // A QA gate's own output: waste (gone for good) or a rejection (failed quality, held for a decision). It belongs to a production
    // batch in the current flow, or to a pooled lot from before it.
    const lotOutput = lotOutputRows.flatMap((r) => {
      const item = r.productionBatch?.preProduction.purchaseOrderItem ?? r.combinedLot?.preProduction.purchaseOrderItem;
      if (!item) return [];
      return [
        {
          kind: "batch_output" as const,
          id: r.id,
          itemName: null,
          category: null,
          quantity: r.quantity,
          unit: r.unit,
          plantName: null,
          stageLabel: `${r.stageId === "QA_GATE_MFG" ? "QA Gate — Manufacturing" : "QA Gate — Packaging"}${r.kind === "REJECTED" ? " (rejected, held)" : ""}`,
          outputKind: r.kind,
          batchNo: r.productionBatch?.batchNo ?? null,
          ...traceLabel(item),
          note: r.note,
          date: r.createdAt,
          createdByName: r.createdBy.fullName || r.createdBy.email,
        },
      ];
    });

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
    const rows = await prisma.batchRecycleLog.groupBy({ by: ["combinedLotId", "productionBatchId", "stageId", "kind"], _sum: { quantity: true }, _count: { _all: true } });
    if (rows.length === 0) return res.json([]);

    const lotIds = [...new Set(rows.flatMap((r) => (r.combinedLotId ? [r.combinedLotId] : [])))];
    const batchIds = [...new Set(rows.flatMap((r) => (r.productionBatchId ? [r.productionBatchId] : [])))];
    const [lots, batches, unitRows] = await Promise.all([
      prisma.combinedLot.findMany({ where: { id: { in: lotIds } }, select: { id: true, preProduction: { select: { purchaseOrderItem: poItemTrace } } } }),
      prisma.productionBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, batchNo: true, preProduction: { select: { purchaseOrderItem: poItemTrace } } } }),
      prisma.batchRecycleLog.findMany({ select: { combinedLotId: true, productionBatchId: true, unit: true }, distinct: ["combinedLotId", "productionBatchId"] }),
    ]);
    const lotById = new Map(lots.map((l) => [l.id, l]));
    const batchById = new Map(batches.map((b) => [b.id, b]));
    const unitByKey = new Map(unitRows.map((r) => [`${r.combinedLotId ?? ""}|${r.productionBatchId ?? ""}`, r.unit]));

    res.json(
      rows.flatMap((r) => {
        const lot = r.combinedLotId ? lotById.get(r.combinedLotId) : undefined;
        const batch = r.productionBatchId ? batchById.get(r.productionBatchId) : undefined;
        const item = batch?.preProduction.purchaseOrderItem ?? lot?.preProduction.purchaseOrderItem;
        if (!item) return [];
        return [
          {
            combinedLotId: r.combinedLotId,
            productionBatchId: r.productionBatchId,
            batchNo: batch?.batchNo ?? null,
            outputKind: r.kind,
            stageId: r.stageId,
            stageLabel: r.stageId === "QA_GATE_MFG" ? "QA Gate — Manufacturing" : "QA Gate — Packaging",
            unit: unitByKey.get(`${r.combinedLotId ?? ""}|${r.productionBatchId ?? ""}`) ?? "",
            totalQty: r._sum.quantity ?? 0,
            entryCount: r._count._all,
            ...traceLabel(item),
          },
        ];
      }),
    );
  } catch (err) {
    next(err);
  }
});
