import { assertPlantAccess, assertRunDayStoreAccess, getScopedPlantIds } from "../inventory/day-store-access";
import { Router } from "express";
import { productionBlockedByHoldOrCancel } from "../purchase-orders/hold-guards";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { productionBatchInclude, preProductionInclude, serializeProductionBatch, serializePreProduction, type ProductionBatchWithRelations } from "./batch-include";
import { buildBmrReportPdf } from "./bmr-report-pdf";
import { BATCH_LINE_CLEARANCE_ITEMS } from "./batch-checklists";
import {
  assignBatchNoSchema,
  createProductionBatchSchema,
  productionBatchExecutionSchema,
  productionBatchTransitionEnvelopeSchema,
  type AssignBatchNoInput,
  type CreateProductionBatchInput,
  type ProductionBatchExecutionInput,
} from "./batch.schemas";
import { transitionProductionBatchStage } from "./production-batch-transition";
import { utilizationGapMessage, utilizationOfBatches } from "./batch-utilization";
import type { Prisma } from "@prisma/client";

// --- Tier 2 of the three-tier pipeline (see schema.prisma's own comment
// block above ProductionBatch): the small manufacturing runs a
// PreProduction's material actually gets split across, limited by real
// equipment capacity. Creation/execution here is plain CRUD (just
// IN_PROGRESS -> COMPLETED) — the real pipeline (IPQC through Dispatch
// Plan) is each batch's OWN, handled by production-batch-transition.ts
// once a batch is COMPLETED, not a pooled CombinedLot any more (see that
// model's own comment: "combine" stopped being the model per the
// client — every batch packages, gets QC'd, and dispatches on its own).
// Completing a run (POST /:id/complete) just adds its outputQty to the
// parent PreProduction's running combinedQty — a "how much has this item
// produced so far" figure the remaining-quantity rollup still uses,
// nothing more. ---

export const productionBatchesRouter = Router();

productionBatchesRouter.use(requireAuth);

// Every batch, across every PreProduction, COMPLETED ones only — the
// Dashboard's own "everything currently in a batch's own IPQC-through-
// Dispatch pipeline" queue, same "read access open to any authenticated
// user, not paginated" shape as GET /combined-lots. A still-IN_PROGRESS
// batch has nothing here yet (see transitionProductionBatchStage), so
// it's excluded rather than shown sitting at a stage nobody can act on.
productionBatchesRouter.get("/production-batches", async (req: AuthedRequest, res, next) => {
  try {
    // A Plant-limited Production login sees only its own Plant's batches.
    const plantScope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    const batches = await prisma.productionBatch.findMany({
      where: { status: "COMPLETED", ...(plantScope ? { preProduction: { plantId: { in: plantScope } } } : {}) },
      include: productionBatchInclude,
      orderBy: { completedAt: "desc" },
    });
    res.json(batches.map(serializeProductionBatch));
  } catch (err) {
    next(err);
  }
});

const PREP_LABEL: Record<string, string> = { INDENT_ISSUE: "Indent Issue", BATCH_NO: "Batch No (R&D)", DISPENSING: "Dispensing", LINE_CLEARANCE: "Line Clearance", READY: "ready" };

/** From the batch's raw-material Utilization: input = A + B + C + D (what the batch took and accounted for; the E leftover stays in the Plant's stock), output = A (what went into the product). */
async function rawMaterialInputOutput(batchId: string): Promise<{ inputQty: number; outputQty: number }> {
  const rows = await prisma.batchMaterialConsumption.findMany({ where: { productionBatchId: batchId, item: { category: "RM" } }, select: { quantity: true, purpose: true } });
  const a = rows.filter((r) => r.purpose === "PRODUCTION").reduce((sum, r) => sum + r.quantity, 0);
  const used = rows.reduce((sum, r) => sum + r.quantity, 0);
  const q3 = (n: number) => Math.round(n * 1000) / 1000;
  return { inputQty: q3(used), outputQty: q3(a) };
}

// A batch as the screens read it, plus where its Utilization stands: the RM sheet (`utilization`, which gates the end of manufacturing),
// the PM sheet (`utilization.pm`, which gates the end of Packaging) and the plan's materials with what was dispensed for the batch.
const NO_PART = { required: 0, logged: 0, missing: [] as string[], complete: true };
export async function withUtilization(batches: ProductionBatchWithRelations[]) {
  const byRun = new Map<string, ProductionBatchWithRelations[]>();
  for (const b of batches) byRun.set(b.preProductionId, [...(byRun.get(b.preProductionId) ?? []), b]);
  const out = new Map<string, Awaited<ReturnType<typeof utilizationOfBatches>> extends Map<string, infer U> ? U : never>();
  for (const [, list] of byRun) {
    const poItemId = list[0]!.preProduction?.purchaseOrderItem.id;
    if (!poItemId) continue;
    for (const [id, u] of await utilizationOfBatches(poItemId, list.map((b) => ({ id: b.id, plannedQty: b.plannedQty })))) out.set(id, u);
  }
  return batches.map((b) => ({ ...serializeProductionBatch(b), utilization: out.get(b.id) ?? { ...NO_PART, pm: NO_PART, items: [] } }));
}

async function requirePreProduction(preProductionId: string) {
  return prisma.preProduction.findUnique({
    where: { id: preProductionId },
    select: { id: true, purchaseOrderItemId: true, plantId: true, batchFlow: true, plannedQty: true, combinedQty: true, currentStageId: true, sampleQcStatus: true, combinedLot: { select: { id: true } }, purchaseOrderItem: { select: { releasedQty: true } } },
  });
}

// Every small manufacturing run against one PreProduction — Production
// creates these as capacity allows; read access open to any
// authenticated user, same as the rest of the pipeline.
productionBatchesRouter.get("/pre-productions/:preProductionId/production-batches", async (req: AuthedRequest<{ preProductionId: string }>, res, next) => {
  try {
    const runs = await prisma.productionBatch.findMany({
      where: { preProductionId: req.params.preProductionId },
      include: productionBatchInclude,
      orderBy: { createdAt: "asc" },
    });
    res.json(await withUtilization(runs));
  } catch (err) {
    next(err);
  }
});

// Starting a new manufacturing run — Production's call, same as the old
// single-Batch model's creation, just scoped one tier down. Only
// available once the parent PreProduction has actually cleared Sample QC
// Approval (its own terminal stage) — manufacturing can't start on
// material that hasn't been approved yet — and only while there's still
// unplanned quantity left (plannedQty - combinedQty), so the sum of
// every run's own plannedQty can't silently exceed what the parent run
// was ever meant to produce.
productionBatchesRouter.post("/pre-productions/:preProductionId/production-batches", requireRole("PRODUCTION"), async (req: AuthedRequest<{ preProductionId: string }>, res, next) => {
  try {
    const parsed = createProductionBatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { batchNo, plannedQty, shift, manpowerCount, shiftStartAt } = parsed.data as CreateProductionBatchInput;

    const preProduction = await requirePreProduction(req.params.preProductionId);
    if (!preProduction) return res.status(404).json({ error: "Pre-production run not found" });
    await assertPlantAccess(req.user!.id, req.user!.roles, preProduction.plantId);
    const blocked = await productionBlockedByHoldOrCancel(preProduction.purchaseOrderItemId);
    if (blocked) return res.status(409).json({ error: blocked });
    // Sample QC Approval completes in place (see pre-production-stage.ts)
    // — currentStageId alone can't tell "sitting here, not yet reviewed"
    // from "actually Approved", so the literal status is what really
    // gates this, same hard-gate rule the stage itself enforces.
    if (preProduction.currentStageId !== "SAMPLE_QC_APPROVAL" || preProduction.sampleQcStatus !== "Approved") {
      return res.status(400).json({ error: "Production can only start once this run's Sample QC Approval has actually been set to Approved." });
    }
    if (preProduction.combinedLot) {
      return res.status(409).json({ error: "This run has already fully combined into a lot — nothing left to plan." });
    }

    // Only IN_PROGRESS runs' plannedQty count as "still outstanding" here —
    // a COMPLETED run's own plannedQty already spent itself into
    // combinedQty above (see POST /:id/complete), so counting it again
    // here would double-subtract it from what's left to plan.
    const existingBatches = await prisma.productionBatch.aggregate({ where: { preProductionId: preProduction.id, status: "IN_PROGRESS" }, _sum: { plannedQty: true } });
    const alreadyPlanned = existingBatches._sum.plannedQty ?? 0;
    const remaining = preProduction.plannedQty - preProduction.combinedQty - alreadyPlanned;
    if (plannedQty > remaining + 1e-6) {
      return res.status(400).json({ error: `Only ${Math.max(0, Math.round(remaining * 1000) / 1000)} left unplanned on this run — reduce the planned quantity.` });
    }
    // PPIC may have released only part of the order to Production so far: batches can't go beyond what has been released.
    const released = Math.min(preProduction.plannedQty, preProduction.purchaseOrderItem.releasedQty ?? preProduction.plannedQty);
    const releaseLeft = released - preProduction.combinedQty - alreadyPlanned;
    if (plannedQty > releaseLeft + 1e-6) {
      return res.status(400).json({ error: `PPIC has released ${released} of ${preProduction.plannedQty} to Production — only ${Math.max(0, Math.round(releaseLeft * 1000) / 1000)} can be planned until PPIC releases more.` });
    }

    const batch = await prisma.productionBatch.create({
      // The batch has ONE start date-time: it is also its manufacturing start date. In the per-batch flow it starts at Indent Issue (it
      // needs its indent, batch number, Dispensing and Line Clearance before production); otherwise it is ready from the start.
      data: { preProductionId: preProduction.id, batchNo, plannedQty, shift, manpowerCount, shiftStartAt, manufacturingStartDate: shiftStartAt, prepStageId: preProduction.batchFlow ? "INDENT_ISSUE" : "READY", createdById: req.user!.id },
      include: productionBatchInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "production_batch.created", entityType: "ProductionBatch", entityId: batch.id });

    res.status(201).json((await withUtilization([batch]))[0]);
  } catch (err) {
    next(err);
  }
});

async function requireBatch(id: string): Promise<ProductionBatchWithRelations | null> {
  return prisma.productionBatch.findUnique({ where: { id }, include: productionBatchInclude });
}

// Single-run detail fetch — its own Tier-3 pipeline detail page needs a
// clean GET /:id the same shape every other tier in this module has,
// rather than making the frontend dig a batch out of its parent's list.
// The Handover page's list (Production's tile): every batch whose manufacturing is complete and that is still in Production's hands or
// waiting at QA's packaging gate, with where it is now. Once QA passes it, the finished goods are with the Day Store and leave this
// list. Production sees its own Plant's.
productionBatchesRouter.get("/production-batches/handover-board", requireRole("PRODUCTION", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const plantScope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    const batches = await prisma.productionBatch.findMany({
      where: {
        status: "COMPLETED",
        // Only batches that have reached Packaging: at Packaging itself (running, or Completed and ready to hand over) or already handed to QA.
        // A batch still at IPQC / the manufacturing QA gate / Bulk QC has not been packed, so it is not Production's to hand over yet.
        currentStageId: { in: ["PACKAGING", "QA_GATE_PACKAGING"] },
        preProduction: { ...(plantScope ? { plantId: { in: plantScope } } : {}) },
      },
      orderBy: { completedAt: "asc" },
      select: {
        id: true,
        batchNo: true,
        currentStageId: true,
        packagingStatus: true,
        outputQty: true,
        packApprovedQty: true,
        dispatchedQty: true,
        completedAt: true,
        fgStoreReceivedDate: true,
        packagingEndDate: true,
        updatedAt: true,
        preProduction: {
          select: {
            id: true,
            plant: { select: { id: true, name: true } },
            purchaseOrderItem: {
              select: { id: true, productName: true, productCategory: true, unit: true, purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } } },
            },
          },
        },
      },
    });
    res.json(
      batches
        .map((b) => {
          const item = b.preProduction.purchaseOrderItem;
          return {
            batchId: b.id,
            batchNo: b.batchNo,
            itemId: item.id,
            poId: item.purchaseOrder.id,
            poNumber: item.purchaseOrder.poNumber,
            customerName: item.purchaseOrder.customer.companyName,
            productName: item.productName,
            productCategory: item.productCategory,
            unit: item.unit,
            plant: b.preProduction.plant,
            currentStageId: b.currentStageId,
            packagingStatus: b.packagingStatus,
            outputQty: b.outputQty,
            packedQty: b.packApprovedQty,
            dispatchedQty: b.dispatchedQty ?? 0,
            completedAt: b.completedAt,
            fgStoreAt: b.fgStoreReceivedDate,
            // Handed over to QA once it has left Packaging (it then waits at QA's packaging gate).
            handedOverAt: b.currentStageId === "QA_GATE_PACKAGING" ? (b.packagingEndDate ?? b.updatedAt) : null,
          };
        }),
    );
  } catch (err) {
    next(err);
  }
});

// The Production Report's batch-level detail: for every batch its timeline (indent, batch no, dispensing, line clearance, manufacturing,
// the QA gates, packaging, hand-over, dispatch), Packaging's own sheet (shift, manpower, times) and the Utilization of its materials,
// RM and PM apart: what the plan needs for the batch, what the Day Store gave, A used, B waste, C rejected, D sample, E leftover.
// Material used but not in the plan (extra) is listed too and marked. Plant-limited logins see only their own Plant's batches.
productionBatchesRouter.get("/production-batches/report-board", requireRole("PRODUCTION", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const plantScope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    const batches = await prisma.productionBatch.findMany({
      where: { preProduction: { ...(plantScope ? { plantId: { in: plantScope } } : {}) } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        batchNo: true,
        plannedQty: true,
        status: true,
        prepStageId: true,
        currentStageId: true,
        createdAt: true,
        productionPlanDate: true,
        indentSignedAt: true,
        batchNoAllocatedAt: true,
        rmDispensingDate: true,
        pmIssuedDate: true,
        dispensedAt: true,
        grnNo: true,
        lineClearanceStatus: true,
        lineClearanceAt: true,
        lineClearanceChecks: true,
        shift: true,
        manpowerCount: true,
        shiftStartAt: true,
        shiftEndAt: true,
        manufacturingStatus: true,
        manufacturingRemarks: true,
        inputQty: true,
        outputQty: true,
        completedAt: true,
        ipqcStatus: true,
        mfgQaStatus: true,
        mfgApprovedQty: true,
        mfgRejectedQty: true,
        mfgWastageQty: true,
        bulkQcStatus: true,
        packagingShift: true,
        packagingManpowerCount: true,
        packagingStartAt: true,
        packagingEndAt: true,
        packagingStatus: true,
        packagingRemarks: true,
        packApprovedQty: true,
        packRejectedQty: true,
        packWastageQty: true,
        fgStoreReceivedDate: true,
        fgQaStatus: true,
        handedOverToDispatchAt: true,
        invoiceDate: true,
        dispatchDate: true,
        dispatchedQty: true,
        // What went to customers: the batch's own Dispatch Plan (old flow) and the customer shipments Dispatch has sent (new flow).
        fgShipments: { where: { type: "CUSTOMER", status: "DISPATCHED", deletedAt: null }, select: { quantity: true, dispatchDate: true, invoiceDate: true } },
        preProductionId: true,
        preProduction: { select: { purchaseOrderItem: { select: { id: true } } } },
      },
    });
    if (batches.length === 0) return res.json([]);

    const ids = batches.map((b) => b.id);
    const [consumed, returned, leftovers] = await Promise.all([
      prisma.batchMaterialConsumption.groupBy({ by: ["productionBatchId", "itemId", "purpose"], where: { productionBatchId: { in: ids } }, _sum: { quantity: true } }),
      prisma.stockTransfer.groupBy({ by: ["productionBatchId", "itemId"], where: { productionBatchId: { in: ids }, deletedAt: null }, _sum: { quantity: true } }),
      prisma.batchLeftover.groupBy({ by: ["productionBatchId", "itemId"], where: { productionBatchId: { in: ids } }, _sum: { quantity: true } }),
    ]);

    // Plan materials + what was given, per run, from the same source the Utilization gates use.
    const byItem = new Map<string, { id: string; plannedQty: number }[]>();
    for (const b of batches) byItem.set(b.preProduction.purchaseOrderItem.id, [...(byItem.get(b.preProduction.purchaseOrderItem.id) ?? []), { id: b.id, plannedQty: b.plannedQty }]);
    const util = new Map<string, Awaited<ReturnType<typeof utilizationOfBatches>> extends Map<string, infer U> ? U : never>();
    for (const [poItemId, list] of byItem) for (const [id, u] of await utilizationOfBatches(poItemId, list)) util.set(id, u);

    // Usage on materials outside the plan: name them, and add what was dispensed for them.
    const given = await prisma.batchDispensingLine.groupBy({ by: ["productionBatchId", "itemId"], where: { productionBatchId: { in: ids } }, _sum: { quantity: true } });
    const touched = new Set<string>([...consumed.map((c) => c.itemId), ...returned.map((r) => r.itemId), ...leftovers.map((l) => l.itemId), ...given.map((g) => g.itemId)]);
    const itemInfo = new Map((await prisma.inventoryItem.findMany({ where: { id: { in: [...touched] } }, select: { id: true, name: true, category: true, unit: true } })).map((i) => [i.id, i]));
    const q3 = (n: number) => Math.round(n * 1000) / 1000;

    // Extra material (asked from the Day Store outside any plan) is raised for a product, not for a batch: show what was asked and what was
    // issued per product and material next to the batch's own usage of it.
    const extraRequests = await prisma.inventoryRequest.findMany({
      where: { isExtra: true, deletedAt: null, extraForPoItemId: { in: [...byItem.keys()] } },
      select: { itemId: true, extraForPoItemId: true, requestedQty: true, fulfillments: { where: { deletedAt: null }, select: { quantity: true } } },
    });
    const extraBy = new Map<string, { requested: number; issued: number }>();
    for (const r of extraRequests) {
      const key = `${r.extraForPoItemId}::${r.itemId}`;
      const cur = extraBy.get(key) ?? { requested: 0, issued: 0 };
      cur.requested += r.requestedQty;
      cur.issued += r.fulfillments.reduce((sum, f) => sum + f.quantity, 0);
      extraBy.set(key, cur);
    }

    res.json(
      batches.map((b) => {
        const u = util.get(b.id);
        type Row = { itemId: string; itemName: string; category: "RM" | "PM"; unit: string; inPlan: boolean; requiredQty: number; givenQty: number; consumedQty: number; wastedQty: number; rejectedQty: number; sampleQty: number; returnedQty: number };
        const rows = new Map<string, Row>();
        const row = (itemId: string): Row | null => {
          const existing = rows.get(itemId);
          if (existing) return existing;
          const info = itemInfo.get(itemId);
          if (!info) return null;
          const created: Row = { itemId, itemName: info.name, category: info.category === "PM" ? "PM" : "RM", unit: info.unit ?? "", inPlan: false, requiredQty: 0, givenQty: 0, consumedQty: 0, wastedQty: 0, rejectedQty: 0, sampleQty: 0, returnedQty: 0 };
          rows.set(itemId, created);
          return created;
        };
        for (const i of u?.items ?? []) rows.set(i.itemId, { itemId: i.itemId, itemName: i.itemName, category: i.category, unit: i.unit, inPlan: true, requiredQty: i.requiredQty, givenQty: i.givenQty, consumedQty: 0, wastedQty: 0, rejectedQty: 0, sampleQty: 0, returnedQty: 0 });
        for (const g of given) if (g.productionBatchId === b.id) { const r = row(g.itemId); if (r && !r.inPlan) r.givenQty = g._sum.quantity ?? 0; }
        for (const c of consumed) {
          if (c.productionBatchId !== b.id) continue;
          const r = row(c.itemId);
          if (!r) continue;
          const qty = c._sum.quantity ?? 0;
          if (c.purpose === "PRODUCTION") r.consumedQty += qty;
          else if (c.purpose === "WASTE") r.wastedQty += qty;
          else if (c.purpose === "REJECTED") r.rejectedQty += qty;
          else if (c.purpose === "SAMPLE") r.sampleQty += qty;
        }
        for (const t of returned) if (t.productionBatchId === b.id) { const r = row(t.itemId); if (r) r.returnedQty += t._sum.quantity ?? 0; }
        for (const l of leftovers) if (l.productionBatchId === b.id) { const r = row(l.itemId); if (r) r.returnedQty += l._sum.quantity ?? 0; }
        const materials = [...rows.values()].map((r) => {
          const extra = extraBy.get(`${b.preProduction.purchaseOrderItem.id}::${r.itemId}`);
          return { ...r, requiredQty: q3(r.requiredQty), givenQty: q3(r.givenQty), consumedQty: q3(r.consumedQty), wastedQty: q3(r.wastedQty), rejectedQty: q3(r.rejectedQty), sampleQty: q3(r.sampleQty), returnedQty: q3(r.returnedQty), extraRequestedQty: q3(extra?.requested ?? 0), extraIssuedQty: q3(extra?.issued ?? 0) };
        });
        const { preProduction: _run, fgShipments, ...rest } = b;
        const legacy = b.currentStageId === "DISPATCH_PLAN";
        const sentQty = q3((legacy ? (b.dispatchedQty ?? 0) : 0) + fgShipments.reduce((sum, s) => sum + s.quantity, 0));
        const sentDates = [...(legacy && b.dispatchDate ? [b.dispatchDate] : []), ...fgShipments.flatMap((s) => (s.dispatchDate ? [s.dispatchDate] : []))].sort((x, y) => y.getTime() - x.getTime());
        const invoiceDates = [...(legacy && b.invoiceDate ? [b.invoiceDate] : []), ...fgShipments.flatMap((s) => (s.invoiceDate ? [s.invoiceDate] : []))].sort((x, y) => y.getTime() - x.getTime());
        return { ...rest, batchId: b.id, dispatchedQty: sentQty, dispatchDate: sentDates[0] ?? null, invoiceDate: invoiceDates[0] ?? null, materials };
      }),
    );
  } catch (err) {
    next(err);
  }
});

// Production hands a packed batch on to QA: this closes Packaging (the same forward the batch's own page does, so Packaging must read
// Completed) and puts the batch at QA's packaging gate. After QA approves, the finished goods are with the Day Store of the Plant, which
// hands them to Dispatch once QA has approved them as finished goods.
productionBatchesRouter.post("/production-batches/:id/handover", requireRole("PRODUCTION"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await prisma.productionBatch.findUnique({ where: { id: req.params.id } });
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    const preProduction = await prisma.preProduction.findUnique({ where: { id: batch.preProductionId }, select: { plantId: true } });
    await assertPlantAccess(req.user!.id, req.user!.roles, preProduction?.plantId);
    if (batch.status !== "COMPLETED") return res.status(409).json({ error: "Complete the batch's manufacturing first." });

    if (batch.currentStageId !== "PACKAGING") {
      if (["IPQC", "QA_GATE_MFG", "BULK_QC"].includes(batch.currentStageId)) return res.status(409).json({ error: "This batch has not reached Packaging yet." });
      return res.status(409).json({ error: "This batch has already been handed over to QA." });
    }
    const done = String(batch.packagingStatus ?? "").trim().toLowerCase() === "completed";
    if (!done) return res.status(409).json({ error: 'Packaging must be marked "Completed" before the batch can be handed over.' });

    const moved = await transitionProductionBatchStage({ batch, action: "FORWARD", rawBody: {}, actorId: req.user!.id, actorRoles: req.user!.roles });
    if (!moved.ok) return res.status(moved.status).json({ error: moved.error });
    await recordAudit({ actorId: req.user!.id, action: "production_batch.handed_over_to_qa", entityType: "ProductionBatch", entityId: batch.id });
    res.json(serializeProductionBatch(moved.updated));
  } catch (err) {
    next(err);
  }
});

productionBatchesRouter.get("/production-batches/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await requireBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: "Production run not found" });
    await assertPlantAccess(req.user!.id, req.user!.roles, batch.preProduction?.plantId);
    res.json((await withUtilization([batch]))[0]);
  } catch (err) {
    next(err);
  }
});

// Save this run's own execution fields — dates/status/remarks, input and
// output quantities. Doesn't itself complete the run (see POST
// /:id/complete below) — same "save everything, don't force it all at
// once" shape the rest of this pipeline uses, so Production can fill
// this in incrementally as manufacturing actually happens.
productionBatchesRouter.patch("/production-batches/:id", requireRole("PRODUCTION"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const parsed = productionBatchExecutionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const data = parsed.data as ProductionBatchExecutionInput;

    const existing = await requireBatch(req.params.id);
    if (!existing) return res.status(404).json({ error: "Production run not found" });
    await assertPlantAccess(req.user!.id, req.user!.roles, existing.preProduction?.plantId);
    if (existing.status === "COMPLETED") return res.status(409).json({ error: "This run has already been completed and can no longer be edited." });

    const poItemId = existing.preProduction?.purchaseOrderItem.id;
    const batchFlow = !!existing.preProduction?.batchFlow;
    if (batchFlow) {
      // Production starts only once the batch is cleared (indent, batch number, Dispensing, Line Clearance). Input and output come from
      // the Utilization, not from boxes.
      if (existing.prepStageId !== "READY") return res.status(409).json({ error: `This batch is not cleared for production yet: it is at ${PREP_LABEL[existing.prepStageId]}.` });
      delete data.inputQty;
      delete data.outputQty;
    }
    // What Production fills when the batch FINISHES (output, end time, status, remarks) opens only once the Utilization is complete.
    const finishing = data.outputQty !== undefined || data.shiftEndAt !== undefined || data.manufacturingEndDate !== undefined || data.manufacturingStatus !== undefined || data.manufacturingRemarks !== undefined;
    if (finishing && poItemId) {
      const u = (await utilizationOfBatches(poItemId, [{ id: existing.id, plannedQty: existing.plannedQty }])).get(existing.id)!;
      if (!u.complete) return res.status(409).json({ error: utilizationGapMessage(u, "record the end time, status and remarks") });
    }
    if (finishing && batchFlow) {
      const shift = data.shift ?? existing.shift;
      const manpower = data.manpowerCount ?? existing.manpowerCount;
      const start = data.shiftStartAt ?? existing.shiftStartAt;
      if (!shift || !manpower || !start) return res.status(409).json({ error: "Fill the start fields first: shift, manpower and the start date and time." });
    }
    // One start and one end date-time: they are also the manufacturing start / end dates.
    const patch: Prisma.ProductionBatchUpdateInput = { ...(data as Prisma.ProductionBatchUpdateInput) };
    if (data.shiftStartAt) patch.manufacturingStartDate = data.shiftStartAt;
    if (data.shiftEndAt) patch.manufacturingEndDate = data.shiftEndAt;

    const updated = await prisma.productionBatch.update({ where: { id: existing.id }, data: patch, include: productionBatchInclude });
    await recordAudit({ actorId: req.user!.id, action: "production_batch.updated", entityType: "ProductionBatch", entityId: updated.id });

    res.json((await withUtilization([updated]))[0]);
  } catch (err) {
    next(err);
  }
});

// The one action with real side effects: marks this run COMPLETED, adds
// its outputQty to the parent PreProduction's running combinedQty, and —
// only once that running total actually reaches the parent's plannedQty
// — creates the CombinedLot every downstream stage (IPQC onward) happens
// against. Requires outputQty to already be recorded; there's nothing
// meaningful to add to the parent's running total without it.
//
// No longer auto-creates a CombinedLot — per the client, "combine" isn't
// the model any more: every batch packages, gets QC'd, and dispatches on
// its own (see production-batch-transition.ts), so there's nothing left
// to pool into once this batch is done. combinedQty on the parent
// PreProduction keeps incrementing as a running "how much has this item
// produced so far" figure (still used for the remaining-quantity
// rollup), it just never triggers a CombinedLot any more.
// CombinedLot itself is untouched for any lot that already exists from
// before this change — old data still reads and works exactly as it did.
productionBatchesRouter.post("/production-batches/:id/complete", requireRole("PRODUCTION"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await requireBatch(req.params.id);
    if (!existing) return res.status(404).json({ error: "Production run not found" });
    await assertPlantAccess(req.user!.id, req.user!.roles, existing.preProduction?.plantId);
    if (existing.status === "COMPLETED") return res.status(409).json({ error: "Already completed." });
    const batchFlow = !!existing.preProduction?.batchFlow;
    if (existing.preProduction?.purchaseOrderItem.id) {
      const u = (await utilizationOfBatches(existing.preProduction.purchaseOrderItem.id, [{ id: existing.id, plannedQty: existing.plannedQty }])).get(existing.id)!;
      if (!u.complete) return res.status(409).json({ error: utilizationGapMessage(u, "complete the batch") });
    }
    // Per-batch flow: the batch must be cleared and have its production sheet filled, and its input / output are worked out from its
    // raw-material Utilization (input = what it took: A + B + C + D - E; output = what went into the product: A), not typed.
    let derived: { inputQty: number; outputQty: number } | null = null;
    if (batchFlow) {
      if (existing.prepStageId !== "READY") return res.status(409).json({ error: `This batch is not cleared for production yet: it is at ${PREP_LABEL[existing.prepStageId]}.` });
      if (!existing.shift || !existing.manpowerCount || !existing.shiftStartAt) return res.status(409).json({ error: "Fill the start fields first: shift, manpower and the start date and time." });
      if (!existing.shiftEndAt) return res.status(409).json({ error: "Record the end date and time before completing the batch." });
      derived = await rawMaterialInputOutput(existing.id);
      if (derived.outputQty <= 0) return res.status(409).json({ error: "Log the raw material's Production quantity (A) before completing the batch." });
    } else if (existing.outputQty == null) {
      return res.status(400).json({ error: "Record this run's output quantity before completing it." });
    }

    const outputQty = derived ? derived.outputQty : existing.outputQty!;
    const batch = await prisma.$transaction(async (tx) => {
      await tx.productionBatch.update({ where: { id: existing.id }, data: { status: "COMPLETED", completedById: req.user!.id, completedAt: new Date(), ...(derived ? { inputQty: derived.inputQty, outputQty: derived.outputQty } : {}) } });
      await tx.preProduction.update({ where: { id: existing.preProductionId }, data: { combinedQty: { increment: outputQty } } });
      return tx.productionBatch.findUniqueOrThrow({ where: { id: existing.id }, include: productionBatchInclude });
    });

    await recordAudit({ actorId: req.user!.id, action: "production_batch.completed", entityType: "ProductionBatch", entityId: existing.id, metadata: { outputQty } });

    res.json({ productionBatch: (await withUtilization([batch]))[0] });
  } catch (err) {
    next(err);
  }
});

// QC assigns the real batch number — deliberately not Production's call
// any more (see schema.prisma's own comment on ProductionBatch.batchNo).
// Settable any time this run exists, not just once at IPQC — a genuine
// correction later shouldn't be locked out.
productionBatchesRouter.patch("/production-batches/:id/batch-no", requireRole("QA_QC", "RND"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const parsed = assignBatchNoSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { batchNo } = parsed.data as AssignBatchNoInput;

    const existing = await requireBatch(req.params.id);
    if (!existing) return res.status(404).json({ error: "Production run not found" });
    if (existing.preProduction?.batchFlow) {
      // The batch number is R&D's; it can be corrected until Dispensing has started, then it is locked (Admin can still change it).
      if (!req.user!.roles.includes("ADMIN") && !req.user!.roles.includes("RND")) return res.status(403).json({ error: "The batch number is allocated by R&D." });
      if (!req.user!.roles.includes("ADMIN") && ["LINE_CLEARANCE", "READY"].includes(existing.prepStageId)) return res.status(409).json({ error: "The batch number is locked: Dispensing has been done." });
    }
    const taken = await prisma.productionBatch.findFirst({ where: { batchNo, id: { not: existing.id } }, select: { id: true } });
    if (taken) return res.status(409).json({ error: `Batch number ${batchNo} is already used by another batch.` });
    const updated = await prisma.productionBatch.update({ where: { id: existing.id }, data: { batchNo }, include: productionBatchInclude });
    await recordAudit({ actorId: req.user!.id, action: "production_batch.batch_no_assigned", entityType: "ProductionBatch", entityId: updated.id, metadata: { batchNo } });

    res.json(serializeProductionBatch(updated));
  } catch (err) {
    next(err);
  }
});

// This batch's OWN Tier-3 pipeline — IPQC through Dispatch Plan, same
// FORWARD/REJECT shape as CombinedLot's own PATCH /:id/stage (see
// combined-lot.routes.ts), just walked once per batch. Only reachable
// once the run is COMPLETED (see transitionProductionBatchStage) — a
// still-in-progress batch has nothing for QC to check yet.
productionBatchesRouter.patch("/production-batches/:id/stage", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await prisma.productionBatch.findUnique({ where: { id: req.params.id }, include: { preProduction: { select: { plantId: true } } } });
    if (!batch) return res.status(404).json({ error: "Production run not found" });
    await assertPlantAccess(req.user!.id, req.user!.roles, batch.preProduction?.plantId);
    // The finished goods are held by the Day Store of the batch's Plant: it receives them and hands them to Dispatch.
    if (batch.currentStageId === "FG_STORE" || batch.currentStageId === "FG_HANDOVER") await assertRunDayStoreAccess(req.user!.id, req.user!.roles, batch.preProduction?.plantId);

    const envelope = productionBatchTransitionEnvelopeSchema.safeParse(req.body);
    if (!envelope.success) return res.status(400).json({ error: "Validation failed", details: envelope.error.flatten() });
    const { action, note } = envelope.data;

    const result = await transitionProductionBatchStage({
      batch,
      action,
      note,
      rawBody: req.body as Record<string, unknown>,
      actorId: req.user!.id,
      actorRoles: req.user!.roles,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, ...(result.details !== undefined ? { details: result.details } : {}) });
    }
    res.json(serializeProductionBatch(result.updated));
  } catch (err) {
    next(err);
  }
});

// The full Batch Manufacturing Record (BMR) for this run — see
// bmr-report-pdf.ts for what it pulls together. Available any time, not
// gated on the batch reaching a particular stage — a still-in-progress
// batch's report just shows blanks for what hasn't happened yet, same
// "print what's there" shape the client's own paper form has.
productionBatchesRouter.get("/production-batches/:id/bmr-report.pdf", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await requireBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: "Production run not found" });

    const preProduction = await prisma.preProduction.findUnique({ where: { id: batch.preProductionId }, include: preProductionInclude });
    if (!preProduction) return res.status(404).json({ error: "Parent pre-production run not found" });
    const serializedPreProduction = serializePreProduction(preProduction);

    const dispensingSheet = serializedPreProduction.consumptions.map((c) => ({
      itemName: c.item.name,
      purpose: c.purpose,
      quantity: c.quantity,
      unit: c.unit,
      grossWeight: c.grossWeight,
      tareWeight: c.tareWeight,
      netWeight: c.netWeight,
      arNo: c.arNo,
    }));

    // A per-batch-flow batch has its own Line Clearance checklist (QA ticks it for the batch); an old run uses the run's bulk-manufacturing one.
    const lineClearanceRows = preProduction.batchFlow
      ? BATCH_LINE_CLEARANCE_ITEMS.map((i) => ({ itemKey: i.key, label: i.label, deptOk: null, qaOk: batch.lineClearanceChecks ? ((batch.lineClearanceChecks as Record<string, boolean>)[i.key] ?? null) : null }))
      : serializedPreProduction.bulkMfgLineClearanceChecklist;
    const doc = buildBmrReportPdf(batch, lineClearanceRows, preProduction.sampleQcStatus, preProduction.sampleQcRemarks, dispensingSheet);

    await recordAudit({ actorId: req.user!.id, action: "production_batch.bmr_report_exported", entityType: "ProductionBatch", entityId: batch.id });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="BMR_${(batch.batchNo ?? batch.id).replace(/[^a-zA-Z0-9]/g, "_")}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    next(err);
  }
});
