import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { assertPlantAccess, getScopedPlantIds } from "./day-store-access";
import { loadProductionRequests } from "./my-store-production.routes";
import { notifyPlantDayStore } from "./plan-requests";
import { PAST_PACKING_STAGES as PAST_PACKING } from "../batches/batch-pipeline";

/**
 * Extra material: Production asks for material that is NOT part of the plan, for one batch, straight from its own Plant's Store.
 *
 *   POST   /            Production raises a request (the batch it is for, item, quantity, needed by, why). The batch gives the PO, the product and the Plant,
 *                       so the material can be traced to the batch it was used in. (R&D's trial material is not asked here: that is R&D's own sample flow.)
 *   GET    /batches     the batches Production can ask for (its Plants'; a batch with a number, not yet at the finished-goods store)
 *   GET    /            the list with its trail (Production: its Plants; PPIC: all)
 *   DELETE /:id         Production withdraws one the Store has not touched yet
 *
 * From there it is the Store's normal Production Requests flow (approve, issue from its shelf to the Plant, ask the Warehouse for the
 * rest). When the Warehouse cannot cover what the Store asked for, the need goes to PPIC by itself (autoEscalateExtraAsks), PPIC sends it
 * to Purchase from Pre-Inventory, Purchase logs the PI (the ETA shows on the request), and when the material arrives it travels the same way:
 * Warehouse -> Store -> Plant. What was issued for the batch shows on its Utilization (so Production only fills in what it used) and in the
 * Production Report.
 */
export const extraRequestsRouter = Router();
extraRequestsRouter.use(requireAuth);


const dateField = z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.date().optional());
// A material typed in by Production because it is not in the item list (RM / PM, or Other: gloves, masks, cleaning material ...).
const newItemSchema = z.object({
  category: z.enum(["RM", "PM", "OTHER"]),
  name: z.string().trim().min(2, "Type the material's name").max(120),
  unit: z.string().trim().min(1, "Choose the unit").max(20),
});
const createSchema = z
  .object({
  itemId: z.string().uuid().optional(),
  newItem: newItemSchema.optional(),
  requestedQty: z.coerce.number().positive(),
  neededBy: dateField,
  reason: z.string().trim().min(3, "Say why this material is needed").max(500),
  // The batch the material is for: it gives the PO, the product and the Plant.
  productionBatchId: z.string().uuid("Choose the batch this material is for"),
  })
  .refine((d) => !!d.itemId !== !!d.newItem, { message: "Choose an item, or add a new material", path: ["itemId"] });

extraRequestsRouter.post("/", requireRole("PRODUCTION"), validateBody(createSchema), async (req: AuthedRequest, res, next) => {
  try {
    const input = req.body as z.infer<typeof createSchema>;
    const batch = await prisma.productionBatch.findUnique({
      where: { id: input.productionBatchId },
      select: { id: true, batchNo: true, currentStageId: true, preProduction: { select: { plantId: true, purchaseOrderItemId: true } } },
    });
    if (!batch) return res.status(400).json({ error: "Unknown batch" });
    if (!batch.batchNo) return res.status(409).json({ error: "This batch has no batch number yet." });
    if (PAST_PACKING.includes(batch.currentStageId)) return res.status(409).json({ error: "This batch has already been packed and gone to the finished-goods store: no more material can be asked for it." });
    const plantId = batch.preProduction.plantId;
    if (!plantId) return res.status(409).json({ error: "This batch's run has no Plant." });
    await assertPlantAccess(req.user!.id, req.user!.roles, plantId);
    const plant = await prisma.plant.findUnique({ where: { id: plantId }, select: { id: true, name: true, dayStoreId: true } });
    if (!plant) return res.status(400).json({ error: "Unknown Plant" });
    if (!plant.dayStoreId) return res.status(400).json({ error: "This Plant has no Store to ask." });
    // An item from the list, or a material typed in: one that is already in the list under the same name is used (never a duplicate), else it is created
    let item = input.itemId ? await prisma.inventoryItem.findUnique({ where: { id: input.itemId }, select: { id: true, name: true, category: true, unit: true } }) : null;
    let newMaterial = false;
    if (input.itemId && !item) return res.status(400).json({ error: "Unknown item" });
    if (input.newItem) {
      const typed = input.newItem;
      item = await prisma.inventoryItem.findFirst({ where: { category: typed.category, name: { equals: typed.name, mode: "insensitive" } }, select: { id: true, name: true, category: true, unit: true } });
      if (!item) {
        item = await prisma.inventoryItem.create({ data: { category: typed.category, name: typed.name, unit: typed.unit }, select: { id: true, name: true, category: true, unit: true } });
        newMaterial = true;
        await recordAudit({ actorId: req.user!.id, action: "inventory_item.created_by_extra_request", entityType: "InventoryItem", entityId: item.id, metadata: { name: typed.name, category: typed.category, unit: typed.unit } });
      }
    }
    if (!item) return res.status(400).json({ error: "Choose an item, or add a new material" });

    const created = await prisma.inventoryRequest.create({
      data: {
        itemId: item.id,
        category: item.category,
        requestedQty: input.requestedQty,
        purpose: "ISSUED_PRODUCTION",
        neededBy: input.neededBy,
        note: input.reason,
        requestedById: req.user!.id,
        plantId: plant.id,
        isExtra: true,
        extraForPoItemId: batch.preProduction.purchaseOrderItemId,
        productionBatchId: batch.id,
        newMaterial,
      },
    });
    await recordAudit({ actorId: req.user!.id, action: "extra_request.created", entityType: "InventoryRequest", entityId: created.id, metadata: { itemId: item.id, requestedQty: input.requestedQty, plantId: plant.id, productionBatchId: batch.id, newMaterial: newMaterial || undefined } });
    await notifyPlantDayStore(
      plant.dayStoreId,
      { title: `${newMaterial ? "New material" : "Extra material"}: ${item.name} (batch ${batch.batchNo})`, body: `${input.requestedQty} ${item.unit ?? ""} for ${plant.name}: ${input.reason}`.replace("  ", " "), link: "/my-store/production-requests" },
      req.user!.id,
    ).catch((err) => req.log?.error({ err }, "notify failed: extra_request.created"));
    res.status(201).json({ id: created.id });
  } catch (err) {
    next(err);
  }
});

// The batches this login may ask material for (a Plant login: its own Plant's; others: every Plant that has a Store): one with a batch number that
// has not yet gone to the finished-goods store, with its PO and product.
extraRequestsRouter.get("/batches", requireRole("PRODUCTION"), async (req: AuthedRequest, res, next) => {
  try {
    const scope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    const batches = await prisma.productionBatch.findMany({
      where: {
        batchNo: { not: null },
        currentStageId: { notIn: [...PAST_PACKING] as never[] },
        preProduction: { plant: { dayStoreId: { not: null }, ...(scope ? { id: { in: scope } } : {}) } },
      },
      select: {
        id: true,
        batchNo: true,
        preProduction: { select: { plant: { select: { id: true, name: true } }, purchaseOrderItem: { select: { id: true, productName: true, purchaseOrder: { select: { poNumber: true } } } } } },
      },
      orderBy: [{ createdAt: "asc" }],
    });
    res.json(
      batches.map((b) => ({
        batchId: b.id,
        batchNo: b.batchNo!,
        itemId: b.preProduction.purchaseOrderItem.id,
        productName: b.preProduction.purchaseOrderItem.productName,
        poNumber: b.preProduction.purchaseOrderItem.purchaseOrder.poNumber,
        plantId: b.preProduction.plant?.id ?? null,
        plantName: b.preProduction.plant?.name ?? null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

extraRequestsRouter.get("/", requireRole("PRODUCTION", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const plantIds = await getScopedPlantIds(req.user!.id, req.user!.roles);
    res.json(await loadProductionRequests(null, { plantIds, extraOnly: true }));
  } catch (err) {
    next(err);
  }
});

extraRequestsRouter.delete("/:id", requireRole("PRODUCTION"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const request = await prisma.inventoryRequest.findFirst({ where: { id: req.params.id, deletedAt: null, isExtra: true }, include: { fulfillments: { where: { deletedAt: null }, select: { id: true } } } });
    if (!request) return res.status(404).json({ error: "Extra request not found" });
    await assertPlantAccess(req.user!.id, req.user!.roles, request.plantId);
    if (request.status !== "PENDING" || request.fulfillments.length > 0) return res.status(409).json({ error: "The Store has already started on this request." });
    await prisma.inventoryRequest.update({ where: { id: request.id }, data: { deletedAt: new Date(), deletedById: req.user!.id } });
    await recordAudit({ actorId: req.user!.id, action: "extra_request.withdrawn", entityType: "InventoryRequest", entityId: request.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
