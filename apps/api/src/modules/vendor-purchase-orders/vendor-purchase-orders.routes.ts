import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import {
  createVendorPurchaseOrderSchema,
  updateVendorPurchaseOrderSchema,
  updateVendorPurchaseOrderItemSchema,
  vendorPurchaseOrderItemInputSchema,
  receiveVendorPurchaseOrderItemSchema,
  addVendorPurchaseOrderFreightSchema,
  type CreateVendorPurchaseOrderInput,
  type UpdateVendorPurchaseOrderInput,
  type UpdateVendorPurchaseOrderItemInput,
  type VendorPurchaseOrderItemInput,
  type ReceiveVendorPurchaseOrderItemInput,
  type AddVendorPurchaseOrderFreightInput,
} from "./vendor-purchase-orders.schemas";

export const vendorPurchaseOrdersRouter = Router();

vendorPurchaseOrdersRouter.use(requireAuth);

// Same broad-read roles as Vendors/Pre-Inventory — everyone who works
// this material-procurement flow needs to see it; only Purchase writes
// header/line-item fields — Warehouse (STORE) additionally gets its own
// narrow write access below (receive + freight), nothing else.
const READ_ROLES = ["PPIC", "STORE", "PURCHASE", "ACCOUNTS"] as const;

function notifyFailed(req: AuthedRequest, label: string) {
  return (err: unknown) => req.log?.error({ err }, `notify failed: ${label}`);
}

// Money is rounded to 2dp at write time, same locally-scoped convention
// every other money computation in this codebase uses (see
// computePoBilling in purchase-orders.routes.ts) rather than a shared
// helper nothing else uses yet.
const round2 = (n: number) => Math.round(n * 100) / 100;

// GST-exclusive: the entered rate is the base price, GST is added on top.
function computeItemAmount(item: Pick<VendorPurchaseOrderItemInput, "quantity" | "rate" | "gstPct">): number {
  return round2(item.quantity * item.rate * (1 + item.gstPct / 100));
}

const vpoInclude = {
  vendor: { select: { id: true, name: true, code: true } },
  freightAddedBy: { select: { id: true, fullName: true } },
  items: {
    where: { deletedAt: null },
    include: {
      item: { select: { id: true, name: true, category: true, unit: true, code: true } },
      // Only what completion/aging needs — same "just enough to derive
      // the summary, not the full record" restraint purchase-orders'
      // own poInclude uses for preProduction/combinedLot.
      receivingTransactions: { where: { deletedAt: null }, select: { quantity: true, rejectedQty: true, receiptStatus: true, acceptedAt: true } },
    },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.VendorPurchaseOrderInclude;

type VpoWithItems = Prisma.VendorPurchaseOrderGetPayload<{ include: typeof vpoInclude }>;

// A line item counts as received once its QC-accepted receipts' net
// quantity (quantity - rejectedQty, same "what actually counts toward
// stock" rule stock.ts's getOnHandByItemId uses) reaches its ordered
// quantity — a QC_REJECTED or still-PENDING_QC receipt doesn't count yet,
// same as it doesn't count toward stock-on-hand either. The PO itself is
// "completed" once every line is; completionDate is the latest acceptedAt
// across every line's accepted receipts, daysTaken the whole-day span
// from orderDate — direct structural mirror of purchase-orders.routes.ts's
// own computeCompletion, computed on read, never stored.
function computeItemReceipt(item: VpoWithItems["items"][number]) {
  const accepted = item.receivingTransactions.filter((t) => t.receiptStatus === "ACCEPTED");
  const receivedQty = round2(accepted.reduce((sum, t) => sum + (t.quantity - (t.rejectedQty ?? 0)), 0));
  const isReceived = receivedQty >= item.quantity - 1e-6;
  const latestAcceptedAt = accepted.reduce<Date | null>((latest, t) => (t.acceptedAt && (!latest || t.acceptedAt > latest) ? t.acceptedAt : latest), null);
  return { receivedQty, isReceived, latestAcceptedAt };
}

function computeCompletion(po: VpoWithItems): { isCompleted: boolean; completionDate: string | null; daysTaken: number | null } {
  if (po.items.length === 0) return { isCompleted: false, completionDate: null, daysTaken: null };

  const receipts = po.items.map(computeItemReceipt);
  const isCompleted = receipts.every((r) => r.isReceived);
  if (!isCompleted) return { isCompleted: false, completionDate: null, daysTaken: null };

  const dates = receipts.map((r) => r.latestAcceptedAt).filter((d): d is Date => d !== null);
  if (dates.length === 0) return { isCompleted: true, completionDate: null, daysTaken: null };

  const completionDate = new Date(Math.max(...dates.map((d) => d.getTime())));
  const daysTaken = Math.round((completionDate.getTime() - po.orderDate.getTime()) / (1000 * 60 * 60 * 24));

  return { isCompleted: true, completionDate: completionDate.toISOString(), daysTaken };
}

function serializeVendorPo(po: VpoWithItems) {
  const totalAmount = round2(po.items.reduce((sum, item) => sum + item.amount, 0));
  const items = po.items.map((item) => {
    const { receivingTransactions: _receivingTransactions, ...rest } = item;
    return { ...rest, receivedQty: computeItemReceipt(item).receivedQty };
  });
  return { ...po, items, totalAmount, completion: computeCompletion(po) };
}

vendorPurchaseOrdersRouter.get("/", requireRole(...READ_ROLES), async (req, res, next) => {
  try {
    const pagination = parsePagination(req);
    const [total, orders] = await Promise.all([
      prisma.vendorPurchaseOrder.count({ where: { deletedAt: null } }),
      prisma.vendorPurchaseOrder.findMany({
        where: { deletedAt: null },
        include: vpoInclude,
        orderBy: { createdAt: "desc" },
        skip: pagination.skip,
        take: pagination.take,
      }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(orders.map(serializeVendorPo));
  } catch (err) {
    next(err);
  }
});

vendorPurchaseOrdersRouter.get("/:id", requireRole(...READ_ROLES), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const po = await prisma.vendorPurchaseOrder.findUnique({ where: { id: req.params.id }, include: vpoInclude });
    if (!po || po.deletedAt) return res.status(404).json({ error: "Vendor purchase order not found" });
    res.json(serializeVendorPo(po));
  } catch (err) {
    next(err);
  }
});

vendorPurchaseOrdersRouter.post("/", requireRole("PURCHASE"), validateBody(createVendorPurchaseOrderSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { vendorId, items, ...rest } = req.body as CreateVendorPurchaseOrderInput;

    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) return res.status(400).json({ error: "Unknown vendor" });

    const itemIds = [...new Set(items.map((i) => i.itemId))];
    const foundItems = await prisma.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true } });
    if (foundItems.length !== itemIds.length) return res.status(400).json({ error: "One or more line items reference an unknown RM/PM item" });

    // Synthetic strictly-increasing createdAt per item, same trick
    // purchase-orders.routes.ts uses to keep line-item order stable
    // (createdAt: "asc") when everything lands in the same transaction.
    const baseCreatedAt = Date.now();
    const po = await prisma.vendorPurchaseOrder.create({
      data: {
        vendorId,
        ...rest,
        createdById: req.user!.id,
        items: {
          create: items.map((item, idx) => ({
            itemId: item.itemId,
            quantity: item.quantity,
            unit: item.unit,
            rate: item.rate,
            gstPct: item.gstPct,
            amount: computeItemAmount(item),
            createdAt: new Date(baseCreatedAt + idx),
          })),
        },
      },
      include: vpoInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "vendor_purchase_order.created", entityType: "VendorPurchaseOrder", entityId: po.id, metadata: { itemCount: items.length } });

    res.status(201).json(serializeVendorPo(po));
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return res.status(409).json({ error: "A vendor PO with this PO Number already exists" });
    next(err);
  }
});

vendorPurchaseOrdersRouter.patch("/:id", requireRole("PURCHASE"), validateBody(updateVendorPurchaseOrderSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.vendorPurchaseOrder.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.deletedAt) return res.status(404).json({ error: "Vendor purchase order not found" });

    const data = req.body as UpdateVendorPurchaseOrderInput;
    if (data.vendorId) {
      const vendor = await prisma.vendor.findUnique({ where: { id: data.vendorId } });
      if (!vendor) return res.status(400).json({ error: "Unknown vendor" });
    }

    const updated = await prisma.vendorPurchaseOrder.update({ where: { id: req.params.id }, data, include: vpoInclude });

    await recordAudit({ actorId: req.user!.id, action: "vendor_purchase_order.updated", entityType: "VendorPurchaseOrder", entityId: updated.id });

    res.json(serializeVendorPo(updated));
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return res.status(409).json({ error: "A vendor PO with this PO Number already exists" });
    next(err);
  }
});

vendorPurchaseOrdersRouter.post(
  "/:id/items",
  requireRole("PURCHASE"),
  validateBody(vendorPurchaseOrderItemInputSchema),
  async (req: AuthedRequest<{ id: string }>, res, next) => {
    try {
      const po = await prisma.vendorPurchaseOrder.findUnique({ where: { id: req.params.id } });
      if (!po || po.deletedAt) return res.status(404).json({ error: "Vendor purchase order not found" });

      const input = req.body as VendorPurchaseOrderItemInput;
      const foundItem = await prisma.inventoryItem.findUnique({ where: { id: input.itemId }, select: { id: true } });
      if (!foundItem) return res.status(400).json({ error: "Unknown RM/PM item" });

      const item = await prisma.vendorPurchaseOrderItem.create({
        data: { vendorPurchaseOrderId: req.params.id, ...input, amount: computeItemAmount(input) },
        include: { item: { select: { id: true, name: true, category: true, unit: true, code: true } } },
      });

      await recordAudit({ actorId: req.user!.id, action: "vendor_purchase_order.item_added", entityType: "VendorPurchaseOrder", entityId: po.id, metadata: { itemId: item.id } });

      res.status(201).json(item);
    } catch (err) {
      next(err);
    }
  },
);

vendorPurchaseOrdersRouter.patch(
  "/:id/items/:itemId",
  requireRole("PURCHASE"),
  validateBody(updateVendorPurchaseOrderItemSchema),
  async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
    try {
      const existing = await prisma.vendorPurchaseOrderItem.findUnique({ where: { id: req.params.itemId } });
      if (!existing || existing.vendorPurchaseOrderId !== req.params.id || existing.deletedAt) return res.status(404).json({ error: "Line item not found" });

      const patch = req.body as UpdateVendorPurchaseOrderItemInput;
      if (patch.itemId) {
        const foundItem = await prisma.inventoryItem.findUnique({ where: { id: patch.itemId }, select: { id: true } });
        if (!foundItem) return res.status(400).json({ error: "Unknown RM/PM item" });
      }

      // Recompute amount from whichever of quantity/rate/gstPct actually
      // changed, falling back to the item's existing values for the rest
      // — a partial edit (e.g. just the rate) still lands on a correct
      // amount instead of requiring the whole row to be resent.
      const merged = {
        quantity: patch.quantity ?? existing.quantity,
        rate: patch.rate ?? existing.rate,
        gstPct: patch.gstPct ?? existing.gstPct,
      };

      const updated = await prisma.vendorPurchaseOrderItem.update({
        where: { id: req.params.itemId },
        data: { ...patch, amount: computeItemAmount(merged) },
        include: { item: { select: { id: true, name: true, category: true, unit: true, code: true } } },
      });

      await recordAudit({
        actorId: req.user!.id,
        action: "vendor_purchase_order.item_updated",
        entityType: "VendorPurchaseOrder",
        entityId: req.params.id,
        metadata: { itemId: updated.id, before: { quantity: existing.quantity, rate: existing.rate, gstPct: existing.gstPct }, after: patch },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

vendorPurchaseOrdersRouter.delete("/:id/items/:itemId", requireRole("PURCHASE"), async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
  try {
    const existing = await prisma.vendorPurchaseOrderItem.findUnique({ where: { id: req.params.itemId } });
    if (!existing || existing.vendorPurchaseOrderId !== req.params.id || existing.deletedAt) return res.status(404).json({ error: "Line item not found" });

    await prisma.vendorPurchaseOrderItem.update({ where: { id: req.params.itemId }, data: { deletedAt: new Date(), deletedById: req.user!.id } });

    await recordAudit({ actorId: req.user!.id, action: "vendor_purchase_order.item_removed", entityType: "VendorPurchaseOrder", entityId: req.params.id, metadata: { itemId: req.params.itemId } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Warehouse marks a line item received — creates the same
// InventoryTransaction(type: RECEIVED) GRN-merged entity the existing
// Material Received flow does (see inventory.routes.ts POST
// /transactions), starting PENDING_QC and going through that flow's
// existing inward QC gate untouched. `quantity` here is how much
// physically arrived; a partial delivery just means this gets called
// again later against the same line item for the remainder — see
// computeItemReceipt above for how completion is derived from however
// many of these accumulate.
vendorPurchaseOrdersRouter.post(
  "/:id/items/:itemId/receive",
  requireRole("STORE"),
  validateBody(receiveVendorPurchaseOrderItemSchema),
  async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
    try {
      const lineItem = await prisma.vendorPurchaseOrderItem.findUnique({
        where: { id: req.params.itemId },
        include: { vendorPurchaseOrder: { include: { vendor: { select: { name: true } } } }, item: { select: { id: true, name: true } } },
      });
      if (!lineItem || lineItem.vendorPurchaseOrderId !== req.params.id || lineItem.deletedAt || lineItem.vendorPurchaseOrder.deletedAt) {
        return res.status(404).json({ error: "Line item not found" });
      }

      const input = req.body as ReceiveVendorPurchaseOrderItemInput;
      const unit = input.unit ?? lineItem.unit;

      const txn = await prisma.inventoryTransaction.create({
        data: {
          itemId: lineItem.itemId,
          type: "RECEIVED",
          date: new Date(),
          unit,
          quantity: input.quantity,
          vendorName: lineItem.vendorPurchaseOrder.vendor.name,
          batchNo: input.batchNo,
          grnNo: input.grnNo,
          mfgDate: input.mfgDate,
          expiryDate: input.expiryDate,
          remark: input.remark,
          createdById: req.user!.id,
          receiptStatus: "PENDING_QC",
          isTransitTracked: false,
          deliveredAt: new Date(),
          deliveredById: req.user!.id,
          vendorPurchaseOrderItemId: lineItem.id,
        },
      });

      await recordAudit({
        actorId: req.user!.id,
        action: "vendor_purchase_order.item_received",
        entityType: "VendorPurchaseOrder",
        entityId: req.params.id,
        metadata: { itemId: lineItem.id, transactionId: txn.id, quantity: input.quantity },
      });

      await notifyRoles(["QA_QC"], { title: `${lineItem.item.name} awaiting inward QC`, body: `${input.quantity} ${unit} — vendor PO receipt`, link: "/inventory" }, req.user!.id).catch(
        notifyFailed(req, "vendor_purchase_order.item_received"),
      );

      res.status(201).json(txn);
    } catch (err) {
      next(err);
    }
  },
);

// Optional — Warehouse can add freight charges any time after receiving
// starts (not gated on completion, since freight for a delivery is often
// billed separately from the material itself). One figure per PO, not
// per line item — see the schema's own comment on why.
vendorPurchaseOrdersRouter.post(
  "/:id/freight",
  requireRole("STORE"),
  validateBody(addVendorPurchaseOrderFreightSchema),
  async (req: AuthedRequest<{ id: string }>, res, next) => {
    try {
      const existing = await prisma.vendorPurchaseOrder.findUnique({ where: { id: req.params.id } });
      if (!existing || existing.deletedAt) return res.status(404).json({ error: "Vendor purchase order not found" });

      const { freightCharges } = req.body as AddVendorPurchaseOrderFreightInput;
      const updated = await prisma.vendorPurchaseOrder.update({
        where: { id: req.params.id },
        data: { freightCharges, freightAddedById: req.user!.id, freightAddedAt: new Date() },
        include: vpoInclude,
      });

      await recordAudit({ actorId: req.user!.id, action: "vendor_purchase_order.freight_added", entityType: "VendorPurchaseOrder", entityId: updated.id, metadata: { freightCharges } });

      res.json(serializeVendorPo(updated));
    } catch (err) {
      next(err);
    }
  },
);

vendorPurchaseOrdersRouter.delete("/:id", requireRole("PURCHASE"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.vendorPurchaseOrder.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.deletedAt) return res.status(404).json({ error: "Vendor purchase order not found" });

    await prisma.vendorPurchaseOrder.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), deletedById: req.user!.id } });

    await recordAudit({ actorId: req.user!.id, action: "vendor_purchase_order.removed", entityType: "VendorPurchaseOrder", entityId: req.params.id });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
