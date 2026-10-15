import bcrypt from "bcryptjs";
import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { signAccessToken } from "../../common/lib/jwt";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { loginRateLimit } from "../../common/middleware/rate-limit";
import { changePasswordSchema, loginSchema, type ChangePasswordInput, type LoginInput } from "./auth.schemas";

export const authRouter = Router();

type UserWithRoles = { id: string; employeeId: number; email: string; loginId: string | null; fullName: string; roles: { isDeptAdmin: boolean; role: { name: string } }[] };

function serializeUser(user: UserWithRoles) {
  return {
    id: user.id,
    employeeId: user.employeeId,
    email: user.email,
    loginId: user.loginId,
    fullName: user.fullName,
    roles: user.roles.map((r) => r.role.name),
    // The departments this person is the admin of (the "My team" page shows for them)
    deptAdminOf: user.roles.filter((r) => r.isDeptAdmin).map((r) => r.role.name),
  };
}

// Accounts are not made by the person himself: the admin of his department (or the System Admin) creates the login (apps/api users routes).
authRouter.post("/register", (_req, res) => {
  res.status(403).json({ error: "Accounts are created by the admin of your department. Ask them for a login." });
});

authRouter.post("/login", loginRateLimit, validateBody(loginSchema), async (req, res, next) => {
  try {
    const { login, email, password } = req.body as LoginInput;
    const who = (login ?? email ?? "").trim();
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: { equals: who, mode: "insensitive" } }, { loginId: who.toLowerCase() }] },
      include: { roles: { include: { role: true } } },
    });
    if (!user || !user.isActive) return res.status(401).json({ error: "Invalid login ID or password" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Invalid login ID or password" });

    const roles = user.roles.map((r) => r.role.name);
    const token = signAccessToken({ sub: user.id, roles, tokenVersion: user.tokenVersion });

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await recordAudit({ actorId: user.id, action: "user.login", entityType: "User", entityId: user.id });

    res.json({ token, user: serializeUser(user) });
  } catch (err) {
    next(err);
  }
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, include: { roles: { include: { role: true } } } });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(serializeUser(user));
  } catch (err) {
    next(err);
  }
});

// Re-issues a fresh token in the response so changing your own password
// doesn't log you out of your own session.
authRouter.post("/change-password", requireAuth, validateBody(changePasswordSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body as ChangePasswordInput;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Current password is incorrect" });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordChangedAt: new Date(), passwordChangedBy: "USER", tokenVersion: { increment: 1 } },
      include: { roles: { include: { role: true } } },
    });

    await recordAudit({ actorId: user.id, action: "user.password_changed", entityType: "User", entityId: user.id });

    const roles = updated.roles.map((r) => r.role.name);
    const token = signAccessToken({ sub: updated.id, roles, tokenVersion: updated.tokenVersion });
    res.json({ token, user: serializeUser(updated) });
  } catch (err) {
    next(err);
  }
});
