import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { notifyRoles } from "../../common/lib/notify";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { RouteError } from "../../common/lib/route-error";
import { getOnHandByItemId } from "../inventory/stock";
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
  item: { id: string; category: string; name: string };
  sentBy: { fullName: string; email: string };
  confirmedBy: { fullName: string; email: string } | null;
}) {
  return {
    id: t.id,
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
    await tx.inventoryTransaction.create({
      data: { itemId, type: "ISSUED_RND", date: new Date(), unit, quantity, remark: note ? `Sent to R&D Store — ${note}` : "Sent to R&D Store", createdById: sentById },
    });
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
      if (!isAdmin) return res.status(403).json({ error: "Store can no longer send a sample directly — fulfill an R&D request instead." });

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
rndStoreRouter.post("/transfers/:id/confirm", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.rndTransfer.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Transfer not found" });
    if (existing.confirmedAt) return res.status(409).json({ error: "Already confirmed." });

    const isAdmin = req.user!.roles.includes("ADMIN");
    const item = await prisma.inventoryItem.findUnique({ where: { id: existing.itemId } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });

    if (existing.direction === "TO_RND") {
      if (!req.user!.roles.includes("RND") && !isAdmin) return res.status(403).json({ error: "Only R&D can confirm receipt of a sample sent to the R&D Store." });

      const updated = await prisma.$transaction(async (tx) => {
        await tx.rndStoreTransaction.create({
          data: { itemId: existing.itemId, type: "INBOUND", quantity: existing.quantity, unit: existing.unit, transferId: existing.id, createdById: req.user!.id },
        });
        return tx.rndTransfer.update({ where: { id: existing.id }, data: { confirmedById: req.user!.id, confirmedAt: new Date() }, include: transferInclude });
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
          quantity: existing.quantity,
          isRndReturn: true,
          receiptStatus: "ACCEPTED",
          acceptedById: req.user!.id,
          acceptedAt: new Date(),
          remark: "Returned from R&D Store",
          createdById: req.user!.id,
        },
      });
      return tx.rndTransfer.update({ where: { id: existing.id }, data: { confirmedById: req.user!.id, confirmedAt: new Date() }, include: transferInclude });
    });

    await recordAudit({ actorId: req.user!.id, action: "rnd_transfer.confirmed_at_warehouse", entityType: "RndTransfer", entityId: updated.id });
    res.json(serializeTransfer(updated));
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
    const { itemId, quantity, unit, note } = req.body as CreateRndSampleRequestInput;
    const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });

    const request = await prisma.rndSampleRequest.create({
      data: { itemId, quantity, unit, note, requestedById: req.user!.id },
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
rndStoreRouter.get("/report", requireRole("STORE", "RND"), async (_req, res, next) => {
  try {
    const rows = await prisma.rndStoreTransaction.groupBy({
      by: ["itemId", "type", "consumeReason"],
      where: { deletedAt: null },
      _sum: { quantity: true },
    });
    const inboundRows = await prisma.rndStoreTransaction.groupBy({ by: ["itemId"], where: { deletedAt: null, type: "INBOUND" }, _sum: { quantity: true } });

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

    res.json(
      [...report.values()].map((r) => ({
        ...r,
        onHand: r.inboundQty - r.testingQty - r.formulationTrialQty - r.wastageQty - r.rejectedQty - r.dispatchedQty - r.returnedQty,
      })),
    );
  } catch (err) {
    next(err);
  }
});
