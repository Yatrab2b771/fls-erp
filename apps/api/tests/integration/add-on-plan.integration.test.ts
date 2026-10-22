import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

/**
 * Add on Plan: BD gets a call "can we get this product urgently?"; PPIC picks the product, types the quantity and sees the RM and PM it
 * needs against live stock. Worked out fresh for the quantity (same engines and Kg <-> packs conversion as a PO line); nothing is saved.
 */
async function setup() {
  const ppic = await createUser(["PPIC"]);
  const bd = await createUser(["BD"]);
  const stamp = Date.now();
  const customer = (await request(app).post("/api/customers").set(authHeader(bd.token)).send({ companyName: `AO Customer ${stamp}` })).body as { id: string };

  const whey = await prisma.inventoryItem.create({ data: { category: "RM", name: `AO Whey ${stamp}`, unit: "Kg" } });
  const jar = await prisma.inventoryItem.create({ data: { category: "PM", name: `AO Jar ${stamp}`, unit: "Nos" } });
  const stock = async (itemId: string, unit: string, quantity: number) => {
    await prisma.inventoryTransaction.create({ data: { itemId, createdById: ppic.user.id, date: new Date(), unit, type: "RECEIVED", quantity, vendorName: "V", receiptStatus: "ACCEPTED", acceptedById: ppic.user.id, acceptedAt: new Date() } });
  };
  await stock(whey.id, "Kg", 30);
  await stock(jar.id, "Nos", 400);

  // AO Powder: both a packaging BOM (1 kg pack, a Jar linked to the Warehouse item + a Leaflet that is not) and an RM formulation (20 g whey + 10 g of an item not in the catalog per 30 g serving)
  const name = `AO Powder ${stamp}`;
  await prisma.sku.create({
    data: {
      customerId: customer.id,
      productName: name,
      packSize: "1 kg",
      packagingComponents: {
        create: [
          { type: "Jar", quantity: 1, unit: "Nos", pmItemId: jar.id, packingLevel: "Primary", overagePct: 0.02 },
          { type: "Leaflet", quantity: 1, unit: "Nos", packingLevel: "Secondary", overagePct: 0 },
        ],
      },
    },
  });
  await prisma.recipe.create({
    data: {
      customerId: customer.id,
      name,
      totalServing: 30,
      ingredients: {
        create: [
          { name: whey.name, brand: "BrandW", gPerServing: 20, costPerKg: 0, sortOrder: 1 },
          { name: `AO Mystery ${stamp}`, brand: "BrandM", gPerServing: 10, costPerKg: 0, sortOrder: 2 },
        ],
      },
    },
  });
  const calc = (body: object, token = ppic.token) => request(app).post("/api/add-on-plan/calculate").set(authHeader(token)).send({ customerId: customer.id, name, ...body });
  return { ppic: ppic.token, bd: bd.token, customer, name, stamp, whey, calc };
}

type Line = { name: string; requiredQty: number; onHand: number | null; short: boolean; shortfallQty: number; group?: string; detail?: string };

describe("Add on Plan: any product, any quantity", () => {
  it("lists the products, and is for PPIC only", async () => {
    const s = await setup();
    const list = (await request(app).get("/api/add-on-plan/products").set(authHeader(s.ppic))).body as { key: string; name: string; customerName: string; hasPm: boolean; hasRm: boolean }[];
    expect(list.find((p) => p.name === s.name)).toMatchObject({ hasPm: true, hasRm: true, customerName: `AO Customer ${s.stamp}` });
    // A product with only a Packaging BOM (no RM formulation) is not offered
    const only = `AO Only PM List ${s.stamp}`;
    await prisma.sku.create({ data: { customerId: s.customer.id, productName: only, packSize: "1 kg", packagingComponents: { create: [{ type: "Jar", quantity: 1, unit: "Nos" }] } } });
    const again = (await request(app).get("/api/add-on-plan/products").set(authHeader(s.ppic))).body as { name: string }[];
    expect(again.map((p) => p.name)).not.toContain(only);
    expect(list.every((p) => p.hasPm && p.hasRm)).toBe(true);
    expect((await request(app).get("/api/add-on-plan/products").set(authHeader(s.bd))).status).toBe(403);
    expect((await s.calc({ quantity: 10, unit: "KG" }, s.bd)).status).toBe(403);
  });

  it("works the RM and PM out for a Kg quantity, against stock", async () => {
    const s = await setup();
    const res = await s.calc({ quantity: 100, unit: "KG" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kg: 100, packs: 100, quantity: 100, unit: "KG" });
    expect(res.body.note).toMatch(/100 packs/);

    // RM: 100 Kg x 20 g / 30 g = 66.67 Kg of whey, 30 in stock; the second ingredient is not a catalog item
    const rm = res.body.rm.lines as Line[];
    expect(res.body.rm.available).toBe(true);
    expect(rm.find((l) => l.name === s.whey.name)).toMatchObject({ requiredQty: 66.67, onHand: 30, short: true, shortfallQty: 36.67, detail: "BrandW" });
    expect(rm.find((l) => l.name.startsWith("AO Mystery"))).toMatchObject({ onHand: null, short: false });

    // PM: 100 packs, the Jar with 2% buffer = 102 (400 in stock), the Leaflet is not a catalog item
    const pm = res.body.pm.lines as Line[];
    expect(pm.find((l) => l.name === `AO Jar ${s.stamp}`)).toMatchObject({ requiredQty: 102, onHand: 400, short: false, group: "Primary" });
    expect(pm.find((l) => l.name === "Leaflet")).toMatchObject({ requiredQty: 100, onHand: null, group: "Secondary" });
    expect(res.body.summary).toEqual({ total: 4, short: 1, notInCatalog: 2 });
  });

  it("takes packs too: 50 packs of 1 kg = 50 Kg and 50 packs", async () => {
    const s = await setup();
    const res = await s.calc({ quantity: 50, unit: "PACKS" });
    expect(res.body).toMatchObject({ kg: 50, packs: 50 });
    expect((res.body.rm.lines as Line[]).find((l) => l.name === s.whey.name)).toMatchObject({ requiredQty: 33.33, short: true, shortfallQty: 3.33 });
    expect((res.body.pm.lines as Line[]).find((l) => l.name === `AO Jar ${s.stamp}`)?.requiredQty).toBe(51);
  });

  it("says which side cannot be worked out and why, and checks the input", async () => {
    const s = await setup();
    // A product with only a Packaging BOM and no pack size: RM side missing, and Kg cannot become packs
    const only = `AO Only PM ${s.stamp}`;
    await prisma.sku.create({ data: { customerId: s.customer.id, productName: only, packagingComponents: { create: [{ type: "Jar", quantity: 1, unit: "Nos" }] } } });
    const res = await request(app).post("/api/add-on-plan/calculate").set(authHeader(s.ppic)).send({ customerId: s.customer.id, name: only, quantity: 10, unit: "KG" });
    expect(res.status).toBe(200);
    expect(res.body.rm).toMatchObject({ available: false, lines: [] });
    expect(res.body.rm.problem).toMatch(/no RM formulation/i);
    expect(res.body.pm).toMatchObject({ available: false });
    expect(res.body.pm.problem).toMatch(/pack size/i);

    expect((await s.calc({ quantity: 0, unit: "KG" })).status).toBe(400);
    expect((await s.calc({ quantity: 5, unit: "TONS" })).status).toBe(400);
    expect((await request(app).post("/api/add-on-plan/calculate").set(authHeader(s.ppic)).send({ customerId: "00000000-0000-4000-8000-000000000000", name: s.name, quantity: 5, unit: "KG" })).status).toBe(404);
  });
});
