import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { logger } from "../../common/lib/logger";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { RouteError } from "../../common/lib/route-error";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { assertPlantAccess, getScopedDayStoreIds, getScopedPlantIds } from "../inventory/day-store-access";
import { plantPosition } from "./plant-position";

/**
 * Plant Stock: what each Plant holds of every material, how much of it is reserved for batches (dispensed to a batch and not yet accounted for
 * by its Utilization) and how much is free. Leftover marked by a batch (E · Return) stays here until Production sends it back to the Day Store.
 *
 *   GET  /      the Plant's materials (?plantId; without it, every Plant the caller may see), each with its batches
 *   POST /return   Production sends free material (the leftover first) back to the Plant's own Day Store
 */
export const plantStockRouter = Router();
plantStockRouter.use(requireAuth, requireRole("PRODUCTION", "PPIC", "STORE"));

const q3 = (n: number) => Math.round(n * 1000) / 1000;

/** The Plants this caller sees: a Plant-limited Production login its own, a Day Store login its paired Plant. */
async function visiblePlants(req: AuthedRequest) {
  const plantScope = await getScopedPlantIds(req.user!.id, req.user!.roles);
  const storeScope = await getScopedDayStoreIds(req.user!.id, req.user!.roles);
  return prisma.plant.findMany({
    where: { ...(plantScope ? { id: { in: plantScope } } : {}), ...(storeScope ? { dayStoreId: { in: storeScope } } : {}) },
    select: { id: true, name: true, dayStoreId: true },
    orderBy: { name: "asc" },
  });
}

plantStockRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const all = await visiblePlants(req);
    const wanted = typeof req.query.plantId === "string" ? all.filter((p) => p.id === req.query.plantId) : all;
    const rows: Record<string, unknown>[] = [];
    for (const plant of wanted) {
      const position = await plantPosition(plant.id, undefined);
      const items = await prisma.inventoryItem.findMany({ where: { id: { in: [...position.keys()] } }, select: { id: true, name: true, category: true, unit: true } });
      const itemOf = new Map(items.map((i) => [i.id, i]));
      for (const p of position.values()) {
        if (!(p.onHand > 1e-9 || p.reserved > 1e-9 || p.pendingReturn > 1e-9)) continue;
        const item = itemOf.get(p.itemId);
        if (!item) continue;
        rows.push({
          plantId: plant.id,
          plantName: plant.name,
          itemId: item.id,
          itemName: item.name,
          category: item.category,
          unit: item.unit ?? "",
          onHand: q3(p.onHand),
          reserved: q3(p.reserved),
          free: q3(p.free),
          pendingReturn: q3(p.pendingReturn),
          batches: p.batches.filter((b) => b.reserved > 1e-9 || b.leftover > 1e-9 || b.given > 1e-9).map((b) => ({ ...b, given: q3(b.given), used: q3(b.used), leftover: q3(b.leftover), reserved: q3(b.reserved) })),
        });
      }
    }
    rows.sort((a, b) => String(a.plantName).localeCompare(String(b.plantName)) || String(a.itemName).localeCompare(String(b.itemName)));
    res.json({ plants: all.map((p) => ({ id: p.id, name: p.name })), rows });
  } catch (err) {
    next(err);
  }
});

const returnSchema = z.object({
  plantId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: z.coerce.number().positive("Enter the quantity to send back."),
  note: z.string().trim().max(500).optional(),
});

plantStockRouter.post("/return", requireRole("PRODUCTION"), validateBody(returnSchema), async (req: AuthedRequest, res, next) => {
  try {
    const input = req.body as z.infer<typeof returnSchema>;
    await assertPlantAccess(req.user!.id, req.user!.roles, input.plantId);
    const [plant, item] = await Promise.all([prisma.plant.findUnique({ where: { id: input.plantId }, select: { id: true, name: true, dayStoreId: true } }), prisma.inventoryItem.findUnique({ where: { id: input.itemId }, select: { id: true, name: true, unit: true } })]);
    if (!plant) return res.status(404).json({ error: "Plant not found" });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });
    if (!plant.dayStoreId) return res.status(400).json({ error: "This Plant has no Day Store to send material back to." });
    const unit = item.unit ?? "Kg";

    const transfer = await runSerializable(async (tx) => {
      const free = (await plantPosition(plant.id, [item.id], tx)).get(item.id)?.free ?? 0;
      if (input.quantity > free + 1e-9) throw new RouteError(409, `Only ${q3(Math.max(0, free))} ${unit} of ${item.name} is free at this Plant: the rest is reserved for batches.`);
      const created = await tx.stockTransfer.create({
        data: { itemId: item.id, quantity: input.quantity, unit, note: input.note ?? "Leftover returned from the Plant", sourceType: "PLANT", sourcePlantId: plant.id, destinationType: "DAY_STORE", destDayStoreId: plant.dayStoreId, sentById: req.user!.id },
        select: { id: true },
      });
      // What is sent back counts against the batches' marked leftover first (oldest first)
      let left = input.quantity;
      const leftovers = await tx.batchLeftover.findMany({ where: { itemId: item.id, productionBatch: { preProduction: { plantId: plant.id } } }, orderBy: { createdAt: "asc" } });
      for (const l of leftovers) {
        const pending = l.quantity - l.returnedQty;
        if (left <= 1e-9) break;
        if (pending <= 1e-9) continue;
        const take = Math.min(left, pending);
        await tx.batchLeftover.update({ where: { id: l.id }, data: { returnedQty: l.returnedQty + take } });
        left -= take;
      }
      return created;
    });
    await recordAudit({ actorId: req.user!.id, action: "plant_stock.returned", entityType: "StockTransfer", entityId: transfer.id, metadata: { itemId: item.id, quantity: input.quantity, plantId: plant.id } });
    await notifyRoles(["STORE"], { title: `${item.name} on its way back from ${plant.name}`, body: `${input.quantity} ${unit}: confirm once it arrives.`, link: "/stock-transfers" }, req.user!.id).catch((err) => logger.error({ err }, "notify failed: plant_stock.return"));
    res.status(201).json({ id: transfer.id });
  } catch (err) {
    next(err);
  }
});
