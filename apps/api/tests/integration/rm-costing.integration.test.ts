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
        { name: "PEA PROTEIN EXTRACT", brand: "YANTAI CO", costPerKg: 360, gPerServing: 7.0, proteinPct: 0.8 },
        { name: "SUCRALOSE PURE POWDER", brand: "TECHNO", costPerKg: 1400, gPerServing: 0.12, proteinPct: 0 },
      ],
    },
  ],
};

describe("POST /api/rm-costing/recipes/import", () => {
  it("is restricted to PPIC", async () => {
    const { token: plainToken } = await createUser([]);
    const denied = await request(app).post("/api/rm-costing/recipes/import").set(authHeader(plainToken)).send(RECIPE_IMPORT_BODY);
    expect(denied.status).toBe(403);

    const { token: ppicToken } = await createUser(["PPIC"]);
    const allowed = await request(app).post("/api/rm-costing/recipes/import").set(authHeader(ppicToken)).send(RECIPE_IMPORT_BODY);
    expect(allowed.status).toBe(201);
    expect(allowed.body.recipesUpserted).toBe(1);
  });
});

describe("full RM plan lifecycle", () => {
  it("create plan -> queue batch -> update costing -> calculate -> export", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    await request(app).post("/api/rm-costing/recipes/import").set(authHeader(ppicToken)).send(RECIPE_IMPORT_BODY);
    const recipes = await request(app).get("/api/rm-costing/recipes").set(authHeader(ppicToken));
    const recipeId = recipes.body[0].id;

    const { token: bearerToken } = await createUser([]);
    const plan = await request(app).post("/api/rm-costing/plans").set(authHeader(bearerToken)).send({ name: "Integration RM Plan" });
    expect(plan.status).toBe(201);
    const planId = plan.body.id;

    const patchCosting = await request(app)
      .patch(`/api/rm-costing/plans/${planId}/costing`)
      .set(authHeader(bearerToken))
      .send({ costingParams: { mfgLossPct: 3, packSizeG: 400, testCost: 2000, jarCost: 25, scoopCost: 8, labelCost: 23, convCost: 25, ccbCost: 8, profitPct: 10, gstPct: 0 } });
    expect(patchCosting.status).toBe(200);

    const addItem = await request(app).post(`/api/rm-costing/plans/${planId}/items`).set(authHeader(bearerToken)).send({ recipeId, batchSizeKg: 100 });
    expect(addItem.status).toBe(201);
    const itemId = addItem.body.items[0].id;

    const calc = await request(app).post(`/api/rm-costing/plans/${planId}/calculate`).set(authHeader(bearerToken));
    expect(calc.status).toBe(200);
    expect(calc.body.result.batches).toHaveLength(1);
    expect(calc.body.result.batches[0].pricePerPouch).toBeGreaterThan(0);

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

  it("PPIC can send a calculated plan's procurement rollup straight into Pre-Inventory as RM requirements", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    await request(app).post("/api/rm-costing/recipes/import").set(authHeader(ppicToken)).send(RECIPE_IMPORT_BODY);
    const recipeId = (await request(app).get("/api/rm-costing/recipes").set(authHeader(ppicToken))).body[0].id;

    const plan = await request(app).post("/api/rm-costing/plans").set(authHeader(ppicToken)).send({ name: "Send Test RM Plan" });
    const planId = plan.body.id;

    const tooEarly = await request(app).post(`/api/rm-costing/plans/${planId}/send-to-pre-inventory`).set(authHeader(ppicToken));
    expect(tooEarly.status).toBe(400); // not calculated yet

    await request(app).post(`/api/rm-costing/plans/${planId}/items`).set(authHeader(ppicToken)).send({ recipeId, batchSizeKg: 100 });
    const calc = await request(app).post(`/api/rm-costing/plans/${planId}/calculate`).set(authHeader(ppicToken));
    const procurementCount = calc.body.result.procurement.length;
    expect(procurementCount).toBe(2); // the two ingredients in RECIPE_IMPORT_BODY

    const { token: plainToken } = await createUser([]);
    const denied = await request(app).post(`/api/rm-costing/plans/${planId}/send-to-pre-inventory`).set(authHeader(plainToken));
    expect(denied.status).toBe(403);

    const sent = await request(app).post(`/api/rm-costing/plans/${planId}/send-to-pre-inventory`).set(authHeader(ppicToken));
    expect(sent.status).toBe(201);
    expect(sent.body.requirementsCreated).toBe(procurementCount);

    const requirements = await request(app).get("/api/inventory/requirements").set(authHeader(ppicToken));
    expect(requirements.body.length).toBe(procurementCount);
    expect(requirements.body.every((r: { category: string; unit: string; note: string }) => r.category === "RM" && r.unit === "Kg" && r.note?.includes("Send Test RM Plan"))).toBe(true);
  });

  it("invalidates a calculated result — and blocks export again — after removing the batch that was queued when it was calculated", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    await request(app).post("/api/rm-costing/recipes/import").set(authHeader(ppicToken)).send(RECIPE_IMPORT_BODY);
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
