import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("R&D's Return Material: send material back to the Warehouse", () => {
  it("R&D returns material it holds; the Warehouse confirms it; it cannot return more than it has", async () => {
    const { token: store } = await createUser(["STORE"]);
    const { token: rnd } = await createUser(["RND"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(store)).send({ category: "RM", name: "RT Flour", unit: "Kg" });
    const itemId = item.body.id as string;

    // The Warehouse has 100 Kg; R&D asks for 20 and receives it
    const received = await request(app).post("/api/inventory/transactions").set(authHeader(store)).send({ itemId, type: "RECEIVED", date: "2026-10-01", unit: "Kg", quantity: 100, vendorName: "RT Vendor" });
    await request(app).patch(`/api/inventory/transactions/${received.body.id}/qc`).set(authHeader(rnd)).send({ action: "APPROVE", samplingDate: "2026-10-02" });
    const req = await request(app).post("/api/rnd-store/requests").set(authHeader(rnd)).send({ itemId, quantity: 20, unit: "Kg" });
    await request(app).post(`/api/rnd-store/requests/${req.body.id}/fulfill`).set(authHeader(store));
    const incoming = (await request(app).get("/api/rnd-store/received-material").set(authHeader(rnd))).body.find((r: { requestId: string }) => r.requestId === req.body.id);
    await request(app).post(`/api/rnd-store/transfers/${incoming.transferId}/confirm`).set(authHeader(rnd));

    const list = async () => (await request(app).get("/api/rnd-store/returns").set(authHeader(rnd))).body as Record<string, unknown>[];
    expect(await list()).toEqual([]);

    // Returning more than R&D holds is refused; returning part of it works
    const tooMuch = await request(app).post("/api/rnd-store/transfers").set(authHeader(rnd)).send({ direction: "TO_WAREHOUSE", itemId, quantity: 25, unit: "Kg" });
    expect(tooMuch.status).toBe(409);
    const sent = await request(app).post("/api/rnd-store/transfers").set(authHeader(rnd)).send({ direction: "TO_WAREHOUSE", itemId, quantity: 5, unit: "Kg", note: "trial finished" });
    expect(sent.status).toBe(201);
    expect(await list()).toMatchObject([{ itemName: "RT Flour", quantity: 5, status: "SENT", reason: "trial finished", rndOnHand: 15, warehouseOnHand: 80 }]);
    expect(((await list())[0]!.vendors as { vendorName: string }[])[0]!.vendorName).toBe("RT Vendor");

    // The Warehouse confirms: it is back in stock
    expect((await request(app).post(`/api/rnd-store/transfers/${sent.body.id}/confirm`).set(authHeader(store))).status).toBe(200);
    expect(await list()).toMatchObject([{ status: "RETURNED", warehouseOnHand: 85 }]);

    // Only R&D reads this list
    expect((await request(app).get("/api/rnd-store/returns").set(authHeader(store))).status).toBe(403);
  });
});
