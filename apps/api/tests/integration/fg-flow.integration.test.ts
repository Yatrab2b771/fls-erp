import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("Finished goods after Packaging: QA gate -> Day Store -> QA approval -> Dispatch -> customer / Warehouse", () => {
  it("walks a batch from QA's packaging gate to Dispatch, ships it in parts to the customer and the Warehouse, and the Warehouse stock follows", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token: qa } = await createUser(["QA_QC"]);
    const { token: dispatch } = await createUser(["DISPATCH"]);
    const { token: warehouse } = await createUser(["STORE"]); // not limited to a Day Store: the Warehouse seat
    const { user: dayStoreUser, token: dayStore } = await createUser(["STORE"]);
    const { user: otherUser, token: otherStore } = await createUser(["STORE"]);

    const store = await prisma.dayStore.create({ data: { name: `FG Store ${Date.now()}`, createdById: dayStoreUser.id } });
    const otherDayStore = await prisma.dayStore.create({ data: { name: `FG Other Store ${Date.now()}`, createdById: dayStoreUser.id } });
    const plant = await prisma.plant.create({ data: { name: `FG Plant ${Date.now()}`, createdById: dayStoreUser.id, dayStoreId: store.id } });
    await prisma.dayStoreAssignment.create({ data: { userId: dayStoreUser.id, dayStoreId: store.id } });
    await prisma.dayStoreAssignment.create({ data: { userId: otherUser.id, dayStoreId: otherDayStore.id } });

    const customer = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "FG Customer" });
    const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId: customer.body.id, poNumber: "FG-PO-1", items: [{ productName: "FG Powder", productCategory: "Powder", quantity: 100, unit: "KG" }] });
    const itemId = po.body.items[0].id as string;
    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemId, plannedQty: 100, plantId: plant.id, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
    const batch = await prisma.productionBatch.create({
      data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: dayStoreUser.id } }, batchNo: "FG-1", plannedQty: 100, outputQty: 100, status: "COMPLETED", completedAt: new Date(), currentStageId: "QA_GATE_PACKAGING", packagingStatus: "Completed" },
    });
    const stage = (token: string, body: Record<string, unknown>) => request(app).patch(`/api/production-batches/${batch.id}/stage`).set(authHeader(token)).send(body);
    const board = (token: string, st: string) => request(app).get(`/api/fg/store-board?stage=${st}`).set(authHeader(token));

    // QA passes the packaging gate: the finished goods are now at the Day Store
    const gate = await stage(qa, { action: "FORWARD", packQaStatus: "Approved", packQcStatus: "Approved", packApprovedQty: 100 });
    expect(gate.status).toBe(200);
    expect(gate.body.currentStageId).toBe("FG_STORE");

    // The Day Store of the Plant receives them; another Day Store and the Warehouse seat cannot
    expect((await board(dayStore, "FG_STORE")).body.map((r: { batchNo: string }) => r.batchNo)).toEqual(["FG-1"]);
    expect((await board(otherStore, "FG_STORE")).body).toEqual([]);
    expect((await stage(otherStore, { action: "FORWARD", fgStoreReceivedDate: "2026-10-12" })).status).toBe(403);
    const received = await stage(dayStore, { action: "FORWARD", fgStoreReceivedDate: "2026-10-12", fgStoreRemarks: "100 jars counted" });
    expect(received.status).toBe(200);
    expect(received.body.currentStageId).toBe("FG_QC_RELEASE");

    // QA approves the finished goods: only a real Approved moves them on
    expect((await board(qa, "FG_QC_RELEASE")).body.map((r: { batchNo: string }) => r.batchNo)).toEqual(["FG-1"]);
    expect((await stage(dayStore, { action: "FORWARD", fgQaStatus: "Approved" })).status).toBe(403); // not the Day Store's call
    const held = await stage(qa, { action: "FORWARD", fgQaStatus: "Hold", fgQcStatus: "Hold" });
    expect(held.body.currentStageId).toBe("FG_QC_RELEASE");
    const notApproved = await stage(qa, { action: "FORWARD", fgQcStatus: "Approved" });
    expect(notApproved.body.currentStageId).toBe("FG_QC_RELEASE");
    const approved = await stage(qa, { action: "FORWARD", fgQaStatus: "Approved", fgQcStatus: "Approved" });
    expect(approved.body.currentStageId).toBe("FG_HANDOVER");

    // The Day Store hands them to Dispatch (once)
    expect((await board(dayStore, "FG_HANDOVER")).body.map((r: { batchNo: string }) => r.batchNo)).toEqual(["FG-1"]);
    expect((await request(app).get("/api/fg/dispatch-board").set(authHeader(dispatch))).body).toEqual([]); // not handed over yet
    const handed = await stage(dayStore, { action: "FORWARD" });
    expect(handed.status).toBe(200);
    expect(handed.body.handedOverToDispatchAt).toBeTruthy();
    expect((await stage(dayStore, { action: "FORWARD" })).status).toBe(409);
    expect((await board(dayStore, "FG_HANDOVER")).body).toEqual([]);

    // Dispatch sees it with 100 on hand
    const dispatchBoard = async () => (await request(app).get("/api/fg/dispatch-board").set(authHeader(dispatch))).body as { batchId: string; approvedQty: number; remainingQty: number; shipments: { id: string; type: string; status: string }[] }[];
    expect((await dispatchBoard())[0]).toMatchObject({ batchId: batch.id, approvedQty: 100, remainingQty: 100 });

    // To the customer: a part, never more than what is left
    const customerShip = (quantity: number) => request(app).post(`/api/fg/batches/${batch.id}/customer-shipments`).set(authHeader(dispatch)).send({ quantity, transportType: "Road", pickedBy: "Ravi", loadedBy: "Sunil" });
    expect((await customerShip(150)).status).toBe(409);
    const toCustomer = await customerShip(30);
    expect(toCustomer.status).toBe(201);
    // It goes to Accounts first (the quantity is held back at once); Dispatch can only send it once Accounts has added the invoice
    expect(toCustomer.body).toMatchObject({ type: "CUSTOMER", status: "WITH_ACCOUNTS", quantity: 30 });
    expect((await dispatchBoard())[0]!.remainingQty).toBe(70);
    const sendToCustomer = () => request(app).post(`/api/fg/shipments/${toCustomer.body.id}/send-to-customer`).set(authHeader(dispatch));
    expect((await sendToCustomer()).status).toBe(409); // Accounts has not approved it
    expect((await request(app).post(`/api/fg/shipments/${toCustomer.body.id}/accounts-approve`).set(authHeader(dispatch)).send({ invoiceNo: "INV-1" })).status).toBe(403); // not Dispatch's step
    const accountsUser = (await createUser(["ACCOUNTS"])).token;
    expect((await request(app).post(`/api/fg/shipments/${toCustomer.body.id}/accounts-approve`).set(authHeader(accountsUser)).send({})).status).toBe(400); // an invoice number is needed
    const backToDispatch = await request(app).post(`/api/fg/shipments/${toCustomer.body.id}/accounts-return`).set(authHeader(accountsUser)).send({ reason: "Weight is missing" });
    expect(backToDispatch.body).toMatchObject({ status: "SENT_BACK", rejectedReason: "Weight is missing" });
    const resubmitted = await request(app).post(`/api/fg/shipments/${toCustomer.body.id}/resubmit`).set(authHeader(dispatch)).send({ weightKg: 31.5, goodsValue: 20000 });
    expect(resubmitted.body).toMatchObject({ status: "WITH_ACCOUNTS", weightKg: 31.5, insuranceCharge: 20 }); // insurance: 0.1% of the goods value
    const accountsOk = await request(app).post(`/api/fg/shipments/${toCustomer.body.id}/accounts-approve`).set(authHeader(accountsUser)).send({ invoiceNo: "INV-1", invoiceAmount: 20000, ewayBillNo: "EWB-1" });
    expect(accountsOk.body).toMatchObject({ status: "READY_TO_SEND", invoiceNo: "INV-1", invoiceAmount: 20000 });
    expect((await sendToCustomer()).body).toMatchObject({ status: "DISPATCHED" });
    expect((await dispatchBoard())[0]!.remainingQty).toBe(70);

    // To the Warehouse: it is asked first
    const ask = await request(app).post(`/api/fg/batches/${batch.id}/warehouse-requests`).set(authHeader(dispatch)).send({ quantity: 50, note: "Stock for the next order" });
    expect(ask.status).toBe(201);
    expect(ask.body.status).toBe("REQUESTED");
    expect((await dispatchBoard())[0]!.remainingQty).toBe(20);
    const send = (id: string) => request(app).post(`/api/fg/shipments/${id}/send`).set(authHeader(dispatch)).send({ transportType: "Own vehicle" });
    expect((await send(ask.body.id)).status).toBe(409); // the Warehouse has not accepted
    expect((await request(app).patch(`/api/fg/shipments/${ask.body.id}/decision`).set(authHeader(dayStore)).send({ action: "ACCEPT" })).status).toBe(403); // a Day Store is not the Warehouse
    const requests = (await request(app).get("/api/fg/warehouse-requests").set(authHeader(warehouse))).body as { id: string; status: string; productName: string }[];
    expect(requests.find((r) => r.id === ask.body.id)).toMatchObject({ status: "REQUESTED", productName: "FG Powder" });
    const accepted = await request(app).patch(`/api/fg/shipments/${ask.body.id}/decision`).set(authHeader(warehouse)).send({ action: "ACCEPT" });
    expect(accepted.body.status).toBe("ACCEPTED");

    const warehouseFg = async () => (await request(app).get("/api/inventory/fg-stock").set(authHeader(warehouse))).body as { id: string; onHandQty: number }[];
    expect((await warehouseFg()).find((r) => r.id === batch.id)).toBeUndefined(); // not in the Warehouse yet
    expect((await send(ask.body.id)).body.status).toBe("SENT");
    expect((await warehouseFg()).find((r) => r.id === batch.id)).toBeUndefined(); // on the way is not stock
    const receive = await request(app).post(`/api/fg/shipments/${ask.body.id}/receive`).set(authHeader(warehouse));
    expect(receive.body.status).toBe("RECEIVED");
    expect((await warehouseFg()).find((r) => r.id === batch.id)?.onHandQty).toBe(50);

    // A refused request frees the quantity again
    const second = await request(app).post(`/api/fg/batches/${batch.id}/warehouse-requests`).set(authHeader(dispatch)).send({ quantity: 20 });
    expect((await dispatchBoard())[0]!.remainingQty).toBe(0);
    expect((await request(app).patch(`/api/fg/shipments/${second.body.id}/decision`).set(authHeader(warehouse)).send({ action: "REJECT" })).status).toBe(400); // a reason is needed
    expect((await request(app).patch(`/api/fg/shipments/${second.body.id}/decision`).set(authHeader(warehouse)).send({ action: "REJECT", reason: "No space" })).body.status).toBe("REJECTED");
    expect((await dispatchBoard())[0]!.remainingQty).toBe(20);

    // Accounts may add the invoice any time (optional)
    const { token: accounts } = await createUser(["ACCOUNTS"]);
    const invoiced = await request(app).patch(`/api/fg/shipments/${toCustomer.body.id}/invoice`).set(authHeader(accounts)).send({ invoiceNo: "INV-7", ewayBillNo: "EWB-7" });
    expect(invoiced.body).toMatchObject({ invoiceNo: "INV-7", ewayBillNo: "EWB-7" });

    // Only what went to the customer counts towards the PO being complete (the Warehouse transfer is not a sale)
    const detail = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authHeader(bd));
    expect(detail.body.completion.isCompleted).toBe(false);
    const last = await customerShip(20);
    expect(last.status).toBe(201);
    expect((await dispatchBoard())[0]).toBeTruthy(); // still on its list: the shipment has not been sent yet
    await request(app).post(`/api/fg/shipments/${last.body.id}/accounts-approve`).set(authHeader(accountsUser)).send({ invoiceNo: "INV-2" });
    await request(app).post(`/api/fg/shipments/${last.body.id}/send-to-customer`).set(authHeader(dispatch));
    expect(await dispatchBoard()).toEqual([]); // nothing left with Dispatch and everything sent, so it drops off its list
  });
});
