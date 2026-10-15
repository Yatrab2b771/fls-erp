import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { logger } from "../../common/lib/logger";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { RouteError } from "../../common/lib/route-error";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { assertPlantAccess, assertRunDayStoreAccess, getScopedDayStoreIds, getScopedPlantIds } from "../inventory/day-store-access";
import { getOnHandByDayStoreAndItem, getOnHandByPlantAndItem } from "../inventory/stock";
import { productionBlockedByHoldOrCancel } from "../purchase-orders/hold-guards";
import { productionBatchInclude, serializeProductionBatch } from "./batch-include";
import { getRequiredDispensingItems } from "./dispensing-requirements";
import { BATCH_LINE_CLEARANCE_ITEMS } from "./batch-checklists";
import { utilizationGapMessage, utilizationOfBatches } from "./batch-utilization";
import { withUtilization } from "./production-batches.routes";
import { plantFreeQty } from "../plant-consumption/plant-position";

/**
 * The per-batch flow (a run started with batchFlow = true). Every batch goes through four steps of its own before its production starts:
 *
 *   Indent Issue (Production) -> Batch No (R&D) -> Dispensing (Day Store) -> Line Clearance (QA) -> READY (Production runs it)
 *
 *   GET   /production-batches/prep-board?stage=   the batches waiting at one step (scoped to the caller's Plant / Day Store)
 *   GET   /production-batches/prep-summary        how many batches wait at each step (the dashboard tiles)
 *   GET   /production-batches/held-products       products PPIC put on hold, with their batches (Production's Held Products tile)
 *   PATCH /production-batches/:id/hold            Production holds / releases a batch still in preparation (only for a product on hold)
 *   POST  /production-batches/:id/indent          Production signs the batch's indent
 *   POST  /production-batches/:id/batch-no/allocate   R&D allocates the next serial number (or one it types; always unique)
 *   POST  /production-batches/:id/dispense        the Day Store dispenses THIS batch's material to the Plant
 *   POST  /production-batches/:id/line-clearance  QA clears the line (Approved opens production)
 *   GET   /production-batches/packaging-board     batches at Packaging, with their PM Utilization
 *   PATCH /production-batches/:id/packaging       Packaging's production sheet and status
 */
export const batchPrepRouter = Router();
batchPrepRouter.use(requireAuth);

const STAGES = ["INDENT_ISSUE", "BATCH_NO", "DISPENSING", "LINE_CLEARANCE", "READY"] as const;
type PrepStage = (typeof STAGES)[number];
const STAGE_LABEL: Record<PrepStage, string> = { INDENT_ISSUE: "Indent Issue", BATCH_NO: "Batch No", DISPENSING: "Dispensing", LINE_CLEARANCE: "Line Clearance", READY: "Ready for production" };
const q3 = (n: number) => Math.round(n * 1000) / 1000;
const HELD_MESSAGE = "Production has put this batch on hold. It goes on once Production releases it.";

const boardInclude = {
  preProduction: {
    select: {
      id: true,
      batchFlow: true,
      plantId: true,
      plant: { select: { id: true, name: true, dayStoreId: true } },
      purchaseOrderItem: { select: { id: true, productName: true, quantity: true, unit: true, purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } } } },
    },
  },
} satisfies Prisma.ProductionBatchInclude;
type BoardBatch = Prisma.ProductionBatchGetPayload<{ include: typeof boardInclude }>;

/** The batches this caller may see: a Plant-limited Production login sees its own Plant's, a Day Store login its own store's. */
async function scopeWhere(req: AuthedRequest): Promise<Prisma.ProductionBatchWhereInput> {
  const plantScope = await getScopedPlantIds(req.user!.id, req.user!.roles);
  const storeScope = await getScopedDayStoreIds(req.user!.id, req.user!.roles);
  return {
    preProduction: {
      batchFlow: true,
      ...(plantScope ? { plantId: { in: plantScope } } : {}),
      ...(storeScope ? { plant: { dayStoreId: { in: storeScope } } } : {}),
    },
  };
}

/** The plan's materials for ONE batch: the plan's total scaled to the batch's share of the order. */
async function requirementsOf(batch: { plannedQty: number; preProduction: { purchaseOrderItem: { id: string; quantity: number } } }) {
  const item = batch.preProduction.purchaseOrderItem;
  const required = await getRequiredDispensingItems(item.id);
  const scale = item.quantity > 0 ? batch.plannedQty / item.quantity : 1;
  return required.map((r) => ({ ...r, requiredQty: q3(r.requiredQty * scale) })).filter((r) => r.requiredQty > 0);
}

async function boardRow(b: BoardBatch, withRequirements: boolean) {
  const item = b.preProduction.purchaseOrderItem;
  const plant = b.preProduction.plant;
  let requirements: { itemId: string; itemName: string; category: string; unit: string; requiredQty: number; dayStoreQty: number; plantFreeQty: number; enough: boolean }[] | undefined;
  if (withRequirements) {
    const req = await requirementsOf(b);
    const ids = req.map((r) => r.itemId);
    const shelf = plant?.dayStoreId && ids.length ? await getOnHandByDayStoreAndItem(plant.dayStoreId, ids) : new Map<string, { onHand: number }>();
    const free = plant && ids.length ? await plantFreeQty(plant.id, ids, undefined) : new Map<string, number>();
    requirements = req.map((r) => {
      const dayStoreQty = q3(Math.max(0, shelf.get(r.itemId)?.onHand ?? 0));
      const plantFree = q3(Math.max(0, free.get(r.itemId) ?? 0));
      return { itemId: r.itemId, itemName: r.itemName, category: r.category, unit: r.unit, requiredQty: r.requiredQty, dayStoreQty, plantFreeQty: plantFree, enough: plantFree + dayStoreQty >= r.requiredQty - 1e-9 };
    });
  }
  return {
    id: b.id,
    batchNo: b.batchNo,
    plannedQty: b.plannedQty,
    unit: item.unit,
    prepStageId: b.prepStageId,
    batchStatus: b.status,
    held: !!b.heldAt,
    holdReason: b.holdReason,
    runId: b.preProduction.id,
    itemId: item.id,
    poId: item.purchaseOrder.id,
    poNumber: item.purchaseOrder.poNumber,
    customerName: item.purchaseOrder.customer.companyName,
    productName: item.productName,
    plant: plant ? { id: plant.id, name: plant.name } : null,
    createdAt: b.createdAt,
    prodIndentSlipSign: b.prodIndentSlipSign,
    productionPlanDate: b.productionPlanDate,
    indentSignedAt: b.indentSignedAt,
    batchNoAllocatedAt: b.batchNoAllocatedAt,
    rmDispensingDate: b.rmDispensingDate,
    pmIssuedDate: b.pmIssuedDate,
    dispensingRemarks: b.dispensingRemarks,
    dispensedAt: b.dispensedAt,
    grnNo: b.grnNo,
    lineClearanceStatus: b.lineClearanceStatus,
    lineClearanceRemarks: b.lineClearanceRemarks,
    lineClearanceAt: b.lineClearanceAt,
    lineClearanceChecklist: BATCH_LINE_CLEARANCE_ITEMS.map((i) => ({ key: i.key, label: i.label, ok: ((b.lineClearanceChecks ?? {}) as Record<string, boolean>)[i.key] === true })),
    ...(requirements ? { requirements } : {}),
  };
}

async function loadBatch(id: string) {
  return prisma.productionBatch.findUnique({ where: { id }, include: boardInclude });
}

// ---------------------------------------------------------------------------------------------------------------- boards

batchPrepRouter.get("/production-batches/prep-board", async (req: AuthedRequest, res, next) => {
  try {
    const stage = String(req.query.stage ?? "") as PrepStage;
    if (!STAGES.includes(stage)) return res.status(400).json({ error: "Unknown stage" });
    // R&D's Batch No list (?all=1) also shows the batches that already have their number, so R&D can see (and, until Dispensing, correct) what it allocated.
    const withAllocated = stage === "BATCH_NO" && req.query.all === "1";
    // A batch Production has put on hold is listed only on Held Products, not at its step
    const where: Prisma.ProductionBatchWhereInput = withAllocated ? { OR: [{ prepStageId: "BATCH_NO", status: "IN_PROGRESS" }, { batchNo: { not: null } }], ...(await scopeWhere(req)) } : { status: "IN_PROGRESS", prepStageId: stage, heldAt: null, ...(await scopeWhere(req)) };
    const batches = await prisma.productionBatch.findMany({ where, include: boardInclude, orderBy: withAllocated ? { createdAt: "desc" } : { createdAt: "asc" } });
    // Indent Issue and Dispensing show the batch's materials (the plan scaled to the batch's quantity) and whether they are available.
    res.json(await Promise.all(batches.map((b) => boardRow(b, stage === "DISPENSING" || stage === "INDENT_ISSUE"))));
  } catch (err) {
    next(err);
  }
});

batchPrepRouter.get("/production-batches/prep-summary", async (req: AuthedRequest, res, next) => {
  try {
    const where = { status: "IN_PROGRESS" as const, heldAt: null, ...(await scopeWhere(req)) };
    const groups = await prisma.productionBatch.groupBy({ by: ["prepStageId"], where, _count: { _all: true } });
    const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<PrepStage, number>;
    for (const g of groups) counts[g.prepStageId] = g._count._all;
    res.json(counts);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- Held Products (Production)

const holdSchema = z
  .object({ held: z.boolean(), reason: z.string().trim().max(500).optional() })
  .refine((d) => !d.held || !!d.reason, { message: "Write why you are holding this batch.", path: ["reason"] });

/**
 * PPIC put a product on Hold and told Production: here Production sees that product with every batch of it, and holds (or later releases)
 * the batches one by one. A batch can be held only while it is still in preparation (Indent Issue to Line Clearance): once it is READY
 * (in manufacturing) it follows the whole pipeline. A product also stays listed while one of its batches is still held, even after PPIC released it.
 */
batchPrepRouter.get("/production-batches/held-products", requireRole("PRODUCTION", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const plantScope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    const items = await prisma.purchaseOrderItem.findMany({
      where: {
        deletedAt: null,
        cancelledAt: null,
        planSentToProductionAt: { not: null },
        preProduction: { is: { batchFlow: true, ...(plantScope ? { plantId: { in: plantScope } } : {}) } },
        OR: [{ materialHeldAt: { not: null } }, { preProduction: { is: { productionBatches: { some: { heldAt: { not: null } } } } } }],
      },
      orderBy: [{ materialHeldAt: { sort: "desc", nulls: "last" } }, { productName: "asc" }],
      select: {
        id: true,
        productName: true,
        quantity: true,
        unit: true,
        materialHeldAt: true,
        purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } },
        preProduction: {
          select: {
            id: true,
            plant: { select: { name: true } },
            productionBatches: {
              orderBy: { createdAt: "asc" },
              select: { id: true, batchNo: true, plannedQty: true, status: true, prepStageId: true, heldAt: true, holdReason: true, heldBy: { select: { fullName: true } } },
            },
          },
        },
      },
    });
    res.json(
      items.map((item) => {
        const batches = item.preProduction?.productionBatches ?? [];
        return {
          itemId: item.id,
          poId: item.purchaseOrder.id,
          poNumber: item.purchaseOrder.poNumber,
          customerName: item.purchaseOrder.customer.companyName,
          productName: item.productName,
          quantity: item.quantity,
          unit: item.unit,
          plantName: item.preProduction?.plant?.name ?? null,
          runId: item.preProduction?.id ?? null,
          productHeld: !!item.materialHeldAt,
          productHeldAt: item.materialHeldAt?.toISOString() ?? null,
          batches: batches.map((b) => ({
            id: b.id,
            batchNo: b.batchNo,
            plannedQty: b.plannedQty,
            stageLabel: b.status === "COMPLETED" ? "Manufacturing done" : b.prepStageId === "READY" ? "In production" : STAGE_LABEL[b.prepStageId],
            inProduction: b.prepStageId === "READY" || b.status === "COMPLETED",
            held: !!b.heldAt,
            heldAt: b.heldAt?.toISOString() ?? null,
            heldByName: b.heldBy?.fullName ?? null,
            holdReason: b.holdReason,
            canHold: !!item.materialHeldAt && !b.heldAt && b.status === "IN_PROGRESS" && b.prepStageId !== "READY",
            canRelease: !!b.heldAt,
          })),
        };
      }),
    );
  } catch (err) {
    next(err);
  }
});

batchPrepRouter.patch("/production-batches/:id/hold", requireRole("PRODUCTION"), validateBody(holdSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const { held, reason } = req.body as z.infer<typeof holdSchema>;
    const batch = await loadBatch(req.params.id);
    if (!batch || !batch.preProduction.batchFlow) return res.status(404).json({ error: "Batch not found" });
    await assertPlantAccess(req.user!.id, req.user!.roles, batch.preProduction.plantId);
    const item = batch.preProduction.purchaseOrderItem;
    if (held) {
      if (batch.heldAt) return res.status(409).json({ error: "This batch is already on hold." });
      if (batch.status !== "IN_PROGRESS" || batch.prepStageId === "READY") return res.status(409).json({ error: "This batch is already in production, so it can't be held. It follows the whole pipeline." });
      const product = await prisma.purchaseOrderItem.findUnique({ where: { id: item.id }, select: { materialHeldAt: true } });
      if (!product?.materialHeldAt) return res.status(409).json({ error: "PPIC has not put this product on hold, so its batches can't be held." });
    } else if (!batch.heldAt) {
      return res.status(409).json({ error: "This batch is not on hold." });
    }

    const updated = await prisma.productionBatch.update({
      where: { id: batch.id },
      data: held ? { heldAt: new Date(), heldById: req.user!.id, holdReason: reason } : { heldAt: null, heldById: null, holdReason: null },
      include: boardInclude,
    });
    await recordAudit({ actorId: req.user!.id, action: held ? "production_batch.held" : "production_batch.hold_released", entityType: "ProductionBatch", entityId: batch.id, metadata: { stage: batch.prepStageId, ...(held ? { reason } : {}) } });
    const label = `${batch.batchNo ?? "A batch"} of ${item.productName} (${item.purchaseOrder.poNumber ?? "PO"})`;
    await notifyRoles(["PPIC"], held ? { title: `Production held ${label}`, body: reason ?? "", link: "/held-products" } : { title: `Production released ${label}`, body: "The batch goes on.", link: "/held-products" }, req.user!.id).catch((err) => logger.error({ err }, "notify failed: batch.hold"));
    res.json(await boardRow(updated, false));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- Indent Issue (Production)

const indentSchema = z.object({
  prodIndentSlipSign: z.string().trim().min(1, "Enter who signed the indent slip.").max(120),
  productionPlanDate: z.coerce.date({ required_error: "Enter the production plan date.", invalid_type_error: "Enter the production plan date." }),
});

batchPrepRouter.post("/production-batches/:id/indent", requireRole("PRODUCTION"), validateBody(indentSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await loadBatch(req.params.id);
    if (!batch || !batch.preProduction.batchFlow) return res.status(404).json({ error: "Batch not found" });
    await assertPlantAccess(req.user!.id, req.user!.roles, batch.preProduction.plantId);
    if (batch.prepStageId !== "INDENT_ISSUE") return res.status(409).json({ error: `This batch is already past Indent Issue (it is at ${STAGE_LABEL[batch.prepStageId]}).` });
    if (batch.heldAt) return res.status(409).json({ error: HELD_MESSAGE });
    const blocked = await productionBlockedByHoldOrCancel(batch.preProduction.purchaseOrderItem.id);
    if (blocked) return res.status(409).json({ error: blocked });
    const input = req.body as z.infer<typeof indentSchema>;
    const updated = await prisma.productionBatch.update({ where: { id: batch.id }, data: { prodIndentSlipSign: input.prodIndentSlipSign, productionPlanDate: input.productionPlanDate, indentSignedAt: new Date(), prepStageId: "BATCH_NO" }, include: boardInclude });
    await recordAudit({ actorId: req.user!.id, action: "production_batch.indent_signed", entityType: "ProductionBatch", entityId: batch.id });
    await notifyRoles(["RND"], { title: `Batch of ${batch.preProduction.purchaseOrderItem.productName} needs a batch number`, body: `${batch.plannedQty} ${batch.preProduction.purchaseOrderItem.unit}: allocate the batch number.`, link: "/batch-no" }, req.user!.id).catch((err) => logger.error({ err }, "notify failed: batch.indent"));
    res.json(await boardRow(updated, false));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- Batch No (R&D)

const allocateSchema = z.object({ batchNo: z.string().trim().max(60).optional() });

/** The next free serial of this year: FLS-26-0001, FLS-26-0002, ... The counter only goes up, and a number that exists already is skipped. */
async function nextBatchNo(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  for (let i = 0; i < 50; i++) {
    const counter = await tx.batchNoCounter.upsert({ where: { key: String(year) }, create: { key: String(year), last: 1 }, update: { last: { increment: 1 } } });
    const candidate = `FLS-${String(year).slice(2)}-${String(counter.last).padStart(4, "0")}`;
    if (!(await tx.productionBatch.findFirst({ where: { batchNo: candidate }, select: { id: true } }))) return candidate;
  }
  throw new RouteError(500, "Could not find a free batch number.");
}

batchPrepRouter.post("/production-batches/:id/batch-no/allocate", requireRole("RND"), validateBody(allocateSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await loadBatch(req.params.id);
    if (!batch || !batch.preProduction.batchFlow) return res.status(404).json({ error: "Batch not found" });
    if (batch.prepStageId !== "BATCH_NO") return res.status(409).json({ error: batch.batchNo ? `This batch already has its number (${batch.batchNo}).` : `This batch is at ${STAGE_LABEL[batch.prepStageId]}: Production has to sign its indent first.` });
    if (batch.heldAt) return res.status(409).json({ error: HELD_MESSAGE });
    const typed = (req.body as z.infer<typeof allocateSchema>).batchNo?.trim();
    const updated = await runSerializable(async (tx) => {
      let batchNo = typed;
      if (batchNo) {
        if (await tx.productionBatch.findFirst({ where: { batchNo, id: { not: batch.id } }, select: { id: true } })) throw new RouteError(409, `Batch number ${batchNo} is already used by another batch.`);
      } else {
        batchNo = await nextBatchNo(tx);
      }
      return tx.productionBatch.update({ where: { id: batch.id }, data: { batchNo, batchNoAllocatedAt: new Date(), batchNoAllocatedById: req.user!.id, prepStageId: "DISPENSING" }, include: boardInclude });
    });
    await recordAudit({ actorId: req.user!.id, action: "production_batch.batch_no_allocated", entityType: "ProductionBatch", entityId: batch.id, metadata: { batchNo: updated.batchNo, typed: !!typed } });
    await notifyRoles(["STORE"], { title: `${updated.batchNo}: ${batch.preProduction.purchaseOrderItem.productName} is ready for Dispensing`, body: `${batch.plannedQty} ${batch.preProduction.purchaseOrderItem.unit}: dispense this batch's material.`, link: "/batch-dispensing" }, req.user!.id).catch((err) => logger.error({ err }, "notify failed: batch.batch_no"));
    res.json(await boardRow(updated, false));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- Dispensing (Day Store)

const dispenseSchema = z.object({
  rmDispensingDate: z.coerce.date({ required_error: "Enter the RM dispensing date.", invalid_type_error: "Enter the RM dispensing date." }),
  pmIssuedDate: z.coerce.date({ required_error: "Enter the PM issued date.", invalid_type_error: "Enter the PM issued date." }),
  dispensingRemarks: z.string().trim().max(1000).optional(),
  grnNo: z.string().trim().max(120).optional(), // optional: the GRN the material came on
});

batchPrepRouter.post("/production-batches/:id/dispense", requireRole("STORE"), validateBody(dispenseSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await loadBatch(req.params.id);
    if (!batch || !batch.preProduction.batchFlow) return res.status(404).json({ error: "Batch not found" });
    await assertRunDayStoreAccess(req.user!.id, req.user!.roles, batch.preProduction.plantId);
    if (batch.prepStageId !== "DISPENSING") return res.status(409).json({ error: batch.prepStageId === "BATCH_NO" || batch.prepStageId === "INDENT_ISSUE" ? "This batch has no batch number yet: R&D allocates it first." : "This batch has already been dispensed." });
    if (batch.heldAt) return res.status(409).json({ error: HELD_MESSAGE });
    const plant = batch.preProduction.plant;
    const input = req.body as z.infer<typeof dispenseSchema>;
    const required = await requirementsOf(batch);
    if (required.length > 0 && !plant) return res.status(400).json({ error: "Assign a Plant to this run before dispensing." });

    const updated = await runSerializable(async (tx) => {
      if (required.length > 0) {
        const ids = required.map((r) => r.itemId);
        // The Plant may already hold some of the material (issued to it earlier for the plan); the Day Store gives what is missing.
        const free = await plantFreeQty(plant!.id, ids, tx);
        const shelf = plant!.dayStoreId ? await getOnHandByDayStoreAndItem(plant!.dayStoreId, ids, tx) : new Map<string, { onHand: number }>();
        const shortfalls = required.map((r) => ({ ...r, short: q3(Math.max(0, r.requiredQty - (free.get(r.itemId) ?? 0))) })).filter((s) => s.short > 1e-9);
        const stillShort = shortfalls.filter((s) => s.short > (shelf.get(s.itemId)?.onHand ?? 0) + 1e-9);
        if (stillShort.length > 0) {
          throw new RouteError(409, `The Day Store does not hold enough material for this batch: ${stillShort.map((s) => `${s.itemName} (needs ${s.short} more, Day Store has ${q3(Math.max(0, shelf.get(s.itemId)?.onHand ?? 0))} ${s.unit})`).join("; ")}.`);
        }
        for (const s of shortfalls) {
          const open = await tx.inventoryRequest.findFirst({
            where: { purchaseOrderItemId: batch.preProduction.purchaseOrderItem.id, itemId: s.itemId, purpose: "ISSUED_PRODUCTION", preProductionId: null, deletedAt: null, status: { in: ["PENDING", "APPROVED", "PARTIALLY_ISSUED"] } },
            include: { fulfillments: { where: { deletedAt: null }, select: { quantity: true } } },
            orderBy: { createdAt: "asc" },
          });
          await tx.inventoryTransaction.create({
            data: { itemId: s.itemId, type: "ISSUED_PRODUCTION", date: new Date(), unit: s.unit, quantity: s.short, createdById: req.user!.id, dayStoreId: plant!.dayStoreId, plantId: plant!.id, fulfillsRequestId: open?.id ?? null, deliveredAt: new Date(), deliveredById: req.user!.id, remark: `Issued to the Plant at Dispensing (${batch.batchNo ?? "batch"})` },
          });
          if (open) {
            const issued = open.fulfillments.reduce((x, f) => x + f.quantity, 0) + s.short;
            await tx.inventoryRequest.update({ where: { id: open.id }, data: { status: issued >= open.requestedQty - 1e-9 ? "ISSUED" : "PARTIALLY_ISSUED" } });
          }
        }
        await tx.batchDispensingLine.createMany({ data: required.map((r) => ({ productionBatchId: batch.id, itemId: r.itemId, quantity: r.requiredQty, unit: r.unit, createdById: req.user!.id })) });
      }
      return tx.productionBatch.update({
        where: { id: batch.id },
        data: { rmDispensingDate: input.rmDispensingDate, pmIssuedDate: input.pmIssuedDate, dispensingRemarks: input.dispensingRemarks, grnNo: input.grnNo, dispensedAt: new Date(), prepStageId: "LINE_CLEARANCE" },
        include: boardInclude,
      });
    });
    await recordAudit({ actorId: req.user!.id, action: "production_batch.dispensed", entityType: "ProductionBatch", entityId: batch.id, metadata: { materials: required.length } });
    await notifyRoles(["QA_QC"], { title: `${updated.batchNo}: ${batch.preProduction.purchaseOrderItem.productName} needs Line Clearance`, body: `${batch.plannedQty} ${batch.preProduction.purchaseOrderItem.unit}: approve the line.`, link: "/batch-line-clearance" }, req.user!.id).catch((err) => logger.error({ err }, "notify failed: batch.dispense"));
    res.json(await boardRow(updated, false));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- Line Clearance (QA)

const CHECK_KEYS = new Set(BATCH_LINE_CLEARANCE_ITEMS.map((i) => i.key));
const lineClearanceSchema = z
  .object({
    lineClearanceStatus: z.enum(["Approved", "Not Approved", "Hold"]),
    lineClearanceRemarks: z.string().trim().max(1000).optional(),
    // QA's BMR 4.0 checklist: { itemKey: true | false }
    lineClearanceChecks: z.record(z.string(), z.boolean()).optional(),
  })
  .refine((d) => d.lineClearanceStatus === "Approved" || !!d.lineClearanceRemarks, { message: "Write the remark for Not Approved / Hold.", path: ["lineClearanceRemarks"] })
  .refine((d) => Object.keys(d.lineClearanceChecks ?? {}).every((k) => CHECK_KEYS.has(k)), { message: "Unknown checklist item.", path: ["lineClearanceChecks"] })
  .refine((d) => d.lineClearanceStatus !== "Approved" || BATCH_LINE_CLEARANCE_ITEMS.every((i) => d.lineClearanceChecks?.[i.key] === true), { message: "Tick every Line Clearance checklist item before approving the line.", path: ["lineClearanceChecks"] });

batchPrepRouter.post("/production-batches/:id/line-clearance", requireRole("QA_QC"), validateBody(lineClearanceSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await loadBatch(req.params.id);
    if (!batch || !batch.preProduction.batchFlow) return res.status(404).json({ error: "Batch not found" });
    if (batch.prepStageId !== "LINE_CLEARANCE") return res.status(409).json({ error: batch.prepStageId === "READY" ? "This batch's line is already cleared." : `This batch is at ${STAGE_LABEL[batch.prepStageId]}: Line Clearance comes after Dispensing.` });
    if (batch.heldAt) return res.status(409).json({ error: HELD_MESSAGE });
    const input = req.body as z.infer<typeof lineClearanceSchema>;
    const approved = input.lineClearanceStatus === "Approved";
    // Approving the line opens production: not while PPIC has the product on hold (the batches in preparation are held one by one by Production)
    if (approved) {
      const blocked = await productionBlockedByHoldOrCancel(batch.preProduction.purchaseOrderItem.id);
      if (blocked) return res.status(409).json({ error: blocked });
    }
    const updated = await prisma.productionBatch.update({
      where: { id: batch.id },
      data: { lineClearanceStatus: input.lineClearanceStatus, lineClearanceRemarks: input.lineClearanceRemarks ?? null, lineClearanceChecks: input.lineClearanceChecks ?? undefined, lineClearanceAt: new Date(), ...(approved ? { prepStageId: "READY" as const } : {}) },
      include: boardInclude,
    });
    await recordAudit({ actorId: req.user!.id, action: "production_batch.line_clearance", entityType: "ProductionBatch", entityId: batch.id, metadata: { status: input.lineClearanceStatus } });
    if (approved) {
      await notifyRoles(["PRODUCTION"], { title: `${updated.batchNo}: ${batch.preProduction.purchaseOrderItem.productName} is ready for production`, body: "Line Clearance approved. Start the batch.", link: "/batches" }, req.user!.id).catch((err) => logger.error({ err }, "notify failed: batch.line_clearance"));
    }
    res.json(await boardRow(updated, false));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- Packaging (Production)

batchPrepRouter.get("/production-batches/packaging-board", requireRole("PRODUCTION", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const plantScope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    const batches = await prisma.productionBatch.findMany({
      where: { status: "COMPLETED", currentStageId: "PACKAGING", ...(plantScope ? { preProduction: { plantId: { in: plantScope } } } : {}) },
      include: productionBatchInclude,
      orderBy: { completedAt: "asc" },
    });
    res.json(await withUtilization(batches));
  } catch (err) {
    next(err);
  }
});

const packagingSchema = z
  .object({
    packagingShift: z.enum(["Day", "Night"]).optional(),
    packagingManpowerCount: z.coerce.number().int().positive().optional(),
    packagingStartAt: z.coerce.date().optional(),
    packagingEndAt: z.coerce.date().optional(),
    packagingStatus: z.string().trim().max(120).optional(),
    packagingRemarks: z.string().trim().max(1000).optional(),
  })
  .refine((d) => !d.packagingStartAt || !d.packagingEndAt || d.packagingEndAt.getTime() >= d.packagingStartAt.getTime(), { message: "End time can't be before the start time.", path: ["packagingEndAt"] });

batchPrepRouter.patch("/production-batches/:id/packaging", requireRole("PRODUCTION"), validateBody(packagingSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await prisma.productionBatch.findUnique({ where: { id: req.params.id }, include: productionBatchInclude });
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    await assertPlantAccess(req.user!.id, req.user!.roles, batch.preProduction?.plantId);
    if (batch.status !== "COMPLETED" || batch.currentStageId !== "PACKAGING") return res.status(409).json({ error: "This batch is not at Packaging." });
    const data = req.body as z.infer<typeof packagingSchema>;

    // The end of Packaging (status Completed, end time, remarks) opens only once the PM Utilization is complete and the start fields are in.
    const finishing = data.packagingEndAt !== undefined || data.packagingRemarks !== undefined || String(data.packagingStatus ?? "").trim().toLowerCase() === "completed";
    if (finishing) {
      const u = (await utilizationOfBatches(batch.preProduction.purchaseOrderItem.id, [{ id: batch.id, plannedQty: batch.plannedQty }])).get(batch.id)!;
      if (!u.pm.complete) return res.status(409).json({ error: utilizationGapMessage(u.pm, "mark Packaging Completed and record the end time", "PM") });
      const shift = data.packagingShift ?? batch.packagingShift;
      const manpower = data.packagingManpowerCount ?? batch.packagingManpowerCount;
      const start = data.packagingStartAt ?? batch.packagingStartAt;
      if (!shift || !manpower || !start) return res.status(409).json({ error: "Fill the start fields first: shift, manpower and the start date and time." });
    }
    const patch: Prisma.ProductionBatchUpdateInput = { ...data };
    if (data.packagingStartAt) patch.packagingStartDate = data.packagingStartAt;
    if (data.packagingEndAt) patch.packagingEndDate = data.packagingEndAt;
    const updated = await prisma.productionBatch.update({ where: { id: batch.id }, data: patch, include: productionBatchInclude });
    await recordAudit({ actorId: req.user!.id, action: "production_batch.packaging_updated", entityType: "ProductionBatch", entityId: batch.id });
    res.json((await withUtilization([updated]))[0]);
  } catch (err) {
    next(err);
  }
});

export { serializeProductionBatch };
