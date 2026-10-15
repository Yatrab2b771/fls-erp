import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

async function setup() {
  const { token, user } = await createUser(["STORE"]);
  const cocoa = await prisma.inventoryItem.create({ data: { category: "RM", name: "SRC Cocoa", unit: "Kg" } });
  const jar = await prisma.inventoryItem.create({ data: { category: "PM", name: "SRC Jar", unit: "Nos" } });
  const base = { createdById: user.id, type: "RECEIVED" as const };
  const txn = (data: Record<string, unknown>) => prisma.inventoryTransaction.create({ data: { ...base, date: new Date("2026-09-10T00:00:00Z"), unit: "Kg", quantity: 10, ...data } as never });

  await txn({ itemId: cocoa.id, vendorName: "SRC Vendor A", invoiceNo: "SRC-INV-1", grnNo: "SRC-GRN-1", batchNo: "SRC-B1", receiptStatus: "ACCEPTED" });
  await txn({ itemId: jar.id, unit: "Nos", quantity: 50, date: new Date("2026-09-20T00:00:00Z"), vendorName: "SRC Vendor B", invoiceNo: "SRC-INV-2", receiptStatus: "PENDING_QC" });
  // Not "received from a vendor": R&D return, Day Store transfer back, opening stock, deleted.
  await txn({ itemId: cocoa.id, isRndReturn: true, receiptStatus: "ACCEPTED" });
  await txn({ itemId: cocoa.id, isStockTransferReceipt: true, receiptStatus: "ACCEPTED" });
  await txn({ itemId: cocoa.id, isOpeningStock: true, receiptStatus: "ACCEPTED" });
  await txn({ itemId: cocoa.id, vendorName: "SRC Vendor A", deletedAt: new Date(), receiptStatus: "ACCEPTED" });
  return { token };
}

describe("Stock Received - vendor deliveries into the Warehouse", () => {
  it("counts and lists only vendor deliveries, newest first", async () => {
    const { token } = await setup();
    const get = (qs = "") => request(app).get(`/api/inventory/stock-received${qs}`).set(authHeader(token));

    const summary = await request(app).get("/api/inventory/stock-received/summary").set(authHeader(token));
    expect(summary.body.total).toBeGreaterThanOrEqual(2);

    const res = await get("?vendor=SRC%20Vendor%20A&vendor=SRC%20Vendor%20B");
    expect(res.status).toBe(200);
    expect(res.headers["x-total-count"]).toBe("2");
    expect(res.body.map((r: { itemName: string }) => r.itemName)).toEqual(["SRC Jar", "SRC Cocoa"]); // 20 Sep before 10 Sep
    expect(res.body[1]).toMatchObject({ invoiceNo: "SRC-INV-1", grnNo: "SRC-GRN-1", batchNo: "SRC-B1", qcStatus: "Accepted", category: "RM" });
    expect(res.body[0].qcStatus).toBe("Pending QC");
  });

  it("filters: date, category, item, vendor, invoice, GRN, batch, QC status", async () => {
    const { token } = await setup();
    const count = async (qs: string) => (await request(app).get(`/api/inventory/stock-received?vendor=SRC%20Vendor%20A&vendor=SRC%20Vendor%20B&${qs}`).set(authHeader(token))).headers["x-total-count"];

    expect(await count("category=PM")).toBe("1");
    expect(await count("item=SRC%20Cocoa")).toBe("1");
    expect(await count("vendor=SRC%20Vendor%20B")).toBe("2"); // already part of the base filter, still both
    expect(await count("invoiceNo=SRC-INV-2")).toBe("1");
    expect(await count("grnNo=SRC-GRN-1")).toBe("1");
    expect(await count("batchNo=SRC-B1")).toBe("1");
    expect(await count("qcStatus=Pending%20QC")).toBe("1");
    expect(await count("qcStatus=Accepted&qcStatus=Pending%20QC")).toBe("2");
    expect(await count("dateFrom=2026-09-15")).toBe("1");
    expect(await count("dateTo=2026-09-10")).toBe("1"); // the end date runs to the end of that day
    expect(await count("dateFrom=2026-09-11&dateTo=2026-09-19")).toBe("0");
  });

  it("options: distinct values, searchable; unknown field is a 400; other roles are blocked", async () => {
    const { token } = await setup();
    const opt = (qs: string) => request(app).get(`/api/inventory/stock-received/options?${qs}`).set(authHeader(token));

    expect((await opt("field=vendor&q=src vendor")).body.values).toEqual(["SRC Vendor A", "SRC Vendor B"]);
    expect((await opt("field=item&q=src")).body.values).toEqual(["SRC Cocoa", "SRC Jar"]);
    expect((await opt("field=invoiceNo&q=SRC-INV")).body.values).toEqual(["SRC-INV-1", "SRC-INV-2"]);
    expect((await opt("field=nope")).status).toBe(400);

    const { token: bd } = await createUser(["BD"]);
    expect((await request(app).get("/api/inventory/stock-received").set(authHeader(bd))).status).toBe(403);
  });
});
