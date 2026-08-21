import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

const CATALOG_IMPORT_BODY = {
  brands: [
    {
      brand: "IntegrationBrand",
      skus: [
        {
          productName: "Test Whey 1kg",
          jar: "1kg HDPE Jar",
          wadMm: "83mm",
          scoopMl: "30ml",
          silicaGelGms: "2",
          silicaGelQtyNos: "1",
          authenticationSticker: "Yes",
          leaflet: "Yes",
          corrugatedBoxMm: "5-ply",
          packagingSizeNos: "12",
        },
      ],
    },
  ],
};

describe("POST /api/catalog/import", () => {
  it("is restricted to PPIC/PURCHASE", async () => {
    const { token: plainToken } = await createUser([]);
    const denied = await request(app).post("/api/catalog/import").set(authHeader(plainToken)).send(CATALOG_IMPORT_BODY);
    expect(denied.status).toBe(403);

    const { token: ppicToken } = await createUser(["PPIC"]);
    const allowed = await request(app).post("/api/catalog/import").set(authHeader(ppicToken)).send(CATALOG_IMPORT_BODY);
    expect(allowed.status).toBe(201);
    expect(allowed.body.brandsTouched).toBe(1);
    expect(allowed.body.skusUpserted).toBe(1);
  });
});

describe("full BOM plan lifecycle", () => {
  it("create plan -> queue SKU -> calculate -> export", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    await request(app).post("/api/catalog/import").set(authHeader(ppicToken)).send(CATALOG_IMPORT_BODY);
    const skus = await request(app).get("/api/catalog/skus").set(authHeader(ppicToken));
    const skuId = skus.body[0].id;

    const { token: bearerToken } = await createUser([]); // plan CRUD has no role restriction
    const plan = await request(app).post("/api/bom/plans").set(authHeader(bearerToken)).send({ name: "Integration Test Plan" });
    expect(plan.status).toBe(201);
    const planId = plan.body.id;

    const addItem = await request(app).post(`/api/bom/plans/${planId}/items`).set(authHeader(bearerToken)).send({ skuId, targetYield: 1000 });
    expect(addItem.status).toBe(201);
    expect(addItem.body.items).toHaveLength(1);

    const calc = await request(app).post(`/api/bom/plans/${planId}/calculate`).set(authHeader(bearerToken));
    expect(calc.status).toBe(200);
    expect(calc.body.result.lines.length).toBeGreaterThan(0);
    expect(calc.body.result.totalYield).toBe(1000);

    const xlsx = await request(app).get(`/api/bom/plans/${planId}/export.xlsx`).set(authHeader(bearerToken));
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml");

    const pdf = await request(app).get(`/api/bom/plans/${planId}/export.pdf`).set(authHeader(bearerToken));
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");

    // GET should carry the same snapshot the calculate response did, so
    // reopening the plan doesn't need a fresh Calculate click to show numbers.
    const reGet = await request(app).get(`/api/bom/plans/${planId}`).set(authHeader(bearerToken));
    expect(reGet.body.result.totalYield).toBe(1000);
  });

  it("PPIC can send a calculated plan straight into Pre-Inventory as PM requirements", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    await request(app).post("/api/catalog/import").set(authHeader(ppicToken)).send(CATALOG_IMPORT_BODY);
    const skuId = (await request(app).get("/api/catalog/skus").set(authHeader(ppicToken))).body[0].id;

    const plan = await request(app).post("/api/bom/plans").set(authHeader(ppicToken)).send({ name: "Send Test Plan" });
    const planId = plan.body.id;

    const tooEarly = await request(app).post(`/api/bom/plans/${planId}/send-to-pre-inventory`).set(authHeader(ppicToken));
    expect(tooEarly.status).toBe(400); // not calculated yet

    await request(app).post(`/api/bom/plans/${planId}/items`).set(authHeader(ppicToken)).send({ skuId, targetYield: 1000 });
    const calc = await request(app).post(`/api/bom/plans/${planId}/calculate`).set(authHeader(ppicToken));
    const lineCount = calc.body.result.lines.length;

    const { token: plainToken } = await createUser([]);
    const denied = await request(app).post(`/api/bom/plans/${planId}/send-to-pre-inventory`).set(authHeader(plainToken));
    expect(denied.status).toBe(403);

    const sent = await request(app).post(`/api/bom/plans/${planId}/send-to-pre-inventory`).set(authHeader(ppicToken));
    expect(sent.status).toBe(201);
    expect(sent.body.requirementsCreated).toBe(lineCount);

    const requirements = await request(app).get("/api/inventory/requirements").set(authHeader(ppicToken));
    expect(requirements.body.length).toBe(lineCount);
    expect(requirements.body.every((r: { category: string; note: string }) => r.category === "PM" && r.note?.includes("Send Test Plan"))).toBe(true);
  });

  it("rejects export before the plan has been calculated", async () => {
    const { token } = await createUser([]);
    const plan = await request(app).post("/api/bom/plans").set(authHeader(token)).send({ name: "Uncalculated Plan" });
    const xlsx = await request(app).get(`/api/bom/plans/${plan.body.id}/export.xlsx`).set(authHeader(token));
    expect(xlsx.status).toBe(400);
  });

  it("invalidates a calculated result — and blocks export again — after removing the item that was queued when it was calculated", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    await request(app).post("/api/catalog/import").set(authHeader(ppicToken)).send(CATALOG_IMPORT_BODY);
    const skuId = (await request(app).get("/api/catalog/skus").set(authHeader(ppicToken))).body[0].id;

    const { token } = await createUser([]);
    const plan = await request(app).post("/api/bom/plans").set(authHeader(token)).send({ name: "Invalidation Test Plan" });
    const planId = plan.body.id;
    const addItem = await request(app).post(`/api/bom/plans/${planId}/items`).set(authHeader(token)).send({ skuId, targetYield: 500 });
    const itemId = addItem.body.items[0].id;

    const calc = await request(app).post(`/api/bom/plans/${planId}/calculate`).set(authHeader(token));
    expect(calc.body.plan.status).toBe("CALCULATED");

    const removeItem = await request(app).delete(`/api/bom/plans/${planId}/items/${itemId}`).set(authHeader(token));
    expect(removeItem.status).toBe(200);
    expect(removeItem.body.status).toBe("DRAFT");
    expect(removeItem.body.result).toBeNull(); // not the stale snapshot from before the item was removed

    const reGet = await request(app).get(`/api/bom/plans/${planId}`).set(authHeader(token));
    expect(reGet.body.result).toBeNull();

    const xlsx = await request(app).get(`/api/bom/plans/${planId}/export.xlsx`).set(authHeader(token));
    expect(xlsx.status).toBe(400); // must require a fresh Calculate, not silently export the stale numbers
  });
});
