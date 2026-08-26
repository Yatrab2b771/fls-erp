import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/common/lib/prisma";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("POST /api/auth/register + login", () => {
  it("registers a roleless account and logs in", async () => {
    const reg = await request(app).post("/api/auth/register").send({ email: "new@fls.test", password: "SuperSecret123", fullName: "New Person" });
    expect(reg.status).toBe(201);
    expect(reg.body.roles).toEqual([]);

    const login = await request(app).post("/api/auth/login").send({ email: "new@fls.test", password: "SuperSecret123" });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
  });

  it("rejects a wrong password", async () => {
    await request(app).post("/api/auth/register").send({ email: "wrong@fls.test", password: "SuperSecret123", fullName: "Wrong" });
    const login = await request(app).post("/api/auth/login").send({ email: "wrong@fls.test", password: "NotThePassword" });
    expect(login.status).toBe(401);
  });
});

describe("POST /api/auth/login rate limiting", () => {
  it("is keyed by IP + email together, not IP alone — exhausting one account's attempts doesn't lock out a different account from the same IP", async () => {
    // Each iteration is a real bcrypt.compare at cost 12 (by design — not
    // something to weaken for test speed), so 10+ of them sequentially
    // routinely runs past vitest's 5s default.
    await request(app).post("/api/auth/register").send({ email: "victim@fls.test", password: "SuperSecret123", fullName: "Victim" });
    await request(app).post("/api/auth/register").send({ email: "bystander@fls.test", password: "SuperSecret123", fullName: "Bystander" });

    // Burn through the 10-attempt window on one account (e.g. someone
    // mistyping their password repeatedly).
    let lastStatus = 0;
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post("/api/auth/login").send({ email: "victim@fls.test", password: "WrongPassword" });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(401); // the 10 allowed attempts still just fail auth, not rate-limited yet

    const eleventh = await request(app).post("/api/auth/login").send({ email: "victim@fls.test", password: "WrongPassword" });
    expect(eleventh.status).toBe(429);

    // A different account hitting the API from the same test client (same
    // source IP in this harness) is completely unaffected.
    const bystander = await request(app).post("/api/auth/login").send({ email: "bystander@fls.test", password: "SuperSecret123" });
    expect(bystander.status).toBe(200);
  }, 15000);

  it("doesn't count successful logins against the limit — only failed ones", async () => {
    await request(app).post("/api/auth/register").send({ email: "repeat-login@fls.test", password: "SuperSecret123", fullName: "Repeat Login" });

    // Logging in correctly more than 10 times in the window (e.g. testing
    // multiple department accounts, or just re-logging in a lot) must
    // never trip the limit — only actual failed attempts should.
    let lastStatus = 0;
    for (let i = 0; i < 15; i++) {
      const res = await request(app).post("/api/auth/login").send({ email: "repeat-login@fls.test", password: "SuperSecret123" });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(200);
  }, 15000);
});

describe("GET /api/auth/me", () => {
  it("requires a bearer token and returns the current user's roles", async () => {
    const denied = await request(app).get("/api/auth/me");
    expect(denied.status).toBe(401);

    const { token } = await createUser(["BD"]);
    const res = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(["BD"]);
  });
});

describe("POST /api/auth/change-password", () => {
  it("invalidates the old token by bumping tokenVersion", async () => {
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
  });
});
