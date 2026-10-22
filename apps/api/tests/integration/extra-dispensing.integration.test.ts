import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("Extra material for a batch goes through the Store's dispensing, with a GRN", () => {
  it("the Store approves it and dispenses it (in rounds): own GRN, on its way until Production receives it, and traced to the batch", async () => {
    const { user: productionUser, token: production } = await createUser(["PRODUCTION"]);
    const { user: storeUser, token: store } = await createUser(["STORE"]);
    const { user: otherUser, token: otherStore } = await createUser(["STORE"]);
    const { token: bd } = await createUser(["BD"]);
    const dayStore = await prisma.dayStore.create({ data: { name: `XD Store ${Date.now()}`, createdById: storeUser.id } });
    const otherDayStore = await prisma.dayStore.create({ data: { name: `XD Other ${Date.now()}`, createdById: storeUser.id } });
    const plant = await prisma.plant.create({ data: { name: `XD Plant ${Date.now()}`, createdById: storeUser.id, dayStoreId: dayStore.id } });
    await prisma.dayStoreAssignment.create({ data: { userId: storeUser.id, dayStoreId: dayStore.id } });
    await prisma.dayStoreAssignment.create({ data: { userId: otherUser.id, dayStoreId: otherDayStore.id } });
    await prisma.plantAssignment.create({ data: { userId: productionUser.id, plantId: plant.id } });

    const customer = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "XD Customer" });
    const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: customer.body.id, poNumber: "XD-PO-1", items: [{ productName: "XD Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: po.body.items[0].id, plannedQty: 100, plantId: plant.id, batchFlow: true, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
    const batch = await prisma.productionBatch.create({ data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: productionUser.id } }, batchNo: "XD-1", plannedQty: 50, status: "IN_PROGRESS" } });
    const item = await prisma.inventoryItem.create({ data: { category: "RM", name: `XD Resin ${Date.now()}`, unit: "Kg" } });
    // The Store holds 100 Kg
    await prisma.inventoryTransaction.create({ data: { itemId: item.id, type: "ISSUED_DAY_STORE", date: new Date(), unit: "Kg", quantity: 100, createdById: storeUser.id, dayStoreId: dayStore.id, deliveredAt: new Date() } });

    const ask = await request(app).post("/api/inventory/extra-requests").set(authHeader(production)).send({ itemId: item.id, requestedQty: 60, reason: "Spillage on the line", productionBatchId: batch.id });
    expect(ask.status).toBe(201);
    const dispense = (token: string, body: Record<string, unknown>) => request(app).post(`/api/production-batches/${batch.id}/dispense-extra`).set(authHeader(token)).send({ requestId: ask.body.id, ...body });

    // Not before the Store has approved it; and only the Store of the batch's Plant
    expect((await dispense(store, {})).status).toBe(404);
    expect((await request(app).patch(`/api/inventory/requests/${ask.body.id}/review`).set(authHeader(store)).send({ action: "APPROVE" })).status).toBe(200);
    expect((await dispense(production, {})).status).toBe(403);
    expect((await dispense(otherStore, {})).status).toBe(403);
    expect((await dispense(store, { quantity: 61 })).status).toBe(409); // more than is owed

    // A first round: 25 of the 60 Kg, with its GRN
    const first = await dispense(store, { quantity: 25, note: "Weighed twice" });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ issued: 25, remaining: 35, unit: "Kg" });
    expect(first.body.grnNo).toMatch(/^FLS-XDP-XD-1-\d{2}$/);
    const txn = await prisma.inventoryTransaction.findUniqueOrThrow({ where: { id: first.body.txnId } });
    expect(txn).toMatchObject({ type: "ISSUED_PRODUCTION", quantity: 25, grnNo: first.body.grnNo, batchNo: "XD-1", fulfillsRequestId: ask.body.id, isTransitTracked: true, deliveredAt: null, plantId: plant.id, dayStoreId: dayStore.id });
    expect((await prisma.inventoryRequest.findUniqueOrThrow({ where: { id: ask.body.id } })).status).toBe("PARTIALLY_ISSUED");
    const storeStock = async () => ((await request(app).get(`/api/inventory/day-stores/${dayStore.id}/stock`).set(authHeader(store))).body.stock as { onHand: number }[]).reduce((s, r) => s + r.onHand, 0);
    expect(await storeStock()).toBe(75); // left the Store at once

    // The Store's own list of what it dispensed to the Plant has it, batch and GRN wise, marked as extra material
    const listed = (await request(app).get("/api/inventory/my-store/issued-to-plant").set(authHeader(store))).body as { id: string; batchNo: string | null; grnNo: string | null; isExtra: boolean; status: string }[];
    expect(listed.find((r) => r.id === first.body.txnId)).toMatchObject({ batchNo: "XD-1", grnNo: first.body.grnNo, isExtra: true, status: "In Transit" });

    // Production sees it on its way, with the GRN, and receives it (less than was sent needs a reason)
    const mine = async () => ((await request(app).get("/api/inventory/extra-requests").set(authHeader(production))).body as { id: string; onItsWay: { id: string; quantity: number }[]; grnNos: string[] }[]).find((r) => r.id === ask.body.id)!;
    expect(await mine()).toMatchObject({ onItsWay: [{ id: first.body.txnId, quantity: 25 }], grnNos: [first.body.grnNo] });
    expect((await request(app).post(`/api/inventory/transactions/${first.body.txnId}/confirm-delivery`).set(authHeader(production)).send({ receivedQty: 24 })).status).toBe(400);
    const got = await request(app).post(`/api/inventory/transactions/${first.body.txnId}/confirm-delivery`).set(authHeader(production)).send({ receivedQty: 24, note: "1 Kg spilled" });
    expect(got.status).toBe(200);
    expect((await mine()).onItsWay).toEqual([]);

    // The second round takes the rest: the batch's number with the next letter; the request is complete
    const second = await dispense(store, {});
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ issued: 60, remaining: 0 });
    expect(second.body.grnNo).toBe(`${first.body.grnNo}-A`);
    expect((await prisma.inventoryRequest.findUniqueOrThrow({ where: { id: ask.body.id } })).status).toBe("ISSUED");
    expect((await dispense(store, {})).status).toBe(404); // nothing is open any more
    expect(await storeStock()).toBe(40);

    // The batch's Utilization lists it (60 Kg given) for Production to fill in what was used
    const row = ((await request(app).get(`/api/pre-productions/${run.id}/production-batches`).set(authHeader(production))).body as { id: string; utilization: { extraItems: { itemId: string; givenQty: number }[] } }[]).find((b) => b.id === batch.id)!;
    expect(row.utilization.extraItems).toEqual([expect.objectContaining({ itemId: item.id, givenQty: 60 })]);

    // Not more than the Store holds, and not once the batch is packed
    const big = await request(app).post("/api/inventory/extra-requests").set(authHeader(production)).send({ itemId: item.id, requestedQty: 500, reason: "A lot more", productionBatchId: batch.id });
    expect((await request(app).patch(`/api/inventory/requests/${big.body.id}/review`).set(authHeader(store)).send({ action: "APPROVE" })).status).toBe(200);
    const tooMuch = await request(app).post(`/api/production-batches/${batch.id}/dispense-extra`).set(authHeader(store)).send({ requestId: big.body.id });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toMatch(/holds only 40/);
    await prisma.productionBatch.update({ where: { id: batch.id }, data: { currentStageId: "FG_STORE" } });
    const packed = await request(app).post(`/api/production-batches/${batch.id}/dispense-extra`).set(authHeader(store)).send({ requestId: big.body.id, quantity: 10 });
    expect(packed.status).toBe(409);
    expect(packed.body.error).toMatch(/already been packed/);
  });
});
