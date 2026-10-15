import { prisma } from "../../common/lib/prisma";

/**
 * PPIC's Hold on a product acts differently depending on how far it has got:
 *
 *  - Not fully planned yet (Not Planned tile): its plan can't be generated —
 *    BOM / RM Generate and Calculate are refused until it's released. That's
 *    what this guard checks.
 *  - Both plans calculated (Material Planning tile): planning is done, so the
 *    hold instead stops it going on to Production (POST send-plan-to-production
 *    checks materialHeldAt itself) and stops it claiming stock. Regulatory's
 *    review is NOT held — it carries on regardless.
 *
 * Returns the error message to send back (409), or null when planning may go on.
 */
/**
 * Production cannot work on a product PPIC has put on Hold or cancelled: no run can be opened, no run stage moved, no batch made.
 * (Hold and Cancel are allowed until the first batch exists; see purchase-orders.routes.ts.)
 */
export async function productionBlockedByHoldOrCancel(purchaseOrderItemId: string): Promise<string | null> {
  const item = await prisma.purchaseOrderItem.findUnique({ where: { id: purchaseOrderItemId }, select: { materialHeldAt: true, cancelledAt: true } });
  if (item?.cancelledAt) return "PPIC cancelled this product, so Production cannot work on it.";
  if (item?.materialHeldAt) return "PPIC has put this product on hold. Production can go on once PPIC releases it.";
  return null;
}

export async function planningBlockedByHold(purchaseOrderItemId: string | null | undefined): Promise<string | null> {
  if (!purchaseOrderItemId) return null;
  const item = await prisma.purchaseOrderItem.findUnique({
    where: { id: purchaseOrderItemId },
    select: {
      materialHeldAt: true,
      cancelledAt: true,
      rmPlans: { where: { status: "CALCULATED" }, take: 1, select: { id: true } },
      bomPlans: { where: { status: "CALCULATED" }, take: 1, select: { id: true } },
    },
  });
  if (item?.cancelledAt) return "This product is cancelled.";
  if (!item?.materialHeldAt) return null;
  const fullyPlanned = item.rmPlans.length > 0 && item.bomPlans.length > 0;
  return fullyPlanned ? null : "This product is on hold — release it before generating its plan.";
}
