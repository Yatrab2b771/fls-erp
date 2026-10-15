import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { syncShortToPurchaseSafe } from "./purchase-sync";
import { notifyProductionOfProductHold } from "./hold-notify";

// BD asks PPIC to put a product on Hold or to cancel it. Only until Production has made the product's first batch. PPIC accepts (which
// does it) or rejects with a reason; BD hears either way. One open request per product.

export const itemChangeRequestsRouter = Router();
itemChangeRequestsRouter.use(requireAuth);

const createSchema = z.object({
  purchaseOrderItemId: z.string().uuid(),
  kind: z.enum(["HOLD", "CANCEL"]),
  reason: z.string().trim().min(3, "Give a reason").max(500),
});
const decideSchema = z
  .object({ action: z.enum(["ACCEPT", "REJECT"]), note: z.string().trim().max(500).optional() })
  .refine((d) => d.action === "ACCEPT" || !!d.note, { message: "Write why you are rejecting it", path: ["note"] });

const include = {
  requestedBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
  purchaseOrderItem: {
    select: {
      id: true,
      productName: true,
      productCategory: true,
      quantity: true,
      unit: true,
      materialHeldAt: true,
      cancelledAt: true,
      planSentToProductionAt: true,
      plannedPlant: { select: { name: true } },
      purchaseOrder: { select: { id: true, poNumber: true, createdById: true, customer: { select: { companyName: true } } } },
      preProduction: { select: { id: true, productionBatches: { select: { prepStageId: true } } } },
    },
  },
} satisfies Prisma.ItemChangeRequestInclude;

/** Cancel is possible until any batch exists; Hold until a batch is READY (Production has started making it - batches still in preparation Production holds one by one). */
const stoppedByBatch = (batches: { prepStageId: string }[] | undefined, kind: "HOLD" | "CANCEL") => (batches ?? []).some((b) => kind === "CANCEL" || b.prepStageId === "READY");
const STOPPED_MESSAGE = { HOLD: "Production has already started making a batch of this product, so it can't be held any more.", CANCEL: "Production has already made a batch of this product, so it can't be cancelled any more." } as const;
type Row = Prisma.ItemChangeRequestGetPayload<{ include: typeof include }>;

function serialize(r: Row) {
  const item = r.purchaseOrderItem;
  return {
    id: r.id,
    kind: r.kind,
    reason: r.reason,
    status: r.status,
    requestedByName: r.requestedBy.fullName,
    requestedAt: r.requestedAt.toISOString(),
    decidedByName: r.decidedBy?.fullName ?? null,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    poId: item.purchaseOrder.id,
    poNumber: item.purchaseOrder.poNumber,
    customerName: item.purchaseOrder.customer.companyName,
    itemId: item.id,
    productName: item.productName,
    productCategory: item.productCategory,
    quantity: item.quantity,
    unit: item.unit,
    plantName: item.plannedPlant?.name ?? null,
    isHeld: !!item.materialHeldAt,
    isCancelled: !!item.cancelledAt,
    planSent: !!item.planSentToProductionAt,
    /** A batch stops this request from being done (for a Hold only a batch already started in production; for a Cancel any batch). */
    hasBatch: stoppedByBatch(item.preProduction?.productionBatches, r.kind),
  };
}

// BD sees every request it (or a colleague) raised; PPIC sees the open ones by default.
itemChangeRequestsRouter.get("/", requireRole("BD", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const status = req.query.status === "ALL" ? undefined : req.query.status === "ACCEPTED" || req.query.status === "REJECTED" ? req.query.status : "PENDING";
    const rows = await prisma.itemChangeRequest.findMany({ where: { status }, include, orderBy: { requestedAt: "desc" }, take: 500 });
    res.json(rows.map(serialize));
  } catch (err) {
    next(err);
  }
});

itemChangeRequestsRouter.post("/", requireRole("BD"), validateBody(createSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { purchaseOrderItemId, kind, reason } = req.body as z.infer<typeof createSchema>;
    const item = await prisma.purchaseOrderItem.findUnique({
      where: { id: purchaseOrderItemId },
      select: { id: true, deletedAt: true, cancelledAt: true, materialHeldAt: true, productName: true, purchaseOrder: { select: { id: true, status: true, poNumber: true, customer: { select: { companyName: true } } } }, preProduction: { select: { productionBatches: { select: { prepStageId: true } } } } },
    });
    if (!item || item.deletedAt) return res.status(404).json({ error: "Product not found" });
    if (item.purchaseOrder.status !== "APPROVED") return res.status(409).json({ error: "PPIC only sees approved POs: change a draft PO yourself." });
    if (item.cancelledAt) return res.status(409).json({ error: "This product is already cancelled." });
    if (kind === "HOLD" && item.materialHeldAt) return res.status(409).json({ error: "This product is already on hold." });
    if (stoppedByBatch(item.preProduction?.productionBatches, kind)) return res.status(409).json({ error: STOPPED_MESSAGE[kind] });
    if (await prisma.itemChangeRequest.findFirst({ where: { purchaseOrderItemId, status: "PENDING" }, select: { id: true } })) {
      return res.status(409).json({ error: "A request for this product is already waiting for PPIC." });
    }

    const created = await prisma.itemChangeRequest.create({ data: { purchaseOrderItemId, kind, reason, requestedById: req.user!.id }, include });
    await recordAudit({ actorId: req.user!.id, action: "item_change_request.created", entityType: "PurchaseOrder", entityId: item.purchaseOrder.id, metadata: { itemId: item.id, kind, reason } });
    await notifyRoles(
      ["PPIC"],
      { title: `BD asks to ${kind === "HOLD" ? "hold" : "cancel"} ${item.productName}`, body: `${item.purchaseOrder.customer.companyName} · ${item.purchaseOrder.poNumber ?? "PO"} - ${reason}`, link: "/bd-requests" },
      req.user!.id,
    ).catch((err) => req.log?.error({ err }, "notify failed: item_change_request.created"));
    res.status(201).json(serialize(created));
  } catch (err) {
    next(err);
  }
});

itemChangeRequestsRouter.patch("/:id", requireRole("PPIC"), validateBody(decideSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const { action, note } = req.body as z.infer<typeof decideSchema>;
    const request = await prisma.itemChangeRequest.findUnique({ where: { id: req.params.id }, include });
    if (!request) return res.status(404).json({ error: "Request not found" });
    if (request.status !== "PENDING") return res.status(409).json({ error: `This request was already ${request.status.toLowerCase()}.` });
    const item = request.purchaseOrderItem;
    const label = `${item.productName} (${item.purchaseOrder.poNumber ?? "PO"})`;
    const now = new Date();

    if (action === "ACCEPT") {
      if (item.cancelledAt) return res.status(409).json({ error: "This product is already cancelled." });
      if (stoppedByBatch(item.preProduction?.productionBatches, request.kind)) return res.status(409).json({ error: STOPPED_MESSAGE[request.kind] });
      if (request.kind === "HOLD") {
        await prisma.purchaseOrderItem.update({ where: { id: item.id }, data: { materialHeldAt: item.materialHeldAt ?? now, materialHeldById: req.user!.id } });
      } else {
        await prisma.purchaseOrderItem.update({ where: { id: item.id }, data: { cancelledAt: now, cancelledById: req.user!.id, cancelReason: request.reason, materialHeldAt: null, materialHeldById: null } });
        // The Day Store's requests for it that nobody has started on are dropped (material already issued stays where it is, as stock)
        await prisma.inventoryRequest.updateMany({ where: { purchaseOrderItemId: item.id, deletedAt: null, status: "PENDING", fulfillments: { none: {} } }, data: { deletedAt: now, deletedById: req.user!.id } });
      }
      await syncShortToPurchaseSafe(req.user!.id, req.log);
      if (request.kind === "HOLD" && !item.materialHeldAt) await notifyProductionOfProductHold([item.id], true, req.user!.id);
    }

    const updated = await prisma.itemChangeRequest.update({
      where: { id: request.id },
      data: { status: action === "ACCEPT" ? "ACCEPTED" : "REJECTED", decidedById: req.user!.id, decidedAt: now, decisionNote: note || null },
      include,
    });
    await recordAudit({ actorId: req.user!.id, action: action === "ACCEPT" ? "item_change_request.accepted" : "item_change_request.rejected", entityType: "PurchaseOrder", entityId: item.purchaseOrder.id, metadata: { itemId: item.id, kind: request.kind, note } });
    const doneWord = request.kind === "HOLD" ? "put on hold" : "cancelled";
    await notifyUser(item.purchaseOrder.createdById, {
      title: action === "ACCEPT" ? `PPIC ${doneWord} ${label}` : `PPIC did not accept your ${request.kind === "HOLD" ? "hold" : "cancel"} request for ${label}`,
      body: action === "ACCEPT" ? "As you asked." : (note ?? ""),
      link: `/purchase-orders/${item.purchaseOrder.id}`,
    }).catch((err) => req.log?.error({ err }, "notify failed: item_change_request.decided"));
    res.json(serialize(updated));
  } catch (err) {
    next(err);
  }
});
