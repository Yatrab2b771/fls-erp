import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/common/lib/prisma";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("login (by login ID or email) and the closed sign-up", () => {
  it("does not let anyone make an account for himself: the admin of his department creates the login", async () => {
    const reg = await request(app).post("/api/auth/register").send({ email: "new@fls.test", password: "SuperSecret123", fullName: "New Person" });
    expect(reg.status).toBe(403);
    expect(await prisma.user.count({ where: { email: "new@fls.test" } })).toBe(0);
  });

  it("logs in with the email or with the login ID (any letter case), and notes the last login", async () => {
    const { user, email, password } = await createUser(["BD"]);
    await prisma.user.update({ where: { id: user.id }, data: { loginId: `aman.bd.${user.employeeId}` } });

    const byEmail = await request(app).post("/api/auth/login").send({ email, password });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.token).toBeTruthy();
    expect(byEmail.body.user).toMatchObject({ loginId: `aman.bd.${user.employeeId}`, roles: ["BD"], deptAdminOf: [] });

    const byLogin = await request(app).post("/api/auth/login").send({ login: `AMAN.bd.${user.employeeId}`, password });
    expect(byLogin.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).lastLoginAt).not.toBeNull();
  });

  it("rejects a wrong password and an unknown login", async () => {
    const { email } = await createUser([]);
    expect((await request(app).post("/api/auth/login").send({ email, password: "NotThePassword" })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ login: "nobody.here", password: "TestPassword123" })).status).toBe(401);
  });
});

describe("POST /api/auth/login rate limiting", () => {
  it("is keyed by IP + login together, not IP alone — exhausting one account's attempts doesn't lock out a different account from the same IP", async () => {
    // Each iteration is a real bcrypt.compare (by design), so 10+ of them
    // sequentially routinely runs past vitest's 5s default.
    const victim = await createUser([]);
    const bystander = await createUser([]);

    // Burn through the 10-attempt window on one account (e.g. someone
    // mistyping their password repeatedly).
    let lastStatus = 0;
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post("/api/auth/login").send({ email: victim.email, password: "WrongPassword" });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(401); // the 10 allowed attempts still just fail auth, not rate-limited yet

    const eleventh = await request(app).post("/api/auth/login").send({ email: victim.email, password: "WrongPassword" });
    expect(eleventh.status).toBe(429);

    // A different account hitting the API from the same test client (same
    // source IP in this harness) is completely unaffected.
    const ok = await request(app).post("/api/auth/login").send({ email: bystander.email, password: bystander.password });
    expect(ok.status).toBe(200);
  }, 30000);

  it("doesn't count successful logins against the limit — only failed ones", async () => {
    const { email, password } = await createUser([]);

    // Logging in correctly more than 10 times in the window must never
    // trip the limit — only actual failed attempts should.
    let lastStatus = 0;
    for (let i = 0; i < 15; i++) {
      const res = await request(app).post("/api/auth/login").send({ email, password });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(200);
  }, 30000);
});

describe("GET /api/auth/me", () => {
  it("requires a bearer token and returns the current user's roles", async () => {
    const denied = await request(app).get("/api/auth/me");
    expect(denied.status).toBe(401);

    const { token } = await createUser(["BD"]);
    const res = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(["BD"]);
    expect(res.body.deptAdminOf).toEqual([]);
  });
});

describe("POST /api/auth/change-password", () => {
  it("invalidates the old token by bumping tokenVersion, and notes that the user changed it himself", async () => {
    const { user, token } = await createUser([]);
    const passwordHash = await bcrypt.hash("OldPassword123", 10);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    const changed = await request(app).post("/api/auth/change-password").set(authHeader(token)).send({ currentPassword: "OldPassword123", newPassword: "NewPassword123" });
    expect(changed.status).toBe(200);
    expect(changed.body.token).toBeTruthy();

    const staleTokenReq = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(staleTokenReq.status).toBe(401);

    const freshTokenReq = await request(app).get("/api/auth/me").set(authHeader(changed.body.token));
    expect(freshTokenReq.status).toBe(200);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordChangedBy: true, passwordChangedAt: true } })).toMatchObject({ passwordChangedBy: "USER" });
  });
});
