import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/common/lib/prisma";
import { authHeader, createUser } from "./helpers";

const app = createApp();

const call = (token: string, method: "get" | "post" | "patch" | "delete", path: string, body?: object) => {
  const r = request(app)[method](path).set(authHeader(token));
  return body ? r.send(body) : r;
};

/** Makes this person the admin of one department, the way the System Admin does it. */
async function makeDeptAdmin(user: { id: string }, role: "BD" | "PPIC" | "STORE") {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { name: role } });
  await prisma.userRole.update({ where: { userId_roleId: { userId: user.id, roleId: roleRow.id } }, data: { isDeptAdmin: true } });
}

describe("Department admin: the logins of one department", () => {
  it("lets the department admin create and manage only his own department's logins, with the login ID and password he types", async () => {
    const stamp = Date.now();
    const sys = await createUser(["ADMIN"]);
    const bdAdmin = await createUser(["BD"]);
    await makeDeptAdmin(bdAdmin.user, "BD");
    const bdUser = await createUser(["BD"]);
    const ppicUser = await createUser(["PPIC"]);
    const twoDepts = await createUser(["BD", "PPIC"]);
    const plain = await createUser(["BD"]); // not an admin

    // Only an admin sees the users page; a department admin sees his own department (and nobody who also holds another role)
    expect((await call(plain.token, "get", "/api/users")).status).toBe(403);
    const mine = (await call(bdAdmin.token, "get", "/api/users")).body as { id: string; deptAdminOf: string[] }[];
    expect(mine.map((u) => u.id)).toEqual(expect.arrayContaining([bdAdmin.user.id, bdUser.user.id]));
    expect(mine.map((u) => u.id)).not.toContain(ppicUser.user.id);
    expect(mine.map((u) => u.id)).not.toContain(twoDepts.user.id);
    expect(mine.find((u) => u.id === bdAdmin.user.id)!.deptAdminOf).toEqual(["BD"]);
    expect((await call(sys.token, "get", "/api/users")).body.length).toBeGreaterThanOrEqual(5);

    // Create: login ID and password are typed by the admin; the department is his own
    const login = `neha.bd.${stamp}`;
    expect((await call(bdAdmin.token, "post", "/api/users", { fullName: "Neha Kapoor", loginId: "has space", password: "Secret-Pass-123" })).status).toBe(400);
    expect((await call(bdAdmin.token, "post", "/api/users", { fullName: "Neha Kapoor", loginId: login, password: "short" })).status).toBe(400);
    expect((await call(bdAdmin.token, "post", "/api/users", { fullName: "Neha Kapoor", loginId: login, password: "Secret-Pass-123", role: "PPIC" })).status).toBe(403); // another department
    const created = await call(bdAdmin.token, "post", "/api/users", { fullName: "Neha Kapoor", loginId: login.toUpperCase(), password: "Secret-Pass-123" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ loginId: login, fullName: "Neha Kapoor", roles: ["BD"], passwordChangedBy: "ADMIN", isActive: true });
    expect(created.body.email).toBe(`${login}@fls.local`);
    expect((await call(bdAdmin.token, "post", "/api/users", { fullName: "Again", loginId: login, password: "Secret-Pass-123" })).status).toBe(409); // the login ID is taken

    // The new person logs in with the login ID and the password the admin typed (no first-login change is forced)
    const loggedIn = await request(app).post("/api/auth/login").send({ login, password: "Secret-Pass-123" });
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.body.user.roles).toEqual(["BD"]);
    const newId = created.body.id as string;

    // Manage: rename, change the login ID (signs him out), switch off and on, reset the password
    expect((await call(bdAdmin.token, "patch", `/api/users/${newId}`, { fullName: "Neha K." })).body.fullName).toBe("Neha K.");
    const moved = await call(bdAdmin.token, "patch", `/api/users/${newId}`, { loginId: `neha.k.${stamp}` });
    expect(moved.status).toBe(200);
    expect((await call(loggedIn.body.token, "get", "/api/auth/me")).status).toBe(401); // signed out by the change
    expect((await request(app).post("/api/auth/login").send({ login, password: "Secret-Pass-123" })).status).toBe(401); // the old login ID is gone
    await prisma.user.update({ where: { id: bdUser.user.id }, data: { loginId: `taken.${stamp}` } });
    expect((await call(bdAdmin.token, "patch", `/api/users/${newId}`, { loginId: `taken.${stamp}` })).status).toBe(409); // another account's login ID
    expect((await call(bdAdmin.token, "patch", `/api/users/${newId}`, { email: bdUser.email })).status).toBe(409); // another account's email
    expect((await call(bdAdmin.token, "patch", `/api/users/${newId}`, { isActive: false })).body.isActive).toBe(false);
    expect((await request(app).post("/api/auth/login").send({ login: `neha.k.${stamp}`, password: "Secret-Pass-123" })).status).toBe(401); // switched off
    expect((await call(bdAdmin.token, "patch", `/api/users/${newId}`, { isActive: true })).body.isActive).toBe(true);
    expect((await call(bdAdmin.token, "post", `/api/users/${newId}/reset-password`, { newPassword: "short" })).status).toBe(400);
    expect((await call(bdAdmin.token, "post", `/api/users/${newId}/reset-password`, { newPassword: "Brand-New-Pass-9" })).status).toBe(204);
    expect((await request(app).post("/api/auth/login").send({ login: `neha.k.${stamp}`, password: "Secret-Pass-123" })).status).toBe(401);
    const again = await request(app).post("/api/auth/login").send({ login: `neha.k.${stamp}`, password: "Brand-New-Pass-9" });
    expect(again.status).toBe(200);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: newId } });
    expect(after).toMatchObject({ passwordChangedBy: "ADMIN" });
    expect(after.lastLoginAt).not.toBeNull();

    // The user can change his own password himself; the log says who changed it last
    const own = await call(again.body.token, "post", "/api/auth/change-password", { currentPassword: "Brand-New-Pass-9", newPassword: "My-Own-Pass-2026" });
    expect(own.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: newId } })).passwordChangedBy).toBe("USER");
    // ...and the admin can still reset it when he forgets it
    expect((await call(bdAdmin.token, "post", `/api/users/${newId}/reset-password`, { newPassword: "Reset-After-Forgot-1" })).status).toBe(204);

    // Out of reach: another department, a person with two departments, the System Admin, himself (beyond his own password)
    for (const other of [ppicUser, twoDepts, sys]) {
      expect((await call(bdAdmin.token, "patch", `/api/users/${other.user.id}`, { fullName: "Hacked" })).status).toBe(403);
      expect((await call(bdAdmin.token, "post", `/api/users/${other.user.id}/reset-password`, { newPassword: "Hacked-Password-1" })).status).toBe(403);
    }
    expect((await call(bdAdmin.token, "post", `/api/users/${bdAdmin.user.id}/reset-password`, { newPassword: "Hacked-Password-1" })).status).toBe(409);
    expect((await call(bdAdmin.token, "patch", `/api/users/${bdAdmin.user.id}`, { isActive: false })).status).toBe(409);
    expect((await call(bdAdmin.token, "patch", `/api/users/${bdAdmin.user.id}`, { loginId: "my.new.id" })).status).toBe(409);
    // ...and he cannot hand out roles or make another admin
    expect((await call(bdAdmin.token, "post", `/api/users/${newId}/roles`, { role: "ADMIN" })).status).toBe(403);
    expect((await call(bdAdmin.token, "patch", `/api/users/${newId}/dept-admin`, { role: "BD", isDeptAdmin: true })).status).toBe(403);

    // The activity is written down
    const actions = (await prisma.auditLog.findMany({ where: { entityId: newId }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["user.created", "user.renamed", "user.login_id_changed", "user.deactivated", "user.activated", "user.password_reset", "user.password_changed"]));
  }, 60000);

  it("lets only the System Admin choose a department's admin, one per department, who must hold that role", async () => {
    const sys = await createUser(["ADMIN"]);
    const first = await createUser(["STORE"]);
    const second = await createUser(["STORE"]);
    const outsider = await createUser(["PPIC"]);
    const set = (token: string, userId: string, role: string, isDeptAdmin: boolean) => call(token, "patch", `/api/users/${userId}/dept-admin`, { role, isDeptAdmin });

    expect((await set(first.token, first.user.id, "STORE", true)).status).toBe(403);
    expect((await set(sys.token, first.user.id, "ADMIN", true)).status).toBe(400); // ADMIN is not a department
    expect((await set(sys.token, outsider.user.id, "STORE", true)).status).toBe(409); // does not hold the role

    expect((await set(sys.token, first.user.id, "STORE", true)).body.deptAdminOf).toEqual(["STORE"]);
    // making the second one the admin takes it from the first: one per department
    const moved = await set(sys.token, second.user.id, "STORE", true);
    expect(moved.body.deptAdminOf).toEqual(["STORE"]);
    expect(await prisma.userRole.count({ where: { role: { name: "STORE" }, isDeptAdmin: true } })).toBe(1);
    expect((await prisma.userRole.findFirstOrThrow({ where: { userId: first.user.id, role: { name: "STORE" } } })).isDeptAdmin).toBe(false);
    expect((await call(first.token, "get", "/api/users")).status).toBe(403); // no longer an admin
    expect((await call(second.token, "get", "/api/users")).status).toBe(200);

    // The System Admin creates a login for any department, and takes the admin away again
    const login = `sys.made.${Date.now()}`;
    expect((await call(sys.token, "post", "/api/users", { fullName: "Made By System", loginId: login, password: "System-Made-Pass-1", role: "PPIC" })).body.roles).toEqual(["PPIC"]);
    expect((await set(sys.token, second.user.id, "STORE", false)).body.deptAdminOf).toEqual([]);
  }, 30000);
});
