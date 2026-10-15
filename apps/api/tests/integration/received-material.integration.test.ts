import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("R&D's Received Material: request to the Warehouse, then receive", () => {
  it("follows a request from Requested to Issued to Received, with the material's vendors and the Warehouse stock", async () => {
    const { token: store } = await createUser(["STORE"]);
    const { token: rnd } = await createUser(["RND"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(store)).send({ category: "RM", name: "RM Flour", unit: "Kg" });
    const itemId = item.body.id as string;

    // The Warehouse has 100 Kg from "RM Vendor", approved at inward QC
    const received = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(store))
      .send({ itemId, type: "RECEIVED", date: "2026-10-01", unit: "Kg", quantity: 100, vendorName: "RM Vendor", batchNo: "B-77", grnNo: "GRN-9" });
    await request(app).patch(`/api/inventory/transactions/${received.body.id}/qc`).set(authHeader(rnd)).send({ action: "APPROVE", samplingDate: "2026-10-02" });

    const info = await request(app).get(`/api/rnd-store/item-info/${itemId}`).set(authHeader(rnd));
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ name: "RM Flour", warehouseOnHand: 100 });
    expect(info.body.vendors[0]).toMatchObject({ vendorName: "RM Vendor", batchNo: "B-77", grnNo: "GRN-9" });

    // R&D asks the Warehouse for 10 Kg
    const created = await request(app).post("/api/rnd-store/requests").set(authHeader(rnd)).send({ itemId, quantity: 10, unit: "Kg", note: "trial" });
    expect(created.status).toBe(201);
    const row = async () => ((await request(app).get("/api/rnd-store/received-material").set(authHeader(rnd))).body as Record<string, unknown>[]).find((r) => r.requestId === created.body.id)!;
    expect(await row()).toMatchObject({ status: "REQUESTED", itemName: "RM Flour", quantity: 10, warehouseOnHand: 100 });
    expect(((await row()).vendors as { vendorName: string }[])[0]!.vendorName).toBe("RM Vendor");

    // The Warehouse issues it: R&D now has to confirm receipt
    const issued = await request(app).post(`/api/rnd-store/requests/${created.body.id}/fulfill`).set(authHeader(store));
    expect(issued.status).toBe(200);
    expect(await row()).toMatchObject({ status: "ISSUED", warehouseOnHand: 90 });

    const transferId = (await row()).transferId as string;
    expect((await request(app).post(`/api/rnd-store/transfers/${transferId}/confirm`).set(authHeader(rnd))).status).toBe(200);
    expect(await row()).toMatchObject({ status: "RECEIVED" });

    // Only R&D reads this list
    expect((await request(app).get("/api/rnd-store/received-material").set(authHeader(store))).status).toBe(403);
  });
});
