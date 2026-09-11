import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

async function createApprovedPoItem(bdToken: string, poNumber: string) {
  const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: `Customer for ${poNumber}` });
  const po = await request(app)
    .post("/api/purchase-orders")
    .set(authHeader(bdToken))
    .send({ customerId: customer.body.id, poNumber, items: [{ productName: "Transit Product", quantity: 100, unit: "Kg" }] });
  await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
  return po.body.items[0].id as string;
}

// GET /api/inventory/transit — one combined "still open" feed across
// every kind of internal movement. Covers the QC Sample leg added
// alongside Phase F/G (a PreProduction run's Dispensing-time
// SAMPLE-purpose consumption auto-creates a QcSampleTransfer, which is
// exactly the kind of "in transit, pending confirmation" state this
// endpoint exists to surface — it was missing from here before, even
// though the underlying pipeline already worked).
describe("GET /api/inventory/transit", () => {
  it("is restricted to STORE/PPIC/PRODUCTION/QA_QC/RND", async () => {
    const { token: plainToken } = await createUser([]);
    const denied = await request(app).get("/api/inventory/transit").set(authHeader(plainToken));
    expect(denied.status).toBe(403);

    const { token: storeToken } = await createUser(["STORE"]);
    const ok = await request(app).get("/api/inventory/transit").set(authHeader(storeToken));
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);
  });

  it("surfaces a pending QC Sample transfer (kind: qc_sample), traced back to its run/product, and drops it once confirmed", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);

    const itemId = await createApprovedPoItem(bdToken, "PO-TRANSIT-1001");
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    const runId = run.body.id;

    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Transit Protein" });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 50, isOpeningStock: true });
    const plant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Transit Plant" });
    await request(app).patch(`/api/pre-productions/${runId}/plant`).set(authHeader(ppicToken)).send({ plantId: plant.body.id });
    const mr = await request(app)
      .post("/api/inventory/requests")
      .set(authHeader(ppicToken))
      .send({ itemId: item.body.id, category: "RM", requestedQty: 50, purpose: "ISSUED_PRODUCTION", plantId: plant.body.id });
    await request(app).patch(`/api/inventory/requests/${mr.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
    await request(app).post(`/api/inventory/requests/${mr.body.id}/issue`).set(authHeader(storeToken)).send({ date: "2026-08-01", unit: "Kg", quantity: 50, dayStoreId: null });

    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD" }); // -> INDENT_ISSUE
    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(ppicToken)).send({ action: "FORWARD" }); // -> LINE_CLEARANCE
    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", lineClearanceStatus: "Approved" }); // -> DISPENSING

    const dispensed = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(storeToken))
      .send({ action: "FORWARD", consumption: [{ itemId: item.body.id, quantity: 15, unit: "Kg", purpose: "SAMPLE" }] });
    expect(dispensed.status).toBe(200);
    expect(dispensed.body.currentStageId).toBe("SAMPLE_QC_APPROVAL");

    const beforeConfirm = await request(app).get("/api/inventory/transit").set(authHeader(qaToken));
    const qcRow = beforeConfirm.body.find((r: { kind: string }) => r.kind === "qc_sample");
    expect(qcRow).toBeTruthy();
    expect(qcRow).toMatchObject({
      item: expect.objectContaining({ name: "Transit Protein" }),
      quantity: 15,
      unit: "Kg",
      from: "Plant",
      to: "QC",
      confirmPath: null,
      linkPath: `/pre-productions/${runId}`,
      productName: "Transit Product",
    });

    const transferId = qcRow.id;
    const confirmed = await request(app).post(`/api/qc-sample/pre-productions/${runId}/transfers/${transferId}/confirm`).set(authHeader(qaToken));
    expect(confirmed.status).toBe(200);

    const afterConfirm = await request(app).get("/api/inventory/transit").set(authHeader(qaToken));
    expect(afterConfirm.body.some((r: { kind: string; id: string }) => r.kind === "qc_sample" && r.id === transferId)).toBe(false);
  });
});
