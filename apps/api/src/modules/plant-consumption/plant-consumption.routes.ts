import { assertPlantAccess, getScopedPlantIds } from "../inventory/day-store-access";
import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { RouteError } from "../../common/lib/route-error";
import { getOnHandByPlantAndItem } from "../inventory/stock";
import { recordPlantConsumptionSchema, type RecordPlantConsumptionInput } from "./plant-consumption.schemas";
import type { RmMasterResult } from "../rm-costing/rm-costing-engine";
import type { BomResult } from "../packaging-bom/bom-engine";

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
      await assertPlantAccess(req.user!.id, req.user!.roles, run.plantId);
      if (!run.plantId) return res.status(400).json({ error: "This run has no Plant set yet — nothing to record consumption against." });

      const input = req.body as RecordPlantConsumptionInput;
      const item = await prisma.inventoryItem.findUnique({ where: { id: input.itemId }, select: { id: true, name: true } });
      if (!item) return res.status(400).json({ error: "Unknown inventory item" });
      if (input.destDayStoreId) {
        const destStore = await prisma.dayStore.findUnique({ where: { id: input.destDayStoreId }, select: { id: true } });
        if (!destStore) return res.status(400).json({ error: "Unknown destination Day Store" });
      }

      if (input.productionBatchId) {
        const batch = await prisma.productionBatch.findUnique({ where: { id: input.productionBatchId }, select: { preProductionId: true } });
        if (!batch || batch.preProductionId !== run.id) return res.status(400).json({ error: "That batch does not belong to this production run." });
      }

      // Same check-then-write-under-SERIALIZABLE pattern every other
      // gated stock action in this app uses — closes the race between
      // two entries racing the same on-hand number.
      const result = await runSerializable(async (tx) => {
        const onHand = (await getOnHandByPlantAndItem(run.plantId!, [input.itemId], tx)).get(input.itemId) ?? 0;

        const wanted = (
          [
            { purpose: "PRODUCTION", quantity: input.consumedQty },
            { purpose: "WASTE", quantity: input.wastedQty },
            { purpose: "REJECTED", quantity: input.rejectedQty },
            { purpose: "SAMPLE", quantity: input.sampleQty },
          ] satisfies { purpose: "PRODUCTION" | "WASTE" | "REJECTED" | "SAMPLE"; quantity: number }[]
        ).filter((r) => r.quantity > 0);

        // The Day Store dispensed the whole plan to the run at Dispensing (logged on the run, not on a batch), and that already left the
        // Plant's stock. A batch's usage is its share of THAT material: it is booked out of what was given at Dispensing first, and only what
        // goes beyond it is new consumption that has to be on hand at the Plant. (Without a batch the entry is plain new consumption.)
        const fromPool = new Map<string, number>(); // purpose -> how much of this entry comes out of the Dispensing pool
        if (input.productionBatchId) {
          for (const w of wanted) {
            const pool = await tx.batchMaterialConsumption.findMany({ where: { preProductionId: run.id, itemId: input.itemId, purpose: w.purpose, productionBatchId: null }, orderBy: { createdAt: "asc" } });
            let left = w.quantity;
            for (const r of pool) {
              if (left <= 1e-9) break;
              const take = Math.min(left, r.quantity);
              if (take >= r.quantity - 1e-9) await tx.batchMaterialConsumption.delete({ where: { id: r.id } });
              else await tx.batchMaterialConsumption.update({ where: { id: r.id }, data: { quantity: r.quantity - take } });
              left -= take;
            }
            fromPool.set(w.purpose, w.quantity - left);
          }
        }
        // A batch's E · Return is leftover that stays in the Plant's stock: it needs nothing more on hand. Without a batch it is a real return.
        const isLeftover = !!input.productionBatchId;
        const newQty = wanted.reduce((sum, w) => sum + (w.quantity - (fromPool.get(w.purpose) ?? 0)), 0) + (isLeftover ? 0 : input.returnedQty);
        if (newQty > onHand + 1e-9) {
          throw new RouteError(409, `Only ${onHand} ${input.unit} of ${item.name} actually on hand at this Plant — can't account for more than that.`);
        }

        const consumptionRows = wanted;
        if (consumptionRows.length > 0) {
          await tx.batchMaterialConsumption.createMany({
            data: consumptionRows.map((r) => ({
              preProductionId: run.id,
              itemId: input.itemId,
              quantity: r.quantity,
              unit: input.unit,
              purpose: r.purpose,
              createdById: req.user!.id,
              productionBatchId: input.productionBatchId ?? null,
            })),
          });
        }

        // Waste and rejected raw material also go on the Recycle Store's books (a one-way sink: nothing comes back). The consumption row
        // above is what takes it out of the Plant's stock; this row is the Recycle Store's own record of it, tied to the run.
        const sink = consumptionRows.filter((r) => r.purpose === "WASTE" || r.purpose === "REJECTED");
        if (sink.length > 0) {
          await tx.inventoryTransaction.createMany({
            data: sink.map((r) => ({
              itemId: input.itemId,
              type: "ISSUED_RECYCLE" as const,
              date: new Date(),
              unit: input.unit,
              quantity: r.quantity,
              plantId: run.plantId!,
              preProductionId: run.id,
              createdById: req.user!.id,
              deliveredAt: new Date(),
              deliveredById: req.user!.id,
              remark: `${r.purpose === "WASTE" ? "Wasted" : "Rejected"} at the Plant${input.note ? ` - ${input.note}` : ""}`,
            })),
          });
        }

        if (isLeftover && input.returnedQty > 0) {
          await tx.batchLeftover.create({ data: { productionBatchId: input.productionBatchId!, itemId: input.itemId, quantity: input.returnedQty, unit: input.unit, createdById: req.user!.id } });
        }

        let transfer = null;
        if (input.returnedQty > 0 && !isLeftover) {
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
              productionBatchId: input.productionBatchId ?? null,
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
    await assertPlantAccess(req.user!.id, req.user!.roles, run.plantId);
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

    const byItem = new Map<string, { itemId: string; itemName: string; unit: string; consumedQty: number; wastedQty: number; rejectedQty: number; sampleQty: number; returnedQty: number; plantOnHand: number }>();
    function bucket(itemId: string, itemName: string, unit: string) {
      let b = byItem.get(itemId);
      if (!b) {
        b = { itemId, itemName, unit, consumedQty: 0, wastedQty: 0, rejectedQty: 0, sampleQty: 0, returnedQty: 0, plantOnHand: onHand.get(itemId) ?? 0 };
        byItem.set(itemId, b);
      }
      return b;
    }

    for (const c of consumptions) {
      const b = bucket(c.itemId, c.item.name, c.unit);
      if (c.purpose === "PRODUCTION") b.consumedQty += c.quantity;
      else if (c.purpose === "WASTE") b.wastedQty += c.quantity;
      else if (c.purpose === "REJECTED") b.rejectedQty += c.quantity;
      else if (c.purpose === "SAMPLE") b.sampleQty += c.quantity;
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

// Consolidated report across every run — the same PRODUCTION/WASTE/
// REJECTED split as the per-run balance above, but flattened to one row
// per (PreProduction run × Item) across the whole company instead of
// scoped to a single run. This is what actually answers "how much RM/PM
// went into this Product / Batch / PO" without opening each run's own
// detail page one at a time. Optional filters let the PO detail page and
// a PreProduction run's own detail page deep-link straight to their own
// slice of this same dataset instead of duplicating the query.
// Deliberately does NOT fold in returnedQty (StockTransfer) — that's a
// Plant-level "sent back to Store" event, not a per-item usage number,
// and the per-run balance route above already surfaces it separately.
plantConsumptionRouter.get("/report", requireRole(...READ_ROLES, "QA_QC"), async (req: AuthedRequest, res, next) => {
  try {
    const { poId, preProductionId, itemId, dateFrom, dateTo } = req.query as {
      poId?: string;
      preProductionId?: string;
      itemId?: string;
      dateFrom?: string;
      dateTo?: string;
    };

    const plantScope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    const consumptions = await prisma.batchMaterialConsumption.findMany({
      where: {
        itemId: itemId || undefined,
        preProductionId: preProductionId || undefined,
        preProduction: {
          ...(poId ? { purchaseOrderItem: { purchaseOrderId: poId } } : {}),
          // A Plant-limited Production login reads only its own Plant's consumption.
          ...(plantScope ? { plantId: { in: plantScope } } : {}),
        },
        // Both ends inclusive — dateTo covers the whole day, not just its
        // midnight instant, same "calendar date, not timestamp" rule the
        // rest of this app's date-range filters use.
        createdAt: {
          ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
          ...(dateTo ? { lt: new Date(new Date(dateTo).getTime() + 24 * 60 * 60 * 1000) } : {}),
        },
      },
      select: {
        preProductionId: true,
        itemId: true,
        quantity: true,
        unit: true,
        purpose: true,
        createdAt: true,
        item: { select: { name: true, category: true } },
        preProduction: {
          select: {
            id: true,
            purchaseOrderItemId: true,
            productionBatches: { select: { batchNo: true }, take: 1 },
            purchaseOrderItem: {
              select: {
                productName: true,
                purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } },
              },
            },
          },
        },
      },
    });

    interface Row {
      preProductionId: string;
      purchaseOrderItemId: string;
      poId: string;
      poNumber: string | null;
      customerName: string;
      productName: string;
      batchNo: string | null;
      itemId: string;
      itemName: string;
      category: string;
      unit: string;
      lastLoggedAt: string;
      consumedQty: number;
      sampleQty: number;
      wastedQty: number;
      rejectedQty: number;
      requiredQty: number | null;
    }

    const byRow = new Map<string, Row>();

    for (const c of consumptions) {
      const key = `${c.preProductionId}::${c.itemId}`;
      let row = byRow.get(key);
      if (!row) {
        row = {
          preProductionId: c.preProductionId,
          purchaseOrderItemId: c.preProduction.purchaseOrderItemId,
          poId: c.preProduction.purchaseOrderItem.purchaseOrder.id,
          poNumber: c.preProduction.purchaseOrderItem.purchaseOrder.poNumber,
          customerName: c.preProduction.purchaseOrderItem.purchaseOrder.customer.companyName,
          productName: c.preProduction.purchaseOrderItem.productName,
          batchNo: c.preProduction.productionBatches[0]?.batchNo ?? null,
          itemId: c.itemId,
          itemName: c.item.name,
          category: c.item.category,
          unit: c.unit,
          lastLoggedAt: c.createdAt.toISOString(),
          consumedQty: 0,
          sampleQty: 0,
          wastedQty: 0,
          rejectedQty: 0,
          requiredQty: null,
        };
        byRow.set(key, row);
      }
      if (c.createdAt.toISOString() > row.lastLoggedAt) row.lastLoggedAt = c.createdAt.toISOString();
      if (c.purpose === "PRODUCTION") row.consumedQty += c.quantity;
      else if (c.purpose === "SAMPLE") row.sampleQty += c.quantity;
      else if (c.purpose === "WASTE") row.wastedQty += c.quantity;
      else if (c.purpose === "REJECTED") row.rejectedQty += c.quantity;
    }

    const rows = [...byRow.values()];

    // "Required" — how much of this item that product's own RM/BOM Plan
    // called for in total, read off whichever plan (RM for category RM,
    // BOM for category PM) is linked to this specific product, so the
    // report can show "X of Y consumed" per product instead of just a
    // running total with nothing to compare it against. Same source
    // pending-materials.ts's Pending PO Report reads, just matched
    // directly by purchaseOrderItemId here (one plan per product) rather
    // than via a pooled plan's `sources` map.
    const purchaseOrderItemIds = [...new Set(rows.map((r) => r.purchaseOrderItemId))];
    const [rmPlans, bomPlans] = await Promise.all([
      prisma.rmPlan.findMany({
        where: { purchaseOrderItemId: { in: purchaseOrderItemIds }, status: "CALCULATED" },
        orderBy: { calculatedAt: "desc" },
        select: { purchaseOrderItemId: true, resultSnapshot: true },
      }),
      prisma.bomPlan.findMany({
        where: { purchaseOrderItemId: { in: purchaseOrderItemIds }, status: "CALCULATED" },
        orderBy: { calculatedAt: "desc" },
        select: { purchaseOrderItemId: true, resultSnapshot: true },
      }),
    ]);
    // First (most recent, since ordered desc) plan per product wins.
    const latestRmByPoItem = new Map<string, RmMasterResult>();
    for (const p of rmPlans) if (p.purchaseOrderItemId && !latestRmByPoItem.has(p.purchaseOrderItemId)) latestRmByPoItem.set(p.purchaseOrderItemId, p.resultSnapshot as unknown as RmMasterResult);
    const latestBomByPoItem = new Map<string, BomResult>();
    for (const p of bomPlans) if (p.purchaseOrderItemId && !latestBomByPoItem.has(p.purchaseOrderItemId)) latestBomByPoItem.set(p.purchaseOrderItemId, p.resultSnapshot as unknown as BomResult);

    for (const row of rows) {
      if (row.category === "RM") {
        const plan = latestRmByPoItem.get(row.purchaseOrderItemId);
        const line = plan?.procurement.find((p) => p.name === row.itemName);
        if (line) row.requiredQty = line.totalKg;
      } else {
        const plan = latestBomByPoItem.get(row.purchaseOrderItemId);
        const line = plan?.lines.find((l) => (l.itemName ?? l.component) === row.itemName || `${l.component} — ${l.spec}` === row.itemName);
        if (line) row.requiredQty = line.totalQty;
      }
    }

    res.json(rows);
  } catch (err) {
    next(err);
  }
});
