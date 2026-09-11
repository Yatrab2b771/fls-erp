import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

/** Creates a customer + PO (DRAFT, one line item), approves it as BD, and returns the PO + its one item's id. */
async function createApprovedPo(bdToken: string, poNumber: string, quantity: number, unit: string) {
  const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: `Customer for ${poNumber}` });
  const po = await request(app)
    .post("/api/purchase-orders")
    .set(authHeader(bdToken))
    .send({ customerId: customer.body.id, poNumber, items: [{ productName: "Recon Product", quantity, unit }] });
  await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
  return { poId: po.body.id as string, itemId: po.body.items[0].id as string };
}

// Phase G — one PO item's full three-tier run walked through the entire
// pipeline with real quantities at every split point (Dispensing's 3-way
// consumption, the QC Sample lifecycle, both QA gates' Approved/
// Rejected/Wastage split, Dispatch's own recorded qty), then read back
// through the one PO-level rollup — confirms every number lands in the
// right bucket, not just that the pipeline walk itself succeeds.
describe("GET /api/purchase-orders/:id/reconciliation", () => {
  it("rolls up dispensed/sample/QA-gate/dispatch numbers across a PO's production run, matching every split exactly", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: accountsToken } = await createUser(["ACCOUNTS"]);
    const { token: dispatchToken } = await createUser(["DISPATCH"]);

    const { poId, itemId } = await createApprovedPo(bdToken, "PO-RECON-1001", 100, "Kg");

    const run = await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: itemId });
    const runId = run.body.id;

    // Get real stock into this run's Plant — same Material Request ->
    // approve -> issue flow every other Dispensing test in this suite uses.
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Recon Protein" });
    await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-08-01", unit: "Kg", quantity: 100, isOpeningStock: true });
    const plant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Recon Plant" });
    await request(app).patch(`/api/pre-productions/${runId}/plant`).set(authHeader(ppicToken)).send({ plantId: plant.body.id });
    const mr = await request(app)
      .post("/api/inventory/requests")
      .set(authHeader(ppicToken))
      .send({ itemId: item.body.id, category: "RM", requestedQty: 100, purpose: "ISSUED_PRODUCTION", plantId: plant.body.id });
    await request(app).patch(`/api/inventory/requests/${mr.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
    await request(app).post(`/api/inventory/requests/${mr.body.id}/issue`).set(authHeader(storeToken)).send({ date: "2026-08-01", unit: "Kg", quantity: 100, dayStoreId: null });

    // Walk to Dispensing.
    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD" }); // -> INDENT_ISSUE
    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(ppicToken)).send({ action: "FORWARD" }); // -> LINE_CLEARANCE
    await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", lineClearanceStatus: "Approved" }); // -> DISPENSING

    // The 3-way split: 70 Production, 20 Sample, 10 Waste (all 100 Kg accounted for).
    const dispensed = await request(app)
      .patch(`/api/pre-productions/${runId}/stage`)
      .set(authHeader(storeToken))
      .send({
        action: "FORWARD",
        consumption: [
          { itemId: item.body.id, quantity: 70, unit: "Kg", purpose: "PRODUCTION" },
          { itemId: item.body.id, quantity: 20, unit: "Kg", purpose: "SAMPLE" },
          { itemId: item.body.id, quantity: 10, unit: "Kg", purpose: "WASTE" },
        ],
      });
    expect(dispensed.status).toBe(200);
    expect(dispensed.body.currentStageId).toBe("SAMPLE_QC_APPROVAL");

    // QC confirms the auto-sent sample, tests part of it, rejects the rest.
    const pending = await request(app).get(`/api/qc-sample/pre-productions/${runId}/transfers?status=PENDING`).set(authHeader(qaToken));
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0]).toMatchObject({ direction: "TO_QC", quantity: 20, unit: "Kg" });
    const confirmed = await request(app).post(`/api/qc-sample/pre-productions/${runId}/transfers/${pending.body[0].id}/confirm`).set(authHeader(qaToken));
    expect(confirmed.status).toBe(200);

    await request(app).post(`/api/qc-sample/pre-productions/${runId}/consume`).set(authHeader(qaToken)).send({ itemId: item.body.id, quantity: 15, unit: "Kg", consumeReason: "TESTING" });
    await request(app).post(`/api/qc-sample/pre-productions/${runId}/consume`).set(authHeader(qaToken)).send({ itemId: item.body.id, quantity: 5, unit: "Kg", consumeReason: "REJECTED" });

    const sampleQc = await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", sampleQcStatus: "Approved" });
    expect(sampleQc.status).toBe(200);
    expect(sampleQc.body.currentStageId).toBe("SAMPLE_QC_APPROVAL"); // completes in place

    // Tier 2 — one ProductionBatch covering the whole planned 100 Kg,
    // completed with no self-reported wastage so combinedQty reaches
    // plannedQty and the CombinedLot is created automatically.
    const pb = (await request(app).post(`/api/pre-productions/${runId}/production-batches`).set(authHeader(productionToken)).send({ plannedQty: 100 })).body;
    await request(app)
      .patch(`/api/production-batches/${pb.id}`)
      .set(authHeader(productionToken))
      .send({ manufacturingStartDate: "2026-08-05", manufacturingEndDate: "2026-08-06", manufacturingStatus: "Completed", inputQty: 100, outputQty: 100 });
    const completed = await request(app).post(`/api/production-batches/${pb.id}/complete`).set(authHeader(productionToken));
    expect(completed.status).toBe(200);
    const lot = completed.body.combinedLot as { id: string; currentStageId: string };
    expect(lot).not.toBeNull();
    expect(lot.currentStageId).toBe("IPQC");

    await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", ipqcStatus: "Approved" }); // -> QA_GATE_MFG

    // QA Gate Mfg — the Approved/Rejected/Wastage split (Phase F).
    const mfgGate = await request(app)
      .patch(`/api/combined-lots/${lot.id}/stage`)
      .set(authHeader(qaToken))
      .send({ action: "FORWARD", mfgQaStatus: "Approved", mfgQcStatus: "Approved", mfgApprovedQty: 60, mfgRejectedQty: 3, mfgWastageQty: 2 });
    expect(mfgGate.status).toBe(200);
    expect(mfgGate.body.currentStageId).toBe("BULK_QC");
    expect(mfgGate.body.mfgWastageQty).toBe(2);

    await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", bulkQcStatus: "Approved" }); // -> PACKAGING

    // Packaging, then QA Gate Packaging — same split, its own numbers.
    await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(productionToken)).send({ action: "FORWARD", packagingStatus: "Completed" }); // -> QA_GATE_PACKAGING
    const packGate = await request(app)
      .patch(`/api/combined-lots/${lot.id}/stage`)
      .set(authHeader(qaToken))
      .send({ action: "FORWARD", packQaStatus: "Approved", packQcStatus: "Approved", packApprovedQty: 55, packRejectedQty: 3, packWastageQty: 2 });
    expect(packGate.status).toBe(200);
    expect(packGate.body.currentStageId).toBe("BILLING_EWAY_BILL");

    // Both gates' Wastage buckets landed in the Recycle Store's own
    // per-lot ledger — one row per gate that actually cleared.
    const lotDetail = await request(app).get(`/api/combined-lots/${lot.id}`).set(authHeader(storeToken));
    expect(lotDetail.body.recycleLogs).toHaveLength(2);
    expect(lotDetail.body.recycleLogs.map((r: { stageId: string; quantity: number; unit: string }) => ({ stageId: r.stageId, quantity: r.quantity, unit: r.unit }))).toEqual(
      expect.arrayContaining([
        { stageId: "QA_GATE_MFG", quantity: 2, unit: "Kg" },
        { stageId: "QA_GATE_PACKAGING", quantity: 2, unit: "Kg" },
      ]),
    );

    await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(accountsToken)).send({ action: "FORWARD" }); // -> DISPATCH_PLAN
    const dispatched = await request(app).patch(`/api/combined-lots/${lot.id}/stage`).set(authHeader(dispatchToken)).send({ action: "FORWARD", dispatchedQty: 50, dispatchDate: "2026-08-10" });
    expect(dispatched.status).toBe(200);

    // The whole point of Phase G: one call rolls all of the above up,
    // per PO line item, with a totals row on top.
    const recon = await request(app).get(`/api/purchase-orders/${poId}/reconciliation`).set(authHeader(bdToken));
    expect(recon.status).toBe(200);
    expect(recon.body.items).toHaveLength(1);
    const row = recon.body.items[0];
    expect(row).toMatchObject({
      purchaseOrderItemId: itemId,
      productName: "Recon Product",
      orderedQty: 100,
      unit: "Kg",
      currentStageId: "DISPATCH_PLAN",
      plannedQtyTotal: 100,
      dispensedProduction: 70,
      dispensedSample: 20,
      dispensedWaste: 10,
      sampleSentToQc: 20,
      sampleTestingQty: 15,
      sampleWastageQty: 0,
      sampleRejectedQty: 5,
      outputQty: 100,
      mfgRejectedQty: 3,
      mfgWastageQty: 2,
      packRejectedQty: 3,
      packWastageQty: 2,
      dispatchedQty: 50,
    });
    expect(row.productionBatches).toHaveLength(1);
    expect(row.productionBatches[0]).toMatchObject({ batchId: pb.id, outputQty: 100 });

    // Single-item PO — the totals row is identical to that one row.
    const { productionBatches: _pbs, purchaseOrderItemId: _id, productName: _pn, orderedQty: _oq, unit: _u, currentStageId: _cs, ...rowTotals } = row;
    expect(recon.body.totals).toEqual(rowTotals);
  });

  it("404s for an unknown PO", async () => {
    const { token } = await createUser(["BD"]);
    const res = await request(app).get("/api/purchase-orders/00000000-0000-0000-0000-000000000000/reconciliation").set(authHeader(token));
    expect(res.status).toBe(404);
  });

  it("an item with no production started yet reports zeroes, not an error", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { poId, itemId } = await createApprovedPo(bdToken, "PO-RECON-EMPTY", 25, "Kg");

    const recon = await request(app).get(`/api/purchase-orders/${poId}/reconciliation`).set(authHeader(bdToken));
    expect(recon.status).toBe(200);
    expect(recon.body.items).toHaveLength(1);
    expect(recon.body.items[0]).toMatchObject({ purchaseOrderItemId: itemId, orderedQty: 25, currentStageId: null, plannedQtyTotal: 0, dispatchedQty: 0 });
    expect(recon.body.totals.dispatchedQty).toBe(0);
  });
});
