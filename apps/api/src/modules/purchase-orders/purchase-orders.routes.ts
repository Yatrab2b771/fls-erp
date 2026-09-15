import { Router } from "express";
import multer, { MulterError } from "multer";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { detectFileType, resolveStoragePath, saveUploadedFile } from "../../common/lib/storage";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { buildPurchaseOrderPdf } from "./po-pdf";
import {
  createPurchaseOrderSchema,
  generatePoInvoiceSchema,
  importPurchaseOrdersSchema,
  reviewPurchaseOrderSchema,
  updatePurchaseOrderItemSchema,
  updatePurchaseOrderSchema,
  type CreatePurchaseOrderInput,
  type GeneratePoInvoiceInput,
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

const poInclude = {
  customer: { select: { id: true, companyName: true } },
  reviewedBy: { select: { id: true, fullName: true } },
  items: {
    // deletedAt: null — a soft-deleted line item drops out of the PO the
    // instant it's removed, same as before, just recoverable now.
    where: { deletedAt: null },
    include: {
      // Lightweight summaries only — full plan detail (items, calculated
      // result) is fetched on-demand from the BOM/RM Costing pages
      // themselves; here we just need enough to render a status chip and
      // a link from the order/product view (the "Production Pipeline"
      // strip that ties all four modules together).
      bomPlans: { select: { id: true, name: true, status: true }, orderBy: { createdAt: "desc" } },
      rmPlans: { select: { id: true, name: true, status: true }, orderBy: { createdAt: "desc" } },
      // Just enough to compute completion below (and to know whether
      // production has started at all, for the delete guard further
      // down) — not the run's full record, that's what GET
      // /api/pre-productions/:id is for. PreProduction is 1:1 with a PO
      // item now, so this is at most one row, not a list.
      preProduction: { select: { id: true, combinedLot: { select: { currentStageId: true, dispatchDate: true } } } },
    },
    orderBy: { createdAt: "asc" },
  },
  // deletedAt: null — same reasoning as items above.
  documents: { where: { deletedAt: null }, select: { id: true, filename: true, mimeType: true, uploadedAt: true, uploadedById: true } },
} satisfies Prisma.PurchaseOrderInclude;

type PoWithBatches = Prisma.PurchaseOrderGetPayload<{ include: typeof poInclude }>;

// A PO is "completed" once every line item's PreProduction run has
// actually pooled into a CombinedLot and that lot has reached the end of
// its own pipeline — DISPATCH_PLAN — same "done" definition the
// Dashboard's own active-batch count already uses (see DashboardPage.tsx
// activeBatches), just re-derived for the three-tier pipeline: an item
// with no PreProduction yet (production hasn't started) or a
// PreProduction still short of its plannedQty (no CombinedLot yet) both
// count as "not completed". Computed on read, never stored — same rule
// as every other derived number in this app. completionDate is the
// latest dispatchDate across those lots (the business-entered ship date
// at that stage, not a technical row-update timestamp), and daysTaken is
// the whole-day span from the PO's own orderDate (falling back to when
// it was entered, if BD never filled in an order date).
function computeCompletion(po: PoWithBatches): { isCompleted: boolean; completionDate: string | null; daysTaken: number | null } {
  if (po.items.length === 0) return { isCompleted: false, completionDate: null, daysTaken: null };

  const lots = po.items.map((item) => item.preProduction?.combinedLot ?? null);
  const isCompleted = lots.every((lot) => lot?.currentStageId === "DISPATCH_PLAN");
  if (!isCompleted) return { isCompleted: false, completionDate: null, daysTaken: null };

  const dispatchDates = lots.map((lot) => lot!.dispatchDate).filter((d): d is Date => d !== null);
  if (dispatchDates.length === 0) return { isCompleted: true, completionDate: null, daysTaken: null }; // reached Dispatch Plan, but Dispatch never filled in a ship date to measure from

  const completionDate = new Date(Math.max(...dispatchDates.map((d) => d.getTime())));
  const startDate = po.orderDate ?? po.createdAt;
  const daysTaken = Math.round((completionDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

  return { isCompleted: true, completionDate: completionDate.toISOString(), daysTaken };
}

function serializePo(po: PoWithBatches) {
  // preProduction was only fetched to compute completion — strip it back
  // out of each item before responding, same "don't leak the query's
  // working data into the API shape" reasoning as everywhere else.
  return { ...po, items: po.items.map(({ preProduction: _preProduction, ...item }) => item), completion: computeCompletion(po) };
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
purchaseOrdersRouter.get("/reports/bd-ppic", requireRole("BD", "PPIC"), async (_req, res, next) => {
  try {
    const orders = await prisma.purchaseOrder.findMany({
      where: { status: { not: "REJECTED" } },
      select: {
        poNumber: true,
        orderDate: true,
        createdAt: true,
        customer: { select: { companyName: true } },
        items: {
          where: { deletedAt: null },
          select: {
            productName: true,
            quantity: true,
            unit: true,
            preProduction: { select: { combinedLot: { select: { dispatchedQty: true, dispatchDate: true } } } },
            rmPlans: {
              where: { status: "CALCULATED" },
              orderBy: { calculatedAt: "desc" },
              take: 1,
              select: { resultSnapshot: true },
            },
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

        const snapshot = item.rmPlans[0]?.resultSnapshot as { batches?: { packSizeG?: number; pricePerPouch?: number }[] } | null | undefined;
        const batchResult = snapshot?.batches?.[0];
        let value: number | null = null;
        if (batchResult?.packSizeG && batchResult?.pricePerPouch) {
          const estimatedPouches = round((dispatchedQtyKg * 1000) / batchResult.packSizeG);
          value = round(estimatedPouches * batchResult.pricePerPouch);
        }

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
          value,
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
        items: { create: items.map((item, idx) => ({ ...item, createdAt: new Date(baseCreatedAt + idx) })) },
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

// --- PO-level consolidated Billing — separate from each Batch's own
// Billing & E-Way Bill stage (that one's per-shipment paperwork:
// invoiceNo/ewayBillNo). This is the whole-PO commercial amount, per the
// client: one PO can carry several products/batches and Accounts wants
// one number for the lot.
//
// Per item: Price per Pouch (from that item's own, latest CALCULATED RM
// Costing plan) x estimated pouches shipped. "Estimated pouches" isn't
// dispatchedQty itself — dispatchedQty is recorded in the same unit as
// the PO item (Kg, since RM Costing only ever runs for Kg-unit items —
// see rm-plan.routes.ts's own isKgUnit gate), so it's converted via the
// same plan's packSizeG (grams per pouch): dispatchedKg * 1000 /
// packSizeG. An item with no CALCULATED RM Costing plan (a BOM-only or
// pouch-unit product) simply can't be priced this way yet — its line
// carries amount: null and priced: false, and is left out of the total
// rather than guessed at. ---

async function computePoBilling(purchaseOrderId: string) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    select: {
      id: true,
      poNumber: true,
      items: {
        where: { deletedAt: null },
        select: {
          id: true,
          productName: true,
          unit: true,
          preProduction: { select: { combinedLot: { select: { dispatchedQty: true } } } },
          rmPlans: {
            where: { status: "CALCULATED" },
            orderBy: { calculatedAt: "desc" },
            take: 1,
            select: { resultSnapshot: true },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!po) return null;

  const round = (n: number) => Math.round(n * 100) / 100;

  const lines = po.items.map((item) => {
    const dispatchedQtyKg = round(item.preProduction?.combinedLot?.dispatchedQty ?? 0);
    const snapshot = item.rmPlans[0]?.resultSnapshot as { batches?: { packSizeG?: number; pricePerPouch?: number }[] } | null | undefined;
    const batchResult = snapshot?.batches?.[0];

    if (!batchResult?.packSizeG || !batchResult?.pricePerPouch) {
      return {
        purchaseOrderItemId: item.id,
        productName: item.productName,
        unit: item.unit,
        dispatchedQtyKg,
        packSizeG: null,
        pricePerPouch: null,
        estimatedPouches: null,
        amount: null,
        priced: false,
      };
    }

    const estimatedPouches = round((dispatchedQtyKg * 1000) / batchResult.packSizeG);
    const amount = round(estimatedPouches * batchResult.pricePerPouch);

    return {
      purchaseOrderItemId: item.id,
      productName: item.productName,
      unit: item.unit,
      dispatchedQtyKg,
      packSizeG: batchResult.packSizeG,
      pricePerPouch: batchResult.pricePerPouch,
      estimatedPouches,
      amount,
      priced: true,
    };
  });

  const totalAmount = round(lines.reduce((sum, l) => sum + (l.amount ?? 0), 0));
  return { poId: po.id, poNumber: po.poNumber, lines, totalAmount };
}

// Live preview — recomputes off current data every call, doesn't touch
// the saved invoice (if one already exists it's returned alongside, so
// the UI can show "this is what's saved" vs "this is what it'd be now").
// Pricing data, same visibility rule as item-pricing.ts.
purchaseOrdersRouter.get("/:id/billing", requireRole("PURCHASE", "ACCOUNTS"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const preview = await computePoBilling(req.params.id);
    if (!preview) return res.status(404).json({ error: "Purchase order not found" });
    const saved = await prisma.purchaseOrderInvoice.findUnique({ where: { purchaseOrderId: req.params.id }, include: { generatedBy: { select: { fullName: true, email: true } } } });
    res.json({ ...preview, invoice: saved });
  } catch (err) {
    next(err);
  }
});

// Generate/regenerate the saved invoice — Accounts-only (Purchase can see
// the preview above, only Accounts commits it). A repeat call overwrites
// the previous snapshot with a fresh computation, same "recalculating
// re-opens it" reasoning as BomPlan/RmPlan's own Calculate.
purchaseOrdersRouter.post("/:id/billing", requireRole("ACCOUNTS"), validateBody(generatePoInvoiceSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const computed = await computePoBilling(req.params.id);
    if (!computed) return res.status(404).json({ error: "Purchase order not found" });

    const { invoiceNo, invoiceDate } = req.body as GeneratePoInvoiceInput;
    const invoice = await prisma.purchaseOrderInvoice.upsert({
      where: { purchaseOrderId: req.params.id },
      create: {
        purchaseOrderId: req.params.id,
        invoiceNo,
        invoiceDate,
        totalAmount: computed.totalAmount,
        lineItems: computed.lines as unknown as Prisma.InputJsonValue,
        generatedById: req.user!.id,
      },
      update: {
        invoiceNo,
        invoiceDate,
        totalAmount: computed.totalAmount,
        lineItems: computed.lines as unknown as Prisma.InputJsonValue,
        generatedById: req.user!.id,
      },
      include: { generatedBy: { select: { fullName: true, email: true } } },
    });

    await recordAudit({
      actorId: req.user!.id,
      action: "purchase_order.invoice_generated",
      entityType: "PurchaseOrder",
      entityId: req.params.id,
      metadata: { totalAmount: computed.totalAmount, lineCount: computed.lines.length },
    });

    res.status(201).json({ ...computed, invoice });
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
      const item = await prisma.purchaseOrderItem.findUnique({ where: { id: req.params.itemId }, include: { preProduction: { select: { id: true } } } });
      if (!item || item.purchaseOrderId !== req.params.id) return res.status(404).json({ error: "Line item not found" });

      const data = req.body as UpdatePurchaseOrderItemInput;
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
