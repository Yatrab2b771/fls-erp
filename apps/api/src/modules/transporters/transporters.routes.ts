import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { createTransporterSchema, updateTransporterSchema, type CreateTransporterInput, type UpdateTransporterInput } from "./transporters.schemas";

export const transportersRouter = Router();

transportersRouter.use(requireAuth);

// The transport-name dropdown on a shipment: Dispatch picks (and adds), Accounts and the Warehouse see who a shipment went with.
// The whole list in one go (a company has a few dozen transporters at most).
transportersRouter.get("/", requireRole("DISPATCH", "ACCOUNTS", "STORE"), async (_req, res, next) => {
  try {
    res.json(await prisma.transporter.findMany({ orderBy: { name: "asc" }, take: 1000 }));
  } catch (err) {
    next(err);
  }
});

transportersRouter.post("/", requireRole("DISPATCH"), validateBody(createTransporterSchema), async (req: AuthedRequest, res, next) => {
  try {
    const data = req.body as CreateTransporterInput;
    const same = await prisma.transporter.findFirst({ where: { name: { equals: data.name, mode: "insensitive" } } });
    if (same) return res.status(409).json({ error: `"${same.name}" is already in the list.` });
    const created = await prisma.transporter.create({ data: { ...data, createdById: req.user!.id } });
    await recordAudit({ actorId: req.user!.id, action: "transporter.created", entityType: "Transporter", entityId: created.id });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// Fix a name or a Transporter ID typed wrong. A shipment already sent keeps the name it was sent with.
transportersRouter.patch("/:id", requireRole("DISPATCH"), validateBody(updateTransporterSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.transporter.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Transporter not found" });
    const data = req.body as UpdateTransporterInput;
    if (data.name) {
      const same = await prisma.transporter.findFirst({ where: { id: { not: existing.id }, name: { equals: data.name, mode: "insensitive" } } });
      if (same) return res.status(409).json({ error: `"${same.name}" is already in the list.` });
    }
    const updated = await prisma.transporter.update({ where: { id: existing.id }, data });
    await recordAudit({ actorId: req.user!.id, action: "transporter.updated", entityType: "Transporter", entityId: updated.id });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});
