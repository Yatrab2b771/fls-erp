import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { RouteError } from "../../common/lib/route-error";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { assertPlantAccess } from "../inventory/day-store-access";
import { getOnHandByPlantAndItem } from "../inventory/stock";
import { productionHoldMessage } from "../purchase-orders/hold-guards";
import { withUtilization } from "./production-batches.routes";
import { productionBatchInclude } from "./batch-include";
import { utilizationOfBatches } from "./batch-utilization";
import { goodQtyOf } from "./good-qty";
import { backWithProduction } from "./batch-pipeline";

/**
 * A batch's Utilization is entered for the whole batch, then shared out over the materials:
 *
 *   PUT /production-batches/:id/utilization/:category      category RM (while the batch is in production, before its end time) or PM (at Packaging)
 *
 * Production gives the four numbers of the whole batch (Produced, Waste, Reject, Sample) and, material by material, the lines the form worked
 * out from the plan (each editable, with extra materials added). Saving REPLACES that kind's Utilization of the batch (it can be edited again
 * until the batch is handed over to QA): the earlier rows are taken back (the Plant's stock and the Recycle Store's waste / reject rows
 * follow), the new ones are booked in one go. Everything downstream reads the same BatchMaterialConsumption rows as before.
 */
export const batchUtilizationRouter = Router();
batchUtilizationRouter.use(requireAuth);

const q3 = (n: number) => Math.round(n * 1000) / 1000;
const EPS = 1e-9;
const qty = z.coerce.number().min(0, "A quantity can't be negative.").max(1e9);

const saveSchema = z.object({
  producedQty: qty,
  wasteQty: qty.default(0),
  rejectQty: qty.default(0),
  sampleQty: qty.default(0),
  note: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        itemId: z.string().min(1),
        consumedQty: qty.default(0),
        wastedQty: qty.default(0),
        rejectedQty: qty.default(0),
        sampleQty: qty.default(0),
      }),
    )
    .max(500),
});

batchUtilizationRouter.put("/production-batches/:id/utilization/:category", requireRole("PRODUCTION"), validateBody(saveSchema), async (req: AuthedRequest<{ id: string; category: string }>, res, next) => {
  try {
    const category = req.params.category.toUpperCase();
    if (category !== "RM" && category !== "PM") return res.status(400).json({ error: "The Utilization is for RM or PM material." });
    const input = req.body as z.infer<typeof saveSchema>;

    const batch = await prisma.productionBatch.findUnique({ where: { id: req.params.id }, include: productionBatchInclude });
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    const run = batch.preProduction;
    if (!run.batchFlow) return res.status(409).json({ error: "This run is from before the per-batch flow: log its usage material by material." });
    await assertPlantAccess(req.user!.id, req.user!.roles, run.plantId);
    if (!run.plantId) return res.status(400).json({ error: "This run has no Plant set yet." });
    // The RM sheet is filled once the batch is back with Production from Bulk QC (before its end time and Send to Packaging open) and, for a batch
    // that reached Packaging without it, at Packaging. The PM sheet is Packaging's. Both can be edited until the batch is handed over to QA.
    const atPackaging = batch.status === "COMPLETED" && batch.currentStageId === "PACKAGING";
    const inProduction = batch.prepStageId === "READY" && !!batch.shiftStartAt && backWithProduction(batch);
    if (category === "RM" ? !inProduction : !atPackaging) {
      return res.status(409).json({
        error: category === "RM" ? "The RM Utilization is filled once Bulk QC has passed and the batch is back with Production, before it is sent to Packaging." : "The PM Utilization is filled while the batch is at Packaging, until it is handed over to QA.",
      });
    }
    const productHeld = await productionHoldMessage(run.purchaseOrderItem.id);
    if (productHeld) return res.status(409).json({ error: productHeld });

    const status = (await utilizationOfBatches(run.purchaseOrderItem.id, [{ id: batch.id, plannedQty: batch.plannedQty }])).get(batch.id)!;

    // What this sheet has to cover: every plan material of the kind needs its A. Extra materials are free, but must be of the same kind.
    const planItems = status.items.filter((i) => i.category === category);
    const lines = new Map<string, (typeof input.lines)[number]>();
    for (const l of input.lines) {
      if (lines.has(l.itemId)) return res.status(400).json({ error: "A material is listed twice." });
      lines.set(l.itemId, l);
    }
    const stock = await prisma.inventoryItem.findMany({ where: { id: { in: [...lines.keys()] } }, select: { id: true, name: true, category: true, unit: true } });
    const itemOf = new Map(stock.map((i) => [i.id, i]));
    for (const [itemId] of lines) {
      const item = itemOf.get(itemId);
      if (!item) return res.status(400).json({ error: "Unknown material in the list." });
      if (item.category !== category) return res.status(400).json({ error: `${item.name} is not a ${category} material: it can't go on the ${category} sheet.` });
    }
    if (!(input.producedQty > 0)) return res.status(400).json({ error: `Enter how much was ${category === "RM" ? "produced" : "packed"} (A) for the batch.` });
    const missing = planItems.filter((i) => !((lines.get(i.itemId)?.consumedQty ?? 0) > EPS)).map((i) => i.itemName);
    if (missing.length > 0) return res.status(400).json({ error: `Every plan material needs its Used quantity (A): ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", ..." : ""}.` });

    const result = await runSerializable(async (tx) => {
      // 1. Take back the earlier Utilization of this kind: its consumption rows and its Recycle Store rows (waste / reject).
      const old = await tx.batchMaterialConsumption.findMany({ where: { productionBatchId: batch.id, reworkId: null, item: { category } }, select: { id: true, itemId: true } });
      if (old.length > 0) {
        const leftovers = await tx.batchLeftover.findMany({ where: { productionBatchId: batch.id }, select: { itemId: true } });
        const leftoverOfKind = leftovers.length ? await tx.inventoryItem.count({ where: { id: { in: leftovers.map((l) => l.itemId) }, category } }) : 0;
        if (leftoverOfKind > 0) throw new RouteError(409, "This batch has leftover material recorded the old way: it can't be re-entered here.");
      }
      const recycle = await tx.inventoryTransaction.findMany({ where: { productionBatchId: batch.id, type: "ISSUED_RECYCLE", deletedAt: null, item: { category } }, select: { id: true } });
      if (recycle.length > 0) {
        const decided = await tx.recycleDecision.count({ where: { transactionId: { in: recycle.map((r) => r.id) } } });
        if (decided > 0) throw new RouteError(409, "The Recycle Store has already decided on this batch's waste or reject, so its Utilization can't be changed any more.");
        await tx.inventoryTransaction.updateMany({ where: { id: { in: recycle.map((r) => r.id) } }, data: { deletedAt: new Date() } });
      }
      if (old.length > 0) await tx.batchMaterialConsumption.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });

      // 2. Book the new rows. The Plant can't account for more of a material than it holds (what was taken back above counts again).
      const unitOf = (itemId: string) => planItems.find((p) => p.itemId === itemId)?.unit ?? itemOf.get(itemId)?.unit ?? (category === "RM" ? "Kg" : "Count");
      const onHand = await getOnHandByPlantAndItem(run.plantId!, [...lines.keys()], tx);
      for (const [itemId, l] of lines) {
        const total = l.consumedQty + l.wastedQty + l.rejectedQty + l.sampleQty;
        if (total > (onHand.get(itemId) ?? 0) + EPS) {
          throw new RouteError(409, `Only ${q3(onHand.get(itemId) ?? 0)} ${unitOf(itemId)} of ${itemOf.get(itemId)!.name} is on hand at this Plant: it can't account for ${q3(total)}.`);
        }
      }
      const purposes = [
        ["PRODUCTION", "consumedQty"],
        ["WASTE", "wastedQty"],
        ["REJECTED", "rejectedQty"],
        ["SAMPLE", "sampleQty"],
      ] as const;
      const rows = [...lines].flatMap(([itemId, l]) => purposes.filter(([, key]) => l[key] > EPS).map(([purpose, key]) => ({ itemId, purpose, quantity: l[key], unit: unitOf(itemId) })));
      if (rows.length > 0) {
        await tx.batchMaterialConsumption.createMany({
          data: rows.map((r) => ({ preProductionId: run.id, productionBatchId: batch.id, itemId: r.itemId, quantity: r.quantity, unit: r.unit, purpose: r.purpose, createdById: req.user!.id })),
        });
        // Waste and rejected material go on the Recycle Store's books (waste gone for good, reject held for a decision), as with any usage entry.
        const sink = rows.filter((r) => r.purpose === "WASTE" || r.purpose === "REJECTED");
        if (sink.length > 0) {
          await tx.inventoryTransaction.createMany({
            data: sink.map((r) => ({
              itemId: r.itemId,
              type: "ISSUED_RECYCLE" as const,
              recycleKind: r.purpose === "REJECTED" ? "REJECTED" : "WASTAGE",
              date: new Date(),
              unit: r.unit,
              quantity: r.quantity,
              plantId: run.plantId!,
              preProductionId: run.id,
              productionBatchId: batch.id,
              createdById: req.user!.id,
              deliveredAt: new Date(),
              deliveredById: req.user!.id,
              remark: `${r.purpose === "WASTE" ? "Wasted" : "Rejected"} at the Plant${input.note ? ` - ${input.note}` : ""}`,
            })),
          });
        }
      }

      // 3. Keep the four numbers, so the form opens with them again.
      await tx.batchUtilizationSheet.upsert({
        where: { productionBatchId_category: { productionBatchId: batch.id, category } },
        create: { productionBatchId: batch.id, category, producedQty: input.producedQty, wasteQty: input.wasteQty, rejectQty: input.rejectQty, sampleQty: input.sampleQty, savedById: req.user!.id },
        update: { producedQty: input.producedQty, wasteQty: input.wasteQty, rejectQty: input.rejectQty, sampleQty: input.sampleQty, savedById: req.user!.id },
      });

      // 4. The RM sheet gives the batch its real yield: output = what was produced, input = everything the batch accounted for. The "made so
      // far" of the run follows the change in output.
      if (category === "RM") {
        const output = q3(input.producedQty);
        // What the batch counts for in "made so far" follows the change (its output, less what the QA gate it has passed already took out)
        const delta = goodQtyOf({ ...batch, outputQty: output }) - goodQtyOf(batch);
        await tx.productionBatch.update({ where: { id: batch.id }, data: { outputQty: output, inputQty: q3(input.producedQty + input.wasteQty + input.rejectQty + input.sampleQty) } });
        // A batch still in production adds its output to the run's "made so far" when it is completed; only one already completed is trued up here.
        if (batch.status === "COMPLETED" && Math.abs(delta) > EPS) await tx.preProduction.update({ where: { id: batch.preProductionId }, data: { combinedQty: { increment: delta } } });
      }
      return tx.productionBatch.findUniqueOrThrow({ where: { id: batch.id }, include: productionBatchInclude });
    });

    await recordAudit({
      actorId: req.user!.id,
      action: "production_batch.utilization_saved",
      entityType: "ProductionBatch",
      entityId: batch.id,
      metadata: { category, producedQty: input.producedQty, wasteQty: input.wasteQty, rejectQty: input.rejectQty, sampleQty: input.sampleQty, materials: lines.size },
    });
    res.json((await withUtilization([result]))[0]);
  } catch (err) {
    next(err);
  }
});
