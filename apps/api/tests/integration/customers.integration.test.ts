import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("POST /api/customers", () => {
  it("is restricted to BD (ADMIN bypasses)", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const denied = await request(app).post("/api/customers").set(authHeader(storeToken)).send({ companyName: "X" });
    expect(denied.status).toBe(403);

    const { token: bdToken } = await createUser(["BD"]);
    const asBd = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "BD Created Co." });
    expect(asBd.status).toBe(201);
  });

  it("read access is open to any authenticated user", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Co." });

    const { token: plainToken } = await createUser([]);
    const res = await request(app).get("/api/customers").set(authHeader(plainToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
  });
});
