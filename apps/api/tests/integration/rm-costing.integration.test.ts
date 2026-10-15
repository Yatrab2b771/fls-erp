import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

const RECIPE_IMPORT_BODY = {
  recipes: [
    {
      name: "INTEGRATION TEST RECIPE",
      ingredients: [
        { name: "PEA PROTEIN EXTRACT", brand: "YANTAI CO", gPerServing: 7.0, proteinPct: 0.8 },
        { name: "SUCRALOSE PURE POWDER", brand: "TECHNO", gPerServing: 0.12, proteinPct: 0 },
      ],
    },
  ],
};

describe("POST /api/rm-costing/recipes/import", () => {
  it("is restricted to RND", async () => {
    const { token: plainToken } = await createUser([]);
    const denied = await request(app).post("/api/rm-costing/recipes/import").set(authHeader(plainToken)).send(RECIPE_IMPORT_BODY);
    expect(denied.status).toBe(403);

    // PPIC used to own this too — now it's R&D's job (PPIC requests what's
    // missing, R&D delivers it — see recipe-request.routes.ts).
    const { token: ppicToken } = await createUser(["PPIC"]);
    const stillDenied = await request(app).post("/api/rm-costing/recipes/import").set(authHeader(ppicToken)).send(RECIPE_IMPORT_BODY);
    expect(stillDenied.status).toBe(403);

    const { token: rndToken } = await createUser(["RND"]);
    const allowed = await request(app).post("/api/rm-costing/recipes/import").set(authHeader(rndToken)).send(RECIPE_IMPORT_BODY);
    expect(allowed.status).toBe(201);
    expect(allowed.body.recipesUpserted).toBe(1);
  });
});

describe("full RM plan lifecycle", () => {
  it("create plan -> queue batch -> calculate -> export", async () => {
    const { token: rndToken } = await createUser(["RND"]);
    await request(app).post("/api/rm-costing/recipes/import").set(authHeader(rndToken)).send(RECIPE_IMPORT_BODY);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const recipes = await request(app).get("/api/rm-costing/recipes").set(authHeader(ppicToken));
    const recipeId = recipes.body[0].id;

    const { token: bearerToken } = await createUser([]);
    const plan = await request(app).post("/api/rm-costing/plans").set(authHeader(bearerToken)).send({ name: "Integration RM Plan" });
    expect(plan.status).toBe(201);
    const planId = plan.body.id;

    // The costing profile endpoint is gone: the system does no costing.
    const gone = await request(app).patch(`/api/rm-costing/plans/${planId}/costing`).set(authHeader(rndToken)).send({ costingParams: { profitPct: 10 } });
    expect(gone.status).toBe(404);

    const addItem = await request(app).post(`/api/rm-costing/plans/${planId}/items`).set(authHeader(bearerToken)).send({ recipeId, batchSizeKg: 100 });
    expect(addItem.status).toBe(201);
    const itemId = addItem.body.items[0].id;

    const calc = await request(app).post(`/api/rm-costing/plans/${planId}/calculate`).set(authHeader(bearerToken));
    expect(calc.status).toBe(200);
    expect(calc.body.result.batches).toHaveLength(1);
    expect(calc.body.result.batches[0]).not.toHaveProperty("pricePerPouch");
    expect(calc.body.result.procurement.length).toBeGreaterThan(0);

    const xlsx = await request(app).get(`/api/rm-costing/plans/${planId}/export.xlsx`).set(authHeader(bearerToken));
    expect(xlsx.status).toBe(200);

    const pdf = await request(app).get(`/api/rm-costing/plans/${planId}/export.pdf`).set(authHeader(bearerToken));
    expect(pdf.status).toBe(200);

    const bmr = await request(app).get(`/api/rm-costing/plans/${planId}/items/${itemId}/dispensing.pdf`).set(authHeader(bearerToken));
    expect(bmr.status).toBe(200);
    expect(bmr.headers["content-type"]).toBe("application/pdf");

    // GET should carry the same snapshot the calculate response did, so
    // reopening the plan doesn't need a fresh Calculate click to show numbers.
    const reGet = await request(app).get(`/api/rm-costing/plans/${planId}`).set(authHeader(bearerToken));
    expect(reGet.body.result.batches).toHaveLength(1);
  });

  it("invalidates a calculated result — and blocks export again — after removing the batch that was queued when it was calculated", async () => {
    const { token: rndToken } = await createUser(["RND"]);
    await request(app).post("/api/rm-costing/recipes/import").set(authHeader(rndToken)).send(RECIPE_IMPORT_BODY);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const recipeId = (await request(app).get("/api/rm-costing/recipes").set(authHeader(ppicToken))).body[0].id;

    const { token } = await createUser([]);
    const plan = await request(app).post("/api/rm-costing/plans").set(authHeader(token)).send({ name: "RM Invalidation Test Plan" });
    const planId = plan.body.id;
    const addItem = await request(app).post(`/api/rm-costing/plans/${planId}/items`).set(authHeader(token)).send({ recipeId, batchSizeKg: 50 });
    const itemId = addItem.body.items[0].id;

    const calc = await request(app).post(`/api/rm-costing/plans/${planId}/calculate`).set(authHeader(token));
    expect(calc.body.plan.status).toBe("CALCULATED");

    const removeItem = await request(app).delete(`/api/rm-costing/plans/${planId}/items/${itemId}`).set(authHeader(token));
    expect(removeItem.status).toBe(200);
    expect(removeItem.body.status).toBe("DRAFT");
    expect(removeItem.body.result).toBeNull(); // not the stale snapshot from before the batch was removed

    const reGet = await request(app).get(`/api/rm-costing/plans/${planId}`).set(authHeader(token));
    expect(reGet.body.result).toBeNull();

    const xlsx = await request(app).get(`/api/rm-costing/plans/${planId}/export.xlsx`).set(authHeader(token));
    expect(xlsx.status).toBe(400); // must require a fresh Calculate, not silently export the stale numbers
  });
});
