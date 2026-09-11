import { prisma } from "../../common/lib/prisma";
import type { PrismaClient } from "@prisma/client";

// Same "subset satisfied by both prisma and a tx handle" shape as
// inventory/stock.ts's own Db type — lets the on-hand check and the
// write that depends on it run inside one SERIALIZABLE transaction.
type Db = Pick<PrismaClient, "rndStoreTransaction">;

// R&D Store's own on-hand balance — sum(INBOUND) − sum(CONSUMED) −
// sum(DISPATCHED) − sum(RETURNED), per item. Entirely separate from
// Warehouse's own on-hand (stock.ts's getOnHandByItemId) — see the
// schema.prisma comment block on RndTransfer/RndStoreTransaction for why
// this is a second ledger, not a location tag on the first.
export async function getRndStoreOnHand(itemIds?: string[], db: Db = prisma): Promise<Map<string, number>> {
  const itemFilter = { deletedAt: null, ...(itemIds ? { itemId: { in: itemIds } } : {}) };

  const [inboundTotals, consumedTotals, dispatchedTotals, returnedTotals] = await Promise.all([
    db.rndStoreTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "INBOUND" }, _sum: { quantity: true } }),
    db.rndStoreTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "CONSUMED" }, _sum: { quantity: true } }),
    db.rndStoreTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "DISPATCHED" }, _sum: { quantity: true } }),
    db.rndStoreTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "RETURNED" }, _sum: { quantity: true } }),
  ]);

  const inbound = new Map(inboundTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const consumed = new Map(consumedTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const dispatched = new Map(dispatchedTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const returned = new Map(returnedTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));

  const allItemIds = new Set([...inbound.keys(), ...consumed.keys(), ...dispatched.keys(), ...returned.keys(), ...(itemIds ?? [])]);
  const onHand = new Map<string, number>();
  for (const id of allItemIds) {
    onHand.set(id, (inbound.get(id) ?? 0) - (consumed.get(id) ?? 0) - (dispatched.get(id) ?? 0) - (returned.get(id) ?? 0));
  }
  return onHand;
}
