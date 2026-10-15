import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser, ensurePlant } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("RM BOM is matched by customer + product name", () => {
  it("never borrows a common recipe or another customer's recipe; R&D gets the request and decides", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token: rnd } = await createUser(["RND"]);
    const { token: ppic } = await createUser(["PPIC"]);
    const product = `PC Whey ${Date.now()}`;
    const ingredient = (g: number) => [{ name: "PC Protein", brand: "X", gPerServing: g, proteinPct: 0 }];
    const importRecipe = (body: Record<string, unknown>) => request(app).post("/api/rm-costing/recipes/import").set(authHeader(rnd)).send({ recipes: [{ name: product, ingredients: ingredient(1), ...body }] });

    const a = (await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: `PC Customer A ${Date.now()}` })).body;
    const b = (await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: `PC Customer B ${Date.now()}` })).body;

    // An old common recipe exists (no customer) and customer B has its own recipe
    expect((await importRecipe({})).status).toBe(201);
    expect((await importRecipe({ customerId: b.id, ingredients: ingredient(2) })).status).toBe(201);
    expect(await prisma.recipe.count({ where: { name: product } })).toBe(2);

    // Customer A orders the product: Generate finds nothing for A (the common recipe and B's are not A's)
    const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: a.id, poNumber: `PO-PC-${Date.now()}`, items: [{ productName: product, productCategory: "Powder", quantity: 100, unit: "Kg" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bd)).send({ status: "APPROVED" });
    const itemId = po.body.items[0].id as string;
    await ensurePlant(itemId);
    const plan = await request(app).post("/api/rm-costing/plans").set(authHeader(ppic)).send({ name: "PC RM", purchaseOrderItemId: itemId });
    expect(plan.body.status).toBe("DRAFT");
    expect(plan.body.suggestedRecipes ?? []).toEqual([]); // not even offered as a "did you mean"
    const list = await request(app).get("/api/recipe-requests").set(authHeader(rnd));
    expect(list.body.find((r: { productName: string }) => r.productName === product)).toMatchObject({ rmNeeded: true, status: "PENDING" });

    // R&D decides: saves A's own recipe -> A's waiting plan calculates from A's recipe only
    expect((await importRecipe({ customerId: a.id, ingredients: ingredient(3) })).status).toBe(201);
    const after = await prisma.rmPlan.findUniqueOrThrow({ where: { id: plan.body.id }, include: { items: { include: { recipe: true } } } });
    expect(after.status).toBe("CALCULATED");
    expect(after.items[0]!.recipe.customerId).toBe(a.id);
    expect(await prisma.recipe.count({ where: { name: product } })).toBe(3);
    // The RM side of the request is fulfilled (the packaging side is still waiting on R&D, so it is not READY yet)
    const request2 = (await request(app).get("/api/recipe-requests").set(authHeader(rnd))).body.find((r: { productName: string }) => r.productName === product);
    expect(request2.rmFulfilledAt).toBeTruthy();
    expect(request2.status).toBe("PENDING");
  });
});
