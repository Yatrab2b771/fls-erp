import type { Prisma } from "@prisma/client";

/**
 * Warehouse finished-goods stock of a production batch.
 *
 * New flow: finished goods sit with the Day Store until the Day Store hands them to Dispatch; Dispatch sends them to the customer or
 * to the Warehouse. Only what Dispatch has SENT to the Warehouse and the Warehouse has confirmed RECEIVED is Warehouse stock; what the Warehouse
 * sends back to Dispatch (FROM_WAREHOUSE) leaves it.
 * A batch that was already at Billing / Dispatch Plan in the old flow keeps its old arithmetic (produced less dispatched).
 */
export const LEGACY_FG_STAGES = ["BILLING_EWAY_BILL", "DISPATCH_PLAN"] as const;

export const fgBatchWhere = {
  OR: [{ currentStageId: { in: [...LEGACY_FG_STAGES] } }, { fgShipments: { some: { type: "WAREHOUSE", status: "RECEIVED", deletedAt: null } } }],
} satisfies Prisma.ProductionBatchWhereInput;

/** What moves the Warehouse stock: what it received from Dispatch, less what it sent back to Dispatch (so Dispatch can ship it to a customer). */
export const receivedFgSelect = {
  where: { deletedAt: null, OR: [{ type: "WAREHOUSE", status: "RECEIVED" }, { type: "FROM_WAREHOUSE", status: { in: ["SENT", "RECEIVED"] } }] },
  select: { type: true, quantity: true },
} satisfies Prisma.ProductionBatch$fgShipmentsArgs;

export function warehouseFgOf(b: { currentStageId: string; outputQty: number | null; packApprovedQty: number | null; dispatchedQty: number | null; fgShipments: { type: string; quantity: number }[] }): { produced: number; dispatched: number; onHand: number } {
  if ((LEGACY_FG_STAGES as readonly string[]).includes(b.currentStageId)) {
    const produced = b.outputQty ?? b.packApprovedQty ?? 0;
    return { produced, dispatched: b.dispatchedQty ?? 0, onHand: produced - (b.dispatchedQty ?? 0) };
  }
  const received = b.fgShipments.filter((s) => s.type === "WAREHOUSE").reduce((sum, s) => sum + s.quantity, 0);
  const sentBack = b.fgShipments.filter((s) => s.type === "FROM_WAREHOUSE").reduce((sum, s) => sum + s.quantity, 0);
  return { produced: received, dispatched: sentBack, onHand: Math.max(0, received - sentBack) };
}
