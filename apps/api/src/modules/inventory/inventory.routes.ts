import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { RouteError } from "../../common/lib/route-error";
import { assertDayStoreAccess } from "./day-store-access";
import { getOnHandByDayStoreAndItem, getOnHandByItemId, getOnHandByPlantAndItem, notifyIfNewlyAvailable } from "./stock";
import { notifyIfPoNewlyReady } from "../po-readiness/po-readiness.routes";
import {
  createDispatchTransferSchema,
  createInventoryItemSchema,
  createInventoryRequestSchema,
  createInventoryTransactionSchema,
  dispatchConfirmSchema,
  importDispatchTransfersSchema,
  importInventoryRequestsSchema,
  importInventoryTransactionsSchema,
  inwardQcReviewSchema,
  invoiceSchema,
  issueInventoryRequestSchema,
  qcReviewSchema,
  reviewInventoryRequestSchema,
  updateInventoryItemSchema,
  type CreateDispatchTransferInput,
  type CreateInventoryItemInput,
  type CreateInventoryRequestInput,
  type CreateInventoryTransactionInput,
  type DispatchConfirmInput,
  type ImportDispatchTransfersInput,
  type ImportInventoryRequestsInput,
  type ImportInventoryTransactionsInput,
  type InwardQcReviewInput,
  type InvoiceInput,
  type IssueInventoryRequestInput,
  type QcReviewInput,
  type ReviewInventoryRequestInput,
  type UpdateInventoryItemInput,
} from "./inventory.schemas";
import type { DispatchQcStatus, DispatchTransferType, InventoryCategory, InventoryReceiptStatus, InventoryRequestStatus, Prisma } from "@prisma/client";

export const inventoryRouter = Router();

inventoryRouter.use(requireAuth);

// A notification failure is logged, never fatal — the write it's
// attached to already succeeded and that response shouldn't 500 over a
// notice. `req` is typed loosely here since every call site's own
// AuthedRequest<P> generic would otherwise have to match exactly.
function notifyFailed(req: AuthedRequest, label: string) {
  return (err: unknown) => req.log?.error({ err }, `notify failed: ${label}`);
}

// Unlike Order Tracking/BOM/RM Costing, this module is NOT open to every
// authenticated user by default. Store owns the Warehouse tool this
// ports, so the ledger (transactions, dispatch transfers) and item
// writes stay STORE/ADMIN-only, gated per-route below (no more router-
// level blanket gate) — because PPIC now needs narrow access of its own:
// read the catalog/stock to know what to request, and use the Material
// Requests endpoints, without seeing the received/issued log itself.

// --- Item catalog — "List from Sanjay & naveen. Option to add item" ---

inventoryRouter.get("/items", requireRole("STORE", "PPIC"), async (req, res, next) => {
  try {
    const category = req.query.category as InventoryCategory | undefined;
    const items = await prisma.inventoryItem.findMany({
      where: category ? { category } : undefined,
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
    res.json(items);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.post("/items", requireRole("STORE"), validateBody(createInventoryItemSchema), async (req: AuthedRequest, res, next) => {
  try {
    const data = req.body as CreateInventoryItemInput;

    const existing = await prisma.inventoryItem.findUnique({ where: { category_name: { category: data.category, name: data.name } } });
    if (existing) return res.status(409).json({ error: "An item with this name already exists in this category" });

    const item = await prisma.inventoryItem.create({ data });

    await recordAudit({ actorId: req.user!.id, action: "inventory_item.created", entityType: "InventoryItem", entityId: item.id });

    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.patch("/items/:id", requireRole("STORE"), validateBody(updateInventoryItemSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.inventoryItem.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Inventory item not found" });

    const data = req.body as UpdateInventoryItemInput;
    const updated = await prisma.inventoryItem.update({ where: { id: req.params.id }, data });

    await recordAudit({ actorId: req.user!.id, action: "inventory_item.updated", entityType: "InventoryItem", entityId: updated.id });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// --- Stock on hand — sum(RECEIVED) − sum(ISSUED_DAY_STORE) − sum(ISSUED_PRODUCTION) per item ---

inventoryRouter.get("/stock", requireRole("STORE", "PPIC"), async (req, res, next) => {
  try {
    const category = req.query.category as InventoryCategory | undefined;

    const [items, receivedTotals, issuedDayStoreTotals, issuedProductionTotals] = await Promise.all([
      prisma.inventoryItem.findMany({ where: category ? { category } : undefined, orderBy: [{ category: "asc" }, { name: "asc" }] }),
      // Only ACCEPTED counts — a delivery still sitting in QC, or one QC
      // rejected, hasn't actually become usable stock yet. rejectedQty
      // is summed alongside quantity so a partially-rejected delivery
      // only counts its actually-usable remainder (see qcReviewSchema).
      prisma.inventoryTransaction.groupBy({ by: ["itemId"], where: { type: "RECEIVED", receiptStatus: "ACCEPTED" }, _sum: { quantity: true, rejectedQty: true } }),
      prisma.inventoryTransaction.groupBy({ by: ["itemId"], where: { type: "ISSUED_DAY_STORE" }, _sum: { quantity: true } }),
      prisma.inventoryTransaction.groupBy({ by: ["itemId"], where: { type: "ISSUED_PRODUCTION" }, _sum: { quantity: true } }),
    ]);

    // Kept as one bulk breakdown (received/issued-day-store/
    // issued-production separately) for this full-ledger view, not
    // routed through getOnHandByItemId's collapsed onHand-only map —
    // that shared helper is for callers (like Pre-Inventory) that only
    // need the final number.
    const receivedGross = new Map(receivedTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
    const rejected = new Map(receivedTotals.map((r) => [r.itemId, r._sum.rejectedQty ?? 0]));
    const issuedDayStore = new Map(issuedDayStoreTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
    const issuedProduction = new Map(issuedProductionTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));

    const stock = items.map((item) => {
      const rejectedQty = rejected.get(item.id) ?? 0;
      // Net of any partial QC rejection — what actually became usable stock.
      const receivedQty = (receivedGross.get(item.id) ?? 0) - rejectedQty;
      const issuedDayStoreQty = issuedDayStore.get(item.id) ?? 0;
      const issuedProductionQty = issuedProduction.get(item.id) ?? 0;
      const issuedQty = issuedDayStoreQty + issuedProductionQty;
      return { item, receivedQty, rejectedQty, issuedDayStoreQty, issuedProductionQty, issuedQty, onHand: receivedQty - issuedQty };
    });

    res.json(stock);
  } catch (err) {
    next(err);
  }
});

// One item, split across every location that can hold it — the inverse
// view of dayStoresRouter's/plantsRouter's own "/:id/stock" (one
// location, every item). Same three functions from stock.ts, just
// called once per Day Store/Plant instead of once for the whole
// Warehouse ledger — cheap, since each call is scoped to this single
// itemId. Report #5: "pick an RM/PM, see Warehouse vs every Day Store
// vs every Plant side by side."
inventoryRouter.get("/items/:id/stock-by-location", requireRole("STORE", "PPIC"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const item = await prisma.inventoryItem.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: "Item not found" });

    const [dayStores, plants] = await Promise.all([prisma.dayStore.findMany({ orderBy: { name: "asc" } }), prisma.plant.findMany({ orderBy: { name: "asc" } })]);

    const [warehouseOnHand, dayStoreBalances, plantBalances] = await Promise.all([
      getOnHandByItemId([item.id]),
      Promise.all(dayStores.map((ds) => getOnHandByDayStoreAndItem(ds.id, [item.id]))),
      Promise.all(plants.map((p) => getOnHandByPlantAndItem(p.id, [item.id]))),
    ]);

    res.json({
      item,
      warehouse: warehouseOnHand.get(item.id) ?? 0,
      dayStores: dayStores.map((ds, i) => ({ id: ds.id, name: ds.name, ...(dayStoreBalances[i]!.get(item.id) ?? { receivedFromWarehouse: 0, issuedToProduction: 0, onHand: 0 }) })),
      plants: plants.map((p, i) => ({ id: p.id, name: p.name, onHand: plantBalances[i]!.get(item.id) ?? 0 })),
    });
  } catch (err) {
    next(err);
  }
});

// --- Reference data for the vendor field — distinct vendor names already
// used on a Material Received entry, offered as a combobox so the form
// nudges toward reusing a known vendor without forbidding a new one. ---

// Purchase needs this list too — the Pre-Inventory "Log PO" form offers
// the same reuse-a-known-vendor nudge, and a vendor first named there
// (Pre-Inventory's PreInventoryRequirement.vendorName) should show up
// here just as much as one first named on a Material Received entry.
//
// ?itemId=... additionally suggests a single vendor: whoever most
// recently supplied *that* item, so Log PO can offer a one-click default
// instead of leaving Purchase to hunt through the full alphabetical list.
inventoryRouter.get("/vendors", requireRole("STORE", "PURCHASE"), async (req, res, next) => {
  try {
    const itemId = typeof req.query.itemId === "string" ? req.query.itemId : undefined;
    const [txnRows, requirementRows, lastTxn, lastRequirement] = await Promise.all([
      prisma.inventoryTransaction.findMany({ where: { vendorName: { not: null } }, distinct: ["vendorName"], select: { vendorName: true } }),
      prisma.preInventoryRequirement.findMany({ where: { vendorName: { not: null } }, distinct: ["vendorName"], select: { vendorName: true } }),
      itemId
        ? prisma.inventoryTransaction.findFirst({ where: { itemId, vendorName: { not: null } }, orderBy: { date: "desc" }, select: { vendorName: true, date: true } })
        : null,
      itemId
        ? prisma.preInventoryRequirement.findFirst({ where: { itemId, vendorName: { not: null } }, orderBy: { purchaseAt: "desc" }, select: { vendorName: true, purchaseAt: true } })
        : null,
    ]);
    const names = new Set([...txnRows, ...requirementRows].map((r) => r.vendorName).filter((v): v is string => !!v));

    // Whichever of the two is more recent wins the suggestion.
    let suggested: string | null = null;
    if (lastTxn || lastRequirement) {
      const txnAt = lastTxn?.date?.getTime() ?? -1;
      const reqAt = lastRequirement?.purchaseAt?.getTime() ?? -1;
      suggested = (txnAt >= reqAt ? lastTxn?.vendorName : lastRequirement?.vendorName) ?? null;
    }

    res.json({ vendors: [...names].sort((a, b) => a.localeCompare(b)), suggested });
  } catch (err) {
    next(err);
  }
});

// --- Transaction log — the three sheets ("MATERIAL RECEIVED" / "MATERIAL
// Issued to day store" / "MATERIAL Issued to Production"), told apart by
// `type`, on one endpoint ---

const txnInclude = {
  item: true,
  createdBy: { select: { id: true, employeeId: true, fullName: true } },
  qcCheckedBy: { select: { id: true, employeeId: true, fullName: true } },
  acceptedBy: { select: { id: true, employeeId: true, fullName: true } },
  dayStore: true,
  plant: true,
} satisfies Prisma.InventoryTransactionInclude;

// QA_QC needs to see the Received log (to know what's awaiting inward
// QC), not the rest of the ledger — the frontend scopes what it actually
// shows per role, same pattern as PPIC's narrower Inventory access above.
inventoryRouter.get("/transactions", requireRole("STORE", "QA_QC"), async (req, res, next) => {
  try {
    const { type, category, itemId, receiptStatus } = req.query as {
      type?: "RECEIVED" | "ISSUED_DAY_STORE" | "ISSUED_PRODUCTION";
      category?: InventoryCategory;
      itemId?: string;
      receiptStatus?: InventoryReceiptStatus;
    };
    const pagination = parsePagination(req);

    const where: Prisma.InventoryTransactionWhereInput = {
      ...(type ? { type } : {}),
      ...(itemId ? { itemId } : {}),
      ...(category ? { item: { category } } : {}),
      ...(receiptStatus ? { receiptStatus } : {}),
    };

    const [total, transactions] = await Promise.all([
      prisma.inventoryTransaction.count({ where }),
      prisma.inventoryTransaction.findMany({ where, include: txnInclude, orderBy: { date: "desc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(transactions);
  } catch (err) {
    next(err);
  }
});

// --- Bulk import — one Excel sheet's worth of Received/Issued rows at
// once, parsed client-side (apps/web's inventoryImport.ts) into the same
// shape as a single Log Entry. Items are resolved-or-created by
// (category, name), same as the "+ New" option on the manual form.
// ISSUED_PRODUCTION is excluded — see the same note on POST /transactions
// below; a spreadsheet row can't carry an approved Material Request. ---

inventoryRouter.post("/transactions/import", requireRole("STORE"), validateBody(importInventoryTransactionsSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { type, rows, isOpeningStock, dayStoreId } = req.body as ImportInventoryTransactionsInput;

    if (type === "ISSUED_PRODUCTION" && !req.user!.roles.includes("ADMIN")) {
      return res.status(400).json({ error: "Issued to Production entries must come from an approved Material Request — see the Material Requests tab." });
    }
    if (isOpeningStock && type !== "RECEIVED") {
      return res.status(400).json({ error: "Opening Stock only applies to Material Received rows." });
    }
    if (dayStoreId && type !== "ISSUED_DAY_STORE") {
      return res.status(400).json({ error: "Day Store only applies to Issued to Day Store rows." });
    }
    if (dayStoreId) {
      const dayStore = await prisma.dayStore.findUnique({ where: { id: dayStoreId } });
      if (!dayStore) return res.status(400).json({ error: "Unknown Day Store" });
    }

    // Resolve every distinct (category, name) pair to an item id up front,
    // creating any item this sheet mentions for the first time — one
    // upsert per unique item rather than per row.
    const uniqueItems = new Map<string, { category: "RM" | "PM"; name: string }>();
    for (const row of rows) uniqueItems.set(`${row.category}::${row.itemName}`, { category: row.category, name: row.itemName });

    const itemIds = new Map<string, string>();
    let itemsCreated = 0;
    for (const [key, { category, name }] of uniqueItems) {
      const existing = await prisma.inventoryItem.findUnique({ where: { category_name: { category, name } } });
      if (existing) {
        itemIds.set(key, existing.id);
      } else {
        const created = await prisma.inventoryItem.create({ data: { category, name } });
        itemIds.set(key, created.id);
        itemsCreated += 1;
      }
    }

    // Resolve every distinct per-row Day Store name to an id, creating
    // any that don't exist yet — same resolve-or-create pattern as
    // items above, same permission level (STORE) as the manual entry
    // form's own "+ New" Day Store option. Lets one sheet mix rows for
    // several stores (e.g. the app's downloaded report format, which has
    // a Day Store column per row) instead of requiring one sheet per store.
    const dayStoreIdByName = new Map<string, string>();
    let dayStoresCreated = 0;
    if (type === "ISSUED_DAY_STORE") {
      const uniqueNames = new Set(rows.map((r) => r.dayStoreName).filter((n): n is string => !!n));
      for (const name of uniqueNames) {
        const existing = await prisma.dayStore.findUnique({ where: { name } });
        if (existing) {
          dayStoreIdByName.set(name, existing.id);
        } else {
          const created = await prisma.dayStore.create({ data: { name, createdById: req.user!.id } });
          dayStoreIdByName.set(name, created.id);
          dayStoresCreated += 1;
        }
      }
    }

    // A Store user scoped to specific store(s) via DayStoreAssignment
    // can't bulk-import rows tagged to a store they don't manage —
    // check every distinct store this sheet actually touches (the
    // batch-level default and any per-row override), not just the one
    // picked in the toolbar.
    if (type === "ISSUED_DAY_STORE") {
      const usedDayStoreIds = new Set<string>();
      for (const row of rows) {
        const id = row.dayStoreName ? dayStoreIdByName.get(row.dayStoreName) : dayStoreId;
        if (id) usedDayStoreIds.add(id);
      }
      for (const id of usedDayStoreIds) await assertDayStoreAccess(req.user!.id, req.user!.roles, id);
    }

    const rowsData: Prisma.InventoryTransactionCreateManyInput[] = rows.map((row) => ({
      itemId: itemIds.get(`${row.category}::${row.itemName}`)!,
      type,
      date: row.date,
      unit: row.unit,
      quantity: row.quantity,
      size: row.size,
      vendorName: row.vendorName,
      // Per-row Day Store wins when the sheet carries one; otherwise
      // fall back to whatever was picked once for the whole batch.
      dayStoreId: type === "ISSUED_DAY_STORE" ? (row.dayStoreName ? dayStoreIdByName.get(row.dayStoreName) : dayStoreId) : undefined,
      batchNo: row.batchNo,
      grnNo: row.grnNo,
      mfgDate: row.mfgDate,
      expiryDate: row.expiryDate,
      remark: row.remark,
      createdById: req.user!.id,
      // Opening Stock skips the inward QC gate entirely — nothing was
      // actually delivered today to inspect, it's existing stock being
      // catalogued for the first time. Otherwise, same gate as a single
      // manual entry — a bulk sheet doesn't get to skip QA/QC just
      // because it came in as a batch.
      receiptStatus: type === "RECEIVED" ? (isOpeningStock ? "ACCEPTED" : "PENDING_QC") : undefined,
      isOpeningStock: !!isOpeningStock,
      acceptedById: isOpeningStock ? req.user!.id : undefined,
      acceptedAt: isOpeningStock ? new Date() : undefined,
    }));

    // Same live-stock gate as the single-entry POST /transactions above
    // and /requests/:id/issue — a bulk sheet of issues has just as much
    // potential to overdraw the shelf as a manual one, row by row, so
    // sum what the whole sheet asks for per item and check it against
    // what's actually on hand before writing anything. Same ADMIN
    // data-correction exemption, and same SERIALIZABLE-transaction
    // reasoning (see the single-entry route above) for why the check and
    // the write have to be atomic — two concurrent bulk imports touching
    // the same item could otherwise both read a stale on-hand number.
    const isGatedIssue = (type === "ISSUED_DAY_STORE" || type === "ISSUED_PRODUCTION") && !req.user!.roles.includes("ADMIN");
    const result = isGatedIssue
      ? await runSerializable(async (tx) => {
          const nameById = new Map([...itemIds.entries()].map(([key, id]) => [id, uniqueItems.get(key)!.name]));
          const requestedByItem = new Map<string, number>();
          for (const row of rows) {
            const id = itemIds.get(`${row.category}::${row.itemName}`)!;
            requestedByItem.set(id, (requestedByItem.get(id) ?? 0) + row.quantity);
          }
          const onHand = await getOnHandByItemId([...requestedByItem.keys()], tx);
          const shortfalls = [...requestedByItem.entries()]
            .map(([id, requestedQty]) => ({ name: nameById.get(id), requestedQty, onHand: onHand.get(id) ?? 0 }))
            .filter((s) => s.requestedQty > s.onHand);
          if (shortfalls.length > 0) {
            throw new RouteError(409, `Some rows ask for more than what's on hand: ${shortfalls.map((s) => `${s.name} (needs ${s.requestedQty}, only ${s.onHand} on hand)`).join("; ")}`);
          }
          return tx.inventoryTransaction.createMany({ data: rowsData });
        })
      : await prisma.inventoryTransaction.createMany({ data: rowsData });

    await recordAudit({
      actorId: req.user!.id,
      action: isOpeningStock ? "inventory.opening_stock_imported" : "inventory.transactions_imported",
      entityType: "InventoryTransaction",
      metadata: { type, rowCount: result.count, itemsCreated, dayStoreId, dayStoresCreated },
    });

    if (type === "RECEIVED" && !isOpeningStock && result.count > 0) {
      await notifyRoles(
        ["QA_QC"],
        { title: `${result.count} material received row(s) awaiting inward QC`, body: "Bulk import — check the Material Received tab.", link: "/inventory" },
        req.user!.id,
      ).catch(notifyFailed(req, "inventory.transactions_imported"));
    }
    if (isOpeningStock) {
      // A bulk sheet can add stock for the same item across several
      // rows — sum per item first so the crossing check (see
      // notifyIfNewlyAvailable) sees the sheet's whole effect at once,
      // not one row's worth in isolation.
      const addedByItem = new Map<string, number>();
      for (const row of rows) {
        const id = itemIds.get(`${row.category}::${row.itemName}`)!;
        addedByItem.set(id, (addedByItem.get(id) ?? 0) + row.quantity);
      }
      await Promise.all(
        [...addedByItem.entries()].flatMap(([itemId, addedQty]) => [
          notifyIfNewlyAvailable({ itemId, addedQty, actorId: req.user!.id, onFail: (label) => notifyFailed(req, label) }),
          notifyIfPoNewlyReady({ itemId, addedQty, actorId: req.user!.id, onFail: (label) => notifyFailed(req, label) }),
        ]),
      );
    }

    res.status(201).json({ transactionsCreated: result.count, itemsCreated, dayStoresCreated });
  } catch (err) {
    next(err);
  }
});

inventoryRouter.post("/transactions", requireRole("STORE"), validateBody(createInventoryTransactionSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { itemId, ...rest } = req.body as CreateInventoryTransactionInput;

    // The department-wise gate: Store can no longer decide on its own what
    // gets issued to Production — that has to come from PPIC's approved
    // Material Request, fulfilled via POST /requests/:id/issue. ADMIN can
    // still bypass for data correction, same override pattern as the
    // Batch pipeline's JUMP action.
    if (rest.type === "ISSUED_PRODUCTION" && !req.user!.roles.includes("ADMIN")) {
      return res.status(400).json({ error: "Issued to Production entries must come from an approved Material Request — see the Material Requests tab." });
    }
    if (rest.isOpeningStock && rest.type !== "RECEIVED") {
      return res.status(400).json({ error: "Opening Stock only applies to Material Received rows." });
    }

    const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });

    // A Store user scoped to specific store(s) via DayStoreAssignment
    // can't log an entry tagged to a store they don't manage — same
    // restriction as issuing against it (below) or renaming it.
    if (rest.dayStoreId) await assertDayStoreAccess(req.user!.id, req.user!.roles, rest.dayStoreId);

    const createData: Prisma.InventoryTransactionUncheckedCreateInput = {
      itemId,
      ...rest,
      createdById: req.user!.id,
      // Inward QC gate: a fresh RECEIVED row starts PENDING_QC and won't
      // count toward stock until QA/QC approves it and Store accepts it
      // (see PATCH /transactions/:id/qc and POST /transactions/:id/accept)
      // — unless it's Opening Stock, which skips straight to ACCEPTED.
      receiptStatus: rest.type === "RECEIVED" ? (rest.isOpeningStock ? "ACCEPTED" : "PENDING_QC") : undefined,
      acceptedById: rest.isOpeningStock ? req.user!.id : undefined,
      acceptedAt: rest.isOpeningStock ? new Date() : undefined,
    };

    // Same live-stock gate as /requests/:id/issue — a direct Day Store
    // entry has no requestedQty ceiling to fall back on, so without this
    // the only thing stopping Store from issuing more than what's
    // physically on the shelf is manual care. Doesn't apply to RECEIVED,
    // which only ever adds to stock, or to an ADMIN's ISSUED_PRODUCTION
    // override just above — same "data-correction bypass" reasoning as
    // that override having no other gate either.
    //
    // The check and the write run inside one SERIALIZABLE transaction —
    // two Store users issuing the same item at once could otherwise both
    // read the same on-hand number before either write lands, and both
    // pass a check that's individually correct but jointly overdraws the
    // shelf. Postgres aborts one side with a serialization failure when
    // that happens; runSerializable retries it against the now-current
    // number instead of surfacing a spurious error.
    const isGatedIssue = (rest.type === "ISSUED_DAY_STORE" || rest.type === "ISSUED_PRODUCTION") && !req.user!.roles.includes("ADMIN");
    const txn = isGatedIssue
      ? await runSerializable(async (tx) => {
          const onHand = await getOnHandByItemId([itemId], tx);
          const currentStock = onHand.get(itemId) ?? 0;
          if (rest.quantity > currentStock) {
            throw new RouteError(409, `Only ${currentStock} ${rest.unit} actually on hand — can't issue more than what's in stock.`);
          }
          return tx.inventoryTransaction.create({ data: createData, include: txnInclude });
        })
      : await prisma.inventoryTransaction.create({ data: createData, include: txnInclude });

    const auditAction = rest.isOpeningStock
      ? "inventory.opening_stock_logged"
      : rest.type === "RECEIVED"
        ? "inventory.material_received"
        : rest.type === "ISSUED_DAY_STORE"
          ? "inventory.material_issued_day_store"
          : "inventory.material_issued_production";

    await recordAudit({
      actorId: req.user!.id,
      action: auditAction,
      entityType: "InventoryTransaction",
      entityId: txn.id,
      metadata: { itemId, quantity: rest.quantity, unit: rest.unit },
    });

    if (rest.type === "RECEIVED" && !rest.isOpeningStock) {
      await notifyRoles(["QA_QC"], { title: `${item.name} awaiting inward QC`, body: `${rest.quantity} ${rest.unit}`, link: "/inventory" }, req.user!.id).catch(
        notifyFailed(req, "inventory.material_received"),
      );
    }
    if (rest.isOpeningStock) {
      await notifyIfNewlyAvailable({ itemId, addedQty: rest.quantity, actorId: req.user!.id, onFail: (label) => notifyFailed(req, label) });
      await notifyIfPoNewlyReady({ itemId, addedQty: rest.quantity, actorId: req.user!.id, onFail: (label) => notifyFailed(req, label) });
    }

    res.status(201).json(txn);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.delete("/transactions/:id", requireRole("STORE"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const txn = await prisma.inventoryTransaction.findUnique({ where: { id: req.params.id } });
    if (!txn) return res.status(404).json({ error: "Transaction not found" });

    // Deleting a row can send stock negative from either direction:
    // - An ACCEPTED RECEIVED row is an inflow to the Warehouse-wide
    //   total — other issues may already depend on it existing.
    // - An ISSUED_DAY_STORE row is an inflow to a specific Day Store —
    //   removing it can't hurt the Warehouse-wide number (that only
    //   ever goes up), but Production may have already pulled material
    //   *out of* that store depending on this delivery having arrived.
    // - An ISSUED_PRODUCTION row tagged with a Plant is an inflow to
    //   that Plant — same reasoning, Dispensing may already have logged
    //   real consumption against it (see batches.routes.ts).
    // A RECEIVED row still in QC or rejected was never counted in the
    // first place, and an ISSUED_PRODUCTION row's dayStoreId tag (if
    // any) is that transaction's *outflow* side for a store — deleting
    // it only ever adds back to that store's balance, never subtracts.
    const removingQty = txn.type === "RECEIVED" ? txn.quantity - (txn.rejectedQty ?? 0) : txn.quantity;
    const needsWarehouseCheck = txn.type === "RECEIVED" && txn.receiptStatus === "ACCEPTED";
    const needsDayStoreCheck = txn.type === "ISSUED_DAY_STORE" && !!txn.dayStoreId;
    const needsPlantCheck = txn.type === "ISSUED_PRODUCTION" && !!txn.plantId;

    await (needsWarehouseCheck || needsDayStoreCheck || needsPlantCheck
      ? runSerializable(async (tx) => {
          if (needsWarehouseCheck) {
            const onHand = await getOnHandByItemId([txn.itemId], tx);
            const currentStock = onHand.get(txn.itemId) ?? 0;
            if (removingQty > currentStock) {
              throw new RouteError(
                409,
                `Removing this would send stock negative — only ${currentStock} ${txn.unit} on hand, but ${removingQty} ${txn.unit} of what's already counted came from this entry.`,
              );
            }
          }
          if (needsDayStoreCheck) {
            const onHand = await getOnHandByDayStoreAndItem(txn.dayStoreId!, [txn.itemId], tx);
            const currentStoreStock = onHand.get(txn.itemId)?.onHand ?? 0;
            if (removingQty > currentStoreStock) {
              throw new RouteError(
                409,
                `Removing this would send that Store's stock negative — only ${currentStoreStock} ${txn.unit} there, but ${removingQty} ${txn.unit} of what's already counted came from this entry.`,
              );
            }
          }
          if (needsPlantCheck) {
            const onHand = await getOnHandByPlantAndItem(txn.plantId!, [txn.itemId], tx);
            const currentPlantStock = onHand.get(txn.itemId) ?? 0;
            if (removingQty > currentPlantStock) {
              throw new RouteError(
                409,
                `Removing this would send that Plant's stock negative — only ${currentPlantStock} ${txn.unit} there, but ${removingQty} ${txn.unit} of what's already counted came from this entry.`,
              );
            }
          }
          await tx.inventoryTransaction.delete({ where: { id: req.params.id } });
        })
      : prisma.inventoryTransaction.delete({ where: { id: req.params.id } }));

    await recordAudit({ actorId: req.user!.id, action: "inventory.transaction_removed", entityType: "InventoryTransaction", entityId: req.params.id, metadata: { itemId: txn.itemId, type: txn.type } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// --- Inward QC gate — a RECEIVED row starts PENDING_QC; QA/QC checks it
// (this route), then Store accepts it (the next route) before it counts
// toward stock. QC_REJECTED is terminal. ---

inventoryRouter.patch("/transactions/:id/qc", requireRole("QA_QC"), validateBody(inwardQcReviewSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.inventoryTransaction.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Transaction not found" });
    if (existing.type !== "RECEIVED") return res.status(400).json({ error: "Only a Material Received entry goes through inward QC" });
    if (existing.receiptStatus !== "PENDING_QC") return res.status(409).json({ error: `This entry is already ${existing.receiptStatus?.toLowerCase().replace("_", " ")}` });

    const { action, note, rejectedQty } = req.body as InwardQcReviewInput;
    if (action === "APPROVE" && rejectedQty !== undefined && rejectedQty >= existing.quantity) {
      return res.status(400).json({ error: "That's the whole delivery — use Reject instead of a partial rejection." });
    }

    // Guarding receiptStatus in the WHERE clause (not just the read
    // above) makes this one atomic conditional update instead of a
    // check-then-write — two QA_QC users reviewing the same PENDING_QC
    // row at once can't both succeed and silently overwrite each
    // other's call; the database's own row lock on the UPDATE settles
    // who wins, and the loser's write matches zero rows instead of
    // quietly clobbering the first review.
    const result = await prisma.inventoryTransaction.updateMany({
      where: { id: req.params.id, receiptStatus: "PENDING_QC" },
      data: {
        receiptStatus: action === "APPROVE" ? "QC_APPROVED" : "QC_REJECTED",
        qcCheckedById: req.user!.id,
        qcCheckedAt: new Date(),
        qcNote: note,
        rejectedQty: action === "APPROVE" ? (rejectedQty ?? 0) : null,
      },
    });
    if (result.count === 0) {
      return res.status(409).json({ error: "This entry was just reviewed by someone else." });
    }
    const updated = await prisma.inventoryTransaction.findUniqueOrThrow({ where: { id: req.params.id }, include: txnInclude });

    await recordAudit({
      actorId: req.user!.id,
      action: action === "APPROVE" ? "inventory.receipt_qc_approved" : "inventory.receipt_qc_rejected",
      entityType: "InventoryTransaction",
      entityId: updated.id,
      metadata: { note, rejectedQty: action === "APPROVE" ? (rejectedQty ?? 0) : existing.quantity },
    });

    await notifyRoles(
      ["STORE"],
      action === "APPROVE"
        ? {
            title: `${updated.item.name} QC-approved`,
            body: rejectedQty ? `${existing.quantity - rejectedQty} ${existing.unit} accepted, ${rejectedQty} ${existing.unit} rejected — ready to accept into stock.` : "Ready to accept into stock.",
            link: "/inventory",
          }
        : { title: `${updated.item.name} QC-rejected`, body: note, link: "/inventory" },
      req.user!.id,
    ).catch(notifyFailed(req, "inventory.receipt_qc_reviewed"));

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.post("/transactions/:id/accept", requireRole("STORE"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.inventoryTransaction.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Transaction not found" });
    if (existing.receiptStatus !== "QC_APPROVED") return res.status(409).json({ error: "Only a QC-approved entry can be accepted into stock" });

    // Same atomic conditional update as the QC review route above — two
    // Store users accepting the same QC-approved row at once would
    // otherwise both succeed, double-firing notifyIfNewlyAvailable and
    // leaving whichever click landed second silently overwrite the
    // first one's acceptedBy/acceptedAt.
    const result = await prisma.inventoryTransaction.updateMany({
      where: { id: req.params.id, receiptStatus: "QC_APPROVED" },
      data: { receiptStatus: "ACCEPTED", acceptedById: req.user!.id, acceptedAt: new Date() },
    });
    if (result.count === 0) {
      return res.status(409).json({ error: "This entry was just accepted by someone else." });
    }
    const updated = await prisma.inventoryTransaction.findUniqueOrThrow({ where: { id: req.params.id }, include: txnInclude });

    await recordAudit({ actorId: req.user!.id, action: "inventory.receipt_accepted", entityType: "InventoryTransaction", entityId: updated.id, metadata: { quantity: updated.quantity } });

    await notifyIfNewlyAvailable({
      itemId: updated.itemId,
      addedQty: updated.quantity - (updated.rejectedQty ?? 0),
      actorId: req.user!.id,
      onFail: (label) => notifyFailed(req, label),
    });
    await notifyIfPoNewlyReady({
      itemId: updated.itemId,
      addedQty: updated.quantity - (updated.rejectedQty ?? 0),
      actorId: req.user!.id,
      onFail: (label) => notifyFailed(req, label),
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// --- Material Requests (indents) — the department-wise approval gate.
// PPIC raises a request against an item; Store approves or rejects it;
// only an approved request can be issued, which is what actually creates
// the ISSUED_* ledger row above (see /requests/:id/issue). Real-world
// shape: Draft-less "PENDING → APPROVED/REJECTED → ISSUED", same
// Approve/Reject language as PurchaseOrder's review flow. ---

const requestInclude = {
  item: true,
  requestedBy: { select: { id: true, employeeId: true, fullName: true } },
  reviewedBy: { select: { id: true, employeeId: true, fullName: true } },
  plant: true,
  fulfillments: { include: { dayStore: true }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.InventoryRequestInclude;

type RequestRow = Prisma.InventoryRequestGetPayload<{ include: typeof requestInclude }>;

/** issuedQty/remainingQty are derived from the fulfillments list, never stored — same rule as Pre-Inventory's shortQty. */
function withIssuedQty<T extends RequestRow>(request: T) {
  const issuedQty = request.fulfillments.reduce((sum, f) => sum + f.quantity, 0);
  return { ...request, issuedQty, remainingQty: Math.max(0, request.requestedQty - issuedQty) };
}

inventoryRouter.get("/requests", requireRole("STORE", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const { status } = req.query as { status?: InventoryRequestStatus };
    const isStoreOrAdmin = req.user!.roles.includes("STORE") || req.user!.roles.includes("ADMIN");
    const pagination = parsePagination(req);

    const where: Prisma.InventoryRequestWhereInput = {
      ...(status ? { status } : {}),
      // PPIC (not also Store/Admin) only ever sees its own indents —
      // it's a request queue, not a window into the whole warehouse.
      ...(isStoreOrAdmin ? {} : { requestedById: req.user!.id }),
    };

    const [total, requests] = await Promise.all([
      prisma.inventoryRequest.count({ where }),
      prisma.inventoryRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: "desc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(requests.map(withIssuedQty));
  } catch (err) {
    next(err);
  }
});

inventoryRouter.post("/requests", requireRole("PPIC"), validateBody(createInventoryRequestSchema), async (req: AuthedRequest, res, next) => {
  try {
    const data = req.body as CreateInventoryRequestInput;

    const item = await prisma.inventoryItem.findUnique({ where: { id: data.itemId } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });
    if (item.category !== data.category) return res.status(400).json({ error: "Category doesn't match the selected item" });

    const request = await prisma.inventoryRequest.create({
      data: { ...data, requestedById: req.user!.id },
      include: requestInclude,
    });

    await recordAudit({
      actorId: req.user!.id,
      action: "inventory_request.created",
      entityType: "InventoryRequest",
      entityId: request.id,
      metadata: { itemId: data.itemId, purpose: data.purpose, requestedQty: data.requestedQty },
    });

    await notifyRoles(["STORE"], { title: `New request: ${item.name}`, body: `${data.requestedQty} requested by ${request.requestedBy.fullName}`, link: "/inventory" }, req.user!.id).catch(
      notifyFailed(req, "inventory_request.created"),
    );

    res.status(201).json(withIssuedQty(request));
  } catch (err) {
    next(err);
  }
});

// Bulk indent sheet — same resolve-or-create-item pattern as the
// transactions import, but purpose is per-row since a real sheet mixes
// Production and Day Store lines. Every row lands as its own PENDING
// request, same as if PPIC had submitted them one at a time.
inventoryRouter.post("/requests/import", requireRole("PPIC"), validateBody(importInventoryRequestsSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = req.body as ImportInventoryRequestsInput;

    const uniqueItems = new Map<string, { category: "RM" | "PM"; name: string }>();
    for (const row of rows) uniqueItems.set(`${row.category}::${row.itemName}`, { category: row.category, name: row.itemName });

    const itemIds = new Map<string, string>();
    let itemsCreated = 0;
    for (const [key, { category, name }] of uniqueItems) {
      const existing = await prisma.inventoryItem.findUnique({ where: { category_name: { category, name } } });
      if (existing) {
        itemIds.set(key, existing.id);
      } else {
        const created = await prisma.inventoryItem.create({ data: { category, name } });
        itemIds.set(key, created.id);
        itemsCreated += 1;
      }
    }

    const result = await prisma.inventoryRequest.createMany({
      data: rows.map((row) => ({
        itemId: itemIds.get(`${row.category}::${row.itemName}`)!,
        category: row.category,
        requestedQty: row.requestedQty,
        purpose: row.purpose,
        neededBy: row.neededBy,
        note: row.note,
        requestedById: req.user!.id,
      })),
    });

    await recordAudit({
      actorId: req.user!.id,
      action: "inventory_requests.imported",
      entityType: "InventoryRequest",
      metadata: { rowCount: result.count, itemsCreated },
    });

    if (result.count > 0) {
      await notifyRoles(["STORE"], { title: `${result.count} new material request(s)`, body: "Bulk import — check the Material Requests tab.", link: "/inventory" }, req.user!.id).catch(
        notifyFailed(req, "inventory_requests.imported"),
      );
    }

    res.status(201).json({ requestsCreated: result.count, itemsCreated });
  } catch (err) {
    next(err);
  }
});

inventoryRouter.patch("/requests/:id/review", requireRole("STORE"), validateBody(reviewInventoryRequestSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.inventoryRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Request not found" });
    if (existing.status !== "PENDING") return res.status(409).json({ error: `This request is already ${existing.status.toLowerCase()}` });

    const { action, rejectionReason } = req.body as ReviewInventoryRequestInput;

    // Same atomic conditional update as the QC/accept/dispatch routes —
    // two Store users reviewing the same PENDING request at once can't
    // both land a write.
    const result = await prisma.inventoryRequest.updateMany({
      where: { id: req.params.id, status: "PENDING" },
      data: {
        status: action === "APPROVE" ? "APPROVED" : "REJECTED",
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        rejectionReason: action === "REJECT" ? rejectionReason : null,
      },
    });
    if (result.count === 0) {
      return res.status(409).json({ error: "This request was just reviewed by someone else." });
    }
    const updated = await prisma.inventoryRequest.findUniqueOrThrow({ where: { id: req.params.id }, include: requestInclude });

    await recordAudit({
      actorId: req.user!.id,
      action: action === "APPROVE" ? "inventory_request.approved" : "inventory_request.rejected",
      entityType: "InventoryRequest",
      entityId: updated.id,
      metadata: { rejectionReason },
    });

    await notifyUser(
      updated.requestedById,
      action === "APPROVE"
        ? { title: `Request approved: ${updated.item.name}`, body: `${updated.requestedQty} — Store will issue it shortly.`, link: "/inventory" }
        : { title: `Request rejected: ${updated.item.name}`, body: rejectionReason, link: "/inventory" },
    ).catch(notifyFailed(req, "inventory_request.reviewed"));

    res.json(withIssuedQty(updated));
  } catch (err) {
    next(err);
  }
});

inventoryRouter.post("/requests/:id/issue", requireRole("STORE"), validateBody(issueInventoryRequestSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const data = req.body as IssueInventoryRequestInput;

    // The read (request + its existing fulfillments), the on-hand check,
    // and both writes (the new fulfillment + the request's status) all
    // run inside one SERIALIZABLE transaction — two Store users issuing
    // against the same request (or the same item, from different
    // requests) at once could otherwise each read a stale "remaining"/
    // "on hand" number before the other's write lands, and both pass a
    // check that's individually correct but jointly over-issues. Postgres
    // aborts one side with a serialization failure when that happens;
    // runSerializable retries it against the now-current numbers.
    const { existing, txn, newStatus, newTotal } = await runSerializable(async (tx) => {
      const existing = await tx.inventoryRequest.findUnique({ where: { id: req.params.id }, include: { fulfillments: true } });
      if (!existing) throw new RouteError(404, "Request not found");
      if (existing.status !== "APPROVED" && existing.status !== "PARTIALLY_ISSUED") {
        throw new RouteError(409, "Only an approved (or partially issued) request can be issued");
      }

      // A Store user scoped to specific store(s) via DayStoreAssignment
      // can't issue against a store they don't manage — whether that's
      // stock heading *into* that store (purpose ISSUED_DAY_STORE) or
      // being pulled *out of* it on its way to Production.
      if (data.dayStoreId) await assertDayStoreAccess(req.user!.id, req.user!.roles, data.dayStoreId);

      // Store doesn't have to have the full requestedQty on hand — issue
      // whatever's available now, and the request stays open for the
      // rest. Each issue is its own transaction (see fulfillments).
      const alreadyIssued = existing.fulfillments.reduce((sum, f) => sum + f.quantity, 0);
      const remaining = existing.requestedQty - alreadyIssued;
      if (data.quantity > remaining) {
        throw new RouteError(400, `That's more than what's left on this request — ${remaining} remaining.`);
      }

      // The request's own remaining balance is a ceiling on what PPIC
      // asked for, but it says nothing about what's actually on the
      // shelf — issuing more than that would send Stock on Hand negative
      // for material that was never really received. Same live-stock
      // gate Pre-Inventory's Log PO uses, applied here too.
      const onHand = await getOnHandByItemId([existing.itemId], tx);
      const currentStock = onHand.get(existing.itemId) ?? 0;
      if (data.quantity > currentStock) {
        throw new RouteError(409, `Only ${currentStock} ${data.unit} actually on hand — can't issue more than what's in stock.`);
      }

      // The Warehouse-wide check above only proves the company as a
      // whole has enough — it says nothing about whether *this specific*
      // Day Store does. dayStoreId here means "pull this out of that
      // store's own shelf" (see issueInventoryRequestSchema), so if it's
      // set, that store's own balance is the real ceiling: Warehouse
      // stock sitting unallocated to any store, or sitting at a
      // *different* store, doesn't make this store's shelf any less
      // empty. Same SERIALIZABLE transaction as above, so this can't be
      // raced past either.
      if (data.dayStoreId) {
        const dayStoreOnHand = await getOnHandByDayStoreAndItem(data.dayStoreId, [existing.itemId], tx);
        const storeStock = dayStoreOnHand.get(existing.itemId)?.onHand ?? 0;
        if (data.quantity > storeStock) {
          throw new RouteError(409, `Only ${storeStock} ${data.unit} actually on hand at that Day Store — can't issue more than what's there.`);
        }
      }

      const newTotal = alreadyIssued + data.quantity;
      const newStatus = newTotal >= existing.requestedQty ? "ISSUED" : "PARTIALLY_ISSUED";

      const txn = await tx.inventoryTransaction.create({
        data: {
          itemId: existing.itemId,
          type: existing.purpose,
          date: data.date,
          unit: data.unit,
          quantity: data.quantity,
          size: data.size,
          createdById: req.user!.id,
          fulfillsRequestId: existing.id,
          // S7 — dayStoreId is Store's call at issue time; plantId is
          // carried straight off the request PPIC raised it against.
          dayStoreId: data.dayStoreId,
          plantId: existing.plantId,
        },
        include: txnInclude,
      });
      await tx.inventoryRequest.update({ where: { id: existing.id }, data: { status: newStatus } });

      return { existing, txn, newStatus, newTotal };
    });

    await recordAudit({
      actorId: req.user!.id,
      action: "inventory_request.issued",
      entityType: "InventoryRequest",
      entityId: existing.id,
      metadata: { transactionId: txn.id, quantity: data.quantity, totalIssued: newTotal, requestedQty: existing.requestedQty },
    });

    const remainingAfter = existing.requestedQty - newTotal;
    await notifyUser(
      existing.requestedById,
      newStatus === "ISSUED"
        ? { title: `Issued: ${txn.item.name}`, body: `${data.quantity} ${data.unit} — request complete.`, link: "/inventory" }
        : { title: `Partially issued: ${txn.item.name}`, body: `${data.quantity} ${data.unit} now, ${remainingAfter} ${data.unit} still remaining.`, link: "/inventory" },
    ).catch(notifyFailed(req, "inventory_request.issued"));

    res.status(201).json(txn);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.delete("/requests/:id", requireRole("STORE", "PPIC"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.inventoryRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Request not found" });
    if (existing.status === "ISSUED" || existing.status === "PARTIALLY_ISSUED") {
      return res.status(409).json({ error: "This request already has real ledger transactions against it and can't be removed" });
    }

    const isOwner = existing.requestedById === req.user!.id;
    const isStoreOrAdmin = req.user!.roles.includes("STORE") || req.user!.roles.includes("ADMIN");
    if (!isOwner && !isStoreOrAdmin) return res.status(403).json({ error: "You do not have permission to perform this action" });

    await prisma.inventoryRequest.delete({ where: { id: req.params.id } });

    await recordAudit({ actorId: req.user!.id, action: "inventory_request.removed", entityType: "InventoryRequest", entityId: req.params.id, metadata: { status: existing.status } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// --- Dispatch transfer log — the two sheets ("FG transfer to Dispatch" /
// "Bill transfer to Dispatch from Accounts"), told apart by `type`, on one
// endpoint. Customer links to the Order Tracking customer master. ---

const dispatchTransferInclude = {
  customer: { select: { id: true, companyName: true } },
  createdBy: { select: { id: true, employeeId: true, fullName: true } },
  qcCheckedBy: { select: { id: true, employeeId: true, fullName: true } },
  sourceRequest: { include: { item: true } },
  plant: true,
  dispatchedBy: { select: { id: true, employeeId: true, fullName: true } },
  invoicedBy: { select: { id: true, employeeId: true, fullName: true } },
} satisfies Prisma.DispatchTransferInclude;

// QA_QC needs to see FG transfers awaiting outward QC, and Dispatch/
// Accounts need the same log for their own S9 actions — the frontend
// scopes what it actually shows/lets each role act on.
inventoryRouter.get("/dispatch-transfers", requireRole("STORE", "QA_QC", "DISPATCH", "ACCOUNTS"), async (req, res, next) => {
  try {
    const { type, customerId, qcStatus } = req.query as { type?: DispatchTransferType; customerId?: string; qcStatus?: DispatchQcStatus };
    const pagination = parsePagination(req);

    const where: Prisma.DispatchTransferWhereInput = {
      ...(type ? { type } : {}),
      ...(customerId ? { customerId } : {}),
      ...(qcStatus ? { qcStatus } : {}),
    };

    const [total, transfers] = await Promise.all([
      prisma.dispatchTransfer.count({ where }),
      prisma.dispatchTransfer.findMany({ where, include: dispatchTransferInclude, orderBy: { date: "desc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(transfers);
  } catch (err) {
    next(err);
  }
});

// Customer stock reconciliation — one row per customer: everything FG
// dispatch has physically sent out, how much of that Accounts has
// actually invoiced, and what's still outstanding. Scoped to FG rows
// only — BILL transfers never go through Dispatch confirmation or
// invoicing (see the /:id/dispatch and /:id/invoice routes above, both
// FG-only), so there's nothing to reconcile on that side; a BILL row is
// paperwork Accounts already has in hand, not a shipment waiting on an
// invoice. "Dispatched" here means Dispatch has actually confirmed it
// went out (dispatchedAt set) — QC-cleared-but-not-yet-shipped goods
// aren't Finance's concern yet, that's still Dispatch's queue.
inventoryRouter.get("/reports/customer-reconciliation", requireRole("STORE", "ACCOUNTS"), async (_req, res, next) => {
  try {
    const transfers = await prisma.dispatchTransfer.findMany({
      where: { type: "FG", dispatchedAt: { not: null } },
      select: { quantity: true, invoicedAt: true, customer: { select: { id: true, companyName: true } } },
    });

    const byCustomer = new Map<string, { customerName: string; dispatchedQty: number; dispatchedCount: number; invoicedQty: number; invoicedCount: number }>();
    for (const t of transfers) {
      let row = byCustomer.get(t.customer.id);
      if (!row) {
        row = { customerName: t.customer.companyName, dispatchedQty: 0, dispatchedCount: 0, invoicedQty: 0, invoicedCount: 0 };
        byCustomer.set(t.customer.id, row);
      }
      row.dispatchedQty += t.quantity;
      row.dispatchedCount += 1;
      if (t.invoicedAt) {
        row.invoicedQty += t.quantity;
        row.invoicedCount += 1;
      }
    }

    const rows = [...byCustomer.values()]
      .map((r) => ({ ...r, outstandingQty: r.dispatchedQty - r.invoicedQty, outstandingCount: r.dispatchedCount - r.invoicedCount }))
      .sort((a, b) => b.outstandingQty - a.outstandingQty);

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.post("/dispatch-transfers", requireRole("STORE"), validateBody(createDispatchTransferSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { customerId, ...rest } = req.body as CreateDispatchTransferInput;

    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) return res.status(400).json({ error: "Unknown customer" });

    if (rest.sourceRequestId) {
      if (rest.type !== "FG") return res.status(400).json({ error: "A source request can only be linked to an FG transfer" });
      const sourceRequest = await prisma.inventoryRequest.findUnique({ where: { id: rest.sourceRequestId } });
      if (!sourceRequest) return res.status(400).json({ error: "Unknown material request" });
      if (sourceRequest.status !== "ISSUED") return res.status(400).json({ error: "Only an issued request can be linked as a source — nothing left the shelf for it yet" });
    }

    const transfer = await prisma.dispatchTransfer.create({
      // Outward QC gate: an FG row starts PENDING_QC (see PATCH
      // /dispatch-transfers/:id/qc); BILL rows are paperwork, not goods,
      // so they carry no qcStatus at all.
      data: { customerId, ...rest, createdById: req.user!.id, qcStatus: rest.type === "FG" ? "PENDING_QC" : undefined },
      include: dispatchTransferInclude,
    });

    await recordAudit({
      actorId: req.user!.id,
      action: rest.type === "FG" ? "inventory.fg_transfer_to_dispatch" : "inventory.bill_transfer_to_dispatch",
      entityType: "DispatchTransfer",
      entityId: transfer.id,
      metadata: { customerId, productName: rest.productName, quantity: rest.quantity, sourceRequestId: rest.sourceRequestId },
    });

    if (rest.type === "FG") {
      await notifyRoles(["QA_QC"], { title: `${rest.productName} awaiting outward QC`, body: `${customer.companyName} — ${rest.quantity}`, link: "/inventory" }, req.user!.id).catch(
        notifyFailed(req, "inventory.fg_transfer_to_dispatch"),
      );
    }

    res.status(201).json(transfer);
  } catch (err) {
    next(err);
  }
});

// Bulk upload — customers are matched by exact companyName against the
// existing directory, never created here (customer creation is
// BD-only). A row whose customer doesn't match anything gets skipped
// and named back in the response so Store knows to ask BD to add it.
inventoryRouter.post("/dispatch-transfers/import", requireRole("STORE"), validateBody(importDispatchTransfersSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { type, rows } = req.body as ImportDispatchTransfersInput;

    const uniqueNames = [...new Set(rows.map((r) => r.customerName))];
    const customers = await prisma.customer.findMany({ where: { companyName: { in: uniqueNames } } });
    const customerIdByName = new Map(customers.map((c) => [c.companyName, c.id]));

    const unknownCustomers = uniqueNames.filter((n) => !customerIdByName.has(n));
    const usableRows = rows.filter((r) => customerIdByName.has(r.customerName));

    const result = usableRows.length
      ? await prisma.dispatchTransfer.createMany({
          data: usableRows.map((row) => ({
            type,
            date: row.date,
            customerId: customerIdByName.get(row.customerName)!,
            productName: row.productName,
            quantity: row.quantity,
            createdById: req.user!.id,
            qcStatus: type === "FG" ? "PENDING_QC" : undefined,
          })),
        })
      : { count: 0 };

    await recordAudit({
      actorId: req.user!.id,
      action: "inventory.dispatch_transfers_imported",
      entityType: "DispatchTransfer",
      metadata: { type, rowCount: result.count, unknownCustomers },
    });

    if (type === "FG" && result.count > 0) {
      await notifyRoles(["QA_QC"], { title: `${result.count} FG transfer${result.count === 1 ? "" : "s"} awaiting outward QC`, body: "Bulk import from Store.", link: "/inventory" }, req.user!.id).catch(
        notifyFailed(req, "inventory.dispatch_transfers_imported"),
      );
    }

    res.status(201).json({ transfersCreated: result.count, unknownCustomers });
  } catch (err) {
    next(err);
  }
});

// --- Outward QC gate — FG rows only; BILL rows have no qcStatus and
// this route rejects them outright. QC_REJECTED is terminal, same as
// the inward gate. ---

inventoryRouter.patch("/dispatch-transfers/:id/qc", requireRole("QA_QC"), validateBody(qcReviewSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.dispatchTransfer.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Dispatch transfer not found" });
    if (existing.type !== "FG") return res.status(400).json({ error: "Only an FG transfer goes through outward QC" });
    if (existing.qcStatus !== "PENDING_QC") return res.status(409).json({ error: `This transfer is already ${existing.qcStatus?.toLowerCase().replace("_", " ")}` });

    const { action, note } = req.body as QcReviewInput;

    // Same atomic conditional update as the inward QC/accept routes —
    // two QA_QC users reviewing the same transfer at once can't both
    // land a write.
    const result = await prisma.dispatchTransfer.updateMany({
      where: { id: req.params.id, qcStatus: "PENDING_QC" },
      data: { qcStatus: action === "APPROVE" ? "QC_APPROVED" : "QC_REJECTED", qcCheckedById: req.user!.id, qcCheckedAt: new Date(), qcNote: note },
    });
    if (result.count === 0) {
      return res.status(409).json({ error: "This transfer was just reviewed by someone else." });
    }
    const updated = await prisma.dispatchTransfer.findUniqueOrThrow({ where: { id: req.params.id }, include: dispatchTransferInclude });

    await recordAudit({
      actorId: req.user!.id,
      action: action === "APPROVE" ? "inventory.dispatch_qc_approved" : "inventory.dispatch_qc_rejected",
      entityType: "DispatchTransfer",
      entityId: updated.id,
      metadata: { note },
    });

    await notifyRoles(
      ["STORE"],
      action === "APPROVE"
        ? { title: `${updated.productName} outward QC-approved`, body: "Ready to dispatch.", link: "/inventory" }
        : { title: `${updated.productName} outward QC-rejected`, body: note, link: "/inventory" },
      req.user!.id,
    ).catch(notifyFailed(req, "inventory.dispatch_qc_reviewed"));

    // S9 — this is the point Dispatch actually has something to act on:
    // before QC clears, the goods aren't cleared to ship at all.
    if (action === "APPROVE") {
      await notifyRoles(["DISPATCH"], { title: `${updated.productName} cleared for dispatch`, body: `${updated.customer.companyName} — ready to hand off.`, link: "/inventory" }, req.user!.id).catch(
        notifyFailed(req, "inventory.dispatch_qc_approved.dispatch"),
      );
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// --- S9 — Dispatch confirms the shipment has actually gone out and
// hands invoicing details to Finance; Finance (Accounts) closes the
// loop once the invoice is raised. Both FG-only, both gated behind
// outward QC having already cleared — you can't dispatch or invoice
// something QC hasn't approved. ---

inventoryRouter.patch("/dispatch-transfers/:id/dispatch", requireRole("DISPATCH"), validateBody(dispatchConfirmSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.dispatchTransfer.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Dispatch transfer not found" });
    if (existing.type !== "FG") return res.status(400).json({ error: "Only an FG transfer goes through Dispatch's confirmation" });
    if (existing.qcStatus !== "QC_APPROVED") return res.status(409).json({ error: "This transfer hasn't cleared outward QC yet" });
    if (existing.dispatchedAt) return res.status(409).json({ error: "This transfer is already marked dispatched" });

    const { dispatchNote } = req.body as DispatchConfirmInput;

    // Same atomic conditional update as the QC routes above — two
    // Dispatch users confirming the same shipment at once can't both
    // land a write and double-notify Accounts.
    const result = await prisma.dispatchTransfer.updateMany({
      where: { id: req.params.id, qcStatus: "QC_APPROVED", dispatchedAt: null },
      data: { dispatchedById: req.user!.id, dispatchedAt: new Date(), dispatchNote },
    });
    if (result.count === 0) {
      return res.status(409).json({ error: "This transfer was just confirmed dispatched by someone else." });
    }
    const updated = await prisma.dispatchTransfer.findUniqueOrThrow({ where: { id: req.params.id }, include: dispatchTransferInclude });

    await recordAudit({ actorId: req.user!.id, action: "inventory.dispatch_confirmed", entityType: "DispatchTransfer", entityId: updated.id, metadata: { dispatchNote } });

    await notifyRoles(["ACCOUNTS"], { title: `${updated.productName} dispatched — ready to invoice`, body: `${updated.customer.companyName}, qty ${updated.quantity}`, link: "/inventory" }, req.user!.id).catch(
      notifyFailed(req, "inventory.dispatch_confirmed"),
    );

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.patch("/dispatch-transfers/:id/invoice", requireRole("ACCOUNTS"), validateBody(invoiceSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.dispatchTransfer.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Dispatch transfer not found" });
    if (!existing.dispatchedAt) return res.status(409).json({ error: "Dispatch hasn't confirmed this shipment has gone out yet" });
    if (existing.invoicedAt) return res.status(409).json({ error: "This transfer is already invoiced" });

    const { invoiceNumber } = req.body as InvoiceInput;

    // Same atomic conditional update as the routes above — two Accounts
    // users invoicing the same transfer at once can't both land a write
    // and silently overwrite each other's invoice number.
    const result = await prisma.dispatchTransfer.updateMany({
      where: { id: req.params.id, dispatchedAt: { not: null }, invoicedAt: null },
      data: { invoiceNumber, invoicedById: req.user!.id, invoicedAt: new Date() },
    });
    if (result.count === 0) {
      return res.status(409).json({ error: "This transfer was just invoiced by someone else." });
    }
    const updated = await prisma.dispatchTransfer.findUniqueOrThrow({ where: { id: req.params.id }, include: dispatchTransferInclude });

    await recordAudit({ actorId: req.user!.id, action: "inventory.dispatch_invoiced", entityType: "DispatchTransfer", entityId: updated.id, metadata: { invoiceNumber } });

    await notifyUser(existing.createdById, { title: `${updated.productName} invoiced`, body: `Invoice ${invoiceNumber}`, link: "/inventory" }).catch(notifyFailed(req, "inventory.dispatch_invoiced"));

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.delete("/dispatch-transfers/:id", requireRole("STORE"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const transfer = await prisma.dispatchTransfer.findUnique({ where: { id: req.params.id } });
    if (!transfer) return res.status(404).json({ error: "Dispatch transfer not found" });

    await prisma.dispatchTransfer.delete({ where: { id: req.params.id } });

    await recordAudit({
      actorId: req.user!.id,
      action: "inventory.dispatch_transfer_removed",
      entityType: "DispatchTransfer",
      entityId: req.params.id,
      metadata: { customerId: transfer.customerId, type: transfer.type },
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
