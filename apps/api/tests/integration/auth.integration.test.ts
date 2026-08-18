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
