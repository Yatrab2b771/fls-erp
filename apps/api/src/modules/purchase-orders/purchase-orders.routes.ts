import { Router } from "express";
import multer, { MulterError } from "multer";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, parseSearch, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { detectFileType, resolveStoragePath, saveUploadedFile } from "../../common/lib/storage";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { buildPurchaseOrderPdf } from "./po-pdf";
import { getPoFullReport } from "./po-full-report";
import { buildPoFullReportPdf } from "./po-full-report-pdf";
import { getPendingPoMaterials } from "./pending-materials";
import { getMaterialPlanning } from "./material-planning";
import { autoCalculateAfterRelease } from "./auto-calculate";
import { loadOrderConversion } from "./order-conversion";
import { syncShortToPurchaseSafe } from "./purchase-sync";
import { cancelPoItem } from "./cancel-item";
import { notifyProductionOfProductHold } from "./hold-notify";
import { raiseRequestsForPlannedItemSafe, notifyPlantDayStore } from "../inventory/plan-requests";
import { getPoStats } from "./po-stats";
import { getPoItemPlanAvailability } from "../planning/add-on-plan";
import { canSeeUnapprovedPos, poVisibilityWhere } from "./po-visibility";
import { poInclude, computeCompletion, computeItemDispatch, type PoWithBatches } from "./po-completion";
import { productionStageOf } from "../ppic/production-stage";
import { agingRanges, dateRange, readFilters, type DateRange } from "../ppic/ppic-filters";
import {
  createPurchaseOrderSchema,
  createProductCategorySchema,
  importPurchaseOrdersSchema,
  reviewPurchaseOrderSchema,
  updatePurchaseOrderItemSchema,
  assignPlannedPlantSchema,
  regulatoryReviewSchema,
  setMaterialHoldSchema,
  cancelItemSchema,
  setRegulatoryBodySchema,
  updatePurchaseOrderSchema,
  type CreatePurchaseOrderInput,
  type CreateProductCategoryInput,
  type ImportPurchaseOrdersInput,
  type ReviewPurchaseOrderInput,
  type UpdatePurchaseOrderInput,
  type UpdatePurchaseOrderItemInput,
  type AssignPlannedPlantInput,
  type RegulatoryReviewInput,
  type SetMaterialHoldInput,
  type CancelItemInput,
  type SetRegulatoryBodyInput,
} from "./purchase-orders.schemas";
import type { Prisma } from "@prisma/client";

export const purchaseOrdersRouter = Router();

purchaseOrdersRouter.use(requireAuth);

// Photo or PDF only, per the intake form's "Upload" control — matches how
// a PO is actually received (a scan or a forwarded PDF), nothing else.
//
// No fileFilter here on purpose: the field the browser sends as
// `file.mimetype` is just the multipart part's Content-Type header, which
// the uploader fully controls — a curl/Postman/Burp request can label
// anything (an .exe, a script) "application/pdf" and walk straight past a
// check like that. The real gate is `detectFileType()` below, which reads
// the actual bytes multer buffered in memory. Only the byte count (20MB
// cap) is enforced up front, since that's a genuine request-level limit,
// not a claim the client can lie about.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
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

function serializePo(po: PoWithBatches) {
  // preProduction was only fetched to compute completion — strip it back
  // out of each item before responding, same "don't leak the query's
  // working data into the API shape" reasoning as everywhere else.
  // Each product also says how much of its own order has been dispatched, so a product shows as complete on its own (BD's Completed Products).
  const items = po.items.map((full) => {
    const { preProduction: _preProduction, ...item } = full;
    const d = computeItemDispatch(full);
    const completionDate = d.dispatchDates.length ? new Date(Math.max(...d.dispatchDates.map((x) => x.getTime()))).toISOString() : null;
    // Where the product is once it has been sent to Production (null before that): the same rule the data check and every list use.
    const productionStage = productionStageOf({
      planSentToProductionAt: full.planSentToProductionAt,
      quantity: full.quantity,
      requiredQty: full.closedShortAt ? full.closedShortQty : null,
      batches: (full.preProduction?.productionBatches ?? []).map((b) => ({ currentStageId: b.currentStageId, prepStageId: b.prepStageId, handedOverToDispatchAt: b.handedOverToDispatchAt, customerShippedQty: Math.max(0, b.fgShipments.reduce((a, s) => a + s.quantity, 0) - b.customerReturns.reduce((a, r) => a + r.quantity, 0)) })),
    });
    return { ...item, productionStage, dispatch: { dispatchedQty: d.dispatchedQty, isCompleted: d.isDone, completionDate: d.isDone ? completionDate : null } };
  });
  return { ...po, items, completion: computeCompletion(po) };
}

// Matches each requested Product Category name against the master list
// (case-insensitive) and returns the canonical spelling, so "powder" and
// "Powder" can't become two different values on PO lines. Anything not in
// the master list comes back in `unknown` — the caller 400s rather than
// silently creating a category (that's what POST /product-categories is for).
async function resolveProductCategories(names: string[]) {
  const master = await prisma.productCategory.findMany({ select: { name: true } });
  const byLower = new Map(master.map((c) => [c.name.toLowerCase(), c.name]));
  const canonical = new Map<string, string>();
  const unknown: string[] = [];
  for (const name of new Set(names.map((n) => n.trim()))) {
    const hit = byLower.get(name.toLowerCase());
    if (hit) canonical.set(name.toLowerCase(), hit);
    else unknown.push(name);
  }
  return { canonical: (name: string) => canonical.get(name.trim().toLowerCase())!, unknown };
}

// Dropdown source for the PO forms' Product Category field — open to any
// authenticated user, same as the PO reads below.
purchaseOrdersRouter.get("/product-categories", async (_req, res, next) => {
  try {
    res.json(await prisma.productCategory.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, name: true } }));
  } catch (err) {
    next(err);
  }
});

// "+ Add new product category" from the PO form. Idempotent on a
// case-insensitive name match: adding "powder" when "Powder" exists returns
// the existing row (200) instead of a duplicate or an error, since the
// caller's real intent — "make this one selectable" — is already satisfied.
purchaseOrdersRouter.post("/product-categories", requireRole("BD"), validateBody(createProductCategorySchema), async (req: AuthedRequest, res, next) => {
  try {
    const { name } = req.body as CreateProductCategoryInput;
    const existing = await prisma.productCategory.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true, name: true } });
    if (existing) return res.json(existing);

    const created = await prisma.productCategory.create({ data: { name, createdById: req.user!.id }, select: { id: true, name: true } });
    await recordAudit({ actorId: req.user!.id, action: "product_category.created", entityType: "ProductCategory", entityId: created.id, metadata: { name } });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// Only BD/Admin can see a PO that hasn't been approved (Draft) or was
// rejected — every other department only ever sees Approved POs. This
// runs for every route below with an `:id`, so a direct link, the PDF, the
// full report, billing, planning actions... all 404 for a non-BD/Admin
// user on an unapproved PO, exactly as if it didn't exist. (Unknown ids
// fall through to each route's own 404.)
purchaseOrdersRouter.param("id", async (req, res, next, id) => {
  try {
    if (canSeeUnapprovedPos((req as AuthedRequest).user?.roles)) return next();
    const po = await prisma.purchaseOrder.findUnique({ where: { id }, select: { status: true } });
    if (po && po.status !== "APPROVED") return res.status(404).json({ error: "Purchase order not found" });
    next();
  } catch (err) {
    next(err);
  }
});

// Order Tracking's tiles over every PO the caller may see (see po-stats.ts).
purchaseOrdersRouter.get("/summary", async (req: AuthedRequest, res, next) => {
  try {
    res.json(await getPoStats(poVisibilityWhere(req.user?.roles)));
  } catch (err) {
    next(err);
  }
});

// Read is open to any authenticated user, but non-BD/Admin only get
// Approved POs (see poVisibilityWhere); only BD/Admin write.
// ?search= matches PO number, customer, or any live product's name / category
// on the server; paginated with ?page=&pageSize= (X-Total-Count = matches).
purchaseOrdersRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const pagination = parsePagination(req);
    const search = parseSearch(req);
    // The filter bar: customers picked by name, and the PO's age in whole days (Aging buckets) counted from its order date (entry date when it has none)
    const filters = readFilters(req);
    const orderedWithin = (range: DateRange): Prisma.PurchaseOrderWhereInput => ({ OR: [{ orderDate: range }, { orderDate: null, createdAt: range }] });
    const aging = agingRanges(filters);
    const dates = dateRange(filters);
    const visible: Prisma.PurchaseOrderWhereInput = {
      AND: [
        poVisibilityWhere(req.user?.roles),
        ...(filters.customer.length ? [{ customer: { companyName: { in: filters.customer } } }] : []),
        ...(aging ? [{ OR: aging.map(orderedWithin) }] : []),
        ...(dates ? [orderedWithin(dates)] : []),
        ...(search
          ? [
              {
                OR: [
                  { poNumber: { contains: search, mode: "insensitive" as const } },
                  { customer: { companyName: { contains: search, mode: "insensitive" as const } } },
                  {
                    items: {
                      some: {
                        deletedAt: null,
                        OR: [{ productName: { contains: search, mode: "insensitive" as const } }, { productCategory: { contains: search, mode: "insensitive" as const } }],
                      },
                    },
                  },
                ],
              },
            ]
          : []),
      ],
    };
    const [total, orders] = await Promise.all([
      prisma.purchaseOrder.count({ where: visible }),
      prisma.purchaseOrder.findMany({ where: visible, include: poInclude, orderBy: { createdAt: "desc" }, skip: pagination.skip, take: pagination.take }),
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
// Wastage is now a per-ProductionBatch number (Tier 2 — several small
// manufacturing runs can exist per PreProduction), never stored
// (schema.prisma: derived inputQty - outputQty, see batch.engine.ts
// computeWastage) — recomputed here the same way. mfgRejectedQty moved
// to CombinedLot (Tier 3 — QC's own quality-rejection figure against the
// pooled lot, independent of any one run's wastage), so this report now
// reads both tiers and reports each ProductionBatch's own wastage
// alongside its parent lot's rejection figure. A run with neither set
// yet (still mid-pipeline) is left out — nothing to report until
// Production/QC have actually entered those numbers.
purchaseOrdersRouter.get("/reports/wastage-rejection", async (_req, res, next) => {
  try {
    const runs = await prisma.productionBatch.findMany({
      where: { inputQty: { not: null } },
      select: {
        id: true,
        batchNo: true,
        inputQty: true,
        outputQty: true,
        preProduction: {
          select: {
            purchaseOrderItem: {
              select: { productName: true, unit: true, purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } } },
            },
            combinedLot: { select: { mfgRejectedQty: true } },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    const rows = runs.map((b) => ({
      customerName: b.preProduction.purchaseOrderItem.purchaseOrder.customer.companyName,
      poNumber: b.preProduction.purchaseOrderItem.purchaseOrder.poNumber ?? b.preProduction.purchaseOrderItem.purchaseOrder.id.slice(0, 8),
      productName: b.preProduction.purchaseOrderItem.productName,
      batchNo: b.batchNo,
      unit: b.preProduction.purchaseOrderItem.unit,
      inputQty: b.inputQty,
      outputQty: b.outputQty,
      wastageQty: b.inputQty !== null && b.outputQty !== null ? Math.max(0, b.inputQty - b.outputQty) : null,
      mfgRejectedQty: b.preProduction.combinedLot?.mfgRejectedQty ?? null,
    }));

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// BD & PPIC's own download report — one row per PO line item, columns
// matching their shared Excel template exactly (PO No./PO Date/
// Customer/Product Name/Qty/Dispatch Qty/Dispatch Date/Value/Ageing/
// Remarks). Rejected POs are left out — same "not actually pending on
// anything" reasoning as the aging report above. Value reuses
// computePoBilling's own per-item pricing (Price per Pouch x estimated
// pouches shipped, from the item's latest CALCULATED RM Costing plan) —
// null/blank for an item that isn't priced yet, never guessed at.
// Ageing is measured from PO Date (falling back to createdAt) through to
// Dispatch Date once the item has one, or through to today if it's
// still in flight — so a shipped item's age freezes the day it went out
// instead of continuing to climb. Remarks has no backing field yet, so
// it comes back blank for every row — same as the template's own sample
// data — ready for BD/PPIC to fill in by hand after download.
// Pending PO Report — one row per product on every still-pending PO
// (same "pending" definition as the dashboard's own Pending POs tile),
// with each product's own required RM/PM materials and whether live
// stock covers them. See pending-materials.ts for how this differs from
// po-readiness's own PO Material Requirement engine.
purchaseOrdersRouter.get("/reports/pending-materials", requireRole("PPIC"), async (_req, res, next) => {
  try {
    res.json(await getPendingPoMaterials());
  } catch (err) {
    next(err);
  }
});

// Material Planning — every planned product's raw/packaging materials with
// how much live stock covers vs. how much is short, allocated FIFO across
// products (see material-planning.ts).
purchaseOrdersRouter.get("/reports/material-planning", requireRole("PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const planning = await getMaterialPlanning();
    // Opening the list also brings the shortfall requirements already sent to
    // Purchase back in line with it (see purchase-sync.ts).
    await syncShortToPurchaseSafe(req.user?.id ?? null, req.log, planning);
    res.json(planning);
  } catch (err) {
    next(err);
  }
});

purchaseOrdersRouter.get("/reports/bd-ppic", requireRole("BD", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const orders = await prisma.purchaseOrder.findMany({
      // BD/Admin still see their own Drafts here; PPIC only Approved.
      where: canSeeUnapprovedPos(req.user?.roles) ? { status: { not: "REJECTED" } } : { status: "APPROVED" },
      select: {
        poNumber: true,
        orderDate: true,
        createdAt: true,
        customer: { select: { companyName: true } },
        items: {
          where: { deletedAt: null, cancelledAt: null },
          select: {
            productName: true,
            quantity: true,
            unit: true,
            preProduction: { select: { combinedLot: { select: { dispatchedQty: true, dispatchDate: true } } } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const round = (n: number) => Math.round(n * 100) / 100;
    const dayMs = 1000 * 60 * 60 * 24;
    const now = Date.now();

    const rows = orders.flatMap((po) =>
      po.items.map((item) => {
        const lot = item.preProduction?.combinedLot ?? null;
        const dispatchedQtyKg = round(lot?.dispatchedQty ?? 0);
        const dispatchDate = lot?.dispatchDate ?? null;

        const startDate = po.orderDate ?? po.createdAt;
        const ageingEnd = dispatchDate ?? new Date(now);
        const ageingDays = Math.max(0, Math.round((ageingEnd.getTime() - startDate.getTime()) / dayMs));

        return {
          poNumber: po.poNumber,
          poDate: po.orderDate,
          customerName: po.customer.companyName,
          productName: item.productName,
          quantity: item.quantity,
          unit: item.unit,
          dispatchedQty: dispatchedQtyKg,
          dispatchDate,
          ageingDays,
        };
      }),
    );

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

    const cats = await resolveProductCategories(items.map((i) => i.productCategory));
    if (cats.unknown.length) return res.status(400).json({ error: `Unknown Product Category: ${cats.unknown.join(", ")}` });

    // Explicit, strictly-increasing createdAt per item — a nested create
    // all runs inside one transaction, and Postgres's now() returns the
    // *transaction's* start time for every row in it, not a fresh
    // per-row timestamp. Left to @default(now()), every item in this PO
    // would get the exact same createdAt, making poInclude's
    // `items: { orderBy: { createdAt: "asc" } }` a tie — Postgres is
    // free to return tied rows in either order, so the item list (and
    // this order.body.items[0]/[1] indexing every caller relies on)
    // would occasionally come back shuffled. A 1ms-apart synthetic
    // timestamp per item, in submission order, makes that ordering real
    // instead of a coin flip.
    const baseCreatedAt = Date.now();
    const order = await prisma.purchaseOrder.create({
      data: {
        customerId,
        ...rest,
        createdById: req.user!.id,
        items: { create: items.map((item, idx) => ({ ...item, productCategory: cats.canonical(item.productCategory), createdAt: new Date(baseCreatedAt + idx) })) },
      },
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

    const cats = await resolveProductCategories(rows.map((r) => r.productCategory));
    if (cats.unknown.length) return res.status(400).json({ error: `Unknown Product Category in import: ${cats.unknown.join(", ")}. Add it first from the PO form, or fix the sheet.` });

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
          orderDate: first.orderDate,
          expectedDeliveryDate: first.expectedDeliveryDate,
          regulatoryBody: first.regulatoryBody,
          regulatoryStatus: first.regulatoryStatus,
          createdById: req.user!.id,
          // Explicit, strictly-increasing createdAt per item — same
          // "a nested create's rows would otherwise tie on now()"
          // reasoning as the manual-form POST / above.
          items: {
            create: groupRows.map((r, idx) => ({
              productName: r.productName,
              productCategory: cats.canonical(r.productCategory),
              dosageForm: r.dosageForm,
              quantity: r.quantity,
              unit: r.unit,
              volume: r.volume,
              packSize: r.packSize,
              packType: r.packType,
              createdAt: new Date(Date.now() + idx),
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

// The full, step-by-step story of this PO — every product line, its
// PreProduction run's own Tier-1 walk, and every ProductionBatch under
// it with its own Tier-2 execution + Tier-3 walk, each with field values
// and full stage history. See po-full-report.ts's own comment for why
// this exists separately from the older /reconciliation and
// batch-report-pdf.ts (legacy CombinedLot-only) reports. Shared assembler
// backs both this JSON route (the on-screen report page) and the PDF
// export right below it, so they can never drift apart.
purchaseOrdersRouter.get("/:id/full-report", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const report = await getPoFullReport(req.params.id);
    if (!report) return res.status(404).json({ error: "Purchase order not found" });
    res.json(report);
  } catch (err) {
    next(err);
  }
});

purchaseOrdersRouter.get("/:id/full-report.pdf", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const report = await getPoFullReport(req.params.id);
    if (!report) return res.status(404).json({ error: "Purchase order not found" });

    const doc = buildPoFullReportPdf(report);
    await recordAudit({ actorId: req.user!.id, action: "purchase_order.exported_full_report_pdf", entityType: "PurchaseOrder", entityId: report.po.id });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="FLS_PO_Full_Report_${report.po.poNumber ?? report.po.id}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    next(err);
  }
});

// Phase G — a PO-level combined Material Reconciliation, rolling up
// every one of a PO's line items' production run: how much of the PO's
// own ordered qty is actually planned, RM/PM dispensed (Production/
// Sample/Waste — see BatchConsumptionPurpose), how much of the sample
// leg actually went to QC and what it resolved to (Testing/Wastage/
// Rejected — see QcSampleConsumeReason), every small ProductionBatch
// run's own recorded output, the pooled CombinedLot's QA gate
// Rejected/Wastage split (Phase F — see CombinedLot.mfgRejectedQty/
// mfgWastageQty/packRejectedQty/packWastageQty), and finally what
// Dispatch Plan recorded as shipped. One row per line item (a PO's
// PreProduction runs are always scoped to one item, 1:1 now), plus a
// `totals` row summing across every item — same "round every numeric
// field to 3dp" reasoning as inventory.routes.ts's own reconciliation
// report, since this sums the same kind of float ledgers.
purchaseOrdersRouter.get("/:id/reconciliation", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        poNumber: true,
        items: {
          where: { deletedAt: null },
          select: {
            id: true,
            productName: true,
            quantity: true,
            unit: true,
            preProduction: {
              select: {
                id: true,
                plannedQty: true,
                productionBatches: { select: { id: true, batchNo: true, outputQty: true } },
                combinedLot: {
                  select: { currentStageId: true, mfgRejectedQty: true, mfgWastageQty: true, packRejectedQty: true, packWastageQty: true, dispatchedQty: true },
                },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!po) return res.status(404).json({ error: "Purchase order not found" });

    const allPreProductionIds = po.items.map((i) => i.preProduction?.id).filter((id): id is string => id != null);

    const [consumptionRows, qcSentRows, qcConsumedRows] = await Promise.all([
      allPreProductionIds.length > 0
        ? prisma.batchMaterialConsumption.groupBy({ by: ["preProductionId", "purpose"], where: { preProductionId: { in: allPreProductionIds } }, _sum: { quantity: true } })
        : [],
      allPreProductionIds.length > 0
        ? prisma.qcSampleTransfer.groupBy({ by: ["preProductionId"], where: { preProductionId: { in: allPreProductionIds }, direction: "TO_QC", deletedAt: null }, _sum: { quantity: true } })
        : [],
      allPreProductionIds.length > 0
        ? prisma.qcSampleTransaction.groupBy({ by: ["preProductionId", "consumeReason"], where: { preProductionId: { in: allPreProductionIds }, type: "CONSUMED", deletedAt: null }, _sum: { quantity: true } })
        : [],
    ]);

    // Same binary-float-noise reasoning as inventory.routes.ts's own
    // reconciliation report — summing many groupBy results can land on
    // e.g. 1e-14 for what's mathematically exactly 0.
    const round = (n: number) => Math.round(n * 1000) / 1000;

    const consumptionByRun = new Map<string, { production: number; sample: number; waste: number }>();
    for (const r of consumptionRows) {
      const cur = consumptionByRun.get(r.preProductionId) ?? { production: 0, sample: 0, waste: 0 };
      const qty = r._sum.quantity ?? 0;
      if (r.purpose === "SAMPLE") cur.sample += qty;
      else if (r.purpose === "WASTE") cur.waste += qty;
      else cur.production += qty;
      consumptionByRun.set(r.preProductionId, cur);
    }
    const sampleSentByRun = new Map(qcSentRows.map((r) => [r.preProductionId, r._sum.quantity ?? 0]));
    const qcConsumedByRun = new Map<string, { testing: number; wastage: number; rejected: number }>();
    for (const r of qcConsumedRows) {
      const cur = qcConsumedByRun.get(r.preProductionId) ?? { testing: 0, wastage: 0, rejected: 0 };
      const qty = r._sum.quantity ?? 0;
      if (r.consumeReason === "TESTING") cur.testing += qty;
      else if (r.consumeReason === "WASTAGE") cur.wastage += qty;
      else if (r.consumeReason === "REJECTED") cur.rejected += qty;
      qcConsumedByRun.set(r.preProductionId, cur);
    }

    const poItems = po.items;
    type ItemRow = ReturnType<typeof buildItemRow>;
    function buildItemRow(item: (typeof poItems)[number]) {
      const run = item.preProduction;
      const c = run ? (consumptionByRun.get(run.id) ?? { production: 0, sample: 0, waste: 0 }) : { production: 0, sample: 0, waste: 0 };
      const qc = run ? (qcConsumedByRun.get(run.id) ?? { testing: 0, wastage: 0, rejected: 0 }) : { testing: 0, wastage: 0, rejected: 0 };
      const lot = run?.combinedLot ?? null;
      const productionBatches = (run?.productionBatches ?? []).map((b) => ({ batchId: b.id, batchNo: b.batchNo, outputQty: round(b.outputQty ?? 0) }));

      return {
        purchaseOrderItemId: item.id,
        productName: item.productName,
        orderedQty: item.quantity,
        unit: item.unit,
        currentStageId: lot?.currentStageId ?? null,
        plannedQtyTotal: round(run?.plannedQty ?? 0),
        dispensedProduction: round(c.production),
        dispensedSample: round(c.sample),
        dispensedWaste: round(c.waste),
        sampleSentToQc: round(sampleSentByRun.get(run?.id ?? "") ?? 0),
        sampleTestingQty: round(qc.testing),
        sampleWastageQty: round(qc.wastage),
        sampleRejectedQty: round(qc.rejected),
        outputQty: round(productionBatches.reduce((sum, b) => sum + b.outputQty, 0)),
        mfgRejectedQty: round(lot?.mfgRejectedQty ?? 0),
        mfgWastageQty: round(lot?.mfgWastageQty ?? 0),
        packRejectedQty: round(lot?.packRejectedQty ?? 0),
        packWastageQty: round(lot?.packWastageQty ?? 0),
        dispatchedQty: round(lot?.dispatchedQty ?? 0),
        productionBatches,
      };
    }

    const items: ItemRow[] = poItems.map(buildItemRow);

    const totalsKeys = [
      "plannedQtyTotal",
      "dispensedProduction",
      "dispensedSample",
      "dispensedWaste",
      "sampleSentToQc",
      "sampleTestingQty",
      "sampleWastageQty",
      "sampleRejectedQty",
      "outputQty",
      "mfgRejectedQty",
      "mfgWastageQty",
      "packRejectedQty",
      "packWastageQty",
      "dispatchedQty",
    ] as const;
    const totals = Object.fromEntries(totalsKeys.map((k) => [k, round(items.reduce((acc, it) => acc + it[k], 0))])) as Record<(typeof totalsKeys)[number], number>;

    res.json({ poId: po.id, poNumber: po.poNumber, items, totals });
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

// Which regulatory body (FSSAI/AYUSH/...) this PO was actually applied
// against, and its status (Applied/Not Applied/Issued) — BD can set this
// at intake via PATCH /:id above, but Regulatory is the department that
// actually tracks this day to day, so they get their own narrow-scope
// route to set/correct just this field pair (never the rest of the PO),
// right where they're about to Approve/Not Approve a product line below.
purchaseOrdersRouter.patch("/:id/regulatory-body", requireRole("BD", "REGULATORY"), validateBody(setRegulatoryBodySchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Purchase order not found" });

    const data = req.body as SetRegulatoryBodyInput;
    const updated = await prisma.purchaseOrder.update({ where: { id: req.params.id }, data, include: poInclude });

    await recordAudit({ actorId: req.user!.id, action: "purchase_order.regulatory_body_set", entityType: "PurchaseOrder", entityId: updated.id, metadata: data });

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
        // Regulatory is deliberately NOT notified here any more — there's
        // nothing for it to review until PPIC's plan for a product is
        // calculated. It gets its notice then (regulatory-handoff.ts).
      ]);
    } else {
      await notifyUser(updated.createdById, { title: `${poLabel} rejected`, body: rejectionReason, link: `/purchase-orders/${updated.id}` }).catch(notifyFailed("po.rejected.creator"));
    }

    res.json(serializePo(updated));
  } catch (err) {
    next(err);
  }
});

// PPIC's Hold / Release on a product. Held and not fully planned: its plan
// can't be generated. Held and fully planned: it can't be sent to Production
// and stops claiming stock in Material Planning's FIFO queue (Regulatory's
// review is not held). Allowed until Production has started making it (a batch that is READY): after the plan is sent to Production Hold
// stops Production opening or moving the run and making batches. Batches still in preparation are held one by one by Production
// (it is told), see batch-prep.routes.ts.
purchaseOrdersRouter.patch(
  "/:id/items/:itemId/material-hold",
  requireRole("PPIC"),
  validateBody(setMaterialHoldSchema),
  async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
    try {
      const item = await prisma.purchaseOrderItem.findUnique({ where: { id: req.params.itemId }, include: { preProduction: { select: { id: true, _count: { select: { productionBatches: { where: { prepStageId: "READY" } } } } } } } });
      if (!item || item.purchaseOrderId !== req.params.id || item.deletedAt) return res.status(404).json({ error: "Line item not found" });
      if (item.cancelledAt) return res.status(409).json({ error: "This product is cancelled." });
      const { held } = req.body as SetMaterialHoldInput;
      if (held && item.preProduction && item.preProduction._count.productionBatches > 0) {
        return res.status(409).json({ error: "Production has already started making a batch of this product, so it can't be held any more." });
      }

      const updated = await prisma.purchaseOrderItem.update({
        where: { id: item.id },
        data: held ? { materialHeldAt: new Date(), materialHeldById: req.user!.id } : { materialHeldAt: null, materialHeldById: null },
      });
      await recordAudit({ actorId: req.user!.id, action: held ? "purchase_order.item_material_held" : "purchase_order.item_material_released", entityType: "PurchaseOrder", entityId: req.params.id, metadata: { itemId: item.id } });
      // Released: pick up any R&D catalog update that landed while it was held.
      if (!held) {
        const owner = await prisma.purchaseOrder.findUnique({ where: { id: item.purchaseOrderId }, select: { customerId: true } });
        if (owner) await autoCalculateAfterRelease(owner.customerId, item.productName, req.user!.id, req.log).catch((err) => req.log?.error({ err }, "auto-calculate after release failed"));
      }
      await syncShortToPurchaseSafe(req.user!.id, req.log);
      if (!!item.materialHeldAt !== held) await notifyProductionOfProductHold([item.id], held, req.user!.id);
      res.json({ id: updated.id, materialHeldAt: updated.materialHeldAt });
    } catch (err) {
      next(err);
    }
  },
);

// Same, for every product on the PO at once. Products already sent to
// Production with a batch already made are skipped, not errored.
purchaseOrdersRouter.patch("/:id/material-hold", requireRole("PPIC"), validateBody(setMaterialHoldSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const order = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!order) return res.status(404).json({ error: "Purchase order not found" });

    const { held } = req.body as SetMaterialHoldInput;
    const targetWhere = { purchaseOrderId: order.id, deletedAt: null, cancelledAt: null, OR: [{ preProduction: null }, { preProduction: { productionBatches: { none: { prepStageId: "READY" as const } } } }] };
    // Only the products whose hold really changes: Production is told about those
    const changing = await prisma.purchaseOrderItem.findMany({ where: { ...targetWhere, materialHeldAt: held ? null : { not: null } }, select: { id: true } });
    const result = await prisma.purchaseOrderItem.updateMany({
      where: targetWhere,
      data: held ? { materialHeldAt: new Date(), materialHeldById: req.user!.id } : { materialHeldAt: null, materialHeldById: null },
    });
    await notifyProductionOfProductHold(changing.map((i) => i.id), held, req.user!.id);
    await recordAudit({ actorId: req.user!.id, action: held ? "purchase_order.material_held" : "purchase_order.material_released", entityType: "PurchaseOrder", entityId: order.id, metadata: { itemCount: result.count } });
    // Released: pick up any R&D catalog update that landed while they were held.
    if (!held) {
      const owner = await prisma.purchaseOrder.findUnique({ where: { id: order.id }, select: { customerId: true, items: { where: { deletedAt: null, cancelledAt: null }, select: { productName: true } } } });
      for (const it of owner?.items ?? []) {
        await autoCalculateAfterRelease(owner!.customerId, it.productName, req.user!.id, req.log).catch((err) => req.log?.error({ err }, "auto-calculate after release failed"));
      }
    }
    await syncShortToPurchaseSafe(req.user!.id, req.log);
    res.json({ updated: result.count });
  } catch (err) {
    next(err);
  }
});

// "Send short material to Purchase" (Material Planning's Action menu): turns
// the SHORT materials of one product into Pre-Inventory requirements - the
// existing place Purchase works from - already marked as notified, and tells
// Purchase once. requiredQty is stored as live stock + the shortfall, because
// Pre-Inventory judges a shortfall against live stock alone (it doesn't know
// stock is reserved for other products): that way Purchase sees exactly the
// quantity that is really missing. Sending twice doesn't duplicate - a material
// already sent for this product is skipped.
purchaseOrdersRouter.post("/:id/items/:itemId/send-short-to-purchase", requireRole("PPIC"), async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
  try {
    const item = await prisma.purchaseOrderItem.findUnique({
      where: { id: req.params.itemId },
      include: { purchaseOrder: { select: { id: true, poNumber: true } } },
    });
    if (!item || item.purchaseOrderId !== req.params.id || item.deletedAt) return res.status(404).json({ error: "Line item not found" });
    if (item.cancelledAt) return res.status(409).json({ error: "This product is cancelled." });
    if (item.materialHeldAt) return res.status(409).json({ error: "This product is on hold - release it first." });

    const planning = await getMaterialPlanning();
    const shorts = planning.rows.filter((r) => r.purchaseOrderItemId === item.id && r.status === "SHORT");
    if (shorts.length === 0) return res.status(400).json({ error: "Nothing is short for this product right now." });

    const poLabel = item.purchaseOrder.poNumber ?? `PO ${item.purchaseOrder.id.slice(0, 8)}`;
    const note = `Material Planning - ${poLabel} / ${item.productName}`;
    let sent = 0;
    let updated = 0;
    let skipped = 0;
    for (const s of shorts) {
      const inv = await prisma.inventoryItem.findUnique({ where: { category_name: { category: s.type, name: s.material } } });
      if (!inv) {
        skipped += 1;
        continue;
      }
      const requiredQty = Math.round(((s.onHand ?? 0) + (s.shortQty ?? 0)) * 100) / 100;
      const already = await prisma.preInventoryRequirement.findFirst({ where: { itemId: inv.id, sourcePoItemId: item.id, deletedAt: null } });
      if (already) {
        // Already sent. While Purchase hasn't logged a PO, a second click just brings the quantity up to date.
        if (!already.purchaseAt && Math.abs(already.requiredQty - requiredQty) > 0.005) {
          await prisma.preInventoryRequirement.update({ where: { id: already.id }, data: { requiredQty } });
          updated += 1;
        } else {
          skipped += 1;
        }
        continue;
      }
      await prisma.preInventoryRequirement.create({
        data: {
          date: new Date(),
          category: s.type,
          itemId: inv.id,
          unit: s.unit,
          requiredQty,
          note,
          sourcePoItemId: item.id,
          requestedById: req.user!.id,
          purchaseNotifiedAt: new Date(),
        },
      });
      sent += 1;
    }

    if (sent > 0 || updated > 0) {
      await notifyRoles(
        ["PURCHASE"],
        { title: `Shortfall: ${item.productName}`, body: `${poLabel} - ${sent} new, ${updated} updated material shortfall(s), please log a PO.`, link: "/pre-inventory" },
        req.user!.id,
      ).catch((err) => req.log?.error({ err }, "notify failed: purchase_order.short_sent_to_purchase"));
    }
    await recordAudit({ actorId: req.user!.id, action: "purchase_order.item_short_sent_to_purchase", entityType: "PurchaseOrder", entityId: req.params.id, metadata: { itemId: item.id, sent, updated, skipped } });

    res.json({ sent, updated, skipped });
  } catch (err) {
    next(err);
  }
});

// PPIC's Cancel - the product is dead for good (no undo): it drops out of the
// PPIC lists, the stock queue, Regulatory's queue and the PO's completion. The
// row is kept, marked cancelled with who/when/why. Allowed until the first batch is made (Production is stopped, the Day Store's untouched
// material requests for it are dropped). BD (who owns the PO) is told.
purchaseOrdersRouter.patch(
  "/:id/items/:itemId/cancel",
  requireRole("PPIC"),
  validateBody(cancelItemSchema),
  async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
    try {
      const { reason } = req.body as CancelItemInput;
      const updated = await cancelPoItem({ itemId: req.params.itemId, poId: req.params.id, actorId: req.user!.id, reason, by: "PPIC", log: req.log });
      res.json({ id: updated.id, cancelledAt: updated.cancelledAt, cancelReason: updated.cancelReason });
    } catch (err) {
      next(err);
    }
  },
);

// "Add More" — appends one more product line item to an existing PO.
purchaseOrdersRouter.post(
  "/:id/items",
  requireRole("BD"),
  validateBody(createPurchaseOrderSchema.shape.items.element),
  async (req: AuthedRequest<{ id: string }>, res, next) => {
    try {
      const order = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
      if (!order) return res.status(404).json({ error: "Purchase order not found" });

      const cats = await resolveProductCategories([req.body.productCategory]);
      if (cats.unknown.length) return res.status(400).json({ error: `Unknown Product Category: ${cats.unknown.join(", ")}` });

      const item = await prisma.purchaseOrderItem.create({ data: { purchaseOrderId: req.params.id, ...req.body, productCategory: cats.canonical(req.body.productCategory) } });

      await recordAudit({ actorId: req.user!.id, action: "purchase_order.item_added", entityType: "PurchaseOrder", entityId: order.id, metadata: { itemId: item.id } });

      res.status(201).json(item);
    } catch (err) {
      next(err);
    }
  },
);

// How a line's quantity is turned into packs (for the Packaging BOM) and Kg (for the RM BOM), with the working shown.
purchaseOrdersRouter.get("/:id/items/:itemId/conversion", async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
  try {
    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: req.params.itemId }, select: { purchaseOrderId: true, productName: true, quantity: true, unit: true, packSize: true, deletedAt: true, purchaseOrder: { select: { customerId: true } } } });
    if (!item || item.purchaseOrderId !== req.params.id || item.deletedAt) return res.status(404).json({ error: "Line item not found" });
    res.json(await loadOrderConversion(item, item.purchaseOrder.customerId));
  } catch (err) {
    next(err);
  }
});

purchaseOrdersRouter.patch(
  "/:id/items/:itemId",
  requireRole("BD"),
  validateBody(updatePurchaseOrderItemSchema),
  async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
    try {
      const item = await prisma.purchaseOrderItem.findUnique({ where: { id: req.params.itemId }, include: { preProduction: { select: { id: true } } } });
      if (!item || item.purchaseOrderId !== req.params.id) return res.status(404).json({ error: "Line item not found" });

      const data = req.body as UpdatePurchaseOrderItemInput;
      if (data.productCategory) {
        const cats = await resolveProductCategories([data.productCategory]);
        if (cats.unknown.length) return res.status(400).json({ error: `Unknown Product Category: ${cats.unknown.join(", ")}` });
        data.productCategory = cats.canonical(data.productCategory);
      }
      const updated = await prisma.purchaseOrderItem.update({ where: { id: req.params.itemId }, data, include: { preProduction: { select: { id: true } } } });

      // Editing a line item stays allowed even once it has a real
      // PreProduction run against it (unlike deleting it, which is
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
        metadata: { itemId: updated.id, before, after: data, hasPreProduction: item.preProduction != null },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// PPIC's own planning call, made ahead of Production ever creating a run
// — see PurchaseOrderItem.plannedPlantId's own schema comment. Once set,
// PreProduction creation (pre-production.routes.ts POST /) locks onto
// this Plant instead of letting Production choose one; clears back to
// unplanned with plantId: null. Not gated on PO/item status — PPIC can
// plan ahead of approval, or change their mind, right up until
// Production actually creates the run (item.preProduction check mirrors
// every other PO-item edit's own "no real production against it yet"
// guard).
purchaseOrdersRouter.patch(
  "/:id/items/:itemId/planned-plant",
  requireRole("PPIC"),
  validateBody(assignPlannedPlantSchema),
  async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
    try {
      const item = await prisma.purchaseOrderItem.findUnique({
        where: { id: req.params.itemId },
        include: { preProduction: { select: { id: true } }, bomPlans: { where: { status: "CALCULATED" }, select: { id: true }, take: 1 }, rmPlans: { where: { status: "CALCULATED" }, select: { id: true }, take: 1 } },
      });
      if (!item || item.purchaseOrderId !== req.params.id || item.deletedAt) return res.status(404).json({ error: "Line item not found" });
      if (item.preProduction) return res.status(409).json({ error: "Production has already started on this line item — the Plant is locked in." });
      // The Plant can be set or changed only while the product is Not Planned. Once both plans are calculated their
      // material has gone to that Plant's Day Store, so changing it then would leave that material in the wrong place.
      if (item.plannedPlantId && item.bomPlans.length > 0 && item.rmPlans.length > 0) {
        return res.status(409).json({ error: "This product is already planned - its Plant can't be changed any more." });
      }

      const { plantId } = req.body as AssignPlannedPlantInput;
      if (plantId) {
        const plant = await prisma.plant.findUnique({ where: { id: plantId } });
        if (!plant) return res.status(400).json({ error: "Unknown Plant" });
      }

      const updated = await prisma.purchaseOrderItem.update({ where: { id: req.params.itemId }, data: { plannedPlantId: plantId }, include: { plannedPlant: { select: { id: true, name: true } } } });
      // Plans already calculated: the materials now go to this Plant's Day Store.
      if (plantId) await raiseRequestsForPlannedItemSafe(updated.id, req.user!.id, req.log);
      await recordAudit({ actorId: req.user!.id, action: "purchase_order.item_planned_plant_set", entityType: "PurchaseOrder", entityId: req.params.id, metadata: { itemId: updated.id, plantId } });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// Regulatory's own sign-off on one product line — independent of BD's own
// self-declared regulatoryBody/regulatoryStatus on the PO header. This is
// the real hard gate POST /:id/items/:itemId/send-plan-to-production
// below checks — nothing else in the app reads or enforces it.
purchaseOrdersRouter.patch(
  "/:id/items/:itemId/regulatory-review",
  requireRole("REGULATORY"),
  validateBody(regulatoryReviewSchema),
  async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
    try {
      const item = await prisma.purchaseOrderItem.findUnique({ where: { id: req.params.itemId } });
      if (!item || item.purchaseOrderId !== req.params.id || item.deletedAt) return res.status(404).json({ error: "Line item not found" });

      if (item.cancelledAt) return res.status(409).json({ error: "This product was cancelled by PPIC." });
      // Nothing for Regulatory to review until PPIC's plan for this product
      // is calculated — that's what sends it here (see regulatory-handoff.ts).
      if (!item.sentToRegulatoryAt) {
        return res.status(400).json({ error: "This product's plan hasn't been sent to Regulatory yet — it goes automatically once PPIC's plan is calculated." });
      }

      const { status, remarks } = req.body as RegulatoryReviewInput;
      const updated = await prisma.purchaseOrderItem.update({
        where: { id: req.params.itemId },
        data: { regulatoryStatus: status, regulatoryRemarks: remarks, regulatoryReviewedById: req.user!.id, regulatoryReviewedAt: new Date() },
      });

      await recordAudit({
        actorId: req.user!.id,
        action: "purchase_order.item_regulatory_reviewed",
        entityType: "PurchaseOrder",
        entityId: req.params.id,
        metadata: { itemId: updated.id, status, remarks },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// PPIC's own hand-off — the calculated BOM/RM plan Generate produced only
// reaches Production once PPIC explicitly sends it, and only once every
// precondition for that is real: a Plant assigned, at least one plan
// actually CALCULATED (not just Draft), and Regulatory's own Approved
// sign-off on this exact product line. Sets planSentToProductionAt, the
// hard gate POST /pre-productions checks — Production simply cannot open
// a run against this item until this has happened.
purchaseOrdersRouter.post(
  "/:id/items/:itemId/send-plan-to-production",
  requireRole("PPIC", "RND"),
  async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
    try {
      const item = await prisma.purchaseOrderItem.findUnique({
        where: { id: req.params.itemId },
        include: {
          preProduction: { select: { id: true } },
          plannedPlant: { select: { id: true, name: true } },
          bomPlans: { select: { status: true } },
          rmPlans: { select: { status: true } },
        },
      });
      if (!item || item.purchaseOrderId !== req.params.id || item.deletedAt) return res.status(404).json({ error: "Line item not found" });
      // R&D may hand a product over to Production without PPIC only after changing its plan to V1 / V2 (the urgent-production way), and only the whole order.
      const isPpic = req.user!.roles.some((r) => r === "PPIC" || r === "ADMIN");
      if (!isPpic) {
        if (item.activeBomSlot === "DISPLAY") return res.status(403).json({ error: "R&D can send a product to Production only after changing its plan to V1 or V2." });
        if ((req.body as { quantity?: unknown } | undefined)?.quantity != null) return res.status(403).json({ error: "R&D sends the whole order; a part release is PPIC's." });
      }
      // A release can be the whole order or part of it ({ quantity }); PPIC can keep releasing more until the whole order is out.
      const alreadyReleased = item.planSentToProductionAt ? Math.min(item.quantity, item.releasedQty ?? item.quantity) : 0;
      const remainingToRelease = item.quantity - alreadyReleased;
      if (item.planSentToProductionAt && remainingToRelease <= 1e-6) return res.status(409).json({ error: "The whole quantity has already been released to Production for this line item." });
      if (item.preProduction && !item.planSentToProductionAt) return res.status(409).json({ error: "Production has already started on this line item." });
      if (item.cancelledAt) return res.status(409).json({ error: "This product is cancelled." });
      const rawQty = (req.body as { quantity?: unknown } | undefined)?.quantity;
      const partialQty = rawQty === undefined || rawQty === null || rawQty === "" ? null : Number(rawQty);
      if (partialQty !== null && (!Number.isFinite(partialQty) || partialQty <= 0)) return res.status(400).json({ error: "Enter a quantity greater than zero." });
      if (partialQty !== null && partialQty > remainingToRelease + 1e-6) {
        return res.status(400).json({ error: `Only ${Math.round(remainingToRelease * 1000) / 1000} ${item.unit} is left to release (ordered ${item.quantity}, released ${Math.round(alreadyReleased * 1000) / 1000}).` });
      }
      const releaseQty = partialQty ?? remainingToRelease;
      // PPIC's Hold — a held product can't go on to Production until released.
      if (item.materialHeldAt) return res.status(409).json({ error: "This product is on hold — release it before sending its plan to Production." });

      if (!item.plannedPlantId) {
        return res.status(400).json({ error: "Assign a Plant to this product before sending the plan to Production." });
      }

      // Both plans, never just one: half a plan would hide half the material from Material Planning and from the Day Store.
      const rmDone = item.rmPlans.some((p) => p.status === "CALCULATED");
      const bomDone = item.bomPlans.some((p) => p.status === "CALCULATED");
      if (!rmDone || !bomDone) {
        return res.status(400).json({ error: `Calculate the ${!rmDone && !bomDone ? "RM plan and the Packaging BOM plan" : !rmDone ? "RM plan" : "Packaging BOM plan"} for this product before sending it to Production.` });
      }

      if (item.regulatoryStatus !== "Approved") {
        return res.status(400).json({
          error:
            item.regulatoryStatus === "Not Approved"
              ? "Regulatory marked this product Not Approved — the plan can't be sent to Production."
              : "Waiting on Regulatory's approval for this product before the plan can be sent to Production.",
        });
      }

      // Material gate: don't let a product with short raw / packaging material
      // slip into Production by accident. Judged on the same FIFO allocation the
      // Material Planning list shows (only possible once both plans are
      // calculated, which is when the product is in that list). A PARTIAL release skips it: PPIC is choosing how much to start
      // with while the rest of the material is still being bought.
      const planning = partialQty === null ? await getMaterialPlanning() : { rows: [] as Awaited<ReturnType<typeof getMaterialPlanning>>["rows"] };
      const shortages = planning.rows.filter((r) => r.purchaseOrderItemId === item.id && r.status === "SHORT");
      if (shortages.length > 0) {
        return res.status(409).json({
          error: `Material is short for this product - ${shortages.map((s) => `${s.material} (short ${s.shortQty} ${s.unit})`).join(", ")}. It can be sent to Production once everything is covered.`,
          code: "MATERIAL_SHORT",
          shortages: shortages.map((s) => ({ type: s.type, material: s.material, unit: s.unit, requiredQty: s.requiredQty, shortQty: s.shortQty })),
        });
      }

      const newReleased = alreadyReleased + releaseQty;
      const isWhole = newReleased >= item.quantity - 1e-6;
      const updated = await prisma.purchaseOrderItem.update({
        where: { id: item.id },
        // releasedQty stays null once the whole order is out (null = all of it)
        data: { planSentToProductionAt: item.planSentToProductionAt ?? new Date(), releasedQty: isWhole ? null : Math.round(newReleased * 1000) / 1000 },
      });

      await recordAudit({
        actorId: req.user!.id,
        action: "purchase_order.item_plan_sent_to_production",
        entityType: "PurchaseOrder",
        entityId: req.params.id,
        metadata: { itemId: item.id, plantId: item.plannedPlantId, releasedNow: releaseQty, releasedTotal: newReleased, orderQty: item.quantity },
      });

      await notifyRoles(
        ["PRODUCTION"],
        {
          title: `${item.productName} planned for ${item.plannedPlant?.name ?? "production"}`,
          body: isWhole && alreadyReleased === 0 ? "PPIC's plan is ready — Indent Issue can start once material arrives." : `PPIC released ${releaseQty} ${item.unit} (${Math.round(newReleased * 1000) / 1000} of ${item.quantity} ${item.unit} so far).`,
          link: `/purchase-orders/${req.params.id}`,
        },
        req.user!.id,
      ).catch((err) => req.log?.error({ err }, "notify failed: purchase_order.item_plan_sent_to_production"));

      // The Plant's Day Store hears what Production may now start, so it can have the material ready for the GRN.
      if (item.plannedPlantId) {
        const plant = await prisma.plant.findUnique({ where: { id: item.plannedPlantId }, select: { dayStoreId: true } });
        await notifyPlantDayStore(
          plant?.dayStoreId,
          {
            title: `${item.productName} released to Production`,
            body: isWhole && alreadyReleased === 0 ? "The whole order is released. Material must reach the Plant for the Material Received & GRN step." : `${releaseQty} ${item.unit} released (${Math.round(newReleased * 1000) / 1000} of ${item.quantity} ${item.unit} so far). Material for that quantity must reach the Plant.`,
            link: "/my-store/production-requests",
          },
          req.user!.id,
        ).catch((err) => req.log?.error({ err }, "notify failed: plan released to store"));
      }
      await syncShortToPurchaseSafe(req.user!.id, req.log);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// (Regulatory reads it too: it reviews a product by the materials of its plan.)
// Read-only "View" for PPIC's plan-sent list and Production's own drill-
// down into it — what did PPIC actually plan for this one product? Same
// material-availability read the Add on Plan feature does, just resolved
// from a PO line item instead of a Sku/Recipe search (see
// getPoItemPlanAvailability's own comment).
purchaseOrdersRouter.get("/:id/items/:itemId/plan", requireRole("PPIC", "PRODUCTION", "REGULATORY"), async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
  try {
    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: req.params.itemId } });
    if (!item || item.purchaseOrderId !== req.params.id || item.deletedAt) return res.status(404).json({ error: "Line item not found" });

    const plan = await getPoItemPlanAvailability(item.id);
    // How far the run's preparation has got (GRN, Indent, Dispensing, Line Clearance), so the plan view shows it too.
    const prepRun = await prisma.preProduction.findUnique({
      where: { purchaseOrderItemId: item.id },
      select: { currentStageId: true, grnNo: true, grnDate: true, prodIndentSlipSign: true, productionPlanDate: true, rmDispensingDate: true, pmIssuedDate: true, sampleQcStatus: true },
    });
    const preparation = prepRun && { stage: prepRun.currentStageId, grnNo: prepRun.grnNo, grnDate: prepRun.grnDate, indentSlip: prepRun.prodIndentSlipSign, indentDate: prepRun.productionPlanDate, rmDispensingDate: prepRun.rmDispensingDate, pmIssuedDate: prepRun.pmIssuedDate, lineClearance: prepRun.sampleQcStatus };
    // ?released=1 (Production's view): quantities for the part PPIC has released so far, not the whole order.
    const releasedQty = item.planSentToProductionAt ? Math.min(item.quantity, item.releasedQty ?? item.quantity) : item.quantity;
    const factor = item.quantity > 0 ? releasedQty / item.quantity : 1;
    if (req.query.released !== "1" || factor >= 1 - 1e-9) return res.json({ ...plan, preparation, release: { orderQty: item.quantity, releasedQty, unit: item.unit } });
    const scale = <T extends { materials: { requiredQty: number; onHand: number | null; short: boolean; shortfallQty: number }[] }>(d: T | null): T | null =>
      d && {
        ...d,
        materials: d.materials.map((m) => {
          const requiredQty = Math.round(m.requiredQty * factor * 1000) / 1000;
          const short = m.onHand != null && m.onHand < requiredQty;
          return { ...m, requiredQty, short, shortfallQty: short ? Math.round((requiredQty - (m.onHand ?? 0)) * 1000) / 1000 : 0 };
        }),
      };
    res.json({ bom: scale(plan.bom), rm: scale(plan.rm), preparation, release: { orderQty: item.quantity, releasedQty, unit: item.unit } });
  } catch (err) {
    next(err);
  }
});

// PPIC's "Send partial" dialog: how much is left to release and a SUGGESTION of how much the material in hand can cover. It is only
// a suggestion - PPIC can release any quantity up to what is left.
purchaseOrdersRouter.get("/:id/items/:itemId/release-info", requireRole("PPIC"), async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
  try {
    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: req.params.itemId } });
    if (!item || item.purchaseOrderId !== req.params.id || item.deletedAt) return res.status(404).json({ error: "Line item not found" });
    const releasedQty = item.planSentToProductionAt ? Math.min(item.quantity, item.releasedQty ?? item.quantity) : 0;
    const remainingQty = Math.max(0, item.quantity - releasedQty);

    const planning = await getMaterialPlanning();
    const rows = planning.rows.filter((r) => r.purchaseOrderItemId === item.id && r.requiredQty > 0);
    let fraction = 1;
    let limitedBy: string | null = null;
    for (const r of rows) {
      const f = Math.max(0, (r.requiredQty - (r.shortQty ?? 0)) / r.requiredQty);
      if (f < fraction) {
        fraction = f;
        limitedBy = r.material;
      }
    }
    const coverableTotal = rows.length ? fraction * item.quantity : null;
    const suggestedQty = coverableTotal === null ? null : Math.max(0, Math.min(remainingQty, Math.floor((coverableTotal - releasedQty) * 100) / 100));
    res.json({ orderQty: item.quantity, releasedQty, remainingQty, unit: item.unit, suggestedQty, limitedBy });
  } catch (err) {
    next(err);
  }
});

purchaseOrdersRouter.delete("/:id/items/:itemId", requireRole("BD"), async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
  try {
    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: req.params.itemId }, include: { preProduction: { select: { id: true } } } });
    if (!item || item.purchaseOrderId !== req.params.id || item.deletedAt) return res.status(404).json({ error: "Line item not found" });

    // PreProduction.purchaseOrderItemId cascades on delete — this item's
    // own production run (and everything hanging off it: its stage
    // events, consumption ledger, and every ProductionBatch/CombinedLot
    // that grew out of it) would be silently wiped out along with it,
    // even one sitting at Dispatch, fully packaged and QC-approved.
    // There's no confirmation dialog that could make that safe to allow —
    // a line item with real production against it just isn't removable
    // any more, same "it's real ledger history, not a form field"
    // reasoning as everywhere else deletion is locked down in this app.
    if (item.preProduction) {
      return res.status(409).json({
        error: "This line item has a production run against it and can't be removed — deleting it would erase that production history.",
      });
    }

    await prisma.purchaseOrderItem.update({ where: { id: req.params.itemId }, data: { deletedAt: new Date(), deletedById: req.user!.id } });

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

    // Identify the file from its real bytes, not the filename or
    // Content-Type the request claims — see the comment on `upload` above.
    // Anything that isn't actually a PDF or a supported image is rejected
    // here, before it ever touches disk.
    const detected = detectFileType(req.file.buffer);
    if (!detected) {
      return res.status(400).json({ error: "That file isn't a PDF or a supported image (JPEG, PNG, GIF, WEBP, BMP) — the upload was rejected." });
    }

    const storagePath = saveUploadedFile(detected.ext, req.file.buffer);
    const doc = await prisma.purchaseOrderDocument.create({
      data: {
        purchaseOrderId: req.params.id,
        // Original filename is kept only as a display label (and is what
        // downloads back as the Content-Disposition filename) — it never
        // decides the stored extension or MIME type, both of which come
        // from `detected` above.
        filename: req.file.originalname,
        mimeType: detected.mimeType,
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
    if (!doc || doc.purchaseOrderId !== req.params.id || doc.deletedAt) return res.status(404).json({ error: "Document not found" });

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
    if (!doc || doc.purchaseOrderId !== req.params.id || doc.deletedAt) return res.status(404).json({ error: "Document not found" });

    // Soft delete only — the file on disk stays put (see storage.ts)
    // so a Recycle Bin restore has something real to bring back.
    await prisma.purchaseOrderDocument.update({ where: { id: req.params.docId }, data: { deletedAt: new Date(), deletedById: req.user!.id } });

    await recordAudit({ actorId: req.user!.id, action: "purchase_order.document_removed", entityType: "PurchaseOrder", entityId: req.params.id, metadata: { documentId: req.params.docId } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
