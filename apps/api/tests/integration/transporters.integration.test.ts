import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("Transporters: the Transport name dropdown on a shipment", () => {
  it("Dispatch adds and fixes transporters; Accounts and the Warehouse only read; duplicates are refused", async () => {
    const { token: dispatch } = await createUser(["DISPATCH"]);
    const { token: accounts } = await createUser(["ACCOUNTS"]);
    const { token: store } = await createUser(["STORE"]);
    const { token: bd } = await createUser(["BD"]);

    // Empty to begin with: each system fills its own
    expect((await request(app).get("/api/transporters").set(authHeader(dispatch))).body).toEqual([]);

    // The name is kept as typed; the Transporter ID is upper-cased and trimmed
    const first = await request(app).post("/api/transporters").set(authHeader(dispatch)).send({ name: "  Gurgaon Express ", transporterId: " 06girps2440p1ze " });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ name: "Gurgaon Express", transporterId: "06GIRPS2440P1ZE" });
    // The ID is optional
    const second = await request(app).post("/api/transporters").set(authHeader(dispatch)).send({ name: "Darsh Transport", transporterId: "" });
    expect(second.status).toBe(201);
    expect(second.body.transporterId).toBeNull();

    // The same name again (any spelling of the case) is one transporter
    const dup = await request(app).post("/api/transporters").set(authHeader(dispatch)).send({ name: "gurgaon express" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already in the list/);
    expect((await request(app).post("/api/transporters").set(authHeader(dispatch)).send({ name: "   " })).status).toBe(400);

    // The list is by name, for Dispatch, Accounts and the Warehouse; nobody else
    for (const token of [dispatch, accounts, store]) {
      const list = await request(app).get("/api/transporters").set(authHeader(token));
      expect(list.status).toBe(200);
      expect((list.body as { name: string }[]).map((t) => t.name)).toEqual(["Darsh Transport", "Gurgaon Express"]);
    }
    expect((await request(app).get("/api/transporters").set(authHeader(bd))).status).toBe(403);
    expect((await request(app).post("/api/transporters").set(authHeader(accounts)).send({ name: "RS Logistic" })).status).toBe(403);

    // Fixing one: the ID can be added later, and a name cannot become another's
    const fixed = await request(app).patch(`/api/transporters/${second.body.id}`).set(authHeader(dispatch)).send({ transporterId: "07dddpk9432h1zf" });
    expect(fixed.status).toBe(200);
    expect(fixed.body.transporterId).toBe("07DDDPK9432H1ZF");
    expect((await request(app).patch(`/api/transporters/${second.body.id}`).set(authHeader(dispatch)).send({ name: "GURGAON EXPRESS" })).status).toBe(409);
    expect((await request(app).patch(`/api/transporters/${second.body.id}`).set(authHeader(accounts)).send({ name: "Darsh" })).status).toBe(403);
    expect((await request(app).patch("/api/transporters/00000000-0000-0000-0000-000000000000").set(authHeader(dispatch)).send({ name: "X" })).status).toBe(404);
  });
});
