import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("Production's extra material: Day Store -> Warehouse -> PPIC -> Purchase, then back down the same way", () => {
  it("walks one request from Production to the Plant", async () => {
    const { user: productionUser, token: production } = await createUser(["PRODUCTION"]);
    const { token: otherProduction, user: otherProductionUser } = await createUser(["PRODUCTION"]);
    const { user: dayStoreUser, token: dayStore } = await createUser(["STORE"]);
    const { token: warehouse } = await createUser(["STORE"]);
    const { token: ppic } = await createUser(["PPIC"]);
    const { token: purchase } = await createUser(["PURCHASE"]);
    const { token: rnd } = await createUser(["RND"]);

    const mk = async (name: string, owner: string) => {
      const store = await prisma.dayStore.create({ data: { name: `${name} ${Date.now()}`, createdById: owner } });
      return { store, plant: await prisma.plant.create({ data: { name: `${name} Plant ${Date.now()}`, createdById: owner, dayStoreId: store.id } }) };
    };
    const mine = await mk("EX", dayStoreUser.id);
    const other = await mk("EX Other", dayStoreUser.id);
    await prisma.dayStoreAssignment.create({ data: { userId: dayStoreUser.id, dayStoreId: mine.store.id } });
    await prisma.plantAssignment.create({ data: { userId: productionUser.id, plantId: mine.plant.id } });
    await prisma.plantAssignment.create({ data: { userId: otherProductionUser.id, plantId: other.plant.id } });

    const item = await request(app).post("/api/inventory/items").set(authHeader(warehouse)).send({ category: "RM", name: `EX Resin ${Date.now()}`, unit: "Kg" });
    const extra = (token: string, body: Record<string, unknown>) => request(app).post("/api/inventory/extra-requests").set(authHeader(token)).send({ itemId: item.body.id, requestedQty: 40, reason: "Trial batch of the new flavour", neededBy: "2026-10-20", ...body });

    // Production raises it, for its own Plant only, with a reason
    expect((await extra(production, { reason: "x" })).status).toBe(400);
    expect((await extra(dayStore, {})).status).toBe(403); // Production only
    expect((await extra(otherProduction, { plantId: mine.plant.id })).status).toBe(403); // not that Plant's login
    const created = await extra(production, {});
    expect(created.status).toBe(201);
    const productionRequestId = created.body.id as string;

    // The Day Store of that Plant sees it as extra (no product), approves it; it has no stock, so it asks the Warehouse
    const dsList = async () => ((await request(app).get("/api/inventory/my-store/production-requests?pageSize=200").set(authHeader(dayStore))).body as { id: string; isExtra: boolean; productName: string | null; note: string | null; toAsk: number; purchaseState: string | null; purchaseEta: string | null; stage: string }[]);
    const seen = (await dsList()).find((r) => r.id === productionRequestId);
    expect(seen).toMatchObject({ isExtra: true, productName: null, note: "Trial batch of the new flavour", toAsk: 40 });
    expect((await request(app).patch(`/api/inventory/requests/${productionRequestId}/review`).set(authHeader(dayStore)).send({ action: "APPROVE" })).status).toBe(200);
    const ask = await request(app).post(`/api/inventory/my-store/production-requests/${productionRequestId}/request-from-warehouse`).set(authHeader(dayStore));
    expect(ask.status).toBe(201);
    const askId = ask.body.id as string;

    // The Warehouse has nothing, so the need went to PPIC by itself - only the missing 40 Kg
    const requirement = await prisma.preInventoryRequirement.findFirst({ where: { sourceRequestId: askId } });
    expect(requirement).toBeTruthy();
    expect(requirement!.requiredQty).toBeCloseTo(40, 6);
    expect(requirement!.note).toContain("Extra material");
    const trail = async () => ((await request(app).get("/api/inventory/extra-requests").set(authHeader(production))).body as { id: string; supplyStage: string | null; purchaseEta: string | null; status: string; stage: string; issuedQty: number }[]).find((r) => r.id === productionRequestId)!;
    expect((await trail()).supplyStage).toBe("WITH_PPIC");
    expect((await request(app).get("/api/inventory/extra-requests").set(authHeader(otherProduction))).body).toEqual([]); // another Plant's login does not see it
    const again = await request(app).get("/api/inventory/material-requests").set(authHeader(warehouse)); // reading the Warehouse list does not escalate it twice
    expect(again.status).toBe(200);
    expect(await prisma.preInventoryRequirement.count({ where: { sourceRequestId: askId } })).toBe(1);

    // PPIC sends it to Purchase; Purchase logs a PI with an ETA, which shows to Production and the Day Store
    expect((await request(app).post(`/api/inventory/requirements/${requirement!.id}/notify-purchase`).set(authHeader(ppic))).status).toBe(200);
    expect((await trail()).supplyStage).toBe("WITH_PURCHASE");
    const pi = await request(app).patch(`/api/inventory/requirements/${requirement!.id}/purchase`).set(authHeader(purchase)).send({ poNumber: "PI-EX-1", vendorName: "EX Vendor", eta: "2026-10-18", quantity: 40 });
    expect(pi.status).toBe(200);
    expect(await trail()).toMatchObject({ supplyStage: "ON_ORDER", purchaseEta: expect.stringContaining("2026-10-18") });
    expect((await dsList()).find((r) => r.id === productionRequestId)).toMatchObject({ purchaseState: "ON_ORDER", purchaseEta: expect.stringContaining("2026-10-18") });

    // The material arrives: the Warehouse receives it, R&D approves it, the Warehouse issues to the Day Store, the Day Store issues to the Plant
    const received = await request(app).post("/api/inventory/transactions").set(authHeader(warehouse)).send({ itemId: item.body.id, type: "RECEIVED", date: "2026-10-05", unit: "Kg", quantity: 50, vendorName: "EX Vendor" });
    expect(received.status).toBe(201);
    expect((await request(app).patch(`/api/inventory/transactions/${received.body.id}/qc`).set(authHeader(rnd)).send({ action: "APPROVE", samplingDate: "2026-10-05" })).status).toBe(200);
    expect((await request(app).patch(`/api/inventory/requests/${askId}/review`).set(authHeader(warehouse)).send({ action: "APPROVE" })).status).toBe(200);
    const toStore = await request(app).post(`/api/inventory/requests/${askId}/issue`).set(authHeader(warehouse)).send({ date: "2026-10-05", unit: "Kg", quantity: 40, dayStoreId: mine.store.id });
    expect(toStore.status).toBe(201);
    const toPlant = await request(app).post(`/api/inventory/requests/${productionRequestId}/issue`).set(authHeader(dayStore)).send({ date: "2026-10-05", unit: "Kg", quantity: 40, dayStoreId: mine.store.id });
    expect(toPlant.status).toBe(201);
    const done = await trail();
    expect(done).toMatchObject({ status: "Issued", issuedQty: 40, stage: "ISSUED_TO_PLANT" });

    // Production can withdraw only what the Day Store has not started on
    const second = await extra(production, { requestedQty: 5 });
    expect((await request(app).delete(`/api/inventory/extra-requests/${second.body.id}`).set(authHeader(otherProduction))).status).toBe(403);
    expect((await request(app).delete(`/api/inventory/extra-requests/${second.body.id}`).set(authHeader(production))).status).toBe(204);
    expect((await request(app).delete(`/api/inventory/extra-requests/${productionRequestId}`).set(authHeader(production))).status).toBe(409);
  });
});
