import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("Available Stock report for a period (Opening / Received / Issued / Closing)", () => {
  it("reads the stock as of any day, for the whole company or for one location", async () => {
    const { token, user } = await createUser(["STORE"]);
    const item = await prisma.inventoryItem.create({ data: { category: "RM", name: `SR Item ${Date.now()}`, unit: "Kg" } });
    const store = await prisma.dayStore.create({ data: { name: `SR Store ${Date.now()}`, createdById: user.id } });
    const plant = await prisma.plant.create({ data: { name: `SR Plant ${Date.now()}`, createdById: user.id, dayStoreId: store.id } });
    const d = (day: string) => new Date(`${day}T10:00:00.000Z`);
    const txn = (data: Record<string, unknown>) => prisma.inventoryTransaction.create({ data: { itemId: item.id, unit: "Kg", createdById: user.id, deliveredAt: new Date(), ...data } as never });

    await txn({ type: "RECEIVED", date: d("2026-09-01"), quantity: 100, receiptStatus: "ACCEPTED" });
    await txn({ type: "RECEIVED", date: d("2026-09-10"), quantity: 50, receiptStatus: "ACCEPTED" });
    await txn({ type: "RECEIVED", date: d("2026-09-12"), quantity: 30, receiptStatus: "PENDING_QC" }); // still in QC: not stock
    await txn({ type: "ISSUED_DAY_STORE", date: d("2026-09-05"), quantity: 40, dayStoreId: store.id });
    await txn({ type: "ISSUED_PRODUCTION", date: d("2026-09-08"), quantity: 10, dayStoreId: store.id, plantId: plant.id });

    const report = async (query: Record<string, string | string[]>) => {
      const res = await request(app).get("/api/inventory/available-stock/report").query({ item: item.name, ...query }).set(authHeader(token));
      expect(res.status).toBe(200);
      return { basis: res.headers["x-report-basis"], row: (res.body as { opening: number; received: number; issued: number; closing: number }[])[0] };
    };

    // Whole company, 2 to 30 Sept: 100 at the start; 50 received; nothing used (the moves between locations cancel); 150 at the end
    const company = await report({ from: "2026-09-02", to: "2026-09-30" });
    expect(company.basis).toBe("company");
    expect(company.row).toMatchObject({ opening: 100, received: 50, issued: 0, closing: 150 });

    // As of 4 Sept (no From): everything before then
    expect((await report({ to: "2026-09-04" })).row).toMatchObject({ opening: 0, received: 100, issued: 0, closing: 100 });

    // The Warehouse alone: 100 at the start, 50 in, 40 out to the Day Store, 110 at the end
    const warehouse = await report({ from: "2026-09-02", to: "2026-09-30", location: "warehouse" });
    expect(warehouse.basis).toBe("locations");
    expect(warehouse.row).toMatchObject({ opening: 100, received: 50, issued: 40, closing: 110 });

    // The Day Store: nothing before 5 Sept, 40 in, 10 out to its Plant, 30 left
    const dayStore = await report({ from: "2026-09-02", to: "2026-09-30", location: `ds:${store.id}` });
    expect(dayStore.row).toMatchObject({ opening: 0, received: 40, issued: 10, closing: 30 });
    // ...and on 4 Sept it had received nothing yet
    expect((await report({ to: "2026-09-04", location: `ds:${store.id}` })).row).toBeUndefined();

    // The Plant: 10 in from its Day Store
    expect((await report({ from: "2026-09-02", to: "2026-09-30", location: `plant:${plant.id}` })).row).toMatchObject({ opening: 0, received: 10, issued: 0, closing: 10 });

    // Two locations together are one group: the Warehouse -> Day Store move (40) is inside the group, so it is neither Received nor Issued
    // (no double counting). Only the 10 the Day Store sent on to its Plant (outside the group) counts as Issued.
    const pair = await report({ from: "2026-09-02", to: "2026-09-30", location: ["warehouse", `ds:${store.id}`] });
    expect(pair.row).toMatchObject({ opening: 100, received: 50, issued: 10, closing: 140 });
    // Add the Plant too and nothing crosses the edge any more
    expect((await report({ from: "2026-09-02", to: "2026-09-30", location: ["warehouse", `ds:${store.id}`, `plant:${plant.id}`] })).row).toMatchObject({ opening: 100, received: 50, issued: 0, closing: 150 });

    // The deliveries behind Received, for the row's dropdown: only what QC accepted, only inside the period, each with its own batch
    const deliveries = async (query: string) => (await request(app).get(`/api/inventory/available-stock/batches?itemId=${item.id}&accepted=1${query}`).set(authHeader(token))).body as { receivedQty: number; receivedOn: string }[];
    expect((await deliveries("&from=2026-09-01&to=2026-09-30")).map((b) => b.receivedQty).sort((x, y) => x - y)).toEqual([50, 100]); // the 30 still in QC is not listed
    expect((await deliveries("&from=2026-09-02&to=2026-09-30")).map((b) => b.receivedQty)).toEqual([50]);

    // Every entry behind the numbers, for the row dropdown: the deliveries, the issue to the Day Store, the issue on to the Plant
    const entriesOf = async (query: Record<string, string | string[]>) =>
      (await request(app).get("/api/inventory/available-stock/report/entries").query({ itemId: item.id, from: "2026-09-02", to: "2026-09-30", ...query }).set(authHeader(token))).body as { label: string; direction: string; qty: number }[];
    const allEntries = await entriesOf({});
    expect(allEntries.map((e) => `${e.label}:${e.direction}`)).toEqual(["Issued to Day Store:MOVED", "Issued to Plant:MOVED", "Received from vendor:IN"]); // 5, 8 and 10 Sept; the first two move stock inside the company
    const warehouseOnly = await entriesOf({ location: "warehouse" });
    expect(warehouseOnly.map((e) => `${e.label}:${e.direction}`)).toEqual(["Issued to Day Store:OUT", "Received from vendor:IN"]);
    const dayStoreOnly = await entriesOf({ location: `ds:${store.id}` });
    expect(dayStoreOnly.map((e) => `${e.label}:${e.direction}`)).toEqual(["Issued to Day Store:IN", "Issued to Plant:OUT"]);

    // A period in which nothing moved still shows the opening / closing balance of what is held
    expect((await report({ from: "2026-09-20", to: "2026-09-25" })).row).toMatchObject({ opening: 150, received: 0, issued: 0, closing: 150 });
  });
});
