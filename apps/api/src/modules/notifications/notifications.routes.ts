import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { requireAuth, type AuthedRequest } from "../../common/middleware/auth";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

// Every authenticated user reads only their own notifications — there's
// no cross-department visibility here, unlike most of the app's other
// read endpoints. unreadCount is returned alongside the list so the
// bell badge doesn't need a second round trip every poll.
notificationsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const unreadOnly = req.query.unreadOnly === "true";
    const limit = Math.min(Number(req.query.limit) || 30, 100);

    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { recipientId: req.user!.id, ...(unreadOnly ? { readAt: null } : {}) },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.notification.count({ where: { recipientId: req.user!.id, readAt: null } }),
    ]);

    res.json({ notifications, unreadCount });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post("/:id/read", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Notification not found" });
    if (existing.recipientId !== req.user!.id) return res.status(403).json({ error: "You do not have permission to perform this action" });

    const updated = existing.readAt ? existing : await prisma.notification.update({ where: { id: req.params.id }, data: { readAt: new Date() } });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post("/read-all", async (req: AuthedRequest, res, next) => {
  try {
    const result = await prisma.notification.updateMany({ where: { recipientId: req.user!.id, readAt: null }, data: { readAt: new Date() } });
    res.json({ markedRead: result.count });
  } catch (err) {
    next(err);
  }
});
