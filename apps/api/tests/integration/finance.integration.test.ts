import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("Vendor payments (Finance)", () => {
  it("shows Finance only the short RM / PM Purchase has logged a vendor for, and records pay / hold / reject with remarks", async () => {
    const ppic = (await createUser(["PPIC"])).token;
    const purchase = (await createUser(["PURCHASE"])).token;
    const finance = (await createUser(["ACCOUNTS"])).token;
    const stamp = Date.now();
    const item = await prisma.inventoryItem.create({ data: { category: "RM", name: `FIN Item ${stamp}`, unit: "Kg" } });
    const other = await prisma.inventoryItem.create({ data: { category: "RM", name: `FIN Other ${stamp}`, unit: "Kg" } });
    const need = async (itemId: string) => (await request(app).post("/api/inventory/requirements").set(authHeader(ppic)).send({ date: "2026-10-01", category: "RM", itemId, unit: "Kg", requiredQty: 100 })).body as { id: string };
    const a = await need(item.id);
    await need(other.id); // short too, but Purchase has not logged a vendor for it
    const logged = await request(app).patch(`/api/inventory/requirements/${a.id}/purchase`).set(authHeader(purchase)).send({ poNumber: `FIN-PI-${stamp}`, vendorName: "FIN Vendor", eta: "2026-11-01", quantity: 100 });
    expect(logged.status).toBeLessThan(300);

    const list = async () => (await request(app).get("/api/finance/payments").set(authHeader(finance))).body as { lineId: string; piNumber: string; vendorName: string; shortQty: number; status: string; paidTotal: number; balance: number | null; remarks: string | null; itemName: string }[];
    const mine = async () => (await list()).find((r) => r.piNumber === `FIN-PI-${stamp}`)!;
    expect(await mine()).toMatchObject({ itemName: item.name, vendorName: "FIN Vendor", shortQty: 100, status: "PENDING" });
    expect((await list()).some((r) => r.itemName === other.name)).toBe(false); // no vendor logged yet: not for Finance
    expect((await request(app).get("/api/finance/payments").set(authHeader(purchase))).status).toBe(200); // Purchase can see what Finance decided...
    expect((await request(app).get("/api/finance/payments").set(authHeader(ppic))).status).toBe(403); // ...nobody else outside Finance can

    const lineId = (await mine()).lineId;
    const act = (path: string, body: object) => request(app).post(`/api/finance/lines/${lineId}/${path}`).set(authHeader(finance)).send(body);
    expect((await request(app).post(`/api/finance/lines/${lineId}/hold`).set(authHeader(purchase)).send({ remark: "x" })).status).toBe(403); // ...but only Finance decides
    expect((await act("hold", {})).status).toBe(400); // a remark is needed
    expect((await act("hold", { remark: "Earlier invoices unpaid" })).status).toBe(200);
    expect(await mine()).toMatchObject({ status: "ON_HOLD", remarks: "Earlier invoices unpaid" });
    expect((await act("payment", { kind: "PARTIAL", amount: 400, poAmount: 1000, remark: "First part" })).status).toBe(201);
    expect(await mine()).toMatchObject({ status: "PAID_PARTIAL", paidTotal: 400, balance: 600 });
    expect((await act("payment", { kind: "PARTIAL", amount: 600 })).status).toBe(201); // the total reaches the PO amount: paid in full
    expect(await mine()).toMatchObject({ status: "PAID_FULL", paidTotal: 1000, balance: 0 });
    expect((await act("reject", { remark: "Rate is wrong" })).status).toBe(200);
    expect(await mine()).toMatchObject({ status: "REJECTED", remarks: "Rate is wrong" });

    // Purchase sees what Finance decided on its line
    const requirements = (await request(app).get("/api/inventory/requirements").set(authHeader(purchase))).body as { id: string; purchaseLines: { finance: { status: string; remarks: string } | null }[] }[];
    expect(requirements.find((r) => r.id === a.id)?.purchaseLines[0]?.finance).toMatchObject({ status: "REJECTED", remarks: "Rate is wrong" });
  });
});
