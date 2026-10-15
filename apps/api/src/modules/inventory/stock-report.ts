import { prisma } from "../../common/lib/prisma";
import type { Prisma } from "@prisma/client";

/**
 * The stock report for a period: per item, what was there at the start (Opening), what came in (Received), what went out (Issued) and what
 * was there at the end (Closing), for one location, several locations, or the whole company. Same movements the live stock maths uses
 * (stock.ts / rnd-stock.ts), but cut by date, so a stock figure can be read "as of" any day.
 *
 * The chosen locations are read as ONE group. Received and Issued count only what crosses the edge of the group: a move between two
 * chosen locations (a Day Store issuing to its Plant, the Warehouse to a Day Store...) is neither, so nothing is counted twice. Opening and
 * Closing are the group's total stock. With every location chosen (the whole company) the only things crossing the edge are deliveries
 * from outside (Received) and material used up or sent to customers (Issued).
 *
 *   Warehouse   in  = deliveries accepted by QC (by receipt date), less what QC rejected;   out = issued to a Day Store / the R&D Store
 *   Day Store   in  = issued to it by the Warehouse (delivered) + transfers confirmed into it;   out = issued on to its Plant + transfers it sent
 *   Plant       in  = issued to it by its Day Store (delivered) + transfers confirmed into it;   out = transfers it sent back + material used (dispensing)
 *   R&D Store   in  = INBOUND;   out = consumed + dispatched + returned
 * Every movement remembers who is on the other side ("ds:<id>", "plant:<id>", "warehouse", "rnd", or null = outside the company).
 */

export interface ReportLocation {
  key: string; // "warehouse" | "rnd" | "ds:<id>" | "plant:<id>"
  kind: "WAREHOUSE" | "DAY_STORE" | "RND" | "PLANT";
}

type Range = { gte?: Date; lt?: Date; lte?: Date };
type Entry = { itemId: string; qty: number; other: string | null };
type Flow = { in: Entry[]; out: Entry[] };

const store = (id: string | null) => (id ? `ds:${id}` : null);
const plant = (id: string | null) => (id ? `plant:${id}` : null);
/** The other side of a transfer: a Day Store, a Plant, or (neither set) the Warehouse. */
const counterpart = (dayStoreId: string | null, plantId: string | null) => store(dayStoreId) ?? plant(plantId) ?? "warehouse";

async function flowOf(loc: ReportLocation, range: Range): Promise<Flow> {
  const live = { deletedAt: null };
  const txn = <B extends ("dayStoreId" | "plantId" | "isRndReturn" | "stockTransferId")[]>(type: Prisma.InventoryTransactionWhereInput["type"], by: B, extra: Prisma.InventoryTransactionWhereInput = {}) =>
    (prisma.inventoryTransaction.groupBy as (args: unknown) => Promise<unknown>)({ by: ["itemId", ...by], where: { ...live, type, date: range, ...extra }, _sum: { quantity: true, rejectedQty: true } }) as Promise<
      ({ itemId: string; _sum: { quantity: number | null; rejectedQty: number | null } } & Partial<Record<B[number], string | boolean | null>>)[]
    >;
  const transfers = (where: Prisma.StockTransferWhereInput, by: ("sourceDayStoreId" | "sourcePlantId" | "destDayStoreId" | "destPlantId")[]) =>
    (prisma.stockTransfer.groupBy as (args: unknown) => Promise<unknown>)({ by: ["itemId", ...by], where: { ...live, ...where }, _sum: { quantity: true } }) as Promise<
      ({ itemId: string; _sum: { quantity: number | null } } & Partial<Record<(typeof by)[number], string | null>>)[]
    >;
  const net = (r: { _sum: { quantity: number | null; rejectedQty?: number | null } }) => (r._sum.quantity ?? 0) - (r._sum.rejectedQty ?? 0);

  if (loc.kind === "WAREHOUSE") {
    const [received, toStores, toRnd] = await Promise.all([
      txn("RECEIVED", ["isRndReturn", "stockTransferId"], { receiptStatus: "ACCEPTED" }),
      txn("ISSUED_DAY_STORE", ["dayStoreId"]),
      txn("ISSUED_RND", []),
    ]);
    // A delivery that came from a transfer (a Day Store / Plant sending stock back) has that location on the other side
    const ids = received.map((r) => r.stockTransferId as string | null).filter((v): v is string => !!v);
    const sources = new Map((ids.length ? await prisma.stockTransfer.findMany({ where: { id: { in: ids } }, select: { id: true, sourceDayStoreId: true, sourcePlantId: true } }) : []).map((t) => [t.id, counterpart(t.sourceDayStoreId, t.sourcePlantId)]));
    return {
      in: received.map((r) => ({ itemId: r.itemId, qty: net(r), other: r.isRndReturn ? "rnd" : r.stockTransferId ? (sources.get(r.stockTransferId as string) ?? null) : null })),
      out: [...toStores.map((r) => ({ itemId: r.itemId, qty: net(r), other: store((r.dayStoreId as string | null) ?? null) })), ...toRnd.map((r) => ({ itemId: r.itemId, qty: net(r), other: "rnd" }))],
    };
  }
  if (loc.kind === "DAY_STORE") {
    const id = loc.key.slice(3);
    const [fromWarehouse, transferIn, toPlant, transferOut] = await Promise.all([
      txn("ISSUED_DAY_STORE", [], { dayStoreId: id, deliveredAt: { not: null } }),
      transfers({ destDayStoreId: id, confirmedAt: { not: null, ...range } }, ["sourceDayStoreId", "sourcePlantId"]),
      txn("ISSUED_PRODUCTION", ["plantId"], { dayStoreId: id }),
      transfers({ sourceDayStoreId: id, sentAt: range }, ["destDayStoreId", "destPlantId"]),
    ]);
    return {
      in: [...fromWarehouse.map((r) => ({ itemId: r.itemId, qty: net(r), other: "warehouse" })), ...transferIn.map((r) => ({ itemId: r.itemId, qty: net(r), other: counterpart((r.sourceDayStoreId as string | null) ?? null, (r.sourcePlantId as string | null) ?? null) }))],
      out: [...toPlant.map((r) => ({ itemId: r.itemId, qty: net(r), other: plant((r.plantId as string | null) ?? null) })), ...transferOut.map((r) => ({ itemId: r.itemId, qty: net(r), other: counterpart((r.destDayStoreId as string | null) ?? null, (r.destPlantId as string | null) ?? null) }))],
    };
  }
  if (loc.kind === "PLANT") {
    const id = loc.key.slice(6);
    const [fromStore, transferIn, transferOut, used] = await Promise.all([
      txn("ISSUED_PRODUCTION", ["dayStoreId"], { plantId: id, deliveredAt: { not: null } }),
      transfers({ destPlantId: id, confirmedAt: { not: null, ...range } }, ["sourceDayStoreId", "sourcePlantId"]),
      transfers({ sourcePlantId: id, sentAt: range }, ["destDayStoreId", "destPlantId"]),
      prisma.batchMaterialConsumption.groupBy({ by: ["itemId"], where: { createdAt: range, preProduction: { plantId: id } }, _sum: { quantity: true } }),
    ]);
    return {
      in: [...fromStore.map((r) => ({ itemId: r.itemId, qty: net(r), other: store((r.dayStoreId as string | null) ?? null) })), ...transferIn.map((r) => ({ itemId: r.itemId, qty: net(r), other: counterpart((r.sourceDayStoreId as string | null) ?? null, (r.sourcePlantId as string | null) ?? null) }))],
      out: [...transferOut.map((r) => ({ itemId: r.itemId, qty: net(r), other: counterpart((r.destDayStoreId as string | null) ?? null, (r.destPlantId as string | null) ?? null) })), ...used.map((r) => ({ itemId: r.itemId, qty: r._sum.quantity ?? 0, other: null }))],
    };
  }
  // R&D Store: a row's date is its own date, falling back to when it was logged
  const rows = await prisma.rndStoreTransaction.findMany({ where: { deletedAt: null }, select: { itemId: true, type: true, quantity: true, date: true, createdAt: true } });
  const inside = (d: Date) => (!range.gte || d >= range.gte) && (!range.lt || d < range.lt) && (!range.lte || d <= range.lte);
  const flow: Flow = { in: [], out: [] };
  for (const r of rows) {
    if (!inside(r.date ?? r.createdAt)) continue;
    if (r.type === "INBOUND") flow.in.push({ itemId: r.itemId, qty: r.quantity, other: "warehouse" });
    else flow.out.push({ itemId: r.itemId, qty: r.quantity, other: r.type === "RETURNED" ? "warehouse" : null }); // consumed / dispatched leave the company
  }
  return flow;
}

export interface MovementRow {
  itemId: string;
  opening: number;
  received: number;
  issued: number;
  closing: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * from / to are inclusive days (UTC). Without `from` the opening is 0 and everything up to `to` is the period; without `to` the period
 * runs to now. `locations` are read as one group (see the top of this file).
 */
export async function loadStockMovement(locations: ReportLocation[], from: string | undefined, to: string | undefined): Promise<MovementRow[]> {
  const fromStart = from ? new Date(`${from}T00:00:00.000Z`) : undefined;
  const toEnd = to ? new Date(`${to}T23:59:59.999Z`) : undefined;
  const periodRange: Range = { ...(fromStart ? { gte: fromStart } : {}), ...(toEnd ? { lte: toEnd } : {}) };
  const group = new Set(locations.map((l) => l.key));

  const opening = new Map<string, number>();
  const received = new Map<string, number>();
  const issued = new Map<string, number>();
  const closingMove = new Map<string, number>(); // everything in the period, in - out
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  await Promise.all(
    locations.map(async (loc) => {
      const [before, during] = await Promise.all([fromStart ? flowOf(loc, { lt: fromStart }) : Promise.resolve<Flow>({ in: [], out: [] }), flowOf(loc, periodRange)]);
      for (const e of before.in) add(opening, e.itemId, e.qty);
      for (const e of before.out) add(opening, e.itemId, -e.qty);
      for (const e of during.in) {
        add(closingMove, e.itemId, e.qty);
        if (!e.other || !group.has(e.other)) add(received, e.itemId, e.qty); // only what comes from outside the group
      }
      for (const e of during.out) {
        add(closingMove, e.itemId, -e.qty);
        if (!e.other || !group.has(e.other)) add(issued, e.itemId, e.qty); // only what leaves the group
      }
    }),
  );

  const ids = new Set([...opening.keys(), ...received.keys(), ...issued.keys(), ...closingMove.keys()]);
  const rows: MovementRow[] = [];
  for (const itemId of ids) {
    const open = opening.get(itemId) ?? 0;
    rows.push({ itemId, opening: round2(open), received: round2(received.get(itemId) ?? 0), issued: round2(issued.get(itemId) ?? 0), closing: round2(open + (closingMove.get(itemId) ?? 0)) });
  }
  return rows.filter((r) => Math.abs(r.opening) > 1e-6 || Math.abs(r.received) > 1e-6 || Math.abs(r.issued) > 1e-6 || Math.abs(r.closing) > 1e-6);
}

// ---------------------------------------------------------------------------------------------------------------------
// The entries behind one item's row: every movement of that item in the period that touches the chosen locations
// ---------------------------------------------------------------------------------------------------------------------

export interface StockEntry {
  date: string;
  /** What happened, in words: "Received from vendor", "Issued to Day Store", "Transfer", "Used in production"... */
  label: string;
  from: string;
  to: string;
  qty: number;
  unit: string;
  /** Relative to the chosen locations: IN (comes from outside), OUT (goes outside), MOVED (between chosen locations). */
  direction: "IN" | "OUT" | "MOVED";
  batchNo: string | null;
  grnNo: string | null;
  mfgDate: string | null;
  expiryDate: string | null;
  vendorName: string | null;
  reference: string | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** `names` maps a location key ("warehouse", "ds:<id>", "plant:<id>", "rnd") to its label. */
export async function loadItemEntries(locations: ReportLocation[], names: Map<string, string>, itemId: string, from: string | undefined, to: string | undefined): Promise<StockEntry[]> {
  const fromStart = from ? new Date(`${from}T00:00:00.000Z`) : undefined;
  const toEnd = to ? new Date(`${to}T23:59:59.999Z`) : undefined;
  const range: Range = { ...(fromStart ? { gte: fromStart } : {}), ...(toEnd ? { lte: toEnd } : {}) };
  const group = new Set(locations.map((l) => l.key));
  const nameOf = (key: string | null, fallback = "Outside") => (key ? (names.get(key) ?? key) : fallback);
  const live = { deletedAt: null, itemId };
  const out: (StockEntry & { fromKey: string | null; toKey: string | null })[] = [];
  const push = (e: {
    date: Date;
    label: string;
    fromKey: string | null;
    toKey: string | null;
    fromLabel?: string;
    toLabel?: string;
    qty: number;
    unit: string;
    batchNo?: string | null;
    grnNo?: string | null;
    mfgDate?: Date | null;
    expiryDate?: Date | null;
    vendorName?: string | null;
    reference?: string | null;
  }) =>
    out.push({
      date: e.date.toISOString(),
      label: e.label,
      from: e.fromLabel ?? nameOf(e.fromKey),
      to: e.toLabel ?? nameOf(e.toKey),
      qty: round2(e.qty),
      unit: e.unit,
      direction: "IN",
      batchNo: e.batchNo ?? null,
      grnNo: e.grnNo ?? null,
      mfgDate: iso(e.mfgDate),
      expiryDate: iso(e.expiryDate),
      vendorName: e.vendorName ?? null,
      reference: e.reference ?? null,
      fromKey: e.fromKey,
      toKey: e.toKey,
    });

  const [received, issued, transfers, consumed, rnd] = await Promise.all([
    prisma.inventoryTransaction.findMany({ where: { ...live, type: "RECEIVED", receiptStatus: "ACCEPTED", date: range } }),
    prisma.inventoryTransaction.findMany({ where: { ...live, type: { in: ["ISSUED_DAY_STORE", "ISSUED_PRODUCTION", "ISSUED_RND"] }, date: range, deliveredAt: { not: null } } }),
    prisma.stockTransfer.findMany({ where: { ...live, OR: [{ sentAt: range }, { confirmedAt: { not: null, ...range } }] } }),
    prisma.batchMaterialConsumption.findMany({
      where: { itemId, createdAt: range },
      include: { preProduction: { select: { plantId: true, purchaseOrderItem: { select: { productName: true, purchaseOrder: { select: { poNumber: true } } } } } } },
    }),
    prisma.rndStoreTransaction.findMany({ where: live }),
  ]);

  const transferSources = new Map(transfers.map((t) => [t.id, counterpart(t.sourceDayStoreId, t.sourcePlantId)]));
  for (const r of received) {
    const fromTransfer = r.stockTransferId ? transferSources.get(r.stockTransferId) : undefined;
    push({
      date: r.date,
      label: r.isRndReturn ? "Returned from R&D Store" : fromTransfer ? "Returned by a store / plant" : "Received from vendor",
      fromKey: r.isRndReturn ? "rnd" : (fromTransfer ?? null),
      fromLabel: r.isRndReturn || fromTransfer ? undefined : (r.vendorName ?? "Vendor"),
      toKey: "warehouse",
      qty: r.quantity - (r.rejectedQty ?? 0),
      unit: r.unit,
      batchNo: r.batchNo,
      grnNo: r.grnNo,
      mfgDate: r.mfgDate,
      expiryDate: r.expiryDate,
      vendorName: r.vendorName,
      reference: r.invoiceNo ? `Invoice ${r.invoiceNo}` : null,
    });
  }
  for (const r of issued) {
    if (r.type === "ISSUED_DAY_STORE") push({ date: r.date, label: "Issued to Day Store", fromKey: "warehouse", toKey: store(r.dayStoreId), qty: r.quantity, unit: r.unit, batchNo: r.batchNo, grnNo: r.grnNo, mfgDate: r.mfgDate, expiryDate: r.expiryDate, reference: r.remark });
    else if (r.type === "ISSUED_RND") push({ date: r.date, label: "Issued to R&D Store", fromKey: "warehouse", toKey: "rnd", qty: r.quantity, unit: r.unit, batchNo: r.batchNo, reference: r.remark });
    else push({ date: r.date, label: "Issued to Plant", fromKey: store(r.dayStoreId), toKey: plant(r.plantId), qty: r.quantity, unit: r.unit, batchNo: r.batchNo, reference: r.remark });
  }
  for (const t of transfers) {
    const dest = t.destinationType === "WAREHOUSE" ? "warehouse" : counterpart(t.destDayStoreId, t.destPlantId);
    push({ date: t.sentAt, label: t.confirmedAt ? "Transfer" : "Transfer (not yet confirmed)", fromKey: counterpart(t.sourceDayStoreId, t.sourcePlantId), toKey: dest, qty: t.quantity, unit: t.unit, reference: t.note });
  }
  for (const c of consumed) {
    const item = c.preProduction.purchaseOrderItem;
    push({
      date: c.createdAt,
      label: c.purpose === "PRODUCTION" ? "Used in production" : c.purpose === "SAMPLE" ? "Used as sample" : "Wasted",
      fromKey: plant(c.preProduction.plantId),
      toKey: null,
      toLabel: "Used up",
      qty: c.quantity,
      unit: c.unit,
      reference: `${item.productName} (${item.purchaseOrder.poNumber ?? "PO"})`,
    });
  }
  const inside = (d: Date) => (!range.gte || d >= range.gte) && (!range.lte || d <= range.lte);
  for (const r of rnd) {
    const d = r.date ?? r.createdAt;
    if (!inside(d)) continue;
    if (r.type === "INBOUND") push({ date: d, label: "Received into R&D Store", fromKey: "warehouse", toKey: "rnd", qty: r.quantity, unit: r.unit, vendorName: r.vendorName, reference: r.note });
    else if (r.type === "RETURNED") push({ date: d, label: "Returned to Warehouse", fromKey: "rnd", toKey: "warehouse", qty: r.quantity, unit: r.unit, reference: r.note });
    else push({ date: d, label: r.type === "DISPATCHED" ? "Dispatched to customer" : "Consumed in R&D", fromKey: "rnd", toKey: null, toLabel: r.type === "DISPATCHED" ? "Customer" : "Used up", qty: r.quantity, unit: r.unit, reference: r.note });
  }

  return out
    .flatMap(({ fromKey, toKey, ...e }) => {
      const fromIn = !!fromKey && group.has(fromKey);
      const toIn = !!toKey && group.has(toKey);
      if (!fromIn && !toIn) return []; // does not touch the chosen locations
      return [{ ...e, direction: fromIn && toIn ? ("MOVED" as const) : toIn ? ("IN" as const) : ("OUT" as const) }];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
