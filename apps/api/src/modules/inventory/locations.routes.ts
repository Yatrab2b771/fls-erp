import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";

// Day Stores and Plants — named identities Store tags onto the existing
// ledger (S6/S7: "issued to which Day Store", "received by which
// Plant") instead of the flat ISSUED_DAY_STORE/ISSUED_PRODUCTION
// buckets it was before. Not a fixed list of 4 — the client's flow just
// happens to have 4 of each today; Store/Admin can add more any time,
// so this is deliberately just a named, growable directory (create +
// list), same shape as InventoryItem's own catalog, not a full CRUD
// resource — nothing about a Day Store or Plant's identity needs
// editing or deleting once real transactions reference it.

const createLocationSchema = z.object({ name: z.string().min(1).max(200) });
type CreateLocationInput = z.infer<typeof createLocationSchema>;

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
