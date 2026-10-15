import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("R&D's New Material list and inward QC with a sampling date", () => {
  it("lists what the Warehouse received; every decision needs a sampling date; Testing keeps it out of stock until it is approved", async () => {
    const { token: store } = await createUser(["STORE"]);
    const { token: rnd } = await createUser(["RND"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(store)).send({ category: "RM", name: "NM Flour", unit: "Kg" });
    const received = await request(app)
      .post("/api/inventory/transactions")
      .set(authHeader(store))
      .send({ itemId: item.body.id, type: "RECEIVED", date: "2026-10-01", unit: "Kg", quantity: 100, vendorName: "NM Vendor" });
    const qc = (body: Record<string, unknown>) => request(app).patch(`/api/inventory/transactions/${received.body.id}/qc`).set(authHeader(rnd)).send(body);
    const listed = async () => ((await request(app).get("/api/inventory/new-material").set(authHeader(rnd))).body as { id: string; status: string; samplingDate: string | null; vendorName: string; itemName: string; category: string }[]).find((r) => r.id === received.body.id);

    // R&D only, and the entry shows up as Pending
    expect((await request(app).get("/api/inventory/new-material").set(authHeader(store))).status).toBe(403);
    expect(await listed()).toMatchObject({ status: "PENDING_QC", samplingDate: null, vendorName: "NM Vendor", itemName: "NM Flour", category: "RM" });

    // No sampling date, no decision
    expect((await qc({ action: "TEST" })).status).toBe(400);
    expect((await qc({ action: "HOLD", note: "x" })).status).toBe(400);

    // Testing: sampled, not in stock yet
    const testing = await qc({ action: "TEST", samplingDate: "2026-10-03" });
    expect(testing.status).toBe(200);
    expect(testing.body.receiptStatus).toBe("TESTING");
    expect(await listed()).toMatchObject({ status: "TESTING", samplingDate: expect.stringContaining("2026-10-03") });
    const stock = await request(app).get("/api/inventory/stock").set(authHeader(store));
    const line = (stock.body as { item: { id: string }; onHand: number }[]).find((l) => l.item.id === item.body.id);
    expect(line?.onHand ?? 0).toBe(0);

    // From Testing it can still be held (note needed) and then approved, which puts it in stock
    expect((await qc({ action: "HOLD", samplingDate: "2026-10-03" })).status).toBe(400);
    expect((await qc({ action: "HOLD", samplingDate: "2026-10-03", note: "COA awaited" })).body.receiptStatus).toBe("ON_HOLD");
    const approved = await qc({ action: "APPROVE", samplingDate: "2026-10-03" });
    expect(approved.body.receiptStatus).toBe("ACCEPTED");
    expect(await listed()).toMatchObject({ status: "ACCEPTED" });
    const after = await request(app).get("/api/inventory/stock").set(authHeader(store));
    expect((after.body as { item: { id: string }; onHand: number }[]).find((l) => l.item.id === item.body.id)?.onHand).toBe(100);

    // A decided entry cannot be reviewed again
    expect((await qc({ action: "REJECT", samplingDate: "2026-10-03", note: "late" })).status).toBe(409);
  });

  it("R&D's Quarantine lists pending, testing, held, rejected and expired material, and an approved one drops out", async () => {
    const { token: store } = await createUser(["STORE"]);
    const { token: rnd } = await createUser(["RND"]);
    const item = await request(app).post("/api/inventory/items").set(authHeader(store)).send({ category: "RM", name: "QR Powder", unit: "Kg" });
    const receive = async (extra: Record<string, unknown> = {}) =>
      (await request(app).post("/api/inventory/transactions").set(authHeader(store)).send({ itemId: item.body.id, type: "RECEIVED", date: "2026-10-01", unit: "Kg", quantity: 10, vendorName: "QR Vendor", ...extra })).body.id as string;
    const qc = (id: string, body: Record<string, unknown>) => request(app).patch(`/api/inventory/transactions/${id}/qc`).set(authHeader(rnd)).send({ samplingDate: "2026-10-03", ...body });
    const list = async () => ((await request(app).get("/api/inventory/new-material/quarantine").set(authHeader(rnd))).body as { id: string; reason: string }[]);
    const reasonOf = async (id: string) => (await list()).find((r) => r.id === id)?.reason;

    const pending = await receive();
    const testing = await receive();
    const held = await receive();
    const rejected = await receive();
    const approved = await receive();
    const expired = await receive({ expiryDate: "2027-01-01" });
    await qc(testing, { action: "TEST" });
    await qc(held, { action: "HOLD", note: "COA awaited" });
    await qc(rejected, { action: "REJECT", note: "Damaged" });
    await qc(approved, { action: "APPROVE" });
    await qc(expired, { action: "APPROVE" });
    await prisma.inventoryTransaction.update({ where: { id: expired }, data: { expiryDate: new Date("2026-09-01") } }); // time passes: accepted, but now past its expiry date

    expect(await reasonOf(pending)).toBe("PENDING_QC");
    expect(await reasonOf(testing)).toBe("TESTING");
    expect(await reasonOf(held)).toBe("ON_HOLD");
    expect(await reasonOf(rejected)).toBe("REJECTED");
    expect(await reasonOf(expired)).toBe("EXPIRED");
    expect(await reasonOf(approved)).toBeUndefined(); // approved and in date: usable stock, not quarantine

    // Approving a pending / held one takes it out; releasing the expired one takes it out too
    await qc(held, { action: "APPROVE" });
    expect(await reasonOf(held)).toBeUndefined();
    expect((await request(app).patch(`/api/inventory/transactions/${expired}/release-expiry`).set(authHeader(rnd))).status).toBe(200);
    expect(await reasonOf(expired)).toBeUndefined();
    // Rejected is final: it stays, and cannot be reviewed again
    expect((await qc(rejected, { action: "APPROVE" })).status).toBe(409);
    expect(await reasonOf(rejected)).toBe("REJECTED");

    expect((await request(app).get("/api/inventory/new-material/quarantine").set(authHeader(store))).status).toBe(403);
  });
});
