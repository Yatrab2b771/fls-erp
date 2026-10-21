import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";

/** Puts a Material Request's status back in line with the issues that still count toward it (after one was deleted or refused). */
export async function resyncRequestStatus(requestId: string, db: Prisma.TransactionClient | PrismaClient = prisma): Promise<void> {
  const request = await db.inventoryRequest.findUnique({ where: { id: requestId }, include: { fulfillments: { where: { deletedAt: null }, select: { quantity: true } } } });
  if (!request || !["ISSUED", "PARTIALLY_ISSUED"].includes(request.status)) return;
  const issued = request.fulfillments.reduce((sum, f) => sum + f.quantity, 0);
  const status = issued >= request.requestedQty - 1e-9 ? "ISSUED" : issued > 1e-9 ? "PARTIALLY_ISSUED" : "APPROVED";
  if (status !== request.status) await db.inventoryRequest.update({ where: { id: requestId }, data: { status } });
}
