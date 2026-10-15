import { prisma } from "../../common/lib/prisma";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { getRndStoreOnHand } from "../rnd-store/rnd-stock";
import type { Prisma, PrismaClient } from "@prisma/client";
import { allocateReceiptToPurchaseLines } from "./purchase-lines";

// A subset of the Prisma client's query surface, satisfied by both the
// top-level `prisma` singleton and the `tx` handle inside
// prisma.$transaction(async (tx) => ...). Letting every read in this
// file take one of these (default `prisma`) is what makes it possible
// to run the same on-hand check *and* the write that depends on it
// inside one atomic transaction — see the callers in inventory.routes.ts
// that pass `tx` under SERIALIZABLE isolation to close the check-then-
// write race two concurrent Store users could otherwise hit.
type Db = Pick<PrismaClient, "inventoryTransaction" | "batchMaterialConsumption" | "stockTransfer">;

// The one place stock-on-hand math lives — sum(RECEIVED, accepted) −
// sum(ISSUED_DAY_STORE) − sum(ISSUED_RND), per item. The Warehouse never
// issues to Production or a Plant: that only ever happens out of a Day
// Store (an ISSUED_PRODUCTION row always carries the dayStoreId it left),
// so it leaves that Day Store's balance and never the Warehouse's. Used by GET /inventory/stock (the full ledger view) and by
// Pre-Inventory's live shortfall computation (Part 2 — no more manual
// "Confirm Availability" step; PPIC's requirement is compared against
// this same number, live, every time it's read). ISSUED_RND (a sample
// sent to the R&D Store — see rnd-store.routes.ts) is an outflow here
// same as the other two ISSUED_* types; a RECEIVED row with
// isRndReturn=true (R&D's leftover coming back) needs no special-casing
// — it's already ACCEPTED at creation and counted by the RECEIVED sum
// above, same as Opening Stock.
export async function getOnHandByItemId(itemIds?: string[], db: Db = prisma): Promise<Map<string, number>> {
  // deletedAt: null everywhere in this file — a soft-deleted transaction
  // (Recycle Bin) stops counting toward stock the instant it's removed,
  // same as the hard delete this replaced did, and starts counting again
  // the instant an Admin restores it.
  const itemFilter: Prisma.InventoryTransactionWhereInput = { deletedAt: null, ...(itemIds ? { itemId: { in: itemIds } } : {}) };

  const [receivedTotals, issuedDayStoreTotals, issuedRndTotals] = await Promise.all([
    // Only ACCEPTED counts — a delivery still sitting in QC, or one QC
    // rejected, hasn't actually become usable stock yet. Opening Stock
    // rows are ACCEPTED at creation (see schema.prisma), so they're
    // already included here with no special-casing needed. rejectedQty
    // is summed alongside quantity so a partially-rejected delivery
    // (see qcReviewSchema) only counts its actually-usable remainder.
    // The OR clause is the expiry-quarantine gate — an ACCEPTED row
    // whose expiryDate has already passed stops counting the instant it
    // expires (live, on every read, no background job), same as a fresh
    // delivery still awaiting its first QC check — unless QA/QC has
    // explicitly released it (expiryReleasedAt set). Both buckets show
    // up together on GET /inventory/quarantine.
    db.inventoryTransaction.groupBy({
      by: ["itemId"],
      where: { ...itemFilter, type: "RECEIVED", receiptStatus: "ACCEPTED", OR: [{ expiryDate: null }, { expiryDate: { gte: new Date() } }, { expiryReleasedAt: { not: null } }] },
      _sum: { quantity: true, rejectedQty: true },
    }),
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_DAY_STORE" }, _sum: { quantity: true } }),
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_RND" }, _sum: { quantity: true } }),
  ]);

  const received = new Map(receivedTotals.map((r) => [r.itemId, (r._sum.quantity ?? 0) - (r._sum.rejectedQty ?? 0)]));
  const issuedDayStore = new Map(issuedDayStoreTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const issuedRnd = new Map(issuedRndTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));

  const allItemIds = new Set([...received.keys(), ...issuedDayStore.keys(), ...issuedRnd.keys(), ...(itemIds ?? [])]);
  const onHand = new Map<string, number>();
  for (const id of allItemIds) {
    onHand.set(id, (received.get(id) ?? 0) - (issuedDayStore.get(id) ?? 0) - (issuedRnd.get(id) ?? 0));
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
  // Store-to-store legs (see StockTransfer in schema.prisma) — kept as
  // their own two fields rather than folded into the Warehouse-facing
  // ones above, since "how much came from another Day Store" and "how
  // much went to Production" are different questions Store might ask.
  receivedFromTransfer: number;
  sentViaTransfer: number;
  onHand: number;
}

// Real-time per-Day-Store balance — same subtraction shape as Warehouse's
// own on-hand above, just scoped to one Day Store: everything ever
// ISSUED_DAY_STORE *to* it, minus everything ISSUED_PRODUCTION Store has
// tagged as coming back *out of* it (see issueInventoryRequestSchema —
// dayStoreId is now required there precisely so this subtraction is
// trustworthy, not silently missing rows nobody remembered to tag), plus
// the same two legs again for direct store-to-store transfers (see
// StockTransfer). This is NOT a second source of truth for Warehouse's
// own number — Warehouse's on-hand above is unaffected by any of this,
// it already nets out both ISSUED_* types regardless of which store they
// went through, and a StockTransfer with a WAREHOUSE destination lands
// there as a real RECEIVED row on confirm rather than through this path.
export async function getOnHandByDayStoreAndItem(dayStoreId: string, itemIds?: string[], db: Db = prisma): Promise<Map<string, DayStoreBalance>> {
  const itemFilter: Prisma.InventoryTransactionWhereInput = { deletedAt: null, ...(itemIds ? { itemId: { in: itemIds } } : {}) };
  const transferItemFilter: Prisma.StockTransferWhereInput = { deletedAt: null, ...(itemIds ? { itemId: { in: itemIds } } : {}) };

  const [issuedToStoreTotals, issuedFromStoreTotals, transferInTotals, transferOutTotals] = await Promise.all([
    // deliveredAt: not null — excludes a still-open transit-tracked row
    // (isTransitTracked=true, awaiting the Day Store's own confirm).
    // Every other row already has deliveredAt stamped at creation (see
    // schema.prisma), so this is a no-op filter for anything that isn't
    // currently in transit.
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_DAY_STORE", dayStoreId, deliveredAt: { not: null } }, _sum: { quantity: true } }),
    // No deliveredAt filter here on purpose — this is the Day Store's own
    // outflow (issued onward to Production), which leaves this store's
    // balance the instant it's logged, same "source drops immediately"
    // rule as everywhere else, regardless of whether that onward leg is
    // itself transit-tracked.
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_PRODUCTION", dayStoreId }, _sum: { quantity: true } }),
    // Another Day Store's transfer landing here — only counts once this
    // store has confirmed it, same in-transit gate as deliveredAt above.
    db.stockTransfer.groupBy({ by: ["itemId"], where: { ...transferItemFilter, destDayStoreId: dayStoreId, confirmedAt: { not: null } }, _sum: { quantity: true } }),
    // This store sending onward (to another Day Store, the Warehouse, or
    // a Plant) — counts immediately at send, regardless of destination
    // or confirmation, same "source drops immediately" rule as above.
    db.stockTransfer.groupBy({ by: ["itemId"], where: { ...transferItemFilter, sourceDayStoreId: dayStoreId }, _sum: { quantity: true } }),
  ]);

  const issuedToStore = new Map(issuedToStoreTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const issuedFromStore = new Map(issuedFromStoreTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const transferIn = new Map(transferInTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const transferOut = new Map(transferOutTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));

  const allItemIds = new Set([...issuedToStore.keys(), ...issuedFromStore.keys(), ...transferIn.keys(), ...transferOut.keys(), ...(itemIds ?? [])]);
  const balances = new Map<string, DayStoreBalance>();
  for (const id of allItemIds) {
    const receivedFromWarehouse = issuedToStore.get(id) ?? 0;
    const issuedToProduction = issuedFromStore.get(id) ?? 0;
    const receivedFromTransfer = transferIn.get(id) ?? 0;
    const sentViaTransfer = transferOut.get(id) ?? 0;
    balances.set(id, {
      receivedFromWarehouse,
      issuedToProduction,
      receivedFromTransfer,
      sentViaTransfer,
      onHand: receivedFromWarehouse + receivedFromTransfer - issuedToProduction - sentViaTransfer,
    });
  }
  return balances;
}

// Real-time per-Plant balance — same shape as getOnHandByDayStoreAndItem
// above, but the "outflow" side is different: a Plant's inflow is
// ISSUED_PRODUCTION tagged with plantId (Inventory's existing tag,
// unchanged), while its outflow is BatchMaterialConsumption — real RM/PM
// usage Store logs at a PreProduction run's Dispensing stage (apps/api/
// src/modules/batches/pre-production.routes.ts). Unlike Day Store,
// there's no ledger row on the Inventory side for the outflow; it lives
// entirely in the Batches module, joined here through
// PreProduction.plantId.
export async function getOnHandByPlantAndItem(plantId: string, itemIds?: string[], db: Db = prisma): Promise<Map<string, number>> {
  const itemFilter: Prisma.InventoryTransactionWhereInput = { deletedAt: null, ...(itemIds ? { itemId: { in: itemIds } } : {}) };
  const consumptionItemFilter: Prisma.BatchMaterialConsumptionWhereInput = itemIds ? { itemId: { in: itemIds } } : {};
  const transferItemFilter: Prisma.StockTransferWhereInput = { deletedAt: null, ...(itemIds ? { itemId: { in: itemIds } } : {}) };

  const [issuedToPlantTotals, transferInTotals, transferOutTotals, consumedTotals] = await Promise.all([
    // deliveredAt: not null — same open-transit exclusion as the Day
    // Store inflow above; a no-op for anything not currently in transit.
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_PRODUCTION", plantId, deliveredAt: { not: null } }, _sum: { quantity: true } }),
    // A Day Store's direct transfer landing here — only counts once
    // Plant has confirmed it, same in-transit gate as deliveredAt above.
    db.stockTransfer.groupBy({ by: ["itemId"], where: { ...transferItemFilter, destPlantId: plantId, confirmedAt: { not: null } }, _sum: { quantity: true } }),
    // This Plant returning unused material to a store/Warehouse (Plant
    // Consumption's "returned" leg) — counts immediately at send, same
    // "source drops immediately" rule as every other outflow, regardless
    // of whether the receiving side has confirmed yet.
    db.stockTransfer.groupBy({ by: ["itemId"], where: { ...transferItemFilter, sourcePlantId: plantId }, _sum: { quantity: true } }),
    db.batchMaterialConsumption.groupBy({ by: ["itemId"], where: { ...consumptionItemFilter, preProduction: { plantId } }, _sum: { quantity: true } }),
  ]);

  const issuedToPlant = new Map(issuedToPlantTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const transferIn = new Map(transferInTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const transferOut = new Map(transferOutTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const consumed = new Map(consumedTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));

  const allItemIds = new Set([...issuedToPlant.keys(), ...transferIn.keys(), ...transferOut.keys(), ...consumed.keys(), ...(itemIds ?? [])]);
  const onHand = new Map<string, number>();
  for (const id of allItemIds) {
    onHand.set(id, (issuedToPlant.get(id) ?? 0) + (transferIn.get(id) ?? 0) - (transferOut.get(id) ?? 0) - (consumed.get(id) ?? 0));
  }
  return onHand;
}

// Company-wide availability for PO Readiness, Pre-Inventory's shortfall
// check, and the Pending PO Report — per the 2026-08-26 PO-execution
// cascade call (Day Store/Plant) plus the follow-up request to also
// count R&D Store: RM/PM availability for deciding whether something is
// genuinely short is "total of Warehouse + every Day Store + any
// balance stock at Plants + R&D Store," not Warehouse alone.
// getOnHandByItemId on its own only answers "what's still sitting in
// the Warehouse" — material already moved out to a Day Store, a Plant,
// or R&D Store (but not yet consumed/dispatched/tested away) drops out
// of that number even though it's still real, usable stock the company
// has. This sums all four so nothing shows short just because its
// material already staged forward to another location.
//
// No double-counting: Warehouse's own on-hand already subtracts every
// ISSUED_DAY_STORE/ISSUED_PRODUCTION/ISSUED_RND row regardless of
// destination, so material that moved to a Day Store, Plant, or R&D
// Store is removed from the Warehouse side and only re-appears once
// here, in that location's own balance. A transfer between locations
// (Warehouse -> Day Store, Day Store -> Plant, Warehouse -> R&D Store)
// nets to zero change in this total — only a new RECEIVED delivery or a
// real BatchMaterialConsumption/R&D consumption changes it, which is
// exactly why the existing notifyIfPoNewlyReady/notifyIfNewlyAvailable
// "0 -> positive crossing" hooks (fired only at RECEIVED events) don't
// need to change to stay correct against this.
export async function getTotalAvailableByItemId(
  itemIds: string[],
  db: Db & Pick<PrismaClient, "dayStore" | "plant" | "rndStoreTransaction"> = prisma,
): Promise<Map<string, number>> {
  const [warehouse, dayStores, plants, rndStore] = await Promise.all([
    getOnHandByItemId(itemIds, db),
    db.dayStore.findMany({ select: { id: true } }),
    db.plant.findMany({ select: { id: true } }),
    getRndStoreOnHand(itemIds, db),
  ]);

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
  for (const [itemId, onHand] of rndStore) {
    total.set(itemId, (total.get(itemId) ?? 0) + onHand);
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

  // The delivery is real stock now: take it off the PI lines still "on order" for this item
  // (earliest ETA first), so it is not counted both as stock and as incoming.
  await allocateReceiptToPurchaseLines(itemId, addedQty).catch(onFail(`pre_inventory.purchase_lines.receipt.${itemId}`));

  // A Day Store waiting on this material for a plan is told it is in the Warehouse now, so it can ask for it.
  await notifyDayStoresWaitingFor(itemId, addedQty).catch(onFail(`day_store.material_arrived.${itemId}`));

  const onHand = await getOnHandByItemId([itemId]);
  const currentStock = onHand.get(itemId) ?? 0;
  const stockBefore = currentStock - addedQty;
  if (stockBefore > 0 || currentStock <= 0) return; // not a 0 -> positive crossing

  const [item, requirements] = await Promise.all([
    prisma.inventoryItem.findUnique({ where: { id: itemId } }),
    prisma.preInventoryRequirement.findMany({ where: { itemId, deletedAt: null }, select: { id: true, requestedById: true } }),
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

/** Day Stores with an open production request for this item hear that new stock reached the Warehouse. */
async function notifyDayStoresWaitingFor(itemId: string, addedQty: number): Promise<void> {
  const open = await prisma.inventoryRequest.findMany({
    where: { itemId, purpose: "ISSUED_PRODUCTION", deletedAt: null, status: { in: ["PENDING", "APPROVED", "PARTIALLY_ISSUED"] }, plant: { dayStoreId: { not: null } } },
    select: { purchaseOrderItemId: true, plant: { select: { name: true, dayStoreId: true } }, item: { select: { name: true, unit: true } } },
  });
  if (open.length === 0) return;
  const poItems = await prisma.purchaseOrderItem.findMany({ where: { id: { in: open.map((r) => r.purchaseOrderItemId).filter((id): id is string => !!id) } }, select: { id: true, productName: true } });
  const productOf = new Map(poItems.map((p) => [p.id, p.productName]));
  const byStore = new Map<string, { itemName: string; unit: string; products: Set<string> }>();
  for (const r of open) {
    const storeId = r.plant?.dayStoreId;
    if (!storeId) continue;
    const cur = byStore.get(storeId) ?? { itemName: r.item.name, unit: r.item.unit ?? "", products: new Set<string>() };
    const product = r.purchaseOrderItemId ? productOf.get(r.purchaseOrderItemId) : undefined;
    if (product) cur.products.add(product);
    byStore.set(storeId, cur);
  }
  for (const [storeId, info] of byStore) {
    const content = {
      title: `${info.itemName} arrived in the Warehouse`,
      body: `${Math.round(addedQty * 1000) / 1000}${info.unit ? ` ${info.unit}` : ""} received${info.products.size ? ` - needed for ${[...info.products].join(", ")}` : ""}. Ask the Warehouse for it.`,
      link: "/my-store/production-requests",
    };
    const users = await prisma.dayStoreAssignment.findMany({ where: { dayStoreId: storeId, user: { isActive: true } }, select: { userId: true } });
    if (users.length > 0) await Promise.all(users.map((u) => notifyUser(u.userId, content)));
  }
}
