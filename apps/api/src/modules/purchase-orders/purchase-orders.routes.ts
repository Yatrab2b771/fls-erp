import { Router } from "express";
import multer, { MulterError } from "multer";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { deleteUploadedFile, resolveStoragePath, saveUploadedFile } from "../../common/lib/storage";
import { buildPurchaseOrderPdf } from "./po-pdf";
import {
  createPurchaseOrderSchema,
  reviewPurchaseOrderSchema,
  updatePurchaseOrderItemSchema,
  updatePurchaseOrderSchema,
  type CreatePurchaseOrderInput,
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
    },
    orderBy: { createdAt: "asc" },
  },
  documents: { select: { id: true, filename: true, mimeType: true, uploadedAt: true, uploadedById: true } },
} satisfies Prisma.PurchaseOrderInclude;

// Read is open to any authenticated user; only BD/Admin write.
purchaseOrdersRouter.get("/", async (req, res, next) => {
  try {
    const pagination = parsePagination(req);
    const [total, orders] = await Promise.all([
      prisma.purchaseOrder.count(),
      prisma.purchaseOrder.findMany({ include: poInclude, orderBy: { createdAt: "desc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(orders);
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

    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});

purchaseOrdersRouter.get("/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const order = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id }, include: poInclude });
    if (!order) return res.status(404).json({ error: "Purchase order not found" });
    res.json(order);
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

    res.json(updated);
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
    const updated = await prisma.purchaseOrder.update({
      where: { id: req.params.id },
      data: { status, rejectionReason: status === "REJECTED" ? rejectionReason : null, reviewedById: req.user!.id, reviewedAt: new Date() },
      include: poInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: status === "APPROVED" ? "purchase_order.approved" : "purchase_order.rejected", entityType: "PurchaseOrder", entityId: updated.id });

    res.json(updated);
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
      const item = await prisma.purchaseOrderItem.findUnique({ where: { id: req.params.itemId } });
      if (!item || item.purchaseOrderId !== req.params.id) return res.status(404).json({ error: "Line item not found" });

      const data = req.body as UpdatePurchaseOrderItemInput;
      const updated = await prisma.purchaseOrderItem.update({ where: { id: req.params.itemId }, data });

      await recordAudit({ actorId: req.user!.id, action: "purchase_order.item_updated", entityType: "PurchaseOrder", entityId: req.params.id, metadata: { itemId: updated.id } });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

purchaseOrdersRouter.delete("/:id/items/:itemId", requireRole("BD"), async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
  try {
    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: req.params.itemId } });
    if (!item || item.purchaseOrderId !== req.params.id) return res.status(404).json({ error: "Line item not found" });

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
