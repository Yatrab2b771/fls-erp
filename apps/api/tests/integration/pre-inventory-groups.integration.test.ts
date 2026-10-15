import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("Pre-Inventory rows carry the customer PO and product they were raised for", () => {
  it("sourcePo is filled for rows sent from Material Planning, null for manual rows", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken, user: ppic } = await createUser(["PPIC"]);
    const customer = (await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Group Customer" })).body;
    const po = (
      await request(app)
        .post("/api/purchase-orders")
        .set(authHeader(bdToken))
        .send({ customerId: customer.id, poNumber: "PO-GRP-1", items: [{ productName: "Grouped Product", productCategory: "Powder", quantity: 12, unit: "KG" }] })
    ).body;

    const rm = await prisma.inventoryItem.create({ data: { category: "RM", name: "GRP-RM", unit: "Kg" } });
    const pm = await prisma.inventoryItem.create({ data: { category: "PM", name: "GRP-PM", unit: "Nos" } });
    const base = { date: new Date(), requestedById: ppic.id };
    await prisma.preInventoryRequirement.create({ data: { ...base, category: "RM", itemId: rm.id, unit: "Kg", requiredQty: 5, sourcePoItemId: po.items[0].id } });
    await prisma.preInventoryRequirement.create({ data: { ...base, category: "PM", itemId: pm.id, unit: "Nos", requiredQty: 9, sourcePoItemId: po.items[0].id } });
    await prisma.preInventoryRequirement.create({ data: { ...base, category: "RM", itemId: rm.id, unit: "Kg", requiredQty: 1 } }); // manual

    const res = await request(app).get("/api/inventory/requirements").set(authHeader(ppicToken));
    expect(res.status).toBe(200);
    const linked = res.body.filter((r: { sourcePo: unknown }) => r.sourcePo);
    expect(linked).toHaveLength(2);
    expect(linked[0].sourcePo).toMatchObject({ poNumber: "PO-GRP-1", customerName: "Group Customer", productName: "Grouped Product", quantity: 12, unit: "KG" });
    expect(res.body.filter((r: { sourcePo: unknown }) => !r.sourcePo)).toHaveLength(1);
  });

  it("a manual requirement can be tied to a PO product by hand - shown like the rest, never synced with Material Planning", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const customer = (await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Linked Customer" })).body;
    const po = (
      await request(app)
        .post("/api/purchase-orders")
        .set(authHeader(bdToken))
        .send({ customerId: customer.id, poNumber: "PO-LINK-1", items: [{ productName: "Linked Product", productCategory: "Powder", quantity: 8, unit: "KG" }] })
    ).body;
    await request(app).patch(`/api/purchase-orders/${po.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
    const item = await prisma.inventoryItem.create({ data: { category: "RM", name: "LINK-RM", unit: "Kg" } });
    const body = { date: "2026-10-01", category: "RM", itemId: item.id, unit: "Kg", requiredQty: 25 };

    const linked = await request(app).post("/api/inventory/requirements").set(authHeader(ppicToken)).send({ ...body, purchaseOrderItemId: po.items[0].id });
    expect(linked.status).toBe(201);
    expect(linked.body.sourcePo).toMatchObject({ poNumber: "PO-LINK-1", productName: "Linked Product", customerName: "Linked Customer" });
    const row = await prisma.preInventoryRequirement.findUniqueOrThrow({ where: { id: linked.body.id } });
    expect(row.sourcePoItemId).toBeNull(); // not a Material Planning row, so the sync leaves it alone
    expect(row.linkedPoItemId).toBe(po.items[0].id);

    // Without a link, nothing changes; a made-up product id is refused.
    expect((await request(app).post("/api/inventory/requirements").set(authHeader(ppicToken)).send(body)).body.sourcePo).toBeNull();
    expect((await request(app).post("/api/inventory/requirements").set(authHeader(ppicToken)).send({ ...body, purchaseOrderItemId: "11111111-1111-4111-8111-111111111111" })).status).toBe(400);
  });
});
