import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("R&D's customer-wise BOM with Warehouse item links", () => {
  it("R&D adds a customer, a product and a BOM linked to Warehouse items; the plan uses the Warehouse item name; PPIC can view but not edit", async () => {
    const { token: rnd } = await createUser(["RND"]);
    const { token: ppic } = await createUser(["PPIC"]);
    const { token: store } = await createUser(["STORE"]);
    const pm = await request(app).post("/api/inventory/items").set(authHeader(store)).send({ category: "PM", name: "BL Jar 500ml Amber", unit: "Nos" });
    const rm = await request(app).post("/api/inventory/items").set(authHeader(store)).send({ category: "RM", name: "BL Flour", unit: "Kg" });

    // New customer + product, by R&D
    const customer = await request(app).post("/api/customers").set(authHeader(rnd)).send({ companyName: "BL Brand" });
    expect(customer.status).toBe(201);
    const sku = await request(app).post("/api/catalog/skus").set(authHeader(rnd)).send({ customerId: customer.body.id, productName: "BL Protein" });
    expect(sku.status).toBe(201);

    const put = (token: string, components: unknown[]) => request(app).put(`/api/catalog/skus/${sku.body.id}/packaging-components`).set(authHeader(token)).send({ components });
    expect((await put(ppic, [{ type: "Jar", quantity: 1, unit: "Nos" }])).status).toBe(403);
    // Only a PM item can be linked
    expect((await put(rnd, [{ type: "Jar", quantity: 1, unit: "Nos", pmItemId: rm.body.id }])).status).toBe(400);

    const saved = await put(rnd, [
      { type: "Jar", quantity: 1, unit: "Nos", pmItemId: pm.body.id },
      { type: "Leaflet", quantity: 1, unit: "Nos" },
    ]);
    expect(saved.status).toBe(200);
    const jar = saved.body.packagingComponents.find((c: { type: string }) => c.type === "Jar");
    expect(jar).toMatchObject({ pmItemId: pm.body.id, itemName: "BL Jar 500ml Amber" });
    expect(saved.body.packagingComponents.find((c: { type: string }) => c.type === "Leaflet").pmItemId).toBeNull();

    // PPIC reads the same BOM
    const list = await request(app).get(`/api/catalog/skus?customerId=${customer.body.id}`).set(authHeader(ppic));
    expect(list.body[0].packagingComponents).toHaveLength(2);

    // The plan's line carries the Warehouse item name
    const plan = await request(app).post("/api/bom/plans").set(authHeader(rnd)).send({ name: "BL Plan" });
    await request(app).post(`/api/bom/plans/${plan.body.id}/items`).set(authHeader(rnd)).send({ skuId: sku.body.id, targetYield: 100 });
    const calc = await request(app).post(`/api/bom/plans/${plan.body.id}/calculate`).set(authHeader(rnd));
    expect(calc.status).toBe(200);
    const lines = calc.body.result.lines as { component: string; itemName?: string; totalQty: number }[];
    expect(lines.find((l) => l.component === "Jar")?.itemName).toBe("BL Jar 500ml Amber");
    expect(lines.find((l) => l.component === "Leaflet")?.itemName).toBeUndefined();
  });
});
