import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { assertDayStoreAccess } from "./day-store-access";
import { getOnHandByDayStoreAndItem, getOnHandByPlantAndItem } from "./stock";
import type { InventoryCategory } from "@prisma/client";

// Day Stores and Plants — named identities Store tags onto the existing
// ledger (S6/S7: "issued to which Day Store", "received by which
// Plant") instead of the flat ISSUED_DAY_STORE/ISSUED_PRODUCTION
// buckets it was before. Not a fixed list of 4 — the client's flow just
// happens to have 4 of each today; Store/Admin can add more any time.
// Rename exists (below) because these often start as placeholders —
// "Store 1"/"Store 2" — before real names/IDs are assigned later; still
// no delete, since a real transaction referencing one shouldn't be able
// to lose its target.

const createLocationSchema = z.object({ name: z.string().min(1).max(200) });
type CreateLocationInput = z.infer<typeof createLocationSchema>;
// Same shape as create — rename is just "give it a new name."
const renameLocationSchema = createLocationSchema;
type RenameLocationInput = z.infer<typeof renameLocationSchema>;

export const dayStoresRouter = Router();
export const plantsRouter = Router();

dayStoresRouter.use(requireAuth);
plantsRouter.use(requireAuth);

// Read is open to anyone who can already see the Inventory module —
// every department that tags a Day Store/Plant on an entry needs the
// list to pick from.
dayStoresRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await prisma.dayStore.findMany({ orderBy: { name: "asc" } }));
  } catch (err) {
    next(err);
  }
});

dayStoresRouter.post("/", requireRole("STORE"), validateBody(createLocationSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { name } = req.body as CreateLocationInput;
    const existing = await prisma.dayStore.findUnique({ where: { name } });
    if (existing) return res.status(409).json({ error: "A day store with this name already exists" });

    const dayStore = await prisma.dayStore.create({ data: { name, createdById: req.user!.id } });
    await recordAudit({ actorId: req.user!.id, action: "day_store.created", entityType: "DayStore", entityId: dayStore.id });

    res.status(201).json(dayStore);
  } catch (err) {
    next(err);
  }
});

dayStoresRouter.patch("/:id", requireRole("STORE"), validateBody(renameLocationSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const { name } = req.body as RenameLocationInput;
    const existing = await prisma.dayStore.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Day Store not found" });
    await assertDayStoreAccess(req.user!.id, req.user!.roles, existing.id);

    const clash = await prisma.dayStore.findUnique({ where: { name } });
    if (clash && clash.id !== existing.id) return res.status(409).json({ error: "A day store with this name already exists" });

    const dayStore = await prisma.dayStore.update({ where: { id: existing.id }, data: { name } });
    await recordAudit({ actorId: req.user!.id, action: "day_store.renamed", entityType: "DayStore", entityId: dayStore.id, metadata: { from: existing.name, to: name } });

    res.json(dayStore);
  } catch (err) {
    next(err);
  }
});

// Real-time balance for one Day Store — see stock.ts
// getOnHandByDayStoreAndItem for the actual math. Same role gate as the
// Warehouse-wide GET /inventory/stock, since this is the same kind of
// number for a narrower scope.
dayStoresRouter.get("/:id/stock", requireRole("STORE", "PPIC"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const dayStore = await prisma.dayStore.findUnique({ where: { id: req.params.id } });
    if (!dayStore) return res.status(404).json({ error: "Day Store not found" });
    await assertDayStoreAccess(req.user!.id, req.user!.roles, dayStore.id);

    // No itemIds filter here on purpose — that's what keeps this to only
    // items with actual activity at this store, instead of the whole
    // catalog padded with zeros for everything never issued here.
    const onHand = await getOnHandByDayStoreAndItem(dayStore.id);
    const category = req.query.category as InventoryCategory | undefined;
    const items = await prisma.inventoryItem.findMany({
      where: { id: { in: [...onHand.keys()] }, ...(category ? { category } : {}) },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });

    res.json({
      dayStore,
      stock: items.map((item) => ({
        item,
        ...(onHand.get(item.id) ?? { receivedFromWarehouse: 0, issuedToProduction: 0, receivedFromTransfer: 0, sentViaTransfer: 0, onHand: 0 }),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// --- Store assignment — restricts which specific Day Store(s) a
// STORE-department user can manage; see DayStoreAssignment in
// schema.prisma and assertDayStoreAccess for the enforcement side. Both
// ADMIN and STORE can grant/revoke (per the decision this shipped
// under) — this is a Store-department self-service control, not an
// Admin-only one like role grants. ---

const assignmentInclude = {
  user: { select: { id: true, employeeId: true, fullName: true } },
  assignedBy: { select: { id: true, employeeId: true, fullName: true } },
} as const;

dayStoresRouter.get("/:id/assignments", requireRole("STORE"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const dayStore = await prisma.dayStore.findUnique({ where: { id: req.params.id } });
    if (!dayStore) return res.status(404).json({ error: "Day Store not found" });

    const assignments = await prisma.dayStoreAssignment.findMany({
      where: { dayStoreId: dayStore.id },
      include: assignmentInclude,
      orderBy: { assignedAt: "asc" },
    });
    res.json(assignments);
  } catch (err) {
    next(err);
  }
});

const assignUserSchema = z.object({ userId: z.string().uuid() });

dayStoresRouter.post("/:id/assignments", requireRole("STORE"), validateBody(assignUserSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const dayStore = await prisma.dayStore.findUnique({ where: { id: req.params.id } });
    if (!dayStore) return res.status(404).json({ error: "Day Store not found" });

    const { userId } = req.body as z.infer<typeof assignUserSchema>;
    const targetUser = await prisma.user.findUnique({ where: { id: userId }, include: { roles: { include: { role: true } } } });
    if (!targetUser) return res.status(404).json({ error: "User not found" });
    // Assignment only makes sense for someone who actually holds the
    // STORE role — assigning a PPIC/ADMIN user here would be a no-op
    // (they're always unrestricted, see assertDayStoreAccess) and
    // assigning anyone else wouldn't grant them any access this system
    // doesn't already withhold at the route level.
    if (!targetUser.roles.some((r) => r.role.name === "STORE")) {
      return res.status(400).json({ error: "Only a user with the STORE role can be assigned to a store" });
    }

    const assignment = await prisma.dayStoreAssignment.upsert({
      where: { userId_dayStoreId: { userId, dayStoreId: dayStore.id } },
      create: { userId, dayStoreId: dayStore.id, assignedById: req.user!.id },
      update: {},
      include: assignmentInclude,
    });

    await recordAudit({
      actorId: req.user!.id,
      action: "day_store.user_assigned",
      entityType: "DayStore",
      entityId: dayStore.id,
      metadata: { userId, userName: targetUser.fullName },
    });

    res.status(201).json(assignment);
  } catch (err) {
    next(err);
  }
});

dayStoresRouter.delete("/:id/assignments/:userId", requireRole("STORE"), async (req: AuthedRequest<{ id: string; userId: string }>, res, next) => {
  try {
    const existing = await prisma.dayStoreAssignment.findUnique({ where: { userId_dayStoreId: { userId: req.params.userId, dayStoreId: req.params.id } } });
    if (!existing) return res.status(404).json({ error: "This user isn't assigned to this store" });

    await prisma.dayStoreAssignment.delete({ where: { userId_dayStoreId: { userId: req.params.userId, dayStoreId: req.params.id } } });

    await recordAudit({ actorId: req.user!.id, action: "day_store.user_unassigned", entityType: "DayStore", entityId: req.params.id, metadata: { userId: req.params.userId } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Minimal STORE-role directory for the assignment picker — deliberately
// narrower than GET /api/users (admin-only, full directory incl. email/
// isActive/every role): STORE department members need to pick from
// their own colleagues to assign, not get the whole company's user
// list. Every DayStoreAssignment target must come from this same set
// (enforced above), so this is exactly the pool worth exposing here.
dayStoresRouter.get("/store-users", requireRole("STORE"), async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { isActive: true, roles: { some: { role: { name: "STORE" } } } },
      select: { id: true, employeeId: true, fullName: true },
      orderBy: { fullName: "asc" },
    });
    res.json(users);
  } catch (err) {
    next(err);
  }
});

plantsRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await prisma.plant.findMany({ orderBy: { name: "asc" } }));
  } catch (err) {
    next(err);
  }
});

plantsRouter.post("/", requireRole("STORE"), validateBody(createLocationSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { name } = req.body as CreateLocationInput;
    const existing = await prisma.plant.findUnique({ where: { name } });
    if (existing) return res.status(409).json({ error: "A plant with this name already exists" });

    const plant = await prisma.plant.create({ data: { name, createdById: req.user!.id } });
    await recordAudit({ actorId: req.user!.id, action: "plant.created", entityType: "Plant", entityId: plant.id });

    res.status(201).json(plant);
  } catch (err) {
    next(err);
  }
});

plantsRouter.patch("/:id", requireRole("STORE"), validateBody(renameLocationSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const { name } = req.body as RenameLocationInput;
    const existing = await prisma.plant.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Plant not found" });

    const clash = await prisma.plant.findUnique({ where: { name } });
    if (clash && clash.id !== existing.id) return res.status(409).json({ error: "A plant with this name already exists" });

    const plant = await prisma.plant.update({ where: { id: existing.id }, data: { name } });
    await recordAudit({ actorId: req.user!.id, action: "plant.renamed", entityType: "Plant", entityId: plant.id, metadata: { from: existing.name, to: name } });

    res.json(plant);
  } catch (err) {
    next(err);
  }
});

// Real-time balance for one Plant — see stock.ts
// getOnHandByPlantAndItem. Mirrors the Day Store endpoint above, but the
// outflow side comes from the Batches module (BatchMaterialConsumption),
// not another Inventory transaction type.
plantsRouter.get("/:id/stock", requireRole("STORE", "PPIC", "PRODUCTION"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const plant = await prisma.plant.findUnique({ where: { id: req.params.id } });
    if (!plant) return res.status(404).json({ error: "Plant not found" });

    const onHand = await getOnHandByPlantAndItem(plant.id);
    const category = req.query.category as InventoryCategory | undefined;
    const items = await prisma.inventoryItem.findMany({
      where: { id: { in: [...onHand.keys()] }, ...(category ? { category } : {}) },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });

    res.json({
      plant,
      stock: items.map((item) => ({ item, onHand: onHand.get(item.id) ?? 0 })),
    });
  } catch (err) {
    next(err);
  }
});
