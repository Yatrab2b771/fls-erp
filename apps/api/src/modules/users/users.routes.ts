import bcrypt from "bcryptjs";
import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";
import { Prisma, RoleName } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { loginIdSchema, passwordSchema } from "../auth/auth.schemas";

/**
 * The logins of the system. The System Admin (role ADMIN) manages every account. Each department has ONE department admin (set by the System
 * Admin): he sees and manages the accounts of his own department only. The admin types the login ID and the password himself.
 *
 *   GET    /                       the accounts (a department admin: only people who hold nothing but his own department's role)
 *   POST   /                       create an account: name, login ID, password, email (optional), role (a department admin: his own department)
 *   PATCH  /:userId                switch on / off, rename, change the login ID or the email
 *   POST   /:userId/reset-password set a new password (they are signed out everywhere)
 *   PATCH  /:userId/dept-admin     System Admin: make someone the admin of a department (replaces the earlier one)
 *   POST   /:userId/roles, DELETE /:userId/roles/:role   System Admin only
 *
 * A department admin can manage a person only if every role that person holds is one of his own departments and none of them is ADMIN, so nobody
 * can use a department's reach to get into another department. Nobody can read a password: it is stored scrambled.
 */
export const usersRouter = Router();

usersRouter.use(requireAuth);

type Scope = { system: boolean; depts: RoleName[] };
type ScopedRequest<P extends Record<string, string> = Record<string, string>> = AuthedRequest<P> & { scope: Scope };

/** What the caller may manage: everything (System Admin), his department(s) (department admin), or nothing (403). */
async function withScope(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const system = req.user!.roles.includes("ADMIN");
    const rows = system ? [] : await prisma.userRole.findMany({ where: { userId: req.user!.id, isDeptAdmin: true }, select: { role: { select: { name: true } } } });
    const depts = rows.map((r) => r.role.name);
    if (!system && depts.length === 0) return res.status(403).json({ error: "You do not have permission to perform this action" });
    (req as ScopedRequest).scope = { system, depts };
    next();
  } catch (err) {
    next(err);
  }
}

const canManage = (scope: Scope, targetRoles: RoleName[]) => scope.system || (targetRoles.length > 0 && targetRoles.every((r) => r !== "ADMIN" && scope.depts.includes(r)));

const userInclude = { roles: { include: { role: true } } } satisfies Prisma.UserInclude;
type UserRow = Prisma.UserGetPayload<{ include: typeof userInclude }>;

const serialize = (u: UserRow) => ({
  id: u.id,
  employeeId: u.employeeId,
  loginId: u.loginId,
  email: u.email,
  fullName: u.fullName,
  isActive: u.isActive,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt,
  passwordChangedAt: u.passwordChangedAt,
  passwordChangedBy: u.passwordChangedBy,
  roles: u.roles.map((r) => r.role.name),
  deptAdminOf: u.roles.filter((r) => r.isDeptAdmin).map((r) => r.role.name),
});

const loadTarget = (id: string) => prisma.user.findUnique({ where: { id }, include: userInclude });

/** A login ID must not be another account's login ID or email (a login is by either), and an email must not be another's login ID. */
async function identityTaken(values: string[], exceptUserId?: string): Promise<string | null> {
  for (const v of values.filter(Boolean)) {
    const hit = await prisma.user.findFirst({
      where: { id: exceptUserId ? { not: exceptUserId } : undefined, OR: [{ loginId: v.toLowerCase() }, { email: { equals: v, mode: "insensitive" } }] },
      select: { loginId: true, email: true },
    });
    if (hit) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------

usersRouter.get("/", withScope, async (req, res, next) => {
  try {
    const { scope } = req as ScopedRequest;
    const where: Prisma.UserWhereInput = scope.system ? {} : { roles: { some: { role: { name: { in: scope.depts } } }, none: { role: { name: { notIn: scope.depts } } } } };
    const pagination = parsePagination(req);
    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, include: userInclude, orderBy: { createdAt: "asc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(users.map(serialize));
  } catch (err) {
    next(err);
  }
});

const createUserSchema = z.object({
  fullName: z.string().trim().min(1, "Enter the full name").max(200),
  loginId: loginIdSchema,
  password: passwordSchema,
  email: z.union([z.literal(""), z.string().trim().toLowerCase().email().max(200)]).optional(),
  role: z.nativeEnum(RoleName).optional(),
});

usersRouter.post("/", withScope, validateBody(createUserSchema), async (req, res, next) => {
  try {
    const { scope } = req as ScopedRequest;
    const b = req.body as z.infer<typeof createUserSchema>;
    const actor = (req as AuthedRequest).user!;
    // a department admin always creates inside his own department
    const role = scope.system ? b.role : (b.role ?? (scope.depts.length === 1 ? scope.depts[0] : undefined));
    if (!scope.system && (!role || !scope.depts.includes(role))) return res.status(403).json({ error: "You can create logins only for your own department." });
    const email = b.email || `${b.loginId}@fls.local`;
    const taken = await identityTaken([b.loginId, email]);
    if (taken) return res.status(409).json({ error: `"${taken}" is already used by another account.` });

    const roleRow = role ? await prisma.role.findUnique({ where: { name: role } }) : null;
    if (role && !roleRow) return res.status(400).json({ error: `Unknown role: ${role}` });
    const passwordHash = await bcrypt.hash(b.password, 12);
    const created = await prisma.user.create({
      data: {
        email,
        loginId: b.loginId,
        fullName: b.fullName,
        passwordHash,
        passwordChangedAt: new Date(),
        passwordChangedBy: "ADMIN",
        ...(roleRow ? { roles: { create: { roleId: roleRow.id, grantedBy: actor.id } } } : {}),
      },
      include: userInclude,
    });
    await recordAudit({ actorId: actor.id, action: "user.created", entityType: "User", entityId: created.id, metadata: { loginId: b.loginId, role: role ?? null } });
    res.status(201).json(serialize(created));
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

    await prisma.$transaction([
      prisma.userRole.upsert({
        where: { userId_roleId: { userId, roleId: roleRow.id } },
        create: { userId, roleId: roleRow.id, grantedBy: req.user!.id },
        update: {},
      }),
      // requireAuth checks tokenVersion live against the DB, but the
      // `roles` array itself comes straight from the JWT payload minted
      // at login — never re-checked. Without this bump, a role granted
      // here wouldn't actually work until the user's next login.
      prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } }),
    ]);

    await recordAudit({ actorId: req.user!.id, action: "user.role_granted", entityType: "User", entityId: userId, metadata: { role } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

const updateUserSchema = z
  .object({ isActive: z.boolean().optional(), fullName: z.string().min(1).max(200).optional(), email: z.string().email().max(200).optional(), loginId: loginIdSchema.optional() })
  .refine((v) => v.isActive !== undefined || v.fullName !== undefined || v.email !== undefined || v.loginId !== undefined, { message: "Provide isActive, fullName, email and/or loginId" });

usersRouter.patch("/:userId", withScope, validateBody(updateUserSchema), async (req, res, next) => {
  try {
    const { scope } = req as ScopedRequest;
    const actor = (req as AuthedRequest).user!;
    const { userId } = req.params as { userId: string };
    const { isActive, fullName, email, loginId } = req.body as z.infer<typeof updateUserSchema>;

    const target = await loadTarget(userId);
    if (!target) return res.status(404).json({ error: "User not found" });
    if (!canManage(scope, target.roles.map((r) => r.role.name))) return res.status(403).json({ error: "You can manage only the people of your own department." });
    const self = target.id === actor.id;
    if (self && isActive === false) return res.status(409).json({ error: "You cannot switch yourself off." });
    if (self && !scope.system && (email !== undefined || loginId !== undefined)) return res.status(409).json({ error: "Ask the System Admin to change your own login ID or email." });

    const emailChanged = email !== undefined && email.toLowerCase() !== target.email.toLowerCase();
    const loginChanged = loginId !== undefined && loginId !== target.loginId;
    const taken = await identityTaken([...(emailChanged ? [email!] : []), ...(loginChanged ? [loginId!] : [])], target.id);
    if (taken) return res.status(409).json({ error: `"${taken}" is already used by another account.` });

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(isActive !== undefined ? { isActive, tokenVersion: { increment: 1 } } : {}),
        ...(fullName !== undefined ? { fullName } : {}),
        // The email and the login ID are the login identity: change either and an existing session is signed out, so nobody keeps working
        // under a stale identity.
        ...(emailChanged || loginChanged ? { tokenVersion: { increment: 1 } } : {}),
        ...(emailChanged ? { email: email!.toLowerCase() } : {}),
        ...(loginChanged ? { loginId } : {}),
      },
      include: userInclude,
    });

    if (isActive !== undefined) await recordAudit({ actorId: actor.id, action: isActive ? "user.activated" : "user.deactivated", entityType: "User", entityId: userId });
    if (fullName !== undefined) await recordAudit({ actorId: actor.id, action: "user.renamed", entityType: "User", entityId: userId, metadata: { from: target.fullName, to: fullName } });
    if (emailChanged) await recordAudit({ actorId: actor.id, action: "user.email_changed", entityType: "User", entityId: userId, metadata: { from: target.email, to: email } });
    if (loginChanged) await recordAudit({ actorId: actor.id, action: "user.login_id_changed", entityType: "User", entityId: userId, metadata: { from: target.loginId, to: loginId } });

    res.json(serialize(updated));
  } catch (err) {
    next(err);
  }
});

const resetPasswordSchema = z.object({ newPassword: passwordSchema });

usersRouter.post("/:userId/reset-password", withScope, validateBody(resetPasswordSchema), async (req, res, next) => {
  try {
    const { scope } = req as ScopedRequest;
    const actor = (req as AuthedRequest).user!;
    const { userId } = req.params as { userId: string };
    const { newPassword } = req.body as { newPassword: string };

    const target = await loadTarget(userId);
    if (!target) return res.status(404).json({ error: "User not found" });
    if (!canManage(scope, target.roles.map((r) => r.role.name))) return res.status(403).json({ error: "You can manage only the people of your own department." });
    if (target.id === actor.id && !scope.system) return res.status(409).json({ error: "Change your own password from your profile (type the old one)." });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    // tokenVersion: the person is signed out everywhere and logs in again with the new password
    await prisma.user.update({ where: { id: userId }, data: { passwordHash, passwordChangedAt: new Date(), passwordChangedBy: "ADMIN", tokenVersion: { increment: 1 } } });
    await recordAudit({ actorId: actor.id, action: "user.password_reset", entityType: "User", entityId: userId });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

const deptAdminSchema = z.object({ role: z.nativeEnum(RoleName), isDeptAdmin: z.boolean() });

usersRouter.patch("/:userId/dept-admin", requireRole("ADMIN"), validateBody(deptAdminSchema), async (req: AuthedRequest<{ userId: string }>, res, next) => {
  try {
    const { userId } = req.params;
    const { role, isDeptAdmin } = req.body as z.infer<typeof deptAdminSchema>;
    if (role === "ADMIN") return res.status(400).json({ error: "ADMIN is not a department." });
    const roleRow = await prisma.role.findUnique({ where: { name: role } });
    if (!roleRow) return res.status(400).json({ error: `Unknown role: ${role}` });
    const held = await prisma.userRole.findUnique({ where: { userId_roleId: { userId, roleId: roleRow.id } } });
    if (!held) return res.status(409).json({ error: `This person does not hold the ${role} role. Give the role first.` });

    await prisma.$transaction(async (tx) => {
      // one admin per department: the earlier one stops being the admin
      if (isDeptAdmin) await tx.userRole.updateMany({ where: { roleId: roleRow.id, isDeptAdmin: true }, data: { isDeptAdmin: false } });
      await tx.userRole.update({ where: { userId_roleId: { userId, roleId: roleRow.id } }, data: { isDeptAdmin } });
    });
    await recordAudit({ actorId: req.user!.id, action: "user.dept_admin_set", entityType: "User", entityId: userId, metadata: { role, isDeptAdmin } });
    const updated = await loadTarget(userId);
    res.json(serialize(updated!));
  } catch (err) {
    next(err);
  }
});

usersRouter.delete("/:userId/roles/:role", requireRole("ADMIN"), async (req: AuthedRequest<{ userId: string; role: string }>, res, next) => {
  try {
    const { userId, role } = req.params;
    const roleRow = await prisma.role.findUnique({ where: { name: role as RoleName } });
    if (!roleRow) return res.status(400).json({ error: `Unknown role: ${role}` });

    // Same tokenVersion bump as granting a role, and for the same
    // reason it matters more here: without it, a revoked role stays
    // fully usable on the user's existing token until it expires.
    await prisma.$transaction([prisma.userRole.deleteMany({ where: { userId, roleId: roleRow.id } }), prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } })]);

    await recordAudit({ actorId: req.user!.id, action: "user.role_revoked", entityType: "User", entityId: userId, metadata: { role } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
