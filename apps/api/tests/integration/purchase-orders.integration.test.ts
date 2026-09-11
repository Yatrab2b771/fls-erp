import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

async function createCustomer(token: string, companyName = "Acme Nutrition Pvt. Ltd.") {
  const res = await request(app).post("/api/customers").set(authHeader(token)).send({ companyName });
  return res.body;
}

/**
 * Walks a PO item's whole three-tier production run straight to a
 * CombinedLot sitting at DISPATCH_PLAN, via admin JUMPs — fine for tests
 * that are about PO-level rollups (completion, billing), not the
 * pipeline walk itself, which the pre-production/production-batches/
 * combined-lot test suites already cover in full. Returns the
 * CombinedLot id.
 */
async function walkToDispatchPlan(itemId: string, plannedQty: number, tokens: { production: string; admin: string }) {
  const run = (await request(app).post("/api/pre-productions").set(authHeader(tokens.production)).send({ purchaseOrderItemId: itemId })).body;
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.admin)).send({ action: "JUMP", targetStageId: "SAMPLE_QC_APPROVAL" });
  // JUMP only moves currentStageId — it doesn't set sampleQcStatus, and
  // Production can't start until that's literally "Approved" (see
  // production-batches.routes.ts's own gate), so a real FORWARD still
  // has to set it even after an admin jump. ADMIN bypasses the stage's
  // own department check, same as JUMP does.
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.admin)).send({ action: "FORWARD", sampleQcStatus: "Approved" });
  const pb = (await request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(tokens.production)).send({ plannedQty })).body;
  await request(app).patch(`/api/production-batches/${pb.id}`).set(authHeader(tokens.production)).send({ outputQty: plannedQty });
  const completed = await request(app).post(`/api/production-batches/${pb.id}/complete`).set(authHeader(tokens.production));
  const lot = completed.body.combinedLot as { id: string };
  await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(tokens.admin)).send({ action: "JUMP", targetStageId: "DISPATCH_PLAN" });
  return lot.id;
}

describe("POST /api/purchase-orders", () => {
  it("is restricted to BD and requires at least one product line item", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken);

    const { token: ppicToken } = await createUser(["PPIC"]);
    const denied = await request(app).post("/api/purchase-orders").set(authHeader(ppicToken)).send({ customerId: customer.id, items: [] });
    expect(denied.status).toBe(403);

    const noItems = await request(app).post("/api/purchase-orders").set(authHeader(bdToken)).send({ customerId: customer.id, items: [] });
    expect(noItems.status).toBe(400);

    const created = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({
        customerId: customer.id,
        poNumber: "PO-1001",
        items: [
          { productName: "Medicine A", quantity: 100, unit: "KG" },
          { productName: "Medicine B", quantity: 50, unit: "SKU", volume: 25 },
        ],
      });
    expect(created.status).toBe(201);
    expect(created.body.items).toHaveLength(2);
    const medicineB = created.body.items.find((i: { productName: string }) => i.productName === "Medicine B");
    expect(medicineB.volume).toBe(25);
  });
});

describe("POST /api/purchase-orders/import", () => {
  it("is restricted to BD", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    const denied = await request(app)
      .post("/api/purchase-orders/import")
      .set(authHeader(ppicToken))
      .send({ rows: [{ poNumber: "PO-IMPORT-1", customerName: "X", productName: "Y", quantity: 1, unit: "KG" }] });
    expect(denied.status).toBe(403);
  });

  it("groups rows sharing a PO Number into one PO, resolves-or-creates the customer by name, and skips a PO Number that already exists", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const existingCustomer = await createCustomer(bdToken, "Already Known Customer Ltd");

    const imported = await request(app)
      .post("/api/purchase-orders/import")
      .set(authHeader(bdToken))
      .send({
        rows: [
          { poNumber: "PO-IMPORT-1001", customerName: "Already Known Customer Ltd", orderDate: "2026-08-01", productName: "Whey Protein", quantity: 500, unit: "KG" },
          { poNumber: "PO-IMPORT-1001", customerName: "Already Known Customer Ltd", productName: "Multivitamin Capsules", quantity: 2000, unit: "SKU" },
          { poNumber: "PO-IMPORT-1002", customerName: "Brand New Customer Pvt Ltd", productName: "Omega-3 Softgels", quantity: 1000, unit: "SKU" },
        ],
      });
    expect(imported.status).toBe(201);
    expect(imported.body.posCreated).toBe(2);
    expect(imported.body.itemsCreated).toBe(3);
    expect(imported.body.customersCreated).toBe(1); // only "Brand New Customer" — the other already existed
    expect(imported.body.skippedExisting).toEqual([]);

    const po1 = await prisma.purchaseOrder.findFirst({ where: { poNumber: "PO-IMPORT-1001" }, include: { items: true, customer: true } });
    expect(po1!.items).toHaveLength(2); // both rows landed on the same PO
    expect(po1!.customerId).toBe(existingCustomer.id); // matched by name, not duplicated
    expect(po1!.status).toBe("DRAFT"); // same review step as the manual form

    const po2 = await prisma.purchaseOrder.findFirst({ where: { poNumber: "PO-IMPORT-1002" }, include: { customer: true } });
    expect(po2!.customer.companyName).toBe("Brand New Customer Pvt Ltd");

    // Re-uploading the same PO Number is skipped, not merged/duplicated.
    const reimported = await request(app)
      .post("/api/purchase-orders/import")
      .set(authHeader(bdToken))
      .send({ rows: [{ poNumber: "PO-IMPORT-1001", customerName: "Already Known Customer Ltd", productName: "A third product", quantity: 1, unit: "KG" }] });
    expect(reimported.body.posCreated).toBe(0);
    expect(reimported.body.skippedExisting).toEqual(["PO-IMPORT-1001"]);
    const po1After = await prisma.purchaseOrder.findFirst({ where: { poNumber: "PO-IMPORT-1001" }, include: { items: true } });
    expect(po1After!.items).toHaveLength(2); // unchanged — the skip didn't touch it
  });

  it("rejects an empty rows array", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const res = await request(app).post("/api/purchase-orders/import").set(authHeader(bdToken)).send({ rows: [] });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/purchase-orders/:id/review", () => {
  it("starts DRAFT, is restricted to BD, requires a reason to reject, and can't be re-reviewed", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken);
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, items: [{ productName: "Medicine A", quantity: 10, unit: "KG" }] });
    expect(po.body.status).toBe("DRAFT");

    const { token: ppicToken } = await createUser(["PPIC"]);
    const denied = await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(ppicToken)).send({ status: "APPROVED" });
    expect(denied.status).toBe(403);

    const noReason = await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "REJECTED" });
    expect(noReason.status).toBe(400);

    const approved = await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("APPROVED");
    expect(approved.body.reviewedBy.id).toBeTruthy();

    const reReview = await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "REJECTED", rejectionReason: "changed my mind" });
    expect(reReview.status).toBe(400);
  });

  it("two BD users reviewing the same DRAFT PO at once: exactly one decision lands, the other gets a clean 409", async () => {
    const { token: bdToken1 } = await createUser(["BD"]);
    const { token: bdToken2 } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken1);
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken1))
      .send({ customerId: customer.id, items: [{ productName: "Medicine A", quantity: 10, unit: "KG" }] });

    const [a, b] = await Promise.all([
      request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken1)).send({ status: "APPROVED" }),
      request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken2)).send({ status: "REJECTED", rejectionReason: "changed my mind" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const final = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authHeader(bdToken1));
    // Whichever landed, the PO is in exactly one final state, not some blend of both.
    expect(["APPROVED", "REJECTED"]).toContain(final.body.status);
  });

  it("rejects with a reason recorded", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken);
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, items: [{ productName: "Medicine A", quantity: 10, unit: "KG" }] });

    const rejected = await request(app)
      .patch(`/api/purchase-orders/${po.body.id}/review`)
      .set(authHeader(bdToken))
      .send({ status: "REJECTED", rejectionReason: "Pricing doesn't match the quote." });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("REJECTED");
    expect(rejected.body.rejectionReason).toMatch(/Pricing/);
  });
});

describe("PO line items — Add More / edit / remove", () => {
  it("supports adding, editing, and removing a line item", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken);
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, items: [{ productName: "Medicine A", quantity: 10, unit: "KG" }] });

    const added = await request(app)
      .post(`/api/purchase-orders/${po.body.id}/items`)
      .set(authHeader(bdToken))
      .send({ productName: "Medicine C", quantity: 30, unit: "SKU" });
    expect(added.status).toBe(201);

    const edited = await request(app).patch(`/api/purchase-orders/${po.body.id}/items/${added.body.id}`).set(authHeader(bdToken)).send({ quantity: 45 });
    expect(edited.status).toBe(200);
    expect(edited.body.quantity).toBe(45);

    const removed = await request(app).delete(`/api/purchase-orders/${po.body.id}/items/${added.body.id}`).set(authHeader(bdToken));
    expect(removed.status).toBe(204);

    const detail = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authHeader(bdToken));
    expect(detail.body.items).toHaveLength(1);
  });

  it("editing an item with a PreProduction run against it is still allowed, but records the before/after and that a run exists", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const customer = await createCustomer(bdToken);
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, items: [{ productName: "Medicine A", quantity: 100, unit: "KG" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });

    const itemId = po.body.items[0].id;
    await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });

    const edited = await request(app).patch(`/api/purchase-orders/${po.body.id}/items/${itemId}`).set(authHeader(bdToken)).send({ quantity: 60 });
    expect(edited.status).toBe(200); // allowed — only delete is locked
    expect(edited.body.quantity).toBe(60);

    const log = await prisma.auditLog.findFirst({ where: { action: "purchase_order.item_updated", entityId: po.body.id }, orderBy: { createdAt: "desc" } });
    expect(log?.metadata).toMatchObject({ before: { quantity: 100 }, after: { quantity: 60 }, hasPreProduction: true });
  });

  it("blocks removing a line item that already has a PreProduction run against it — deleting it would cascade away the run's whole history", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const customer = await createCustomer(bdToken);
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, items: [{ productName: "Medicine A", quantity: 10, unit: "KG" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });

    const itemId = po.body.items[0].id;
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    expect(run.status).toBe(201);

    const blocked = await request(app).delete(`/api/purchase-orders/${po.body.id}/items/${itemId}`).set(authHeader(bdToken));
    expect(blocked.status).toBe(409);

    // The run (and the item it hangs off) is still very much there.
    const runStillThere = await request(app).get(`/api/pre-productions/${run.body.id}`).set(authHeader(bdToken));
    expect(runStillThere.status).toBe(200);
  });
});

describe("PO document upload", () => {
  it("accepts a PDF, rejects a non-image/PDF file, and can be downloaded back", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken);
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, items: [{ productName: "Medicine A", quantity: 10, unit: "KG" }] });

    const upload = await request(app)
      .post(`/api/purchase-orders/${po.body.id}/documents`)
      .set(authHeader(bdToken))
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "po.pdf", contentType: "application/pdf" });
    expect(upload.status).toBe(201);

    const rejected = await request(app)
      .post(`/api/purchase-orders/${po.body.id}/documents`)
      .set(authHeader(bdToken))
      .attach("file", Buffer.from("not a pdf or image"), { filename: "notes.txt", contentType: "text/plain" });
    expect(rejected.status).toBe(400);

    const download = await request(app).get(`/api/purchase-orders/${po.body.id}/documents/${upload.body.id}/download`).set(authHeader(bdToken));
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toBe("application/pdf");
  });
});

describe("GET /api/purchase-orders/:id/export.pdf", () => {
  it("generates a printable PDF of the PO, open to any authenticated user, at any status", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken);
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber: "PO-2001", items: [{ productName: "Medicine A", quantity: 10, unit: "KG" }] });
    expect(po.body.status).toBe("DRAFT");

    const { token: ppicToken } = await createUser(["PPIC"]);
    const exported = await request(app).get(`/api/purchase-orders/${po.body.id}/export.pdf`).set(authHeader(ppicToken));
    expect(exported.status).toBe(200);
    expect(exported.headers["content-type"]).toBe("application/pdf");
    expect(exported.headers["content-disposition"]).toContain("FLS_PO_PO-2001.pdf");
    expect(Buffer.isBuffer(exported.body) || exported.body instanceof Uint8Array).toBe(true);
  });

  it("404s for an unknown PO", async () => {
    const { token } = await createUser(["BD"]);
    const res = await request(app).get("/api/purchase-orders/00000000-0000-0000-0000-000000000000/export.pdf").set(authHeader(token));
    expect(res.status).toBe(404);
  });
});

describe("PO completion — days taken from order date to every item's lot reaching Dispatch Plan", () => {
  it("isCompleted stays false until every item's CombinedLot reaches DISPATCH_PLAN; then completionDate/daysTaken compute off the latest dispatch date", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: dispatchToken } = await createUser(["DISPATCH"]);
    const { token: adminToken } = await createUser(["ADMIN"]);
    const customer = await createCustomer(bdToken, "Completion Test Customer");

    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({
        customerId: customer.id,
        poNumber: "PO-COMPLETION-1001",
        orderDate: "2026-08-01",
        items: [
          { productName: "Medicine A", quantity: 10, unit: "KG" },
          { productName: "Medicine B", quantity: 5, unit: "KG" },
        ],
      });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    expect(po.body.completion).toEqual({ isCompleted: false, completionDate: null, daysTaken: null }); // no production started yet at all

    const itemA = po.body.items[0].id;
    const itemB = po.body.items[1].id;
    const tokens = { production: productionToken, admin: adminToken };
    const lotA = await walkToDispatchPlan(itemA, 10, tokens);
    // Item B deliberately left behind — no production started on it at all.
    void itemB;

    // Lot A ships — PO still isn't complete, B hasn't even started.
    await request(app).patch(`/api/combined-lots/${lotA}/stage`).set(authHeader(dispatchToken)).send({ action: "FORWARD", dispatchDate: "2026-08-10" });
    const stillOpen = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authHeader(bdToken));
    expect(stillOpen.body.completion.isCompleted).toBe(false);

    // B starts, reaches Dispatch Plan and ships later — that's what completes the PO.
    const lotB = await walkToDispatchPlan(itemB, 5, tokens);
    await request(app).patch(`/api/combined-lots/${lotB}/stage`).set(authHeader(dispatchToken)).send({ action: "FORWARD", dispatchDate: "2026-08-15" });

    const completed = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authHeader(bdToken));
    expect(completed.body.completion.isCompleted).toBe(true);
    expect(completed.body.completion.completionDate.slice(0, 10)).toBe("2026-08-15"); // the later of the two dispatch dates, not the earlier
    expect(completed.body.completion.daysTaken).toBe(14); // Aug 1 -> Aug 15

    // Same number shows up in the list endpoint, not just the detail one.
    const list = await request(app).get("/api/purchase-orders?pageSize=200").set(authHeader(bdToken));
    const listRow = list.body.find((p: { id: string }) => p.id === po.body.id);
    expect(listRow.completion).toEqual(completed.body.completion);
  });
});

// Per the client: one consolidated commercial invoice for the whole PO,
// not one per batch — Price per Pouch (from each item's own RM Costing
// plan) x estimated pouches actually shipped, summed across every item.
describe("GET/POST /api/purchase-orders/:id/billing — PO-level consolidated invoice", () => {
  it("computes Price/Pouch x estimated-pouches-shipped per item, sums into one total, and lets Accounts save it as a real invoice", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { token: dispatchToken } = await createUser(["DISPATCH"]);
    const { token: purchaseToken } = await createUser(["PURCHASE"]);
    const { token: accountsToken } = await createUser(["ACCOUNTS"]);
    const { token: rndToken } = await createUser(["RND"]);

    // A priceable item — a real Recipe (RM Costing auto-matches by name,
    // Kg-unit only) so Generate calculates a real packSizeG/pricePerPouch.
    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({ recipes: [{ name: "Billing Test Whey", ingredients: [{ name: "Whey Isolate", brand: "TestBrand", costPerKg: 600, gPerServing: 25, proteinPct: 0.9 }] }] });

    const customer = await createCustomer(bdToken, "Billing Test Customer");
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({
        customerId: customer.id,
        poNumber: "PO-BILL-1001",
        items: [
          { productName: "Billing Test Whey", quantity: 100, unit: "Kg" }, // priceable
          { productName: "Billing Test Unpriced Product", quantity: 50, unit: "Kg" }, // no Recipe — stays unpriced
        ],
      });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    const pricedItemId = po.body.items[0].id;
    const unpricedItemId = po.body.items[1].id;

    // Generate — auto-matches the Recipe, calculates immediately.
    const rmPlan = await request(app).post("/api/rm-costing/plans").set(authHeader(bdToken)).send({ name: "Billing Test — RM", purchaseOrderItemId: pricedItemId });
    expect(rmPlan.body.status).toBe("CALCULATED");
    const packSizeG = rmPlan.body.result.batches[0].packSizeG;
    const pricePerPouch = rmPlan.body.result.batches[0].pricePerPouch;
    expect(packSizeG).toBeGreaterThan(0);
    expect(pricePerPouch).toBeGreaterThan(0);

    // Production run for the priced item, jumped straight to Dispatch Plan
    // with a real dispatchedQty (Kg — same unit as the PO item, not pouches).
    const lotId = await walkToDispatchPlan(pricedItemId, 100, { production: productionToken, admin: adminToken });
    await request(app).patch(`/api/combined-lots/${lotId}/stage`).set(authHeader(dispatchToken)).send({ action: "FORWARD", dispatchDate: "2026-09-10", dispatchedQty: 85 });

    // Denied roles first.
    const deniedGet = await request(app).get(`/api/purchase-orders/${po.body.id}/billing`).set(authHeader(bdToken));
    expect(deniedGet.status).toBe(403);
    const deniedGenerate = await request(app).post(`/api/purchase-orders/${po.body.id}/billing`).set(authHeader(purchaseToken)).send({});
    expect(deniedGenerate.status).toBe(403); // Purchase can preview, not commit

    const preview = await request(app).get(`/api/purchase-orders/${po.body.id}/billing`).set(authHeader(purchaseToken));
    expect(preview.status).toBe(200);
    expect(preview.body.invoice).toBeNull(); // nothing saved yet

    const pricedLine = preview.body.lines.find((l: { purchaseOrderItemId: string }) => l.purchaseOrderItemId === pricedItemId);
    const unpricedLine = preview.body.lines.find((l: { purchaseOrderItemId: string }) => l.purchaseOrderItemId === unpricedItemId);

    // 85 Kg dispatched -> pouches via packSizeG, x pricePerPouch.
    const expectedPouches = Math.round(((85 * 1000) / packSizeG) * 100) / 100;
    const expectedAmount = Math.round(expectedPouches * pricePerPouch * 100) / 100;
    expect(pricedLine).toMatchObject({ dispatchedQtyKg: 85, packSizeG, pricePerPouch, priced: true });
    expect(pricedLine.estimatedPouches).toBeCloseTo(expectedPouches, 2);
    expect(pricedLine.amount).toBeCloseTo(expectedAmount, 2);

    // The unpriced item (no RM Costing plan at all) carries a null amount
    // — never guessed at — and doesn't count toward the total.
    expect(unpricedLine).toMatchObject({ dispatchedQtyKg: 0, packSizeG: null, pricePerPouch: null, estimatedPouches: null, amount: null, priced: false });
    expect(preview.body.totalAmount).toBeCloseTo(expectedAmount, 2);

    // Accounts commits it as a real, saved invoice.
    const generated = await request(app)
      .post(`/api/purchase-orders/${po.body.id}/billing`)
      .set(authHeader(accountsToken))
      .send({ invoiceNo: "INV-PO-1001", invoiceDate: "2026-09-11" });
    expect(generated.status).toBe(201);
    expect(generated.body.invoice).toMatchObject({ invoiceNo: "INV-PO-1001", totalAmount: preview.body.totalAmount });
    expect(generated.body.invoice.generatedBy.fullName).toBeTruthy();

    // A later preview now shows the saved invoice alongside the live recompute.
    const afterSave = await request(app).get(`/api/purchase-orders/${po.body.id}/billing`).set(authHeader(accountsToken));
    expect(afterSave.body.invoice.invoiceNo).toBe("INV-PO-1001");
  });
});
