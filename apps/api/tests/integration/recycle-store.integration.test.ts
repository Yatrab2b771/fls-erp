import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

async function createApprovedPoItem(bdToken: string) {
  const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Recycle Store Customer" });
  const po = await request(app)
    .post("/api/purchase-orders")
    .set(authHeader(bdToken))
    .send({ customerId: customer.body.id, poNumber: "PO-RECYCLE-1001", items: [{ productName: "Recycle Product", quantity: 100, unit: "Kg" }] });
  await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
  return po.body.items[0].id as string;
}

// Recycle Store — a read-only combined view over the two waste ledgers
// (real RM/PM spill at Dispensing, traced to a PreProduction run, and a
// QA gate's own Wastage bucket, traced to a CombinedLot — see
// recycle-store.routes.ts). Nothing here is created by this module
// itself; both entries below are produced automatically by the pipeline
// (pre-production-transition.ts / combined-lot-transition.ts) — this
// just confirms they land in the combined report correctly.
describe("Recycle Store", () => {
  it("is restricted to STORE/PRODUCTION/QA_QC/PPIC (ADMIN bypasses); a plain user is denied", async () => {
    const { token: plainToken } = await createUser([]);
    const denied = await request(app).get("/api/recycle-store/transactions").set(authHeader(plainToken));
    expect(denied.status).toBe(403);

    const { token: storeToken } = await createUser(["STORE"]);
    const ok = await request(app).get("/api/recycle-store/transactions").set(authHeader(storeToken));
    expect(ok.status).toBe(200);

    const { token: adminToken } = await createUser(["ADMIN"]);
    const okAdmin = await request(app).get("/api/recycle-store/transactions").set(authHeader(adminToken));
    expect(okAdmin.status).toBe(200);
  });

  it("combines a real RM/PM Dispensing spill and a QA gate's Wastage entry into one feed, and reports each split by item/by lot", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const { token: adminToken } = await createUser(["ADMIN"]);

    const itemId = await createApprovedPoItem(bdToken);
    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    const runId = run.body.id;

    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Recycle Protein" });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 50, isOpeningStock: true });
    const plant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Recycle Plant" });
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

    // 40 Production, 10 Waste — the WASTE leg is the real RM/PM spill this
    // module should pick up.
    const dispensed = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(storeToken))
      .send({
        action: "FORWARD",
        consumption: [
          { itemId: item.body.id, quantity: 40, unit: "Kg", purpose: "PRODUCTION" },
          { itemId: item.body.id, quantity: 10, unit: "Kg", purpose: "WASTE" },
        ],
      });
    expect(dispensed.status).toBe(200);
    expect(dispensed.body.currentStageId).toBe("SAMPLE_QC_APPROVAL");

    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", sampleQcStatus: "Approved" });

    const pb = (await request(app).post(`/api/pre-productions/${runId}/production-batches`).set(authHeader(productionToken)).send({ plannedQty: 100 })).body;
    await request(app).patch(`/api/production-batches/${pb.id}`).set(authHeader(productionToken)).send({ outputQty: 100 });
    const completed = await request(app).post(`/api/production-batches/${pb.id}/complete`).set(authHeader(productionToken));
    const lotId = completed.body.combinedLot.id as string;
    await request(app).patch(`/api/combined-lots/${lotId}/stage`).set(authHeader(adminToken)).send({ action: "JUMP", targetStageId: "QA_GATE_MFG" });

    const mfgGate = await request(app)
      .patch(`/api/combined-lots/${lotId}/stage`)
      .set(authHeader(qaToken))
      .send({ action: "FORWARD", mfgQaStatus: "Approved", mfgQcStatus: "Approved", mfgWastageQty: 3 });
    expect(mfgGate.status).toBe(200);

    // The combined feed sees both entries, correctly kind-tagged and
    // traced back to the same PO/product.
    const feed = await request(app).get("/api/recycle-store/transactions").set(authHeader(storeToken));
    expect(feed.status).toBe(200);
    const materialEntry = feed.body.find((r: { kind: string }) => r.kind === "material");
    const lotOutputEntry = feed.body.find((r: { kind: string }) => r.kind === "batch_output");
    expect(materialEntry).toMatchObject({ itemName: "Recycle Protein", category: "RM", quantity: 10, unit: "Kg", plantName: "Recycle Plant", productName: "Recycle Product", poNumber: "PO-RECYCLE-1001" });
    expect(lotOutputEntry).toMatchObject({ stageLabel: "QA Gate — Manufacturing", quantity: 3, unit: "Kg", productName: "Recycle Product", poNumber: "PO-RECYCLE-1001" });

    const byItem = await request(app).get("/api/recycle-store/by-item").set(authHeader(storeToken));
    expect(byItem.status).toBe(200);
    expect(byItem.body).toContainEqual(expect.objectContaining({ itemName: "Recycle Protein", category: "RM", unit: "Kg", totalQty: 10, entryCount: 1 }));

    const byBatch = await request(app).get("/api/recycle-store/by-batch").set(authHeader(storeToken));
    expect(byBatch.status).toBe(200);
    expect(byBatch.body).toContainEqual(
      expect.objectContaining({ combinedLotId: lotId, stageId: "QA_GATE_MFG", stageLabel: "QA Gate — Manufacturing", unit: "Kg", totalQty: 3, entryCount: 1, poNumber: "PO-RECYCLE-1001" }),
    );
  });
});
