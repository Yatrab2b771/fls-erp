import { prisma } from "../../common/lib/prisma";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import type { Prisma } from "@prisma/client";

// The one place stock-on-hand math lives — sum(RECEIVED, accepted) −
// sum(ISSUED_DAY_STORE) − sum(ISSUED_PRODUCTION), per item. Used by
// GET /inventory/stock (the full ledger view) and by Pre-Inventory's
// live shortfall computation (Part 2 — no more manual "Confirm
// Availability" step; PPIC's requirement is compared against this same
// number, live, every time it's read).
export async function getOnHandByItemId(itemIds?: string[]): Promise<Map<string, number>> {
  const itemFilter: Prisma.InventoryTransactionWhereInput = itemIds ? { itemId: { in: itemIds } } : {};

  const [receivedTotals, issuedDayStoreTotals, issuedProductionTotals] = await Promise.all([
    // Only ACCEPTED counts — a delivery still sitting in QC, or one QC
    // rejected, hasn't actually become usable stock yet. Opening Stock
    // rows are ACCEPTED at creation (see schema.prisma), so they're
    // already included here with no special-casing needed. rejectedQty
    // is summed alongside quantity so a partially-rejected delivery
    // (see qcReviewSchema) only counts its actually-usable remainder.
    prisma.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "RECEIVED", receiptStatus: "ACCEPTED" }, _sum: { quantity: true, rejectedQty: true } }),
    prisma.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_DAY_STORE" }, _sum: { quantity: true } }),
    prisma.inventoryTransaction.groupBy({ by: ["itemId"], where: { ...itemFilter, type: "ISSUED_PRODUCTION" }, _sum: { quantity: true } }),
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
