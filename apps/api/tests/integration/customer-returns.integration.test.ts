import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();
const call = (token: string, method: "get" | "post", path: string, body?: object) => {
  const r = request(app)[method](path).set(authHeader(token));
  return body ? r.send(body) : r;
};

/** A batch of 75 Kg handed over to Dispatch and all shipped to the customer (invoice 7,500). */
async function setup() {
  const bd = await createUser(["BD"]);
  const warehouse = await createUser(["STORE"]);
  const qa = await createUser(["QA_QC"]);
  const production = await createUser(["PRODUCTION"]);
  const dispatch = await createUser(["DISPATCH"]);
  const accounts = await createUser(["ACCOUNTS"]);
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const customer = await call(bd.token, "post", "/api/customers", { companyName: `CR Customer ${stamp}` });
  const po = await call(bd.token, "post", "/api/purchase-orders", { customerId: customer.body.id, poNumber: `CR-PO-${stamp}`, items: [{ productName: "CR Powder", productCategory: "Powder", quantity: 75, unit: "KG" }] });
  const itemId = po.body.items[0].id as string;
  await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: "APPROVED" } });
  const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: itemId, plannedQty: 75, batchFlow: true } });
  const batch = await prisma.productionBatch.create({
    data: { preProductionId: run.id, createdById: production.user.id, batchNo: `CR-B-${stamp}`, plannedQty: 75, outputQty: 75, packApprovedQty: 75, status: "COMPLETED", currentStageId: "FG_HANDOVER", prepStageId: "READY", handedOverToDispatchAt: new Date(), fgStoreReceivedDate: new Date() },
  });
  await prisma.fgShipment.create({ data: { productionBatchId: batch.id, type: "CUSTOMER", status: "DISPATCHED", quantity: 75, invoiceAmount: 7500, invoiceNo: "INV-1", requestedById: dispatch.user.id, dispatchDate: new Date() } });

  const returnIt = (quantity: number, reason = "Customer found the seal broken") => call(warehouse.token, "post", "/api/customer-returns", { batchId: batch.id, quantity, reason, condition: "Tubs dented" });
  const product = async () => (await call(bd.token, "get", `/api/purchase-orders/${po.body.id}`)).body.items[0].dispatch as { dispatchedQty: number; isCompleted: boolean };
  const dispatchLeft = async () => {
    const board = await call(dispatch.token, "get", "/api/fg/dispatch-board?shipped=1");
    return (board.body as { batchId: string; remainingQty: number }[]).find((b) => b.batchId === batch.id)?.remainingQty;
  };
  return { bd, warehouse, qa, production, dispatch, accounts, batch, itemId, returnIt, product, dispatchLeft };
}

describe("Customer returns", () => {
  it("the Warehouse records it on a QA hold; what the customer holds goes down", async () => {
    const s = await setup();
    expect((await s.product()).isCompleted).toBe(true); // 75 of 75 shipped

    const list = await call(s.warehouse.token, "get", "/api/customer-returns/returnable");
    expect(list.body.find((r: { batchId: string }) => r.batchId === s.batch.id)).toMatchObject({ withCustomerQty: 75, productName: "CR Powder", invoiceNos: ["INV-1"] });

    // Only the Warehouse records it, and not more than the customer holds
    expect((await call(s.dispatch.token, "post", "/api/customer-returns", { batchId: s.batch.id, quantity: 5, reason: "x y z" })).status).toBe(403);
    expect((await s.returnIt(80)).status).toBe(409);
    expect((await call(s.warehouse.token, "post", "/api/customer-returns", { batchId: s.batch.id, quantity: 5, reason: "" })).status).toBe(400);
    const rec = await s.returnIt(20);
    expect(rec.status).toBe(201);
    expect(rec.body).toMatchObject({ status: "WITH_QA", quantity: 20, unit: "KG", condition: "Tubs dented", suggestedAmount: 2000 });

    // The customer now holds 55: the product is not complete any more; Dispatch has nothing of it yet (it is on QA hold)
    expect(await s.product()).toMatchObject({ dispatchedQty: 55, isCompleted: false });
    expect(await s.dispatchLeft()).toBe(0);

    // QA, Accounts and Dispatch are told
    const titles = async (token: string) => ((await call(token, "get", "/api/notifications")).body.notifications as { title: string }[]).map((n) => n.title);
    expect((await titles(s.qa.token)).some((t) => /customer return waits for QA/.test(t))).toBe(true);
    expect((await titles(s.accounts.token)).some((t) => /credit note/.test(t))).toBe(true);
    expect((await titles(s.dispatch.token)).some((t) => /customer returned goods/i.test(t))).toBe(true);

    // The tiles' counts
    const summary = await call(s.qa.token, "get", "/api/customer-returns/summary");
    expect(summary.body).toMatchObject({ withQa: 1, inRework: 0, awaitingDispatch: 0, open: 1, noCreditNote: 1 });
  });

  it("QA passes part of it, Dispatch stores it in the Warehouse, Accounts raises the credit note", async () => {
    const s = await setup();
    const id = (await s.returnIt(20)).body.id as string;
    const qa = (body: object) => call(s.qa.token, "post", `/api/customer-returns/${id}/qa`, body);

    expect((await call(s.dispatch.token, "post", `/api/customer-returns/${id}/qa`, { decision: "PASS" })).status).toBe(403);
    expect((await qa({ decision: "PASS", passedQty: 25 })).status).toBe(400); // more than came back
    expect((await qa({ decision: "SCRAP" })).status).toBe(400); // scrapping needs a reason
    const passed = await qa({ decision: "PASS", passedQty: 15, note: "5 Kg is damaged" });
    expect(passed.status).toBe(200);
    expect(passed.body).toMatchObject({ status: "AWAITING_DISPATCH", qa: { decision: "PASS", passedQty: 15, scrapQty: 5 } });
    expect(await s.dispatchLeft()).toBe(15); // back in Dispatch's stock of the batch

    // Dispatch stores it in the Warehouse: it joins the finished-goods stock, and leaves Dispatch's stock again
    expect((await call(s.qa.token, "post", `/api/customer-returns/${id}/dispatch`, { choice: "STORE" })).status).toBe(403);
    const stored = await call(s.dispatch.token, "post", `/api/customer-returns/${id}/dispatch`, { choice: "STORE" });
    expect(stored.status).toBe(200);
    expect(stored.body.status).toBe("STORED");
    expect(await s.dispatchLeft()).toBe(0);
    const fg = await call(s.warehouse.token, "get", "/api/inventory/fg-list");
    expect((fg.body as { id: string; onHandQty: number }[]).find((r) => r.id === s.batch.id)?.onHandQty).toBe(15);
    expect((await call(s.dispatch.token, "post", `/api/customer-returns/${id}/dispatch`, { choice: "STORE" })).status).toBe(409); // already placed

    // Accounts' credit note: the amount is worked out from the invoice (7,500 / 75 x 20) unless entered; one per return
    const credit = (body: object) => call(s.accounts.token, "post", `/api/customer-returns/${id}/credit-note`, body);
    expect((await call(s.dispatch.token, "post", `/api/customer-returns/${id}/credit-note`, { creditNoteNo: "CN-1" })).status).toBe(403);
    expect((await credit({})).status).toBe(400);
    const cn = await credit({ creditNoteNo: "CN-1" });
    expect(cn.status).toBe(201);
    expect(cn.body.creditNote).toMatchObject({ no: "CN-1", amount: 2000 });
    expect((await credit({ creditNoteNo: "CN-2" })).status).toBe(409);
    expect((await call(s.accounts.token, "get", "/api/customer-returns/summary")).body.noCreditNote).toBe(0);
  });

  it("rework: Production reprocesses it, QA checks it again, Dispatch sends it to the customer again", async () => {
    const s = await setup();
    const id = (await s.returnIt(10)).body.id as string;
    const post = (token: string, path: string, body: object) => call(token, "post", `/api/customer-returns/${id}/${path}`, body);

    expect((await post(s.qa.token, "qa", { decision: "REWORK" })).status).toBe(400); // say what has to be done
    expect((await post(s.qa.token, "qa", { decision: "REWORK", note: "Re-sieve and re-pack" })).body.status).toBe("IN_REWORK");
    expect((await call(s.production.token, "get", "/api/customer-returns/summary")).body.inRework).toBe(1);
    expect((await post(s.production.token, "rework-done", { reworkedQty: 12 })).status).toBe(400); // more than came back
    const done = await post(s.production.token, "rework-done", { reworkedQty: 8, note: "2 Kg lost in sieving" });
    expect(done.body).toMatchObject({ status: "WITH_QA", reworked: true, rework: { reworkedQty: 8 } });

    // The second look: pass or scrap only, and no more than what came out
    expect((await post(s.qa.token, "qa", { decision: "REWORK", note: "again" })).status).toBe(409);
    expect((await post(s.qa.token, "qa", { decision: "PASS", passedQty: 9 })).status).toBe(400);
    expect((await post(s.qa.token, "qa", { decision: "PASS" })).body).toMatchObject({ status: "AWAITING_DISPATCH", qa: { passedQty: 8, scrapQty: 2 } });

    // Dispatch sends it again: it is in its stock of the batch and goes out through a normal customer shipment
    expect(await s.dispatchLeft()).toBe(8);
    expect((await post(s.dispatch.token, "dispatch", { choice: "REDISPATCH" })).body.status).toBe("TO_BE_RESENT");
    expect(await s.dispatchLeft()).toBe(8);
    const ship = await call(s.dispatch.token, "post", `/api/fg/batches/${s.batch.id}/customer-shipments`, { quantity: 8 });
    expect(ship.status).toBe(201);
    expect(await s.dispatchLeft()).toBe(0);
  });

  it("QA can scrap a return; nothing comes back into stock", async () => {
    const s = await setup();
    const id = (await s.returnIt(5)).body.id as string;
    const res = await call(s.qa.token, "post", `/api/customer-returns/${id}/qa`, { decision: "SCRAP", note: "Contaminated" });
    expect(res.body).toMatchObject({ status: "SCRAPPED", qa: { decision: "SCRAP", passedQty: 0, scrapQty: 5 } });
    expect(await s.dispatchLeft()).toBe(0);
    expect(await s.product()).toMatchObject({ dispatchedQty: 70, isCompleted: false });
    // The list, by status
    const list = await call(s.qa.token, "get", "/api/customer-returns?status=SCRAPPED");
    expect(list.body).toHaveLength(1);
  });
});
