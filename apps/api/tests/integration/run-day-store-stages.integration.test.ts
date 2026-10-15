import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

/** Two Day Stores with a Plant each, a run at Plant A (waiting at Material Received) and a run with no Plant. */
async function setup() {
  const { token: warehouse, user } = await createUser(["STORE"]);
  const { token: storeA, user: userA } = await createUser(["STORE"]);
  const { token: storeB, user: userB } = await createUser(["STORE"]);
  const { token: admin } = await createUser(["ADMIN"]);
  const { token: bd } = await createUser(["BD"]);
  const a = await prisma.dayStore.create({ data: { name: "RUN Store A", createdById: user.id } });
  const b = await prisma.dayStore.create({ data: { name: "RUN Store B", createdById: user.id } });
  const plantA = await prisma.plant.create({ data: { name: "RUN Store A", createdById: user.id, dayStoreId: a.id } });
  await prisma.plant.create({ data: { name: "RUN Store B", createdById: user.id, dayStoreId: b.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: userA.id, dayStoreId: a.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: userB.id, dayStoreId: b.id } });

  const customer = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "RUN Customer" });
  const makeRun = async (poNumber: string, plantId: string | null) => {
    const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: customer.body.id, poNumber, items: [{ productName: `${poNumber} Product`, productCategory: "Powder", quantity: 10, unit: "Kg" }] });
    return prisma.preProduction.create({ data: { purchaseOrderItemId: po.body.items[0].id, plannedQty: 10, plantId } });
  };
  const runA = await makeRun("RUN-PO-A", plantA.id);
  const runNoPlant = await makeRun("RUN-PO-N", null);
  return { warehouse, storeA, storeB, admin, runA, runNoPlant };
}

const forward = (token: string, runId: string) => request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(token)).send({ action: "FORWARD", grnNo: "RUN-GRN-1", grnDate: "2026-10-06" });

describe("Material Received & GRN / Dispensing - done by the Day Store of the run's own Plant", () => {
  it("only that Plant's Day Store moves the run (not the Warehouse, not another store); a run with no Plant is Admin's", async () => {
    const { warehouse, storeA, storeB, admin, runA, runNoPlant } = await setup();

    expect((await forward(warehouse, runA.id)).status).toBe(403); // the Warehouse does not do this step
    expect((await forward(storeB, runA.id)).status).toBe(403); // another store's Plant
    expect((await forward(storeA, runNoPlant.id)).status).toBe(403); // no Plant: no Day Store to do it
    expect((await forward(storeA, runA.id)).status).toBe(200);
    expect((await prisma.preProduction.findUniqueOrThrow({ where: { id: runA.id } })).currentStageId).toBe("INDENT_ISSUE");
    expect((await forward(admin, runNoPlant.id)).status).toBe(200); // Admin can step in
  });

  it("a Day Store login lists and opens only the runs at its own Plant; the Warehouse seat still reads every run", async () => {
    const { warehouse, storeA, storeB, runA, runNoPlant } = await setup();
    const ids = async (token: string) => ((await request(app).get("/api/pre-productions").set(authHeader(token))).body as { id: string }[]).map((r) => r.id).sort();

    expect(await ids(storeA)).toEqual([runA.id]);
    expect(await ids(storeB)).toEqual([]);
    expect(await ids(warehouse)).toEqual([runA.id, runNoPlant.id].sort());
    expect((await request(app).get(`/api/pre-productions/${runA.id}`).set(authHeader(storeA))).status).toBe(200);
    expect((await request(app).get(`/api/pre-productions/${runA.id}`).set(authHeader(storeB))).status).toBe(403);
    expect((await request(app).get(`/api/pre-productions/${runA.id}`).set(authHeader(warehouse))).status).toBe(200);
  });
});
