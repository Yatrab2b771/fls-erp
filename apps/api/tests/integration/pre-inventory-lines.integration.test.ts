import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";
import { allocateReceiptToPurchaseLines } from "../../src/modules/inventory/purchase-lines";

const app = createApp();

async function setup(requiredQty = 100) {
  const { token: ppicToken, user: ppic } = await createUser(["PPIC"]);
  const { token: purchaseToken } = await createUser(["PURCHASE"]);
  const item = await prisma.inventoryItem.create({ data: { category: "RM", name: `Split Item ${Math.random().toString(36).slice(2, 7)}`, unit: "Kg" } });
  const requirement = await prisma.preInventoryRequirement.create({ data: { date: new Date(), category: "RM", itemId: item.id, unit: "Kg", requiredQty, requestedById: ppic.id } });
  return { ppicToken, ppic, purchaseToken, item, requirement };
}

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function log(token: string, id: string, body: Record<string, unknown>) {
  return request(app).patch(`/api/inventory/requirements/${id}/purchase`).set(authHeader(token)).send(body);
}

describe("Purchase splits a shortfall into several PI lines", () => {
  it("20 + 40 + 40 Kg, each with its own PI / vendor / ETA; nothing beyond the shortfall", async () => {
    const { purchaseToken, requirement } = await setup(100);

    const first = await log(purchaseToken, requirement.id, { quantity: 20, poNumber: "PI-1", vendorName: "Vendor A", eta: day(5) });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ shortQty: 100, onOrderQty: 20, remainingToLog: 80 });
    expect(first.body.purchaseLines).toHaveLength(1);

    expect((await log(purchaseToken, requirement.id, { quantity: 40, poNumber: "PI-2", vendorName: "Vendor B", eta: day(10) })).body).toMatchObject({ onOrderQty: 60, remainingToLog: 40 });
    const third = await log(purchaseToken, requirement.id, { quantity: 40, poNumber: "PI-3", vendorName: "Vendor C", eta: day(15) });
    expect(third.body).toMatchObject({ onOrderQty: 100, remainingToLog: 0 });
    expect(third.body.purchaseLines.map((l: { piNumber: string; vendorName: string; quantity: number }) => [l.piNumber, l.vendorName, l.quantity])).toEqual([
      ["PI-1", "Vendor A", 20],
      ["PI-2", "Vendor B", 40],
      ["PI-3", "Vendor C", 40],
    ]);

    // Fully on PIs now: nothing left to log, and no over-ordering.
    expect((await log(purchaseToken, requirement.id, { quantity: 5, poNumber: "PI-4", vendorName: "Vendor D", eta: day(20) })).status).toBe(409);
  });

  it("refuses a quantity above what is left, and a line's quantity above the shortfall", async () => {
    const { purchaseToken, requirement } = await setup(50);
    const tooMuch = await log(purchaseToken, requirement.id, { quantity: 60, poNumber: "PI-X", vendorName: "V", eta: day(3) });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toMatch(/Only 50 Kg/);

    const ok = await log(purchaseToken, requirement.id, { quantity: 30, poNumber: "PI-A", vendorName: "V", eta: day(3) });
    const lineId = ok.body.purchaseLines[0].id;
    expect((await log(purchaseToken, requirement.id, { quantity: 30, poNumber: "PI-B", vendorName: "V", eta: day(4) })).status).toBe(400); // only 20 left
    const edit = (body: Record<string, unknown>) => request(app).patch(`/api/inventory/requirements/${requirement.id}/lines/${lineId}`).set(authHeader(purchaseToken)).send(body);
    expect((await edit({ quantity: 60, poNumber: "PI-A", vendorName: "V", eta: day(3) })).status).toBe(400);
    const grown = await edit({ quantity: 45, poNumber: "PI-A2", vendorName: "V2", eta: day(6) });
    expect(grown.status).toBe(200);
    expect(grown.body).toMatchObject({ onOrderQty: 45, remainingToLog: 5 });
    expect(grown.body.purchaseLines[0]).toMatchObject({ piNumber: "PI-A2", vendorName: "V2", quantity: 45 });
    expect(grown.body.purchaseLines[0].correctedAt).not.toBeNull();
  });

  it("sending no quantity still works the old way: logs everything, and a second call corrects it", async () => {
    const { purchaseToken, requirement } = await setup(70);
    const first = await log(purchaseToken, requirement.id, { poNumber: "PI-OLD", vendorName: "Vendor", eta: day(4) });
    expect(first.body).toMatchObject({ onOrderQty: 70, remainingToLog: 0 });
    const fixed = await log(purchaseToken, requirement.id, { poNumber: "PI-FIXED", vendorName: "Vendor 2", eta: day(8) });
    expect(fixed.status).toBe(200);
    expect(fixed.body.purchaseLines).toHaveLength(1); // corrected, not a second line
    expect(fixed.body.purchaseLines[0]).toMatchObject({ piNumber: "PI-FIXED", vendorName: "Vendor 2" });
    // The requirement's own columns follow the latest line, for everything that still reads them.
    expect(fixed.body).toMatchObject({ poNumber: "PI-FIXED", vendorName: "Vendor 2" });
  });

  it("removing a line frees its quantity; a line that has partly arrived cannot be removed", async () => {
    const { purchaseToken, requirement, item, ppic } = await setup(100);
    const a = await log(purchaseToken, requirement.id, { quantity: 60, poNumber: "PI-A", vendorName: "V", eta: day(2) });
    const b = await log(purchaseToken, requirement.id, { quantity: 40, poNumber: "PI-B", vendorName: "V", eta: day(9) });
    const del = (lineId: string) => request(app).delete(`/api/inventory/requirements/${requirement.id}/lines/${lineId}`).set(authHeader(purchaseToken));

    const removed = await del(b.body.purchaseLines[1].id);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ onOrderQty: 60, remainingToLog: 40 });

    // 25 Kg arrives (accepted into stock) -> the earliest-ETA line is partly received.
    await prisma.inventoryTransaction.create({
      data: { itemId: item.id, type: "RECEIVED", date: new Date(), unit: "Kg", quantity: 25, vendorName: "V", createdById: ppic.id, receiptStatus: "ACCEPTED", acceptedById: ppic.id, acceptedAt: new Date() },
    });
    await allocateReceiptToPurchaseLines(item.id, 25);
    expect((await del(a.body.purchaseLines[0].id)).status).toBe(409);
  });

  it("a receipt closes lines earliest ETA first, and the shortfall is not counted twice", async () => {
    const { purchaseToken, requirement, item, ppic } = await setup(100);
    for (const [i, qty] of [20, 40, 40].entries()) await log(purchaseToken, requirement.id, { quantity: qty, poNumber: `PI-${i + 1}`, vendorName: `V${i + 1}`, eta: day(5 * (i + 1)) });

    await prisma.inventoryTransaction.create({
      data: { itemId: item.id, type: "RECEIVED", date: new Date(), unit: "Kg", quantity: 30, vendorName: "V1", createdById: ppic.id, receiptStatus: "ACCEPTED", acceptedById: ppic.id, acceptedAt: new Date() },
    });
    await allocateReceiptToPurchaseLines(item.id, 30);

    const lines = await prisma.requirementPurchaseLine.findMany({ where: { requirementId: requirement.id }, orderBy: { eta: "asc" } });
    expect(lines.map((l) => [l.status, l.receivedQty])).toEqual([
      ["RECEIVED", 20], // fully arrived
      ["OPEN", 10], // 10 of 40 arrived
      ["OPEN", 0],
    ]);

    const list = await request(app).get("/api/inventory/requirements").set(authHeader(purchaseToken));
    const row = list.body.find((r: { id: string }) => r.id === requirement.id);
    // 30 Kg in stock -> 70 short; 70 Kg still on its way (30 + 40) -> everything short is covered by PIs.
    expect(row).toMatchObject({ currentStock: 30, shortQty: 70, onOrderQty: 70, remainingToLog: 0 });
  });

  it("Incoming Material lists the open PI lines (earliest ETA first) for Store and PPIC, with filters, options and a summary", async () => {
    const { purchaseToken, requirement, item } = await setup(100);
    await log(purchaseToken, requirement.id, { quantity: 30, poNumber: "PI-LATE", vendorName: "Slow Vendor", eta: day(-3) }); // already overdue
    await log(purchaseToken, requirement.id, { quantity: 20, poNumber: "PI-SOON", vendorName: "Fast Vendor", eta: day(4) });
    await log(purchaseToken, requirement.id, { quantity: 50, poNumber: "PI-FAR", vendorName: "Fast Vendor", eta: day(30) });
    const { token: storeToken } = await createUser(["STORE"]);
    const { token: ppicToken } = await createUser(["PPIC"]);

    for (const token of [storeToken, ppicToken]) {
      const res = await request(app).get("/api/inventory/requirements/incoming").set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.headers["x-total-count"]).toBe("3");
      expect(res.body.map((r: { piNumber: string }) => r.piNumber)).toEqual(["PI-LATE", "PI-SOON", "PI-FAR"]);
      expect(res.body[0]).toMatchObject({ itemName: item.name, quantity: 30, vendorName: "Slow Vendor", overdue: true, unit: "Kg" });
    }

    const get = (qs: string) => request(app).get(`/api/inventory/requirements/incoming?${qs}`).set(authHeader(storeToken));
    expect((await get("vendor=Fast%20Vendor")).headers["x-total-count"]).toBe("2");
    expect((await get("pi=PI-FAR&pi=PI-SOON")).headers["x-total-count"]).toBe("2");
    expect((await get(`dateFrom=${day(1)}&dateTo=${day(10)}`)).headers["x-total-count"]).toBe("1"); // PI-SOON
    expect((await get("category=PM")).headers["x-total-count"]).toBe("0");
    // Not tied to a customer PO, so a Customer PO / Product pick matches nothing and offers no options.
    expect((await get("customerPo=PO-ANY")).headers["x-total-count"]).toBe("0");
    expect((await request(app).get("/api/inventory/requirements/incoming/options?field=customerPo").set(authHeader(storeToken))).body.values).toEqual([]);

    const summary = await request(app).get("/api/inventory/requirements/incoming/summary").set(authHeader(storeToken));
    expect(summary.body).toEqual({ lines: 3, materials: 1, overdue: 1, dueThisWeek: 1 });

    const options = await request(app).get("/api/inventory/requirements/incoming/options?field=vendor&q=fast").set(authHeader(storeToken));
    expect(options.body.values).toEqual(["Fast Vendor"]);

    // Once stock covers the requirement the lines stop being "incoming".
    await prisma.inventoryTransaction.create({
      data: { itemId: item.id, type: "RECEIVED", date: new Date(), unit: "Kg", quantity: 500, vendorName: "x", createdById: (await prisma.user.findFirstOrThrow()).id, receiptStatus: "ACCEPTED", acceptedAt: new Date() },
    });
    expect((await get("")).headers["x-total-count"]).toBe("0");
  });

  it("the PI-log Excel import can split one shortfall over several rows (optional quantity), and refuses to over-order", async () => {
    const { purchaseToken, requirement, item } = await setup(100);
    const row = (quantity: number | undefined, pi: string) => ({ itemName: item.name, category: "RM", poNumber: pi, vendorName: "Imp Vendor", eta: day(7), ...(quantity ? { quantity } : {}) });
    const res = await request(app)
      .post("/api/inventory/requirements/purchase/import")
      .set(authHeader(purchaseToken))
      .send({ rows: [row(60, "PI-I1"), row(30, "PI-I2"), row(30, "PI-I3")] }); // 60 + 30 fit, the third 30 does not (only 10 left)
    expect(res.status).toBe(201);
    expect(res.body.posLogged).toBe(2);
    expect(res.body.unmatched).toHaveLength(1);
    const lines = await prisma.requirementPurchaseLine.findMany({ where: { requirementId: requirement.id }, orderBy: { loggedAt: "asc" } });
    expect(lines.map((l) => [l.piNumber, l.quantity])).toEqual([["PI-I1", 60], ["PI-I2", 30]]);

    // Without a quantity a row covers everything still to log.
    const rest = await request(app).post("/api/inventory/requirements/purchase/import").set(authHeader(purchaseToken)).send({ rows: [row(undefined, "PI-I4")] });
    expect(rest.body.posLogged).toBe(1);
    expect((await prisma.requirementPurchaseLine.findMany({ where: { requirementId: requirement.id } })).reduce((sum, l) => sum + l.quantity, 0)).toBe(100);
  });
});
