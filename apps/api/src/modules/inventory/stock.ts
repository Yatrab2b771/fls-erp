import { prisma } from "../../common/lib/prisma";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import type { Prisma, PrismaClient } from "@prisma/client";

// A subset of the Prisma client's query surface, satisfied by both the
// top-level `prisma` singleton and the `tx` handle inside
// prisma.$transaction(async (tx) => ...). Letting every read in this
// file take one of these (default `prisma`) is what makes it possible
// to run the same on-hand check *and* the write that depends on it
// inside one atomic transaction — see the callers in inventory.routes.ts
// that pass `tx` under SERIALIZABLE isolation to close the check-then-
// write race two concurrent Store users could otherwise hit.
type Db = Pick<PrismaClient, "inventoryTransaction" | "batchMaterialConsumption">;

// The one place stock-on-hand math lives — sum(RECEIVED, accepted) −
// sum(ISSUED_DAY_STORE) − sum(ISSUED_PRODUCTION), per item. Used by
// GET /inventory/stock (the full ledger view) and by Pre-Inventory's
// live shortfall computation (Part 2 — no more manual "Confirm
// Availability" step; PPIC's requirement is compared against this same
// number, live, every time it's read).
export async function getOnHandByItemId(itemIds?: string[], db: Db = prisma): Promise<Map<string, number>> {
  const itemFilter: Prisma.InventoryTransactionWhereInput = itemIds ? { itemId: { in: itemIds } } : {};

  const [receivedTotals, issuedDayStoreTotals, issuedProductionTotals] = await Promise.all([
    // Only ACCEPTED counts — a delivery still sitting in QC, or one QC
    // rejected, hasn't actually become usable stock yet. Opening Stock
    // rows are ACCEPTED at creation (see schema.prisma), so they're
    // already included here with no special-casing needed. rejectedQty
    // is summed alongside quantity so a partially-rejected delivery
    // (see qcReviewSchema) only counts its actually-usable remainder.
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "RECEIVED", receiptStatus: "ACCEPTED" }, _sum: { quantity: true, rejectedQty: true } }),
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_DAY_STORE" }, _sum: { quantity: true } }),
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_PRODUCTION" }, _sum: { quantity: true } }),
  ]);

  const received = new Map(receivedTotals.map((r) => [r.itemId, (r._sum.quantity ?? 0) - (r._sum.rejectedQty ?? 0)]));
  const issuedDayStore = new Map(issuedDayStoreTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const issuedProduction = new Map(issuedProductionTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));

  const allItemIds = new Set([...received.keys(), ...issuedDayStore.keys(), ...issuedProduction.keys(), ...(itemIds ?? [])]);
  const onHand = new Map<string, number>();
  for (const id of allItemIds) {
    onHand.set(id, (received.get(id) ?? 0) - (issuedDayStore.get(id) ?? 0) - (issuedProduction.get(id) ?? 0));
  }
  return onHand;
}

// One Day Store's real-time balance broken into its two legs, not just
// the net — "how much has this store received from the Warehouse" and
// "how much has this store issued on to Production" are both real
// questions Store asks separately, not just their difference.
export interface DayStoreBalance {
  receivedFromWarehouse: number;
  issuedToProduction: number;
  onHand: number;
}

// Real-time per-Day-Store balance — same subtraction shape as Warehouse's
// own on-hand above, just scoped to one Day Store: everything ever
// ISSUED_DAY_STORE *to* it, minus everything ISSUED_PRODUCTION Store has
// tagged as coming back *out of* it (see issueInventoryRequestSchema —
// dayStoreId is now required there precisely so this subtraction is
// trustworthy, not silently missing rows nobody remembered to tag).
// This is NOT a second source of truth for Warehouse's own number —
// Warehouse's on-hand above is unaffected by any of this, it already
// nets out both ISSUED_* types regardless of which store they went
// through.
export async function getOnHandByDayStoreAndItem(dayStoreId: string, itemIds?: string[], db: Db = prisma): Promise<Map<string, DayStoreBalance>> {
  const itemFilter: Prisma.InventoryTransactionWhereInput = itemIds ? { itemId: { in: itemIds } } : {};

  const [issuedToStoreTotals, issuedFromStoreTotals] = await Promise.all([
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_DAY_STORE", dayStoreId }, _sum: { quantity: true } }),
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_PRODUCTION", dayStoreId }, _sum: { quantity: true } }),
  ]);

  const issuedToStore = new Map(issuedToStoreTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const issuedFromStore = new Map(issuedFromStoreTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));

  const allItemIds = new Set([...issuedToStore.keys(), ...issuedFromStore.keys(), ...(itemIds ?? [])]);
  const balances = new Map<string, DayStoreBalance>();
  for (const id of allItemIds) {
    const receivedFromWarehouse = issuedToStore.get(id) ?? 0;
    const issuedToProduction = issuedFromStore.get(id) ?? 0;
    balances.set(id, { receivedFromWarehouse, issuedToProduction, onHand: receivedFromWarehouse - issuedToProduction });
  }
  return balances;
}

// Real-time per-Plant balance — same shape as getOnHandByDayStoreAndItem
// above, but the "outflow" side is different: a Plant's inflow is
// ISSUED_PRODUCTION tagged with plantId (Inventory's existing tag,
// unchanged), while its outflow is BatchMaterialConsumption — real RM/PM
// usage Store logs at a batch's Dispensing stage (apps/api/src/modules/
// batches/batches.routes.ts). Unlike Day Store, there's no ledger row on
// the Inventory side for the outflow; it lives entirely in the Batches
// module, joined here through Batch.plantId.
export async function getOnHandByPlantAndItem(plantId: string, itemIds?: string[], db: Db = prisma): Promise<Map<string, number>> {
  const itemFilter: Prisma.InventoryTransactionWhereInput = itemIds ? { itemId: { in: itemIds } } : {};
  const consumptionItemFilter: Prisma.BatchMaterialConsumptionWhereInput = itemIds ? { itemId: { in: itemIds } } : {};

  const [issuedToPlantTotals, consumedTotals] = await Promise.all([
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_PRODUCTION", plantId }, _sum: { quantity: true } }),
    db.batchMaterialConsumption.groupBy({ by: ["itemId"], where: { ...consumptionItemFilter, batch: { plantId } }, _sum: { quantity: true } }),
  ]);

  const issuedToPlant = new Map(issuedToPlantTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const consumed = new Map(consumedTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));

  const allItemIds = new Set([...issuedToPlant.keys(), ...consumed.keys(), ...(itemIds ?? [])]);
  const onHand = new Map<string, number>();
  for (const id of allItemIds) {
    onHand.set(id, (issuedToPlant.get(id) ?? 0) - (consumed.get(id) ?? 0));
  }
  return onHand;
}

// Company-wide availability for PO Readiness — per the 2026-08-26
// PO-execution cascade call: RM/PM availability for deciding whether a
// PO can run is "total of Warehouse + Day Store + any balance stock at
// Plants," not Warehouse alone. getOnHandByItemId on its own only
// answers "what's still sitting in the Warehouse" — material already
// moved out to a Day Store or a Plant (but not yet consumed in
// production) drops out of that number even though it's still real,
// usable stock the company has. This sums all three so a PO doesn't
// show short just because its material already staged forward.
//
// No double-counting: Warehouse's own on-hand already subtracts every
// ISSUED_DAY_STORE/ISSUED_PRODUCTION row regardless of destination, so
// material that moved to a Day Store or Plant is removed from the
// Warehouse side and only re-appears once here, in that location's own
// balance. A transfer between locations (Warehouse -> Day Store,
// Day Store -> Plant) nets to zero change in this total — only a new
// RECEIVED delivery or a real BatchMaterialConsumption changes it,
// which is exactly why the existing notifyIfPoNewlyReady/
// notifyIfNewlyAvailable "0 -> positive crossing" hooks (fired only at
// RECEIVED events) don't need to change to stay correct against this.
export async function getTotalAvailableByItemId(itemIds: string[], db: Db & Pick<PrismaClient, "dayStore" | "plant"> = prisma): Promise<Map<string, number>> {
  const [warehouse, dayStores, plants] = await Promise.all([getOnHandByItemId(itemIds, db), db.dayStore.findMany({ select: { id: true } }), db.plant.findMany({ select: { id: true } })]);

  const total = new Map(warehouse);
  const [dayStoreBalances, plantBalances] = await Promise.all([
    Promise.all(dayStores.map((ds) => getOnHandByDayStoreAndItem(ds.id, itemIds, db))),
    Promise.all(plants.map((p) => getOnHandByPlantAndItem(p.id, itemIds, db))),
  ]);

  for (const balances of dayStoreBalances) {
    for (const [itemId, b] of balances) total.set(itemId, (total.get(itemId) ?? 0) + b.onHand);
  }
  for (const balances of plantBalances) {
    for (const [itemId, onHand] of balances) total.set(itemId, (total.get(itemId) ?? 0) + onHand);
  }

  return total;
}

// "Stock Now Available" alert — fires only on the exact moment an
// item's stock crosses from nothing-on-hand to something-on-hand
// (never on every later top-up, so this doesn't repeat once stock is
// already available). Only bothers anyone if there's an open
// Pre-Inventory requirement actually waiting on this item — otherwise
// there's nothing for PPIC or Production to act on. Called after any
// action that accepts new RECEIVED stock: QC accept, and both Opening
// Stock paths (single + bulk), which are ACCEPTED at creation.
export async function notifyIfNewlyAvailable(params: { itemId: string; addedQty: number; actorId: string; onFail: (label: string) => (err: unknown) => void }): Promise<void> {
  const { itemId, addedQty, actorId, onFail } = params;
  if (addedQty <= 0) return;

  const onHand = await getOnHandByItemId([itemId]);
  const currentStock = onHand.get(itemId) ?? 0;
  const stockBefore = currentStock - addedQty;
  if (stockBefore > 0 || currentStock <= 0) return; // not a 0 -> positive crossing

  const [item, requirements] = await Promise.all([
    prisma.inventoryItem.findUnique({ where: { id: itemId } }),
    prisma.preInventoryRequirement.findMany({ where: { itemId }, select: { id: true, requestedById: true } }),
  ]);
  if (!item || requirements.length === 0) return; // nobody's waiting on this one

  await Promise.all([
    ...requirements.map((r) =>
      notifyUser(r.requestedById, {
        title: `${item.name} now available`,
        body: `${currentStock}${item.unit ? ` ${item.unit}` : ""} on hand — you can start with what's there.`,
        link: "/pre-inventory",
      }).catch(onFail(`pre_inventory.stock_available.requester.${r.id}`)),
    ),
    notifyRoles(
      ["PRODUCTION"],
      { title: `${item.name} now available`, body: `${currentStock}${item.unit ? ` ${item.unit}` : ""} on hand.`, link: "/pre-inventory" },
      actorId,
    ).catch(onFail("pre_inventory.stock_available.production")),
  ]);
}
