import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import {
  createDispatchTransferSchema,
  createInventoryItemSchema,
  createInventoryRequestSchema,
  createInventoryTransactionSchema,
  importInventoryRequestsSchema,
  importInventoryTransactionsSchema,
  issueInventoryRequestSchema,
  qcReviewSchema,
  reviewInventoryRequestSchema,
  updateInventoryItemSchema,
  type CreateDispatchTransferInput,
  type CreateInventoryItemInput,
  type CreateInventoryRequestInput,
  type CreateInventoryTransactionInput,
  type ImportInventoryRequestsInput,
  type ImportInventoryTransactionsInput,
  type IssueInventoryRequestInput,
  type QcReviewInput,
  type ReviewInventoryRequestInput,
  type UpdateInventoryItemInput,
} from "./inventory.schemas";
import type { DispatchQcStatus, DispatchTransferType, InventoryCategory, InventoryReceiptStatus, InventoryRequestStatus, Prisma } from "@prisma/client";

export const inventoryRouter = Router();

inventoryRouter.use(requireAuth);

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
      // rejected, hasn't actually become usable stock yet.
      prisma.inventoryTransaction.groupBy({ by: ["itemId"], where: { type: "RECEIVED", receiptStatus: "ACCEPTED" }, _sum: { quantity: true } }),
      prisma.inventoryTransaction.groupBy({ by: ["itemId"], where: { type: "ISSUED_DAY_STORE" }, _sum: { quantity: true } }),
      prisma.inventoryTransaction.groupBy({ by: ["itemId"], where: { type: "ISSUED_PRODUCTION" }, _sum: { quantity: true } }),
    ]);

    const received = new Map(receivedTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
    const issuedDayStore = new Map(issuedDayStoreTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));
    const issuedProduction = new Map(issuedProductionTotals.map((r) => [r.itemId, r._sum.quantity ?? 0]));

    const stock = items.map((item) => {
      const receivedQty = received.get(item.id) ?? 0;
      const issuedDayStoreQty = issuedDayStore.get(item.id) ?? 0;
      const issuedProductionQty = issuedProduction.get(item.id) ?? 0;
      const issuedQty = issuedDayStoreQty + issuedProductionQty;
      return { item, receivedQty, issuedDayStoreQty, issuedProductionQty, issuedQty, onHand: receivedQty - issuedQty };
    });

    res.json(stock);
  } catch (err) {
    next(err);
  }
});

// --- Reference data for the vendor field — distinct vendor names already
// used on a Material Received entry, offered as a combobox so the form
// nudges toward reusing a known vendor without forbidding a new one. ---

inventoryRouter.get("/vendors", requireRole("STORE"), async (_req, res, next) => {
  try {
    const rows = await prisma.inventoryTransaction.findMany({
      where: { vendorName: { not: null } },
      distinct: ["vendorName"],
      select: { vendorName: true },
      orderBy: { vendorName: "asc" },
    });
    res.json(rows.map((r) => r.vendorName).filter((v): v is string => !!v));
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
    const { type, rows } = req.body as ImportInventoryTransactionsInput;

    if (type === "ISSUED_PRODUCTION" && !req.user!.roles.includes("ADMIN")) {
      return res.status(400).json({ error: "Issued to Production entries must come from an approved Material Request — see the Material Requests tab." });
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

    const result = await prisma.inventoryTransaction.createMany({
      data: rows.map((row) => ({
        itemId: itemIds.get(`${row.category}::${row.itemName}`)!,
        type,
        date: row.date,
        unit: row.unit,
        quantity: row.quantity,
        size: row.size,
        vendorName: row.vendorName,
        createdById: req.user!.id,
        // Same inward QC gate as a single manual entry — a bulk sheet
        // doesn't get to skip QA/QC just because it came in as a batch.
        receiptStatus: type === "RECEIVED" ? "PENDING_QC" : undefined,
      })),
    });

    await recordAudit({
      actorId: req.user!.id,
      action: "inventory.transactions_imported",
      entityType: "InventoryTransaction",
      metadata: { type, rowCount: result.count, itemsCreated },
    });

    res.status(201).json({ transactionsCreated: result.count, itemsCreated });
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

    const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });

    const txn = await prisma.inventoryTransaction.create({
      // Inward QC gate: a fresh RECEIVED row starts PENDING_QC and won't
      // count toward stock until QA/QC approves it and Store accepts it
      // (see PATCH /transactions/:id/qc and POST /transactions/:id/accept).
      data: { itemId, ...rest, createdById: req.user!.id, receiptStatus: rest.type === "RECEIVED" ? "PENDING_QC" : undefined },
      include: txnInclude,
    });

    const auditAction =
      rest.type === "RECEIVED" ? "inventory.material_received" : rest.type === "ISSUED_DAY_STORE" ? "inventory.material_issued_day_store" : "inventory.material_issued_production";

    await recordAudit({
      actorId: req.user!.id,
      action: auditAction,
      entityType: "InventoryTransaction",
      entityId: txn.id,
      metadata: { itemId, quantity: rest.quantity, unit: rest.unit },
    });

    res.status(201).json(txn);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.delete("/transactions/:id", requireRole("STORE"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const txn = await prisma.inventoryTransaction.findUnique({ where: { id: req.params.id } });
    if (!txn) return res.status(404).json({ error: "Transaction not found" });

    await prisma.inventoryTransaction.delete({ where: { id: req.params.id } });

    await recordAudit({ actorId: req.user!.id, action: "inventory.transaction_removed", entityType: "InventoryTransaction", entityId: req.params.id, metadata: { itemId: txn.itemId, type: txn.type } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// --- Inward QC gate — a RECEIVED row starts PENDING_QC; QA/QC checks it
// (this route), then Store accepts it (the next route) before it counts
// toward stock. QC_REJECTED is terminal. ---

inventoryRouter.patch("/transactions/:id/qc", requireRole("QA_QC"), validateBody(qcReviewSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.inventoryTransaction.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Transaction not found" });
    if (existing.type !== "RECEIVED") return res.status(400).json({ error: "Only a Material Received entry goes through inward QC" });
    if (existing.receiptStatus !== "PENDING_QC") return res.status(409).json({ error: `This entry is already ${existing.receiptStatus?.toLowerCase().replace("_", " ")}` });

    const { action, note } = req.body as QcReviewInput;

    const updated = await prisma.inventoryTransaction.update({
      where: { id: req.params.id },
      data: { receiptStatus: action === "APPROVE" ? "QC_APPROVED" : "QC_REJECTED", qcCheckedById: req.user!.id, qcCheckedAt: new Date(), qcNote: note },
      include: txnInclude,
    });

    await recordAudit({
      actorId: req.user!.id,
      action: action === "APPROVE" ? "inventory.receipt_qc_approved" : "inventory.receipt_qc_rejected",
      entityType: "InventoryTransaction",
      entityId: updated.id,
      metadata: { note },
    });

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

    const updated = await prisma.inventoryTransaction.update({
      where: { id: req.params.id },
      data: { receiptStatus: "ACCEPTED", acceptedById: req.user!.id, acceptedAt: new Date() },
      include: txnInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "inventory.receipt_accepted", entityType: "InventoryTransaction", entityId: updated.id, metadata: { quantity: updated.quantity } });

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
  fulfillment: true,
} satisfies Prisma.InventoryRequestInclude;

inventoryRouter.get("/requests", requireRole("STORE", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const { status } = req.query as { status?: InventoryRequestStatus };
    const isStoreOrAdmin = req.user!.roles.includes("STORE") || req.user!.roles.includes("ADMIN");

    const where: Prisma.InventoryRequestWhereInput = {
      ...(status ? { status } : {}),
      // PPIC (not also Store/Admin) only ever sees its own indents —
      // it's a request queue, not a window into the whole warehouse.
      ...(isStoreOrAdmin ? {} : { requestedById: req.user!.id }),
    };

    const requests = await prisma.inventoryRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: "desc" } });
    res.json(requests);
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

    res.status(201).json(request);
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

    const updated = await prisma.inventoryRequest.update({
      where: { id: req.params.id },
      data: {
        status: action === "APPROVE" ? "APPROVED" : "REJECTED",
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        rejectionReason: action === "REJECT" ? rejectionReason : null,
      },
      include: requestInclude,
    });

    await recordAudit({
      actorId: req.user!.id,
      action: action === "APPROVE" ? "inventory_request.approved" : "inventory_request.rejected",
      entityType: "InventoryRequest",
      entityId: updated.id,
      metadata: { rejectionReason },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.post("/requests/:id/issue", requireRole("STORE"), validateBody(issueInventoryRequestSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.inventoryRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Request not found" });
    if (existing.status !== "APPROVED") return res.status(409).json({ error: "Only an approved request can be issued" });

    const data = req.body as IssueInventoryRequestInput;

    const [txn] = await prisma.$transaction([
      prisma.inventoryTransaction.create({
        data: {
          itemId: existing.itemId,
          type: existing.purpose,
          date: data.date,
          unit: data.unit,
          quantity: data.quantity,
          size: data.size,
          createdById: req.user!.id,
          fulfillsRequestId: existing.id,
        },
        include: txnInclude,
      }),
      prisma.inventoryRequest.update({ where: { id: existing.id }, data: { status: "ISSUED" } }),
    ]);

    await recordAudit({
      actorId: req.user!.id,
      action: "inventory_request.issued",
      entityType: "InventoryRequest",
      entityId: existing.id,
      metadata: { transactionId: txn.id, quantity: data.quantity },
    });

    res.status(201).json(txn);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.delete("/requests/:id", requireRole("STORE", "PPIC"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.inventoryRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Request not found" });
    if (existing.status === "ISSUED") return res.status(409).json({ error: "An issued request is part of the permanent ledger and can't be removed" });

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
} satisfies Prisma.DispatchTransferInclude;

// QA_QC needs to see FG transfers awaiting outward QC — BILL rows never
// carry a qcStatus, so there's nothing for QA_QC to act on there.
inventoryRouter.get("/dispatch-transfers", requireRole("STORE", "QA_QC"), async (req, res, next) => {
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

    res.status(201).json(transfer);
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

    const updated = await prisma.dispatchTransfer.update({
      where: { id: req.params.id },
      data: { qcStatus: action === "APPROVE" ? "QC_APPROVED" : "QC_REJECTED", qcCheckedById: req.user!.id, qcCheckedAt: new Date(), qcNote: note },
      include: dispatchTransferInclude,
    });

    await recordAudit({
      actorId: req.user!.id,
      action: action === "APPROVE" ? "inventory.dispatch_qc_approved" : "inventory.dispatch_qc_rejected",
      entityType: "DispatchTransfer",
      entityId: updated.id,
      metadata: { note },
    });

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
