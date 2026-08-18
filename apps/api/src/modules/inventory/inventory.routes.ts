import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { createInventoryItemSchema, createInventoryTransactionSchema, updateInventoryItemSchema, type CreateInventoryItemInput, type CreateInventoryTransactionInput, type UpdateInventoryItemInput } from "./inventory.schemas";
import type { InventoryCategory, Prisma } from "@prisma/client";

export const inventoryRouter = Router();

inventoryRouter.use(requireAuth);

// Unlike Order Tracking/BOM/RM Costing, this module is NOT open to every
// authenticated user — Store owns the Warehouse tool this ports, and
// nobody outside Store/Admin has a reason to see stock levels or the
// received/issued log. One router-level gate covers reads and writes
// alike (ADMIN always passes via requireRole's own override).
inventoryRouter.use(requireRole("STORE"));

// --- Item catalog — "List from Sanjay & naveen. Option to add item" ---

inventoryRouter.get("/items", async (req, res, next) => {
  try {
    const category = req.query.category as InventoryCategory | undefined;
    const items = await prisma.inventoryItem.findMany({
      where: category ? { category } : undefined,
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
    res.json(items);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.post("/items", validateBody(createInventoryItemSchema), async (req: AuthedRequest, res, next) => {
  try {
    const data = req.body as CreateInventoryItemInput;

    const existing = await prisma.inventoryItem.findUnique({ where: { category_name: { category: data.category, name: data.name } } });
    if (existing) return res.status(409).json({ error: "An item with this name already exists in this category" });

    const item = await prisma.inventoryItem.create({ data });

    await recordAudit({ actorId: req.user!.id, action: "inventory_item.created", entityType: "InventoryItem", entityId: item.id });

    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.patch("/items/:id", validateBody(updateInventoryItemSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.inventoryItem.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Inventory item not found" });

    const data = req.body as UpdateInventoryItemInput;
    const updated = await prisma.inventoryItem.update({ where: { id: req.params.id }, data });

    await recordAudit({ actorId: req.user!.id, action: "inventory_item.updated", entityType: "InventoryItem", entityId: updated.id });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// --- Stock on hand — sum(RECEIVED) − sum(ISSUED) per item ---

inventoryRouter.get("/stock", async (req, res, next) => {
  try {
    const category = req.query.category as InventoryCategory | undefined;

    const [items, receivedTotals, issuedTotals] = await Promise.all([
      prisma.inventoryItem.findMany({ where: category ? { category } : undefined, orderBy: [{ category: "asc" }, { name: "asc" }] }),
      prisma.inventoryTransaction.groupBy({ by: ["itemId"], where: { type: "RECEIVED" }, _sum: { quantity: true } }),
      prisma.inventoryTransaction.groupBy({ by: ["itemId"], where: { type: "ISSUED" }, _sum: { quantity: true } }),
    ]);

    const received = new Map(receivedTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
    const issued = new Map(issuedTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));

    const stock = items.map((item) => {
      const receivedQty = received.get(item.id) ?? 0;
      const issuedQty = issued.get(item.id) ?? 0;
      return { item, receivedQty, issuedQty, onHand: receivedQty - issuedQty };
    });

    res.json(stock);
  } catch (err) {
    next(err);
  }
});

// --- Transaction log — the two sheets ("MATERIAL RECEIVED" / "MATERIAL
// Issued to day store"), told apart by `type`, on one endpoint ---

const txnInclude = { item: true, createdBy: { select: { id: true, fullName: true } } } satisfies Prisma.InventoryTransactionInclude;

inventoryRouter.get("/transactions", async (req, res, next) => {
  try {
    const { type, category, itemId } = req.query as { type?: "RECEIVED" | "ISSUED"; category?: InventoryCategory; itemId?: string };
    const pagination = parsePagination(req);

    const where: Prisma.InventoryTransactionWhereInput = {
      ...(type ? { type } : {}),
      ...(itemId ? { itemId } : {}),
      ...(category ? { item: { category } } : {}),
    };

    const [total, transactions] = await Promise.all([
      prisma.inventoryTransaction.count({ where }),
      prisma.inventoryTransaction.findMany({ where, include: txnInclude, orderBy: { date: "desc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(transactions);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.post("/transactions", validateBody(createInventoryTransactionSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { itemId, ...rest } = req.body as CreateInventoryTransactionInput;

    const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });

    const txn = await prisma.inventoryTransaction.create({
      data: { itemId, ...rest, createdById: req.user!.id },
      include: txnInclude,
    });

    await recordAudit({
      actorId: req.user!.id,
      action: rest.type === "RECEIVED" ? "inventory.material_received" : "inventory.material_issued",
      entityType: "InventoryTransaction",
      entityId: txn.id,
      metadata: { itemId, quantity: rest.quantity, unit: rest.unit },
    });

    res.status(201).json(txn);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.delete("/transactions/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const txn = await prisma.inventoryTransaction.findUnique({ where: { id: req.params.id } });
    if (!txn) return res.status(404).json({ error: "Transaction not found" });

    await prisma.inventoryTransaction.delete({ where: { id: req.params.id } });

    await recordAudit({ actorId: req.user!.id, action: "inventory.transaction_removed", entityType: "InventoryTransaction", entityId: req.params.id, metadata: { itemId: txn.itemId, type: txn.type } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
