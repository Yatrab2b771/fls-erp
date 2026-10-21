import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { RouteError } from "../../common/lib/route-error";
import { syncShortToPurchaseSafe } from "./purchase-sync";

type Logger = { error: (obj: unknown, msg: string) => void };

/**
 * Cancels one product of a PO for good (no undo): it drops out of the PPIC lists, the stock queue, Regulatory's queue and the PO's completion.
 * The row is kept, marked cancelled with who/when/why. Allowed until the first batch is made. Done by PPIC, and by Production (from New Plan).
 * The Day Store's untouched material requests for it are dropped (material already issued stays where it is, as stock); BD, who owns the PO,
 * is told, and so is PPIC when Production cancels.
 */
export async function cancelPoItem(opts: { itemId: string; poId?: string; actorId: string; reason: string; by: "PPIC" | "Production"; log?: Logger }) {
  const { itemId, poId, actorId, reason, by, log } = opts;
  const item = await prisma.purchaseOrderItem.findUnique({
    where: { id: itemId },
    include: { preProduction: { select: { id: true, _count: { select: { productionBatches: true } } } }, purchaseOrder: { select: { id: true, poNumber: true, createdById: true, customer: { select: { companyName: true } } } } },
  });
  if (!item || (poId && item.purchaseOrderId !== poId) || item.deletedAt) throw new RouteError(404, "Line item not found");
  if (item.cancelledAt) throw new RouteError(409, "This product is already cancelled.");
  if (item.preProduction && item.preProduction._count.productionBatches > 0) {
    throw new RouteError(409, by === "PPIC" ? "Production has already made a batch of this product - it can't be cancelled from here." : "A batch of this product has already been made, so it can't be cancelled. Hold it instead.");
  }

  const updated = await prisma.purchaseOrderItem.update({
    where: { id: item.id },
    // Any hold, PPIC's or Production's, ends with the cancel
    data: { cancelledAt: new Date(), cancelledById: actorId, cancelReason: by === "Production" ? `By Production - ${reason}` : reason, materialHeldAt: null, materialHeldById: null, productionHeldAt: null, productionHeldById: null, productionHoldReason: null },
  });
  await recordAudit({ actorId, action: by === "Production" ? "purchase_order.item_cancelled_by_production" : "purchase_order.item_cancelled", entityType: "PurchaseOrder", entityId: item.purchaseOrderId, metadata: { itemId: item.id, reason } });
  await prisma.inventoryRequest.updateMany({ where: { purchaseOrderItemId: item.id, deletedAt: null, status: "PENDING", fulfillments: { none: {} } }, data: { deletedAt: new Date(), deletedById: actorId } });

  const poLabel = item.purchaseOrder.poNumber ?? `PO ${item.purchaseOrder.id.slice(0, 8)}`;
  const content = { title: `${item.productName} cancelled by ${by}`, body: `${item.purchaseOrder.customer.companyName} · ${poLabel} - ${reason}`, link: `/purchase-orders/${item.purchaseOrder.id}` };
  await notifyUser(item.purchaseOrder.createdById, content).catch((err) => log?.error({ err }, "notify failed: purchase_order.item_cancelled"));
  if (by === "Production") await notifyRoles(["PPIC"], content, actorId).catch((err) => log?.error({ err }, "notify failed: purchase_order.item_cancelled (PPIC)"));

  // Its stock is free again - keep Purchase's shortfall requirements in step.
  await syncShortToPurchaseSafe(actorId, log);
  return updated;
}
