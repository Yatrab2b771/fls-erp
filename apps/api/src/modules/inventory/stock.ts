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
type Db = Pick<PrismaClient, "inventoryTransaction" | "batchMaterialConsumption" | "stockTransfer" | "stockAdjustment">;

/**
 * Everything the Warehouse ledger is made of, per item. `getOnHandByItemId` and the Stock on Hand view both read it, so the
 * two can never disagree.
 *
 *   accepted      ACCEPTED deliveries, net of any partial QC rejection (expired ones included)
 *   adjustmentIn  approved stock adjustments that put stock in (found extra / count up)
 *   issued        sent to Day Stores and to the R&D Store
 *   expired       the part of `accepted` whose expiry date has passed and that QA/QC has not released
 *   disposed      expired stock thrown away (approved EXPIRED_DISPOSAL adjustments)
 *   adjustmentOut approved adjustments that take usable stock out (damage, spillage, count down)
 *
 * Expiry is applied first-expiry-first-out: stock leaves in expiry order, so what was already issued came out of the lots that
 * expire first. What is still sitting expired in Quarantine is therefore max(0, expired - issued - disposed), and usable stock is
 *
 *     accepted + adjustmentIn - max(issued + disposed, expired) - adjustmentOut
 *
 * i.e. issuing material before it expired never turns the balance negative when the rest expires.
 */
export interface WarehouseLedger {
  /** The part of accepted deliveries QC partially rejected (already left out of `accepted`; kept for the Stock on Hand view). */
  rejectedQty: number;
  accepted: number;
  adjustmentIn: number;
  issuedDayStore: number;
  issuedRnd: number;
  expired: number;
  disposed: number;
  adjustmentOut: number;
}

export function emptyWarehouseLedger(): WarehouseLedger {
  return { rejectedQty: 0, accepted: 0, adjustmentIn: 0, issuedDayStore: 0, issuedRnd: 0, expired: 0, disposed: 0, adjustmentOut: 0 };
}

/** Usable Warehouse stock from a ledger (see WarehouseLedger). */
export function usableOf(l: WarehouseLedger): number {
  const issued = l.issuedDayStore + l.issuedRnd;
  return l.accepted + l.adjustmentIn - Math.max(issued + l.disposed, l.expired) - l.adjustmentOut;
}

/** Expired stock still physically in Quarantine (not yet issued out first-expiry-first-out, not yet disposed). */
export function expiredRemainingOf(l: WarehouseLedger): number {
  return Math.max(0, l.expired - (l.issuedDayStore + l.issuedRnd) - l.disposed);
}

export async function getWarehouseLedger(itemIds?: string[], db: Db = prisma): Promise<Map<string, WarehouseLedger>> {
  // deletedAt: null everywhere in this file — a soft-deleted transaction
  // (Recycle Bin) stops counting toward stock the instant it's removed,
  // same as the hard delete this replaced did, and starts counting again
  // the instant an Admin restores it.
  const itemFilter: Prisma.InventoryTransactionWhereInput = { deletedAt: null, ...(itemIds ? { itemId: { in: itemIds } } : {}) };
  const now = new Date();

  const [acceptedTotals, expiredTotals, issuedDayStoreTotals, issuedRndTotals, adjustments] = await Promise.all([
    // Only ACCEPTED counts — a delivery still sitting in QC, or one QC rejected, hasn't actually become usable stock yet.
    // rejectedQty is summed alongside quantity so a partially-rejected delivery only counts its actually-usable remainder.
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "RECEIVED", receiptStatus: "ACCEPTED" }, _sum: { quantity: true, rejectedQty: true } }),
    // The expiry-quarantine part of the above: past its expiry date and not released by QA/QC.
    db.inventoryTransaction.groupBy({
      by: ["itemId"],
      where: { ...itemFilter, type: "RECEIVED", receiptStatus: "ACCEPTED", expiryDate: { lt: now }, expiryReleasedAt: null },
      _sum: { quantity: true, rejectedQty: true },
    }),
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_DAY_STORE" }, _sum: { quantity: true } }),
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_RND" }, _sum: { quantity: true } }),
    db.stockAdjustment.findMany({
      where: { status: "APPROVED", deletedAt: null, locationType: "WAREHOUSE", ...(itemIds ? { itemId: { in: itemIds } } : {}) },
      select: { itemId: true, reason: true, quantityDelta: true },
    }),
  ]);

  const ledgers = new Map<string, WarehouseLedger>();
  const of = (id: string) => {
    let l = ledgers.get(id);
    if (!l) {
      l = emptyWarehouseLedger();
      ledgers.set(id, l);
    }
    return l;
  };
  for (const id of itemIds ?? []) of(id);
  for (const r of acceptedTotals) {
    const l = of(r.itemId);
    l.accepted = (r._sum.quantity ?? 0) - (r._sum.rejectedQty ?? 0);
    l.rejectedQty = r._sum.rejectedQty ?? 0;
  }
  for (const r of expiredTotals) of(r.itemId).expired = (r._sum.quantity ?? 0) - (r._sum.rejectedQty ?? 0);
  for (const r of issuedDayStoreTotals) of(r.itemId).issuedDayStore = r._sum.quantity ?? 0;
  for (const r of issuedRndTotals) of(r.itemId).issuedRnd = r._sum.quantity ?? 0;
  for (const a of adjustments) {
    const l = of(a.itemId);
    if (a.quantityDelta > 0) l.adjustmentIn += a.quantityDelta;
    else if (a.reason === "EXPIRED_DISPOSAL") l.disposed += -a.quantityDelta;
    else l.adjustmentOut += -a.quantityDelta;
  }
  return ledgers;
}

// The one place stock-on-hand math lives for the Warehouse. The Warehouse never issues to Production or a Plant: that only ever
// happens out of a Day Store (an ISSUED_PRODUCTION row always carries the dayStoreId it left), so it leaves that Day Store's
// balance and never the Warehouse's. Used by GET /inventory/stock (the full ledger view) and by Pre-Inventory's live shortfall
// computation (PPIC's requirement is compared against this same number, live, every time it's read). ISSUED_RND (a sample sent
// to the R&D Store — see rnd-store.routes.ts) is an outflow here same as ISSUED_DAY_STORE; a RECEIVED row with isRndReturn=true
// (R&D's leftover coming back) needs no special-casing — it's already ACCEPTED at creation and counted as accepted stock.
export async function getOnHandByItemId(itemIds?: string[], db: Db = prisma): Promise<Map<string, number>> {
  const ledgers = await getWarehouseLedger(itemIds, db);
  const onHand = new Map<string, number>();
  for (const [id, l] of ledgers) onHand.set(id, usableOf(l));
  return onHand;
}

/** Expired stock still sitting in the Warehouse's Quarantine, per item (after first-expiry-first-out issues and disposals). */
export async function getExpiredRemainingByItemId(itemIds?: string[], db: Db = prisma): Promise<Map<string, number>> {
  const ledgers = await getWarehouseLedger(itemIds, db);
  const out = new Map<string, number>();
  for (const [id, l] of ledgers) {
    const remaining = expiredRemainingOf(l);
    if (remaining > 1e-9) out.set(id, remaining);
  }
  return out;
}

/**
 * The expired receipts that still have material in Quarantine, with how much of each is left. Issues and disposals are taken out
 * of the earliest-expiry receipts first (first-expiry-first-out), so a receipt that was fully issued before it expired is not
 * listed even though its date has passed.
 */
export interface ExpiredReceipt {
  id: string;
  itemId: string;
  net: number;
  remaining: number;
}
export async function getExpiredReceipts(itemIds?: string[], db: Db = prisma): Promise<ExpiredReceipt[]> {
  const now = new Date();
  const rows = await db.inventoryTransaction.findMany({
    where: { deletedAt: null, type: "RECEIVED", receiptStatus: "ACCEPTED", expiryDate: { lt: now }, expiryReleasedAt: null, ...(itemIds ? { itemId: { in: itemIds } } : {}) },
    select: { id: true, itemId: true, quantity: true, rejectedQty: true, expiryDate: true, date: true },
    orderBy: [{ expiryDate: "asc" }, { date: "asc" }],
  });
  if (rows.length === 0) return [];
  const ledgers = await getWarehouseLedger([...new Set(rows.map((r) => r.itemId))], db);
  const consumed = new Map<string, number>();
  for (const [id, l] of ledgers) consumed.set(id, l.issuedDayStore + l.issuedRnd + l.disposed);
  const out: ExpiredReceipt[] = [];
  for (const r of rows) {
    const net = r.quantity - (r.rejectedQty ?? 0);
    const left = consumed.get(r.itemId) ?? 0;
    const taken = Math.min(net, left);
    consumed.set(r.itemId, left - taken);
    const remaining = net - taken;
    if (remaining > 1e-9) out.push({ id: r.id, itemId: r.itemId, net, remaining });
  }
  return out;
}

// One Day Store's real-time balance broken into its legs, not just
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
  // Approved stock adjustments at this store (+ found, - lost), already included in onHand.
  adjustments: number;
  onHand: number;
}

const net = (r: { _sum: { quantity: number | null; shortQty: number | null } }) => (r._sum.quantity ?? 0) - (r._sum.shortQty ?? 0);

/** Approved adjustments at one Day Store / Plant / the R&D Store, per item (signed). */
async function adjustmentsAt(where: Prisma.StockAdjustmentWhereInput, itemIds: string[] | undefined, db: Pick<PrismaClient, "stockAdjustment">): Promise<Map<string, number>> {
  const rows = await db.stockAdjustment.groupBy({ by: ["itemId"], where: { status: "APPROVED", deletedAt: null, ...where, ...(itemIds ? { itemId: { in: itemIds } } : {}) }, _sum: { quantityDelta: true } });
  return new Map(rows.map((r) => [r.itemId, r._sum.quantityDelta ?? 0]));
}

// Real-time per-Day-Store balance — same subtraction shape as Warehouse's
// own on-hand above, just scoped to one Day Store: everything ever
// ISSUED_DAY_STORE *to* it, minus everything ISSUED_PRODUCTION Store has
// tagged as coming back *out of* it (see issueInventoryRequestSchema —
// dayStoreId is now required there precisely so this subtraction is
// trustworthy, not silently missing rows nobody remembered to tag), plus
// the same two legs again for direct store-to-store transfers (see
// StockTransfer), plus approved stock adjustments. This is NOT a second
// source of truth for Warehouse's own number — Warehouse's on-hand above is
// unaffected by any of this, it already nets out both ISSUED_* types
// regardless of which store they went through, and a StockTransfer with a
// WAREHOUSE destination lands there as a real RECEIVED row on confirm
// rather than through this path.
export async function getOnHandByDayStoreAndItem(dayStoreId: string, itemIds?: string[], db: Db = prisma): Promise<Map<string, DayStoreBalance>> {
  const itemFilter: Prisma.InventoryTransactionWhereInput = { deletedAt: null, ...(itemIds ? { itemId: { in: itemIds } } : {}) };
  const transferItemFilter: Prisma.StockTransferWhereInput = { deletedAt: null, ...(itemIds ? { itemId: { in: itemIds } } : {}) };

  const [issuedToStoreTotals, issuedFromStoreTotals, transferInTotals, transferOutTotals, adjusted] = await Promise.all([
    // deliveredAt: not null — excludes a still-open transit-tracked row (isTransitTracked=true, awaiting the Day Store's own
    // confirm). Every other row already has deliveredAt stamped at creation (see schema.prisma), so this is a no-op filter for
    // anything that isn't currently in transit. shortQty is what the receiver reported as missing when it confirmed.
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_DAY_STORE", dayStoreId, deliveredAt: { not: null } }, _sum: { quantity: true, shortQty: true } }),
    // No deliveredAt filter here on purpose — this is the Day Store's own outflow (issued onward to Production), which leaves
    // this store's balance the instant it's logged, same "source drops immediately" rule as everywhere else, regardless of
    // whether that onward leg is itself transit-tracked.
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_PRODUCTION", dayStoreId }, _sum: { quantity: true } }),
    // Another Day Store's transfer landing here — only counts once this store has confirmed it, same in-transit gate as above.
    db.stockTransfer.groupBy({ by: ["itemId"], where: { ...transferItemFilter, destDayStoreId: dayStoreId, confirmedAt: { not: null } }, _sum: { quantity: true, shortQty: true } }),
    // This store sending onward (to another Day Store, the Warehouse, or a Plant) — counts immediately at send, regardless of
    // destination or confirmation, same "source drops immediately" rule as above.
    db.stockTransfer.groupBy({ by: ["itemId"], where: { ...transferItemFilter, sourceDayStoreId: dayStoreId }, _sum: { quantity: true } }),
    adjustmentsAt({ locationType: "DAY_STORE", dayStoreId }, itemIds, db),
  ]);

  const issuedToStore = new Map(issuedToStoreTotals.map((r) => [r.itemId, net(r)]));
  const issuedFromStore = new Map(issuedFromStoreTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const transferIn = new Map(transferInTotals.map((r) => [r.itemId, net(r)]));
  const transferOut = new Map(transferOutTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));

  const allItemIds = new Set([...issuedToStore.keys(), ...issuedFromStore.keys(), ...transferIn.keys(), ...transferOut.keys(), ...adjusted.keys(), ...(itemIds ?? [])]);
  const balances = new Map<string, DayStoreBalance>();
  for (const id of allItemIds) {
    const receivedFromWarehouse = issuedToStore.get(id) ?? 0;
    const issuedToProduction = issuedFromStore.get(id) ?? 0;
    const receivedFromTransfer = transferIn.get(id) ?? 0;
    const sentViaTransfer = transferOut.get(id) ?? 0;
    const adjustments = adjusted.get(id) ?? 0;
    balances.set(id, {
      receivedFromWarehouse,
      issuedToProduction,
      receivedFromTransfer,
      sentViaTransfer,
      adjustments,
      onHand: receivedFromWarehouse + receivedFromTransfer - issuedToProduction - sentViaTransfer + adjustments,
    });
  }
  return balances;
}

// Real-time per-Plant balance — same shape as getOnHandByDayStoreAndItem
// above, but the "outflow" side is different: a Plant's inflow is
// ISSUED_PRODUCTION tagged with plantId (Inventory's existing tag,
// unchanged), while its outflow is BatchMaterialConsumption — real RM/PM
// usage logged against a production run. Unlike Day Store, there's no
// ledger row on the Inventory side for the outflow; it lives entirely in
// the Batches module, joined here through PreProduction.plantId.
export async function getOnHandByPlantAndItem(plantId: string, itemIds?: string[], db: Db = prisma): Promise<Map<string, number>> {
  const itemFilter: Prisma.InventoryTransactionWhereInput = { deletedAt: null, ...(itemIds ? { itemId: { in: itemIds } } : {}) };
  const consumptionItemFilter: Prisma.BatchMaterialConsumptionWhereInput = itemIds ? { itemId: { in: itemIds } } : {};
  const transferItemFilter: Prisma.StockTransferWhereInput = { deletedAt: null, ...(itemIds ? { itemId: { in: itemIds } } : {}) };

  const [issuedToPlantTotals, transferInTotals, transferOutTotals, consumedTotals, adjusted] = await Promise.all([
    // deliveredAt: not null — same open-transit exclusion as the Day Store inflow above; a no-op for anything not in transit.
    db.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_PRODUCTION", plantId, deliveredAt: { not: null } }, _sum: { quantity: true, shortQty: true } }),
    // A Day Store's direct transfer landing here — only counts once Plant has confirmed it.
    db.stockTransfer.groupBy({ by: ["itemId"], where: { ...transferItemFilter, destPlantId: plantId, confirmedAt: { not: null } }, _sum: { quantity: true, shortQty: true } }),
    // This Plant returning unused material to a store/Warehouse (Plant Consumption's "returned" leg) — counts immediately at
    // send, same "source drops immediately" rule as every other outflow, regardless of whether the receiving side confirmed.
    db.stockTransfer.groupBy({ by: ["itemId"], where: { ...transferItemFilter, sourcePlantId: plantId }, _sum: { quantity: true } }),
    db.batchMaterialConsumption.groupBy({ by: ["itemId"], where: { ...consumptionItemFilter, preProduction: { plantId } }, _sum: { quantity: true } }),
    adjustmentsAt({ locationType: "PLANT", plantId }, itemIds, db),
  ]);

  const issuedToPlant = new Map(issuedToPlantTotals.map((r) => [r.itemId, net(r)]));
  const transferIn = new Map(transferInTotals.map((r) => [r.itemId, net(r)]));
  const transferOut = new Map(transferOutTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
  const consumed = new Map(consumedTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));

  const allItemIds = new Set([...issuedToPlant.keys(), ...transferIn.keys(), ...transferOut.keys(), ...consumed.keys(), ...adjusted.keys(), ...(itemIds ?? [])]);
  const onHand = new Map<string, number>();
  for (const id of allItemIds) {
    onHand.set(id, (issuedToPlant.get(id) ?? 0) + (transferIn.get(id) ?? 0) - (transferOut.get(id) ?? 0) - (consumed.get(id) ?? 0) + (adjusted.get(id) ?? 0));
  }
  return onHand;
}

/**
 * Material that has left one place but is not yet booked into the next: a transit-tracked issue not yet confirmed, an R&D
 * transfer (either way) not yet confirmed, a Day Store / Plant stock transfer not yet confirmed. The sender's balance has
 * already dropped and the receiver's has not risen, so without this the quantity is in no ledger at all - it would show as
 * missing in Total Available (and trigger a needless purchase) and as unaccounted in the Material Reconciliation.
 */
export async function getInTransitByItemId(itemIds?: string[], db: Db & Pick<PrismaClient, "rndTransfer"> = prisma): Promise<Map<string, number>> {
  const [issues, rnd, transfers] = await Promise.all([
    db.inventoryTransaction.groupBy({
      by: ["itemId"],
      where: { deletedAt: null, isTransitTracked: true, deliveredAt: null, type: { in: ["ISSUED_DAY_STORE", "ISSUED_PRODUCTION"] }, ...(itemIds ? { itemId: { in: itemIds } } : {}) },
      _sum: { quantity: true },
    }),
    db.rndTransfer.groupBy({ by: ["itemId"], where: { deletedAt: null, confirmedAt: null, ...(itemIds ? { itemId: { in: itemIds } } : {}) }, _sum: { quantity: true } }),
    db.stockTransfer.groupBy({ by: ["itemId"], where: { deletedAt: null, confirmedAt: null, ...(itemIds ? { itemId: { in: itemIds } } : {}) }, _sum: { quantity: true } }),
  ]);
  const total = new Map<string, number>();
  for (const rows of [issues, rnd, transfers]) for (const r of rows) total.set(r.itemId, (total.get(r.itemId) ?? 0) + (r._sum.quantity ?? 0));
  return total;
}

// Company-wide availability for PO Readiness, Pre-Inventory's shortfall
// check, and the Pending PO Report — per the 2026-08-26 PO-execution
// cascade call (Day Store/Plant) plus the follow-up request to also
// count R&D Store: RM/PM availability for deciding whether something is
// genuinely short is "total of Warehouse + every Day Store + any
// balance stock at Plants + R&D Store + material on its way between
// them," not Warehouse alone.
// getOnHandByItemId on its own only answers "what's still sitting in
// the Warehouse" — material already moved out to a Day Store, a Plant,
// or R&D Store (but not yet consumed/dispatched/tested away) drops out
// of that number even though it's still real, usable stock the company
// has. This sums all of them so nothing shows short just because its
// material already staged forward to another location.
//
// No double-counting: Warehouse's own on-hand already subtracts every
// ISSUED_DAY_STORE/ISSUED_RND row regardless of destination, so material
// that moved to a Day Store, Plant, or R&D Store is removed from the
// Warehouse side and only re-appears once here, in that location's own
// balance - or, while it is still unconfirmed, in the in-transit total.
// A transfer between locations nets to zero change in this total — only
// a new RECEIVED delivery, an approved adjustment or a real
// BatchMaterialConsumption/R&D consumption changes it, which is exactly
// why the existing notifyIfPoNewlyReady/notifyIfNewlyAvailable "0 ->
// positive crossing" hooks (fired only at RECEIVED events) stay correct.
export async function getTotalAvailableByItemId(
  itemIds: string[],
  db: Db & Pick<PrismaClient, "dayStore" | "plant" | "rndStoreTransaction" | "rndTransfer"> = prisma,
): Promise<Map<string, number>> {
  const [warehouse, dayStores, plants, rndStore, inTransit] = await Promise.all([
    getOnHandByItemId(itemIds, db),
    db.dayStore.findMany({ select: { id: true } }),
    db.plant.findMany({ select: { id: true } }),
    getRndStoreOnHand(itemIds, db),
    getInTransitByItemId(itemIds, db),
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
  for (const [itemId, qty] of inTransit) {
    total.set(itemId, (total.get(itemId) ?? 0) + qty);
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
export async function notifyIfNewlyAvailable(params: { itemId: string; addedQty: number; actorId: string; vendorName?: string | null; onFail: (label: string) => (err: unknown) => void }): Promise<void> {
  const { itemId, addedQty, actorId, vendorName, onFail } = params;
  if (addedQty <= 0) return;

  // The delivery is real stock now: take it off the PI lines still "on order" for this item
  // (earliest ETA first), so it is not counted both as stock and as incoming.
  await allocateReceiptToPurchaseLines(itemId, addedQty, prisma, vendorName).catch(onFail(`pre_inventory.purchase_lines.receipt.${itemId}`));

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
    // Whoever asked for it (PPIC) hears it; Production no longer has Pre-Inventory, so it is not told here.
    ...requirements.map((r) =>
      notifyUser(r.requestedById, {
        title: `${item.name} now available`,
        body: `${currentStock}${item.unit ? ` ${item.unit}` : ""} on hand — you can start with what's there.`,
        link: "/pre-inventory",
      }).catch(onFail(`pre_inventory.stock_available.requester.${r.id}`)),
    ),
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
