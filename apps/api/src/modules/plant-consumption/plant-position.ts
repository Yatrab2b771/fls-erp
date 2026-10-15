import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { getOnHandByPlantAndItem } from "../inventory/stock";

/**
 * What a Plant holds of each material, and how much of it is spoken for.
 *   on hand   issued to the Plant - used - sent back (the Plant's stock, see stock.ts)
 *   reserved  dispensed for a batch and not yet accounted for by that batch's Utilization (used A-D, or left over E): it is for that batch
 *   free      on hand - reserved: what a new batch could be given, or what Production could send back to the Day Store
 *   pending   leftover (E · Return) marked by batches and not yet sent back to the Day Store
 * Leftover material stays in the Plant's stock (it is on hand and, once its batch has accounted for it, free) until Production returns it.
 */
export interface BatchPosition {
  batchId: string;
  batchNo: string | null;
  given: number;
  used: number; // A + B + C + D logged on the batch
  leftover: number; // E marked on the batch
  reserved: number;
}

export interface ItemPosition {
  itemId: string;
  onHand: number;
  reserved: number;
  free: number;
  pendingReturn: number;
  batches: BatchPosition[];
}

type Db = Parameters<typeof getOnHandByPlantAndItem>[2];

export async function plantPosition(plantId: string, itemIds: string[] | undefined, db: Db = undefined): Promise<Map<string, ItemPosition>> {
  const client = (db ?? prisma) as Prisma.TransactionClient;
  const itemFilter = itemIds ? { itemId: { in: itemIds } } : {};
  const onHand = await getOnHandByPlantAndItem(plantId, itemIds, db);
  const [lines, leftovers] = await Promise.all([
    client.batchDispensingLine.findMany({ where: { ...itemFilter, productionBatch: { preProduction: { plantId } } }, select: { productionBatchId: true, itemId: true, quantity: true } }),
    client.batchLeftover.findMany({ where: { ...itemFilter, productionBatch: { preProduction: { plantId } } }, select: { productionBatchId: true, itemId: true, quantity: true, returnedQty: true } }),
  ]);
  const batchIds = [...new Set([...lines, ...leftovers].map((l) => l.productionBatchId))];
  const used = batchIds.length ? await client.batchMaterialConsumption.groupBy({ by: ["productionBatchId", "itemId"], where: { ...itemFilter, productionBatchId: { in: batchIds } }, _sum: { quantity: true } }) : [];
  const batchNos = batchIds.length ? await client.productionBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, batchNo: true } }) : [];
  const noOf = new Map(batchNos.map((b) => [b.id, b.batchNo]));

  const per = new Map<string, BatchPosition & { itemId: string }>(); // batch::item
  const slot = (batchId: string, itemId: string) => {
    const key = `${batchId}::${itemId}`;
    let p = per.get(key);
    if (!p) {
      p = { batchId, itemId, batchNo: noOf.get(batchId) ?? null, given: 0, used: 0, leftover: 0, reserved: 0 };
      per.set(key, p);
    }
    return p;
  };
  for (const l of lines) slot(l.productionBatchId, l.itemId).given += l.quantity;
  for (const u of used) slot(u.productionBatchId!, u.itemId).used += u._sum.quantity ?? 0;
  const pending = new Map<string, number>();
  for (const l of leftovers) {
    slot(l.productionBatchId, l.itemId).leftover += l.quantity;
    pending.set(l.itemId, (pending.get(l.itemId) ?? 0) + Math.max(0, l.quantity - l.returnedQty));
  }

  const byItem = new Map<string, ItemPosition>();
  const ensure = (itemId: string) => {
    let p = byItem.get(itemId);
    if (!p) {
      p = { itemId, onHand: onHand.get(itemId) ?? 0, reserved: 0, free: 0, pendingReturn: pending.get(itemId) ?? 0, batches: [] };
      byItem.set(itemId, p);
    }
    return p;
  };
  for (const b of per.values()) {
    b.reserved = Math.max(0, b.given - b.used - b.leftover);
    const p = ensure(b.itemId);
    p.reserved += b.reserved;
    p.batches.push({ batchId: b.batchId, batchNo: b.batchNo, given: b.given, used: b.used, leftover: b.leftover, reserved: b.reserved });
  }
  for (const [itemId] of onHand) ensure(itemId);
  for (const id of itemIds ?? []) ensure(id);
  for (const p of byItem.values()) p.free = p.onHand - p.reserved;
  return byItem;
}

/** What a Plant can still hand to a new batch (or send back): its stock less what is reserved for batches. */
export async function plantFreeQty(plantId: string, itemIds: string[], db: Db = undefined): Promise<Map<string, number>> {
  const pos = await plantPosition(plantId, itemIds, db);
  return new Map(itemIds.map((id) => [id, pos.get(id)?.free ?? 0]));
}
