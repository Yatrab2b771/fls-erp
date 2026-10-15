import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("R&D's Material Utilization", () => {
  it("splits what reached the R&D Store into testing, formulation, customer sample, rejected, returned, wastage and what is left", async () => {
    const { token: store } = await createUser(["STORE"]);
    const { token: rnd } = await createUser(["RND"]);
    const { token: bd } = await createUser(["BD"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "RU Customer" });
    const item = await request(app).post("/api/inventory/items").set(authHeader(store)).send({ category: "RM", name: "RU Extract", unit: "Kg" });
    const itemId = item.body.id as string;

    // 50 Kg at the Warehouse (vendor "RU Vendor"), 30 of it requested by R&D and received
    const received = await request(app).post("/api/inventory/transactions").set(authHeader(store)).send({ itemId, type: "RECEIVED", date: "2026-10-01", unit: "Kg", quantity: 50, vendorName: "RU Vendor" });
    await request(app).patch(`/api/inventory/transactions/${received.body.id}/qc`).set(authHeader(rnd)).send({ action: "APPROVE", samplingDate: "2026-10-02" });
    const req = await request(app).post("/api/rnd-store/requests").set(authHeader(rnd)).send({ itemId, quantity: 30, unit: "Kg" });
    await request(app).post(`/api/rnd-store/requests/${req.body.id}/fulfill`).set(authHeader(store));
    const incoming = (await request(app).get("/api/rnd-store/received-material").set(authHeader(rnd))).body.find((r: { requestId: string }) => r.requestId === req.body.id);
    await request(app).post(`/api/rnd-store/transfers/${incoming.transferId}/confirm`).set(authHeader(rnd));

    const consume = (reason: string, quantity: number, extra: Record<string, unknown> = {}) => request(app).post("/api/rnd-store/consume").set(authHeader(rnd)).send({ itemId, quantity, unit: "Kg", reason, ...extra });
    expect((await consume("TESTING", 3)).status).toBe(201);
    expect((await consume("FORMULATION_TRIAL", 5, { projectName: "Project X", formulationRef: "F-12" })).status).toBe(201);
    expect((await consume("WASTAGE", 1)).status).toBe(201);
    expect((await consume("REJECTED", 2)).status).toBe(201);
    expect((await request(app).post("/api/rnd-store/dispatch").set(authHeader(rnd)).send({ itemId, quantity: 4, unit: "Kg", customerId: customer.body.id })).status).toBe(201);
    expect((await request(app).post("/api/rnd-store/transfers").set(authHeader(rnd)).send({ direction: "TO_WAREHOUSE", itemId, quantity: 6, unit: "Kg" })).status).toBe(201);

    const res = await request(app).get("/api/rnd-store/utilization").set(authHeader(rnd));
    expect(res.status).toBe(200);
    const row = (res.body as { itemId: string }[]).find((r) => r.itemId === itemId) as Record<string, unknown>;
    expect(row).toMatchObject({ itemName: "RU Extract", category: "RM", receivedQty: 30, testingQty: 3, formulationQty: 5, wastageQty: 1, rejectedQty: 2, customerSampleQty: 4, returnedQty: 6, stockQty: 9 });
    // One receipt, from the Warehouse; the Warehouse vendors are listed too
    expect((row.lots as { source: string }[]).map((l) => l.source)).toEqual(["Warehouse"]);
    expect((row.warehouseVendors as { vendorName: string }[])[0]!.vendorName).toBe("RU Vendor");
    // Every usage entry is in the log, the sample one with its customer
    expect((row.log as { kind: string; customerName: string | null }[]).find((l) => l.kind === "CUSTOMER_SAMPLE")?.customerName).toBe("RU Customer");
    expect((row.log as unknown[]).length).toBe(6);

    expect((await request(app).get("/api/rnd-store/utilization").set(authHeader(store))).status).toBe(403);
  });
});
