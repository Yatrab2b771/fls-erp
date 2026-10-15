import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { parsePagination, parseSearch, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { getRndStoreOnHand } from "../rnd-store/rnd-stock";
import type { Prisma } from "@prisma/client";
import { getScopedDayStoreIds, requireWarehouseSeat } from "./day-store-access";
import { getExpiredReceipts, getOnHandByDayStoreAndItem, getOnHandByItemId, getOnHandByPlantAndItem } from "./stock";
import { loadItemEntries, loadStockMovement } from "./stock-report";

/**
 * "Available Stock" - every RM / PM that is on hand, wherever it sits: Warehouse, each Day
 * Store, the R&D Store and each Plant, in one list.
 *
 *   GET /meta        the locations (for the filter and the By-item columns)
 *   GET /summary     the Store dashboard tile: how many items have stock
 *   GET /            the list - view=item (one row per item with a column per location)
 *                    or view=location (one row per item x location); paged and filtered here
 *   GET /options     dropdown values for the item filter
 *   GET /batches     the receipts (batch no, GRN, mfg / expiry date, qty received) behind one item (?itemId=),
 *                    or behind every item the list filters match (for the Excel report)
 *
 * By item, each row also carries what the receipts say about it: earliest expiry, batches, last received,
 * quantity held in quarantine, and quantity still on order. The system tracks stock per item, not per batch,
 * so these describe the batches that make up the stock; they do not say how much of each batch is left.
 *
 * Same stock maths as everywhere else (stock.ts / rnd-stock.ts), so the numbers match the other
 * Store tiles. Available can't be negative: a location that has gone negative counts as 0.
 */
export const availableStockRouter = Router();
availableStockRouter.use(requireAuth, requireRole("STORE", "PPIC", "ACCOUNTS", "PURCHASE"));

const EPS = 1e-6;
const round2 = (n: number) => Math.round(n * 100) / 100;

interface Location {
  key: string; // "warehouse" | "rnd" | "ds:<id>" | "plant:<id>"
  label: string;
  kind: "WAREHOUSE" | "DAY_STORE" | "RND" | "PLANT";
}

/**
 * Every location, or - for a Day-Store-limited login - just their own store(s) and the Plant paired
 * with each (the Warehouse and R&D Store are not theirs to see).
 */
async function loadLocations(scope: string[] | null = null): Promise<Location[]> {
  const [dayStores, plants] = await Promise.all([
    prisma.dayStore.findMany({ where: scope ? { id: { in: scope } } : {}, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.plant.findMany({ where: scope ? { dayStoreId: { in: scope } } : {}, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return [
    ...(scope ? [] : [{ key: "warehouse", label: "Warehouse", kind: "WAREHOUSE" as const }]),
    ...dayStores.map((d) => ({ key: `ds:${d.id}`, label: d.name, kind: "DAY_STORE" as const })),
    ...(scope ? [] : [{ key: "rnd", label: "R&D Store", kind: "RND" as const }]),
    ...plants.map((p) => ({ key: `plant:${p.id}`, label: `Plant: ${p.name}`, kind: "PLANT" as const })),
  ];
}

const scopeOf = (req: AuthedRequest) => getScopedDayStoreIds(req.user!.id, req.user!.roles);

/** itemId -> location key -> quantity on hand (only positive balances). */
async function loadBalances(locations: Location[]): Promise<Map<string, Map<string, number>>> {
  const byItem = new Map<string, Map<string, number>>();
  const add = (itemId: string, key: string, qty: number) => {
    if (qty <= EPS) return;
    let row = byItem.get(itemId);
    if (!row) byItem.set(itemId, (row = new Map()));
    row.set(key, round2(qty));
  };
  await Promise.all(
    locations.map(async (loc) => {
      if (loc.kind === "WAREHOUSE") for (const [id, qty] of await getOnHandByItemId()) add(id, loc.key, qty);
      else if (loc.kind === "RND") for (const [id, qty] of await getRndStoreOnHand()) add(id, loc.key, qty);
      else if (loc.kind === "DAY_STORE") for (const [id, b] of await getOnHandByDayStoreAndItem(loc.key.slice(3))) add(id, loc.key, b.onHand);
      else for (const [id, qty] of await getOnHandByPlantAndItem(loc.key.slice(6))) add(id, loc.key, qty);
    }),
  );
  return byItem;
}

const DAY_MS = 86_400_000;

export interface ItemDetail {
  earliestExpiry: string | null;
  expiresInDays: number | null;
  lastReceived: string | null;
  batches: number;
  quarantineQty: number;
  onOrderQty: number;
  nextEta: string | null;
}

const EMPTY_DETAIL: ItemDetail = { earliestExpiry: null, expiresInDays: null, lastReceived: null, batches: 0, quarantineQty: 0, onOrderQty: 0, nextEta: null };

/**
 * What the receipts and purchase lines say about each item. A receipt counts toward stock when it is
 * ACCEPTED and not expired (or QA/QC released it after expiry); a pending / on-hold one, or an expired one
 * nobody released, is quarantine. `warehouseSide` false (a Day Store login) keeps only the expiry - the rest is
 * Warehouse business.
 */
async function loadItemDetails(itemIds: string[], warehouseSide: boolean): Promise<Map<string, ItemDetail>> {
  const result = new Map<string, ItemDetail>();
  if (itemIds.length === 0) return result;
  const now = Date.now();
  const receipts = await prisma.inventoryTransaction.findMany({
    where: { type: "RECEIVED", deletedAt: null, itemId: { in: itemIds }, receiptStatus: { in: ["ACCEPTED", "PENDING_QC", "ON_HOLD"] } },
    select: { id: true, itemId: true, receiptStatus: true, quantity: true, rejectedQty: true, expiryDate: true, expiryReleasedAt: true, date: true },
  });
  // An expired receipt is in Quarantine only while material from it is still here (issued out before it expired = not quarantined).
  const expiredLeft = new Map((await getExpiredReceipts(itemIds)).map((e) => [e.id, e.remaining]));
  const lines = warehouseSide
    ? await prisma.requirementPurchaseLine.findMany({ where: { status: "OPEN", requirement: { itemId: { in: itemIds }, deletedAt: null } }, select: { quantity: true, receivedQty: true, eta: true, requirement: { select: { itemId: true } } } })
    : [];

  const get = (id: string) => {
    let d = result.get(id);
    if (!d) result.set(id, (d = { ...EMPTY_DETAIL }));
    return d;
  };
  for (const r of receipts) {
    const d = get(r.itemId);
    const expired = expiredLeft.has(r.id);
    if (r.receiptStatus === "ACCEPTED" && !expired) {
      if (r.expiryDate && (!d.earliestExpiry || r.expiryDate.toISOString() < d.earliestExpiry)) d.earliestExpiry = r.expiryDate.toISOString();
      if (warehouseSide) {
        d.batches += 1;
        if (!d.lastReceived || r.date.toISOString() > d.lastReceived) d.lastReceived = r.date.toISOString();
      }
    } else if (warehouseSide) {
      d.quarantineQty = round2(d.quarantineQty + (expired ? (expiredLeft.get(r.id) ?? 0) : r.quantity - (r.rejectedQty ?? 0)));
    }
  }
  for (const l of lines) {
    const d = get(l.requirement.itemId);
    const open = Math.max(0, l.quantity - l.receivedQty);
    if (open <= EPS) continue;
    d.onOrderQty = round2(d.onOrderQty + open);
    if (!d.nextEta || l.eta.toISOString() < d.nextEta) d.nextEta = l.eta.toISOString();
  }
  for (const d of result.values()) d.expiresInDays = d.earliestExpiry ? Math.ceil((new Date(d.earliestExpiry).getTime() - now) / DAY_MS) : null;
  return result;
}

const EXPIRY_WINDOWS: Record<string, number> = { "Within 30 days": 30, "Within 60 days": 60, "Within 90 days": 90 };

const many = (raw: unknown): string[] => (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());

availableStockRouter.get("/meta", async (req: AuthedRequest, res, next) => {
  try {
    const scope = await scopeOf(req);
    res.json({ locations: await loadLocations(scope), scoped: scope !== null });
  } catch (err) {
    next(err);
  }
});

// The tile: items that have stock somewhere (RM / PM split), and how many locations hold any.
availableStockRouter.get("/summary", async (req: AuthedRequest, res, next) => {
  try {
    const locations = await loadLocations(await scopeOf(req));
    const balances = await loadBalances(locations);
    const items = await prisma.inventoryItem.findMany({ where: { id: { in: [...balances.keys()] } }, select: { id: true, category: true } });
    res.json({
      itemsInStock: items.length,
      rmItems: items.filter((i) => i.category === "RM").length,
      pmItems: items.filter((i) => i.category === "PM").length,
      locations: locations.length,
    });
  } catch (err) {
    next(err);
  }
});

availableStockRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const pagination = parsePagination(req);
    const view = req.query.view === "location" ? "location" : "item";
    const wantedLocations = new Set(many(req.query.location));
    const categories = many(req.query.category);
    const itemNames = many(req.query.item);
    const includeZero = req.query.includeZero === "true" && view === "item";

    const locations = await loadLocations(await scopeOf(req));
    const shown = locations.filter((l) => wantedLocations.size === 0 || wantedLocations.has(l.key));
    const balances = await loadBalances(locations);

    const items = await prisma.inventoryItem.findMany({
      where: {
        ...(includeZero ? {} : { id: { in: [...balances.keys()] } }),
        ...(categories.length ? { category: { in: categories as ("RM" | "PM")[] } } : {}),
        ...(itemNames.length ? { name: { in: itemNames } } : {}),
      },
      select: { id: true, name: true, code: true, category: true, unit: true },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });

    if (view === "item") {
      const scope = await scopeOf(req);
      const base = items
        .map((item) => {
          const own = balances.get(item.id);
          const byLocation: Record<string, number> = {};
          let total = 0;
          for (const loc of shown) {
            const qty = own?.get(loc.key) ?? 0;
            if (qty > 0) byLocation[loc.key] = qty;
            total += qty;
          }
          return { itemId: item.id, itemName: item.name, itemCode: item.code, category: item.category, unit: item.unit, total: round2(total), locations: byLocation };
        })
        .filter((r) => includeZero || r.total > EPS);

      // The receipt-based filters need every candidate's details; without them only the page's rows do.
      const expiryWindows = many(req.query.expiry).flatMap((l) => (EXPIRY_WINDOWS[l] ? [EXPIRY_WINDOWS[l]!] : []));
      const wantQuarantine = many(req.query.hasQuarantine);
      const wantOnOrder = many(req.query.hasOnOrder);
      const needsAll = expiryWindows.length > 0 || wantQuarantine.length > 0 || wantOnOrder.length > 0;
      const warehouseSide = scope === null;

      let rows = base;
      let details = needsAll ? await loadItemDetails(base.map((r) => r.itemId), warehouseSide) : null;
      if (details) {
        const d = details;
        const widest = Math.max(0, ...expiryWindows);
        rows = base.filter((r) => {
          const x = d.get(r.itemId) ?? EMPTY_DETAIL;
          return (
            (!expiryWindows.length || (x.expiresInDays !== null && x.expiresInDays <= widest)) &&
            (!wantQuarantine.length || wantQuarantine.includes(x.quarantineQty > EPS ? "Yes" : "No")) &&
            (!wantOnOrder.length || wantOnOrder.includes(x.onOrderQty > EPS ? "Yes" : "No"))
          );
        });
      }
      setPaginationHeaders(res, rows.length, pagination);
      const page = rows.slice(pagination.skip, pagination.skip + pagination.take);
      details = details ?? (await loadItemDetails(page.map((r) => r.itemId), warehouseSide));
      return res.json(page.map((r) => ({ ...r, detail: details!.get(r.itemId) ?? EMPTY_DETAIL })));
    }

    // One row per item x location
    const rows = items.flatMap((item) => {
      const own = balances.get(item.id);
      return shown.flatMap((loc) => {
        const qty = own?.get(loc.key) ?? 0;
        return qty > EPS ? [{ itemId: item.id, itemName: item.name, category: item.category, unit: item.unit, locationKey: loc.key, locationLabel: loc.label, quantity: qty }] : [];
      });
    });
    setPaginationHeaders(res, rows.length, pagination);
    res.json(rows.slice(pagination.skip, pagination.skip + pagination.take));
  } catch (err) {
    next(err);
  }
});

const isoDay = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

/**
 * GET /report?from=&to=&location=&category=&item=
 * The stock report for a period: per item, Opening (at the start of `from`), Received, Issued and Closing (at the end of `to`).
 * No location pick = the whole company (Received = deliveries from outside, Issued = material used up or sent out); picked locations =
 * those locations read as one group (Received / Issued = what crosses the group's edge, moves between them are not counted). See stock-report.ts.
 */
availableStockRouter.get("/report", async (req: AuthedRequest, res, next) => {
  try {
    const pagination = parsePagination(req);
    const from = isoDay(req.query.from);
    const to = isoDay(req.query.to);
    const wanted = new Set(many(req.query.location));
    const categories = many(req.query.category);
    const itemNames = many(req.query.item);

    const scope = await scopeOf(req);
    const locations = await loadLocations(scope);
    const shown = locations.filter((l) => wanted.size === 0 || wanted.has(l.key));
    const company = scope === null && wanted.size === 0;
    const movement = await loadStockMovement(shown.map((l) => ({ key: l.key, kind: l.kind })), from, to);

    const items = await prisma.inventoryItem.findMany({
      where: { id: { in: movement.map((m) => m.itemId) }, ...(categories.length ? { category: { in: categories as ("RM" | "PM")[] } } : {}), ...(itemNames.length ? { name: { in: itemNames } } : {}) },
      select: { id: true, name: true, code: true, category: true, unit: true },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
    const byId = new Map(movement.map((m) => [m.itemId, m]));
    const rows = items.map((i) => ({ ...byId.get(i.id)!, itemName: i.name, itemCode: i.code, category: i.category, unit: i.unit }));
    setPaginationHeaders(res, rows.length, pagination);
    res.setHeader("X-Report-Basis", company ? "company" : "locations");
    res.json(rows.slice(pagination.skip, pagination.skip + pagination.take));
  } catch (err) {
    next(err);
  }
});

/** GET /report/entries?itemId=&from=&to=&location= : every movement of one item in the period that touches the chosen locations (the row dropdown). */
availableStockRouter.get("/report/entries", async (req: AuthedRequest, res, next) => {
  try {
    const itemId = typeof req.query.itemId === "string" ? req.query.itemId : "";
    if (!itemId) return res.status(400).json({ error: "itemId is required" });
    const wanted = new Set(many(req.query.location));
    const locations = await loadLocations(await scopeOf(req));
    const shown = locations.filter((l) => wanted.size === 0 || wanted.has(l.key));
    const names = new Map(locations.map((l) => [l.key, l.label]));
    res.json(await loadItemEntries(shown.map((l) => ({ key: l.key, kind: l.kind })), names, itemId, isoDay(req.query.from), isoDay(req.query.to)));
  } catch (err) {
    next(err);
  }
});

// Item names for the filter dropdown (items that have stock somewhere), searched with ?q=.
availableStockRouter.get("/options", async (req: AuthedRequest, res, next) => {
  try {
    const q = parseSearch(req, "q")?.toLowerCase();
    const balances = await loadBalances(await loadLocations(await scopeOf(req)));
    const items = await prisma.inventoryItem.findMany({ where: { id: { in: [...balances.keys()] } }, select: { name: true }, orderBy: { name: "asc" } });
    const names = [...new Set(items.map((i) => i.name))];
    const matched = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
    res.json({ values: matched.slice(0, 100), hasMore: matched.length > 100 });
  } catch (err) {
    next(err);
  }
});

// Rates are pricing: only the roles that already see pricing elsewhere.
const canSeeRate = (req: AuthedRequest) => req.user!.roles.some((r) => r === "ADMIN" || r === "STORE" || r === "PURCHASE" || r === "ACCOUNTS");

const RECEIPT_STATUS_LABEL = { ACCEPTED: "Accepted", PENDING_QC: "Pending QC", TESTING: "Testing", ON_HOLD: "On Hold", QC_APPROVED: "QC Approved", QC_REJECTED: "QC Rejected" } as const;

/** The period a batch list is cut to (the stock report deliveries): receipt date from / to inclusive, and only what QC accepted (what Received counts). */
interface BatchPeriod {
  from?: string;
  to?: string;
  acceptedOnly?: boolean;
}

const periodOf = (src: Record<string, unknown>): BatchPeriod => ({ from: isoDay(src.from), to: isoDay(src.to), acceptedOnly: src.accepted === "1" || src.accepted === true });

async function loadBatches(itemIds: string[], canSeeRate: boolean, period: BatchPeriod = {}) {
  if (itemIds.length === 0) return [];
  const now = Date.now();
  const dateRange = { ...(period.from ? { gte: new Date(`${period.from}T00:00:00.000Z`) } : {}), ...(period.to ? { lte: new Date(`${period.to}T23:59:59.999Z`) } : {}) };
  const rows = await prisma.inventoryTransaction.findMany({
    where: { type: "RECEIVED", deletedAt: null, itemId: { in: itemIds }, ...(period.from || period.to ? { date: dateRange } : {}), ...(period.acceptedOnly ? { receiptStatus: "ACCEPTED" } : {}) },
    select: {
      id: true,
      itemId: true,
      date: true,
      unit: true,
      quantity: true,
      rejectedQty: true,
      batchNo: true,
      grnNo: true,
      mfgDate: true,
      expiryDate: true,
      expiryReleasedAt: true,
      vendorName: true,
      invoiceNo: true,
      rate: true,
      receiptStatus: true,
      item: { select: { name: true, category: true } },
    },
    orderBy: [{ date: "desc" }],
  });
  const expiredLeft = new Set((await getExpiredReceipts(itemIds)).map((e) => e.id));
  const out = rows.map((r) => {
    const expired = r.receiptStatus === "ACCEPTED" && expiredLeft.has(r.id);
    return {
      id: r.id,
      itemId: r.itemId,
      itemName: r.item.name,
      category: r.item.category,
      unit: r.unit,
      batchNo: r.batchNo,
      grnNo: r.grnNo,
      mfgDate: r.mfgDate,
      expiryDate: r.expiryDate,
      receivedOn: r.date,
      receivedQty: round2(r.quantity - (r.rejectedQty ?? 0)),
      vendorName: r.vendorName,
      invoiceNo: r.invoiceNo,
      rate: canSeeRate ? r.rate : null,
      status: expired ? "Lab Test" : r.receiptStatus ? RECEIPT_STATUS_LABEL[r.receiptStatus] : "—",
    };
  });
  // Soonest expiry first; no expiry date last.
  return out.sort((a, b) => (a.expiryDate?.getTime() ?? Infinity) - (b.expiryDate?.getTime() ?? Infinity) || b.receivedOn.getTime() - a.receivedOn.getTime());
}

/**
 * The receipts behind the items (batch no, GRN, mfg / expiry date, quantity received). A Day Store login sees the same batches,
 * minus the commercial side (vendor, invoice, rate) and only what QC accepted - the system keeps stock per item, so these describe
 * the batches that make up the stock, not how much of each reached this store.
 */
async function batchesFor(req: AuthedRequest, itemIds: string[], period: BatchPeriod) {
  const scoped = (await scopeOf(req)) !== null;
  const rows = await loadBatches(itemIds, !scoped && canSeeRate(req), scoped ? { ...period, acceptedOnly: true } : period);
  return scoped ? rows.map((r) => ({ ...r, vendorName: null, invoiceNo: null })) : rows;
}

// The receipts behind one item (the row's expand).
availableStockRouter.get("/batches", async (req: AuthedRequest, res, next) => {
  try {
    const itemId = typeof req.query.itemId === "string" ? req.query.itemId : "";
    if (!itemId) return res.status(400).json({ error: "itemId is required" });
    res.json(await batchesFor(req, [itemId], periodOf(req.query)));
  } catch (err) {
    next(err);
  }
});

// The receipts behind many items at once - the Excel report's batch sheet.
availableStockRouter.post("/batches/lookup", async (req: AuthedRequest, res, next) => {
  try {
    const ids = Array.isArray(req.body?.itemIds) ? (req.body.itemIds as unknown[]).filter((v): v is string => typeof v === "string").slice(0, 5000) : [];
    res.json(await batchesFor(req, ids, periodOf((req.body ?? {}) as Record<string, unknown>)));
  } catch (err) {
    next(err);
  }
});
