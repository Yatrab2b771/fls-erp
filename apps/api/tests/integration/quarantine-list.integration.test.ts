import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function setup() {
  const { token, user } = await createUser(["STORE"]);
  const cocoa = await prisma.inventoryItem.create({ data: { category: "RM", name: "QL Cocoa", unit: "Kg" } });
  const jar = await prisma.inventoryItem.create({ data: { category: "PM", name: "QL Jar", unit: "Nos" } });
  const txn = (data: Record<string, unknown>) =>
    prisma.inventoryTransaction.create({ data: { createdById: user.id, type: "RECEIVED", unit: "Kg", quantity: 10, vendorName: "QL Vendor", date: daysAgo(3), ...data } as never });

  await txn({ itemId: cocoa.id, receiptStatus: "PENDING_QC", grnNo: "QL-G1", date: daysAgo(3) }); // Awaiting QC, 3 days
  await txn({ itemId: jar.id, unit: "Nos", receiptStatus: "ON_HOLD", grnNo: "QL-G2", date: daysAgo(20) }); // On Hold, 20 days
  await txn({ itemId: cocoa.id, receiptStatus: "ACCEPTED", grnNo: "QL-G3", date: daysAgo(100), expiryDate: daysAgo(40) }); // Lab Test, 40 days past expiry
  // Not quarantined: accepted + in date, released after expiry, QC approved, deleted
  await txn({ itemId: cocoa.id, receiptStatus: "ACCEPTED", grnNo: "QL-X1", expiryDate: new Date(Date.now() + 30 * 86_400_000) });
  await txn({ itemId: cocoa.id, receiptStatus: "ACCEPTED", grnNo: "QL-X2", expiryDate: daysAgo(5), expiryReleasedAt: new Date() });
  await txn({ itemId: cocoa.id, receiptStatus: "QC_APPROVED", grnNo: "QL-X3" });
  await txn({ itemId: cocoa.id, receiptStatus: "PENDING_QC", grnNo: "QL-X4", deletedAt: new Date() });
  return { token };
}

describe("Quarantine list - Awaiting QC, On Hold and Lab Test, paged and filterable", () => {
  it("lists the three kinds with the right reason and 'since' date", async () => {
    const { token } = await setup();
    const res = await request(app).get("/api/inventory/quarantine-list?vendor=QL%20Vendor").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.headers["x-total-count"]).toBe("3");
    const by = (grn: string) => res.body.find((r: { grnNo: string }) => r.grnNo === grn);
    expect(by("QL-G1").reason).toBe("Awaiting QC");
    expect(by("QL-G2").reason).toBe("On Hold");
    expect(by("QL-G3")).toMatchObject({ reason: "Lab Test", category: "RM" });
    expect(new Date(by("QL-G3").sinceAt).getTime()).toBe(new Date(by("QL-G3").expiryDate).getTime()); // Lab Test ages from expiry
    expect(new Date(by("QL-G1").sinceAt).getTime()).toBe(new Date(by("QL-G1").date).getTime());
  });

  it("filters: reason, category, item, GRN, dates, expiry date and aging", async () => {
    const { token } = await setup();
    const count = async (qs: string) => (await request(app).get(`/api/inventory/quarantine-list?vendor=QL%20Vendor&${qs}`).set(authHeader(token))).headers["x-total-count"];

    expect(await count("reason=Lab%20Test")).toBe("1");
    expect(await count("reason=Awaiting%20QC&reason=On%20Hold")).toBe("2");
    expect(await count("category=PM")).toBe("1");
    expect(await count("item=QL%20Cocoa")).toBe("2");
    expect(await count("grnNo=QL-G2")).toBe("1");
    expect(await count(`dateFrom=${daysAgo(30).toISOString().slice(0, 10)}`)).toBe("2"); // the 100-day-old receipt drops out
    expect(await count(`expiryTo=${daysAgo(1).toISOString().slice(0, 10)}`)).toBe("1");
    // Aging: 3 days (Awaiting QC), 20 days (On Hold), 40 days past expiry (Lab Test)
    expect(await count("aging=0-7%20days")).toBe("1");
    expect(await count("aging=16-30%20days")).toBe("1");
    expect(await count("aging=31-60%20days")).toBe("1");
    expect(await count("aging=0-7%20days&aging=31-60%20days")).toBe("2");
    expect(await count("aging=60%2B%20days")).toBe("0");
  });

  it("options: distinct values among quarantined entries; unknown field 400; other roles blocked", async () => {
    const { token } = await setup();
    const opt = (qs: string) => request(app).get(`/api/inventory/quarantine-list/options?${qs}`).set(authHeader(token));
    expect((await opt("field=grnNo&q=QL-")).body.values).toEqual(["QL-G1", "QL-G2", "QL-G3"]); // never the released / in-date ones
    expect((await opt("field=item&q=QL")).body.values).toEqual(["QL Cocoa", "QL Jar"]);
    expect((await opt("field=nope")).status).toBe(400);
    const { token: bd } = await createUser(["BD"]);
    expect((await request(app).get("/api/inventory/quarantine-list").set(authHeader(bd))).status).toBe(403);
  });
});
