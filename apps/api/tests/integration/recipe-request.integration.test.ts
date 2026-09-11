import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

async function createCustomer(token: string, companyName: string) {
  const res = await request(app).post("/api/customers").set(authHeader(token)).send({ companyName });
  return res.body;
}

// Same Customer name every time for a given product ("<product> Customer")
// — matching a catalog import to this PO no longer goes through a
// separate free-text Brand, it's the PO's own real customerId. Callers
// that want the import to land on the exact same Customer row this PO
// uses must create the Customer *first* (createCustomer), then import
// (which reuses an exact company-name match instead of creating a
// second, unrelated row), then build the PO against that same id.
function customerNameFor(productName: string) {
  return `${productName} Customer`;
}

/** Approves a PO with one line item whose product name matches nothing in the catalog, returns its item id. Creates its own Customer unless one is passed in. */
async function createUnmatchedPoItem(bdToken: string, productName: string, poNumber: string, unit = "Kg", customerId?: string) {
  const resolvedCustomerId = customerId ?? (await createCustomer(bdToken, customerNameFor(productName))).id;
  const po = await request(app)
    .post("/api/purchase-orders")
    .set(authHeader(bdToken))
    .send({ customerId: resolvedCustomerId, poNumber, items: [{ productName, quantity: 100, unit }] });
  await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
  return po.body.items[0].id as string;
}

describe("POST /api/recipe-requests — PPIC asks R&D for a missing Recipe/BOM", () => {
  it("is PPIC-only, detects which side is actually missing, and rejects when the catalog already has a match", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);

    const itemId = await createUnmatchedPoItem(bdToken, "RR Totally New Product", "PO-RR-001");

    const denied = await request(app).post("/api/recipe-requests").set(authHeader(storeToken)).send({ purchaseOrderItemId: itemId });
    expect(denied.status).toBe(403);

    const created = await request(app).post("/api/recipe-requests").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    expect(created.status).toBe(201);
    expect(created.body.bomNeeded).toBe(true);
    expect(created.body.rmNeeded).toBe(true); // unit is Kg and no Recipe exists either
    expect(created.body.status).toBe("PENDING");

    // Re-asking for the same still-open item returns the same row, not a duplicate.
    const again = await request(app).post("/api/recipe-requests").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(created.body.id);

    // A product the catalog already fully matches (both Sku and Recipe) has nothing to ask for.
    const { token: rndToken } = await createUser(["RND"]);
    const matchedCustomer = await createCustomer(bdToken, customerNameFor("RR Already Matched"));
    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({ recipes: [{ name: "RR Already Matched", ingredients: [{ name: "Some Protein", brand: "TestBrand", costPerKg: 300, gPerServing: 10, proteinPct: 0.5 }] }] });
    await request(app)
      .post("/api/catalog/import")
      .set(authHeader(rndToken))
      .send({ customers: [{ customerName: customerNameFor("RR Already Matched"), skus: [{ productName: "RR Already Matched", jar: "1kg HDPE Jar" }] }] });
    const matchedItemId = await createUnmatchedPoItem(bdToken, "RR Already Matched", "PO-RR-002", "Kg", matchedCustomer.id);
    const rejected = await request(app).post("/api/recipe-requests").set(authHeader(ppicToken)).send({ purchaseOrderItemId: matchedItemId });
    expect(rejected.status).toBe(400);
  });

  it("only asks for the side that's actually missing — a PO-item unit that isn't Kg means RM Costing was never in play", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const itemId = await createUnmatchedPoItem(bdToken, "RR Non-Kg Product", "PO-RR-003", "SKU");

    const created = await request(app).post("/api/recipe-requests").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    expect(created.status).toBe(201);
    expect(created.body.bomNeeded).toBe(true);
    expect(created.body.rmNeeded).toBe(false);
  });
});

describe("PATCH /api/recipe-requests/:id/eta — R&D-only", () => {
  it("is restricted to RND, sets status to ETA_GIVEN, and notifies the requester", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: rndToken } = await createUser(["RND"]);
    const itemId = await createUnmatchedPoItem(bdToken, "RR ETA Product", "PO-RR-010");
    const created = await request(app).post("/api/recipe-requests").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });

    const denied = await request(app).patch(`/api/recipe-requests/${created.body.id}/eta`).set(authHeader(ppicToken)).send({ etaDate: "2026-09-10" });
    expect(denied.status).toBe(403);

    const given = await request(app).patch(`/api/recipe-requests/${created.body.id}/eta`).set(authHeader(rndToken)).send({ etaDate: "2026-09-10", etaNote: "Trial run first" });
    expect(given.status).toBe(200);
    expect(given.body.status).toBe("ETA_GIVEN");
    expect(given.body.etaNote).toBe("Trial run first");

    const notifications = await request(app).get("/api/notifications").set(authHeader(ppicToken));
    expect(notifications.body.notifications.some((n: { title: string }) => n.title.includes("RR ETA Product"))).toBe(true);
  });
});

describe("Uploading the missing catalog piece resolves the request — R&D's Import Catalog / Import Recipes", () => {
  it("BOM-only: importing the matching SKU flips a bomNeeded-only request straight to READY", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: rndToken } = await createUser(["RND"]);

    // Recipe already exists (unit Kg, name matches) so only bomNeeded is true.
    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({ recipes: [{ name: "RR Resolve BOM Only", ingredients: [{ name: "Some Protein", brand: "TestBrand", costPerKg: 300, gPerServing: 10, proteinPct: 0.5 }] }] });

    const itemId = await createUnmatchedPoItem(bdToken, "RR Resolve BOM Only", "PO-RR-020");
    const created = await request(app).post("/api/recipe-requests").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    expect(created.body.bomNeeded).toBe(true);
    expect(created.body.rmNeeded).toBe(false);
    expect(created.body.status).toBe("PENDING");

    await request(app)
      .post("/api/catalog/import")
      .set(authHeader(rndToken))
      .send({ customers: [{ customerName: customerNameFor("RR Resolve BOM Only"), skus: [{ productName: "RR Resolve BOM Only", jar: "1kg HDPE Jar" }] }] });

    const list = await request(app).get("/api/recipe-requests").set(authHeader(ppicToken));
    const updated = list.body.find((r: { id: string }) => r.id === created.body.id);
    expect(updated.status).toBe("READY");
    expect(updated.bomFulfilledAt).toBeTruthy();

    // Generate now actually matches.
    const plan = await request(app).post("/api/bom/plans").set(authHeader(bdToken)).send({ name: "Resolve — BOM", purchaseOrderItemId: itemId });
    expect(plan.body.status).toBe("CALCULATED");
  });

  it("needing both sides isn't READY until both have been delivered", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: rndToken } = await createUser(["RND"]);

    const itemId = await createUnmatchedPoItem(bdToken, "RR Resolve Both", "PO-RR-021");
    const created = await request(app).post("/api/recipe-requests").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    expect(created.body.bomNeeded).toBe(true);
    expect(created.body.rmNeeded).toBe(true);

    await request(app)
      .post("/api/catalog/import")
      .set(authHeader(rndToken))
      .send({ customers: [{ customerName: customerNameFor("RR Resolve Both"), skus: [{ productName: "RR Resolve Both", jar: "1kg HDPE Jar" }] }] });

    const afterBom = await request(app).get("/api/recipe-requests").set(authHeader(ppicToken));
    const stillOpen = afterBom.body.find((r: { id: string }) => r.id === created.body.id);
    expect(stillOpen.status).toBe("PENDING"); // BOM side done, RM side still missing
    expect(stillOpen.bomFulfilledAt).toBeTruthy();
    expect(stillOpen.rmFulfilledAt).toBeFalsy();

    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({ recipes: [{ name: "RR Resolve Both", ingredients: [{ name: "Some Protein", brand: "TestBrand", costPerKg: 300, gPerServing: 10, proteinPct: 0.5 }] }] });

    const afterRecipe = await request(app).get("/api/recipe-requests").set(authHeader(ppicToken));
    const nowReady = afterRecipe.body.find((r: { id: string }) => r.id === created.body.id);
    expect(nowReady.status).toBe("READY");
  });

  // The bug this guards: BOM/RM Costing's own "Calculate" only needs a
  // Sku/Recipe to exist — it doesn't touch RecipeRequest at all — so a
  // product added one-at-a-time (R&D's "+ Add a product" / manual
  // Packaging BOM checklist save, never through bulk Import Catalog)
  // used to leave the request stuck PENDING forever even once BOM/RM
  // Costing both showed CALCULATED, silently blocking Batch creation.
  it("manually adding a Sku (not bulk Import Catalog) also resolves a waiting bomNeeded request", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: rndToken } = await createUser(["RND"]);

    // Recipe already exists so only the BOM/packaging side is missing.
    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({ recipes: [{ name: "RR Manual Add Resolves", ingredients: [{ name: "Some Protein", brand: "TestBrand", costPerKg: 300, gPerServing: 10, proteinPct: 0.5 }] }] });

    const customer = await createCustomer(bdToken, customerNameFor("RR Manual Add Resolves"));
    const itemId = await createUnmatchedPoItem(bdToken, "RR Manual Add Resolves", "PO-RR-022", "Kg", customer.id);
    const created = await request(app).post("/api/recipe-requests").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    expect(created.body.bomNeeded).toBe(true);
    expect(created.body.status).toBe("PENDING");

    // R&D's own one-at-a-time "+ Add a product", not bulk Import Catalog —
    // but a bare Sku (name only, no packaging spec yet) still isn't
    // enough to close the gap; see hasBomSpec in bom-engine.ts.
    const sku = await request(app)
      .post("/api/catalog/skus")
      .set(authHeader(rndToken))
      .send({ customerId: customer.id, productName: "RR Manual Add Resolves" });
    expect(sku.status).toBe(201);

    const afterBareAdd = await request(app).get("/api/recipe-requests").set(authHeader(ppicToken));
    expect(afterBareAdd.body.find((r: { id: string }) => r.id === created.body.id).status).toBe("PENDING");

    // R&D actually fills in a real packaging field — that's what closes it.
    await request(app).patch(`/api/catalog/skus/${sku.body.id}`).set(authHeader(rndToken)).send({ jar: "1kg HDPE Jar" });

    const afterAdd = await request(app).get("/api/recipe-requests").set(authHeader(ppicToken));
    expect(afterAdd.body.find((r: { id: string }) => r.id === created.body.id).status).toBe("READY");

    // Generate now actually matches, same as the bulk-import case above.
    const plan = await request(app).post("/api/bom/plans").set(authHeader(bdToken)).send({ name: "Resolve — Manual Add", purchaseOrderItemId: itemId });
    expect(plan.body.status).toBe("CALCULATED");
  });

  it("editing a Sku's spec by hand (PATCH), or saving its Packaging BOM checklist, also resolves a waiting request", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: rndToken } = await createUser(["RND"]);

    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({ recipes: [{ name: "RR Checklist Resolves", ingredients: [{ name: "Some Protein", brand: "TestBrand", costPerKg: 300, gPerServing: 10, proteinPct: 0.5 }] }] });

    const customer = await createCustomer(bdToken, customerNameFor("RR Checklist Resolves"));
    const itemId = await createUnmatchedPoItem(bdToken, "RR Checklist Resolves", "PO-RR-023", "Kg", customer.id);
    const created = await request(app).post("/api/recipe-requests").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    expect(created.body.bomNeeded).toBe(true);
    expect(created.body.status).toBe("PENDING");

    // A bare Sku (BD's own "+ New" off the PO form, before R&D fills
    // anything in) does NOT resolve the request by itself any more — a
    // row existing isn't the same as R&D having actually defined the
    // packaging (see hasBomSpec in bom-engine.ts). This is the real bug
    // this suite used to accept as correct: Generate would silently
    // "calculate" a hollow, ₹0 BOM off exactly this bare row.
    const sku = await request(app)
      .post("/api/catalog/skus")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, productName: "RR Checklist Resolves" });
    const afterCreate = await request(app).get("/api/recipe-requests").set(authHeader(ppicToken));
    expect(afterCreate.body.find((r: { id: string }) => r.id === created.body.id).status).toBe("PENDING");

    // R&D filling in the real packaging spec afterwards — either the flat
    // fields (PATCH) or the components checklist (PUT) — is what actually
    // closes it; either one alone is enough.
    const patched = await request(app).patch(`/api/catalog/skus/${sku.body.id}`).set(authHeader(rndToken)).send({ jar: "1kg HDPE Jar" });
    expect(patched.status).toBe(200);
    const afterPatch = await request(app).get("/api/recipe-requests").set(authHeader(ppicToken));
    expect(afterPatch.body.find((r: { id: string }) => r.id === created.body.id).status).toBe("READY");
  });
});

describe("POST /api/pre-productions — blocked while this PO item's Recipe/BOM request is still open", () => {
  it("refuses to start production while PENDING/ETA_GIVEN, allows it once the request is READY", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: rndToken } = await createUser(["RND"]);

    const itemId = await createUnmatchedPoItem(bdToken, "RR Batch Gate Product", "PO-RR-030");
    const openRequest = await request(app).post("/api/recipe-requests").set(authHeader(ppicToken)).send({ purchaseOrderItemId: itemId });
    expect(openRequest.status).toBe(201);

    const blockedPending = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    expect(blockedPending.status).toBe(400);
    expect(blockedPending.body.error).toMatch(/no ETA given yet/);

    await request(app).patch(`/api/recipe-requests/${openRequest.body.id}/eta`).set(authHeader(rndToken)).send({ etaDate: "2026-09-15" });
    const blockedEta = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    expect(blockedEta.status).toBe(400);
    expect(blockedEta.body.error).toMatch(/ETA/);

    await request(app)
      .post("/api/catalog/import")
      .set(authHeader(rndToken))
      .send({ customers: [{ customerName: customerNameFor("RR Batch Gate Product"), skus: [{ productName: "RR Batch Gate Product", jar: "1kg HDPE Jar" }] }] });
    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({ recipes: [{ name: "RR Batch Gate Product", ingredients: [{ name: "Some Protein", brand: "TestBrand", costPerKg: 300, gPerServing: 10, proteinPct: 0.5 }] }] });

    const allowed = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    expect(allowed.status).toBe(201);
  });

  it("a product that never needed R&D (catalog already matched) starts production normally — no request, no gate", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: rndToken } = await createUser(["RND"]);

    const customer = await createCustomer(bdToken, "No Gate Customer");
    await request(app)
      .post("/api/catalog/import")
      .set(authHeader(rndToken))
      .send({ customers: [{ customerName: "No Gate Customer", skus: [{ productName: "RR No Gate Product", jar: "1kg HDPE Jar" }] }] });

    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber: "PO-RR-040", items: [{ productName: "RR No Gate Product", quantity: 50, unit: "SKU" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    const itemId = po.body.items[0].id;

    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    expect(run.status).toBe(201);
  });
});
