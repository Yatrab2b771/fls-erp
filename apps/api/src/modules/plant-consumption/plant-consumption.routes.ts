import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { RouteError } from "../../common/lib/route-error";
import { getOnHandByPlantAndItem } from "../inventory/stock";
import { recordPlantConsumptionSchema, type RecordPlantConsumptionInput } from "./plant-consumption.schemas";

export const plantConsumptionRouter = Router();

plantConsumptionRouter.use(requireAuth);

// Broad read — Production logs entries, Store/PPIC need to see the same
// picture (Store because a return lands as a pending transfer they'll
// confirm, PPIC for oversight).
const READ_ROLES = ["PRODUCTION", "STORE", "PPIC"] as const;

// Plant records, per RM/PM item on one of its own PreProduction runs, how
// much of what was issued to it was actually consumed / wasted /
// rejected / returned to a store — requirement I. Fans out into the
// same primitives the rest of the app already uses for each leg:
// consumed/wasted/rejected each become a BatchMaterialConsumption row
// (purpose PRODUCTION/WASTE/REJECTED respectively — this route is
// intentionally separate from Dispensing's own consumption logging in
// pre-production-transition.ts, which is a STORE-only, DISPENSING-stage
// action; this one is PRODUCTION-only and runs any time after material
// has actually reached the Plant), and returned becomes a StockTransfer
// with sourceType PLANT (see stock-transfers.routes.ts), tagged with
// this run's id so its own balance view (GET .../balance below) can sum
// exactly the returns tied to it.
plantConsumptionRouter.post(
  "/:preProductionId/entries",
  requireRole("PRODUCTION"),
  validateBody(recordPlantConsumptionSchema),
  async (req: AuthedRequest<{ preProductionId: string }>, res, next) => {
    try {
      const run = await prisma.preProduction.findUnique({ where: { id: req.params.preProductionId }, select: { id: true, plantId: true } });
      if (!run) return res.status(404).json({ error: "Production run not found" });
      if (!run.plantId) return res.status(400).json({ error: "This run has no Plant set yet — nothing to record consumption against." });

      const input = req.body as RecordPlantConsumptionInput;
      const item = await prisma.inventoryItem.findUnique({ where: { id: input.itemId }, select: { id: true, name: true } });
      if (!item) return res.status(400).json({ error: "Unknown inventory item" });
      if (input.destDayStoreId) {
        const destStore = await prisma.dayStore.findUnique({ where: { id: input.destDayStoreId }, select: { id: true } });
        if (!destStore) return res.status(400).json({ error: "Unknown destination Day Store" });
      }

      const totalQty = input.consumedQty + input.wastedQty + input.rejectedQty + input.returnedQty;

      // Same check-then-write-under-SERIALIZABLE pattern every other
      // gated stock action in this app uses — closes the race between
      // two entries racing the same on-hand number.
      const result = await runSerializable(async (tx) => {
        const onHand = (await getOnHandByPlantAndItem(run.plantId!, [input.itemId], tx)).get(input.itemId) ?? 0;
        if (totalQty > onHand) {
          throw new RouteError(409, `Only ${onHand} ${input.unit} of ${item.name} actually on hand at this Plant — can't account for more than that.`);
        }

        const consumptionRows = (
          [
            { purpose: "PRODUCTION", quantity: input.consumedQty },
            { purpose: "WASTE", quantity: input.wastedQty },
            { purpose: "REJECTED", quantity: input.rejectedQty },
          ] satisfies { purpose: "PRODUCTION" | "WASTE" | "REJECTED"; quantity: number }[]
        ).filter((r) => r.quantity > 0);

        if (consumptionRows.length > 0) {
          await tx.batchMaterialConsumption.createMany({
            data: consumptionRows.map((r) => ({
              preProductionId: run.id,
              itemId: input.itemId,
              quantity: r.quantity,
              unit: input.unit,
              purpose: r.purpose,
              createdById: req.user!.id,
            })),
          });
        }

        let transfer = null;
        if (input.returnedQty > 0) {
          transfer = await tx.stockTransfer.create({
            data: {
              itemId: input.itemId,
              quantity: input.returnedQty,
              unit: input.unit,
              note: input.note,
              sourceType: "PLANT",
              sourcePlantId: run.plantId!,
              destinationType: input.destinationType!,
              destDayStoreId: input.destinationType === "DAY_STORE" ? input.destDayStoreId : undefined,
              preProductionId: run.id,
              sentById: req.user!.id,
            },
          });
        }

        return { consumptionRows, transfer };
      });

      await recordAudit({
        actorId: req.user!.id,
        action: "plant_consumption.recorded",
        entityType: "PreProduction",
        entityId: run.id,
        metadata: { itemId: input.itemId, consumedQty: input.consumedQty, wastedQty: input.wastedQty, rejectedQty: input.rejectedQty, returnedQty: input.returnedQty },
      });

      res.status(201).json({ logged: result.consumptionRows, transferId: result.transfer?.id ?? null });
    } catch (err) {
      next(err);
    }
  },
);

// The "balance vs. what the system expects" view — per item touched by
// this specific run: what's been logged against it here (consumed/
// wasted/rejected/returned), alongside the Plant's own live overall
// on-hand for that item (see stock.ts getOnHandByPlantAndItem). The two
// are deliberately not collapsed into one number: on-hand is whole-Plant
// (several runs can share the same physical stock pool, and there's no
// per-run reservation), while the per-item breakdown here is scoped
// exactly to this run's own logged entries — labeled separately in the
// response so the UI never implies a false per-run precision the data
// doesn't actually have.
plantConsumptionRouter.get("/:preProductionId/balance", requireRole(...READ_ROLES), async (req: AuthedRequest<{ preProductionId: string }>, res, next) => {
  try {
    const run = await prisma.preProduction.findUnique({
      where: { id: req.params.preProductionId },
      select: { id: true, plantId: true, plant: { select: { id: true, name: true } } },
    });
    if (!run) return res.status(404).json({ error: "Production run not found" });
    if (!run.plantId) return res.json({ plant: null, items: [] });

    const [consumptions, returns] = await Promise.all([
      prisma.batchMaterialConsumption.findMany({
        where: { preProductionId: run.id },
        select: { itemId: true, quantity: true, unit: true, purpose: true, item: { select: { name: true } } },
      }),
      prisma.stockTransfer.findMany({
        where: { preProductionId: run.id, deletedAt: null },
        select: { itemId: true, quantity: true, unit: true, item: { select: { name: true } } },
      }),
    ]);

    const itemIds = [...new Set([...consumptions.map((c) => c.itemId), ...returns.map((r) => r.itemId)])];
    const onHand = itemIds.length ? await getOnHandByPlantAndItem(run.plantId, itemIds) : new Map<string, number>();

    const byItem = new Map<string, { itemId: string; itemName: string; unit: string; consumedQty: number; wastedQty: number; rejectedQty: number; returnedQty: number; plantOnHand: number }>();
    function bucket(itemId: string, itemName: string, unit: string) {
      let b = byItem.get(itemId);
      if (!b) {
        b = { itemId, itemName, unit, consumedQty: 0, wastedQty: 0, rejectedQty: 0, returnedQty: 0, plantOnHand: onHand.get(itemId) ?? 0 };
        byItem.set(itemId, b);
      }
      return b;
    }

    for (const c of consumptions) {
      const b = bucket(c.itemId, c.item.name, c.unit);
      if (c.purpose === "PRODUCTION") b.consumedQty += c.quantity;
      else if (c.purpose === "WASTE") b.wastedQty += c.quantity;
      else if (c.purpose === "REJECTED") b.rejectedQty += c.quantity;
    }
    for (const r of returns) {
      const b = bucket(r.itemId, r.item.name, r.unit);
      b.returnedQty += r.quantity;
    }

    res.json({ plant: run.plant, items: [...byItem.values()] });
  } catch (err) {
    next(err);
  }
});
