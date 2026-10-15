import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { assertPlantAccess, getScopedPlantIds } from "./day-store-access";
import { loadProductionRequests } from "./my-store-production.routes";
import { notifyPlantDayStore } from "./plan-requests";

/**
 * Extra material: Production asks for material that is NOT part of any plan, straight from its own Plant's Day Store.
 *
 *   POST   /            Production raises a request (item, quantity, needed by, why; the product it is for is an optional note)
 *   GET    /            the list with its trail (Production: its Plants; PPIC: all)
 *   DELETE /:id         Production withdraws one the Day Store has not touched yet
 *
 * From there it is the Day Store's normal Production Requests flow (approve, issue from its shelf to the Plant, ask the Warehouse for the
 * rest). When the Warehouse cannot cover what the Day Store asked for, the need goes to PPIC by itself (autoEscalateExtraAsks), PPIC sends it
 * to Purchase from Pre-Inventory, Purchase logs the PI (the ETA shows on the request), and when the material arrives it travels the same way:
 * Warehouse -> Day Store -> Plant.
 */
export const extraRequestsRouter = Router();
extraRequestsRouter.use(requireAuth);

const dateField = z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.date().optional());
const createSchema = z.object({
  itemId: z.string().uuid(),
  requestedQty: z.coerce.number().positive(),
  neededBy: dateField,
  reason: z.string().trim().min(3, "Say why this material is needed").max(500),
  // Only needed when the login covers more than one Plant (or all of them).
  plantId: z.string().uuid().optional(),
  // Optional: which product it is for. A note only; it does not make this a plan request.
  purchaseOrderItemId: z.string().uuid().optional(),
});

extraRequestsRouter.post("/", requireRole("PRODUCTION"), validateBody(createSchema), async (req: AuthedRequest, res, next) => {
  try {
    const input = req.body as z.infer<typeof createSchema>;
    const scope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    const plantId = input.plantId ?? (scope && scope.length === 1 ? scope[0] : undefined);
    if (!plantId) return res.status(400).json({ error: "Choose the Plant this material is for." });
    await assertPlantAccess(req.user!.id, req.user!.roles, plantId);
    const plant = await prisma.plant.findUnique({ where: { id: plantId }, select: { id: true, name: true, dayStoreId: true } });
    if (!plant) return res.status(400).json({ error: "Unknown Plant" });
    if (!plant.dayStoreId) return res.status(400).json({ error: "This Plant has no Day Store to ask." });
    const item = await prisma.inventoryItem.findUnique({ where: { id: input.itemId }, select: { id: true, name: true, category: true, unit: true } });
    if (!item) return res.status(400).json({ error: "Unknown item" });
    if (input.purchaseOrderItemId && !(await prisma.purchaseOrderItem.findUnique({ where: { id: input.purchaseOrderItemId }, select: { id: true } }))) return res.status(400).json({ error: "Unknown product" });

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
        extraForPoItemId: input.purchaseOrderItemId ?? null,
      },
    });
    await recordAudit({ actorId: req.user!.id, action: "extra_request.created", entityType: "InventoryRequest", entityId: created.id, metadata: { itemId: item.id, requestedQty: input.requestedQty, plantId: plant.id } });
    await notifyPlantDayStore(
      plant.dayStoreId,
      { title: `Extra material: ${item.name}`, body: `${input.requestedQty} ${item.unit ?? ""} for ${plant.name}: ${input.reason}`.replace("  ", " "), link: "/my-store/production-requests" },
      req.user!.id,
    ).catch((err) => req.log?.error({ err }, "notify failed: extra_request.created"));
    res.status(201).json({ id: created.id });
  } catch (err) {
    next(err);
  }
});

// The Plants this login may ask for (a Plant login: its own; others: every Plant that has a Day Store).
extraRequestsRouter.get("/options", requireRole("PRODUCTION"), async (req: AuthedRequest, res, next) => {
  try {
    const scope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    const plants = await prisma.plant.findMany({ where: { dayStoreId: { not: null }, ...(scope ? { id: { in: scope } } : {}) }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    res.json({ plants });
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
    if (request.status !== "PENDING" || request.fulfillments.length > 0) return res.status(409).json({ error: "The Day Store has already started on this request." });
    await prisma.inventoryRequest.update({ where: { id: request.id }, data: { deletedAt: new Date(), deletedById: req.user!.id } });
    await recordAudit({ actorId: req.user!.id, action: "extra_request.withdrawn", entityType: "InventoryRequest", entityId: request.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
