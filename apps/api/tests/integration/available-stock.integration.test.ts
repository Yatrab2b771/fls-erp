import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

/**
 * Cocoa (RM): 100 received, 40 to Day Store A, 5 of those on to its own Plant -> Warehouse 60, Day Store A 35, Plant 5, R&D 12
 * Jar (PM):   200 received, all still in the Warehouse
 * Ghost (RM): never received -> not in stock anywhere
 */
async function setup() {
  const { token, user } = await createUser(["STORE"]);
  const cocoa = await prisma.inventoryItem.create({ data: { category: "RM", name: "AVL Cocoa", unit: "Kg" } });
  const jar = await prisma.inventoryItem.create({ data: { category: "PM", name: "AVL Jar", unit: "Nos" } });
  const ghost = await prisma.inventoryItem.create({ data: { category: "RM", name: "AVL Ghost", unit: "Kg" } });
  const dayStore = await prisma.dayStore.create({ data: { name: "AVL Store A", createdById: user.id } });
  const plant = await prisma.plant.create({ data: { name: "AVL Plant P", createdById: user.id, dayStoreId: dayStore.id } });

  const base = { date: new Date(), createdById: user.id };
  await prisma.inventoryTransaction.create({ data: { ...base, itemId: cocoa.id, type: "RECEIVED", unit: "Kg", quantity: 100, vendorName: "V", receiptStatus: "ACCEPTED", acceptedById: user.id, acceptedAt: new Date() } });
  await prisma.inventoryTransaction.create({ data: { ...base, itemId: jar.id, type: "RECEIVED", unit: "Nos", quantity: 200, vendorName: "V", receiptStatus: "ACCEPTED", acceptedById: user.id, acceptedAt: new Date() } });
  await prisma.inventoryTransaction.create({ data: { ...base, itemId: cocoa.id, type: "ISSUED_DAY_STORE", unit: "Kg", quantity: 40, dayStoreId: dayStore.id, deliveredAt: new Date() } });
  await prisma.inventoryTransaction.create({ data: { ...base, itemId: cocoa.id, type: "ISSUED_PRODUCTION", unit: "Kg", quantity: 5, dayStoreId: dayStore.id, plantId: plant.id, deliveredAt: new Date() } });
  await prisma.rndStoreTransaction.create({ data: { itemId: cocoa.id, type: "INBOUND", quantity: 12, unit: "Kg", createdById: user.id } });
  return { token, cocoa, jar, ghost, dayStore, plant };
}

describe("Available Stock - every RM / PM on hand across Warehouse, Stores, R&D Store and Plants", () => {
  it("summary counts the items that have stock somewhere", async () => {
    const { token } = await setup();
    const res = await request(app).get("/api/inventory/available-stock/summary").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ itemsInStock: 2, rmItems: 1, pmItems: 1 }); // Ghost has none
  });

  it("By item: one row per item with a quantity per location and a total", async () => {
    const { token, dayStore, plant } = await setup();
    const res = await request(app).get("/api/inventory/available-stock?view=item").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.headers["x-total-count"]).toBe("2");
    const cocoa = res.body.find((r: { itemName: string }) => r.itemName === "AVL Cocoa");
    expect(cocoa).toMatchObject({ category: "RM", unit: "Kg", total: 112 });
    expect(cocoa.locations).toEqual({ warehouse: 60, [`ds:${dayStore.id}`]: 35, rnd: 12, [`plant:${plant.id}`]: 5 });
    expect(res.body.find((r: { itemName: string }) => r.itemName === "AVL Jar")).toMatchObject({ total: 200, locations: { warehouse: 200 } });
  });

  it("By location: one row per item x location", async () => {
    const { token, dayStore } = await setup();
    const res = await request(app).get("/api/inventory/available-stock?view=location").set(authHeader(token));
    expect(res.headers["x-total-count"]).toBe("5"); // Cocoa x 4 locations + Jar x 1
    expect(res.body).toContainEqual(expect.objectContaining({ itemName: "AVL Cocoa", locationKey: `ds:${dayStore.id}`, locationLabel: "AVL Store A", quantity: 35 }));
  });

  it("filters: location, category, item; the item total follows the chosen locations", async () => {
    const { token, dayStore } = await setup();
    const get = (qs: string) => request(app).get(`/api/inventory/available-stock?${qs}`).set(authHeader(token));

    const onlyDayStore = await get(`view=item&location=ds:${dayStore.id}`);
    expect(onlyDayStore.body.map((r: { itemName: string; total: number }) => [r.itemName, r.total])).toEqual([["AVL Cocoa", 35]]); // the Jar is not in that Store
    expect((await get("view=item&location=warehouse&location=rnd")).body.find((r: { itemName: string }) => r.itemName === "AVL Cocoa").total).toBe(72); // 60 + 12

    expect((await get("view=item&category=PM")).body.map((r: { itemName: string }) => r.itemName)).toEqual(["AVL Jar"]);
    expect((await get("view=location&item=AVL%20Cocoa")).headers["x-total-count"]).toBe("4");
    expect((await get("view=item&category=RM&item=AVL%20Jar")).headers["x-total-count"]).toBe("0");

    // Out-of-stock items only appear when asked for (By item).
    expect((await get("view=item&includeZero=true")).body.map((r: { itemName: string }) => r.itemName)).toContain("AVL Ghost");
  });

  it("meta lists the locations; options search the item names; other roles are kept out", async () => {
    const { token, dayStore, plant } = await setup();
    const meta = await request(app).get("/api/inventory/available-stock/meta").set(authHeader(token));
    expect(meta.body.locations.map((l: { key: string }) => l.key)).toEqual(["warehouse", `ds:${dayStore.id}`, "rnd", `plant:${plant.id}`]);
    const options = await request(app).get("/api/inventory/available-stock/options?q=coco").set(authHeader(token));
    expect(options.body.values).toEqual(["AVL Cocoa"]);

    const { token: bdToken } = await createUser(["BD"]);
    expect((await request(app).get("/api/inventory/available-stock").set(authHeader(bdToken))).status).toBe(403);
  });
});

describe("Available Stock - what the receipts say about each item", () => {
  const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000);

  async function detailSetup() {
    const { token, user } = await createUser(["STORE"]);
    const whey = await prisma.inventoryItem.create({ data: { category: "RM", name: "AVD Whey", code: "AVD-001", unit: "Kg" } });
    const plain = await prisma.inventoryItem.create({ data: { category: "RM", name: "AVD Plain", unit: "Kg" } });
    const base = { createdById: user.id, unit: "Kg", type: "RECEIVED" as const, receiptStatus: "ACCEPTED" as const, acceptedById: user.id, acceptedAt: new Date(), vendorName: "AVD Vendor" };
    // Two batches in stock (expiring in 20 and 200 days), one still in QC, one expired and not released
    await prisma.inventoryTransaction.create({ data: { ...base, itemId: whey.id, date: daysFromNow(-10), quantity: 60, batchNo: "AVD-B1", grnNo: "AVD-G1", mfgDate: daysFromNow(-100), expiryDate: daysFromNow(20) } });
    await prisma.inventoryTransaction.create({ data: { ...base, itemId: whey.id, date: daysFromNow(-2), quantity: 40, batchNo: "AVD-B2", mfgDate: daysFromNow(-30), expiryDate: daysFromNow(200) } });
    await prisma.inventoryTransaction.create({ data: { ...base, itemId: whey.id, date: daysFromNow(-1), quantity: 15, receiptStatus: "PENDING_QC", acceptedById: null, acceptedAt: null, batchNo: "AVD-B3" } });
    await prisma.inventoryTransaction.create({ data: { ...base, itemId: whey.id, date: daysFromNow(-300), quantity: 5, batchNo: "AVD-OLD", expiryDate: daysFromNow(-5) } });
    await prisma.inventoryTransaction.create({ data: { ...base, itemId: plain.id, date: daysFromNow(-3), quantity: 10 } });
    const need = await prisma.preInventoryRequirement.create({ data: { date: new Date(), category: "RM", itemId: whey.id, unit: "Kg", requiredQty: 500, requestedById: user.id } });
    await prisma.requirementPurchaseLine.create({ data: { requirementId: need.id, quantity: 80, receivedQty: 30, piNumber: "AVD-PI-1", vendorName: "AVD Vendor", eta: daysFromNow(9), loggedById: user.id } });
    return { token, whey, plain };
  }

  it("By item carries earliest expiry, batches, last received, quarantine and on-order", async () => {
    const { token, whey } = await detailSetup();
    const res = await request(app).get("/api/inventory/available-stock?view=item&item=AVD%20Whey&item=AVD%20Plain").set(authHeader(token));
    const row = res.body.find((r: { itemId: string }) => r.itemId === whey.id);
    expect(row).toMatchObject({ itemCode: "AVD-001" });
    expect(row.detail).toMatchObject({ batches: 2, quarantineQty: 20, onOrderQty: 50 }); // 15 in QC + 5 expired; 80 ordered - 30 received
    expect(row.detail.expiresInDays).toBe(20);
    expect(new Date(row.detail.earliestExpiry).getTime()).toBeGreaterThan(Date.now());
    expect(row.detail.nextEta).toBeTruthy();
    const plain = res.body.find((r: { itemName: string }) => r.itemName === "AVD Plain");
    expect(plain.detail).toMatchObject({ earliestExpiry: null, batches: 1, quarantineQty: 0, onOrderQty: 0 });
  });

  it("filters: expiry within, has quarantine, has on order", async () => {
    const { token } = await detailSetup();
    const count = async (qs: string) => (await request(app).get(`/api/inventory/available-stock?view=item&item=AVD%20Whey&item=AVD%20Plain&${qs}`).set(authHeader(token))).headers["x-total-count"];
    expect(await count("expiry=Within%2030%20days")).toBe("1");
    expect(await count("expiry=Within%2090%20days")).toBe("1"); // the 200-day batch is not the earliest
    expect(await count("hasQuarantine=Yes")).toBe("1");
    expect(await count("hasQuarantine=No")).toBe("1");
    expect(await count("hasOnOrder=Yes")).toBe("1");
    expect(await count("hasOnOrder=Yes&hasQuarantine=No")).toBe("0");
  });

  it("batches: the receipts behind an item, soonest expiry first; a Store login sees only the QC-accepted ones, without the vendor and invoice", async () => {
    const { token, whey } = await detailSetup();
    const res = await request(app).get(`/api/inventory/available-stock/batches?itemId=${whey.id}`).set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.map((b: { batchNo: string }) => b.batchNo)).toEqual(["AVD-OLD", "AVD-B1", "AVD-B2", "AVD-B3"]); // expired first (soonest), no-expiry last
    expect(res.body.find((b: { batchNo: string }) => b.batchNo === "AVD-OLD").status).toBe("Lab Test");
    expect(res.body.find((b: { batchNo: string }) => b.batchNo === "AVD-B3").status).toBe("Pending QC");
    expect(res.body.find((b: { batchNo: string }) => b.batchNo === "AVD-B1")).toMatchObject({ grnNo: "AVD-G1", receivedQty: 60, vendorName: "AVD Vendor" });

    const lookup = await request(app).post("/api/inventory/available-stock/batches/lookup").set(authHeader(token)).send({ itemIds: [whey.id] });
    expect(lookup.body).toHaveLength(4);

    const { token: ds, user } = await createUser(["STORE"]);
    const store = await prisma.dayStore.create({ data: { name: "AVD Store", createdById: user.id } });
    await prisma.dayStoreAssignment.create({ data: { userId: user.id, dayStoreId: store.id } });
    const asStore = await request(app).get(`/api/inventory/available-stock/batches?itemId=${whey.id}`).set(authHeader(ds));
    expect(asStore.status).toBe(200);
    const storeBatchNos = asStore.body.map((b: { batchNo: string }) => b.batchNo);
    expect(storeBatchNos).toEqual(["AVD-OLD", "AVD-B1", "AVD-B2"]); // AVD-B3 is still pending QC: not accepted, so not shown
    expect(asStore.body.every((b: { vendorName: unknown; invoiceNo: unknown }) => b.vendorName === null && b.invoiceNo === null)).toBe(true);
  });
});
