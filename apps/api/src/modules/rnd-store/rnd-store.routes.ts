import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { RouteError } from "../../common/lib/route-error";
import { getOnHandByItemId } from "../inventory/stock";
import { recordIssueLots } from "../inventory/lots";
import { receiveTransferSchema, rejectTransferSchema, resolveShortReceipt, type ReceiveTransferInput, type RejectTransferInput } from "../inventory/transit";
import { getRndStoreOnHand } from "./rnd-stock";
import {
  createRndTransferSchema,
  consumeAtRndSchema,
  dispatchToCustomerSchema,
  createRndSampleRequestSchema,
  rejectRndSampleRequestSchema,
  importRndSampleRequestsSchema,
  type CreateRndTransferInput,
  type ConsumeAtRndInput,
  type DispatchToCustomerInput,
  type CreateRndSampleRequestInput,
  type RejectRndSampleRequestInput,
  type ImportRndSampleRequestsInput,
} from "./rnd-store.schemas";

// R&D Store — a second stock ledger for R&D's own sample lifecycle, per
// the client's 6-step description (see the schema.prisma comment block
// on RndTransfer/RndStoreTransaction for the full mapping). Two-sided
// transfers (Warehouse<->R&D) are sender-creates/receiver-confirms, same
// shape as a Material Request or a Dispatch Transfer elsewhere in this
// app; the purely-R&D-side events (consume, dispatch to customer) are
// single actions with no other department's sign-off needed.
export const rndStoreRouter = Router();

rndStoreRouter.use(requireAuth);

const transferInclude = {
  item: { select: { id: true, category: true, name: true } },
  sentBy: { select: { fullName: true, email: true } },
  confirmedBy: { select: { fullName: true, email: true } },
} as const;

function serializeTransfer(t: {
  id: string;
  direction: string;
  itemId: string;
  quantity: number;
  unit: string;
  note: string | null;
  sentAt: Date;
  confirmedAt: Date | null;
  shortQty?: number | null;
  shortNote?: string | null;
  item: { id: string; category: string; name: string };
  sentBy: { fullName: string; email: string };
  confirmedBy: { fullName: string; email: string } | null;
}) {
  return {
    id: t.id,
    shortQty: t.shortQty ?? null,
    shortNote: t.shortNote ?? null,
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

// Creates the actual TO_RND RndTransfer + its immediate Warehouse-side
// ISSUED_RND ledger effect. Shared by the (ADMIN-only) direct push below
// and by fulfilling an RndSampleRequest, which is the normal path now —
// see the module comment on RndSampleRequest in schema.prisma.
async function createSampleSendToRnd(params: { itemId: string; quantity: number; unit: string; note: string | null; sentById: string }) {
  const { itemId, quantity, unit, note, sentById } = params;
  return runSerializable(async (tx) => {
    const onHand = await getOnHandByItemId([itemId], tx);
    const currentStock = onHand.get(itemId) ?? 0;
    if (quantity > currentStock) {
      throw new RouteError(409, `Only ${currentStock} ${unit} actually on hand in the Warehouse — can't send more than what's in stock.`);
    }
    const created = await tx.rndTransfer.create({ data: { direction: "TO_RND", itemId, quantity, unit, note, sentById }, include: transferInclude });
    const issue = await tx.inventoryTransaction.create({
      data: { itemId, type: "ISSUED_RND", date: new Date(), unit, quantity, remark: note ? `Sent to R&D Store — ${note}` : "Sent to R&D Store", createdById: sentById, rndTransferId: created.id },
    });
    await recordIssueLots(tx, issue);
    return created;
  });
}

// Step 1 (STORE -> R&D) / Step 5 (R&D -> STORE) — the sender's own side
// of the ledger moves immediately; the other department's side only
// moves once they confirm (see POST /transfers/:id/confirm below).
rndStoreRouter.post("/transfers", validateBody(createRndTransferSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { direction, itemId, quantity, unit, note } = req.body as CreateRndTransferInput;
    const isAdmin = req.user!.roles.includes("ADMIN");

    if (direction === "TO_RND") {
      // Normal path is R&D raising a request and Store fulfilling it
      // (POST /requests/:id/fulfill) — Store can no longer push a sample
      // out of thin air any more than it can issue to Production without
      // an InventoryRequest. ADMIN keeps a direct override for edge cases.
      if (!isAdmin) return res.status(403).json({ error: "Warehouse can no longer send a sample directly — fulfill an R&D request instead." });

      const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
      if (!item) return res.status(400).json({ error: "Unknown inventory item" });

      const transfer = await createSampleSendToRnd({ itemId, quantity, unit, note: note ?? null, sentById: req.user!.id });

      await recordAudit({ actorId: req.user!.id, action: "rnd_transfer.sent_to_rnd", entityType: "RndTransfer", entityId: transfer.id, metadata: { itemId, quantity, unit } });
      await notifyRoles(["RND"], { title: `${item.name} sent to R&D Store`, body: `${quantity} ${unit} — confirm receipt.`, link: "/rnd-store" }, req.user!.id).catch((err) =>
        req.log?.error({ err }, "notify failed: rnd_transfer.sent_to_rnd"),
      );

      return res.status(201).json(serializeTransfer(transfer));
    }

    // direction === "TO_WAREHOUSE"
    if (!req.user!.roles.includes("RND") && !isAdmin) return res.status(403).json({ error: "Only R&D can send leftover material back to the Warehouse." });

    const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });

    const transfer = await runSerializable(async (tx) => {
      const onHand = await getRndStoreOnHand([itemId], tx);
      const currentStock = onHand.get(itemId) ?? 0;
      if (quantity > currentStock) {
        throw new RouteError(409, `Only ${currentStock} ${unit} actually on hand at the R&D Store — can't send back more than what's there.`);
      }
      const created = await tx.rndTransfer.create({ data: { direction, itemId, quantity, unit, note, sentById: req.user!.id }, include: transferInclude });
      await tx.rndStoreTransaction.create({
        data: { itemId, type: "RETURNED", quantity, unit, note, transferId: created.id, createdById: req.user!.id },
      });
      return created;
    });

    await recordAudit({ actorId: req.user!.id, action: "rnd_transfer.sent_to_warehouse", entityType: "RndTransfer", entityId: transfer.id, metadata: { itemId, quantity, unit } });
    await notifyRoles(["STORE"], { title: `${item.name} returned from R&D Store`, body: `${quantity} ${unit} — confirm receipt.`, link: "/rnd-store" }, req.user!.id).catch((err) =>
      req.log?.error({ err }, "notify failed: rnd_transfer.sent_to_warehouse"),
    );

    res.status(201).json(serializeTransfer(transfer));
  } catch (err) {
    next(err);
  }
});

// Step 2 (R&D confirms Store's send) / Step 6 (Store confirms R&D's
// return). The receiving department's own side of the ledger only moves
// here, not at creation — see the module comment above.
rndStoreRouter.post("/transfers/:id/confirm", validateBody(receiveTransferSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.rndTransfer.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.deletedAt) return res.status(404).json({ error: "Transfer not found" });
    if (existing.confirmedAt) return res.status(409).json({ error: "Already confirmed." });
    // How much actually arrived (less than was sent needs a reason and is kept as a recorded transit loss).
    const received = resolveShortReceipt(existing.quantity, req.body as ReceiveTransferInput);

    const isAdmin = req.user!.roles.includes("ADMIN");
    const item = await prisma.inventoryItem.findUnique({ where: { id: existing.itemId } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });

    if (existing.direction === "TO_RND") {
      if (!req.user!.roles.includes("RND") && !isAdmin) return res.status(403).json({ error: "Only R&D can confirm receipt of a sample sent to the R&D Store." });

      const updated = await prisma.$transaction(async (tx) => {
        await tx.rndStoreTransaction.create({
          data: { itemId: existing.itemId, type: "INBOUND", quantity: received.receivedQty, unit: existing.unit, transferId: existing.id, createdById: req.user!.id },
        });
        return tx.rndTransfer.update({ where: { id: existing.id }, data: { confirmedById: req.user!.id, confirmedAt: new Date(), shortQty: received.shortQty, shortNote: received.shortNote }, include: transferInclude });
      });

      await recordAudit({ actorId: req.user!.id, action: "rnd_transfer.confirmed_at_rnd", entityType: "RndTransfer", entityId: updated.id });
      return res.json(serializeTransfer(updated));
    }

    // direction === "TO_WAREHOUSE"
    if (!req.user!.roles.includes("STORE") && !isAdmin) return res.status(403).json({ error: "Only Store can confirm receipt of material returned from the R&D Store." });

    const updated = await prisma.$transaction(async (tx) => {
      await tx.inventoryTransaction.create({
        data: {
          itemId: existing.itemId,
          type: "RECEIVED",
          date: new Date(),
          unit: existing.unit,
          quantity: received.receivedQty,
          isRndReturn: true,
          receiptStatus: "ACCEPTED",
          acceptedById: req.user!.id,
          acceptedAt: new Date(),
          remark: "Returned from R&D Store",
          createdById: req.user!.id,
        },
      });
      return tx.rndTransfer.update({ where: { id: existing.id }, data: { confirmedById: req.user!.id, confirmedAt: new Date(), shortQty: received.shortQty, shortNote: received.shortNote }, include: transferInclude });
    });

    await recordAudit({ actorId: req.user!.id, action: "rnd_transfer.confirmed_at_warehouse", entityType: "RndTransfer", entityId: updated.id, metadata: received.shortQty ? { shortQty: received.shortQty, shortNote: received.shortNote } : undefined });
    res.json(serializeTransfer(updated));
  } catch (err) {
    next(err);
  }
});

/**
 * Takes a not-yet-confirmed transfer back out of the books, giving the material back to the sender. Used both by the sender
 * cancelling a wrong send and by the receiver refusing it (`rejectedReason`). Confirmed transfers can't be undone this way.
 */
async function reversePendingTransfer(existing: { id: string; direction: string; itemId: string; quantity: number; sentById: string; sentAt: Date }, actorId: string, rejectedReason?: string) {
  await prisma.$transaction(async (tx) => {
    await tx.rndTransfer.update({ where: { id: existing.id }, data: { deletedAt: new Date(), deletedById: actorId, ...(rejectedReason ? { rejectedReason } : {}) } });
    if (existing.direction === "TO_RND") {
      // The Warehouse-side issue: linked directly on new rows; older rows are matched by item, quantity and moment of sending.
      const linked = await tx.inventoryTransaction.findFirst({ where: { rndTransferId: existing.id, deletedAt: null }, select: { id: true } });
      const legacy = linked
        ? null
        : await tx.inventoryTransaction.findFirst({
            where: { type: "ISSUED_RND", itemId: existing.itemId, quantity: existing.quantity, deletedAt: null, rndTransferId: null, createdAt: { gte: new Date(existing.sentAt.getTime() - 60_000), lte: new Date(existing.sentAt.getTime() + 60_000) } },
            select: { id: true },
          });
      const issueId = linked?.id ?? legacy?.id;
      if (issueId) await tx.inventoryTransaction.update({ where: { id: issueId }, data: { deletedAt: new Date(), deletedById: actorId } });
    } else {
      // R&D's side of a return: the RETURNED row dropped its balance when it was sent.
      await tx.rndStoreTransaction.updateMany({ where: { transferId: existing.id, deletedAt: null }, data: { deletedAt: new Date(), deletedById: actorId } });
    }
  });
}

// The sender takes back a transfer the other side has not confirmed yet (wrong item / quantity).
rndStoreRouter.delete("/transfers/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.rndTransfer.findUnique({ where: { id: req.params.id }, include: { item: { select: { name: true } } } });
    if (!existing || existing.deletedAt) return res.status(404).json({ error: "Transfer not found" });
    if (existing.confirmedAt) return res.status(409).json({ error: "Already confirmed by the receiving side - it can't be cancelled here." });
    const isAdmin = req.user!.roles.includes("ADMIN");
    if (!isAdmin && existing.sentById !== req.user!.id) return res.status(403).json({ error: "Only the person who sent this can cancel it." });
    await reversePendingTransfer(existing, req.user!.id);
    await recordAudit({ actorId: req.user!.id, action: "rnd_transfer.cancelled", entityType: "RndTransfer", entityId: existing.id });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// The receiving side refuses a transfer (wrong item, damaged, not what was asked for): the material goes back to the sender.
rndStoreRouter.post("/transfers/:id/reject", validateBody(rejectTransferSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.rndTransfer.findUnique({ where: { id: req.params.id }, include: { item: { select: { name: true } } } });
    if (!existing || existing.deletedAt) return res.status(404).json({ error: "Transfer not found" });
    if (existing.confirmedAt) return res.status(409).json({ error: "Already confirmed - it can't be refused any more." });
    const isAdmin = req.user!.roles.includes("ADMIN");
    const roles = req.user!.roles;
    // R&D receives what the Warehouse sends it; the Warehouse receives what R&D sends back.
    if (existing.direction === "TO_RND" ? !roles.includes("RND") && !isAdmin : !roles.includes("STORE") && !isAdmin) {
      return res.status(403).json({ error: existing.direction === "TO_RND" ? "Only R&D can refuse a sample sent to the R&D Store." : "Only Store can refuse material returned from the R&D Store." });
    }
    const { reason } = req.body as RejectTransferInput;
    await reversePendingTransfer(existing, req.user!.id, reason);
    await recordAudit({ actorId: req.user!.id, action: "rnd_transfer.refused", entityType: "RndTransfer", entityId: existing.id, metadata: { reason } });
    await notifyUser(existing.sentById, {
      title: `${existing.item.name} refused`,
      body: `${existing.quantity} ${existing.unit} was refused: ${reason}. It is back in your stock.`,
      link: "/rnd-store",
    }).catch((err) => req.log?.error({ err }, "notify failed: rnd_transfer.refused"));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

rndStoreRouter.get("/transfers", requireRole("STORE", "RND"), async (req: AuthedRequest, res, next) => {
  try {
    const { status } = req.query as { status?: string };
    const transfers = await prisma.rndTransfer.findMany({
      where: { deletedAt: null, ...(status === "PENDING" ? { confirmedAt: null } : status === "CONFIRMED" ? { confirmedAt: { not: null } } : {}) },
      include: transferInclude,
      orderBy: { sentAt: "desc" },
    });
    res.json(transfers.map(serializeTransfer));
  } catch (err) {
    next(err);
  }
});

const requestInclude = {
  item: { select: { id: true, category: true, name: true } },
  requestedBy: { select: { fullName: true, email: true } },
  reviewedBy: { select: { fullName: true, email: true } },
} as const;

function serializeRequest(r: {
  id: string;
  itemId: string;
  quantity: number;
  unit: string;
  note: string | null;
  status: string;
  requestedAt: Date;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  transferId: string | null;
  item: { id: string; category: string; name: string };
  requestedBy: { fullName: string; email: string };
  reviewedBy: { fullName: string; email: string } | null;
}) {
  return {
    id: r.id,
    itemId: r.itemId,
    itemName: r.item.name,
    category: r.item.category,
    quantity: r.quantity,
    unit: r.unit,
    note: r.note,
    status: r.status,
    requestedAt: r.requestedAt,
    requestedByName: r.requestedBy.fullName || r.requestedBy.email,
    reviewedAt: r.reviewedAt,
    reviewedByName: r.reviewedBy ? r.reviewedBy.fullName || r.reviewedBy.email : null,
    rejectionReason: r.rejectionReason,
    transferId: r.transferId,
  };
}

// R&D asking Store for material — the real trigger for step 1. Raised
// while mid-research on a new product PPIC asked for (see RecipeRequest);
// Store sees it and fulfills or rejects it below.
rndStoreRouter.post("/requests", requireRole("RND"), validateBody(createRndSampleRequestSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { itemId, quantity, unit, note, sampleRequestId } = req.body as CreateRndSampleRequestInput;
    const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });
    if (sampleRequestId && !(await prisma.sampleRequest.findUnique({ where: { id: sampleRequestId }, select: { id: true } }))) return res.status(400).json({ error: "Unknown sample request" });

    const request = await prisma.rndSampleRequest.create({
      data: { itemId, quantity, unit, note, sampleRequestId, requestedById: req.user!.id },
      include: requestInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "rnd_sample_request.created", entityType: "RndSampleRequest", entityId: request.id, metadata: { itemId, quantity, unit } });
    await notifyRoles(["STORE"], { title: `R&D needs ${item.name}`, body: `${quantity} ${unit} requested for research.`, link: "/rnd-store" }, req.user!.id).catch((err) =>
      req.log?.error({ err }, "notify failed: rnd_sample_request.created"),
    );

    res.status(201).json(serializeRequest(request));
  } catch (err) {
    next(err);
  }
});

// Bulk request — one Excel sheet's worth of item asks at once, same
// resolve-or-create-item-by-name-then-createMany shape as
// /api/inventory/requests/import. Every row lands as its own PENDING
// request, same as if R&D had raised them one at a time.
rndStoreRouter.post("/requests/import", requireRole("RND"), validateBody(importRndSampleRequestsSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = req.body as ImportRndSampleRequestsInput;

    const uniqueItems = new Map<string, { category: "RM" | "PM"; name: string }>();
    for (const row of rows) uniqueItems.set(`${row.category}::${row.itemName}`, { category: row.category, name: row.itemName });

    const itemIds = new Map<string, string>();
    let itemsCreated = 0;
    for (const [key, { category, name }] of uniqueItems) {
      const existing = await prisma.inventoryItem.findUnique({ where: { category_name: { category, name } } });
      if (existing) {
        itemIds.set(key, existing.id);
      } else {
        const created = await prisma.inventoryItem.create({ data: { category, name } });
        itemIds.set(key, created.id);
        itemsCreated += 1;
      }
    }

    const result = await prisma.rndSampleRequest.createMany({
      data: rows.map((row) => ({
        itemId: itemIds.get(`${row.category}::${row.itemName}`)!,
        quantity: row.quantity,
        unit: row.unit,
        note: row.note,
        requestedById: req.user!.id,
      })),
    });

    await recordAudit({ actorId: req.user!.id, action: "rnd_sample_requests.imported", entityType: "RndSampleRequest", metadata: { rowCount: result.count, itemsCreated } });
    await notifyRoles(["STORE"], { title: `${result.count} new R&D sample request(s)`, body: "Bulk import — check the R&D Store page.", link: "/rnd-store" }, req.user!.id).catch((err) =>
      req.log?.error({ err }, "notify failed: rnd_sample_requests.imported"),
    );

    res.status(201).json({ requestsCreated: result.count, itemsCreated });
  } catch (err) {
    next(err);
  }
});

rndStoreRouter.get("/requests", requireRole("STORE", "RND"), async (req: AuthedRequest, res, next) => {
  try {
    const { status } = req.query as { status?: string };
    const requests = await prisma.rndSampleRequest.findMany({
      where: status ? { status: status as never } : {},
      include: requestInclude,
      orderBy: { requestedAt: "desc" },
    });
    res.json(requests.map(serializeRequest));
  } catch (err) {
    next(err);
  }
});

// Store fulfilling a request is what actually sends the sample — same
// stock-guarded creation the old direct push used, just gated behind a
// real ask from R&D now.
rndStoreRouter.post("/requests/:id/fulfill", requireRole("STORE"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.rndSampleRequest.findUnique({ where: { id: req.params.id }, include: { item: true } });
    if (!existing) return res.status(404).json({ error: "Request not found" });
    if (existing.status !== "PENDING") return res.status(409).json({ error: `Already ${existing.status.toLowerCase()}.` });

    const transfer = await createSampleSendToRnd({
      itemId: existing.itemId,
      quantity: existing.quantity,
      unit: existing.unit,
      note: existing.note,
      sentById: req.user!.id,
    });

    const updated = await prisma.rndSampleRequest.update({
      where: { id: existing.id },
      data: { status: "FULFILLED", reviewedById: req.user!.id, reviewedAt: new Date(), transferId: transfer.id },
      include: requestInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "rnd_sample_request.fulfilled", entityType: "RndSampleRequest", entityId: updated.id, metadata: { transferId: transfer.id } });
    await notifyRoles(["RND"], { title: `${existing.item.name} sent — confirm receipt`, body: `${existing.quantity} ${existing.unit} sent to R&D Store.`, link: "/rnd-store" }, req.user!.id).catch(
      (err) => req.log?.error({ err }, "notify failed: rnd_sample_request.fulfilled"),
    );

    res.json(serializeRequest(updated));
  } catch (err) {
    next(err);
  }
});

rndStoreRouter.post("/requests/:id/reject", requireRole("STORE"), validateBody(rejectRndSampleRequestSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const { reason } = req.body as RejectRndSampleRequestInput;
    const existing = await prisma.rndSampleRequest.findUnique({ where: { id: req.params.id }, include: { item: true } });
    if (!existing) return res.status(404).json({ error: "Request not found" });
    if (existing.status !== "PENDING") return res.status(409).json({ error: `Already ${existing.status.toLowerCase()}.` });

    const updated = await prisma.rndSampleRequest.update({
      where: { id: existing.id },
      data: { status: "REJECTED", reviewedById: req.user!.id, reviewedAt: new Date(), rejectionReason: reason },
      include: requestInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "rnd_sample_request.rejected", entityType: "RndSampleRequest", entityId: updated.id, metadata: { reason } });
    await notifyRoles(["RND"], { title: `${existing.item.name} request rejected`, body: reason, link: "/rnd-store" }, req.user!.id).catch((err) =>
      req.log?.error({ err }, "notify failed: rnd_sample_request.rejected"),
    );

    res.json(serializeRequest(updated));
  } catch (err) {
    next(err);
  }
});

// R&D withdrawing its own still-pending ask.
rndStoreRouter.post("/requests/:id/cancel", requireRole("RND"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.rndSampleRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Request not found" });
    if (existing.status !== "PENDING") return res.status(409).json({ error: `Already ${existing.status.toLowerCase()}.` });
    if (existing.requestedById !== req.user!.id && !req.user!.roles.includes("ADMIN")) {
      return res.status(403).json({ error: "Only the person who raised this request can cancel it." });
    }

    const updated = await prisma.rndSampleRequest.update({
      where: { id: existing.id },
      data: { status: "CANCELLED", reviewedById: req.user!.id, reviewedAt: new Date() },
      include: requestInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "rnd_sample_request.cancelled", entityType: "RndSampleRequest", entityId: updated.id });
    res.json(serializeRequest(updated));
  } catch (err) {
    next(err);
  }
});

// --- "Received Material": R&D's whole journey of asking the Warehouse for material and receiving it. One row per request (and per direct
// push from the Warehouse with no request behind it). Status: Requested (waiting on the Warehouse) -> Issued (sent, R&D has to confirm
// receipt) -> Received, or Rejected / Cancelled. Each row carries the vendors this material came from (accepted Warehouse receipts,
// newest first, with batch / GRN / dates) and what the Warehouse has on hand now. ---

type VendorLine = { vendorName: string | null; batchNo: string | null; grnNo: string | null; mfgDate: Date | null; expiryDate: Date | null; quantity: number; unit: string; receivedAt: Date };

async function vendorsByItem(itemIds: string[]): Promise<Map<string, VendorLine[]>> {
  const out = new Map<string, VendorLine[]>();
  if (itemIds.length === 0) return out;
  const receipts = await prisma.inventoryTransaction.findMany({
    where: { itemId: { in: itemIds }, type: "RECEIVED", deletedAt: null, receiptStatus: "ACCEPTED", isRndReturn: false, isStockTransferReceipt: false, isOpeningStock: false },
    orderBy: { date: "desc" },
    select: { itemId: true, vendorName: true, batchNo: true, grnNo: true, mfgDate: true, expiryDate: true, quantity: true, unit: true, date: true },
  });
  for (const r of receipts) {
    const list = out.get(r.itemId) ?? [];
    if (list.length < 8) list.push({ vendorName: r.vendorName, batchNo: r.batchNo, grnNo: r.grnNo, mfgDate: r.mfgDate, expiryDate: r.expiryDate, quantity: r.quantity, unit: r.unit, receivedAt: r.date });
    out.set(r.itemId, list);
  }
  return out;
}

rndStoreRouter.get("/received-material", requireRole("RND"), async (_req, res, next) => {
  try {
    const [requests, directTransfers] = await Promise.all([
      prisma.rndSampleRequest.findMany({
        orderBy: { requestedAt: "desc" },
        take: 1000,
        include: {
          item: { select: { id: true, name: true, category: true } },
          requestedBy: { select: { fullName: true, email: true } },
          reviewedBy: { select: { fullName: true, email: true } },
          transfer: { include: { sentBy: { select: { fullName: true, email: true } }, confirmedBy: { select: { fullName: true, email: true } } } },
        },
      }),
      prisma.rndTransfer.findMany({
        where: { direction: "TO_RND", deletedAt: null, sampleRequest: null },
        orderBy: { sentAt: "desc" },
        take: 300,
        include: { item: { select: { id: true, name: true, category: true } }, sentBy: { select: { fullName: true, email: true } }, confirmedBy: { select: { fullName: true, email: true } } },
      }),
    ]);

    const itemIds = [...new Set([...requests.map((r) => r.itemId), ...directTransfers.map((t) => t.itemId)])];
    const [vendors, onHand] = await Promise.all([vendorsByItem(itemIds), itemIds.length ? getOnHandByItemId(itemIds) : Promise.resolve(new Map<string, number>())]);
    const name = (u: { fullName: string; email: string } | null | undefined) => (u ? u.fullName || u.email : null);
    const common = (itemId: string) => ({ vendors: vendors.get(itemId) ?? [], warehouseOnHand: onHand.get(itemId) ?? 0 });

    const rows = [
      ...requests.map((r) => {
        const tr = r.transfer;
        const status = r.status === "REJECTED" ? "REJECTED" : r.status === "CANCELLED" ? "CANCELLED" : r.status === "FULFILLED" ? (tr?.confirmedAt ? "RECEIVED" : "ISSUED") : "REQUESTED";
        return {
          key: `req-${r.id}`,
          requestId: r.id,
          transferId: tr?.id ?? null,
          itemId: r.itemId,
          itemName: r.item.name,
          category: r.item.category,
          quantity: r.quantity,
          unit: r.unit,
          note: r.note,
          status,
          requestedAt: r.requestedAt,
          requestedByName: name(r.requestedBy),
          issuedAt: tr?.sentAt ?? null,
          issuedByName: name(tr?.sentBy),
          receivedAt: tr?.confirmedAt ?? null,
          receivedByName: name(tr?.confirmedBy),
          rejectionReason: r.rejectionReason,
          ...common(r.itemId),
        };
      }),
      ...directTransfers.map((t) => ({
        key: `tr-${t.id}`,
        requestId: null,
        transferId: t.id,
        itemId: t.itemId,
        itemName: t.item.name,
        category: t.item.category,
        quantity: t.quantity,
        unit: t.unit,
        note: t.note,
        status: t.confirmedAt ? "RECEIVED" : "ISSUED",
        requestedAt: t.sentAt,
        requestedByName: null,
        issuedAt: t.sentAt,
        issuedByName: name(t.sentBy),
        receivedAt: t.confirmedAt,
        receivedByName: name(t.confirmedBy),
        rejectionReason: null,
        ...common(t.itemId),
      })),
    ].sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// --- "Material Utilization": for every material that has reached the R&D Store, where it came from, how much came in and when, and what
// became of it: Testing, Formulation trial, Customer sample (dispatched), Rejected, Returned to the Warehouse, Wastage - and what is left
// in stock. The R&D ledger is per material, not per lot, so the split is per material; the lots (receipts) and every usage entry are
// listed alongside. ---
rndStoreRouter.get("/utilization", requireRole("RND"), async (_req, res, next) => {
  try {
    const rows = await prisma.rndStoreTransaction.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "asc" },
      take: 10000,
      include: {
        item: { select: { id: true, name: true, category: true, unit: true } },
        customer: { select: { id: true, companyName: true } },
        transfer: { select: { sentAt: true, confirmedAt: true } },
      },
    });

    const byItem = new Map<string, typeof rows>();
    for (const r of rows) byItem.set(r.itemId, [...(byItem.get(r.itemId) ?? []), r]);
    const itemIds = [...byItem.entries()].filter(([, list]) => list.some((r) => r.type === "INBOUND")).map(([id]) => id);
    const warehouseVendors = await vendorsByItem(itemIds);
    const r3 = (n: number) => Math.round(n * 1000) / 1000;

    const out = itemIds.map((itemId) => {
      const list = byItem.get(itemId)!;
      const item = list[0]!.item;
      const sum = (pick: (r: (typeof rows)[number]) => boolean) => r3(list.filter(pick).reduce((s, r) => s + r.quantity, 0));
      const lots = list
        .filter((r) => r.type === "INBOUND")
        .map((r) => ({
          id: r.id,
          receivedAt: r.date ?? r.transfer?.confirmedAt ?? r.createdAt,
          quantity: r.quantity,
          unit: r.unit,
          source: r.transferId ? "Warehouse" : "Direct purchase",
          vendorName: r.transferId ? null : r.vendorName,
          invoiceNo: r.invoiceNo,
          batchNo: r.batchNo,
          expiryDate: r.expiryDate,
        }))
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
      const received = sum((r) => r.type === "INBOUND");
      const testing = sum((r) => r.type === "CONSUMED" && r.consumeReason === "TESTING");
      const formulation = sum((r) => r.type === "CONSUMED" && r.consumeReason === "FORMULATION_TRIAL");
      const wastage = sum((r) => r.type === "CONSUMED" && r.consumeReason === "WASTAGE");
      const rejected = sum((r) => r.type === "CONSUMED" && r.consumeReason === "REJECTED");
      const customerSample = sum((r) => r.type === "DISPATCHED");
      const returned = sum((r) => r.type === "RETURNED");
      const log = list
        .filter((r) => r.type !== "INBOUND")
        .map((r) => ({
          id: r.id,
          kind: r.type === "DISPATCHED" ? "CUSTOMER_SAMPLE" : r.type === "RETURNED" ? "RETURN" : (r.consumeReason ?? "TESTING"),
          quantity: r.quantity,
          unit: r.unit,
          date: r.date ?? r.transfer?.confirmedAt ?? r.createdAt,
          projectName: r.projectName,
          formulationRef: r.formulationRef,
          batchNo: r.batchNo,
          customerName: r.customer?.companyName ?? null,
          brandName: r.brandName,
          note: r.note,
        }))
        .sort((a, b) => b.date.getTime() - a.date.getTime());
      return {
        itemId,
        itemName: item.name,
        category: item.category,
        unit: item.unit ?? lots[0]?.unit ?? "",
        receivedQty: received,
        firstReceivedAt: lots.length ? lots[lots.length - 1]!.receivedAt : null,
        lastReceivedAt: lots[0]?.receivedAt ?? null,
        lots,
        warehouseVendors: warehouseVendors.get(itemId) ?? [],
        testingQty: testing,
        formulationQty: formulation,
        customerSampleQty: customerSample,
        rejectedQty: rejected,
        returnedQty: returned,
        wastageQty: wastage,
        stockQty: r3(received - testing - formulation - wastage - rejected - customerSample - returned),
        log,
      };
    });
    out.sort((a, b) => (b.lastReceivedAt?.getTime() ?? 0) - (a.lastReceivedAt?.getTime() ?? 0));
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// --- "Return Material": what R&D sent back to the Warehouse. Sent -> the Warehouse confirms receiving it -> Returned. Each row carries what
// R&D still has on hand, what the Warehouse has now, and the vendors the material came from. New returns are made with
// POST /transfers (direction TO_WAREHOUSE), which refuses more than the R&D Store has on hand. ---
rndStoreRouter.get("/returns", requireRole("RND"), async (_req, res, next) => {
  try {
    const transfers = await prisma.rndTransfer.findMany({
      where: { direction: "TO_WAREHOUSE", deletedAt: null },
      orderBy: { sentAt: "desc" },
      take: 1000,
      include: { item: { select: { id: true, name: true, category: true } }, sentBy: { select: { fullName: true, email: true } }, confirmedBy: { select: { fullName: true, email: true } } },
    });
    const itemIds = [...new Set(transfers.map((t) => t.itemId))];
    const [vendors, warehouse, rnd] = await Promise.all([
      vendorsByItem(itemIds),
      itemIds.length ? getOnHandByItemId(itemIds) : Promise.resolve(new Map<string, number>()),
      itemIds.length ? getRndStoreOnHand(itemIds) : Promise.resolve(new Map<string, number>()),
    ]);
    const name = (u: { fullName: string; email: string } | null | undefined) => (u ? u.fullName || u.email : null);
    res.json(
      transfers.map((t) => ({
        id: t.id,
        itemId: t.itemId,
        itemName: t.item.name,
        category: t.item.category,
        quantity: t.quantity,
        unit: t.unit,
        reason: t.note,
        status: t.confirmedAt ? "RETURNED" : "SENT",
        sentAt: t.sentAt,
        sentByName: name(t.sentBy),
        returnedAt: t.confirmedAt,
        confirmedByName: name(t.confirmedBy),
        rndOnHand: rnd.get(t.itemId) ?? 0,
        warehouseOnHand: warehouse.get(t.itemId) ?? 0,
        vendors: vendors.get(t.itemId) ?? [],
      })),
    );
  } catch (err) {
    next(err);
  }
});

// What R&D sees while raising a request: what the Warehouse has on hand now, and the vendors this material came from.
rndStoreRouter.get("/item-info/:itemId", requireRole("RND"), async (req: AuthedRequest<{ itemId: string }>, res, next) => {
  try {
    const item = await prisma.inventoryItem.findUnique({ where: { id: req.params.itemId }, select: { id: true, name: true, category: true, unit: true } });
    if (!item) return res.status(404).json({ error: "Unknown inventory item" });
    const [vendors, onHand] = await Promise.all([vendorsByItem([item.id]), getOnHandByItemId([item.id])]);
    res.json({ ...item, warehouseOnHand: onHand.get(item.id) ?? 0, vendors: vendors.get(item.id) ?? [] });
  } catch (err) {
    next(err);
  }
});

// Step 3 — research uses/wastes/rejects part of what's on hand at R&D.
rndStoreRouter.post("/consume", requireRole("RND"), validateBody(consumeAtRndSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { itemId, quantity, unit, reason, date, projectName, formulationRef, batchNo, note } = req.body as ConsumeAtRndInput;
    const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });

    const txn = await runSerializable(async (tx) => {
      const onHand = await getRndStoreOnHand([itemId], tx);
      const currentStock = onHand.get(itemId) ?? 0;
      if (quantity > currentStock) {
        throw new RouteError(409, `Only ${currentStock} ${unit} actually on hand at the R&D Store — can't consume more than what's there.`);
      }
      return tx.rndStoreTransaction.create({
        data: { itemId, type: "CONSUMED", quantity, unit, consumeReason: reason, date: date ?? new Date(), projectName, formulationRef, batchNo, note, createdById: req.user!.id },
      });
    });

    await recordAudit({ actorId: req.user!.id, action: "rnd_store.consumed", entityType: "RndStoreTransaction", entityId: txn.id, metadata: { itemId, quantity, reason } });
    res.status(201).json(txn);
  } catch (err) {
    next(err);
  }
});

// Step 4 — a sample goes straight to a customer, not back through the
// Warehouse.
rndStoreRouter.post("/dispatch", requireRole("RND"), validateBody(dispatchToCustomerSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { itemId, quantity, unit, customerId, brandName, date, courierDetails, note } = req.body as DispatchToCustomerInput;
    const [item, customer] = await Promise.all([prisma.inventoryItem.findUnique({ where: { id: itemId } }), prisma.customer.findUnique({ where: { id: customerId } })]);
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });
    if (!customer) return res.status(400).json({ error: "Unknown customer" });

    const txn = await runSerializable(async (tx) => {
      const onHand = await getRndStoreOnHand([itemId], tx);
      const currentStock = onHand.get(itemId) ?? 0;
      if (quantity > currentStock) {
        throw new RouteError(409, `Only ${currentStock} ${unit} actually on hand at the R&D Store — can't dispatch more than what's there.`);
      }
      return tx.rndStoreTransaction.create({
        data: { itemId, type: "DISPATCHED", quantity, unit, customerId, brandName, date: date ?? new Date(), courierDetails, note, createdById: req.user!.id },
      });
    });

    await recordAudit({ actorId: req.user!.id, action: "rnd_store.dispatched", entityType: "RndStoreTransaction", entityId: txn.id, metadata: { itemId, quantity, customerId } });
    res.status(201).json(txn);
  } catch (err) {
    next(err);
  }
});

// R&D Store's own activity feed — every CONSUMED/DISPATCHED row, plus
// the confirmed half of every INBOUND/RETURNED transfer. Read-only
// history, same audience as /stock.
rndStoreRouter.get("/transactions", requireRole("STORE", "RND"), async (_req, res, next) => {
  try {
    const rows = await prisma.rndStoreTransaction.findMany({
      where: { deletedAt: null },
      include: {
        item: { select: { id: true, category: true, name: true } },
        customer: { select: { id: true, companyName: true } },
        createdBy: { select: { fullName: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json(
      rows.map((r) => ({
        id: r.id,
        type: r.type,
        itemId: r.itemId,
        itemName: r.item.name,
        category: r.item.category,
        quantity: r.quantity,
        unit: r.unit,
        consumeReason: r.consumeReason,
        customerId: r.customerId,
        customerName: r.customer?.companyName ?? null,
        date: r.date,
        brandName: r.brandName,
        courierDetails: r.courierDetails,
        projectName: r.projectName,
        formulationRef: r.formulationRef,
        batchNo: r.batchNo,
        // Direct Purchase — set only on an INBOUND row R&D raised itself
        // (see POST /direct-purchase); isDirectPurchase distinguishes it
        // from a transfer-confirmed INBOUND for the frontend without it
        // having to know transferId is the tell.
        vendorName: r.vendorName,
        invoiceNo: r.invoiceNo,
        expiryDate: r.expiryDate,
        isDirectPurchase: r.type === "INBOUND" && !r.transferId,
        note: r.note,
        createdAt: r.createdAt,
        createdByName: r.createdBy.fullName || r.createdBy.email,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// Live on-hand at the R&D Store, per item — open to STORE (to know what
// they can be asked to receive back) and RND alike.
rndStoreRouter.get("/stock", requireRole("STORE", "RND"), async (_req, res, next) => {
  try {
    const items = await prisma.inventoryItem.findMany({ orderBy: { name: "asc" } });
    const onHand = await getRndStoreOnHand(items.map((i) => i.id));
    const rows = items.map((i) => ({ item: i, onHand: onHand.get(i.id) ?? 0 })).filter((r) => r.onHand !== 0);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// The "advance corporate tracking" report the client asked for — per
// item, exactly where R&D's raw material went: how much came in, how
// much was genuinely used vs wasted vs rejected in research, how much
// went straight to a customer, how much came back to the Warehouse, and
// what's still sitting at the R&D Store right now.
rndStoreRouter.get("/report", requireRole("STORE", "RND"), async (req: AuthedRequest, res, next) => {
  try {
    const { dateFrom, dateTo } = req.query as { dateFrom?: string; dateTo?: string };
    // Both ends inclusive — dateTo covers the whole day, not just its
    // midnight instant, same "calendar date, not timestamp" rule the
    // rest of this app's date-range filters use. Filtered on createdAt
    // (when the row was actually logged) rather than the optional,
    // type-dependent `date` field, so every row type filters uniformly.
    const dateFilter =
      dateFrom || dateTo
        ? {
            createdAt: {
              ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
              ...(dateTo ? { lt: new Date(new Date(dateTo).getTime() + 24 * 60 * 60 * 1000) } : {}),
            },
          }
        : {};

    const rows = await prisma.rndStoreTransaction.groupBy({
      by: ["itemId", "type", "consumeReason"],
      where: { deletedAt: null, ...dateFilter },
      _sum: { quantity: true },
    });
    const inboundRows = await prisma.rndStoreTransaction.groupBy({ by: ["itemId"], where: { deletedAt: null, type: "INBOUND", ...dateFilter }, _sum: { quantity: true } });

    const itemIds = new Set([...rows.map((r) => r.itemId), ...inboundRows.map((r) => r.itemId)]);
    const items = await prisma.inventoryItem.findMany({ where: { id: { in: [...itemIds] } } });
    const itemById = new Map(items.map((i) => [i.id, i]));
    // One representative unit per item — same "unit is consistent per item
    // across the ledger" assumption the rest of this app already makes
    // (InventoryTransaction works the same way); item.unit itself can be
    // null on legacy items, so fall back to whatever a real transaction row
    // actually recorded.
    const unitRows = await prisma.rndStoreTransaction.findMany({ where: { deletedAt: null, itemId: { in: [...itemIds] } }, select: { itemId: true, unit: true }, distinct: ["itemId"] });
    const unitByItemId = new Map(unitRows.map((r) => [r.itemId, r.unit]));

    const report = new Map<
      string,
      {
        itemId: string;
        itemName: string;
        category: string;
        unit: string;
        inboundQty: number;
        testingQty: number;
        formulationTrialQty: number;
        wastageQty: number;
        rejectedQty: number;
        dispatchedQty: number;
        returnedQty: number;
      }
    >();
    for (const id of itemIds) {
      const item = itemById.get(id);
      if (!item) continue;
      report.set(id, {
        itemId: id,
        itemName: item.name,
        category: item.category,
        unit: unitByItemId.get(id) ?? item.unit ?? "",
        inboundQty: 0,
        testingQty: 0,
        formulationTrialQty: 0,
        wastageQty: 0,
        rejectedQty: 0,
        dispatchedQty: 0,
        returnedQty: 0,
      });
    }
    for (const r of inboundRows) {
      const row = report.get(r.itemId);
      if (row) row.inboundQty = r._sum.quantity ?? 0;
    }
    for (const r of rows) {
      const row = report.get(r.itemId);
      if (!row) continue;
      const qty = r._sum.quantity ?? 0;
      if (r.type === "CONSUMED") {
        if (r.consumeReason === "TESTING") row.testingQty += qty;
        else if (r.consumeReason === "FORMULATION_TRIAL") row.formulationTrialQty += qty;
        else if (r.consumeReason === "WASTAGE") row.wastageQty += qty;
        else if (r.consumeReason === "REJECTED") row.rejectedQty += qty;
      } else if (r.type === "DISPATCHED") {
        row.dispatchedQty += qty;
      } else if (r.type === "RETURNED") {
        row.returnedQty += qty;
      }
    }

    // onHand is always the live, all-time balance — never scoped to
    // dateFrom/dateTo — since "how much is physically there right now"
    // isn't a period metric the way testing/wastage/etc. quantities are;
    // a date-filtered onHand would silently misreport actual stock.
    const onHandByItemId = dateFrom || dateTo ? await getRndStoreOnHand([...itemIds]) : null;

    res.json(
      [...report.values()].map((r) => ({
        ...r,
        onHand: onHandByItemId ? onHandByItemId.get(r.itemId) ?? 0 : r.inboundQty - r.testingQty - r.formulationTrialQty - r.wastageQty - r.rejectedQty - r.dispatchedQty - r.returnedQty,
      })),
    );
  } catch (err) {
    next(err);
  }
});
