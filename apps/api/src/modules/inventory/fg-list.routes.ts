import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { parsePagination, parseSearch, setPaginationHeaders } from "../../common/lib/pagination";
import { requireWarehouseSeat } from "./day-store-access";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { fgBatchWhere, receivedFgSelect, warehouseFgOf } from "./fg-stock";
import { agingRanges, inAnyRange, inRange, type TileFilters } from "../ppic/ppic-filters";

/**
 * The Finished Goods list (Store dashboard tile) - paged and filterable, one row per batch / lot
 * with stock on hand. Same stock rule as GET /inventory/fg-stock: a batch counts once it has
 * reached the FG Store (or any later stage) and has quantity left after what Dispatch has shipped.
 *
 *   GET /           ?po ?product ?customer ?plant ?batch (multi), ?dateFrom/?dateTo (FG Store date), ?aging
 *   GET /options    dropdown values for those filters
 *
 * Aging = whole days since it reached the FG Store (a legacy lot: since its packaging ended).
 */
export const fgListRouter = Router();
fgListRouter.use(requireAuth, requireRole("STORE", "PPIC", "ACCOUNTS", "PURCHASE", "DISPATCH"), requireWarehouseSeat);

const FG_ARRIVED_STAGES = ["FG_STORE", "FG_QC_RELEASE", "BILLING_EWAY_BILL", "DISPATCH_PLAN"] as const;
const EPS = 1e-6;
const round = (n: number) => Math.round(n * 1000) / 1000;
const many = (raw: unknown): string[] => (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, 500);
const isoDay = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

const itemSelect = {
  productName: true,
  unit: true,
  purchaseOrder: { select: { poNumber: true, customer: { select: { companyName: true } } } },
} satisfies Prisma.PurchaseOrderItemSelect;
const runSelect = { plant: { select: { name: true } }, purchaseOrderItem: { select: itemSelect } } satisfies Prisma.PreProductionSelect;

interface FgRow {
  id: string;
  kind: "BATCH" | "COMBINED_LOT";
  poNumber: string | null;
  productName: string;
  customerName: string;
  plantName: string | null;
  label: string;
  unit: string;
  producedQty: number;
  dispatchedQty: number;
  onHandQty: number;
  fgStoreDate: Date | null;
}

async function loadRows(): Promise<FgRow[]> {
  const [batches, lots] = await Promise.all([
    prisma.productionBatch.findMany({
      where: fgBatchWhere,
      select: { id: true, batchNo: true, currentStageId: true, outputQty: true, packApprovedQty: true, dispatchedQty: true, fgStoreReceivedDate: true, fgShipments: receivedFgSelect, preProduction: { select: runSelect } },
    }),
    prisma.combinedLot.findMany({
      where: { currentStageId: { in: [...FG_ARRIVED_STAGES] } },
      select: { id: true, packApprovedQty: true, dispatchedQty: true, packagingEndDate: true, preProduction: { select: runSelect } },
    }),
  ]);
  const rows: FgRow[] = [];
  for (const b of batches) {
    const item = b.preProduction.purchaseOrderItem;
    const fg = warehouseFgOf(b);
    rows.push({
      id: b.id,
      kind: "BATCH",
      poNumber: item.purchaseOrder.poNumber,
      productName: item.productName,
      customerName: item.purchaseOrder.customer.companyName,
      plantName: b.preProduction.plant?.name ?? null,
      label: b.batchNo ?? `Batch ${b.id.slice(0, 8)}`,
      unit: item.unit,
      producedQty: round(fg.produced),
      dispatchedQty: round(fg.dispatched),
      onHandQty: round(fg.onHand),
      fgStoreDate: b.fgStoreReceivedDate,
    });
  }
  for (const l of lots) {
    const item = l.preProduction.purchaseOrderItem;
    const produced = l.packApprovedQty ?? 0;
    rows.push({
      id: l.id,
      kind: "COMBINED_LOT",
      poNumber: item.purchaseOrder.poNumber,
      productName: item.productName,
      customerName: item.purchaseOrder.customer.companyName,
      plantName: l.preProduction.plant?.name ?? null,
      label: `Lot ${l.id.slice(0, 8)}`,
      unit: item.unit,
      producedQty: round(produced),
      dispatchedQty: round(l.dispatchedQty ?? 0),
      onHandQty: round(produced - (l.dispatchedQty ?? 0)),
      fgStoreDate: l.packagingEndDate,
    });
  }
  // A batch Dispatch has an open request on (waiting for the Warehouse, or sent and not yet confirmed) stays in the list even with nothing left on the shelf
  const open = await prisma.fgShipment.findMany({ where: { type: "FROM_WAREHOUSE", status: { in: ["REQUESTED", "SENT"] }, deletedAt: null }, select: { productionBatchId: true } });
  const withOpenRequest = new Set(open.map((o) => o.productionBatchId));
  return rows.filter((r) => r.onHandQty > EPS || (r.kind === "BATCH" && withOpenRequest.has(r.id)));
}

fgListRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const pagination = parsePagination(req);
    const q = req.query;
    const pick = (key: string) => new Set(many(q[key]));
    const [pos, products, customers, plants, batches] = [pick("po"), pick("product"), pick("customer"), pick("plant"), pick("batch")];
    const from = isoDay(q.dateFrom);
    const to = isoDay(q.dateTo);
    const dates = from || to ? { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}) } : undefined;
    const aging = agingRanges({ aging: many(q.aging) } as TileFilters);

    const rows = (await loadRows())
      .filter(
        (r) =>
          (!pos.size || pos.has(r.poNumber ?? "")) &&
          (!products.size || products.has(r.productName)) &&
          (!customers.size || customers.has(r.customerName)) &&
          (!plants.size || plants.has(r.plantName ?? "")) &&
          (!batches.size || batches.has(r.label)) &&
          inRange(r.fgStoreDate?.toISOString(), dates) &&
          inAnyRange(r.fgStoreDate?.toISOString(), aging),
      )
      // Newest into the FG Store first; rows with no date last.
      .sort((a, b) => (b.fgStoreDate?.getTime() ?? 0) - (a.fgStoreDate?.getTime() ?? 0) || a.productName.localeCompare(b.productName));

    setPaginationHeaders(res, rows.length, pagination);
    res.json(rows.slice(pagination.skip, pagination.skip + pagination.take));
  } catch (err) {
    next(err);
  }
});

// Distinct values for a filter among the FG rows, searched with ?q= (first 100).
fgListRouter.get("/options", async (req: AuthedRequest, res, next) => {
  try {
    const field = String(req.query.field ?? "");
    const pickValue: Record<string, (r: FgRow) => string | null> = {
      po: (r) => r.poNumber,
      product: (r) => r.productName,
      customer: (r) => r.customerName,
      plant: (r) => r.plantName,
      batch: (r) => r.label,
    };
    const get = pickValue[field];
    if (!get) return res.status(400).json({ error: "Unknown filter field" });
    const needle = parseSearch(req, "q")?.toLowerCase();
    const values = [...new Set((await loadRows()).map(get).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b)).filter((v) => !needle || v.toLowerCase().includes(needle));
    res.json({ values: values.slice(0, 100), hasMore: values.length > 100 });
  } catch (err) {
    next(err);
  }
});
