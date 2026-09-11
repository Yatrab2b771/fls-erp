import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

// System Health / Audit Log — Admin-only operational tooling, same gate
// as Users/Recycle Bin (requireRole("ADMIN")). No separate role exists
// for this — any ADMIN, and only an ADMIN, can reach both.
describe("System Health / Audit Log — Admin-only", () => {
  it("GET /api/system/health is Admin-only and reports a real DB round trip", async () => {
    const { token: plainToken } = await createUser([]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: adminToken } = await createUser(["ADMIN"]);

    expect((await request(app).get("/api/system/health").set(authHeader(plainToken))).status).toBe(403);
    expect((await request(app).get("/api/system/health").set(authHeader(storeToken))).status).toBe(403);

    const res = await request(app).get("/api/system/health").set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.db.connected).toBe(true);
    expect(typeof res.body.db.latencyMs).toBe("number");
    expect(res.body.process.nodeVersion).toBeTruthy();
    expect(res.body.counts.users).toBeGreaterThanOrEqual(3); // the 3 users just created above, at least
  });

  it("GET /api/system/audit-log is Admin-only, paginated newest-first, and filterable by action/entityType", async () => {
    const { token: plainToken } = await createUser([]);
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { user: target } = await createUser(["STORE"]);

    expect((await request(app).get("/api/system/audit-log").set(authHeader(plainToken))).status).toBe(403);

    // Granting a role (above, via createUser's own seeding) doesn't
    // itself go through the audited route, so generate one real audited
    // action here to search for.
    await request(app).patch(`/api/users/${target.id}`).set(authHeader(adminToken)).send({ fullName: "Audited Rename" });

    const all = await request(app).get("/api/system/audit-log").set(authHeader(adminToken));
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body)).toBe(true);
    expect(all.body.length).toBeGreaterThan(0);
    // Newest first.
    const timestamps = all.body.map((e: { createdAt: string }) => new Date(e.createdAt).getTime());
    expect([...timestamps]).toEqual([...timestamps].sort((a, b) => b - a));

    const filtered = await request(app).get("/api/system/audit-log?action=user.renamed").set(authHeader(adminToken));
    expect(filtered.status).toBe(200);
    expect(filtered.body.length).toBeGreaterThan(0);
    for (const entry of filtered.body) expect(entry.action).toBe("user.renamed");
    expect(filtered.body[0].actor.id).toBe((await request(app).get("/api/auth/me").set(authHeader(adminToken))).body.id);

    const noMatch = await request(app).get("/api/system/audit-log?action=nonexistent.action").set(authHeader(adminToken));
    expect(noMatch.body).toEqual([]);
  });
});
