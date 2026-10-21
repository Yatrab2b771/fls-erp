import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("BOM versions: the Display BOM plus V1 and V2, three in all", () => {
  it("R&D keeps V1 and V2 next to the catalog's own BOM; nothing else may", async () => {
    const rnd = await createUser(["RND"]);
    const ppic = await createUser(["PPIC"]);
    const stamp = Date.now();
    const bd = await createUser(["BD"]);
    const customer = (await request(app).post("/api/customers").set(authHeader(bd.token)).send({ companyName: `BV Customer ${stamp}` })).body as { id: string };
    const product = `BV Powder ${stamp}`;
    await prisma.recipe.create({
      data: {
        name: product,
        customerId: customer.id,
        totalServing: 30,
        ingredients: { create: [{ name: "Whey", brand: "A", costPerKg: 0, gPerServing: 25, proteinPct: 0.8, sortOrder: 0 }, { name: "Cocoa", brand: "B", costPerKg: 0, gPerServing: 5, proteinPct: 0, sortOrder: 1 }] },
      },
    });
    const sku = await prisma.sku.create({ data: { customerId: customer.id, productName: product, jar: "1kg", packagingComponents: { create: [{ type: "Tub 1kg", quantity: 1, unit: "Nos" }, { type: "Front Label", quantity: 1, unit: "Nos", overagePct: 0.02 }] } } });
    expect(sku.id).toBeTruthy();
    const ref = { customerId: customer.id, productName: product };
    const call = (token: string, method: "get" | "put" | "post" | "delete", path: string, body?: object) => {
      const r = request(app)[method](path).set(authHeader(token));
      return body ? r.send(body) : r;
    };

    // The catalog lists the product, with its Display BOM and empty slots
    const list = (await call(rnd.token, "get", `/api/bom-slots/products?search=${encodeURIComponent(product)}`)).body;
    expect(list).toEqual([expect.objectContaining({ productName: product, hasRm: true, hasPm: true, slots: { V1: null, V2: null } })]);
    const empty = (await call(ppic.token, "get", `/api/bom-slots?customerId=${customer.id}&productName=${encodeURIComponent(product)}`)).body;
    expect(empty.display.rm.ingredients).toHaveLength(2);
    expect(empty.display.pm.components.map((c: { type: string }) => c.type).sort()).toEqual(["Front Label", "Tub 1kg"]);
    expect(empty.slots).toEqual({ V1: null, V2: null });

    // Only R&D saves; only V1 and V2 exist
    expect((await call(ppic.token, "post", "/api/bom-slots/V1/copy-from-display", ref)).status).toBe(403);
    expect((await call(rnd.token, "post", "/api/bom-slots/V3/copy-from-display", ref)).status).toBe(400);
    expect((await call(rnd.token, "put", "/api/bom-slots/DISPLAY", { ...ref, rm: { ingredients: [{ name: "x", brand: "y", gPerServing: 1 }] } })).status).toBe(400);

    // V1 starts as a copy of the Display BOM
    const copied = await call(rnd.token, "post", "/api/bom-slots/V1/copy-from-display", ref);
    expect(copied.status).toBe(200);
    expect(copied.body.slots.V1.rm.ingredients).toHaveLength(2);
    expect(copied.body.slots.V1.pm.components).toHaveLength(2);
    expect(copied.body.slots.V2).toBeNull();

    // ...then R&D swaps a material in V1 (the catalog is untouched)
    const edited = await call(rnd.token, "put", "/api/bom-slots/V1", { ...ref, rm: { ingredients: [{ name: "Whey Isolate", brand: "C", gPerServing: 25, proteinPct: 90 }, { name: "Cocoa", brand: "B", gPerServing: 5 }] }, note: "Whey short" });
    expect(edited.status).toBe(200);
    expect(edited.body.slots.V1).toMatchObject({ note: "Whey short" });
    expect(edited.body.slots.V1.rm.ingredients[0].name).toBe("Whey Isolate");
    expect(edited.body.slots.V1.pm.components).toHaveLength(2); // the PM half stayed as copied
    expect(edited.body.display.rm.ingredients[0].name).toBe("Whey");
    expect((await call(rnd.token, "put", "/api/bom-slots/V2", { ...ref, pm: { components: [{ type: "Tub", quantity: 1 }, { type: "tub", quantity: 2 }] } })).status).toBe(400); // a component twice
    expect((await call(rnd.token, "put", "/api/bom-slots/V2", { ...ref })).status).toBe(400); // nothing to save
    const v2 = await call(rnd.token, "put", "/api/bom-slots/V2", { ...ref, pm: { header: { packSize: "1 kg", batchPacks: 120 }, components: [{ type: "Jar 1kg", quantity: 1, unit: "Nos" }] } });
    expect(v2.status).toBe(200);
    expect(v2.body.slots.V2.rm).toBeNull();
    expect(v2.body.slots.V2.pm.header).toMatchObject({ packSize: "1 kg", batchPacks: 120 }); // the pack details are the version's own
    // The recipe header too: a version carries its own product code / trial no. / batch size
    const withHeader = await call(rnd.token, "put", "/api/bom-slots/V1", { ...ref, rm: { productCode: "BV-77", versionLabel: "Trial 4", batchSize: 100, ingredients: [{ name: "Whey Isolate", brand: "C", gPerServing: 25, proteinPct: 90 }, { name: "Cocoa", brand: "B", gPerServing: 5 }] } });
    expect(withHeader.body.slots.V1.rm).toMatchObject({ productCode: "BV-77", versionLabel: "Trial 4", batchSize: 100 });
    expect(withHeader.body.display.rm.productCode).not.toBe("BV-77"); // the catalog is untouched
    expect((await call(rnd.token, "get", `/api/bom-slots/products?search=${encodeURIComponent(product)}`)).body[0].slots).toMatchObject({ V1: { rm: true, pm: true }, V2: { rm: false, pm: true } });

    // What a version needs for a given quantity, worked out by the same engines the plans use
    const display = (await call(rnd.token, "post", "/api/bom-slots/preview", { ...ref, slot: "DISPLAY", kg: 100, packs: 100 })).body;
    const v1 = (await call(rnd.token, "post", "/api/bom-slots/preview", { ...ref, slot: "V1", kg: 100, packs: 100 })).body;
    expect(display.rm.procurement.map((l: { name: string }) => l.name).sort()).toEqual(["Cocoa", "Whey"]);
    expect(v1.rm.procurement.map((l: { name: string }) => l.name).sort()).toEqual(["Cocoa", "Whey Isolate"]);
    expect(display.rm.procurement.find((l: { name: string }) => l.name === "Whey").totalKg).toBeCloseTo(83.333, 2); // 25 of every 30 g
    expect(v1.pm.lines.length).toBeGreaterThan(0);
    expect((await call(rnd.token, "post", "/api/bom-slots/preview", { ...ref, slot: "V2", kg: 100, packs: 100 })).body.rm).toBeNull(); // V2 has no RM half
    expect((await call(rnd.token, "post", "/api/bom-slots/preview", { ...ref, productName: "Not In Catalog", slot: "V1", kg: 1 })).status).toBe(404);

    // Emptying a slot
    const gone = await call(rnd.token, "delete", `/api/bom-slots/V1?customerId=${customer.id}&productName=${encodeURIComponent(product)}`);
    expect(gone.status).toBe(200);
    expect(gone.body.slots.V1).toBeNull();
    expect(gone.body.slots.V2).not.toBeNull();
  });
});
