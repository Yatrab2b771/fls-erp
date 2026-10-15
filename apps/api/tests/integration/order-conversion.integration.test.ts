import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser, ensurePlant } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("Kg and SKU orders are both worked out: packs for the packaging BOM, Kg for the RM BOM", () => {
  it("turns a SKU order into Kg with the pack size, a Kg order into packs, and says what is missing", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token: rnd } = await createUser(["RND"]);
    const { token: ppic } = await createUser(["PPIC"]);
    const customer = (await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: `CV Customer ${Date.now()}` })).body;
    const product = `CV Powder ${Date.now()}`;

    // R&D: packaging BOM (pack 120 g, jar 1 per pack, label 1 per pack, no overage) and the recipe (per Kg)
    const sku = (await request(app).post("/api/catalog/skus").set(authHeader(rnd)).send({ customerId: customer.id, productName: product })).body;
    await request(app).put(`/api/catalog/skus/${sku.id}/packaging-components`).set(authHeader(rnd)).send({ header: { packSize: "120 g", batchPacks: 1000 }, components: [{ type: "Jar", quantity: 1, unit: "Nos", overagePct: 0 }] });
    await request(app).post("/api/rm-costing/recipes/import").set(authHeader(rnd)).send({ recipes: [{ name: product, customerId: customer.id, ingredients: [{ name: "CV Protein", brand: "X", gPerServing: 1, proteinPct: 0 }] }] });

    const order = async (poNumber: string, quantity: number, unit: string, packSize?: string) => {
      const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: customer.id, poNumber, items: [{ productName: product, productCategory: "Powder", quantity, unit, ...(packSize ? { packSize } : {}) }] });
      await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bd)).send({ status: "APPROVED" });
      const itemId = po.body.items[0].id as string;
      await ensurePlant(itemId);
      return { poId: po.body.id as string, itemId };
    };
    const generate = async (itemId: string) => {
      const bom = await request(app).post("/api/bom/plans").set(authHeader(ppic)).send({ name: "CV BOM", purchaseOrderItemId: itemId });
      const rm = await request(app).post("/api/rm-costing/plans").set(authHeader(ppic)).send({ name: "CV RM", purchaseOrderItemId: itemId });
      return { bom: bom.body, rm: rm.body };
    };

    // 600 SKU of a 120 g pack: 600 packs of packaging, 72 Kg of RM
    const a = await order(`CV-A-${Date.now()}`, 600, "SKU");
    expect((await request(app).get(`/api/purchase-orders/${a.poId}/items/${a.itemId}/conversion`).set(authHeader(ppic))).body).toMatchObject({ packs: 600, kg: 72, note: "600 SKU x 120 g = 72 Kg", packSizeSource: "Packaging BOM" });
    const ga = await generate(a.itemId);
    expect(ga.bom.status).toBe("CALCULATED");
    expect(ga.bom.items[0].targetYield).toBe(600);
    expect(ga.rm.status).toBe("CALCULATED");
    expect(ga.rm.items[0].batchSizeKg).toBeCloseTo(72, 6);

    // 100 Kg of the same pack: 100 Kg of RM, 833 packs of packaging
    const b = await order(`CV-B-${Date.now()}`, 100, "KG");
    const gb = await generate(b.itemId);
    expect(gb.rm.items[0].batchSizeKg).toBe(100);
    expect(gb.bom.items[0].targetYield).toBe(833);

    // The pack size on the PO line wins: 100 Kg in 1 kg packs = 100 packs
    const c = await order(`CV-C-${Date.now()}`, 100, "KG", "1 kg");
    expect((await generate(c.itemId)).bom.items[0].targetYield).toBe(100);

    // No pack size anywhere (another product): the SKU order is not guessed; it says what to fill
    const product2 = `CV Bare ${Date.now()}`;
    const sku2 = (await request(app).post("/api/catalog/skus").set(authHeader(rnd)).send({ customerId: customer.id, productName: product2 })).body;
    await request(app).put(`/api/catalog/skus/${sku2.id}/packaging-components`).set(authHeader(rnd)).send({ components: [{ type: "Jar", quantity: 1, unit: "Nos" }] });
    await request(app).post("/api/rm-costing/recipes/import").set(authHeader(rnd)).send({ recipes: [{ name: product2, customerId: customer.id, ingredients: [{ name: "CV Protein", brand: "X", gPerServing: 1, proteinPct: 0 }] }] });
    const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: customer.id, poNumber: `CV-D-${Date.now()}`, items: [{ productName: product2, productCategory: "Powder", quantity: 50, unit: "SKU" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bd)).send({ status: "APPROVED" });
    await ensurePlant(po.body.items[0].id);
    const rmPlan = await request(app).post("/api/rm-costing/plans").set(authHeader(ppic)).send({ name: "CV RM2", purchaseOrderItemId: po.body.items[0].id });
    expect(rmPlan.body.status).toBe("DRAFT");
    expect(rmPlan.body.conversionProblem).toMatch(/Pack size is missing/);
    expect(await prisma.rmPlanItem.count({ where: { planId: rmPlan.body.id } })).toBe(0);
  });
});
