import { Router } from "express";
import multer, { MulterError } from "multer";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { deleteUploadedFile, resolveStoragePath, saveUploadedFile } from "../../common/lib/storage";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { buildPurchaseOrderPdf } from "./po-pdf";
import {
  createPurchaseOrderSchema,
  importPurchaseOrdersSchema,
  reviewPurchaseOrderSchema,
  updatePurchaseOrderItemSchema,
  updatePurchaseOrderSchema,
  type CreatePurchaseOrderInput,
  type ImportPurchaseOrdersInput,
  type ReviewPurchaseOrderInput,
  type UpdatePurchaseOrderInput,
  type UpdatePurchaseOrderItemInput,
} from "./purchase-orders.schemas";
import type { Prisma } from "@prisma/client";

export const purchaseOrdersRouter = Router();

purchaseOrdersRouter.use(requireAuth);

// Photo or PDF only, per the intake form's "Upload" control — matches how
// a PO is actually received (a scan or a forwarded PDF), nothing else.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype === "application/pdf") return cb(null, true);
    cb(new MulterError("LIMIT_UNEXPECTED_FILE", "Only image or PDF files are accepted"));
  },
});

// multer's own errors (bad file type via fileFilter, file too large) land
// here as a MulterError, not a generic 500 — the caller gets a real 400
// with the reason, same shape validateBody's failures use.
function handleUploadErrors(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (err instanceof MulterError) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
}

const poInclude = {
  customer: { select: { id: true, companyName: true } },
  reviewedBy: { select: { id: true, fullName: true } },
  items: {
    include: {
      _count: { select: { batches: true } },
      // Lightweight summaries only — full plan detail (items, calculated
      // result) is fetched on-demand from the BOM/RM Costing pages
      // themselves; here we just need enough to render a status chip and
      // a link from the order/product view (the "Production Pipeline"
      // strip that ties all four modules together).
      bomPlans: { select: { id: true, name: true, status: true }, orderBy: { createdAt: "desc" } },
      rmPlans: { select: { id: true, name: true, status: true }, orderBy: { createdAt: "desc" } },
      // Just enough to compute completion below — not the batch's full
      // record, that's what GET /api/batches/:id is for.
      batches: { select: { currentStageId: true, dispatchDate: true, customerConfirmation: true } },
    },
    orderBy: { createdAt: "asc" },
  },
  documents: { select: { id: true, filename: true, mimeType: true, uploadedAt: true, uploadedById: true } },
} satisfies Prisma.PurchaseOrderInclude;

type PoWithBatches = Prisma.PurchaseOrderGetPayload<{ include: typeof poInclude }>;

// A PO is "completed" once every Batch across every one of its line
// items has reached the end of the pipeline for real — DISPATCH_PLAN
// *and* a recorded customer confirmation, same "done" definition the
// Dashboard's own active-batch count already uses (see
// DashboardPage.tsx activeBatches). Computed on read, never stored —
// same rule as every other derived number in this app. completionDate
// is the latest dispatchDate across those batches (the business-entered
// ship date at that stage, not a technical row-update timestamp), and
// daysTaken is the whole-day span from the PO's own orderDate (falling
// back to when it was entered, if BD never filled in an order date).
function computeCompletion(po: PoWithBatches): { isCompleted: boolean; completionDate: string | null; daysTaken: number | null } {
  const allBatches = po.items.flatMap((item) => item.batches);
  if (allBatches.length === 0) return { isCompleted: false, completionDate: null, daysTaken: null };

  const isCompleted = allBatches.every((b) => b.currentStageId === "DISPATCH_PLAN" && b.customerConfirmation === "Received");
  if (!isCompleted) return { isCompleted: false, completionDate: null, daysTaken: null };

  const dispatchDates = allBatches.map((b) => b.dispatchDate).filter((d): d is Date => d !== null);
  if (dispatchDates.length === 0) return { isCompleted: true, completionDate: null, daysTaken: null }; // confirmed received, but Dispatch never filled in a ship date to measure from

  const completionDate = new Date(Math.max(...dispatchDates.map((d) => d.getTime())));
  const startDate = po.orderDate ?? po.createdAt;
  const daysTaken = Math.round((completionDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

  return { isCompleted: true, completionDate: completionDate.toISOString(), daysTaken };
}

function serializePo(po: PoWithBatches) {
  // batches was only fetched to compute completion — strip it back out
  // of each item before responding, same "don't leak the query's
  // working data into the API shape" reasoning as everywhere else.
  return { ...po, items: po.items.map(({ batches: _batches, ...item }) => item), completion: computeCompletion(po) };
}

// Read is open to any authenticated user; only BD/Admin write.
purchaseOrdersRouter.get("/", async (req, res, next) => {
  try {
    const pagination = parsePagination(req);
    const [total, orders] = await Promise.all([
      prisma.purchaseOrder.count(),
      prisma.purchaseOrder.findMany({ include: poInclude, orderBy: { createdAt: "desc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(orders.map(serializePo));
  } catch (err) {
    next(err);
  }
});

// Report #6 — customer-wise, PO-wise wastage & rejection. Declared before
// GET "/:id" but doesn't need to be — "/reports/wastage-rejection" is two
// path segments, "/:id" only matches one, so there's no ambiguity either
// order. Kept up here just to sit next to the other list-shaped GETs.
//
// wastageQty is never stored (schema.prisma: derived inputQty - outputQty,
// see batch.engine.ts computeWastage) — recomputed here the same way.
// mfgRejectedQty is QC's own stored figure, independent of wastage. A
// batch with neither set yet (still mid-pipeline) is left out — nothing
// to report until Production/QC have actually entered those numbers.
purchaseOrdersRouter.get("/reports/wastage-rejection", async (_req, res, next) => {
  try {
    const batches = await prisma.batch.findMany({
      where: { OR: [{ inputQty: { not: null } }, { mfgRejectedQty: { not: null } }] },
      select: {
        id: true,
        batchNo: true,
        unit: true,
        inputQty: true,
        outputQty: true,
        mfgRejectedQty: true,
        purchaseOrderItem: {
          select: {
            productName: true,
            purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    const rows = batches.map((b) => ({
      customerName: b.purchaseOrderItem.purchaseOrder.customer.companyName,
      poNumber: b.purchaseOrderItem.purchaseOrder.poNumber ?? b.purchaseOrderItem.purchaseOrder.id.slice(0, 8),
      productName: b.purchaseOrderItem.productName,
      batchNo: b.batchNo,
      unit: b.unit,
      inputQty: b.inputQty,
      outputQty: b.outputQty,
      wastageQty: b.inputQty !== null && b.outputQty !== null ? Math.max(0, b.inputQty - b.outputQty) : null,
      mfgRejectedQty: b.mfgRejectedQty,
    }));

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

purchaseOrdersRouter.post("/", requireRole("BD"), validateBody(createPurchaseOrderSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { customerId, items, ...rest } = req.body as CreatePurchaseOrderInput;

    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) return res.status(400).json({ error: "Unknown customer" });

    const order = await prisma.purchaseOrder.create({
      data: { customerId, ...rest, createdById: req.user!.id, items: { create: items } },
      include: poInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "purchase_order.created", entityType: "PurchaseOrder", entityId: order.id, metadata: { itemCount: items.length } });

    res.status(201).json(serializePo(order));
  } catch (err) {
    next(err);
  }
});

// Bulk import — BD's own PO system export, one row per (PO, product)
// pair, grouped into one PurchaseOrder per distinct poNumber. Every
// created PO lands as DRAFT, same as the manual form — bulk entry
// doesn't skip BD's own Approve/Reject review, it just removes the
// re-typing. A poNumber that already exists in the system is skipped
// entirely (not merged/updated) and reported back — there's no
// uniqueness constraint on poNumber to lean on here, so silently
// upserting into an existing PO risks quietly rewriting someone else's
// order; skip-and-report keeps a re-upload safe to retry.
purchaseOrdersRouter.post("/import", requireRole("BD"), validateBody(importPurchaseOrdersSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = req.body as ImportPurchaseOrdersInput;

    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const existing = groups.get(row.poNumber);
      if (existing) existing.push(row);
      else groups.set(row.poNumber, [row]);
    }

    const existingPos = await prisma.purchaseOrder.findMany({ where: { poNumber: { in: [...groups.keys()] } }, select: { poNumber: true } });
    const alreadyExists = new Set(existingPos.map((p) => p.poNumber));

    const customers = await prisma.customer.findMany({ select: { id: true, companyName: true } });
    const customerByName = new Map(customers.map((c) => [c.companyName.trim().toLowerCase(), c.id]));

    let posCreated = 0;
    let itemsCreated = 0;
    let customersCreated = 0;
    const skippedExisting: string[] = [];

    for (const [poNumber, groupRows] of groups) {
      if (alreadyExists.has(poNumber)) {
        skippedExisting.push(poNumber);
        continue;
      }

      const first = groupRows[0]!;
      const customerKey = first.customerName.trim().toLowerCase();
      let customerId = customerByName.get(customerKey);
      if (!customerId) {
        const created = await prisma.customer.create({ data: { companyName: first.customerName.trim(), createdById: req.user!.id } });
        customerId = created.id;
        customerByName.set(customerKey, customerId);
        customersCreated += 1;
      }

      const order = await prisma.purchaseOrder.create({
        data: {
          customerId,
          poNumber,
          brandName: first.brandName,
          orderDate: first.orderDate,
          regulatoryBody: first.regulatoryBody,
          regulatoryStatus: first.regulatoryStatus,
          createdById: req.user!.id,
          items: {
            create: groupRows.map((r) => ({
              productName: r.productName,
              dosageForm: r.dosageForm,
              quantity: r.quantity,
              unit: r.unit,
              volume: r.volume,
              packSize: r.packSize,
              packType: r.packType,
            })),
          },
        },
      });

      posCreated += 1;
      itemsCreated += groupRows.length;

      await recordAudit({ actorId: req.user!.id, action: "purchase_order.created", entityType: "PurchaseOrder", entityId: order.id, metadata: { itemCount: groupRows.length, source: "import" } });
    }

    res.status(201).json({ posCreated, itemsCreated, customersCreated, skippedExisting });
  } catch (err) {
    next(err);
  }
});

purchaseOrdersRouter.get("/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const order = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id }, include: poInclude });
    if (!order) return res.status(404).json({ error: "Purchase order not found" });
    res.json(serializePo(order));
  } catch (err) {
    next(err);
  }
});

// A printable copy of the PO as entered — header fields plus product line
// items — for BD to hand to a customer or file alongside the uploaded
// scan. Open to any authenticated user, same as the read routes above;
// available at any status, not just once approved.
purchaseOrdersRouter.get("/:id/export.pdf", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const order = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id }, include: poInclude });
    if (!order) return res.status(404).json({ error: "Purchase order not found" });

    const doc = buildPurchaseOrderPdf(order);
    await recordAudit({ actorId: req.user!.id, action: "purchase_order.exported_pdf", entityType: "PurchaseOrder", entityId: order.id });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="FLS_PO_${order.poNumber ?? order.id}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    next(err);
  }
});

purchaseOrdersRouter.patch("/:id", requireRole("BD"), validateBody(updatePurchaseOrderSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Purchase order not found" });

    const data = req.body as UpdatePurchaseOrderInput;
    const updated = await prisma.purchaseOrder.update({ where: { id: req.params.id }, data, include: poInclude });

    await recordAudit({ actorId: req.user!.id, action: "purchase_order.updated", entityType: "PurchaseOrder", entityId: updated.id });

    res.json(serializePo(updated));
  } catch (err) {
    next(err);
  }
});

// Draft → BD Approve/Reject. Only from DRAFT — once reviewed, the
// decision stands (matching "Forward to PPIC + RM" being a one-way gate,
// not something that flips back and forth).
purchaseOrdersRouter.patch("/:id/review", requireRole("BD"), validateBody(reviewPurchaseOrderSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Purchase order not found" });
    if (existing.status !== "DRAFT") return res.status(400).json({ error: `This purchase order was already ${existing.status.toLowerCase()}.` });

    const { status, rejectionReason } = req.body as ReviewPurchaseOrderInput;
    // Atomic conditional update — two BD users reviewing the same DRAFT
    // PO at once can't both land a write and silently overwrite each
    // other's decision.
    const result = await prisma.purchaseOrder.updateMany({
      where: { id: req.params.id, status: "DRAFT" },
      data: { status, rejectionReason: status === "REJECTED" ? rejectionReason : null, reviewedById: req.user!.id, reviewedAt: new Date() },
    });
    if (result.count === 0) {
      return res.status(409).json({ error: "This purchase order was just reviewed by someone else." });
    }
    const updated = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: req.params.id }, include: poInclude });

    await recordAudit({ actorId: req.user!.id, action: status === "APPROVED" ? "purchase_order.approved" : "purchase_order.rejected", entityType: "PurchaseOrder", entityId: updated.id });

    // Notification failures are logged, not fatal — the review itself
    // already succeeded and that response shouldn't 500 over a notice.
    const notifyFailed = (label: string) => (err: unknown) => req.log?.error({ err }, `notify failed: ${label}`);
    const poLabel = updated.poNumber ?? `PO ${updated.id.slice(0, 8)}`;
    if (status === "APPROVED") {
      await Promise.all([
        notifyUser(updated.createdById, { title: `${poLabel} approved`, body: "Forwarded to PPIC/RM for planning.", link: `/purchase-orders/${updated.id}` }).catch(notifyFailed("po.approved.creator")),
        // The whole reason approval matters — PPIC can't release a batch
        // off this PO until it happens, so tell them the moment it does.
        notifyRoles(["PPIC"], { title: `${poLabel} approved`, body: `${updated.customer.companyName} — ready to plan batches.`, link: `/purchase-orders/${updated.id}` }, req.user!.id).catch(
          notifyFailed("po.approved.ppic"),
        ),
      ]);
    } else {
      await notifyUser(updated.createdById, { title: `${poLabel} rejected`, body: rejectionReason, link: `/purchase-orders/${updated.id}` }).catch(notifyFailed("po.rejected.creator"));
    }

    res.json(serializePo(updated));
  } catch (err) {
    next(err);
  }
});

// "Add More" — appends one more product line item to an existing PO.
purchaseOrdersRouter.post(
  "/:id/items",
  requireRole("BD"),
  validateBody(createPurchaseOrderSchema.shape.items.element),
  async (req: AuthedRequest<{ id: string }>, res, next) => {
    try {
      const order = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
      if (!order) return res.status(404).json({ error: "Purchase order not found" });

      const item = await prisma.purchaseOrderItem.create({ data: { purchaseOrderId: req.params.id, ...req.body } });

      await recordAudit({ actorId: req.user!.id, action: "purchase_order.item_added", entityType: "PurchaseOrder", entityId: order.id, metadata: { itemId: item.id } });

      res.status(201).json(item);
    } catch (err) {
      next(err);
    }
  },
);

purchaseOrdersRouter.patch(
  "/:id/items/:itemId",
  requireRole("BD"),
  validateBody(updatePurchaseOrderItemSchema),
  async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
    try {
      const item = await prisma.purchaseOrderItem.findUnique({ where: { id: req.params.itemId }, include: { _count: { select: { batches: true } } } });
      if (!item || item.purchaseOrderId !== req.params.id) return res.status(404).json({ error: "Line item not found" });

      const data = req.body as UpdatePurchaseOrderItemInput;
      const updated = await prisma.purchaseOrderItem.update({ where: { id: req.params.itemId }, data, include: { _count: { select: { batches: true } } } });

      // Editing a line item stays allowed even once it has real
      // production Batches against it (unlike deleting it, which is
      // blocked — see DELETE above) — genuine corrections shouldn't be
      // locked out. But without recording *what* changed, there'd be no
      // way to explain later why a batch's numbers no longer match its
      // PO item. `before`/`after` only cover the fields actually
      // touched by this call, not the item's whole row.
      const before: Record<string, unknown> = {};
      for (const key of Object.keys(data) as (keyof UpdatePurchaseOrderItemInput)[]) before[key] = item[key];

      await recordAudit({
        actorId: req.user!.id,
        action: "purchase_order.item_updated",
        entityType: "PurchaseOrder",
        entityId: req.params.id,
        metadata: { itemId: updated.id, before, after: data, batchCount: item._count.batches },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

purchaseOrdersRouter.delete("/:id/items/:itemId", requireRole("BD"), async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
  try {
    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: req.params.itemId }, include: { _count: { select: { batches: true } } } });
    if (!item || item.purchaseOrderId !== req.params.id) return res.status(404).json({ error: "Line item not found" });

    // Batch.purchaseOrderItemId cascades on delete — this item's own
    // production Batches (and everything hanging off each one:
    // BatchStageEvent's whole audit trail, BatchMaterialConsumption)
    // would be silently wiped out along with it, even one sitting at
    // Dispatch, fully packaged and QC-approved. There's no confirmation
    // dialog that could make that safe to allow — a line item with real
    // production against it just isn't removable any more, same "it's
    // real ledger history, not a form field" reasoning as everywhere
    // else deletion is locked down in this app.
    if (item._count.batches > 0) {
      return res.status(409).json({
        error: `This line item has ${item._count.batches} production batch${item._count.batches === 1 ? "" : "es"} against it and can't be removed — deleting it would erase that batch history.`,
      });
    }

    await prisma.purchaseOrderItem.delete({ where: { id: req.params.itemId } });

    await recordAudit({ actorId: req.user!.id, action: "purchase_order.item_removed", entityType: "PurchaseOrder", entityId: req.params.id, metadata: { itemId: req.params.itemId } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// The PO photo/PDF upload — multipart, single field named "file".
purchaseOrdersRouter.post("/:id/documents", requireRole("BD"), upload.single("file"), handleUploadErrors, async (req: AuthedRequest<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const order = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: "Purchase order not found" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded (expected multipart field \"file\")" });

    const storagePath = saveUploadedFile(req.file.originalname, req.file.buffer);
    const doc = await prisma.purchaseOrderDocument.create({
      data: {
        purchaseOrderId: req.params.id,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        storagePath,
        uploadedById: req.user!.id,
      },
      select: { id: true, filename: true, mimeType: true, uploadedAt: true, uploadedById: true },
    });

    await recordAudit({ actorId: req.user!.id, action: "purchase_order.document_uploaded", entityType: "PurchaseOrder", entityId: order.id, metadata: { documentId: doc.id } });

    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

// Authenticated download — not a public static path, since these are
// business documents, not public assets.
purchaseOrdersRouter.get("/:id/documents/:docId/download", async (req: AuthedRequest<{ id: string; docId: string }>, res, next) => {
  try {
    const doc = await prisma.purchaseOrderDocument.findUnique({ where: { id: req.params.docId } });
    if (!doc || doc.purchaseOrderId !== req.params.id) return res.status(404).json({ error: "Document not found" });

    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(doc.filename)}"`);
    res.sendFile(resolveStoragePath(doc.storagePath));
  } catch (err) {
    next(err);
  }
});

purchaseOrdersRouter.delete("/:id/documents/:docId", requireRole("BD"), async (req: AuthedRequest<{ id: string; docId: string }>, res, next) => {
  try {
    const doc = await prisma.purchaseOrderDocument.findUnique({ where: { id: req.params.docId } });
    if (!doc || doc.purchaseOrderId !== req.params.id) return res.status(404).json({ error: "Document not found" });

    await prisma.purchaseOrderDocument.delete({ where: { id: req.params.docId } });
    deleteUploadedFile(doc.storagePath);

    await recordAudit({ actorId: req.user!.id, action: "purchase_order.document_removed", entityType: "PurchaseOrder", entityId: req.params.id, metadata: { documentId: req.params.docId } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
