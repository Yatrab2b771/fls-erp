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
import { productionBlockedByHoldOrCancel, productionHoldMessage } from "../purchase-orders/hold-guards";
import { cancelPoItem } from "../purchase-orders/cancel-item";
import { closeProductShort, reopenProductShort } from "../purchase-orders/close-short";
import { productionBatchInclude, serializeProductionBatch } from "./batch-include";
import { transitionProductionBatchStage } from "./production-batch-transition";
import { effectiveBomSlot, getRequiredDispensingItems } from "./dispensing-requirements";
import { utilizationGapMessage, utilizationOfBatches } from "./batch-utilization";
import { withUtilization } from "./production-batches.routes";
import { plantFreeQty } from "../plant-consumption/plant-position";
import { recordDispensingLots, recordIssueLots } from "../inventory/lots";
import { resolveShortReceipt } from "../inventory/transit";
import { resyncRequestStatus } from "../inventory/request-status";
import { notifyPlantDayStore } from "../inventory/plan-requests";
import { COMBINED_LOT_STAGE_LABEL } from "./combined-lot-stage";
import { PAST_PACKING_STAGES, stageDepartment } from "./batch-pipeline";
import { allowedKeysOf, approvedPlantStock, approvedStoreStock, rulesForPoItems } from "../product-vendors/vendor-rules";

/**
 * The per-batch flow (a run started with batchFlow = true). Every batch goes through steps of its own before its production starts:
 *
 *   Indent Issue (Production) -> Batch No (R&D) -> Dispensing (Day Store) -> READY (Production runs it)
 *
 *   GET   /production-batches/prep-board?stage=   the batches waiting at one step (scoped to the caller's Plant / Day Store)
 *   GET   /production-batches/prep-summary        how many batches wait at each step (the dashboard tiles)
 *   GET   /production-batches/held-products       products PPIC put on hold, with their batches (Production's Held Products tile)
 *   PATCH /production-batches/:id/hold            Production holds / releases a batch still in preparation (only for a product on hold)
 *   POST  /production-batches/:id/indent          Production signs the batch's indent
 *   POST  /production-batches/:id/batch-no/allocate   R&D allocates the next serial number (or one it types; always unique)
 *   POST  /production-batches/:id/dispense        the Day Store dispenses THIS batch's material to the Plant
 *   GET   /production-batches/packaging-board     batches at Packaging, with their PM Utilization
 *   PATCH /production-batches/:id/packaging       Packaging's production sheet and status
 */
export const batchPrepRouter = Router();
batchPrepRouter.use(requireAuth);

const STAGES = ["INDENT_ISSUE", "BATCH_NO", "DISPENSING", "RECEIVE", "LINE_CLEARANCE", "READY"] as const;
type PrepStage = (typeof STAGES)[number];
const STAGE_LABEL: Record<PrepStage, string> = { INDENT_ISSUE: "Indent Issue", BATCH_NO: "Batch No", DISPENSING: "Dispensing", RECEIVE: "Receive (Production)", LINE_CLEARANCE: "Line Clearance", READY: "Ready for production" };
const q3 = (n: number) => Math.round(n * 1000) / 1000;
const HELD_MESSAGE = "Production has put this batch on hold. It goes on once Production releases it.";
/** A batch of a product Production has put on hold is listed only on Held Products, not at its step. */
const notProductionHeld: Prisma.ProductionBatchWhereInput = { preProduction: { purchaseOrderItem: { productionHeldAt: null } } };

const boardInclude = {
  preProduction: {
    select: {
      id: true,
      batchFlow: true,
      plantId: true,
      plant: { select: { id: true, name: true, dayStoreId: true } },
      purchaseOrderItem: { select: { id: true, productName: true, productCategory: true, materialHeldAt: true, cancelledAt: true, quantity: true, unit: true, purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } } } },
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
export async function requirementsOf(batch: { id?: string; bomSlot?: string | null; plannedQty: number; preProduction: { purchaseOrderItem: { id: string; quantity: number } } }) {
  const item = batch.preProduction.purchaseOrderItem;
  // The batch follows the BOM version R&D chose for it (or, if it is not dispensed yet, the product's current one); see effectiveBomSlot.
  const productSlot = (await prisma.purchaseOrderItem.findUnique({ where: { id: item.id }, select: { productionBomSlot: true } }))?.productionBomSlot;
  const batchSlot = batch.bomSlot !== undefined ? batch.bomSlot : batch.id ? (await prisma.productionBatch.findUnique({ where: { id: batch.id }, select: { bomSlot: true } }))?.bomSlot : null;
  const required = await getRequiredDispensingItems(item.id, effectiveBomSlot(batchSlot, productSlot));
  const scale = item.quantity > 0 ? batch.plannedQty / item.quantity : 1;
  return required.map((r) => ({ ...r, requiredQty: q3(r.requiredQty * scale) })).filter((r) => r.requiredQty > 0);
}

async function boardRow(b: BoardBatch, withRequirements: boolean, withReceive = false) {
  const item = b.preProduction.purchaseOrderItem;
  const plant = b.preProduction.plant;
  let requirements: { itemId: string; itemName: string; category: string; unit: string; requiredQty: number; givenQty: number; remainingQty: number; dayStoreQty: number; plantFreeQty: number; enough: boolean; dispensed: boolean; refusedNote: string | null }[] | undefined;
  let receiveLines: { lineId: string; itemId: string; itemName: string; category: string; unit: string; plannedQty: number | null; givenQty: number; sentQty: number }[] | undefined;
  if (withReceive) {
    const pending = await prisma.batchDispensingLine.findMany({ where: { productionBatchId: b.id, deliveryStatus: "PENDING" }, orderBy: { createdAt: "asc" } });
    const info = new Map((await prisma.inventoryItem.findMany({ where: { id: { in: pending.map((l) => l.itemId) } }, select: { id: true, name: true, category: true } })).map((i) => [i.id, i]));
    receiveLines = pending.map((l) => ({ lineId: l.id, itemId: l.itemId, itemName: info.get(l.itemId)?.name ?? "Material", category: info.get(l.itemId)?.category ?? "RM", unit: l.unit, plannedQty: l.plannedQty, givenQty: l.quantity, sentQty: l.sentQty ?? 0 }));
  }
  if (withRequirements) {
    const req = await requirementsOf(b);
    const ids = req.map((r) => r.itemId);
    // A material is done once every round together has given it (within the tolerance); a part given leaves the rest to dispense, and one
    // Production refused shows why, so it is dispensed again.
    const lineRows = await prisma.batchDispensingLine.findMany({ where: { productionBatchId: b.id }, select: { itemId: true, deliveryStatus: true, receiveNote: true, createdAt: true }, orderBy: { createdAt: "asc" } });
    const givenBy = await givenByItem(b.id);
    const refusedNote = new Map(lineRows.filter((l) => l.deliveryStatus === "REFUSED").map((l) => [l.itemId, l.receiveNote]));
    const shelf = plant?.dayStoreId && ids.length ? await getOnHandByDayStoreAndItem(plant.dayStoreId, ids) : new Map<string, { onHand: number }>();
    const free = plant && ids.length ? await plantFreeQty(plant.id, ids, undefined) : new Map<string, number>();
    requirements = req.map((r) => {
      const dayStoreQty = q3(Math.max(0, shelf.get(r.itemId)?.onHand ?? 0));
      const plantFree = q3(Math.max(0, free.get(r.itemId) ?? 0));
      const givenQty = givenBy.get(r.itemId) ?? 0;
      const remainingQty = q3(Math.max(0, r.requiredQty - givenQty));
      const dispensed = isDispensed(r.requiredQty, givenQty);
      return { itemId: r.itemId, itemName: r.itemName, category: r.category, unit: r.unit, requiredQty: r.requiredQty, givenQty, remainingQty, dayStoreQty, plantFreeQty: plantFree, enough: dispensed || plantFree + dayStoreQty >= remainingQty - 1e-9, dispensed, refusedNote: dispensed ? null : (refusedNote.get(r.itemId) ?? null) };
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
    ...(requirements ? { requirements } : {}),
    ...(receiveLines ? { receiveLines } : {}),
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
    // Production's Indent Issue list (?all=1) also keeps the batches whose indent is already signed, with where they are now.
    const withSigned = stage === "INDENT_ISSUE" && req.query.all === "1";
    // A batch Production has put on hold is listed only on Held Products, not at its step
    const where: Prisma.ProductionBatchWhereInput = withSigned
      ? { ...(await scopeWhere(req)) }
      : withAllocated
        ? { OR: [{ prepStageId: "BATCH_NO", status: "IN_PROGRESS" }, { batchNo: { not: null } }], ...(await scopeWhere(req)) }
        : { status: "IN_PROGRESS", prepStageId: stage === "DISPENSING" ? { in: ["DISPENSING", "RECEIVE"] } : stage, heldAt: null, ...(await scopeWhere(req)) };
    const batches = await prisma.productionBatch.findMany({ where: { AND: [where, notProductionHeld] }, include: boardInclude, orderBy: withAllocated || withSigned ? { createdAt: "desc" } : { createdAt: "asc" } });
    // Indent Issue and Dispensing show the batch's materials (the plan scaled to the batch's quantity) and whether they are available;
    // a batch already past its indent has no use for that check.
    const rows = await Promise.all(batches.map((b) => boardRow(b, stage === "DISPENSING" || (stage === "INDENT_ISSUE" && b.prepStageId === "INDENT_ISSUE"), stage === "RECEIVE")));
    // Dispensing also lists a batch Production is receiving while some of its material is still to dispense (the Day Store need not wait).
    res.json(stage === "DISPENSING" ? rows.filter((r) => r.prepStageId === "DISPENSING" || (r.requirements ?? []).some((m) => !m.dispensed)) : rows);
  } catch (err) {
    next(err);
  }
});

/**
 * Production's "Material Received" page, batch by batch: one line per batch and material of its plan (the plan scaled to the batch's quantity).
 *   Received   what the Day Store dispensed for THIS batch (the weighed quantity); nothing until its Dispensing is done
 *   Used       everything logged against the batch: production + wastage + rejected + sample
 *   Left       Received - Used (still with Production for this batch)
 *   Available  the whole Plant's stock of the material (shared by every batch there)
 * Batches of runs from before the per-batch flow are not here: the page gets those, product by product, from /pre-productions/material-board.
 * A Plant-limited Production login sees only its own Plant's batches.
 */
batchPrepRouter.get("/production-batches/material-board", requireRole("PRODUCTION", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const batches = await prisma.productionBatch.findMany({
      where: { AND: [await scopeWhere(req), { preProduction: { purchaseOrderItem: { cancelledAt: null, deletedAt: null, materialHeldAt: null, productionHeldAt: null } } }] },
      include: boardInclude,
      orderBy: { createdAt: "desc" },
    });
    if (batches.length === 0) return res.json([]);

    const ids = batches.map((b) => b.id);
    const [lines, consumed] = await Promise.all([
      prisma.batchDispensingLine.findMany({ where: { productionBatchId: { in: ids }, deliveryStatus: { not: "REFUSED" } }, select: { productionBatchId: true, itemId: true, quantity: true, sentQty: true, deliveryStatus: true } }),
      prisma.batchMaterialConsumption.groupBy({ by: ["productionBatchId", "itemId", "purpose"], where: { productionBatchId: { in: ids } }, _sum: { quantity: true } }),
    ]);
    const key = (a: string | null, b: string) => `${a}::${b}`;
    // received = in the Plant's stock (what it already held for the batch + what Production has confirmed); transit = sent, not yet confirmed
    const given = new Map<string, { received: number; transit: number }>();
    for (const l of lines) {
      const cur = given.get(key(l.productionBatchId, l.itemId)) ?? { received: 0, transit: 0 };
      if (l.deliveryStatus === "PENDING") {
        cur.transit += l.sentQty ?? 0;
        cur.received += Math.max(0, l.quantity - (l.sentQty ?? 0));
      } else cur.received += l.quantity;
      given.set(key(l.productionBatchId, l.itemId), cur);
    }
    const usedBy = new Map<string, { used: number; wasted: number; rejected: number; sample: number }>();
    for (const c of consumed) {
      const cur = usedBy.get(key(c.productionBatchId, c.itemId)) ?? { used: 0, wasted: 0, rejected: 0, sample: 0 };
      const q = c._sum.quantity ?? 0;
      if (c.purpose === "WASTE") cur.wasted += q;
      else if (c.purpose === "REJECTED") cur.rejected += q;
      else if (c.purpose === "SAMPLE") cur.sample += q;
      cur.used += q; // production + wastage + rejected + sample
      usedBy.set(key(c.productionBatchId, c.itemId), cur);
    }

    const plantIds = [...new Set(batches.flatMap((b) => (b.preProduction.plant ? [b.preProduction.plant.id] : [])))];
    const onHand = new Map<string, Map<string, number>>();
    const reqByBatch = new Map(await Promise.all(batches.map(async (b) => [b.id, await requirementsOf(b)] as const)));
    const itemIds = [...new Set([...reqByBatch.values()].flatMap((r) => r.map((m) => m.itemId)))];
    for (const plantId of plantIds) onHand.set(plantId, await getOnHandByPlantAndItem(plantId, itemIds));

    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    res.json(
      batches.flatMap((b) => {
        const po = b.preProduction.purchaseOrderItem;
        const plant = b.preProduction.plant;
        const early = ["INDENT_ISSUE", "BATCH_NO", "DISPENSING", "RECEIVE"].includes(b.prepStageId);
        return (reqByBatch.get(b.id) ?? []).map((m) => {
          const g = given.get(key(b.id, m.itemId));
          const dispensed = !!g; // the material has a line: it was dispensed (received, or still on its way)
          const receivedQty = g ? r3(g.received) : 0;
          const inTransitQty = g ? r3(g.transit) : 0;
          const u = usedBy.get(key(b.id, m.itemId)) ?? { used: 0, wasted: 0, rejected: 0, sample: 0 };
          return {
            batchId: b.id,
            batchNo: b.batchNo,
            batchQty: b.plannedQty,
            prepStageId: b.prepStageId,
            batchStatus: b.status,
            itemId: po.id,
            poId: po.purchaseOrder.id,
            poNumber: po.purchaseOrder.poNumber,
            customerName: po.purchaseOrder.customer.companyName,
            productName: po.productName,
            productCategory: po.productCategory,
            plant: plant ? { id: plant.id, name: plant.name } : null,
            releasedQty: b.plannedQty,
            orderQty: po.quantity,
            productUnit: po.unit,
            material: m.itemName,
            category: m.category,
            unit: m.unit,
            requiredQty: m.requiredQty,
            receivedQty,
            inTransitQty,
            balanceQty: dispensed ? Math.max(0, r3(m.requiredQty - receivedQty - inTransitQty)) : m.requiredQty,
            usedQty: r3(u.used),
            wastedQty: r3(u.wasted),
            rejectedQty: r3(u.rejected),
            sampleQty: r3(u.sample),
            leftQty: r3(receivedQty - u.used),
            availableQty: dispensed && plant ? r3(onHand.get(plant.id)?.get(m.itemId) ?? 0) : null,
            status: !dispensed ? (early ? "NOT_DISPENSED" : "NOT_RECEIVED") : inTransitQty > 0 ? "IN_TRANSIT" : receivedQty >= m.requiredQty - 1e-6 ? "FULL" : "PARTIAL",
            sentAt: b.createdAt,
          };
        });
      }),
    );
  } catch (err) {
    next(err);
  }
});

batchPrepRouter.get("/production-batches/prep-summary", async (req: AuthedRequest, res, next) => {
  try {
    const where = { AND: [{ status: "IN_PROGRESS" as const, heldAt: null }, await scopeWhere(req), notProductionHeld] };
    const groups = await prisma.productionBatch.groupBy({ by: ["prepStageId"], where, _count: { _all: true } });
    const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<PrepStage, number>;
    for (const g of groups) counts[g.prepStageId] = g._count._all;
    // A batch Production is receiving with some material still to dispense also waits at the Day Store's Dispensing.
    const receiving = await prisma.productionBatch.findMany({ where: { AND: [where, { prepStageId: "RECEIVE" }] }, include: boardInclude });
    for (const b of receiving) {
      const planned = await requirementsOf(b);
      const given = await givenByItem(b.id);
      if (planned.some((p) => !isDispensed(p.requiredQty, given.get(p.itemId) ?? 0))) counts.DISPENSING += 1;
    }
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
 * the batches one by one. A batch can be held only while it is still in preparation (Indent Issue to Dispensing / Receive): once it is READY
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
        // a product Production held before its run was started has no run yet
        ...(plantScope ? { plannedPlantId: { in: plantScope } } : {}),
        AND: [{ OR: [{ preProduction: { is: null } }, { preProduction: { is: { batchFlow: true } } }] }],
        OR: [{ materialHeldAt: { not: null } }, { productionHeldAt: { not: null } }, { preProduction: { is: { productionBatches: { some: { heldAt: { not: null } } } } } }],
      },
      orderBy: [{ materialHeldAt: { sort: "desc", nulls: "last" } }, { productionHeldAt: { sort: "desc", nulls: "last" } }, { productName: "asc" }],
      select: {
        id: true,
        productName: true,
        quantity: true,
        unit: true,
        materialHeldAt: true,
        productionHeldAt: true,
        productionHeldById: true,
        productionHoldReason: true,
        purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } },
        preProduction: {
          select: {
            id: true,
            plant: { select: { name: true } },
            productionBatches: {
              orderBy: { createdAt: "asc" },
              select: { id: true, batchNo: true, plannedQty: true, status: true, prepStageId: true, currentStageId: true, shiftStartAt: true, heldAt: true, holdReason: true, heldBy: { select: { fullName: true } } },
            },
          },
        },
      },
    });
    const heldByNames = new Map((await prisma.user.findMany({ where: { id: { in: items.flatMap((i) => (i.productionHeldById ? [i.productionHeldById] : [])) } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
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
          productionHeld: !!item.productionHeldAt,
          productionHeldAt: item.productionHeldAt?.toISOString() ?? null,
          productionHoldReason: item.productionHoldReason,
          productionHeldByName: item.productionHeldById ? (heldByNames.get(item.productionHeldById) ?? null) : null,
          batches: batches.map((b) => ({
            id: b.id,
            batchNo: b.batchNo,
            plannedQty: b.plannedQty,
            stageLabel: b.status === "COMPLETED" ? "Manufacturing done" : b.prepStageId === "READY" ? (b.shiftStartAt ? `${COMBINED_LOT_STAGE_LABEL[b.currentStageId]} (${stageDepartment(b.currentStageId)})` : "In production") : STAGE_LABEL[b.prepStageId],
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

// ---------------------------------------------------------------------------------------------------------------- Production's own Hold / Cancel of a product

const productHoldSchema = z
  .object({ held: z.boolean(), reason: z.string().trim().max(500).optional() })
  .refine((d) => !d.held || !!d.reason, { message: "Write why you are holding this product.", path: ["reason"] });

const productSelect = {
  id: true,
  productName: true,
  unit: true,
  cancelledAt: true,
  deletedAt: true,
  materialHeldAt: true,
  productionHeldAt: true,
  planSentToProductionAt: true,
  plannedPlantId: true,
  purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } },
  preProduction: { select: { id: true, plantId: true, _count: { select: { productionBatches: true } } } },
} satisfies Prisma.PurchaseOrderItemSelect;

/** A product PPIC has sent to Production, that this Production login may act on. */
async function loadSentProduct(req: AuthedRequest<{ itemId: string }>) {
  const item = await prisma.purchaseOrderItem.findUnique({ where: { id: req.params.itemId }, select: productSelect });
  if (!item || item.deletedAt || !item.planSentToProductionAt) throw new RouteError(404, "This product is not with Production.");
  if (item.cancelledAt) throw new RouteError(409, "This product is cancelled.");
  await assertPlantAccess(req.user!.id, req.user!.roles, item.preProduction?.plantId ?? item.plannedPlantId);
  return item;
}

/** A batch in manufacturing (or finished) means the product can no longer be held or returned: it follows the whole pipeline. */
async function hasStartedManufacturing(runId: string | undefined): Promise<boolean> {
  if (!runId) return false;
  return (await prisma.productionBatch.count({ where: { preProductionId: runId, OR: [{ prepStageId: "READY" }, { status: "COMPLETED" }] } })) > 0;
}

/**
 * Production holds / releases a whole product (its own hold, separate from PPIC's). While held: no new batch, no step moves, and the product
 * leaves New Plan for Held Products, where Production releases it. Allowed until a batch is in manufacturing.
 */
batchPrepRouter.patch("/production-batches/products/:itemId/hold", requireRole("PRODUCTION"), validateBody(productHoldSchema), async (req: AuthedRequest<{ itemId: string }>, res, next) => {
  try {
    const { held, reason } = req.body as z.infer<typeof productHoldSchema>;
    const item = await loadSentProduct(req);
    if (held) {
      if (item.productionHeldAt) return res.status(409).json({ error: "You have already put this product on hold." });
      if (await hasStartedManufacturing(item.preProduction?.id)) return res.status(409).json({ error: "A batch of this product is already in production, so it can't be held. It follows the whole pipeline." });
    } else if (!item.productionHeldAt) {
      return res.status(409).json({ error: "This product is not on hold by Production." });
    }
    await prisma.purchaseOrderItem.update({
      where: { id: item.id },
      data: held ? { productionHeldAt: new Date(), productionHeldById: req.user!.id, productionHoldReason: reason } : { productionHeldAt: null, productionHeldById: null, productionHoldReason: null },
    });
    await recordAudit({ actorId: req.user!.id, action: held ? "purchase_order.item_held_by_production" : "purchase_order.item_hold_released_by_production", entityType: "PurchaseOrder", entityId: item.purchaseOrder.id, metadata: { itemId: item.id, ...(held ? { reason } : {}) } });
    const label = `${item.productName} (${item.purchaseOrder.poNumber ?? "PO"})`;
    await notifyRoles(["PPIC"], held ? { title: `Production put ${label} on hold`, body: reason ?? "", link: "/held-products" } : { title: `Production released ${label}`, body: "It goes on.", link: "/held-products" }, req.user!.id).catch((err) => logger.error({ err }, "notify failed: product.production_hold"));
    res.json({ itemId: item.id, productionHeld: held });
  } catch (err) {
    next(err);
  }
});

const productCancelSchema = z.object({ reason: z.string().trim().min(3, "Write why you are cancelling this product.").max(500) });

/**
 * Production's Cancel: the product is dead for good, exactly as when PPIC cancels it (it drops out of every list; no undo). Only while no batch
 * has been made. PPIC and BD are told.
 */
batchPrepRouter.post("/production-batches/products/:itemId/cancel", requireRole("PRODUCTION"), validateBody(productCancelSchema), async (req: AuthedRequest<{ itemId: string }>, res, next) => {
  try {
    const { reason } = req.body as z.infer<typeof productCancelSchema>;
    const item = await loadSentProduct(req);
    const updated = await cancelPoItem({ itemId: item.id, actorId: req.user!.id, reason, by: "Production", log: req.log });
    res.json({ itemId: updated.id, cancelled: true });
  } catch (err) {
    next(err);
  }
});

const closeShortSchema = z.object({ reason: z.string().trim().min(3, "Write why this product is being closed short.").max(500) });

/**
 * Production closes a product short: the batches made less than was ordered and no more will be made, so it ends at what it made (the order then
 * completes once that has been dispatched). Only when every batch is done. BD is told; PPIC is not.
 */
batchPrepRouter.post("/production-batches/products/:itemId/close-short", requireRole("PRODUCTION"), validateBody(closeShortSchema), async (req: AuthedRequest<{ itemId: string }>, res, next) => {
  try {
    const item = await loadSentProduct(req);
    const done = await closeProductShort({ itemId: item.id, actorId: req.user!.id, reason: (req.body as z.infer<typeof closeShortSchema>).reason, log: req.log });
    res.json({ itemId: item.id, closedShort: true, ...done });
  } catch (err) {
    next(err);
  }
});

/** Takes it back: the product is ordered for its full quantity again, and Production can make the rest. */
batchPrepRouter.post("/production-batches/products/:itemId/reopen-short", requireRole("PRODUCTION"), async (req: AuthedRequest<{ itemId: string }>, res, next) => {
  try {
    const item = await loadSentProduct(req);
    await reopenProductShort({ itemId: item.id, actorId: req.user!.id });
    res.json({ itemId: item.id, closedShort: false });
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

/**
 * The GRN of a batch's dispensing: FLS-<first 3 letters of the product>-<batch no>-<running number of that 3-letter code>, e.g.
 * FLS-COC-FLS-26-0054-01. The running number only goes up, so two batches never share one. A batch dispensed again (Production refused
 * some material) keeps its number with a letter added: ...-01-A, then ...-01-B.
 */
async function nextGrnNo(tx: Pick<Prisma.TransactionClient, "batchNoCounter">, productName: string, batchNo: string | null, latest: string | null, consume: boolean): Promise<string> {
  if (latest) return redispenseGrnNo(latest);
  const code = productName.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3).padEnd(3, "X");
  const key = `GRN-${code}`;
  // consume = false only looks at the number the next batch would get (the Generate button); the counter moves when the batch is dispensed.
  const last = consume ? (await tx.batchNoCounter.upsert({ where: { key }, create: { key, last: 1 }, update: { last: { increment: 1 } } })).last : ((await tx.batchNoCounter.findUnique({ where: { key } }))?.last ?? 0) + 1;
  return `FLS-${code}-${batchNo ?? "NA"}-${String(last).padStart(2, "0")}`;
}

/** What each material of a batch has been given so far, over every round (a refused line no longer counts; a short receipt does not reduce it). */
async function givenByItem(batchId: string, client: Pick<Prisma.TransactionClient, "batchDispensingLine"> = prisma): Promise<Map<string, number>> {
  const lines = await client.batchDispensingLine.findMany({ where: { productionBatchId: batchId, deliveryStatus: { not: "REFUSED" } }, select: { itemId: true, quantity: true, givenQty: true } });
  const given = new Map<string, number>();
  for (const l of lines) given.set(l.itemId, q3((given.get(l.itemId) ?? 0) + (l.givenQty ?? l.quantity)));
  return given;
}

/** A material counts as dispensed once what is left to give is within the weighing tolerance of the plan quantity (9.8 Kg of 10 Kg is done). */
const isDispensed = (required: number, given: number) => required - given <= required * DISPENSE_TOLERANCE + 1e-9;

/** Letters after a number: A, B, ... Z, AA, AB, ... */
function nextLetters(letters: string): string {
  const chars = letters.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== "Z") {
      chars[i] = String.fromCharCode(chars[i]!.charCodeAt(0) + 1);
      return chars.join("");
    }
    chars[i] = "A";
  }
  return `A${chars.join("")}`;
}

function redispenseGrnNo(existing: string): string {
  const m = /^(.*-\d+)(?:-([A-Z]+))?$/.exec(existing);
  const base = m?.[1] ?? existing;
  return `${base}-${m?.[2] ? nextLetters(m[2]) : "A"}`;
}

batchPrepRouter.post("/production-batches/:id/batch-no/allocate", requireRole("RND"), validateBody(allocateSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await loadBatch(req.params.id);
    if (!batch || !batch.preProduction.batchFlow) return res.status(404).json({ error: "Batch not found" });
    if (batch.prepStageId !== "BATCH_NO") return res.status(409).json({ error: batch.batchNo ? `This batch already has its number (${batch.batchNo}).` : `This batch is at ${STAGE_LABEL[batch.prepStageId]}: Production has to sign its indent first.` });
    if (batch.heldAt) return res.status(409).json({ error: HELD_MESSAGE });
    const productHeld = await productionHoldMessage(batch.preProduction.purchaseOrderItem.id);
    if (productHeld) return res.status(409).json({ error: productHeld });
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
  // The GRN is made by the system, never typed. The screen sends the one its Generate button showed; it is checked against what the system
  // would make now (another batch of the same product may have taken that number meanwhile). Left out, the system just makes it.
  grnNo: z.string().trim().max(120).optional(),
  // partial = false (the usual one-click case): every material still to give is dispensed in full, `lines` only record a different weighing.
  // partial = true: only the materials in `lines` are dispensed, each for `actualQty` (a part of what is left is fine; the rest is dispensed later).
  partial: z.boolean().optional(),
  // What the Day Store actually weighed out for each material. Leave a material out (or send no lines at all) and what is left to give is
  // taken as given. A weighing more than the tolerance away from what is left needs a note saying why.
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        actualQty: z.coerce.number().positive("The weighed quantity must be more than zero."),
        grossWeight: z.coerce.number().nonnegative().optional(),
        tareWeight: z.coerce.number().nonnegative().optional(),
        arNo: z.string().trim().max(60).optional(),
        note: z.string().trim().max(300).optional(),
      }),
    )
    .max(200)
    .optional(),
});

/** How far a weighed quantity may be from the plan before the Day Store has to say why. */
const DISPENSE_TOLERANCE = 0.05;

/** The Generate button: the GRN the next dispensing round of this batch will get. Nothing is reserved; the number is fixed when the batch is dispensed. */
batchPrepRouter.get("/production-batches/:id/grn-preview", requireRole("STORE"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await loadBatch(req.params.id);
    if (!batch || !batch.preProduction.batchFlow) return res.status(404).json({ error: "Batch not found" });
    await assertRunDayStoreAccess(req.user!.id, req.user!.roles, batch.preProduction.plantId);
    if (!batch.batchNo) return res.status(409).json({ error: "This batch has no batch number yet: R&D allocates it first." });
    res.json({ grnNo: await nextGrnNo(prisma, batch.preProduction.purchaseOrderItem.productName, batch.batchNo, batch.grnNo, false) });
  } catch (err) {
    next(err);
  }
});

batchPrepRouter.post("/production-batches/:id/dispense", requireRole("STORE"), validateBody(dispenseSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await loadBatch(req.params.id);
    if (!batch || !batch.preProduction.batchFlow) return res.status(404).json({ error: "Batch not found" });
    await assertRunDayStoreAccess(req.user!.id, req.user!.roles, batch.preProduction.plantId);
    if (batch.prepStageId === "BATCH_NO" || batch.prepStageId === "INDENT_ISSUE") return res.status(409).json({ error: "This batch has no batch number yet: R&D allocates it first." });
    if (batch.heldAt) return res.status(409).json({ error: HELD_MESSAGE });
    const productHeld = await productionHoldMessage(batch.preProduction.purchaseOrderItem.id);
    if (productHeld) return res.status(409).json({ error: productHeld });
    const plant = batch.preProduction.plant;
    const input = req.body as z.infer<typeof dispenseSchema>;
    const planned = await requirementsOf(batch);
    // What each material still needs: the plan quantity less what earlier rounds gave. A batch at Receive (Production confirming a round)
    // can still be dispensed for what is left, so the Day Store need not wait.
    const givenSoFar = await givenByItem(batch.id);
    const status = planned.map((p) => ({ ...p, given: givenSoFar.get(p.itemId) ?? 0, remaining: q3(Math.max(0, p.requiredQty - (givenSoFar.get(p.itemId) ?? 0))), complete: isDispensed(p.requiredQty, givenSoFar.get(p.itemId) ?? 0) }));
    const atDispensing = batch.prepStageId === "DISPENSING" || (batch.prepStageId === "RECEIVE" && status.some((s) => !s.complete));
    if (!atDispensing) return res.status(409).json({ error: batch.prepStageId === "RECEIVE" ? "Every material of this batch has been dispensed: Production is receiving it." : "This batch has already been dispensed." });
    // Once dispensed the batch keeps the BOM version it was dispensed under (R&D's later changes are for the batches after it).
    const productSlot = (await prisma.purchaseOrderItem.findUnique({ where: { id: batch.preProduction.purchaseOrderItem.id }, select: { productionBomSlot: true } }))?.productionBomSlot;
    const dispensedSlot = effectiveBomSlot(batch.bomSlot, productSlot) ?? "BASE";
    if (planned.length > 0 && !plant) return res.status(400).json({ error: "Assign a Plant to this run before dispensing." });

    // What is actually given in this round: the weighed / chosen quantity where one was entered, else what is left to give. `requiredQty` below
    // is what is GIVEN (it drives the Plant / Day Store stock check and the line); `plannedQty` keeps what the plan asked for.
    const partial = input.partial === true;
    const weighed = new Map((input.lines ?? []).map((l) => [l.itemId, l]));
    for (const l of input.lines ?? []) {
      if (!planned.some((p) => p.itemId === l.itemId)) return res.status(400).json({ error: "A weighed line is for a material that is not in this batch's plan. Material outside the plan goes through Extra Material." });
    }
    if (partial && weighed.size === 0) return res.status(400).json({ error: "Pick at least one material to dispense." });
    const done = status.filter((s) => s.complete && weighed.has(s.itemId));
    if (partial && done.length > 0) return res.status(409).json({ error: `Already fully dispensed: ${done.map((d) => d.itemName).join(", ")}.` });
    // A partial round gives only the picked materials; otherwise every material that is still to give.
    const required = status
      .filter((s) => !s.complete && (!partial || weighed.has(s.itemId)))
      .map((s) => {
        const w = weighed.get(s.itemId);
        const give = q3(w?.actualQty ?? s.remaining);
        // Giving a part of what is left is a partial round, not a deviation: only more than what is left (or, in a full round, any weighing
        // far from it) needs a reason.
        const off = s.remaining > 0 ? (partial ? Math.max(0, give - s.remaining) : Math.abs(give - s.remaining)) / s.remaining : 0;
        return { ...s, plannedQty: s.requiredQty, requiredQty: give, weighing: w, off };
      });
    const unexplained = required.filter((r) => r.off > DISPENSE_TOLERANCE && !r.weighing?.note);
    if (unexplained.length > 0) {
      return res.status(400).json({ error: `Weighed more than ${Math.round(DISPENSE_TOLERANCE * 100)}% away from what is left to give - write why: ${unexplained.map((r) => `${r.itemName} (left ${r.remaining}, weighed ${r.requiredQty} ${r.unit})`).join("; ")}.` });
    }
    const toGive = required;
    if (planned.length > 0 && toGive.length === 0) return res.status(409).json({ error: "Every material of this batch has already been dispensed." });
    // Approved vendors: a material this product may only take from certain vendors (unless R&D allowed another).
    const poItemId = batch.preProduction.purchaseOrderItem.id;
    const vendorRules = (await rulesForPoItems([poItemId])).get(poItemId);
    const allowedOf = (itemId: string) => allowedKeysOf(vendorRules?.get(itemId));

    const updated = await runSerializable(async (tx) => {
      // The GRN of this round. The one the screen showed must still be the one the system would make (another batch of the same product
      // may have taken that number since Generate was pressed); then the counter moves.
      const productName = batch.preProduction.purchaseOrderItem.productName;
      const shown = await nextGrnNo(tx, productName, batch.batchNo, batch.grnNo, false);
      if (input.grnNo && input.grnNo !== shown) throw new RouteError(409, `The GRN has changed (it is now ${shown}). Press Generate again.`);
      const grnNo = await nextGrnNo(tx, productName, batch.batchNo, batch.grnNo, true);
      let anySent = false;
      if (toGive.length > 0) {
        const ids = toGive.map((r) => r.itemId);
        // The Plant may already hold some of the material (issued to it earlier for the plan); the Day Store gives what is missing.
        const free = await plantFreeQty(plant!.id, ids, tx);
        const shelf = plant!.dayStoreId ? await getOnHandByDayStoreAndItem(plant!.dayStoreId, ids, tx) : new Map<string, { onHand: number }>();
        // For a restricted material only the approved vendors' stock counts: what the Plant already holds from them, and what the Day Store
        // holds from them. Stock of another vendor sitting there does not cover the batch.
        const wrongVendor: string[] = [];
        const approvedFree = new Map<string, number>();
        const approvedShelf = new Map<string, number>();
        for (const r of toGive) {
          const keys = allowedOf(r.itemId);
          if (!keys) continue;
          approvedFree.set(r.itemId, Math.min(free.get(r.itemId) ?? 0, await approvedPlantStock(tx, r.itemId, keys, plant!.id)));
          approvedShelf.set(r.itemId, Math.min(shelf.get(r.itemId)?.onHand ?? 0, plant!.dayStoreId ? await approvedStoreStock(tx, r.itemId, keys, plant!.dayStoreId) : 0));
          if (r.requiredQty - approvedFree.get(r.itemId)! > approvedShelf.get(r.itemId)! + 1e-9) {
            const rule = vendorRules!.get(r.itemId)!;
            wrongVendor.push(`${r.itemName} (needs ${r.requiredQty} ${r.unit}; ${rule.vendorNames.join(" / ")} hold only ${q3(approvedFree.get(r.itemId)! + approvedShelf.get(r.itemId)!)} here)`);
          }
        }
        if (wrongVendor.length > 0) {
          throw new RouteError(409, `Approved vendor only - this product may not use another vendor's material for: ${wrongVendor.join("; ")}. Get the approved vendor's material to the Store, or ask R&D to allow another vendor for this product.`);
        }
        const shortfalls = toGive.map((r) => ({ ...r, short: q3(Math.max(0, r.requiredQty - (approvedFree.get(r.itemId) ?? free.get(r.itemId) ?? 0))) })).filter((s) => s.short > 1e-9);
        const stillShort = shortfalls.filter((s) => s.short > (shelf.get(s.itemId)?.onHand ?? 0) + 1e-9);
        if (stillShort.length > 0) {
          throw new RouteError(409, `The Store does not hold enough material for this batch: ${stillShort.map((s) => `${s.itemName} (needs ${s.short} more, Store has ${q3(Math.max(0, shelf.get(s.itemId)?.onHand ?? 0))} ${s.unit})`).join("; ")}.`);
        }
        // What the Day Store sends to the Plant is ON ITS WAY until Production confirms it (the Receive step): it has left the Day Store's
        // stock, and does not count in the Plant's until it is received.
        const issueOf = new Map<string, { id: string; qty: number }>();
        for (const s of shortfalls) {
          const open = await tx.inventoryRequest.findFirst({
            where: { purchaseOrderItemId: batch.preProduction.purchaseOrderItem.id, itemId: s.itemId, purpose: "ISSUED_PRODUCTION", preProductionId: null, deletedAt: null, status: { in: ["PENDING", "APPROVED", "PARTIALLY_ISSUED"] } },
            include: { fulfillments: { where: { deletedAt: null }, select: { quantity: true } } },
            orderBy: { createdAt: "asc" },
          });
          const issue = await tx.inventoryTransaction.create({
            data: {
              itemId: s.itemId,
              type: "ISSUED_PRODUCTION",
              date: new Date(),
              unit: s.unit,
              quantity: s.short,
              createdById: req.user!.id,
              dayStoreId: plant!.dayStoreId,
              plantId: plant!.id,
              fulfillsRequestId: open?.id ?? null,
              isTransitTracked: true,
              deliveredAt: null,
              deliveredById: null,
              remark: `Sent to the Plant at Dispensing (${batch.batchNo ?? "batch"}) - waiting for Production to receive it`,
            },
          });
          // Which lots that came out of the Day Store, oldest expiry first (only the approved vendors' lots for a restricted material).
          await recordIssueLots(tx, issue, allowedOf(s.itemId));
          issueOf.set(s.itemId, { id: issue.id, qty: s.short });
          anySent = true;
          if (open) {
            const issued = open.fulfillments.reduce((x, f) => x + f.quantity, 0) + s.short;
            await tx.inventoryRequest.update({ where: { id: open.id }, data: { status: issued >= open.requestedQty - 1e-9 ? "ISSUED" : "PARTIALLY_ISSUED" } });
          }
        }
        // One line per material: what was weighed and given, what the plan asked for, what is on its way, and (once the Plant holds it) which lots.
        for (const r of toGive) {
          const sent = issueOf.get(r.itemId);
          const line = await tx.batchDispensingLine.create({
            data: {
              productionBatchId: batch.id,
              itemId: r.itemId,
              quantity: r.requiredQty,
              givenQty: r.requiredQty,
              grnNo,
              plannedQty: r.plannedQty,
              unit: r.unit,
              grossWeight: r.weighing?.grossWeight,
              tareWeight: r.weighing?.tareWeight,
              arNo: r.weighing?.arNo,
              note: r.weighing?.note,
              // Nothing had to be sent (the Plant already held it all): there is nothing to receive.
              deliveryStatus: sent ? "PENDING" : "RECEIVED",
              sentQty: sent?.qty,
              issueTxnId: sent?.id,
              receivedAt: sent ? null : new Date(),
              receivedById: sent ? null : req.user!.id,
              createdById: req.user!.id,
            },
          });
          if (!sent) await recordDispensingLots(tx, line, plant!.id, allowedOf(r.itemId));
        }
      }
      // Where the batch goes: Receive when something was sent to the Plant (or Production is already receiving an earlier round); READY when
      // nothing had to be sent and every material is now dispensed; else back to Dispensing for what is left.
      const gave = new Map(toGive.map((r) => [r.itemId, r.requiredQty]));
      const allDone = status.every((s) => isDispensed(s.requiredQty, s.given + (gave.get(s.itemId) ?? 0)));
      const nextStage = anySent || batch.prepStageId === "RECEIVE" ? "RECEIVE" : allDone ? "READY" : "DISPENSING";
      // READY is not allowed while PPIC has the product on hold (or cancelled).
      if (nextStage === "READY") {
        const blocked = await productionBlockedByHoldOrCancel(batch.preProduction.purchaseOrderItem.id);
        if (blocked) throw new RouteError(409, blocked);
      }
      return tx.productionBatch.update({
        where: { id: batch.id },
        data: { rmDispensingDate: input.rmDispensingDate, pmIssuedDate: input.pmIssuedDate, dispensingRemarks: input.dispensingRemarks, grnNo, dispensedAt: new Date(), bomSlot: dispensedSlot, prepStageId: nextStage },
        include: boardInclude,
      });
    });
    await recordAudit({ actorId: req.user!.id, action: "production_batch.dispensed", entityType: "ProductionBatch", entityId: batch.id, metadata: { materials: toGive.length, toReceive: updated.prepStageId === "RECEIVE" } });
    const product = batch.preProduction.purchaseOrderItem;
    if (updated.prepStageId === "RECEIVE") {
      await notifyRoles(["PRODUCTION"], { title: `${updated.batchNo}: ${product.productName} - material is on its way`, body: "The Store has sent this batch's material to the Plant. Confirm what arrived, material by material.", link: "/material-received" }, req.user!.id).catch((err) => logger.error({ err }, "notify failed: batch.dispense.production"));
    } else if (updated.prepStageId === "READY") {
      await notifyRoles(["PRODUCTION"], { title: `${updated.batchNo}: ${product.productName} is ready for production`, body: `${batch.plannedQty} ${product.unit}: the material is dispensed. Start the batch.`, link: "/batches" }, req.user!.id).catch((err) => logger.error({ err }, "notify failed: batch.dispense"));
    }
    res.json(await boardRow(updated, false));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- Extra material (Day Store)

/**
 * The Day Store dispenses the extra material Production asked for a batch (outside its plan, or what R&D's later BOM change needs): the same
 * kind of step as Dispensing, but for one approved extra request and at any step of the batch's production (not only while it is at Dispensing).
 * It has its own GRN (the batch's number with the next letter), the lots it was drawn from (oldest expiry first, approved vendors only), and
 * goes to the Plant as an issue that is ON ITS WAY until Production receives it (Extra Material, or the Transit list).
 */
const dispenseExtraSchema = z.object({
  requestId: z.string().uuid(),
  // What was actually weighed and given; the rest of what is owed when left out
  quantity: z.coerce.number().positive().optional(),
  note: z.string().trim().max(300).optional(),
});

batchPrepRouter.post("/production-batches/:id/dispense-extra", requireRole("STORE"), validateBody(dispenseExtraSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await loadBatch(req.params.id);
    if (!batch || !batch.preProduction.batchFlow) return res.status(404).json({ error: "Batch not found" });
    await assertRunDayStoreAccess(req.user!.id, req.user!.roles, batch.preProduction.plantId);
    if (!batch.batchNo) return res.status(409).json({ error: "This batch has no batch number yet." });
    if (batch.heldAt) return res.status(409).json({ error: HELD_MESSAGE });
    const product = batch.preProduction.purchaseOrderItem;
    const productHeld = await productionHoldMessage(product.id);
    if (productHeld) return res.status(409).json({ error: productHeld });
    if (PAST_PACKING_STAGES.includes(batch.currentStageId)) return res.status(409).json({ error: "This batch has already been packed and gone to the finished-goods store: no more material is dispensed for it." });
    const plant = batch.preProduction.plant;
    if (!plant?.dayStoreId) return res.status(400).json({ error: "This batch's Plant has no Store to dispense from." });
    const input = req.body as z.infer<typeof dispenseExtraSchema>;

    const request = await prisma.inventoryRequest.findFirst({
      where: { id: input.requestId, isExtra: true, productionBatchId: batch.id, deletedAt: null, status: { in: ["APPROVED", "PARTIALLY_ISSUED"] } },
      include: { item: { select: { id: true, name: true, unit: true, category: true } }, fulfillments: { where: { deletedAt: null }, select: { quantity: true } } },
    });
    if (!request) return res.status(404).json({ error: "No approved extra request of this batch with that id (the Store approves it first)." });
    const owed = q3(request.requestedQty - request.fulfillments.reduce((sum, f) => sum + f.quantity, 0));
    const qty = q3(input.quantity ?? owed);
    if (qty <= 0) return res.status(409).json({ error: "Nothing is owed on this request." });
    if (qty > owed + 1e-9) return res.status(409).json({ error: `Only ${owed} ${request.item.unit ?? ""} is still owed on this request.`.replace("  ", " ") });
    const unit = request.item.unit ?? (request.category === "RM" ? "Kg" : "Nos");
    const dayStoreId = plant.dayStoreId;

    // Approved vendors: a material this product may only take from certain vendors (unless R&D allowed another)
    const rules = (await rulesForPoItems([product.id])).get(product.id);
    const allowed = allowedKeysOf(rules?.get(request.itemId));

    const done = await runSerializable(async (tx) => {
      const onHand = (await getOnHandByDayStoreAndItem(dayStoreId, [request.itemId], tx)).get(request.itemId)?.onHand ?? 0;
      if (qty > onHand + 1e-9) throw new RouteError(409, `Your store holds only ${q3(Math.max(0, onHand))} ${unit} of ${request.item.name}. Ask the Warehouse for the rest.`);
      if (allowed) {
        const approved = await approvedStoreStock(tx, request.itemId, allowed, dayStoreId);
        if (qty > approved + 1e-9) throw new RouteError(409, `Approved vendor only - this product may not use another vendor's ${request.item.name}: only ${q3(approved)} ${unit} of the approved vendor's is in your store.`);
      }
      // The GRN of this dispensing: the batch's own number with the next letter (or a first number when the batch has none yet)
      const grnNo = batch.grnNo ? redispenseGrnNo(batch.grnNo) : await nextGrnNo(tx, product.productName, batch.batchNo, null, true);
      const txn = await tx.inventoryTransaction.create({
        data: {
          itemId: request.itemId,
          type: "ISSUED_PRODUCTION",
          date: new Date(),
          unit,
          quantity: qty,
          createdById: req.user!.id,
          dayStoreId,
          plantId: plant.id,
          fulfillsRequestId: request.id,
          grnNo,
          batchNo: batch.batchNo,
          // On its way until Production receives it: it has left the Store's stock and does not count in the Plant's yet
          isTransitTracked: true,
          deliveredAt: null,
          deliveredById: null,
          remark: `Extra material dispensed for batch ${batch.batchNo}${input.note ? ` - ${input.note}` : ""}`,
        },
      });
      await recordIssueLots(tx, txn, allowed);
      const issued = q3(request.requestedQty - owed + qty);
      await tx.inventoryRequest.update({ where: { id: request.id }, data: { status: issued >= request.requestedQty - 1e-9 ? "ISSUED" : "PARTIALLY_ISSUED" } });
      await tx.productionBatch.update({ where: { id: batch.id }, data: { grnNo } });
      return { txnId: txn.id, grnNo, issued, remaining: q3(Math.max(0, request.requestedQty - issued)) };
    });

    await recordAudit({ actorId: req.user!.id, action: "production_batch.extra_dispensed", entityType: "ProductionBatch", entityId: batch.id, metadata: { requestId: request.id, itemId: request.itemId, quantity: qty, grnNo: done.grnNo } });
    await notifyRoles(["PRODUCTION"], { title: `${batch.batchNo}: extra ${request.item.name} is on its way`, body: `${qty} ${unit} sent to the Plant (GRN ${done.grnNo}). Confirm what arrived on Extra Material.`, link: "/extra-material" }, req.user!.id).catch((err) => logger.error({ err }, "notify failed: production_batch.extra_dispensed"));
    res.status(201).json({ ...done, itemName: request.item.name, unit, quantity: qty });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- Receive (Production)

/**
 * Production confirms what the Day Store sent to the Plant for this batch, MATERIAL BY MATERIAL. Until it does, the material is on its way:
 * it has left the Day Store's stock and is not in the Plant's.
 *   RECEIVE  all of it, or less (then say what happened to the rest: it is kept as a recorded transit loss) - it joins the Plant's stock
 *   REFUSE   with a reason: it goes back to the Day Store, and the batch returns to Dispensing for those materials only
 * The batch is READY for production once every material is received (some perhaps after a second dispensing).
 */
const receiveSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: z.string().uuid(),
        action: z.enum(["RECEIVE", "REFUSE"]),
        receivedQty: z.coerce.number().positive().optional(),
        note: z.string().trim().max(300).optional(),
      }),
    )
    .min(1)
    .max(200),
});

batchPrepRouter.post("/production-batches/:id/receive", requireRole("PRODUCTION"), validateBody(receiveSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const batch = await loadBatch(req.params.id);
    if (!batch || !batch.preProduction.batchFlow) return res.status(404).json({ error: "Batch not found" });
    await assertPlantAccess(req.user!.id, req.user!.roles, batch.preProduction.plantId);
    if (batch.prepStageId !== "RECEIVE") return res.status(409).json({ error: "No material of this batch is waiting to be received." });
    if (batch.heldAt) return res.status(409).json({ error: HELD_MESSAGE });
    const productHeld = await productionHoldMessage(batch.preProduction.purchaseOrderItem.id);
    if (productHeld) return res.status(409).json({ error: productHeld });
    const plant = batch.preProduction.plant;
    if (!plant) return res.status(400).json({ error: "This batch's run has no Plant." });
    const input = req.body as z.infer<typeof receiveSchema>;
    const planned = await requirementsOf(batch);
    const receiveRules = (await rulesForPoItems([batch.preProduction.purchaseOrderItem.id])).get(batch.preProduction.purchaseOrderItem.id);

    const result = await runSerializable(async (tx) => {
      const pending = await tx.batchDispensingLine.findMany({ where: { productionBatchId: batch.id, deliveryStatus: "PENDING" } });
      const byId = new Map(pending.map((l) => [l.id, l]));
      const names = new Map((await tx.inventoryItem.findMany({ where: { id: { in: pending.map((l) => l.itemId) } }, select: { id: true, name: true } })).map((i) => [i.id, i.name]));
      const seen = new Set<string>();
      const refused: string[] = [];
      const now = new Date();
      for (const l of input.lines) {
        const line = byId.get(l.lineId);
        if (!line || seen.has(l.lineId)) throw new RouteError(409, "One of these materials is not waiting to be received (it may already be done).");
        seen.add(l.lineId);
        const name = names.get(line.itemId) ?? "material";
        const issue = line.issueTxnId ? await tx.inventoryTransaction.findUnique({ where: { id: line.issueTxnId } }) : null;
        if (l.action === "REFUSE") {
          if (!l.note || l.note.length < 3) throw new RouteError(400, `Write why ${name} is refused.`);
          if (issue && !issue.deletedAt) {
            // Back to the Day Store: a cancelled issue gives its quantity back to the sender's stock.
            await tx.inventoryTransaction.update({ where: { id: issue.id }, data: { deletedAt: now, deletedById: req.user!.id, shortNote: `Refused by Production: ${l.note}` } });
            if (issue.fulfillsRequestId) await resyncRequestStatus(issue.fulfillsRequestId, tx);
          }
          await tx.batchDispensingLine.update({ where: { id: line.id }, data: { deliveryStatus: "REFUSED", receivedAt: now, receivedById: req.user!.id, receiveNote: l.note } });
          refused.push(name);
        } else {
          // Less than was sent is allowed, with a reason; the difference is a recorded transit loss.
          const got = resolveShortReceipt(line.sentQty ?? 0, { receivedQty: l.receivedQty, note: l.note });
          if (issue && !issue.deletedAt) {
            await tx.inventoryTransaction.update({ where: { id: issue.id }, data: { deliveredAt: now, deliveredById: req.user!.id, shortQty: got.shortQty, shortNote: got.shortNote } });
          }
          const received = await tx.batchDispensingLine.update({
            where: { id: line.id },
            data: { deliveryStatus: "RECEIVED", quantity: q3(line.quantity - (got.shortQty ?? 0)), receivedAt: now, receivedById: req.user!.id, receiveNote: got.shortNote },
          });
          // Now the Plant holds it: which lots it was drawn from.
          await recordDispensingLots(tx, received, plant.id, allowedKeysOf(receiveRules?.get(line.itemId)));
        }
      }
      const stillPending = await tx.batchDispensingLine.count({ where: { productionBatchId: batch.id, deliveryStatus: "PENDING" } });
      let stage: "RECEIVE" | "DISPENSING" | "READY" = "RECEIVE";
      if (stillPending === 0) {
        // Nothing is on its way any more: READY when every material is fully dispensed over all rounds, else back to Dispensing for the rest.
        const given = await givenByItem(batch.id, tx);
        stage = planned.some((p) => !isDispensed(p.requiredQty, given.get(p.itemId) ?? 0)) ? "DISPENSING" : "READY";
      }
      if (stage === "READY") {
        const blocked = await productionBlockedByHoldOrCancel(batch.preProduction.purchaseOrderItem.id);
        if (blocked) throw new RouteError(409, blocked);
      }
      const row = await tx.productionBatch.update({ where: { id: batch.id }, data: { prepStageId: stage }, include: boardInclude });
      return { row, stage, refused };
    });

    await recordAudit({ actorId: req.user!.id, action: "production_batch.material_received", entityType: "ProductionBatch", entityId: batch.id, metadata: { lines: input.lines.length, refused: result.refused, stage: result.stage } });
    const product = batch.preProduction.purchaseOrderItem;
    if (result.stage === "READY") {
      await notifyRoles(["PRODUCTION"], { title: `${batch.batchNo}: ${product.productName} is ready for production`, body: `${batch.plannedQty} ${product.unit}: the material is received. Start the batch.`, link: "/batches" }, req.user!.id).catch((err) => logger.error({ err }, "notify failed: batch.receive.qa"));
    } else if (result.stage === "DISPENSING") {
      const refusedAny = result.refused.length > 0;
      await notifyPlantDayStore(plant.dayStoreId, { title: refusedAny ? `${batch.batchNo}: Production refused material` : `${batch.batchNo}: material still to dispense`, body: refusedAny ? `${result.refused.join(", ")} came back. Dispense ${result.refused.length === 1 ? "it" : "them"} again.` : "Production received what was sent. The rest of this batch's material is still to be dispensed.", link: "/batch-dispensing" }, req.user!.id).catch((err) => logger.error({ err }, "notify failed: batch.receive.daystore"));
    }
    res.json(await boardRow(result.row, false, true));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------------- Packaging (Production)

batchPrepRouter.get("/production-batches/packaging-board", requireRole("PRODUCTION", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const plantScope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    const batches = await prisma.productionBatch.findMany({
      // Batches at Packaging, plus (read only) those waiting for QA's packaging approval, and the approved ones waiting for Production's hand-over to the store
      where: {
        status: "COMPLETED",
        OR: [{ currentStageId: { in: ["PACKAGING", "QA_GATE_PACKAGING"] } }, { currentStageId: "FG_STORE", handedToStoreAt: null }],
        ...(plantScope ? { preProduction: { plantId: { in: plantScope } } } : {}),
      },
      include: productionBatchInclude,
      orderBy: { completedAt: "asc" },
    });
    res.json(await withUtilization(batches));
  } catch (err) {
    next(err);
  }
});

/** Packaging's status: In Progress by itself once the start fields are saved; Production can put it On Hold; Completed opens once the PM Utilization is done. */
const PACKAGING_STATUSES = ["In Progress", "Completed", "On Hold"] as const;

const packagingSchema = z
  .object({
    packagingShift: z.enum(["Day", "Night"]).optional(),
    packagingManpowerCount: z.coerce.number().int().positive().optional(),
    packagingStartAt: z.coerce.date().optional(),
    packagingEndAt: z.coerce.date().optional(),
    packagingStatus: z
      .string()
      .trim()
      .transform((s, ctx) => {
        const known = PACKAGING_STATUSES.find((x) => x.toLowerCase() === s.toLowerCase());
        if (!known) {
          ctx.addIssue({ code: "custom", message: `The Packaging status is one of: ${PACKAGING_STATUSES.join(", ")}.` });
          return z.NEVER;
        }
        return known;
      })
      .optional(),
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

    // (The RM Utilization was filled before the batch was sent to Packaging: Packaging only has its own sheet and the PM Utilization.)

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
    // A finished sheet (start fields, end time, PM Utilization done) is Completed and goes to QA's packaging gate by itself, unless Production put it On Hold
    const endNow = data.packagingEndAt ?? batch.packagingEndAt;
    let sendToQa = false;
    if (endNow && String(data.packagingStatus ?? batch.packagingStatus ?? "").trim().toLowerCase() !== "on hold") {
      const u = (await utilizationOfBatches(batch.preProduction.purchaseOrderItem.id, [{ id: batch.id, plannedQty: batch.plannedQty }])).get(batch.id)!;
      const startOk = !!(data.packagingShift ?? batch.packagingShift) && !!(data.packagingManpowerCount ?? batch.packagingManpowerCount) && !!(data.packagingStartAt ?? batch.packagingStartAt);
      if (u.pm.complete && startOk) {
        patch.packagingStatus = "Completed";
        sendToQa = true;
      }
    }
    // Packaging is In Progress by itself as soon as its start fields are saved (unless a status was chosen)
    const startedNow = !!(data.packagingShift ?? batch.packagingShift) && !!(data.packagingManpowerCount ?? batch.packagingManpowerCount) && !!(data.packagingStartAt ?? batch.packagingStartAt);
    const statusNow = String(data.packagingStatus ?? batch.packagingStatus ?? "").trim().toLowerCase();
    if (startedNow && (statusNow === "" || statusNow === "not started")) patch.packagingStatus = "In Progress";
    if (data.packagingStartAt) patch.packagingStartDate = data.packagingStartAt;
    if (data.packagingEndAt) patch.packagingEndDate = data.packagingEndAt;
    const updated = await prisma.productionBatch.update({ where: { id: batch.id }, data: patch, include: productionBatchInclude });
    await recordAudit({ actorId: req.user!.id, action: "production_batch.packaging_updated", entityType: "ProductionBatch", entityId: batch.id });
    if (sendToQa) {
      // The batch stays where it is physically; it now waits for QA's approval at the packaging gate (QA is told)
      const moved = await transitionProductionBatchStage({ batch: updated, action: "FORWARD", rawBody: {}, actorId: req.user!.id, actorRoles: req.user!.roles });
      if (!moved.ok) return res.status(moved.status).json({ error: moved.error });
      await recordAudit({ actorId: req.user!.id, action: "production_batch.packaging_sent_for_qa_approval", entityType: "ProductionBatch", entityId: batch.id });
      return res.json((await withUtilization([moved.updated]))[0]);
    }
    res.json((await withUtilization([updated]))[0]);
  } catch (err) {
    next(err);
  }
});

export { serializeProductionBatch };
