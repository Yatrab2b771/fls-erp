import bcrypt from "bcryptjs";
import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { signAccessToken } from "../../common/lib/jwt";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { loginRateLimit } from "../../common/middleware/rate-limit";
import { changePasswordSchema, loginSchema, registerSchema, type ChangePasswordInput, type LoginInput, type RegisterInput } from "./auth.schemas";

export const authRouter = Router();

function serializeUser(user: { id: string; email: string; fullName: string; roles: { role: { name: string } }[] }) {
  return { id: user.id, email: user.email, fullName: user.fullName, roles: user.roles.map((r) => r.role.name) };
}

// New users register with no roles — only an Admin can grant roles
// (POST /api/users/:userId/roles), so there's no self-service path to
// privilege beyond an Admin deciding to. Deliberately unrate-limited: it
// only ever creates a roleless account, nothing an attacker gains from
// spamming it.
authRouter.post("/register", validateBody(registerSchema), async (req, res, next) => {
  try {
    const { email, password, fullName } = req.body as RegisterInput;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: "An account with this email already exists" });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({ data: { email, passwordHash, fullName }, include: { roles: { include: { role: true } } } });

    await recordAudit({ actorId: user.id, action: "user.registered", entityType: "User", entityId: user.id });

    res.status(201).json(serializeUser(user));
  } catch (err) {
    next(err);
  }
});

authRouter.post("/login", loginRateLimit, validateBody(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body as LoginInput;
    const user = await prisma.user.findUnique({ where: { email }, include: { roles: { include: { role: true } } } });
    if (!user || !user.isActive) return res.status(401).json({ error: "Invalid email or password" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });

    const roles = user.roles.map((r) => r.role.name);
    const token = signAccessToken({ sub: user.id, roles, tokenVersion: user.tokenVersion });

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
      data: { passwordHash, tokenVersion: { increment: 1 } },
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
