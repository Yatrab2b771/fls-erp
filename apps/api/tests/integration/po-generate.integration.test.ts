import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser, ensurePlant } from "./helpers";

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
      .send({ customerId: customer.id, poNumber: "PO-GEN-001", items: [{ productName: "Generate Test Whey 1kg", productCategory: "Powder", quantity: 1000, unit: "SKU" }] });
    // Planning is only allowed off a PO BD has approved — PPIC never sees a Draft.
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    expect(po.status).toBe(201);
    const itemId = po.body.items[0].id;

    await ensurePlant(itemId);
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
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken, "Generate Test Customer");
    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({
        recipes: [
          {
            name: "Generate Test Chocolate Blend",
            customerId: customer.id,
            ingredients: [
              { name: "PEA PROTEIN EXTRACT", brand: "YANTAI CO", costPerKg: 360, gPerServing: 7.0, proteinPct: 0.8 },
              { name: "SUCRALOSE PURE POWDER", brand: "TECHNO", costPerKg: 1400, gPerServing: 0.12, proteinPct: 0 },
            ],
          },
        ],
      });
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber: "PO-GEN-002", items: [{ productName: "Generate Test Chocolate Blend", productCategory: "Powder", quantity: 100, unit: "KG", packSize: "1 kg" }] });
    // Planning is only allowed off a PO BD has approved — PPIC never sees a Draft.
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    expect(po.status).toBe(201);
    const itemId = po.body.items[0].id;

    await ensurePlant(itemId);
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
      .send({ customerId: customer.id, poNumber: "PO-GEN-003", items: [{ productName: "Totally Unrecognized Product XYZ", productCategory: "Powder", quantity: 10, unit: "KG" }] });
    // Planning is only allowed off a PO BD has approved — PPIC never sees a Draft.
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    const itemId = po.body.items[0].id;

    await ensurePlant(itemId);
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

    await ensurePlant(itemId);
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
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken, "Non-Kg Unit Customer");
    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({ recipes: [{ name: "Generate Test Non-Kg Product", customerId: customer.id, ingredients: [{ name: "PEA PROTEIN EXTRACT", brand: "YANTAI CO", costPerKg: 360, gPerServing: 7.0, proteinPct: 0.8 }] }] });
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber: "PO-GEN-004", items: [{ productName: "Generate Test Non-Kg Product", productCategory: "Powder", quantity: 500, unit: "SKU" }] });
    // Planning is only allowed off a PO BD has approved — PPIC never sees a Draft.
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    const itemId = po.body.items[0].id;

    await ensurePlant(itemId);
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

// Regulatory hand-off — the moment a PO product's plan is CALCULATED it goes
// to Regulatory on its own (no manual send), and Regulatory has nothing to
// review before that.
describe("Automatic Regulatory hand-off when a plan is calculated", () => {
  async function approvedPoWithRecipe(poNumber: string, productName: string) {
    const { token: rndToken } = await createUser(["RND"]);
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken, `${productName} Customer`);
    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({ recipes: [{ name: productName, customerId: customer.id, ingredients: [{ name: "PEA PROTEIN EXTRACT", brand: "YANTAI CO", costPerKg: 360, gPerServing: 7.0, proteinPct: 0.8 }] }] });
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber, items: [{ productName, productCategory: "Powder", quantity: 100, unit: "KG", packSize: "1 kg" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    return { bdToken, poId: po.body.id as string, itemId: po.body.items[0].id as string };
  }

  it("sends the product to Regulatory (and notifies it) exactly when the plan reaches CALCULATED — and Regulatory can't review before that", async () => {
    const { prisma } = await import("../../src/common/lib/prisma");
    const { token: regToken, user: regUser } = await createUser(["REGULATORY"]);
    const { bdToken, poId, itemId } = await approvedPoWithRecipe("PO-REG-001", "Regulatory Handoff Blend");

    // BD approving the PO does NOT notify Regulatory any more, and there's nothing to review yet.
    expect(await prisma.notification.count({ where: { recipientId: regUser.id } })).toBe(0);
    expect((await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemId } })).sentToRegulatoryAt).toBeNull();
    const tooEarly = await request(app).patch(`/api/purchase-orders/${poId}/items/${itemId}/regulatory-review`).set(authHeader(regToken)).send({ status: "Approved" });
    expect(tooEarly.status).toBe(400);

    await ensurePlant(itemId);
    const plan = await request(app).post("/api/rm-costing/plans").set(authHeader(bdToken)).send({ name: "Handoff RM", purchaseOrderItemId: itemId });
    expect(plan.body.status).toBe("CALCULATED");

    const sent = await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(sent.sentToRegulatoryAt).not.toBeNull();
    expect(sent.regulatoryStatus).toBeNull(); // sent, awaiting a decision
    const notices = await prisma.notification.findMany({ where: { recipientId: regUser.id } });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toMatch(/Plan sent for regulatory review/);

    // Recalculating an already-awaiting plan doesn't re-notify.
    const { token: ppicToken } = await createUser(["PPIC"]);
    await request(app).post(`/api/rm-costing/plans/${plan.body.id}/calculate`).set(authHeader(ppicToken));
    expect(await prisma.notification.count({ where: { recipientId: regUser.id } })).toBe(1);

    const approved = await request(app).patch(`/api/purchase-orders/${poId}/items/${itemId}/regulatory-review`).set(authHeader(regToken)).send({ status: "Approved" });
    expect(approved.status).toBe(200);
    expect(approved.body.regulatoryStatus).toBe("Approved");

    // An approval survives a later recalculation.
    await request(app).post(`/api/rm-costing/plans/${plan.body.id}/calculate`).set(authHeader(ppicToken));
    expect((await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemId } })).regulatoryStatus).toBe("Approved");
  });

  it("after 'Not Approved', recalculating the plan re-sends it as a fresh Pending review", async () => {
    const { prisma } = await import("../../src/common/lib/prisma");
    const { token: regToken, user: regUser } = await createUser(["REGULATORY"]);
    const { bdToken, poId, itemId } = await approvedPoWithRecipe("PO-REG-002", "Regulatory Resend Blend");
    await ensurePlant(itemId);
    const plan = await request(app).post("/api/rm-costing/plans").set(authHeader(bdToken)).send({ name: "Resend RM", purchaseOrderItemId: itemId });
    expect(plan.body.status).toBe("CALCULATED");

    const rejected = await request(app)
      .patch(`/api/purchase-orders/${poId}/items/${itemId}/regulatory-review`)
      .set(authHeader(regToken))
      .send({ status: "Not Approved", remarks: "Dose too high" });
    expect(rejected.status).toBe(200);

    const { token: ppicToken } = await createUser(["PPIC"]);
    await request(app).post(`/api/rm-costing/plans/${plan.body.id}/calculate`).set(authHeader(ppicToken));

    const after = await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(after.regulatoryStatus).toBeNull();
    expect(after.regulatoryRemarks).toBeNull();
    expect(after.sentToRegulatoryAt).not.toBeNull();
    const titles = (await prisma.notification.findMany({ where: { recipientId: regUser.id }, orderBy: { createdAt: "asc" } })).map((n) => n.title);
    expect(titles).toHaveLength(2);
    expect(titles[1]).toMatch(/re-sent/i);
  });
});

// R&D updates the catalog -> the Draft plans that were waiting on it calculate
// themselves (no second Generate), BOM and RM independently, so a product stays
// Partially Planned until R&D has provided both.
describe("R&D catalog update auto-calculates the waiting Draft plans", () => {
  async function waitingProduct(poNumber: string, productName: string, customerName: string) {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken, user: ppic } = await createUser(["PPIC"]);
    const customer = await createCustomer(bdToken, customerName);
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber, items: [{ productName, productCategory: "Powder", quantity: 100, unit: "KG", packSize: "1 kg" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    const itemId = po.body.items[0].id as string;
    // Nothing in the catalog yet -> Generate leaves both plans as empty Drafts.
    await ensurePlant(itemId);
    const bom = await request(app).post("/api/bom/plans").set(authHeader(ppicToken)).send({ name: `${productName} BOM`, purchaseOrderItemId: itemId });
    await ensurePlant(itemId);
    const rm = await request(app).post("/api/rm-costing/plans").set(authHeader(ppicToken)).send({ name: `${productName} RM`, purchaseOrderItemId: itemId });
    expect(bom.body.status).toBe("DRAFT");
    expect(rm.body.status).toBe("DRAFT");
    return { ppicToken, ppic, customerId: customer.id as string, poId: po.body.id as string, itemId, bomId: bom.body.id as string, rmId: rm.body.id as string };
  }

  const uploadRecipe = (token: string, name: string, customerId: string) =>
    request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(token))
      .send({ recipes: [{ name, customerId, ingredients: [{ name: "PEA PROTEIN EXTRACT", brand: "YANTAI CO", costPerKg: 360, gPerServing: 7.0, proteinPct: 0.8 }] }] });

  const uploadSku = (token: string, customerName: string, productName: string) =>
    request(app)
      .post("/api/catalog/import")
      .set(authHeader(token))
      .send({
        customers: [
          {
            customerName,
            skus: [{ productName, jar: "1kg HDPE Jar", wadMm: "83mm", scoopMl: "30ml", silicaGelGms: "2", silicaGelQtyNos: "1", authenticationSticker: "Yes", leaflet: "Yes", corrugatedBoxMm: "5-ply", packagingSizeNos: "12" }],
          },
        ],
      });

  it("a Recipe upload calculates only the RM plan, the SKU upload then the BOM plan — and the product ends up fully planned", async () => {
    const { prisma } = await import("../../src/common/lib/prisma");
    const { token: rndToken } = await createUser(["RND"]);
    const w = await waitingProduct("PO-AUTO-001", "Auto Calc Blend", "Auto Calc Customer");

    await uploadRecipe(rndToken, "Auto Calc Blend", w.customerId);
    expect((await prisma.rmPlan.findUniqueOrThrow({ where: { id: w.rmId } })).status).toBe("CALCULATED");
    expect((await prisma.bomPlan.findUniqueOrThrow({ where: { id: w.bomId } })).status).toBe("DRAFT"); // still waiting on the SKU
    // Regulatory hand-off fired on the first calculated plan, and PPIC was told.
    expect((await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: w.itemId } })).sentToRegulatoryAt).not.toBeNull();
    let notices = await prisma.notification.findMany({ where: { recipientId: w.ppic.id, title: { contains: "calculated automatically" } } });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toMatch(/RM BOM/);
    expect(notices[0]!.body).toMatch(/Still waiting on the other BOM/);

    await uploadSku(rndToken, "Auto Calc Customer", "Auto Calc Blend");
    expect((await prisma.bomPlan.findUniqueOrThrow({ where: { id: w.bomId } })).status).toBe("CALCULATED");
    notices = await prisma.notification.findMany({ where: { recipientId: w.ppic.id, title: { contains: "calculated automatically" } }, orderBy: { createdAt: "asc" } });
    expect(notices).toHaveLength(2);
    expect(notices[1]!.body).toMatch(/Material Planning/);
  });

  it("does not calculate a product that PPIC has on hold (until it is fully planned)", async () => {
    const { prisma } = await import("../../src/common/lib/prisma");
    const { token: rndToken } = await createUser(["RND"]);
    const w = await waitingProduct("PO-AUTO-002", "Auto Calc Held Blend", "Auto Calc Held Customer");
    expect((await request(app).patch(`/api/purchase-orders/${w.poId}/items/${w.itemId}/material-hold`).set(authHeader(w.ppicToken)).send({ held: true })).status).toBe(200);

    await uploadRecipe(rndToken, "Auto Calc Held Blend", w.customerId);
    expect((await prisma.rmPlan.findUniqueOrThrow({ where: { id: w.rmId } })).status).toBe("DRAFT");
  });

  it("releasing a hold picks up the R&D update that landed while the product was held", async () => {
    const { prisma } = await import("../../src/common/lib/prisma");
    const { token: rndToken } = await createUser(["RND"]);
    const w = await waitingProduct("PO-AUTO-004", "Auto Calc Release Blend", "Auto Calc Release Customer");
    const hold = (held: boolean) => request(app).patch(`/api/purchase-orders/${w.poId}/items/${w.itemId}/material-hold`).set(authHeader(w.ppicToken)).send({ held });

    await hold(true);
    await uploadRecipe(rndToken, "Auto Calc Release Blend", w.customerId);
    expect((await prisma.rmPlan.findUniqueOrThrow({ where: { id: w.rmId } })).status).toBe("DRAFT"); // skipped while held

    await hold(false);
    expect((await prisma.rmPlan.findUniqueOrThrow({ where: { id: w.rmId } })).status).toBe("CALCULATED"); // picked up on release
  });

  it("does nothing for a product PPIC never pressed Generate on (no Draft plan to finish)", async () => {
    const { prisma } = await import("../../src/common/lib/prisma");
    const { token: rndToken } = await createUser(["RND"]);
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken, "Auto Calc No Draft Customer");
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber: "PO-AUTO-003", items: [{ productName: "Auto Calc No Draft", productCategory: "Powder", quantity: 100, unit: "KG", packSize: "1 kg" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });

    await uploadRecipe(rndToken, "Auto Calc No Draft");
    expect(await prisma.rmPlan.count({ where: { purchaseOrderItemId: po.body.items[0].id } })).toBe(0);
  });
});
