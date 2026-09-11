import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

async function createCustomer(token: string, companyName = "Acme Nutrition Pvt. Ltd.") {
  const res = await request(app).post("/api/customers").set(authHeader(token)).send({ companyName });
  return res.body;
}

// The "Generate" button on the PO detail page: creating a BOM/RM plan
// linked to a PO product should auto-run the matching engine the instant
// the catalog already has a SKU/Recipe with that exact product name, with
// no separate Add Item / Calculate steps — see the "two engines" request
// this was built for.
describe("PO detail page 'Generate' — auto-match a linked plan straight to CALCULATED", () => {
  it("BOM: a PO product name matching exactly one catalog SKU (scoped by the PO's customer) calculates immediately on plan creation", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken, "GenerateTestCustomer");

    // Sheet/customer name resolves against the real Customer directory —
    // an exact match reuses the same row, so this Sku attaches to the
    // very Customer the PO below is placed under.
    const { token: rndToken } = await createUser(["RND"]);
    await request(app)
      .post("/api/catalog/import")
      .set(authHeader(rndToken))
      .send({
        customers: [
          {
            customerName: "GenerateTestCustomer",
            skus: [{ productName: "Generate Test Whey 1kg", jar: "1kg HDPE Jar", wadMm: "83mm", scoopMl: "30ml", silicaGelGms: "2", silicaGelQtyNos: "1", authenticationSticker: "Yes", leaflet: "Yes", corrugatedBoxMm: "5-ply", packagingSizeNos: "12" }],
          },
        ],
      });

    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber: "PO-GEN-001", items: [{ productName: "Generate Test Whey 1kg", quantity: 1000, unit: "SKU" }] });
    expect(po.status).toBe(201);
    const itemId = po.body.items[0].id;

    const plan = await request(app).post("/api/bom/plans").set(authHeader(bdToken)).send({ name: "Generate Test Whey 1kg — BOM", purchaseOrderItemId: itemId });
    expect(plan.status).toBe(201);
    expect(plan.body.status).toBe("CALCULATED");
    expect(plan.body.items).toHaveLength(1);
    expect(plan.body.items[0].targetYield).toBe(1000);
    expect(plan.body.result).toBeTruthy();
    expect(plan.body.result.totalYield).toBe(1000);
    expect(plan.body.linkedOrder.poNumber).toBe("PO-GEN-001");
  });

  it("RM Costing: a PO product name matching exactly one Recipe calculates immediately, batch size = the PO line's own quantity", async () => {
    const { token: rndToken } = await createUser(["RND"]);
    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({
        recipes: [
          {
            name: "Generate Test Chocolate Blend",
            ingredients: [
              { name: "PEA PROTEIN EXTRACT", brand: "YANTAI CO", costPerKg: 360, gPerServing: 7.0, proteinPct: 0.8 },
              { name: "SUCRALOSE PURE POWDER", brand: "TECHNO", costPerKg: 1400, gPerServing: 0.12, proteinPct: 0 },
            ],
          },
        ],
      });

    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken, "Generate Test Customer");
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber: "PO-GEN-002", items: [{ productName: "Generate Test Chocolate Blend", quantity: 100, unit: "KG" }] });
    expect(po.status).toBe(201);
    const itemId = po.body.items[0].id;

    const plan = await request(app).post("/api/rm-costing/plans").set(authHeader(bdToken)).send({ name: "Generate Test Chocolate Blend — RM Costing", purchaseOrderItemId: itemId });
    expect(plan.status).toBe(201);
    expect(plan.body.status).toBe("CALCULATED");
    expect(plan.body.items).toHaveLength(1);
    expect(plan.body.items[0].batchSizeKg).toBe(100);
    expect(plan.body.result).toBeTruthy();
    expect(plan.body.result.batches).toHaveLength(1);
    expect(plan.body.result.batches[0].batchSizeKg).toBe(100);
  });

  it("falls back to an empty Draft plan when the product name doesn't match anything in the catalog, and auto-raises a Recipe/BOM request for R&D — no manual 'Request from R&D' click needed", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    // RND, not PPIC — the request here is raised by whoever hit Generate
    // (BD, in this test), and GET /recipe-requests scopes a PPIC caller
    // to only their own asks. RND/ADMIN see the whole queue regardless of
    // who raised it, which is what this assertion actually needs.
    const { token: rndToken } = await createUser(["RND"]);
    const customer = await createCustomer(bdToken, "No Match Customer");
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber: "PO-GEN-003", items: [{ productName: "Totally Unrecognized Product XYZ", quantity: 10, unit: "KG" }] });
    const itemId = po.body.items[0].id;

    const bomPlan = await request(app).post("/api/bom/plans").set(authHeader(bdToken)).send({ name: "No match — BOM", purchaseOrderItemId: itemId });
    expect(bomPlan.status).toBe(201);
    expect(bomPlan.body.status).toBe("DRAFT");
    expect(bomPlan.body.items).toHaveLength(0);
    expect(bomPlan.body.result).toBeNull();

    // Generate itself raised the request — PPIC never called
    // POST /api/recipe-requests by hand. checkGap() checks both sides
    // regardless of which engine's Generate triggered it, so this one
    // BOM-side call already comes back needing both.
    const afterBom = await request(app).get("/api/recipe-requests?purchaseOrderItemId=" + itemId).set(authHeader(rndToken));
    expect(afterBom.body).toHaveLength(1);
    expect(afterBom.body[0]).toMatchObject({ bomNeeded: true, rmNeeded: true, status: "PENDING" });

    const rmPlan = await request(app).post("/api/rm-costing/plans").set(authHeader(bdToken)).send({ name: "No match — RM", purchaseOrderItemId: itemId });
    expect(rmPlan.status).toBe(201);
    expect(rmPlan.body.status).toBe("DRAFT");
    expect(rmPlan.body.items).toHaveLength(0);
    expect(rmPlan.body.result).toBeNull();

    // RM's own Generate found the same request already open and just
    // handed it back — not a second row.
    const afterRm = await request(app).get("/api/recipe-requests?purchaseOrderItemId=" + itemId).set(authHeader(rndToken));
    expect(afterRm.body).toHaveLength(1);
    expect(afterRm.body[0].id).toBe(afterBom.body[0].id);
  });

  it("RM Costing: a matching Recipe is NOT auto-calculated when the PO line's unit isn't Kg — a pack-count quantity is not a batch size", async () => {
    const { token: rndToken } = await createUser(["RND"]);
    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({ recipes: [{ name: "Generate Test Non-Kg Product", ingredients: [{ name: "PEA PROTEIN EXTRACT", brand: "YANTAI CO", costPerKg: 360, gPerServing: 7.0, proteinPct: 0.8 }] }] });

    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken, "Non-Kg Unit Customer");
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber: "PO-GEN-004", items: [{ productName: "Generate Test Non-Kg Product", quantity: 500, unit: "SKU" }] });
    const itemId = po.body.items[0].id;

    const rmPlan = await request(app).post("/api/rm-costing/plans").set(authHeader(bdToken)).send({ name: "Non-Kg unit — RM", purchaseOrderItemId: itemId });
    expect(rmPlan.status).toBe(201);
    expect(rmPlan.body.status).toBe("DRAFT");
    expect(rmPlan.body.items).toHaveLength(0);
    expect(rmPlan.body.result).toBeNull();
  });
});

// "Send to Pre-Inventory" on a PO-linked BOM/RM plan should also feed PO
// Readiness — PPIC shouldn't have to separately re-enter the exact same
// (item, quantity) pairs by hand on the PO Readiness page when the system
// already knows which PO this material is for.
describe("Send to Pre-Inventory also feeds PO Readiness when the plan is PO-linked", () => {
  it("BOM: sending a PO-linked calculated plan creates matching PoMaterialRequirement rows, not just Pre-Inventory ones", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken, "Link Test Customer");

    const { token: rndToken } = await createUser(["RND"]);
    await request(app)
      .post("/api/catalog/import")
      .set(authHeader(rndToken))
      .send({
        customers: [
          {
            customerName: "Link Test Customer",
            skus: [{ productName: "Link Test Product", jar: "1kg HDPE Jar", scoopMl: "30ml", authenticationSticker: "Yes", leaflet: "Yes", corrugatedBoxMm: "5-ply", packagingSizeNos: "12" }],
          },
        ],
      });

    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber: "PO-LINK-001", items: [{ productName: "Link Test Product", quantity: 200, unit: "SKU" }] });
    const itemId = po.body.items[0].id;

    const plan = await request(app).post("/api/bom/plans").set(authHeader(bdToken)).send({ name: "Link Test — BOM", purchaseOrderItemId: itemId });
    expect(plan.body.status).toBe("CALCULATED");

    const { token: ppicToken } = await createUser(["PPIC"]);
    const sent = await request(app).post(`/api/bom/plans/${plan.body.id}/send-to-pre-inventory`).set(authHeader(ppicToken));
    expect(sent.status).toBe(201);
    expect(sent.body.requirementsCreated).toBeGreaterThan(0);
    expect(sent.body.poReadiness).not.toBeNull();
    expect(sent.body.poReadiness.rowsCreated).toBe(sent.body.requirementsCreated);

    const readiness = await request(app).get(`/api/po-readiness/${po.body.id}`).set(authHeader(ppicToken));
    expect(readiness.status).toBe(200);
    expect(readiness.body.totalItems).toBe(sent.body.poReadiness.rowsCreated);
  });

  it("does not touch PO Readiness for an ad-hoc plan with no purchaseOrderItemId", async () => {
    const { token: rndToken } = await createUser(["RND"]);
    await request(app)
      .post("/api/catalog/import")
      .set(authHeader(rndToken))
      .send({ customers: [{ customerName: "AdHocBrand", skus: [{ productName: "Ad Hoc Product", jar: "1kg HDPE Jar" }] }] });
    const { token: ppicToken } = await createUser(["PPIC"]);
    const skus = await request(app).get("/api/catalog/skus").set(authHeader(ppicToken));
    const skuId = skus.body.find((s: { productName: string }) => s.productName === "Ad Hoc Product").id;

    const plan = await request(app).post("/api/bom/plans").set(authHeader(ppicToken)).send({ name: "Ad-hoc plan" });
    await request(app).post(`/api/bom/plans/${plan.body.id}/items`).set(authHeader(ppicToken)).send({ skuId, targetYield: 50 });
    await request(app).post(`/api/bom/plans/${plan.body.id}/calculate`).set(authHeader(ppicToken));

    const sent = await request(app).post(`/api/bom/plans/${plan.body.id}/send-to-pre-inventory`).set(authHeader(ppicToken));
    expect(sent.status).toBe(201);
    expect(sent.body.poReadiness).toBeNull();
  });

  it("a second send on the same unchanged result is blocked — no unique constraint on PreInventoryRequirement to fall back on, so a repeat press would otherwise duplicate every row", async () => {
    const { token: rndToken } = await createUser(["RND"]);
    await request(app)
      .post("/api/catalog/import")
      .set(authHeader(rndToken))
      .send({ customers: [{ customerName: "RepeatSendBrand", skus: [{ productName: "Repeat Send Product", jar: "1kg HDPE Jar" }] }] });
    const { token: ppicToken } = await createUser(["PPIC"]);
    const skus = await request(app).get("/api/catalog/skus").set(authHeader(ppicToken));
    const skuId = skus.body.find((s: { productName: string }) => s.productName === "Repeat Send Product").id;

    const plan = await request(app).post("/api/bom/plans").set(authHeader(ppicToken)).send({ name: "Repeat send plan" });
    await request(app).post(`/api/bom/plans/${plan.body.id}/items`).set(authHeader(ppicToken)).send({ skuId, targetYield: 50 });
    const calculated = await request(app).post(`/api/bom/plans/${plan.body.id}/calculate`).set(authHeader(ppicToken));
    expect(calculated.body.plan.sentToPreInventoryAt).toBeNull();

    const first = await request(app).post(`/api/bom/plans/${plan.body.id}/send-to-pre-inventory`).set(authHeader(ppicToken));
    expect(first.status).toBe(201);

    // Second press on the exact same result — refused, not a duplicate set.
    const second = await request(app).post(`/api/bom/plans/${plan.body.id}/send-to-pre-inventory`).set(authHeader(ppicToken));
    expect(second.status).toBe(400);

    const afterFirst = await request(app).get(`/api/inventory/requirements?pageSize=200`).set(authHeader(ppicToken));
    const matching = afterFirst.body.filter((r: { item: { name: string } }) => r.item.name.includes("Jar/Container"));
    expect(matching).toHaveLength(1); // not 2

    // Recalculating re-opens it — a genuine reason to send again.
    const recalculated = await request(app).post(`/api/bom/plans/${plan.body.id}/calculate`).set(authHeader(ppicToken));
    expect(recalculated.body.plan.sentToPreInventoryAt).toBeNull();
    const third = await request(app).post(`/api/bom/plans/${plan.body.id}/send-to-pre-inventory`).set(authHeader(ppicToken));
    expect(third.status).toBe(201);
  });
});

// "Send to Pre-Inventory" on a PO-linked plan should also raise this PO's
// Material Requests directly — PPIC shouldn't have to separately re-pick
// and re-type the exact same items a second time in the Material Requests
// form when the calculated plan already has them.
describe("Send to Pre-Inventory also raises Material Requests when the plan is PO-linked", () => {
  it("BOM: sending a PO-linked calculated plan creates one PENDING Material Request per item, purpose ISSUED_PRODUCTION", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken, "MR Link Test Customer");

    const { token: rndToken } = await createUser(["RND"]);
    await request(app)
      .post("/api/catalog/import")
      .set(authHeader(rndToken))
      .send({
        customers: [
          {
            customerName: "MR Link Test Customer",
            skus: [{ productName: "MR Link Test Product", jar: "1kg HDPE Jar", scoopMl: "30ml", authenticationSticker: "Yes", leaflet: "Yes", corrugatedBoxMm: "5-ply", packagingSizeNos: "12" }],
          },
        ],
      });

    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber: "PO-MR-LINK-001", items: [{ productName: "MR Link Test Product", quantity: 200, unit: "SKU" }] });
    const itemId = po.body.items[0].id;

    const plan = await request(app).post("/api/bom/plans").set(authHeader(bdToken)).send({ name: "MR Link Test — BOM", purchaseOrderItemId: itemId });
    expect(plan.body.status).toBe("CALCULATED");

    const { token: ppicToken } = await createUser(["PPIC"]);
    const sent = await request(app).post(`/api/bom/plans/${plan.body.id}/send-to-pre-inventory`).set(authHeader(ppicToken));
    expect(sent.status).toBe(201);
    expect(sent.body.materialRequests).not.toBeNull();
    expect(sent.body.materialRequests.rowsCreated).toBe(sent.body.requirementsCreated);

    const requests = await request(app).get("/api/inventory/requests?pageSize=200").set(authHeader(ppicToken));
    expect(requests.status).toBe(200);
    expect(requests.body).toHaveLength(sent.body.materialRequests.rowsCreated);
    for (const r of requests.body) {
      expect(r.status).toBe("PENDING");
      expect(r.purpose).toBe("ISSUED_PRODUCTION");
      expect(r.note).toContain("PO-MR-LINK-001");
    }
  });

  it("does not raise any Material Requests for an ad-hoc plan with no purchaseOrderItemId", async () => {
    const { token: rndToken } = await createUser(["RND"]);
    await request(app)
      .post("/api/catalog/import")
      .set(authHeader(rndToken))
      .send({ customers: [{ customerName: "MrAdHocBrand", skus: [{ productName: "MR Ad Hoc Product", jar: "1kg HDPE Jar" }] }] });
    const { token: ppicToken } = await createUser(["PPIC"]);
    const skus = await request(app).get("/api/catalog/skus").set(authHeader(ppicToken));
    const skuId = skus.body.find((s: { productName: string }) => s.productName === "MR Ad Hoc Product").id;

    const plan = await request(app).post("/api/bom/plans").set(authHeader(ppicToken)).send({ name: "MR Ad-hoc plan" });
    await request(app).post(`/api/bom/plans/${plan.body.id}/items`).set(authHeader(ppicToken)).send({ skuId, targetYield: 50 });
    await request(app).post(`/api/bom/plans/${plan.body.id}/calculate`).set(authHeader(ppicToken));

    const sent = await request(app).post(`/api/bom/plans/${plan.body.id}/send-to-pre-inventory`).set(authHeader(ppicToken));
    expect(sent.status).toBe(201);
    expect(sent.body.materialRequests).toBeNull();

    const requests = await request(app).get("/api/inventory/requests?pageSize=200").set(authHeader(ppicToken));
    expect(requests.body).toHaveLength(0);
  });
});
