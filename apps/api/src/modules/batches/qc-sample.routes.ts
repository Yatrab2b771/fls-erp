import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { notifyRoles } from "../../common/lib/notify";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { RouteError } from "../../common/lib/route-error";
import { getQcSampleOnHand } from "./qc-sample-stock";
import { consumeQcSampleSchema, returnQcSampleSchema, type ConsumeQcSampleInput, type ReturnQcSampleInput } from "./qc-sample.schemas";

// --- QC Sample Store — the pre-production sample lifecycle scoped to one
// PreProduction run (see schema.prisma's QcSampleTransfer/
// QcSampleTransaction comment block, same shape as R&D's item-wide
// ledger in rnd-store.routes.ts). The TO_QC send itself is created in
// pre-production-transition.ts as part of logging Dispensing's
// SAMPLE-purpose consumption — this module picks up from there: QC
// confirms receipt, tests it, and any leftover goes back to the Plant. ---
export const qcSampleRouter = Router();

qcSampleRouter.use(requireAuth);

const transferInclude = {
  item: { select: { id: true, category: true, name: true } },
  sentBy: { select: { fullName: true, email: true } },
  confirmedBy: { select: { fullName: true, email: true } },
} as const;

function serializeTransfer(t: {
  id: string;
  preProductionId: string;
  direction: string;
  itemId: string;
  quantity: number;
  unit: string;
  note: string | null;
  sentAt: Date;
  confirmedAt: Date | null;
  item: { id: string; category: string; name: string };
  sentBy: { fullName: string; email: string };
  confirmedBy: { fullName: string; email: string } | null;
}) {
  return {
    id: t.id,
    preProductionId: t.preProductionId,
    direction: t.direction,
    itemId: t.itemId,
    itemName: t.item.name,
    category: t.item.category,
    quantity: t.quantity,
    unit: t.unit,
    note: t.note,
    sentAt: t.sentAt,
    sentByName: t.sentBy.fullName || t.sentBy.email,
    confirmedAt: t.confirmedAt,
    confirmedByName: t.confirmedBy ? t.confirmedBy.fullName || t.confirmedBy.email : null,
    status: t.confirmedAt ? "CONFIRMED" : "PENDING",
  };
}

async function requirePreProduction(preProductionId: string) {
  const run = await prisma.preProduction.findUnique({ where: { id: preProductionId }, select: { id: true, plantId: true } });
  if (!run) throw new RouteError(404, "Pre-production run not found");
  return run;
}

// Every TO_QC/TO_PLANT transfer logged against this run — QC needs the
// pending TO_QC ones to know what to confirm; Production/Store need the
// pending TO_PLANT ones the same way.
qcSampleRouter.get("/pre-productions/:preProductionId/transfers", requireRole("QA_QC", "RND", "PRODUCTION", "STORE"), async (req: AuthedRequest<{ preProductionId: string }>, res, next) => {
  try {
    const { status } = req.query as { status?: string };
    const transfers = await prisma.qcSampleTransfer.findMany({
      where: {
        preProductionId: req.params.preProductionId,
        deletedAt: null,
        ...(status === "PENDING" ? { confirmedAt: null } : status === "CONFIRMED" ? { confirmedAt: { not: null } } : {}),
      },
      include: transferInclude,
      orderBy: { sentAt: "desc" },
    });
    res.json(transfers.map(serializeTransfer));
  } catch (err) {
    next(err);
  }
});

// Step 2 — QC confirms receipt of a sample Dispensing sent. Only after
// this does the sample count toward what QC can consume/test. RND
// alongside QA_QC — inward QC (which this sample lifecycle feeds into)
// is R&D's own access too, same as the rest of this pipeline's QC work.
qcSampleRouter.post(
  "/pre-productions/:preProductionId/transfers/:id/confirm",
  requireRole("QA_QC", "RND"),
  async (req: AuthedRequest<{ preProductionId: string; id: string }>, res, next) => {
    try {
      const existing = await prisma.qcSampleTransfer.findUnique({ where: { id: req.params.id } });
      if (!existing || existing.preProductionId !== req.params.preProductionId || existing.deletedAt) return res.status(404).json({ error: "Transfer not found" });
      if (existing.direction !== "TO_QC") return res.status(400).json({ error: "Only a sample sent to QC can be confirmed here — see the return endpoint for the other direction." });
      if (existing.confirmedAt) return res.status(409).json({ error: "Already confirmed." });

      const updated = await prisma.$transaction(async (tx) => {
        await tx.qcSampleTransaction.create({
          data: {
            preProductionId: existing.preProductionId,
            itemId: existing.itemId,
            type: "INBOUND",
            quantity: existing.quantity,
            unit: existing.unit,
            transferId: existing.id,
            createdById: req.user!.id,
          },
        });
        return tx.qcSampleTransfer.update({ where: { id: existing.id }, data: { confirmedById: req.user!.id, confirmedAt: new Date() }, include: transferInclude });
      });

      await recordAudit({ actorId: req.user!.id, action: "qc_sample_transfer.confirmed", entityType: "QcSampleTransfer", entityId: updated.id });
      res.json(serializeTransfer(updated));
    } catch (err) {
      next(err);
    }
  },
);

// Step 4 — QC sends any untested leftover back to the Plant. Purely a
// traceability record, same "one-way, no reversal" reasoning as the
// Recycle Store (see schema.prisma): the Plant's balance was already
// permanently reduced the moment this material was dispensed as sample,
// and this system has no second inflow type to reverse that with — it
// isn't restored here.
qcSampleRouter.post(
  "/pre-productions/:preProductionId/return",
  requireRole("QA_QC", "RND"),
  validateBody(returnQcSampleSchema),
  async (req: AuthedRequest<{ preProductionId: string }>, res, next) => {
    try {
      const run = await requirePreProduction(req.params.preProductionId);
      const { itemId, quantity, unit, note } = req.body as ReturnQcSampleInput;
      const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
      if (!item) return res.status(400).json({ error: "Unknown inventory item" });

      const transfer = await runSerializable(async (tx) => {
        const onHand = await getQcSampleOnHand(run.id, [itemId], tx);
        const currentStock = onHand.get(itemId) ?? 0;
        if (quantity > currentStock) {
          throw new RouteError(409, `Only ${currentStock} ${unit} actually on hand for this run's QC sample — can't return more than what's there.`);
        }
        const created = await tx.qcSampleTransfer.create({
          data: { preProductionId: run.id, direction: "TO_PLANT", itemId, quantity, unit, note, sentById: req.user!.id },
          include: transferInclude,
        });
        await tx.qcSampleTransaction.create({
          data: { preProductionId: run.id, itemId, type: "RETURNED", quantity, unit, note, transferId: created.id, createdById: req.user!.id },
        });
        return created;
      });

      await recordAudit({ actorId: req.user!.id, action: "qc_sample_transfer.returned", entityType: "QcSampleTransfer", entityId: transfer.id, metadata: { itemId, quantity, unit } });
      await notifyRoles(["PRODUCTION", "STORE"], { title: `${item.name} leftover returned from QC`, body: `${quantity} ${unit}`, link: `/pre-productions/${run.id}` }, req.user!.id).catch(
        (err) => req.log?.error({ err }, "notify failed: qc_sample_transfer.returned"),
      );

      res.status(201).json(serializeTransfer(transfer));
    } catch (err) {
      next(err);
    }
  },
);

// Step 3 — QC actually tests (or wastes, or rejects) part of what's
// confirmed on hand for this run.
qcSampleRouter.post(
  "/pre-productions/:preProductionId/consume",
  requireRole("QA_QC", "RND"),
  validateBody(consumeQcSampleSchema),
  async (req: AuthedRequest<{ preProductionId: string }>, res, next) => {
    try {
      const run = await requirePreProduction(req.params.preProductionId);
      const { itemId, quantity, unit, consumeReason, note } = req.body as ConsumeQcSampleInput;
      const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
      if (!item) return res.status(400).json({ error: "Unknown inventory item" });

      const txn = await runSerializable(async (tx) => {
        const onHand = await getQcSampleOnHand(run.id, [itemId], tx);
        const currentStock = onHand.get(itemId) ?? 0;
        if (quantity > currentStock) {
          throw new RouteError(409, `Only ${currentStock} ${unit} actually on hand for this run's QC sample — can't consume more than what's there.`);
        }
        return tx.qcSampleTransaction.create({
          data: { preProductionId: run.id, itemId, type: "CONSUMED", quantity, unit, consumeReason, note, createdById: req.user!.id },
        });
      });

      await recordAudit({ actorId: req.user!.id, action: "qc_sample.consumed", entityType: "QcSampleTransaction", entityId: txn.id, metadata: { itemId, quantity, consumeReason } });
      res.status(201).json(txn);
    } catch (err) {
      next(err);
    }
  },
);

// This run's full QC-sample activity + live per-item on-hand — what the
// SAMPLE_QC_APPROVAL stage's own UI reads before letting QC set
// sampleQcStatus to Approved.
qcSampleRouter.get(
  "/pre-productions/:preProductionId/summary",
  requireRole("QA_QC", "RND", "PRODUCTION", "STORE"),
  async (req: AuthedRequest<{ preProductionId: string }>, res, next) => {
    try {
      const run = await requirePreProduction(req.params.preProductionId);
      const [transfers, transactions] = await Promise.all([
        prisma.qcSampleTransfer.findMany({ where: { preProductionId: run.id, deletedAt: null }, include: transferInclude, orderBy: { sentAt: "desc" } }),
        prisma.qcSampleTransaction.findMany({
          where: { preProductionId: run.id, deletedAt: null },
          include: { item: { select: { id: true, category: true, name: true } }, createdBy: { select: { fullName: true, email: true } } },
          orderBy: { createdAt: "desc" },
        }),
      ]);
      const itemIds = [...new Set(transactions.map((t) => t.itemId))];
      const onHand = await getQcSampleOnHand(run.id, itemIds.length > 0 ? itemIds : undefined);

      res.json({
        transfers: transfers.map(serializeTransfer),
        transactions: transactions.map((t) => ({
          id: t.id,
          itemId: t.itemId,
          itemName: t.item.name,
          category: t.item.category,
          type: t.type,
          quantity: t.quantity,
          unit: t.unit,
          consumeReason: t.consumeReason,
          note: t.note,
          createdAt: t.createdAt,
          createdByName: t.createdBy.fullName || t.createdBy.email,
        })),
        onHand: Object.fromEntries(onHand),
      });
    } catch (err) {
      next(err);
    }
  },
);
