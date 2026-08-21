import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("Day Stores / Plants — named, growable identities", () => {
  it("STORE (or ADMIN) can add a new Day Store / Plant; anyone authenticated can list them; names are unique", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: plainToken } = await createUser([]);

    const deniedCreate = await request(app).post("/api/inventory/day-stores").set(authHeader(plainToken)).send({ name: "Day Store A" });
    expect(deniedCreate.status).toBe(403);

    const created = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Day Store A" });
    expect(created.status).toBe(201);

    const dup = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Day Store A" });
    expect(dup.status).toBe(409);

    const list = await request(app).get("/api/inventory/day-stores").set(authHeader(plainToken));
    expect(list.status).toBe(200);
    expect(list.body.map((d: { name: string }) => d.name)).toEqual(["Day Store A"]);

    const plant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Plant 1" });
    expect(plant.status).toBe(201);
    const plantList = await request(app).get("/api/inventory/plants").set(authHeader(plainToken));
    expect(plantList.body.map((p: { name: string }) => p.name)).toEqual(["Plant 1"]);
  });
});

describe("S6/S7 — Day Store / Plant tagging on the existing ledger", () => {
  it("tags which Day Store received an ISSUED_DAY_STORE entry", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    const dayStore = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Day Store A" });

    const txn = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(storeToken))
      .send({ itemId: item.body.id, type: "ISSUED_DAY_STORE", date: "2026-08-21", unit: "Kg", quantity: 10, dayStoreId: dayStore.body.id });
    expect(txn.status).toBe(201);
    expect(txn.body.dayStore.name).toBe("Day Store A");
  });

  it("tags which Plant a Material Request is for, and carries it onto the issued transaction along with the issuing Day Store", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(storeToken)).send({ category: "RM", name: "Whey Protein" });
    const plant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Plant 1" });
    const dayStore = await request(app).post("/api/inventory/day-stores").set(authHeader(storeToken)).send({ name: "Day Store A" });

    const req1 = await request(app)
      .post("/api/inventory/requests")
      .set(authHeader(ppicToken))
      .send({ itemId: item.body.id, category: "RM", requestedQty: 10, purpose: "ISSUED_PRODUCTION", plantId: plant.body.id });
    expect(req1.body.plant.name).toBe("Plant 1");

    await request(app).patch(`/api/inventory/requests/${req1.body.id}/review`).set(authHeader(storeToken)).send({ action: "APPROVE" });
    const issued = await request(app)
      .post(`/api/inventory/requests/${req1.body.id}/issue`)
      .set(authHeader(storeToken))
      .send({ date: "2026-08-21", unit: "Kg", quantity: 10, dayStoreId: dayStore.body.id });
    expect(issued.status).toBe(201);
    expect(issued.body.plant.name).toBe("Plant 1");
    expect(issued.body.dayStore.name).toBe("Day Store A");
  });
});

describe("S8/S9 — Plant-tagged FG transfer, Dispatch confirmation, Finance invoicing", () => {
  async function createClearedFgTransfer(storeToken: string, qaToken: string) {
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });
    const plant = await request(app).post("/api/inventory/plants").set(authHeader(storeToken)).send({ name: "Plant 1" });
    const fg = await request(app)
      .post("/api/inventory/dispatch-transfers")
      .set(authHeader(storeToken))
      .send({ type: "FG", date: "2026-08-21", customerId: customer.body.id, productName: "Whey Gold 1Kg", quantity: 50, plantId: plant.body.id });
    expect(fg.body.plant.name).toBe("Plant 1");
    await request(app).patch(`/api/inventory/dispatch-transfers/${fg.body.id}/qc`).set(authHeader(qaToken)).send({ action: "APPROVE" });
    return fg.body.id as string;
  }

  it("Dispatch can't confirm before outward QC clears; once cleared, confirms and Finance can then invoice", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const { token: dispatchToken } = await createUser(["DISPATCH"]);
    const { token: accountsToken } = await createUser(["ACCOUNTS"]);
    const { token: bdToken } = await createUser(["BD"]);
    const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Nutrition Pvt. Ltd." });

    const pending = await request(app)
      .post("/api/inventory/dispatch-transfers")
      .set(authHeader(storeToken))
      .send({ type: "FG", date: "2026-08-21", customerId: customer.body.id, productName: "Whey Gold 1Kg", quantity: 50 });

    const tooEarly = await request(app).patch(`/api/inventory/dispatch-transfers/${pending.body.id}/dispatch`).set(authHeader(dispatchToken)).send({});
    expect(tooEarly.status).toBe(409);

    const deniedRole = await request(app).patch(`/api/inventory/dispatch-transfers/${pending.body.id}/dispatch`).set(authHeader(storeToken)).send({});
    expect(deniedRole.status).toBe(403);

    const id = await createClearedFgTransfer(storeToken, qaToken);

    const invoiceTooEarly = await request(app).patch(`/api/inventory/dispatch-transfers/${id}/invoice`).set(authHeader(accountsToken)).send({ invoiceNumber: "INV-1" });
    expect(invoiceTooEarly.status).toBe(409);

    const dispatched = await request(app).patch(`/api/inventory/dispatch-transfers/${id}/dispatch`).set(authHeader(dispatchToken)).send({ dispatchNote: "Via road, LR-123" });
    expect(dispatched.status).toBe(200);
    expect(dispatched.body.dispatchedAt).not.toBeNull();

    const dispatchedAgain = await request(app).patch(`/api/inventory/dispatch-transfers/${id}/dispatch`).set(authHeader(dispatchToken)).send({});
    expect(dispatchedAgain.status).toBe(409);

    const invoiceDeniedRole = await request(app).patch(`/api/inventory/dispatch-transfers/${id}/invoice`).set(authHeader(dispatchToken)).send({ invoiceNumber: "INV-1" });
    expect(invoiceDeniedRole.status).toBe(403);

    const invoiced = await request(app).patch(`/api/inventory/dispatch-transfers/${id}/invoice`).set(authHeader(accountsToken)).send({ invoiceNumber: "INV-1" });
    expect(invoiced.status).toBe(200);
    expect(invoiced.body.invoiceNumber).toBe("INV-1");

    const invoicedAgain = await request(app).patch(`/api/inventory/dispatch-transfers/${id}/invoice`).set(authHeader(accountsToken)).send({ invoiceNumber: "INV-2" });
    expect(invoicedAgain.status).toBe(409);
  });

  it("notifies ACCOUNTS on dispatch confirmation and the original creator on invoicing", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: qaToken } = await createUser(["QA_QC"]);
    const { token: dispatchToken } = await createUser(["DISPATCH"]);
    const { token: accountsToken } = await createUser(["ACCOUNTS"]);

    const id = await createClearedFgTransfer(storeToken, qaToken);
    await request(app).post("/api/notifications/read-all").set(authHeader(accountsToken));
    await request(app).patch(`/api/inventory/dispatch-transfers/${id}/dispatch`).set(authHeader(dispatchToken)).send({});

    const accountsInbox = await request(app).get("/api/notifications").set(authHeader(accountsToken));
    expect(accountsInbox.body.notifications.some((n: { title: string }) => n.title.includes("ready to invoice"))).toBe(true);

    await request(app).post("/api/notifications/read-all").set(authHeader(storeToken));
    await request(app).patch(`/api/inventory/dispatch-transfers/${id}/invoice`).set(authHeader(accountsToken)).send({ invoiceNumber: "INV-9" });

    const storeInbox = await request(app).get("/api/notifications").set(authHeader(storeToken));
    expect(storeInbox.body.notifications.some((n: { title: string }) => n.title.includes("invoiced"))).toBe(true);
  });
});
