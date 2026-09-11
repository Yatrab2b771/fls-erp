import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

async function createApprovedPo(bdToken: string, poNumber: string, items: { productName: string; quantity: number; unit: string }[]) {
  const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: `Customer for ${poNumber}` });
  const po = await request(app).post("/api/purchase-orders").set(authHeader(bdToken)).send({ customerId: customer.body.id, poNumber, items });
  await request(app).patch(`/api/purchase-orders/${po.body.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
  return po.body as { id: string; items: { id: string; productName: string }[] };
}

// Bulk "forward the current stage" — one row per (PO Number, Product
// Name), run through the exact same gating a manual Forward would
// (transitionPreProductionStage, shared with PATCH /:id/stage). Confirms
// the shared extraction behaves identically, and that rows are matched,
// gated, and reported correctly. PreProduction is 1:1 with a PO item now,
// so — unlike the old per-Batch version of this — a Batch No. column is
// no longer needed to disambiguate.
describe("POST /api/pre-productions/import", () => {
  it("forwards multiple runs at different stages in one call, each through its own department's gate", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: storeToken } = await createUser(["STORE"]);

    const poA = await createApprovedPo(bdToken, "PO-IMPORT-A", [{ productName: "Import Product A", quantity: 50, unit: "KG" }]);
    const poB = await createApprovedPo(bdToken, "PO-IMPORT-B", [{ productName: "Import Product B", quantity: 50, unit: "KG" }]);
    const runA = (await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: poA.items[0]!.id })).body;
    const runB = (await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: poB.items[0]!.id })).body;
    expect(runA.currentStageId).toBe("MATERIAL_RECEIVED");
    expect(runB.currentStageId).toBe("MATERIAL_RECEIVED");

    // As Store, forward both runs out of MATERIAL_RECEIVED in one bulk call.
    const bulk = await request(app)
      .post("/api/pre-productions/import")
      .set(authHeader(storeToken))
      .send({
        rows: [
          { poNumber: "PO-IMPORT-A", productName: "Import Product A", fields: { grnNo: "GRN-A" } },
          { poNumber: "PO-IMPORT-B", productName: "Import Product B", fields: { grnNo: "GRN-B" } },
        ],
      });
    expect(bulk.status).toBe(201);
    expect(bulk.body.rowsProcessed).toBe(2);
    expect(bulk.body.forwarded).toBe(2);
    expect(bulk.body.blocked).toBe(0);
    expect(bulk.body.unmatched).toBe(0);

    const checkA = await request(app).get(`/api/pre-productions/${runA.id}`).set(authHeader(storeToken));
    const checkB = await request(app).get(`/api/pre-productions/${runB.id}`).set(authHeader(storeToken));
    expect(checkA.body.currentStageId).toBe("INDENT_ISSUE");
    expect(checkA.body.grnNo).toBe("GRN-A");
    expect(checkB.body.currentStageId).toBe("INDENT_ISSUE");
    expect(checkB.body.grnNo).toBe("GRN-B");
  });

  it("reports unmatched rows (bad PO Number / product name, or a line item production hasn't started on yet) without touching real runs", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    await createApprovedPo(bdToken, "PO-IMPORT-NOSTART", [{ productName: "Not Started Product", quantity: 100, unit: "KG" }]);
    const { token: storeToken } = await createUser(["STORE"]);

    const bulk = await request(app)
      .post("/api/pre-productions/import")
      .set(authHeader(storeToken))
      .send({
        rows: [
          { poNumber: "PO-DOES-NOT-EXIST", productName: "Whatever", fields: {} },
          { poNumber: "PO-IMPORT-NOSTART", productName: "No Such Product", fields: {} },
          { poNumber: "PO-IMPORT-NOSTART", productName: "Not Started Product", fields: {} }, // real item, but no PreProduction created yet
        ],
      });
    expect(bulk.status).toBe(201);
    expect(bulk.body.rowsProcessed).toBe(3);
    expect(bulk.body.unmatched).toBe(3);
    expect(bulk.body.forwarded).toBe(0);
    expect(bulk.body.results[0]).toMatchObject({ status: "unmatched" });
    expect(bulk.body.results[1]).toMatchObject({ status: "unmatched" });
    expect(bulk.body.results[2].message).toMatch(/hasn't started/);
  });

  it("a caller lacking the role for one row's stage: that row fails, others in the same call still succeed", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: storeToken } = await createUser(["STORE"]);

    // One run still at MATERIAL_RECEIVED (Store-owned), one already
    // walked to INDENT_ISSUE (PPIC-owned) — a Store-only caller can
    // forward the first but not the second.
    const poA = await createApprovedPo(bdToken, "PO-IMPORT-RBAC-A", [{ productName: "RBAC Product A", quantity: 10, unit: "KG" }]);
    const poB = await createApprovedPo(bdToken, "PO-IMPORT-RBAC-B", [{ productName: "RBAC Product B", quantity: 10, unit: "KG" }]);
    const runA = (await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: poA.items[0]!.id })).body;
    const runB = (await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: poB.items[0]!.id })).body;
    await request(app).patch(`/api/pre-productions/${runB.id}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD" }); // now at INDENT_ISSUE

    const bulk = await request(app)
      .post("/api/pre-productions/import")
      .set(authHeader(storeToken)) // Store only — can't act on INDENT_ISSUE (PPIC's)
      .send({
        rows: [
          { poNumber: "PO-IMPORT-RBAC-A", productName: "RBAC Product A", fields: {} },
          { poNumber: "PO-IMPORT-RBAC-B", productName: "RBAC Product B", fields: {} },
        ],
      });
    expect(bulk.status).toBe(201);
    expect(bulk.body.forwarded).toBe(1);
    expect(bulk.body.blocked).toBe(1);
    const rowA = bulk.body.results.find((r: { poNumber: string }) => r.poNumber === "PO-IMPORT-RBAC-A");
    const rowB = bulk.body.results.find((r: { poNumber: string }) => r.poNumber === "PO-IMPORT-RBAC-B");
    expect(rowA.status).toBe("forwarded");
    expect(rowB.status).toBe("blocked");
    expect(rowB.message).toMatch(/INDENT_ISSUE/);

    const checkA = await request(app).get(`/api/pre-productions/${runA.id}`).set(authHeader(storeToken));
    expect(checkA.body.currentStageId).toBe("INDENT_ISSUE");
  });

  it("a Dispensing row blocked by the full-requirement gate is reported as blocked, same message shape as the single endpoint", async () => {
    const { token: ppicToken } = await createUser(["PPIC"]);
    const { token: productionToken } = await createUser(["PRODUCTION"]);
    const { token: bdToken } = await createUser(["BD"]);
    const { token: storeToken } = await createUser(["STORE"]);

    const { token: rndToken } = await createUser(["RND"]);
    await request(app)
      .post("/api/rm-costing/recipes/import")
      .set(authHeader(rndToken))
      .send({ recipes: [{ name: "Import Gate Product", ingredients: [{ name: "Import Gate Protein", brand: "TestBrand", costPerKg: 300, gPerServing: 10, proteinPct: 0.5 }] }] });

    const po = await createApprovedPo(bdToken, "PO-IMPORT-GATE", [{ productName: "Import Gate Product", quantity: 10, unit: "Kg" }]);
    const rmPlan = await request(app).post("/api/rm-costing/plans").set(authHeader(bdToken)).send({ name: "Import Gate — RM", purchaseOrderItemId: po.items[0]!.id });
    expect(rmPlan.body.status).toBe("CALCULATED");

    const run = (await request(app).post("/api/pre-productions").set(authHeader(productionToken)).send({ purchaseOrderItemId: po.items[0]!.id })).body;
    const { token: qaToken } = await createUser(["QA_QC"]);
    await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(storeToken)).send({ action: "FORWARD" }); // MATERIAL_RECEIVED -> INDENT_ISSUE
    await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(ppicToken)).send({ action: "FORWARD" }); // -> LINE_CLEARANCE
    await request(app).patch(`/api/pre-productions/${run.id}/stage`).set(authHeader(qaToken)).send({ action: "FORWARD", lineClearanceStatus: "Approved" }); // -> DISPENSING

    // No consumption columns in a flat import row — the gate correctly
    // blocks, same as a manual Forward with nothing logged would.
    const bulk = await request(app)
      .post("/api/pre-productions/import")
      .set(authHeader(storeToken))
      .send({ rows: [{ poNumber: "PO-IMPORT-GATE", productName: "Import Gate Product", fields: { rmDispensingDate: "2026-08-01" } }] });
    expect(bulk.status).toBe(201);
    expect(bulk.body.blocked).toBe(1);
    expect(bulk.body.results[0].message).toMatch(/still short/);

    const check = await request(app).get(`/api/pre-productions/${run.id}`).set(authHeader(storeToken));
    expect(check.body.currentStageId).toBe("DISPENSING"); // did not advance
    expect(check.body.rmDispensingDate).toBeTruthy(); // but the field still saved
  });
});
