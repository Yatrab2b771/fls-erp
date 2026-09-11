import { prisma } from "../../common/lib/prisma";
import type { PrismaClient } from "@prisma/client";

// Same "subset satisfied by both prisma and a tx handle" shape as
// inventory/stock.ts's own Db type — lets the on-hand check and the
// write that depends on it run inside one SERIALIZABLE transaction.
type Db = Pick<PrismaClient, "qcSampleTransaction">;

// QC Sample Store's own on-hand balance, scoped to one PreProduction run
// (unlike the R&D Store's item-wide ledger — see the schema.prisma
// comment on why this one is scoped this way) — sum(INBOUND) −
// sum(CONSUMED) − sum(RETURNED), per item.
export async function getQcSampleOnHand(preProductionId: string, itemIds?: string[], db: Db = prisma): Promise<Map<string, number>> {
  const itemFilter = { deletedAt: null, preProductionId, ...(itemIds ? { itemId: { in: itemIds } } : {}) };

  const [inboundTotals, consumedTotals, returnedTotals] = await Promise.all([
    db.qcSampleTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "INBOUND" }, _sum: { quantity: true } }),
    db.qcSampleTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "CONSUMED" }, _sum: { quantity: true } }),
    db.qcSampleTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "RETURNED" }, _sum: { quantity: true } }),
  ]);

  const inbound = new Map(inboundTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const consumed = new Map(consumedTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const returned = new Map(returnedTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));

  const allItemIds = new Set([...inbound.keys(), ...consumed.keys(), ...returned.keys(), ...(itemIds ?? [])]);
  const onHand = new Map<string, number>();
  for (const id of allItemIds) {
    onHand.set(id, (inbound.get(id) ?? 0) - (consumed.get(id) ?? 0) - (returned.get(id) ?? 0));
  }
  return onHand;
}
