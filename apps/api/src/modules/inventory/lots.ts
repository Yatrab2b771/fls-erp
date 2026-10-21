import type { Prisma, PrismaClient } from "@prisma/client";
import { getOnHandByDayStoreAndItem, getOnHandByPlantAndItem, getWarehouseLedger } from "./stock";

/**
 * Lot traceability (see LotAllocation in schema.prisma). A lot is one RECEIVED row. Each time stock leaves a place the lots it
 * came out of are written down, first-expiry-first-out, so that:
 *   - an issue can only draw material that is still good (not expired, or released by QA/QC),
 *   - "which lots went into batch X" and "where did lot Y go" can be answered (a recall),
 *   - material that has since expired AT a Day Store or Plant can be found, not just at the Warehouse.
 *
 * The stock NUMBERS stay exactly what stock.ts says - lots never change a balance. They describe it. Where lots are not known
 * (stock booked before this existed, quantities that moved by a transfer, found-extra adjustments) the lot balance of a place is
 * simply smaller than its stock, and the difference is "lot unknown"; the oldest-expiry lots are assumed to be the ones used up by
 * movements that carry no lot, which is also what first-expiry-first-out would have done.
 */
type Db = Prisma.TransactionClient | PrismaClient;

export interface LotSlice {
  receiptId: string;
  quantity: number;
}

/** A vendor name made comparable: "Yantai  Co" and "yantai co" are the same vendor. */
export const vendorKey = (name: string | null | undefined): string => (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export interface LotBalance {
  receiptId: string;
  /** Who supplied it (the delivery's vendor name), for the approved-vendor rules. */
  vendorName: string | null;
  remaining: number;
  expiryDate: Date | null;
  receivedOn: Date;
  /** true when its expiry date has passed and QA/QC has not released it: it can't be issued from. */
  expired: boolean;
}

const EPS = 1e-9;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

type LotInfo = { id: string; vendorName: string | null; expiryDate: Date | null; expiryReleasedAt: Date | null; date: Date; quantity: number; rejectedQty: number | null };

const byExpiryThenDate = (a: { expiryDate: Date | null; receivedOn: Date }, b: { expiryDate: Date | null; receivedOn: Date }) =>
  (a.expiryDate?.getTime() ?? Infinity) - (b.expiryDate?.getTime() ?? Infinity) || a.receivedOn.getTime() - b.receivedOn.getTime();

const isExpired = (l: { expiryDate: Date | null; expiryReleasedAt: Date | null }, now: Date) => !!l.expiryDate && l.expiryDate.getTime() < now.getTime() && !l.expiryReleasedAt;

/** Takes `qty` away from the front of the (already ordered) lots; returns what could not be taken. */
function consume(lots: LotBalance[], qty: number): number {
  let left = qty;
  for (const lot of lots) {
    if (left <= EPS) break;
    const take = Math.min(lot.remaining, left);
    lot.remaining -= take;
    left -= take;
  }
  return left;
}

async function lotInfo(db: Db, ids: string[]): Promise<Map<string, LotInfo>> {
  if (ids.length === 0) return new Map();
  const rows = await db.inventoryTransaction.findMany({ where: { id: { in: ids } }, select: { id: true, vendorName: true, expiryDate: true, expiryReleasedAt: true, date: true, quantity: true, rejectedQty: true } });
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Warehouse lots of one item, with how much of each is still in the Warehouse. Expired-and-unreleased lots are included (flagged).
 * `pendingIssueQty`: an issue that already exists as a row but has no lots recorded yet (the one being allocated right now) - it must
 * not be counted as a movement that "used up the earliest stock", or it would take its own quantity out of the lots before picking them.
 */
export async function getWarehouseLots(db: Db, itemId: string, pendingIssueQty = 0): Promise<LotBalance[]> {
  const now = new Date();
  const receipts = await db.inventoryTransaction.findMany({
    where: { itemId, type: "RECEIVED", receiptStatus: "ACCEPTED", deletedAt: null },
    select: { id: true, vendorName: true, expiryDate: true, expiryReleasedAt: true, date: true, quantity: true, rejectedQty: true },
  });
  if (receipts.length === 0) return [];

  // What each lot has already given: recorded allocations of Warehouse issues (to Day Stores and to the R&D Store).
  const allocated = await db.lotAllocation.groupBy({
    by: ["receiptId"],
    where: { itemId, issueTxn: { deletedAt: null, type: { in: ["ISSUED_DAY_STORE", "ISSUED_RND"] } } },
    _sum: { quantity: true },
  });
  const allocatedBy = new Map(allocated.map((a) => [a.receiptId, a._sum.quantity ?? 0]));

  const lots: LotBalance[] = receipts
    .map((r) => ({
      receiptId: r.id,
      vendorName: r.vendorName,
      remaining: Math.max(0, r.quantity - (r.rejectedQty ?? 0) - (allocatedBy.get(r.id) ?? 0)),
      expiryDate: r.expiryDate,
      receivedOn: r.date,
      expired: isExpired(r, now),
    }))
    .sort(byExpiryThenDate);

  // Movements that carry no lot (issues booked before lots existed, expired-stock disposals) used up the earliest-expiry stock.
  const ledger = (await getWarehouseLedger([itemId], db as Parameters<typeof getWarehouseLedger>[1])).get(itemId);
  if (ledger) {
    const allocatedTotal = allocated.reduce((s, a) => s + (a._sum.quantity ?? 0), 0);
    const unallocated = Math.max(0, ledger.issuedDayStore + ledger.issuedRnd - pendingIssueQty - allocatedTotal) + ledger.disposed;
    consume(lots, unallocated);
    // Anything that took usable stock out without a lot (damage, spillage) comes off the earliest usable lots.
    consume(
      lots.filter((l) => !l.expired),
      ledger.adjustmentOut,
    );
  }
  return lots;
}

/** Day Store / Plant lots: what flowed in with a lot, less what flowed out with a lot, trimmed to the real balance. */
async function locationLots(db: Db, where: { inflow: Prisma.LotAllocationWhereInput; outflow: Prisma.LotAllocationWhereInput }, itemId: string, onHand: number): Promise<LotBalance[]> {
  const [inflow, outflow] = await Promise.all([
    db.lotAllocation.groupBy({ by: ["receiptId"], where: { itemId, ...where.inflow }, _sum: { quantity: true } }),
    db.lotAllocation.groupBy({ by: ["receiptId"], where: { itemId, ...where.outflow }, _sum: { quantity: true } }),
  ]);
  const outBy = new Map(outflow.map((o) => [o.receiptId, o._sum.quantity ?? 0]));
  const info = await lotInfo(db, inflow.map((i) => i.receiptId));
  const now = new Date();
  const lots: LotBalance[] = inflow
    .flatMap((i) => {
      const l = info.get(i.receiptId);
      if (!l) return [];
      return [{ receiptId: i.receiptId, vendorName: l.vendorName, remaining: Math.max(0, (i._sum.quantity ?? 0) - (outBy.get(i.receiptId) ?? 0)), expiryDate: l.expiryDate, receivedOn: l.date, expired: isExpired(l, now) }];
    })
    .filter((l) => l.remaining > EPS)
    .sort(byExpiryThenDate);
  // Movements without a lot (transfers, counts) used up the earliest-expiry stock first, so the surplus is trimmed from the front.
  const known = lots.reduce((s, l) => s + l.remaining, 0);
  if (known > onHand + EPS) consume(lots, known - Math.max(0, onHand));
  return lots.filter((l) => l.remaining > EPS);
}

/** `pendingOutQty`: an issue out of this store that already exists as a row but has no lots recorded yet (see getWarehouseLots). */
export function getDayStoreLots(db: Db, dayStoreId: string, itemId: string, pendingOutQty = 0): Promise<LotBalance[]> {
  return getOnHandByDayStoreAndItem(dayStoreId, [itemId], db as Parameters<typeof getOnHandByDayStoreAndItem>[2]).then((m) =>
    locationLots(
      db,
      {
        inflow: { issueTxn: { deletedAt: null, type: "ISSUED_DAY_STORE", dayStoreId, deliveredAt: { not: null } } },
        outflow: { issueTxn: { deletedAt: null, type: "ISSUED_PRODUCTION", dayStoreId } },
      },
      itemId,
      (m.get(itemId)?.onHand ?? 0) + pendingOutQty,
    ),
  );
}

export function getPlantLots(db: Db, plantId: string, itemId: string): Promise<LotBalance[]> {
  return getOnHandByPlantAndItem(plantId, [itemId], db as Parameters<typeof getOnHandByPlantAndItem>[2]).then((m) =>
    locationLots(
      db,
      {
        inflow: { issueTxn: { deletedAt: null, type: "ISSUED_PRODUCTION", plantId, deliveredAt: { not: null } } },
        outflow: { dispensingLine: { productionBatch: { preProduction: { plantId } } } },
      },
      itemId,
      m.get(itemId) ?? 0,
    ),
  );
}

/**
 * FEFO pick of `qty` from usable (not expired) lots. Returns the slices it could cover - possibly less than asked (rest = lot unknown).
 * `allow`: only lots of these vendors (vendorKey) may be drawn - the approved vendors of a product that has such a rule.
 */
export function pickFefo(lots: LotBalance[], qty: number, allow?: Set<string>): LotSlice[] {
  const usable = lots.filter((l) => !l.expired && l.remaining > EPS && (!allow || allow.has(vendorKey(l.vendorName)))).sort(byExpiryThenDate);
  const slices: LotSlice[] = [];
  let left = qty;
  for (const lot of usable) {
    if (left <= EPS) break;
    const take = Math.min(lot.remaining, left);
    slices.push({ receiptId: lot.receiptId, quantity: round3(take) });
    left -= take;
  }
  return slices.filter((s) => s.quantity > EPS);
}

async function save(db: Db, itemId: string, slices: LotSlice[], target: { issueTxnId: string } | { dispensingLineId: string }) {
  if (slices.length === 0) return slices;
  await db.lotAllocation.createMany({ data: slices.map((s) => ({ itemId, receiptId: s.receiptId, quantity: s.quantity, ...target })) });
  return slices;
}

/** Records the lots a just-created Warehouse issue (to a Day Store or the R&D Store) came out of. Call inside the issuing transaction. */
export async function recordWarehouseIssueLots(db: Db, txn: { id: string; itemId: string; quantity: number }, allow?: Set<string>) {
  // The issue row exists already but has no allocations yet: leave its own quantity out of the balances it is drawing from.
  const lots = await getWarehouseLots(db, txn.itemId, txn.quantity);
  return save(db, txn.itemId, pickFefo(lots, txn.quantity, allow), { issueTxnId: txn.id });
}

/** Records the lots a just-created Day Store -> Plant issue came out of. */
export async function recordDayStoreIssueLots(db: Db, txn: { id: string; itemId: string; quantity: number; dayStoreId: string }, allow?: Set<string>) {
  const lots = await getDayStoreLots(db, txn.dayStoreId, txn.itemId, txn.quantity);
  return save(db, txn.itemId, pickFefo(lots, txn.quantity, allow), { issueTxnId: txn.id });
}

/** Records the lots of whichever issue was just created (Warehouse -> Day Store / R&D, or Day Store -> Plant). Other types carry no lots. */
export async function recordIssueLots(db: Db, txn: { id: string; itemId: string; type: string; quantity: number; dayStoreId: string | null }, allow?: Set<string>) {
  if (txn.type === "ISSUED_DAY_STORE" || txn.type === "ISSUED_RND") return recordWarehouseIssueLots(db, txn, allow);
  if (txn.type === "ISSUED_PRODUCTION" && txn.dayStoreId) return recordDayStoreIssueLots(db, { ...txn, dayStoreId: txn.dayStoreId }, allow);
  return [];
}

/** Records the lots a batch's dispensing line was drawn from (the Plant's lots). */
export async function recordDispensingLots(db: Db, line: { id: string; itemId: string; quantity: number }, plantId: string, allow?: Set<string>) {
  const lots = await getPlantLots(db, plantId, line.itemId);
  return save(db, line.itemId, pickFefo(lots, line.quantity, allow), { dispensingLineId: line.id });
}

/** A lot's identity, for showing: the supplier delivery it came from. */
export const lotSelect = {
  id: true,
  itemId: true,
  date: true,
  quantity: true,
  rejectedQty: true,
  unit: true,
  vendorName: true,
  grnNo: true,
  batchNo: true,
  invoiceNo: true,
  mfgDate: true,
  expiryDate: true,
  expiryReleasedAt: true,
  receiptStatus: true,
  item: { select: { id: true, name: true, category: true } },
} satisfies Prisma.InventoryTransactionSelect;
