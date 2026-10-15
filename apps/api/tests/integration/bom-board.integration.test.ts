import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("R&D BOM tile: is the RM BOM and the Packaging BOM ready for each PO product?", () => {
  it("shows ready / missing / common-only / old-spec per product, and the pack size gap", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token: rnd } = await createUser(["RND"]);
    const { token: store } = await createUser(["STORE"]);
    const customer = (await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: `BB Customer ${Date.now()}` })).body;
    const t = Date.now();
    const names = { ready: `BB Ready ${t}`, bare: `BB Bare ${t}`, common: `BB Common ${t}`, old: `BB Old ${t}`, litres: `BB Litres ${t}` };

    // Ready: recipe for this customer + packaging BOM + pack size
    const readySku = (await request(app).post("/api/catalog/skus").set(authHeader(rnd)).send({ customerId: customer.id, productName: names.ready })).body;
    await request(app).put(`/api/catalog/skus/${readySku.id}/packaging-components`).set(authHeader(rnd)).send({ header: { packSize: "120 g" }, components: [{ type: "Jar", quantity: 1, unit: "Nos" }] });
    await request(app).post("/api/rm-costing/recipes/import").set(authHeader(rnd)).send({ recipes: [{ name: names.ready, customerId: customer.id, ingredients: [{ name: "BB P", brand: "X", gPerServing: 1, proteinPct: 0 }] }] });
    // Common only: an old recipe with no customer
    await request(app).post("/api/rm-costing/recipes/import").set(authHeader(rnd)).send({ recipes: [{ name: names.common, ingredients: [{ name: "BB P", brand: "X", gPerServing: 1, proteinPct: 0 }] }] });
    // Old spec only: a SKU with the old flat fields and no components
    await request(app).post("/api/catalog/import").set(authHeader(rnd)).send({ customers: [{ customerName: customer.companyName, skus: [{ productName: names.old, jar: "1kg HDPE Jar" }] }] });

    const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({
      customerId: customer.id,
      poNumber: `BB-PO-${t}`,
      items: [
        { productName: names.ready, productCategory: "Powder", quantity: 100, unit: "KG" },
        { productName: names.bare, productCategory: "Powder", quantity: 50, unit: "SKU", packSize: "1 kg" },
        { productName: names.common, productCategory: "Powder", quantity: 20, unit: "KG" },
        { productName: names.old, productCategory: "Powder", quantity: 20, unit: "KG" },
        { productName: names.litres, productCategory: "Liquid", quantity: 20, unit: "Litres" },
      ],
    });
    const board = async () => (await request(app).get("/api/bom-board").set(authHeader(rnd))).body as { productName: string; rm: string; pm: string; packSizeKnown: boolean; needsWork: boolean; rmVersion: number | null; pmVersion: number | null }[];

    // A Draft PO is not on the board yet; once BD approves it, its products are
    expect((await board()).some((r) => r.productName === names.ready)).toBe(false);
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bd)).send({ status: "APPROVED" });
    const rows = await board();
    const of = (n: string) => rows.find((r) => r.productName === n)!;
    expect(of(names.ready)).toMatchObject({ rm: "READY", pm: "READY", packSizeKnown: true, needsWork: false, rmVersion: 1, pmVersion: 1 });
    expect(of(names.bare)).toMatchObject({ rm: "MISSING", pm: "MISSING", packSizeKnown: true, needsWork: true });
    expect(of(names.common)).toMatchObject({ rm: "COMMON", pm: "MISSING", packSizeKnown: false, needsWork: true });
    expect(of(names.old)).toMatchObject({ rm: "MISSING", pm: "OLD_SPEC", needsWork: true });
    expect(of(names.litres)).toMatchObject({ rm: "NOT_APPLICABLE" });

    // R&D and PPIC only
    expect((await request(app).get("/api/bom-board").set(authHeader(store))).status).toBe(403);
  });
});
