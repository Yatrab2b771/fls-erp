import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { RoleName } from "@prisma/client";

export const usersRouter = Router();

usersRouter.use(requireAuth);

// Admin-only directory — deliberately excludes passwordHash.
usersRouter.get("/", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const pagination = parsePagination(req);
    const [total, users] = await Promise.all([
      prisma.user.count(),
      prisma.user.findMany({
        select: { id: true, employeeId: true, email: true, fullName: true, isActive: true, createdAt: true, roles: { include: { role: true } } },
        orderBy: { createdAt: "asc" },
        skip: pagination.skip,
        take: pagination.take,
      }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(users.map((u) => ({ ...u, roles: u.roles.map((r) => r.role.name) })));
  } catch (err) {
    next(err);
  }
});

const grantRoleSchema = z.object({ role: z.nativeEnum(RoleName) });

usersRouter.post("/:userId/roles", requireRole("ADMIN"), validateBody(grantRoleSchema), async (req: AuthedRequest<{ userId: string }>, res, next) => {
  try {
    const { userId } = req.params;
    const { role } = req.body as { role: RoleName };

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    const roleRow = await prisma.role.findUnique({ where: { name: role } });
    if (!roleRow) return res.status(400).json({ error: `Unknown role: ${role}` });

    await prisma.userRole.upsert({
      where: { userId_roleId: { userId, roleId: roleRow.id } },
      create: { userId, roleId: roleRow.id, grantedBy: req.user!.id },
      update: {},
    });

    await recordAudit({ actorId: req.user!.id, action: "user.role_granted", entityType: "User", entityId: userId, metadata: { role } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// isActive and fullName are independent, optional edits on the same
// row — at least one is required. A tokenVersion bump only makes sense
// for isActive (it's what forces existing sessions to re-check), not a
// plain rename.
const updateUserSchema = z
  .object({ isActive: z.boolean().optional(), fullName: z.string().min(1).max(200).optional() })
  .refine((v) => v.isActive !== undefined || v.fullName !== undefined, { message: "Provide isActive and/or fullName" });

usersRouter.patch("/:userId", requireRole("ADMIN"), validateBody(updateUserSchema), async (req: AuthedRequest<{ userId: string }>, res, next) => {
  try {
    const { userId } = req.params;
    const { isActive, fullName } = req.body as { isActive?: boolean; fullName?: string };

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(isActive !== undefined ? { isActive, tokenVersion: { increment: 1 } } : {}),
        ...(fullName !== undefined ? { fullName } : {}),
      },
    });

    if (isActive !== undefined) {
      await recordAudit({ actorId: req.user!.id, action: isActive ? "user.activated" : "user.deactivated", entityType: "User", entityId: userId });
    }
    if (fullName !== undefined) {
      await recordAudit({ actorId: req.user!.id, action: "user.renamed", entityType: "User", entityId: userId, metadata: { from: targetUser.fullName, to: fullName } });
    }

    res.json({ id: updated.id, email: updated.email, fullName: updated.fullName, isActive: updated.isActive });
  } catch (err) {
    next(err);
  }
});

const resetPasswordSchema = z.object({ newPassword: z.string().min(10, "Password must be at least 10 characters") });

usersRouter.post(
  "/:userId/reset-password",
  requireRole("ADMIN"),
  validateBody(resetPasswordSchema),
  async (req: AuthedRequest<{ userId: string }>, res, next) => {
    try {
      const { userId } = req.params;
      const { newPassword } = req.body as { newPassword: string };

      const targetUser = await prisma.user.findUnique({ where: { id: userId } });
      if (!targetUser) return res.status(404).json({ error: "User not found" });

      const passwordHash = await bcrypt.hash(newPassword, 12);
      await prisma.user.update({ where: { id: userId }, data: { passwordHash, tokenVersion: { increment: 1 } } });

      await recordAudit({ actorId: req.user!.id, action: "user.password_reset", entityType: "User", entityId: userId });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.delete("/:userId/roles/:role", requireRole("ADMIN"), async (req: AuthedRequest<{ userId: string; role: string }>, res, next) => {
  try {
    const { userId, role } = req.params;
    const roleRow = await prisma.role.findUnique({ where: { name: role as RoleName } });
    if (!roleRow) return res.status(400).json({ error: `Unknown role: ${role}` });

    await prisma.userRole.deleteMany({ where: { userId, roleId: roleRow.id } });

    await recordAudit({ actorId: req.user!.id, action: "user.role_revoked", entityType: "User", entityId: userId, metadata: { role } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
