import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";

// RM Warehouse / PM Warehouse — a real, named location per InventoryCategory
// (schema.prisma: Warehouse, `category @unique` caps this at exactly two
// rows). Unlike Day Store/Plant this list never grows and never shrinks —
// every InventoryItem is already permanently RM or PM, so which warehouse
// its stock belongs to is derived by matching category, not stored on the
// item or the transaction. No POST here (nothing to create — the two rows
// are bootstrapped by prisma/seed.ts) and no access-restriction table like
// DayStoreAssignment: any Store/PPIC user who can already see Inventory can
// see and act on both warehouses, same as the plain category filter today.

const renameWarehouseSchema = z.object({ name: z.string().min(1).max(200) });
type RenameWarehouseInput = z.infer<typeof renameWarehouseSchema>;

export const warehousesRouter = Router();

warehousesRouter.use(requireAuth);

// Read is open to anyone who can already see the Inventory module — same
// as GET /day-stores and GET /plants, since every department that filters
// Stock on Hand by warehouse needs this list to pick from.
warehousesRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await prisma.warehouse.findMany({ orderBy: { category: "asc" } }));
  } catch (err) {
    next(err);
  }
});

warehousesRouter.patch("/:id", requireRole("STORE"), validateBody(renameWarehouseSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const { name } = req.body as RenameWarehouseInput;
    const existing = await prisma.warehouse.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Warehouse not found" });

    const clash = await prisma.warehouse.findUnique({ where: { name } });
    if (clash && clash.id !== existing.id) return res.status(409).json({ error: "A warehouse with this name already exists" });

    const warehouse = await prisma.warehouse.update({ where: { id: existing.id }, data: { name } });
    await recordAudit({ actorId: req.user!.id, action: "warehouse.renamed", entityType: "Warehouse", entityId: warehouse.id, metadata: { from: existing.name, to: name } });

    res.json(warehouse);
  } catch (err) {
    next(err);
  }
});
