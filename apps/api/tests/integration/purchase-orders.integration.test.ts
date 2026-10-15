import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser, BATCH_START } from "./helpers";
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
  await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { planSentToProductionAt: new Date() } }); // PPIC has sent the plan to Production
  const run = (await request(app).post("/api/pre-productions").set(authHeader(tokens.production)).send({ purchaseOrderItemId: itemId })).body;
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.admin)).send({ action: "JUMP", targetStageId: "SAMPLE_QC_APPROVAL" });
  // JUMP only moves currentStageId — it doesn't set sampleQcStatus, and
  // Production can't start until that's literally "Approved" (see
  // production-batches.routes.ts's own gate), so a real FORWARD still
  // has to set it even after an admin jump. ADMIN bypasses the stage's
  // own department check, same as JUMP does.
  await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(tokens.admin)).send({ action: "FORWARD", sampleQcStatus: "Approved" });
  const pb = (await request(app).post(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(tokens.production)).send({ ...BATCH_START, plannedQty })).body;
  await request(app).patch(`/api/production-batches/${pb.id}`).set(authHeader(tokens.production)).send({ outputQty: plannedQty });
  await request(app).post(`/api/production-batches/${pb.id}/complete`).set(authHeader(tokens.production));
  // Every batch is packed, released and dispatched on its own now (no pooled lot): bring it straight to its Dispatch Plan.
  await prisma.productionBatch.update({ where: { id: pb.id }, data: { currentStageId: "DISPATCH_PLAN" } });
  return pb.id as string;
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
          { productName: "Medicine A", productCategory: "Powder", quantity: 100, unit: "KG" },
          { productName: "Medicine B", productCategory: "Powder", quantity: 50, unit: "SKU", volume: 25 },
        ],
      });
    expect(created.status).toBe(201);
    expect(created.body.items).toHaveLength(2);
    const medicineB = created.body.items.find((i: { productName: string }) => i.productName === "Medicine B");
    expect(medicineB.volume).toBe(25);
  });
});

describe("PO visibility — only BD/Admin see Draft and Rejected POs", () => {
  it("hides Draft and Rejected POs from every other department, and shows a PO to PPIC the moment BD approves it", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: adminToken } = await createUser(["ADMIN"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: regToken } = await createUser(["REGULATORY"]);
    const customer = await createCustomer(bdToken);

    const make = async (poNumber: string) =>
      (
        await request(app)
          .post("/api/purchase-orders")
          .set(authHeader(bdToken))
          .send({ customerId: customer.id, poNumber, items: [{ productName: "Vis Product", productCategory: "Powder", quantity: 10, unit: "KG" }] })
      ).body as { id: string };
    const draft = await make("PO-VIS-DRAFT");
    const rejected = await make("PO-VIS-REJECTED");
    const approved = await make("PO-VIS-APPROVED");
    await request(app).patch(`/api/purchase-orders/${rejected.id}/review`).set(authHeader(bdToken)).send({ status: "REJECTED", rejectionReason: "wrong qty" });
    await request(app).patch(`/api/purchase-orders/${approved.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });

    const numbers = async (token: string) => ((await request(app).get("/api/purchase-orders").set(authHeader(token))).body as { poNumber: string }[]).map((p) => p.poNumber).sort();

    // BD and Admin see all three; everyone else only the approved one.
    expect(await numbers(bdToken)).toEqual(["PO-VIS-APPROVED", "PO-VIS-DRAFT", "PO-VIS-REJECTED"]);
    expect(await numbers(adminToken)).toEqual(["PO-VIS-APPROVED", "PO-VIS-DRAFT", "PO-VIS-REJECTED"]);
    expect(await numbers(ppicToken)).toEqual(["PO-VIS-APPROVED"]);
    expect(await numbers(regToken)).toEqual(["PO-VIS-APPROVED"]);

    // A direct link / PDF / report of an unapproved PO 404s for PPIC, works for BD.
    for (const po of [draft, rejected]) {
      for (const path of ["", "/export.pdf", "/full-report", "/reconciliation"]) {
        expect((await request(app).get(`/api/purchase-orders/${po.id}${path}`).set(authHeader(ppicToken))).status, `PPIC GET ${path} on unapproved PO`).toBe(404);
      }
    }
    expect((await request(app).get(`/api/purchase-orders/${draft.id}`).set(authHeader(bdToken))).status).toBe(200);
    expect((await request(app).get(`/api/purchase-orders/${draft.id}`).set(authHeader(adminToken))).status).toBe(200);
    expect((await request(app).get(`/api/purchase-orders/${approved.id}`).set(authHeader(ppicToken))).status).toBe(200);

    // PPIC's own reports never include the unapproved ones either.
    const report = await request(app).get("/api/purchase-orders/reports/bd-ppic").set(authHeader(ppicToken));
    expect((report.body as { poNumber: string }[]).map((r) => r.poNumber)).toEqual(["PO-VIS-APPROVED"]);
    const bdReport = await request(app).get("/api/purchase-orders/reports/bd-ppic").set(authHeader(bdToken));
    expect((bdReport.body as { poNumber: string }[]).map((r) => r.poNumber).sort()).toEqual(["PO-VIS-APPROVED", "PO-VIS-DRAFT"]);
    const pending = await request(app).get("/api/purchase-orders/reports/pending-materials").set(authHeader(ppicToken));
    expect(JSON.stringify(pending.body)).not.toContain("PO-VIS-DRAFT");
  });

  it("blocks PPIC's planning and material requirements against a PO BD hasn't approved", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const customer = await createCustomer(bdToken);
    const draft = (
      await request(app)
        .post("/api/purchase-orders")
        .set(authHeader(bdToken))
        .send({ customerId: customer.id, poNumber: "PO-VIS-PLAN", items: [{ productName: "Plan Product", productCategory: "Powder", quantity: 10, unit: "KG" }] })
    ).body as { id: string; items: { id: string }[] };

    const bom = await request(app).post("/api/bom/plans").set(authHeader(ppicToken)).send({ name: "x", purchaseOrderItemId: draft.items[0]!.id });
    expect(bom.status).toBe(400);
    expect(bom.body.error).toMatch(/approved by BD/);
    const rm = await request(app).post("/api/rm-costing/plans").set(authHeader(ppicToken)).send({ name: "x", purchaseOrderItemId: draft.items[0]!.id });
    expect(rm.status).toBe(400);
    expect(rm.body.error).toMatch(/approved by BD/);
  });
});

describe("Product Category", () => {
  it("lists the seeded categories and lets BD add a new one, deduped case-insensitively", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);

    const list = await request(app).get("/api/purchase-orders/product-categories").set(authHeader(ppicToken));
    expect(list.status).toBe(200);
    const names = list.body.map((c: { name: string }) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Powder", "Gummies", "Bars", "Capsule", "Tablet", "Liquid"]));

    const denied = await request(app).post("/api/purchase-orders/product-categories").set(authHeader(ppicToken)).send({ name: "Softgel-Test" });
    expect(denied.status).toBe(403);

    try {
      const created = await request(app).post("/api/purchase-orders/product-categories").set(authHeader(bdToken)).send({ name: "Softgel-Test" });
      expect(created.status).toBe(201);

      const again = await request(app).post("/api/purchase-orders/product-categories").set(authHeader(bdToken)).send({ name: "softgel-test" });
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(created.body.id);
    } finally {
      await prisma.productCategory.deleteMany({ where: { name: "Softgel-Test" } });
    }
  });

  it("is required on every new PO line, must exist in the master list, and is stored with the master's spelling", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken);

    const missing = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, items: [{ productName: "No Category", quantity: 1, unit: "KG" }] });
    expect(missing.status).toBe(400);

    const unknown = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, items: [{ productName: "Bad Category", productCategory: "Nonexistent", quantity: 1, unit: "KG" }] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/Unknown Product Category/);

    const created = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, items: [{ productName: "Lowercase", productCategory: "gummies", quantity: 1, unit: "KG" }] });
    expect(created.status).toBe(201);
    expect(created.body.items[0].productCategory).toBe("Gummies");

    const added = await request(app).post(`/api/purchase-orders/${created.body.id}/items`).set(authHeader(bdToken)).send({ productName: "Second", productCategory: "Bars", quantity: 2, unit: "KG" });
    expect(added.status).toBe(201);
    expect(added.body.productCategory).toBe("Bars");

    const addedWithout = await request(app).post(`/api/purchase-orders/${created.body.id}/items`).set(authHeader(bdToken)).send({ productName: "Third", quantity: 2, unit: "KG" });
    expect(addedWithout.status).toBe(400);
  });
});

describe("POST /api/purchase-orders/import", () => {
  it("is restricted to BD", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    const denied = await request(app)
      .post("/api/purchase-orders/import")
      .set(authHeader(ppicToken))
      .send({ rows: [{ poNumber: "PO-IMPORT-1", customerName: "X", productName: "Y", productCategory: "Powder", quantity: 1, unit: "KG" }] });
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
          { poNumber: "PO-IMPORT-1001", customerName: "Already Known Customer Ltd", orderDate: "2026-08-01", productName: "Whey Protein", productCategory: "Powder", quantity: 500, unit: "KG" },
          { poNumber: "PO-IMPORT-1001", customerName: "Already Known Customer Ltd", productName: "Multivitamin Capsules", productCategory: "Powder", quantity: 2000, unit: "SKU" },
          { poNumber: "PO-IMPORT-1002", customerName: "Brand New Customer Pvt Ltd", productName: "Omega-3 Softgels", productCategory: "Powder", quantity: 1000, unit: "SKU" },
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
      .send({ rows: [{ poNumber: "PO-IMPORT-1001", customerName: "Already Known Customer Ltd", productName: "A third product", productCategory: "Powder", quantity: 1, unit: "KG" }] });
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
      .send({ customerId: customer.id, items: [{ productName: "Medicine A", productCategory: "Powder", quantity: 10, unit: "KG" }] });
    expect(po.body.status).toBe("DRAFT");

    const { token: ppicToken } = await createUser(["PPIC"]);
    // A Draft PO is invisible to PPIC (404) — it can't even reach the BD-only gate.
    const denied = await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(ppicToken)).send({ status: "APPROVED" });
    expect(denied.status).toBe(404);

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
      .send({ customerId: customer.id, items: [{ productName: "Medicine A", productCategory: "Powder", quantity: 10, unit: "KG" }] });

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
      .send({ customerId: customer.id, items: [{ productName: "Medicine A", productCategory: "Powder", quantity: 10, unit: "KG" }] });

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
      .send({ customerId: customer.id, items: [{ productName: "Medicine A", productCategory: "Powder", quantity: 10, unit: "KG" }] });

    const added = await request(app)
      .post(`/api/purchase-orders/${po.body.id}/items`)
      .set(authHeader(bdToken))
      .send({ productName: "Medicine C", productCategory: "Powder", quantity: 30, unit: "SKU" });
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
      .send({ customerId: customer.id, items: [{ productName: "Medicine A", productCategory: "Powder", quantity: 100, unit: "KG" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });

    const itemId = po.body.items[0].id;
    await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { planSentToProductionAt: new Date() } }); // PPIC has sent the plan to Production
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
      .send({ customerId: customer.id, items: [{ productName: "Medicine A", productCategory: "Powder", quantity: 10, unit: "KG" }] });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });

    const itemId = po.body.items[0].id;
    await prisma.purchaseOrderItem.update({ where: { id: itemId }, data: { planSentToProductionAt: new Date() } }); // PPIC has sent the plan to Production
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
      .send({ customerId: customer.id, items: [{ productName: "Medicine A", productCategory: "Powder", quantity: 10, unit: "KG" }] });

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
  it("generates a printable PDF of the PO: BD at any status, any other department once it's approved", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await createCustomer(bdToken);
    const po = await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber: "PO-2001", items: [{ productName: "Medicine A", productCategory: "Powder", quantity: 10, unit: "KG" }] });
    expect(po.body.status).toBe("DRAFT");

    const { token: ppicToken } = await createUser(["PPIC"]);
    // Draft: BD can print it, PPIC can't even see it.
    expect((await request(app).get(`/api/purchase-orders/${po.body.id}/export.pdf`).set(authHeader(bdToken))).status).toBe(200);
    expect((await request(app).get(`/api/purchase-orders/${po.body.id}/export.pdf`).set(authHeader(ppicToken))).status).toBe(404);

    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
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
  it("isCompleted stays false until every item's batches have dispatched its whole quantity; then completionDate/daysTaken compute off the latest dispatch date", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
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
          { productName: "Medicine A", productCategory: "Powder", quantity: 10, unit: "KG" },
          { productName: "Medicine B", productCategory: "Powder", quantity: 5, unit: "KG" },
        ],
      });
    await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    expect(po.body.completion).toEqual({ isCompleted: false, completionDate: null, daysTaken: null }); // no production started yet at all

    const itemA = po.body.items[0].id;
    const itemB = po.body.items[1].id;
    const tokens = { production: productionToken, admin: adminToken };
    const batchA = await walkToDispatchPlan(itemA, 10, tokens);
    // Item B deliberately left behind — no production started on it at all.
    void itemB;

    // Batch A ships - PO still isn't complete, B hasn't even started.
    await prisma.productionBatch.update({ where: { id: batchA }, data: { dispatchDate: new Date("2026-08-10"), dispatchedQty: 10 } });
    const stillOpen = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authHeader(bdToken));
    expect(stillOpen.body.completion.isCompleted).toBe(false);

    // B starts, reaches Dispatch Plan and ships later — that's what completes the PO.
    const batchB = await walkToDispatchPlan(itemB, 5, tokens);
    await prisma.productionBatch.update({ where: { id: batchB }, data: { dispatchDate: new Date("2026-08-15"), dispatchedQty: 5 } });

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
