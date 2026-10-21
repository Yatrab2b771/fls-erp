import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyUser } from "../../common/lib/notify";
import { RouteError } from "../../common/lib/route-error";
import { goodQtyOf } from "../batches/good-qty";

type Logger = { error: (obj: unknown, msg: string) => void };
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Production closes a product short: the earlier batches made less than was ordered and no more will be made, so the product ends at what it
 * made. Its ordered quantity for completion becomes that quantity (closedShortQty): once it has been dispatched the product, and its PO, is
 * complete. Only when every batch is done (none in progress) and something is really missing. The PO's owner (BD) is told; PPIC is not.
 */
export async function closeProductShort(opts: { itemId: string; actorId: string; reason: string; log?: Logger }) {
  const { itemId, actorId, reason, log } = opts;
  const item = await prisma.purchaseOrderItem.findUnique({
    where: { id: itemId },
    select: {
      id: true,
      productName: true,
      quantity: true,
      unit: true,
      releasedQty: true,
      deletedAt: true,
      cancelledAt: true,
      planSentToProductionAt: true,
      closedShortAt: true,
      purchaseOrder: { select: { id: true, poNumber: true, createdById: true, customer: { select: { companyName: true } } } },
      preProduction: { select: { productionBatches: { select: { status: true, currentStageId: true, outputQty: true, mfgApprovedQty: true, packApprovedQty: true } } } },
    },
  });
  if (!item || item.deletedAt || !item.planSentToProductionAt) throw new RouteError(404, "This product is not with Production.");
  if (item.cancelledAt) throw new RouteError(409, "This product is cancelled.");
  if (item.closedShortAt) throw new RouteError(409, "This product is already closed short.");
  const batches = item.preProduction?.productionBatches ?? [];
  if (batches.length === 0) throw new RouteError(409, "No batch has been made yet. Cancel the product instead of closing it short.");
  if (batches.some((b) => b.status !== "COMPLETED")) throw new RouteError(409, "A batch is still in progress. Close the product short once every batch is done.");

  // What was made: each finished batch's output, or what QA approved of its bulk once that is known
  const made = round3(batches.reduce((sum, b) => sum + goodQtyOf(b), 0));
  const released = Math.min(item.quantity, item.releasedQty ?? item.quantity);
  if (made <= 0) throw new RouteError(409, "Nothing has been made, so there is nothing to close short.");
  if (made >= released - 1e-6) throw new RouteError(409, `Nothing is short: ${made} ${item.unit} was made against ${round3(released)} ${item.unit}.`);

  await prisma.purchaseOrderItem.update({ where: { id: item.id }, data: { closedShortAt: new Date(), closedShortById: actorId, closedShortReason: reason, closedShortQty: made } });
  await recordAudit({ actorId, action: "purchase_order.item_closed_short", entityType: "PurchaseOrder", entityId: item.purchaseOrder.id, metadata: { itemId: item.id, ordered: item.quantity, madeQty: made, reason } });
  await notifyUser(item.purchaseOrder.createdById, {
    title: `${item.productName} closed short at ${made} ${item.unit}`,
    body: `${item.purchaseOrder.customer.companyName} · ${item.purchaseOrder.poNumber ?? "PO"} - ordered ${item.quantity} ${item.unit}, made ${made}. ${reason}`,
    link: `/purchase-orders/${item.purchaseOrder.id}`,
  }).catch((err) => log?.error({ err }, "notify failed: purchase_order.item_closed_short"));
  return { madeQty: made, orderedQty: item.quantity };
}

/** Takes the close-short back: the product is ordered for its full quantity again (and can get more batches). */
export async function reopenProductShort(opts: { itemId: string; actorId: string }) {
  const item = await prisma.purchaseOrderItem.findUnique({ where: { id: opts.itemId }, select: { id: true, closedShortAt: true, deletedAt: true, purchaseOrderId: true } });
  if (!item || item.deletedAt) throw new RouteError(404, "Product not found");
  if (!item.closedShortAt) throw new RouteError(409, "This product is not closed short.");
  await prisma.purchaseOrderItem.update({ where: { id: item.id }, data: { closedShortAt: null, closedShortById: null, closedShortReason: null, closedShortQty: null } });
  await recordAudit({ actorId: opts.actorId, action: "purchase_order.item_close_short_reopened", entityType: "PurchaseOrder", entityId: item.purchaseOrderId, metadata: { itemId: item.id } });
}
