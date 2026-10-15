import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { computeCompletion, poInclude } from "./po-completion";

/**
 * Order Tracking's tiles, computed on the server over EVERY purchase order the
 * caller may see (`visible` is poVisibilityWhere) - never from whichever page of
 * the list happens to be on screen.
 *  - purchaseOrders: how many POs
 *  - products:       live (not removed, not cancelled) product lines on them
 *  - inProduction:   Approved POs not yet fully shipped
 */
export async function getPoStats(visible: Prisma.PurchaseOrderWhereInput): Promise<{ purchaseOrders: number; products: number; inProduction: number }> {
  const [purchaseOrders, products, approved] = await Promise.all([
    prisma.purchaseOrder.count({ where: visible }),
    prisma.purchaseOrderItem.count({ where: { deletedAt: null, cancelledAt: null, purchaseOrder: visible } }),
    prisma.purchaseOrder.findMany({ where: { AND: [visible, { status: "APPROVED" }] }, include: poInclude }),
  ]);
  const inProduction = approved.filter((po) => !computeCompletion(po).isCompleted).length;
  return { purchaseOrders, products, inProduction };
}
