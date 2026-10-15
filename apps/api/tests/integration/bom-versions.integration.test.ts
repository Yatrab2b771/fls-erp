import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("BOM templates: per-row overage, header fields, versions and PO products", () => {
  it("keeps every save as a version, restores an old one, uses the row's own overage, and lists PO products for R&D", async () => {
    const { token: rnd } = await createUser(["RND"]);
    const { token: ppic } = await createUser(["PPIC"]);
    const { token: bd, user: bdUser } = await createUser(["BD"]);
    const customer = await request(app).post("/api/customers").set(authHeader(rnd)).send({ companyName: `VER Brand ${Date.now()}` });
    const sku = await request(app).post("/api/catalog/skus").set(authHeader(rnd)).send({ customerId: customer.body.id, productName: "VER BCAA 120 g" });
    const put = (components: unknown[], extra: Record<string, unknown> = {}) => request(app).put(`/api/catalog/skus/${sku.body.id}/packaging-components`).set(authHeader(rnd)).send({ components, ...extra });

    // v1: header + a sticker with its own 5% overage, a jar with none
    const v1 = await put(
      [
        { type: "Jar", quantity: 1, unit: "Nos", overagePct: 0 },
        { type: "Cap sticker", quantity: 1, unit: "Nos", overagePct: 0.05, spec: "20mm", make: "Acme", packingLevel: "Secondary" },
      ],
      { header: { packSize: "120 g", packingConfig: "1*64 Jars", batchPacks: 1000 }, note: "first" },
    );
    expect(v1.status).toBe(200);
    expect(v1.body).toMatchObject({ packSize: "120 g", packingConfig: "1*64 Jars", batchPacks: 1000 });
    expect(v1.body.packagingComponents.find((c: { type: string }) => c.type === "Cap sticker")).toMatchObject({ overagePct: 0.05, spec: "20mm", make: "Acme", packingLevel: "Secondary" });

    // The plan engine uses each row's own overage, not a fixed 2%
    const plan = await request(app).post("/api/bom/plans").set(authHeader(rnd)).send({ name: "VER plan" });
    await request(app).post(`/api/bom/plans/${plan.body.id}/items`).set(authHeader(rnd)).send({ skuId: sku.body.id, targetYield: 1000 });
    const calc = await request(app).post(`/api/bom/plans/${plan.body.id}/calculate`).set(authHeader(rnd));
    const lines = calc.body.result.lines as { component: string; baseQty: number; bufferQty: number; totalQty: number }[];
    expect(lines.find((l) => l.component === "Jar")).toMatchObject({ baseQty: 1000, bufferQty: 0, totalQty: 1000 });
    expect(lines.find((l) => l.component === "Cap sticker")).toMatchObject({ baseQty: 1000, bufferQty: 50, totalQty: 1050 });

    // v2: changed; both versions are kept, the newest is Active
    const v2 = await put([{ type: "Jar", quantity: 2, unit: "Nos", overagePct: 0 }], { note: "two jars" });
    expect(v2.status).toBe(200);
    const list = await request(app).get(`/api/bom-versions/PM/${sku.body.id}`).set(authHeader(ppic));
    expect(list.body.map((v: { version: number; active: boolean }) => [v.version, v.active])).toEqual([[2, true], [1, false]]);
    const old = await request(app).get(`/api/bom-versions/PM/${sku.body.id}/1`).set(authHeader(ppic));
    expect(old.body.snapshot.components).toHaveLength(2);

    // Only R&D can restore; restoring v1 makes v3 and changes the live BOM
    expect((await request(app).post(`/api/bom-versions/PM/${sku.body.id}/1/restore`).set(authHeader(ppic))).status).toBe(403);
    const restored = await request(app).post(`/api/bom-versions/PM/${sku.body.id}/1/restore`).set(authHeader(rnd));
    expect(restored.body.version).toBe(3);
    const now = await request(app).get(`/api/catalog/skus?customerId=${customer.body.id}`).set(authHeader(ppic));
    expect(now.body[0].packagingComponents).toHaveLength(2);
    expect((await request(app).get(`/api/bom-versions/PM/${sku.body.id}`).set(authHeader(rnd))).body[0]).toMatchObject({ version: 3, note: "Restored from v1" });

    // RM: kind and header are kept, each import is a version
    const name = `VER Gummy ${Date.now()}`;
    const cid = customer.body.id as string;
    const imp = (mg: number, note: string) => request(app).post("/api/rm-costing/recipes/import").set(authHeader(rnd)).send({ recipes: [{ name, customerId: cid, kind: "PER_UNIT", batchSize: 7500, avgUnitWeightMg: 3491.7, note, ingredients: [{ name: "Citric Acid", brand: "X", gPerServing: mg, proteinPct: 0, uom: "mg" }] }] });
    expect((await imp(32, "a")).status).toBe(201);
    expect((await imp(40, "b")).status).toBe(201);
    const recipe = await prisma.recipe.findFirstOrThrow({ where: { name, customerId: cid } });
    expect(recipe).toMatchObject({ kind: "PER_UNIT", batchSize: 7500 });
    expect((await request(app).get(`/api/bom-versions/RM/${recipe.id}`).set(authHeader(ppic))).body).toHaveLength(2);
    expect((await request(app).post(`/api/bom-versions/RM/${recipe.id}/1/restore`).set(authHeader(rnd))).status).toBe(200);
    expect((await prisma.recipeIngredient.findMany({ where: { recipeId: recipe.id } }))[0]!.gPerServing).toBe(32);

    // PO products: names only, R&D and PPIC, not BD
    const poCustomer = await prisma.customer.create({ data: { companyName: `VER PO Co ${Date.now()}`, createdById: bdUser.id } });
    const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: poCustomer.id, poNumber: `PO-VER-${Date.now()}`, items: [{ productName: "VER New Flavour", productCategory: "Powder", quantity: 100, unit: "KG" }] });
    expect(po.status).toBe(201);
    const names = await request(app).get("/api/catalog/po-products").set(authHeader(rnd));
    expect(names.status).toBe(200);
    expect(names.body.find((p: { productName: string }) => p.productName === "VER New Flavour")).toEqual({ customerId: poCustomer.id, customerName: poCustomer.companyName, productName: "VER New Flavour" });
    expect(JSON.stringify(names.body)).not.toContain("poNumber");
    expect((await request(app).get("/api/catalog/po-products").set(authHeader(bd))).status).toBe(403);
  });
});
