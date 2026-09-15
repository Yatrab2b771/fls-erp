import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { RouteError } from "../../common/lib/route-error";
import { assertDayStoreAccess } from "./day-store-access";
import { getOnHandByDayStoreAndItem, getOnHandByPlantAndItem } from "./stock";
import { createStockTransferSchema, type CreateStockTransferInput } from "./stock-transfers.schemas";

export const stockTransfersRouter = Router();

stockTransfersRouter.use(requireAuth);

function notifyFailed(req: AuthedRequest, label: string) {
  return (err: unknown) => req.log?.error({ err }, `notify failed: ${label}`);
}

const transferInclude = {
  item: { select: { id: true, name: true, category: true } },
  sourceDayStore: { select: { id: true, name: true } },
  sourcePlant: { select: { id: true, name: true } },
  destDayStore: { select: { id: true, name: true } },
  destPlant: { select: { id: true, name: true } },
  sentBy: { select: { id: true, fullName: true } },
  confirmedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.StockTransferInclude;

type TransferWithRelations = Prisma.StockTransferGetPayload<{ include: typeof transferInclude }>;

function sourceName(t: TransferWithRelations): string {
  return t.sourceDayStore?.name ?? t.sourcePlant?.name ?? "Unknown source";
}

// Flattened, frontend-ready shape — same naming convention RndTransfer's
// own serializeTransfer uses (itemName/sentByName/etc., a computed
// status), not nested relation objects.
function serializeTransfer(t: TransferWithRelations) {
  return {
    id: t.id,
    itemId: t.itemId,
    itemName: t.item.name,
    category: t.item.category,
    quantity: t.quantity,
    unit: t.unit,
    note: t.note,
    sourceType: t.sourceType,
    sourceDayStoreId: t.sourceDayStoreId,
    sourceDayStoreName: t.sourceDayStore?.name ?? null,
    sourcePlantId: t.sourcePlantId,
    sourcePlantName: t.sourcePlant?.name ?? null,
    destinationType: t.destinationType,
    destDayStoreId: t.destDayStoreId,
    destDayStoreName: t.destDayStore?.name ?? null,
    destPlantId: t.destPlantId,
    destPlantName: t.destPlant?.name ?? null,
    preProductionId: t.preProductionId,
    sentAt: t.sentAt,
    sentByName: t.sentBy.fullName,
    confirmedAt: t.confirmedAt,
    confirmedByName: t.confirmedBy?.fullName ?? null,
    status: t.confirmedAt ? ("CONFIRMED" as const) : ("PENDING" as const),
  };
}

// Broad read — every department this can touch (Store sending/receiving,
// Production sending from/receiving at a Plant, PPIC overseeing) needs
// visibility.
const READ_ROLES = ["STORE", "PRODUCTION", "PPIC"] as const;

stockTransfersRouter.get("/", requireRole(...READ_ROLES), async (req, res, next) => {
  try {
    const status = req.query.status as "PENDING" | "CONFIRMED" | undefined;
    const where: Prisma.StockTransferWhereInput = {
      deletedAt: null,
      ...(status === "PENDING" ? { confirmedAt: null } : status === "CONFIRMED" ? { confirmedAt: { not: null } } : {}),
    };
    const transfers = await prisma.stockTransfer.findMany({ where, include: transferInclude, orderBy: { sentAt: "desc" } });
    res.json(transfers.map(serializeTransfer));
  } catch (err) {
    next(err);
  }
});

// Store sends material out of a Day Store it manages, or Production sends
// it out of a Plant (the "return unused RM/PM" leg of Plant Consumption)
// — to another Day Store, to the Warehouse, or to a Plant. The source's
// on-hand drops the instant this is created (see stock.ts) — the
// destination only sees it once confirmed below.
stockTransfersRouter.post("/", requireRole("STORE", "PRODUCTION"), validateBody(createStockTransferSchema), async (req: AuthedRequest, res, next) => {
  try {
    const input = req.body as CreateStockTransferInput;

    if (input.sourceType === "DAY_STORE") {
      if (!req.user!.roles.includes("STORE") && !req.user!.roles.includes("ADMIN")) {
        return res.status(403).json({ error: "Only Store can send from a Day Store" });
      }
      await assertDayStoreAccess(req.user!.id, req.user!.roles, input.sourceDayStoreId!);
    } else {
      if (!req.user!.roles.includes("PRODUCTION") && !req.user!.roles.includes("ADMIN")) {
        return res.status(403).json({ error: "Only Production can send from a Plant" });
      }
    }

    const item = await prisma.inventoryItem.findUnique({ where: { id: input.itemId }, select: { id: true } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });
    if (input.destDayStoreId) {
      const destStore = await prisma.dayStore.findUnique({ where: { id: input.destDayStoreId }, select: { id: true } });
      if (!destStore) return res.status(400).json({ error: "Unknown destination Day Store" });
    }
    if (input.destPlantId) {
      const destPlant = await prisma.plant.findUnique({ where: { id: input.destPlantId }, select: { id: true } });
      if (!destPlant) return res.status(400).json({ error: "Unknown destination Plant" });
    }

    // Same check-then-write-under-SERIALIZABLE pattern every other gated
    // issue in this app uses (see inventory.routes.ts) — closes the race
    // between two users reading the same on-hand number and both passing
    // a check that's individually correct but jointly overdraws.
    const transfer = await runSerializable(async (tx) => {
      const currentStock =
        input.sourceType === "DAY_STORE"
          ? ((await getOnHandByDayStoreAndItem(input.sourceDayStoreId!, [input.itemId], tx)).get(input.itemId)?.onHand ?? 0)
          : ((await getOnHandByPlantAndItem(input.sourcePlantId!, [input.itemId], tx)).get(input.itemId) ?? 0);
      if (input.quantity > currentStock) {
        throw new RouteError(409, `Only ${currentStock} ${input.unit} actually on hand there — can't send more than what's there.`);
      }
      return tx.stockTransfer.create({
        data: { ...input, sentById: req.user!.id },
        include: transferInclude,
      });
    });

    await recordAudit({
      actorId: req.user!.id,
      action: "stock_transfer.sent",
      entityType: "StockTransfer",
      entityId: transfer.id,
      metadata: { itemId: input.itemId, quantity: input.quantity, sourceType: input.sourceType, destinationType: input.destinationType },
    });

    const notifyTargetRole = transfer.destinationType === "PLANT" ? "PRODUCTION" : "STORE";
    await notifyRoles(
      [notifyTargetRole],
      { title: `${transfer.item.name} on its way`, body: `${transfer.quantity} ${transfer.unit} from ${sourceName(transfer)} — confirm once it arrives.`, link: "/stock-transfers" },
      req.user!.id,
    ).catch(notifyFailed(req, "stock_transfer.sent"));

    res.status(201).json(serializeTransfer(transfer));
  } catch (err) {
    next(err);
  }
});

stockTransfersRouter.post("/:id/confirm", requireRole("STORE", "PRODUCTION"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const transfer = await prisma.stockTransfer.findUnique({ where: { id: req.params.id }, include: transferInclude });
    if (!transfer || transfer.deletedAt) return res.status(404).json({ error: "Transfer not found" });
    if (transfer.confirmedAt) return res.status(409).json({ error: "This transfer has already been confirmed" });

    // Who may confirm depends on where it's headed: Production confirms
    // at a Plant, Store confirms everywhere else (another Day Store, or
    // the Warehouse) — same department split RndTransfer's own two
    // directions use, regardless of what the source side was.
    if (transfer.destinationType === "PLANT") {
      if (!req.user!.roles.includes("PRODUCTION") && !req.user!.roles.includes("ADMIN")) {
        return res.status(403).json({ error: "Only Production can confirm a transfer headed to a Plant" });
      }
    } else {
      if (!req.user!.roles.includes("STORE") && !req.user!.roles.includes("ADMIN")) {
        return res.status(403).json({ error: "Only Store can confirm this transfer" });
      }
      if (transfer.destinationType === "DAY_STORE" && transfer.destDayStoreId) {
        await assertDayStoreAccess(req.user!.id, req.user!.roles, transfer.destDayStoreId);
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      // A WAREHOUSE destination has no location-scoped balance to net
      // against (Warehouse ownership is derived by item category, not a
      // location FK — see schema.prisma) — so confirming here creates a
      // real RECEIVED row instead, same "never left company custody,
      // skip inward QC" shape as an R&D return (isRndReturn).
      if (transfer.destinationType === "WAREHOUSE") {
        await tx.inventoryTransaction.create({
          data: {
            itemId: transfer.itemId,
            type: "RECEIVED",
            date: new Date(),
            unit: transfer.unit,
            quantity: transfer.quantity,
            receiptStatus: "ACCEPTED",
            acceptedById: req.user!.id,
            acceptedAt: new Date(),
            isStockTransferReceipt: true,
            isTransitTracked: false,
            deliveredAt: new Date(),
            deliveredById: req.user!.id,
            createdById: req.user!.id,
            stockTransferId: transfer.id,
            remark: `Returned from ${sourceName(transfer)}`,
          },
        });
      }
      // DAY_STORE and PLANT destinations need no ledger row of their own
      // — stock.ts's getOnHandByDayStoreAndItem/getOnHandByPlantAndItem
      // already net a confirmed StockTransfer row directly.
      return tx.stockTransfer.update({
        where: { id: transfer.id },
        data: { confirmedById: req.user!.id, confirmedAt: new Date() },
        include: transferInclude,
      });
    });

    await recordAudit({ actorId: req.user!.id, action: "stock_transfer.confirmed", entityType: "StockTransfer", entityId: updated.id });

    await notifyUser(transfer.sentById, {
      title: `${transfer.item.name} confirmed received`,
      body: `${transfer.quantity} ${transfer.unit} arrived at ${transfer.destDayStore?.name ?? transfer.destPlant?.name ?? "the Warehouse"}.`,
      link: "/stock-transfers",
    }).catch(notifyFailed(req, "stock_transfer.confirmed"));

    res.json(serializeTransfer(updated));
  } catch (err) {
    next(err);
  }
});

// Undo a wrong send while it's still unconfirmed — restores the source's
// on-hand immediately, since stock.ts's outflow terms only count
// non-deleted rows. Restricted to whoever sent it (or ADMIN): once the
// other side has acted (confirmed), this is no longer available — the
// undo would then have to unwind a real receipt too, which is a
// different, riskier operation this route deliberately doesn't attempt.
stockTransfersRouter.delete("/:id", requireRole("STORE", "PRODUCTION"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const transfer = await prisma.stockTransfer.findUnique({ where: { id: req.params.id } });
    if (!transfer || transfer.deletedAt) return res.status(404).json({ error: "Transfer not found" });
    if (transfer.confirmedAt) return res.status(409).json({ error: "Already confirmed by the receiving side — can't be undone here" });
    if (transfer.sentById !== req.user!.id && !req.user!.roles.includes("ADMIN")) {
      return res.status(403).json({ error: "Only the person who sent this can undo it" });
    }

    await prisma.stockTransfer.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), deletedById: req.user!.id } });

    await recordAudit({ actorId: req.user!.id, action: "stock_transfer.cancelled", entityType: "StockTransfer", entityId: req.params.id });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
