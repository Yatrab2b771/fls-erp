import { prisma } from "../../common/lib/prisma";
import { notifyRoles } from "../../common/lib/notify";
import { logger } from "../../common/lib/logger";

/**
 * PPIC put a product on Hold (or released it): tell Production, so it can hold the product's batches that are still in preparation
 * (Production's "Held Products" tile). Only products already sent to Production matter to it. Never throws: a failed notification
 * must not undo the hold.
 */
export async function notifyProductionOfProductHold(itemIds: string[], held: boolean, actorId: string): Promise<void> {
  if (itemIds.length === 0) return;
  try {
    const items = await prisma.purchaseOrderItem.findMany({
      where: { id: { in: itemIds }, planSentToProductionAt: { not: null }, deletedAt: null },
      select: {
        productName: true,
        purchaseOrder: { select: { poNumber: true, customer: { select: { companyName: true } } } },
        preProduction: { select: { productionBatches: { where: { status: "IN_PROGRESS", prepStageId: { not: "READY" } }, select: { id: true } } } },
      },
    });
    for (const item of items) {
      const label = `${item.productName} (${item.purchaseOrder.poNumber ?? "PO"})`;
      const inPrep = item.preProduction?.productionBatches.length ?? 0;
      await notifyRoles(
        ["PRODUCTION"],
        held
          ? {
              title: `PPIC put ${label} on hold`,
              body: inPrep > 0 ? `${inPrep} batch${inPrep === 1 ? " is" : "es are"} still in preparation: hold the ones that should not go on.` : "No batch is in preparation. No new batch can be made until PPIC releases it.",
              link: "/held-products",
            }
          : { title: `PPIC released ${label}`, body: "Release your held batches of it when you are ready to go on.", link: "/held-products" },
        actorId,
      );
    }
  } catch (err) {
    logger.error({ err }, "notify failed: product hold");
  }
}
