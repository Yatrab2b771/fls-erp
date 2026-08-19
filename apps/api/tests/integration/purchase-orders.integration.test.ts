import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

async function createCustomer(token: string, companyName = "Acme Nutrition Pvt. Ltd.") {
  const res = await request(app).post("/api/customers").set(authHeader(token)).send({ companyName });
  return res.body;
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
