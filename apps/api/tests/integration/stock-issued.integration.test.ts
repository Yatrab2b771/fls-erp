import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

async function setup() {
  // These rows are built to be in transit: the setup's "the Store receives at once" is off for this file
  (globalThis as { __flsStoreReceivesAtOnce?: boolean }).__flsStoreReceivesAtOnce = false;
  const { token, user } = await createUser(["STORE"]);
  const cocoa = await prisma.inventoryItem.create({ data: { category: "RM", name: "SI Cocoa", unit: "Kg" } });
  const jar = await prisma.inventoryItem.create({ data: { category: "PM", name: "SI Jar", unit: "Nos" } });
  const dayStore = await prisma.dayStore.create({ data: { name: "SI Store A", createdById: user.id } });
  const plant = await prisma.plant.create({ data: { name: "SI Plant P", createdById: user.id } });
  const base = { createdById: user.id, date: new Date("2026-09-10T00:00:00Z") };
  const txn = (data: Record<string, unknown>) => prisma.inventoryTransaction.create({ data: { ...base, unit: "Kg", quantity: 10, ...data } as never });

  await txn({ itemId: cocoa.id, type: "ISSUED_DAY_STORE", dayStoreId: dayStore.id, deliveredAt: new Date(), batchNo: "SI-B1", grnNo: "SI-G1", quantity: 40 });
  await txn({ itemId: jar.id, unit: "Nos", type: "ISSUED_DAY_STORE", dayStoreId: dayStore.id, isTransitTracked: true, date: new Date("2026-09-20T00:00:00Z"), quantity: 100 }); // still in transit
  // A Day Store -> its own Plant issue is not a Warehouse issue, so it never shows here
  await txn({ itemId: cocoa.id, type: "ISSUED_PRODUCTION", dayStoreId: dayStore.id, plantId: plant.id, deliveredAt: new Date(), quantity: 5 });
  await txn({ itemId: cocoa.id, type: "ISSUED_RND", quantity: 2 });
  // Not issues out of the Warehouse: a receipt, a recycle-store entry, and a deleted issue
  await txn({ itemId: cocoa.id, type: "RECEIVED", vendorName: "SI Vendor", receiptStatus: "ACCEPTED" });
  await txn({ itemId: cocoa.id, type: "ISSUED_DAY_STORE", dayStoreId: dayStore.id, deletedAt: new Date() });
  return { token, user };
}

describe("Stock Issued - everything the Warehouse issued out, to Stores and the R&D Store", () => {
  it("lists Store and R&D issues with the location and status, and leaves out a Store -> Plant issue", async () => {
    const { token } = await setup();
    const res = await request(app).get("/api/inventory/stock-issued?item=SI%20Cocoa&item=SI%20Jar").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.headers["x-total-count"]).toBe("3");
    const by = (type: string, item: string) => res.body.find((r: { locationType: string; itemName: string }) => r.locationType === type && r.itemName === item);
    expect(by("Store", "SI Cocoa")).toMatchObject({ locationName: "SI Store A", quantity: 40, batchNo: "SI-B1", grnNo: "SI-G1", status: "Delivered", category: "RM" });
    expect(by("Store", "SI Jar")).toMatchObject({ status: "In Transit", unit: "Nos" });
    expect(by("Plant", "SI Cocoa")).toBeUndefined();
    expect(by("R&D Store", "SI Cocoa")).toMatchObject({ locationName: "R&D Store", quantity: 2 });
    expect(res.body[0].itemName).toBe("SI Jar"); // 20 Sep is newest
  });

  it("filters: location, category, status, batch, GRN, dates, issued by", async () => {
    const { token, user } = await setup();
    const count = async (qs: string) => (await request(app).get(`/api/inventory/stock-issued?item=SI%20Cocoa&item=SI%20Jar&${qs}`).set(authHeader(token))).headers["x-total-count"];

    expect(await count("location=Store:%20SI%20Store%20A")).toBe("2");
    expect(await count("location=R%26D%20Store")).toBe("1");
    expect(await count("location=Store:%20SI%20Store%20A&location=R%26D%20Store")).toBe("3");
    expect(await count("category=PM")).toBe("1");
    expect(await count("status=In%20Transit")).toBe("1");
    expect(await count("status=Delivered")).toBe("2");
    expect(await count("status=Delivered&status=In%20Transit")).toBe("3");
    expect(await count("batchNo=SI-B1")).toBe("1");
    expect(await count("grnNo=SI-G1")).toBe("1");
    expect(await count("dateFrom=2026-09-15")).toBe("1");
    expect(await count(`issuedBy=${encodeURIComponent(user.fullName)}`)).toBe("3");
    expect(await count("issuedBy=Nobody")).toBe("0");
  });

  it("options, summary and roles", async () => {
    const { token } = await setup();
    const opt = (qs: string) => request(app).get(`/api/inventory/stock-issued/options?${qs}`).set(authHeader(token));
    const locations = (await opt("field=location&q=SI")).body.values;
    expect(locations).toEqual(["Store: SI Store A"]);
    expect((await opt("field=location&q=R%26D")).body.values).toEqual(["R&D Store"]);
    expect((await opt("field=batchNo&q=SI-")).body.values).toEqual(["SI-B1"]);
    expect((await opt("field=item&q=SI")).body.values).toEqual(["SI Cocoa", "SI Jar"]);
    expect((await opt("field=nope")).status).toBe(400);

    const summary = await request(app).get("/api/inventory/stock-issued/summary").set(authHeader(token));
    expect(summary.body.total).toBeGreaterThanOrEqual(3);
    const { token: bd } = await createUser(["BD"]);
    expect((await request(app).get("/api/inventory/stock-issued").set(authHeader(bd))).status).toBe(403);
  });
});
