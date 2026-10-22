import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { parsePagination, parseSearch, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { getScopedDayStoreIds } from "./day-store-access";
import { getOnHandByDayStoreAndItem, getOnHandByItemId } from "./stock";
import { autoEscalateExtraAsks, requirementSelect, SUPPLY_LABEL, supplyOf } from "./material-requests.routes";
import { openQtyOf } from "./purchase-lines";

/**
 * Production requests for a Day Store's own Plant.
 *
 * A plan's material requests go to the Day Store of the Plant the product was planned at. That store approves them,
 * fills what it holds into its Plant, and - when it is short - asks the Warehouse for the rest ("Request from
 * Warehouse"), which lands in the Warehouse's urgent Material Request (Plan) list.
 *
 *   GET  /production-requests                           the list (?product ?po ?item ?status ?short)
 *   GET  /production-requests/options                   dropdown values
 *   POST /production-requests/:id/request-from-warehouse
 *
 * What a plan needs is approved from the start and goes on to the Plant at Dispensing (which closes these requests as it gives the material); the
 * normal request endpoints (/api/inventory/requests/:id/...) still allow a Day Store login to review / issue the production requests of its own Plant.
 */
export const myStoreProductionRouter = Router();
myStoreProductionRouter.use(requireAuth, requireRole("STORE", "PPIC"));

const scopeOf = (req: AuthedRequest) => getScopedDayStoreIds(req.user!.id, req.user!.roles);
const many = (raw: unknown): string[] => (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, 500);
const round2 = (n: number) => Math.round(n * 100) / 100;

const STATUS_LABEL = { PENDING: "Pending", APPROVED: "Approved", PARTIALLY_ISSUED: "Partly issued", ISSUED: "Issued", REJECTED: "Rejected" } as const;
const OPEN_STATUSES = ["PENDING", "APPROVED", "PARTIALLY_ISSUED"] as const;
const isOpen = (status: string) => (OPEN_STATUSES as readonly string[]).includes(status);

type TrailStage = "WITH_DAY_STORE" | "REQUESTED_FROM_WAREHOUSE" | "ISSUED_TO_DAY_STORE" | "ISSUED_TO_PLANT" | "CLOSED";
const TRAIL_LABEL: Record<TrailStage, string> = {
  WITH_DAY_STORE: "With Store",
  REQUESTED_FROM_WAREHOUSE: "Requested from Warehouse",
  ISSUED_TO_DAY_STORE: "Issued to Store",
  ISSUED_TO_PLANT: "Issued to Plant",
  CLOSED: "Closed",
};

// `scope`: the Day Stores a Day Store login is limited to. `opts.plantIds`: instead, the Plants a Production login covers (its own extra requests);
// `opts.extraOnly`: only Production's extra-material requests.
export async function loadProductionRequests(scope: string[] | null, opts: { plantIds?: string[] | null; extraOnly?: boolean } = {}) {
  const plantFilter = opts.plantIds !== undefined ? { id: opts.plantIds ? { in: opts.plantIds } : undefined, dayStoreId: { not: null } } : scope ? { dayStoreId: { in: scope } } : { dayStoreId: { not: null } };
  const requests = await prisma.inventoryRequest.findMany({
    where: { deletedAt: null, purpose: "ISSUED_PRODUCTION", ...(opts.extraOnly ? { isExtra: true } : {}), plant: plantFilter },
    select: {
      id: true,
      createdAt: true,
      itemId: true,
      category: true,
      requestedQty: true,
      neededBy: true,
      note: true,
      status: true,
      isExtra: true,
      extraForPoItemId: true,
      newMaterial: true,
      productionBatchId: true,
      purchaseOrderItemId: true,
      preProduction: { select: { purchaseOrderItemId: true } },
      item: { select: { name: true, unit: true } },
      plant: { select: { name: true, dayStoreId: true } },
      requestedBy: { select: { fullName: true } },
      fulfillments: { where: { deletedAt: null }, select: { id: true, quantity: true, isTransitTracked: true, deliveredAt: true, grnNo: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  if (requests.length === 0) return [];

  const poItemIds = [...new Set(requests.map((r) => r.purchaseOrderItemId ?? r.preProduction?.purchaseOrderItemId).filter((id): id is string => !!id))];
  const [poItems, linked] = await Promise.all([
    poItemIds.length ? prisma.purchaseOrderItem.findMany({ where: { id: { in: poItemIds } }, select: { id: true, productName: true, purchaseOrder: { select: { poNumber: true } } } }) : [],
    prisma.inventoryRequest.findMany({
      where: { deletedAt: null, forRequestId: { in: requests.map((r) => r.id) } },
      select: { id: true, forRequestId: true, status: true, requestedQty: true, fulfillments: { where: { deletedAt: null }, select: { quantity: true } } },
    }),
  ]);
  const poById = new Map(poItems.map((p) => [p.id, p]));
  // Extra material: the product it was raised for (a note only), and where its purchase need stands (Warehouse short -> PPIC -> Purchase -> PI).
  const refIds = [...new Set(requests.map((r) => r.extraForPoItemId).filter((id): id is string => !!id))];
  const refProducts = new Map((refIds.length ? await prisma.purchaseOrderItem.findMany({ where: { id: { in: refIds } }, select: { id: true, productName: true, purchaseOrder: { select: { poNumber: true } } } }) : []).map((p) => [p.id, p]));
  // The batch an extra request is for (so its material can be traced to it).
  const batchIds = [...new Set(requests.map((r) => r.productionBatchId).filter((id): id is string => !!id))];
  const batchNos = new Map((batchIds.length ? await prisma.productionBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, batchNo: true } }) : []).map((b) => [b.id, b.batchNo]));
  const askIdsOf = new Map<string, string[]>();
  for (const l of linked) askIdsOf.set(l.forRequestId!, [...(askIdsOf.get(l.forRequestId!) ?? []), l.id]);
  const allAskIds = linked.map((l) => l.id);
  const askRequirements = allAskIds.length ? await prisma.preInventoryRequirement.findMany({ where: { deletedAt: null, sourceRequestId: { in: allAskIds } }, select: requirementSelect }) : [];
  const requirementByAsk = new Map(askRequirements.map((r) => [r.sourceRequestId!, r]));

  // What Purchase is doing about a short material (the earliest ETA among the PI lines still to arrive) and what the Warehouse holds now.
  const requestItemIds = [...new Set(requests.map((r) => r.itemId))];
  const [warehouseStock, purchaseReqs] = await Promise.all([
    getOnHandByItemId(requestItemIds),
    poItemIds.length
      ? prisma.preInventoryRequirement.findMany({
          where: { sourcePoItemId: { in: poItemIds }, itemId: { in: requestItemIds }, deletedAt: null },
          select: { sourcePoItemId: true, itemId: true, purchaseLines: { select: { quantity: true, receivedQty: true, status: true, eta: true } } },
        })
      : [],
  ]);
  const purchaseBy = new Map(purchaseReqs.map((p) => [`${p.sourcePoItemId}::${p.itemId}`, p]));
  const linkedBy = new Map<string, typeof linked>();
  for (const l of linked) linkedBy.set(l.forRequestId!, [...(linkedBy.get(l.forRequestId!) ?? []), l]);

  // This store's own shelf, per (store, item).
  const stockKey = (storeId: string, itemId: string) => `${storeId}::${itemId}`;
  const stock = new Map<string, number>();
  const storeIds = [...new Set(requests.map((r) => r.plant?.dayStoreId).filter((id): id is string => !!id))];
  await Promise.all(
    storeIds.map(async (storeId) => {
      const itemIds = [...new Set(requests.filter((r) => r.plant?.dayStoreId === storeId).map((r) => r.itemId))];
      const balances = await getOnHandByDayStoreAndItem(storeId, itemIds);
      for (const id of itemIds) stock.set(stockKey(storeId, id), round2(Math.max(0, balances.get(id)?.onHand ?? 0)));
    }),
  );
  const storeNames = new Map((await prisma.dayStore.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));

  // The shelf is one pile: it covers the open requests for the same material one after the other (earliest needed first, then oldest),
  // so two plans that need the same material never both count the whole pile as theirs.
  const piles = new Map<string, typeof requests>();
  for (const r of requests) {
    const sid = r.plant?.dayStoreId;
    if (sid && isOpen(r.status)) piles.set(stockKey(sid, r.itemId), [...(piles.get(stockKey(sid, r.itemId)) ?? []), r]);
  }
  const shelfShare = new Map<string, number>();
  for (const [key, list] of piles) {
    let left = stock.get(key) ?? 0;
    const inOrder = [...list].sort((a, b) => (a.neededBy?.getTime() ?? 8.64e15) - (b.neededBy?.getTime() ?? 8.64e15) || a.createdAt.getTime() - b.createdAt.getTime());
    for (const r of inOrder) {
      const owed = Math.max(0, r.requestedQty - r.fulfillments.reduce((s, f) => s + f.quantity, 0));
      const take = round2(Math.min(left, owed));
      shelfShare.set(r.id, take);
      left = round2(left - take);
    }
  }

  const startOfToday = new Date(new Date().toDateString()).getTime();
  return requests.map((r) => {
    const storeId = r.plant?.dayStoreId ?? null;
    const issuedQty = round2(r.fulfillments.reduce((s, f) => s + f.quantity, 0));
    const remainingQty = round2(Math.max(0, r.requestedQty - issuedQty));
    const open = isOpen(r.status);
    const onShelf = shelfShare.get(r.id) ?? 0; // this request's share of the shelf (see above)
    const asks = linkedBy.get(r.id) ?? [];
    const askOpen = asks.filter((a) => isOpen(a.status));
    const askedQty = round2(askOpen.reduce((s, a) => s + Math.max(0, a.requestedQty - a.fulfillments.reduce((x, f) => x + f.quantity, 0)), 0));
    const poItem = poById.get(r.purchaseOrderItemId ?? r.preProduction?.purchaseOrderItemId ?? "");
    const extraSupply = r.isExtra ? supplyOf((askIdsOf.get(r.id) ?? []).map((id) => requirementByAsk.get(id)).find((x) => !!x)) : null;
    const purchase = poItem ? purchaseBy.get(`${poItem.id}::${r.itemId}`) : undefined;
    const openLines = (purchase?.purchaseLines ?? []).filter((l) => openQtyOf(l) > 1e-6);
    const planEta = openLines.length ? new Date(Math.min(...openLines.map((l) => l.eta.getTime()))) : null;
    const planState: "ON_ORDER" | "NOT_ORDERED" | null = !purchase ? null : openLines.length ? "ON_ORDER" : "NOT_ORDERED";
    // An extra request follows its own escalation: PPIC -> Purchase -> on order (with the ETA).
    const purchaseEta = extraSupply ? (extraSupply.eta ? new Date(extraSupply.eta) : null) : planEta;
    const purchaseState: "ON_ORDER" | "NOT_ORDERED" | null = extraSupply ? (extraSupply.stage === "ON_ORDER" ? "ON_ORDER" : extraSupply.stage === "WITH_PPIC" || extraSupply.stage === "WITH_PURCHASE" ? "NOT_ORDERED" : null) : planState;
    // How much the store still has to ask the Warehouse for: what is owed, less what is on its shelf and what is already asked.
    const toAsk = open ? round2(Math.max(0, remainingQty - onShelf - askedQty)) : 0;
    let stage: TrailStage = "WITH_DAY_STORE";
    if (!open) stage = r.status === "ISSUED" ? "ISSUED_TO_PLANT" : "CLOSED";
    else if (askOpen.length) stage = "REQUESTED_FROM_WAREHOUSE";
    else if (asks.length && onShelf > 0) stage = "ISSUED_TO_DAY_STORE";
    return {
      id: r.id,
      requestedAt: r.createdAt.toISOString(),
      itemName: r.item.name,
      category: r.category,
      unit: r.item.unit ?? "",
      requestedQty: r.requestedQty,
      issuedQty,
      remainingQty,
      neededBy: r.neededBy?.toISOString() ?? null,
      overdue: open && !!r.neededBy && r.neededBy.getTime() < startOfToday,
      statusKey: r.status,
      status: STATUS_LABEL[r.status as keyof typeof STATUS_LABEL] ?? r.status,
      open,
      purchaseOrderItemId: poItem?.id ?? null,
      productName: poItem?.productName ?? null,
      poNumber: poItem?.purchaseOrder.poNumber ?? null,
      plantName: r.plant?.name ?? null,
      storeId,
      storeName: storeId ? (storeNames.get(storeId) ?? null) : null,
      requestedBy: r.requestedBy.fullName,
      storeStock: storeId ? (stock.get(stockKey(storeId, r.itemId)) ?? 0) : 0, // the whole pile on the shelf
      storeShare: onShelf, // the part of it that covers this request
      warehouseStock: round2(Math.max(0, warehouseStock.get(r.itemId) ?? 0)),
      purchaseState,
      isExtra: r.isExtra,
      // A card title for requests that belong to no product.
      bundleTitle: r.isExtra ? `Extra material${r.extraForPoItemId && refProducts.get(r.extraForPoItemId) ? ` - for ${refProducts.get(r.extraForPoItemId)!.productName}` : ""}${r.productionBatchId && batchNos.get(r.productionBatchId) ? `, batch ${batchNos.get(r.productionBatchId)}` : ""}` : null,
      newMaterial: r.newMaterial,
      // What the Store has sent for it that Production has not received yet (extra material dispensed for a batch is on its way until then)
      onItsWay: r.fulfillments.filter((f) => f.isTransitTracked && !f.deliveredAt).map((f) => ({ id: f.id, quantity: f.quantity, grnNo: f.grnNo })),
      grnNos: [...new Set(r.fulfillments.map((f) => f.grnNo).filter((g): g is string => !!g))],
      batchId: r.productionBatchId,
      batchNo: r.productionBatchId ? (batchNos.get(r.productionBatchId) ?? null) : null,
      supplyStage: extraSupply?.stage ?? null,
      supplyLabel: extraSupply ? SUPPLY_LABEL[extraSupply.stage] : null,
      refProduct: r.extraForPoItemId ? (refProducts.get(r.extraForPoItemId)?.productName ?? null) : null,
      refPoNumber: r.extraForPoItemId ? (refProducts.get(r.extraForPoItemId)?.purchaseOrder.poNumber ?? null) : null,
      purchaseEta: purchaseEta ? purchaseEta.toISOString() : null,
      purchaseEtaLate: !!purchaseEta && purchaseEta.getTime() < startOfToday,
      short: open && remainingQty - onShelf > 1e-6,
      askedFromWarehouse: askedQty,
      toAsk,
      stage,
      stageLabel: TRAIL_LABEL[stage],
      note: r.note,
    };
  });
}

type ProductionRow = Awaited<ReturnType<typeof loadProductionRequests>>[number];

myStoreProductionRouter.get("/production-requests", async (req: AuthedRequest, res, next) => {
  try {
    const pagination = parsePagination(req);
    const q = req.query;
    const set = (key: string) => new Set(many(q[key]));
    const [products, pos, itemNames, statuses, shortOnly] = [set("product"), set("po"), set("item"), set("status"), many(q.short)];
    const rows = (await loadProductionRequests(await scopeOf(req)))
      .filter(
        (r) =>
          (!products.size || products.has(r.productName ?? "")) &&
          (!pos.size || pos.has(r.poNumber ?? "")) &&
          (!itemNames.size || itemNames.has(r.itemName)) &&
          (!statuses.size || statuses.has(r.status)) &&
          (!shortOnly.length || shortOnly.includes(r.short ? "Yes" : "No")),
      )
      // Open first; late ones first, then the soonest needed-by.
      .sort((a, b) => Number(b.open) - Number(a.open) || Number(b.overdue) - Number(a.overdue) || (a.neededBy ?? "9").localeCompare(b.neededBy ?? "9") || b.requestedAt.localeCompare(a.requestedAt));
    setPaginationHeaders(res, rows.length, pagination);
    res.json(rows.slice(pagination.skip, pagination.skip + pagination.take));
  } catch (err) {
    next(err);
  }
});

myStoreProductionRouter.get("/production-requests/options", async (req: AuthedRequest, res, next) => {
  try {
    const field = String(req.query.field ?? "");
    const needle = parseSearch(req, "q")?.toLowerCase();
    const pick: Record<string, (r: ProductionRow) => string | null> = { product: (r) => r.productName, po: (r) => r.poNumber, item: (r) => r.itemName };
    const get = pick[field];
    if (!get) return res.status(400).json({ error: "Unknown filter field" });
    const values = [...new Set((await loadProductionRequests(await scopeOf(req))).map(get).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b)).filter((v) => !needle || v.toLowerCase().includes(needle));
    res.json({ values: values.slice(0, 100), hasMore: values.length > 100 });
  } catch (err) {
    next(err);
  }
});

// The store is short for this production request: ask the Warehouse for the rest (an urgent, plan-driven request).
myStoreProductionRouter.post("/production-requests/:id/request-from-warehouse", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const row = (await loadProductionRequests(await scopeOf(req))).find((r) => r.id === req.params.id);
    if (!row || !row.storeId) return res.status(404).json({ error: "Production request not found for your store" });
    if (!row.open) return res.status(409).json({ error: "This request is already closed." });
    if (row.askedFromWarehouse > 0) return res.status(409).json({ error: "You have already asked the Warehouse for this." });
    if (row.toAsk <= 1e-6) return res.status(409).json({ error: "Your store has enough of this: it goes on to the Plant at Dispensing." });

    const source = await prisma.inventoryRequest.findUniqueOrThrow({
      where: { id: row.id },
      select: { itemId: true, category: true, neededBy: true, purchaseOrderItemId: true, preProduction: { select: { purchaseOrderItemId: true } } },
    });
    const created = await prisma.inventoryRequest.create({
      data: {
        itemId: source.itemId,
        category: source.category,
        requestedQty: row.toAsk,
        purpose: "ISSUED_DAY_STORE",
        neededBy: source.neededBy,
        note: `For Production request${row.productName ? ` - ${row.productName}` : ""}${row.poNumber ? ` (${row.poNumber})` : ""}`,
        requestedById: req.user!.id,
        requestingDayStoreId: row.storeId,
        forRequestId: row.id,
        purchaseOrderItemId: source.purchaseOrderItemId ?? source.preProduction?.purchaseOrderItemId ?? null,
      },
    });
    await recordAudit({ actorId: req.user!.id, action: "inventory_request.created", entityType: "InventoryRequest", entityId: created.id, metadata: { forRequestId: row.id, requestedQty: row.toAsk, dayStoreId: row.storeId } });
    // Extra material the Warehouse cannot cover goes to PPIC right away.
    await autoEscalateExtraAsks().catch((err) => req.log?.error({ err }, "autoEscalateExtraAsks failed"));
    await notifyRoles(["STORE"], { title: `URGENT (plan): ${row.storeName} needs ${row.itemName}`, body: `${row.toAsk} ${row.unit}${row.productName ? ` for ${row.productName}` : ""}`, link: "/material-requests-plan" }, req.user!.id).catch(() => {});
    res.status(201).json({ id: created.id, requestedQty: row.toAsk });
  } catch (err) {
    next(err);
  }
});
