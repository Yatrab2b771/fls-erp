import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { getDayStoreLots, getPlantLots, getWarehouseLots, lotSelect, type LotBalance } from "./lots";

/**
 * Lots & traceability - read-only views over the lot allocations (see lots.ts).
 *
 *   GET /item/:itemId           one item: every lot, how much of it is left in the Warehouse, and which Day Stores / Plants hold some
 *   GET /expiring               lots that have expired or will within ?days= (default 60) and still have material, at ANY place
 *   GET /search?q=              find a delivery by GRN, batch no, invoice, vendor or item - the starting point of a recall
 *   GET /trace/lot/:receiptId   forwards: where did this delivery go (Day Stores, R&D, which production batches)
 *   GET /trace/batch/:batchId   backwards: which deliveries (supplier, GRN, lot, expiry) went into this production batch
 *   GET /missing-expiry         accepted deliveries with no expiry date (they can never expire, so they are never caught)
 */
export const lotsRouter = Router();
lotsRouter.use(requireAuth, requireRole("STORE", "QA_QC", "RND", "PPIC", "ACCOUNTS", "PRODUCTION"));

const DAY_MS = 86_400_000;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const EXPIRING_SOON_DAYS = 30;

type LotRow = Prisma.InventoryTransactionGetPayload<{ select: typeof lotSelect }>;

function lotView(r: LotRow, remaining?: number) {
  const now = Date.now();
  const daysToExpiry = r.expiryDate ? Math.floor((r.expiryDate.getTime() - now) / DAY_MS) : null;
  const expired = daysToExpiry !== null && r.expiryDate!.getTime() < now && !r.expiryReleasedAt;
  return {
    receiptId: r.id,
    itemId: r.itemId,
    itemName: r.item.name,
    category: r.item.category,
    unit: r.unit,
    vendorName: r.vendorName,
    grnNo: r.grnNo,
    batchNo: r.batchNo,
    invoiceNo: r.invoiceNo,
    receivedOn: r.date,
    mfgDate: r.mfgDate,
    expiryDate: r.expiryDate,
    daysToExpiry,
    receivedQty: round3(r.quantity - (r.rejectedQty ?? 0)),
    ...(remaining !== undefined ? { remaining: round3(remaining) } : {}),
    status: expired ? "EXPIRED" : r.expiryReleasedAt && r.expiryDate && r.expiryDate.getTime() < now ? "RELEASED" : daysToExpiry === null ? "NO_EXPIRY" : daysToExpiry <= EXPIRING_SOON_DAYS ? "EXPIRING" : "OK",
  };
}

async function lotRows(ids: string[]) {
  const rows = await prisma.inventoryTransaction.findMany({ where: { id: { in: ids } }, select: lotSelect });
  return new Map(rows.map((r) => [r.id, r]));
}

lotsRouter.get("/item/:itemId", async (req: AuthedRequest<{ itemId: string }>, res, next) => {
  try {
    const item = await prisma.inventoryItem.findUnique({ where: { id: req.params.itemId }, select: { id: true, name: true, unit: true } });
    if (!item) return res.status(404).json({ error: "Item not found" });
    const [warehouse, dayStores, plants] = await Promise.all([getWarehouseLots(prisma, item.id), prisma.dayStore.findMany({ select: { id: true, name: true } }), prisma.plant.findMany({ select: { id: true, name: true } })]);
    const [dayStoreLots, plantLots] = await Promise.all([
      Promise.all(dayStores.map(async (d) => ({ place: d.name, kind: "DAY_STORE" as const, lots: await getDayStoreLots(prisma, d.id, item.id) }))),
      Promise.all(plants.map(async (p) => ({ place: p.name, kind: "PLANT" as const, lots: await getPlantLots(prisma, p.id, item.id) }))),
    ]);
    const places = [...dayStoreLots, ...plantLots].filter((p) => p.lots.length > 0);
    const rows = await lotRows([...new Set([...warehouse.map((l) => l.receiptId), ...places.flatMap((p) => p.lots.map((l) => l.receiptId))])]);
    const view = (l: LotBalance) => {
      const r = rows.get(l.receiptId);
      return r ? lotView(r, l.remaining) : null;
    };
    res.json({
      item,
      warehouse: warehouse.map(view).filter((x): x is NonNullable<typeof x> => !!x),
      places: places.map((p) => ({ place: p.place, kind: p.kind, lots: p.lots.map(view).filter((x): x is NonNullable<typeof x> => !!x) })),
    });
  } catch (err) {
    next(err);
  }
});

lotsRouter.get("/expiring", async (req: AuthedRequest, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 60));
    const cutoff = new Date(Date.now() + days * DAY_MS);
    // Items that have at least one accepted delivery expiring by then - only those can have an expiring lot anywhere.
    const candidates = await prisma.inventoryTransaction.findMany({
      where: { type: "RECEIVED", receiptStatus: "ACCEPTED", deletedAt: null, expiryDate: { not: null, lte: cutoff }, expiryReleasedAt: null },
      select: { itemId: true },
      distinct: ["itemId"],
      take: 300,
    });
    const itemIds = candidates.map((c) => c.itemId);
    if (itemIds.length === 0) return res.json([]);
    const [dayStores, plants] = await Promise.all([prisma.dayStore.findMany({ select: { id: true, name: true } }), prisma.plant.findMany({ select: { id: true, name: true } })]);

    const found: { place: string; lot: LotBalance }[] = [];
    for (const itemId of itemIds) {
      const [wh, ds, pl] = await Promise.all([getWarehouseLots(prisma, itemId), Promise.all(dayStores.map((d) => getDayStoreLots(prisma, d.id, itemId))), Promise.all(plants.map((p) => getPlantLots(prisma, p.id, itemId)))]);
      const add = (place: string, lots: LotBalance[]) => {
        for (const lot of lots) if (lot.remaining > 1e-9 && lot.expiryDate && lot.expiryDate.getTime() <= cutoff.getTime()) found.push({ place, lot });
      };
      add("Warehouse", wh);
      ds.forEach((lots, i) => add(`Store: ${dayStores[i]!.name}`, lots));
      pl.forEach((lots, i) => add(`Plant: ${plants[i]!.name}`, lots));
    }
    const rows = await lotRows([...new Set(found.map((f) => f.lot.receiptId))]);
    res.json(
      found
        .flatMap((f) => {
          const r = rows.get(f.lot.receiptId);
          return r ? [{ place: f.place, ...lotView(r, f.lot.remaining) }] : [];
        })
        .sort((a, b) => (a.daysToExpiry ?? 0) - (b.daysToExpiry ?? 0)),
    );
  } catch (err) {
    next(err);
  }
});

lotsRouter.get("/search", async (req: AuthedRequest, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2) return res.json([]);
    const contains = { contains: q, mode: "insensitive" as const };
    const rows = await prisma.inventoryTransaction.findMany({
      where: { type: "RECEIVED", deletedAt: null, receiptStatus: { in: ["ACCEPTED", "QC_APPROVED"] }, OR: [{ grnNo: contains }, { batchNo: contains }, { invoiceNo: contains }, { vendorName: contains }, { item: { name: contains } }] },
      select: lotSelect,
      orderBy: { date: "desc" },
      take: 50,
    });
    res.json(rows.map((r) => lotView(r)));
  } catch (err) {
    next(err);
  }
});

lotsRouter.get("/trace/lot/:receiptId", async (req: AuthedRequest<{ receiptId: string }>, res, next) => {
  try {
    const lot = await prisma.inventoryTransaction.findFirst({ where: { id: req.params.receiptId, type: "RECEIVED", deletedAt: null }, select: lotSelect });
    if (!lot) return res.status(404).json({ error: "Delivery not found" });
    const allocations = await prisma.lotAllocation.findMany({
      where: { receiptId: lot.id, OR: [{ issueTxn: { deletedAt: null } }, { dispensingLineId: { not: null } }] },
      include: {
        issueTxn: { select: { id: true, type: true, date: true, quantity: true, dayStore: { select: { name: true } }, plant: { select: { name: true } } } },
        dispensingLine: {
          select: {
            createdAt: true,
            productionBatch: { select: { id: true, batchNo: true, status: true, preProduction: { select: { purchaseOrderItem: { select: { productName: true, purchaseOrder: { select: { poNumber: true, customer: { select: { companyName: true } } } } } } } } } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    const movements = allocations.map((a) => {
      if (a.dispensingLine) {
        const b = a.dispensingLine.productionBatch;
        const po = b.preProduction.purchaseOrderItem;
        return { kind: "BATCH" as const, at: a.dispensingLine.createdAt, quantity: round3(a.quantity), to: `Batch ${b.batchNo ?? "(no number yet)"}`, batchId: b.id, batchNo: b.batchNo, productName: po.productName, poNumber: po.purchaseOrder.poNumber, customerName: po.purchaseOrder.customer.companyName };
      }
      const t = a.issueTxn!;
      const to = t.type === "ISSUED_DAY_STORE" ? `Store: ${t.dayStore?.name ?? "—"}` : t.type === "ISSUED_RND" ? "R&D Store" : `Plant: ${t.plant?.name ?? "—"}`;
      const from = t.type === "ISSUED_PRODUCTION" ? `Store: ${t.dayStore?.name ?? "—"}` : "Warehouse";
      return { kind: t.type, at: t.date, quantity: round3(a.quantity), from, to };
    });
    res.json({ lot: lotView(lot), movements, unaccountedQty: round3(Math.max(0, lot.quantity - (lot.rejectedQty ?? 0) - allocations.filter((a) => a.issueTxn && a.issueTxn.type !== "ISSUED_PRODUCTION").reduce((s, a) => s + a.quantity, 0))) });
  } catch (err) {
    next(err);
  }
});

lotsRouter.get("/trace/batch/:batchId", async (req: AuthedRequest<{ batchId: string }>, res, next) => {
  try {
    const batch = await prisma.productionBatch.findUnique({
      where: { id: req.params.batchId },
      select: {
        id: true,
        batchNo: true,
        preProduction: { select: { purchaseOrderItem: { select: { productName: true, purchaseOrder: { select: { poNumber: true, customer: { select: { companyName: true } } } } } } } },
        dispensingLines: { where: { deliveryStatus: { not: "REFUSED" } }, select: { id: true, itemId: true, quantity: true, plannedQty: true, unit: true, lotsDrawn: { select: { receiptId: true, quantity: true } } } },
      },
    });
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    const lots = await lotRows([...new Set(batch.dispensingLines.flatMap((l) => l.lotsDrawn.map((a) => a.receiptId)))]);
    const items = new Map((await prisma.inventoryItem.findMany({ where: { id: { in: batch.dispensingLines.map((l) => l.itemId) } }, select: { id: true, name: true, category: true } })).map((i) => [i.id, i]));
    const po = batch.preProduction.purchaseOrderItem;
    res.json({
      batch: { id: batch.id, batchNo: batch.batchNo, productName: po.productName, poNumber: po.purchaseOrder.poNumber, customerName: po.purchaseOrder.customer.companyName },
      materials: batch.dispensingLines.map((l) => {
        const traced = l.lotsDrawn.reduce((s, a) => s + a.quantity, 0);
        return {
          itemId: l.itemId,
          itemName: items.get(l.itemId)?.name ?? "—",
          category: items.get(l.itemId)?.category ?? "RM",
          unit: l.unit,
          dispensedQty: round3(l.quantity),
          lotUnknownQty: round3(Math.max(0, l.quantity - traced)),
          lots: l.lotsDrawn.flatMap((a) => {
            const r = lots.get(a.receiptId);
            return r ? [{ ...lotView(r), usedQty: round3(a.quantity) }] : [];
          }),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

lotsRouter.get("/missing-expiry", async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await prisma.inventoryTransaction.findMany({
      where: { type: "RECEIVED", receiptStatus: "ACCEPTED", deletedAt: null, expiryDate: null, item: { category: "RM" } },
      select: lotSelect,
      orderBy: { date: "desc" },
      take: 200,
    });
    res.json(rows.map((r) => lotView(r)));
  } catch (err) {
    next(err);
  }
});
