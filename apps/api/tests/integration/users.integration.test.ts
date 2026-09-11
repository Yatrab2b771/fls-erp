import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("Users module — admin directory, role grant/revoke, activate/deactivate", () => {
  it("GET / and role grant/revoke are ADMIN-only", async () => {
    const { token: plainToken } = await createUser([]);
    const { user: target } = await createUser([]);

    expect((await request(app).get("/api/users").set(authHeader(plainToken))).status).toBe(403);
    expect((await request(app).post(`/api/users/${target.id}/roles`).set(authHeader(plainToken)).send({ role: "STORE" })).status).toBe(403);
    expect((await request(app).delete(`/api/users/${target.id}/roles/STORE`).set(authHeader(plainToken))).status).toBe(403);
  });

  it("granting a role bumps tokenVersion — the target's existing token stops working immediately, a fresh login carries the new role", async () => {
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { user: target, token: staleToken, email, password } = await createUser([]);

    const granted = await request(app).post(`/api/users/${target.id}/roles`).set(authHeader(adminToken)).send({ role: "STORE" });
    expect(granted.status).toBe(204);

    // The token minted before the grant no longer verifies — roles come
    // from the JWT payload, never re-fetched, so without the
    // tokenVersion bump this old token would silently keep working with
    // its stale (roleless) roles array, and separately, the new role
    // wouldn't take effect until whatever the token's natural expiry is.
    const staleReq = await request(app).get("/api/auth/me").set(authHeader(staleToken));
    expect(staleReq.status).toBe(401);

    const relogin = await request(app).post("/api/auth/login").send({ email, password });
    expect(relogin.status).toBe(200);
    expect(relogin.body.user.roles).toEqual(["STORE"]);

    const freshReq = await request(app).post("/api/inventory/items").set(authHeader(relogin.body.token)).send({ category: "RM", name: "Test Item" });
    expect(freshReq.status).toBe(201); // STORE-gated route, now actually usable
  });

  it("revoking a role bumps tokenVersion — the target's existing (still-privileged) token stops working immediately, not just at natural expiry", async () => {
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { user: target, token: staleToken, email, password } = await createUser(["STORE"]);

    const revoked = await request(app).delete(`/api/users/${target.id}/roles/STORE`).set(authHeader(adminToken));
    expect(revoked.status).toBe(204);

    // This is the real point of the fix: the revoked user's existing
    // token — which still carries the STORE role it was minted with —
    // must stop working right away, not stay valid until it naturally
    // expires.
    const staleReq = await request(app).get("/api/auth/me").set(authHeader(staleToken));
    expect(staleReq.status).toBe(401);

    const relogin = await request(app).post("/api/auth/login").send({ email, password });
    expect(relogin.body.user.roles).toEqual([]);

    const freshReq = await request(app).post("/api/inventory/items").set(authHeader(relogin.body.token)).send({ category: "RM", name: "Test Item" });
    expect(freshReq.status).toBe(403); // role is really gone now, not just cosmetically
  });

  it("PATCH /:userId can deactivate/reactivate and rename; deactivating bumps tokenVersion", async () => {
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { user: target, token: staleToken } = await createUser(["STORE"]);

    const deactivated = await request(app).patch(`/api/users/${target.id}`).set(authHeader(adminToken)).send({ isActive: false });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.isActive).toBe(false);

    const staleReq = await request(app).get("/api/auth/me").set(authHeader(staleToken));
    expect(staleReq.status).toBe(401);

    const renamed = await request(app).patch(`/api/users/${target.id}`).set(authHeader(adminToken)).send({ fullName: "Renamed Person" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.fullName).toBe("Renamed Person");
  });

  it("PATCH /:userId can change email — Admin-only, bumps tokenVersion, rejects a conflicting existing email", async () => {
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { user: target, token: staleToken } = await createUser(["STORE"]);
    const { email: otherEmail } = await createUser([]);

    const deniedNonAdmin = await request(app).patch(`/api/users/${target.id}`).set(authHeader(staleToken)).send({ email: "new-address@fls.test" });
    expect(deniedNonAdmin.status).toBe(403);

    const conflict = await request(app).patch(`/api/users/${target.id}`).set(authHeader(adminToken)).send({ email: otherEmail });
    expect(conflict.status).toBe(409);

    const changed = await request(app).patch(`/api/users/${target.id}`).set(authHeader(adminToken)).send({ email: "new-address@fls.test" });
    expect(changed.status).toBe(200);
    expect(changed.body.email).toBe("new-address@fls.test");

    // Same "existing session stops working immediately" guarantee as
    // deactivate/role-revoke — email is part of login identity too.
    const staleReq = await request(app).get("/api/auth/me").set(authHeader(staleToken));
    expect(staleReq.status).toBe(401);

    const relogin = await request(app).post("/api/auth/login").send({ email: "new-address@fls.test", password: "TestPassword123" });
    expect(relogin.status).toBe(200);
  });
});
