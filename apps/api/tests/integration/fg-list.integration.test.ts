import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/** A customer PO with one item, a production run (optionally at a plant), and one batch at the given stage. */
async function fgBatch(bdToken: string, userId: string, o: { po: string; product: string; customer: string; plant?: string; stage: string; produced: number; dispatched?: number; fgDate?: Date; batchNo: string }) {
  const customer = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: o.customer });
  const po = await request(app)
    .post("/api/purchase-orders")
    .set(authHeader(bdToken))
    .send({ customerId: customer.body.id, poNumber: o.po, items: [{ productName: o.product, productCategory: "Powder", quantity: o.produced, unit: "Kg" }] });
  const plant = o.plant ? await prisma.plant.create({ data: { name: o.plant, createdById: userId } }) : null;
  const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: po.body.items[0].id, plannedQty: o.produced, plantId: plant?.id ?? null } });
  return prisma.productionBatch.create({
    data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: userId } }, batchNo: o.batchNo, plannedQty: o.produced, outputQty: o.produced, dispatchedQty: o.dispatched ?? null, currentStageId: o.stage as never, fgStoreReceivedDate: o.fgDate ?? null },
  });
}

// Warehouse finished goods: older batches that reached Billing / Dispatch Plan with stock left, and what Dispatch sent to the Warehouse and the
// Warehouse confirmed (see fg-flow.integration.test.ts for the new flow).
describe("Finished Goods list - batches at or past the FG Store with stock left", () => {
  it("lists only FG stock, with plant, produced / dispatched / on hand", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token, user } = await createUser(["STORE"]);
    await fgBatch(bd, user.id, { po: "FGL-PO-1", product: "FGL Cocoa Powder", customer: "FGL Customer A", plant: "FGL Plant 1", stage: "DISPATCH_PLAN", produced: 1000, dispatched: 300, fgDate: daysAgo(3), batchNo: "FGL-B1" });
    await fgBatch(bd, user.id, { po: "FGL-PO-2", product: "FGL Whey", customer: "FGL Customer B", stage: "DISPATCH_PLAN", produced: 500, fgDate: daysAgo(20), batchNo: "FGL-B2" });
    await fgBatch(bd, user.id, { po: "FGL-PO-3", product: "FGL Still Packing", customer: "FGL Customer C", stage: "FG_STORE", produced: 400, batchNo: "FGL-B3" }); // finished goods still at the Day Store: not Warehouse stock
    await fgBatch(bd, user.id, { po: "FGL-PO-4", product: "FGL All Gone", customer: "FGL Customer D", stage: "DISPATCH_PLAN", produced: 200, dispatched: 200, fgDate: daysAgo(5), batchNo: "FGL-B4" }); // nothing left

    const res = await request(app).get("/api/inventory/fg-list?customer=FGL%20Customer%20A&customer=FGL%20Customer%20B&customer=FGL%20Customer%20C&customer=FGL%20Customer%20D").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.headers["x-total-count"]).toBe("2");
    expect(res.body.map((r: { label: string }) => r.label)).toEqual(["FGL-B1", "FGL-B2"]); // newest into the FG Store first
    expect(res.body[0]).toMatchObject({ poNumber: "FGL-PO-1", productName: "FGL Cocoa Powder", customerName: "FGL Customer A", plantName: "FGL Plant 1", unit: "Kg", producedQty: 1000, dispatchedQty: 300, onHandQty: 700 });
    expect(res.body[1].plantName).toBeNull();
  });

  it("filters: PO, product, customer, plant, batch, FG Store date, aging; options; roles", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token, user } = await createUser(["STORE"]);
    await fgBatch(bd, user.id, { po: "FGX-PO-1", product: "FGX Cocoa", customer: "FGX Cust A", plant: "FGX Plant 1", stage: "DISPATCH_PLAN", produced: 100, fgDate: daysAgo(3), batchNo: "FGX-B1" });
    await fgBatch(bd, user.id, { po: "FGX-PO-2", product: "FGX Whey", customer: "FGX Cust B", plant: "FGX Plant 2", stage: "BILLING_EWAY_BILL", produced: 100, fgDate: daysAgo(40), batchNo: "FGX-B2" });
    const count = async (qs: string) => (await request(app).get(`/api/inventory/fg-list?${qs}`).set(authHeader(token))).headers["x-total-count"];
    const scope = "customer=FGX%20Cust%20A&customer=FGX%20Cust%20B";

    expect(await count(`${scope}&po=FGX-PO-2`)).toBe("1");
    expect(await count(`${scope}&product=FGX%20Cocoa`)).toBe("1");
    expect(await count(`${scope}&plant=FGX%20Plant%202`)).toBe("1");
    expect(await count(`${scope}&batch=FGX-B1`)).toBe("1");
    expect(await count(`${scope}&dateFrom=${daysAgo(10).toISOString().slice(0, 10)}`)).toBe("1");
    expect(await count(`${scope}&aging=0-7%20days`)).toBe("1");
    expect(await count(`${scope}&aging=31-60%20days`)).toBe("1");
    expect(await count(`${scope}&aging=0-7%20days&aging=31-60%20days`)).toBe("2");

    const opt = (qs: string) => request(app).get(`/api/inventory/fg-list/options?${qs}`).set(authHeader(token));
    expect((await opt("field=po&q=FGX")).body.values).toEqual(["FGX-PO-1", "FGX-PO-2"]);
    expect((await opt("field=plant&q=FGX")).body.values).toEqual(["FGX Plant 1", "FGX Plant 2"]);
    expect((await opt("field=nope")).status).toBe(400);
    const { token: other } = await createUser(["BD"]);
    expect((await request(app).get("/api/inventory/fg-list").set(authHeader(other))).status).toBe(403);
  });
});

describe("Finished Goods list - product-wise", () => {
  it("adds up every batch of a product (and shows its batches), per product, with the same filters", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token, user } = await createUser(["STORE"]);
    // One product made in three batches: 400 + 350 (100 of it dispatched) + 250 still at the Day Store (not in the FG stock)
    const first = await fgBatch(bd, user.id, { po: "FGP-PO-1", product: "FGP Cocoa", customer: "FGP Customer", plant: "FGP Plant", stage: "DISPATCH_PLAN", produced: 400, fgDate: daysAgo(10), batchNo: "FGP-B1" });
    const more = (batchNo: string, qty: number, stage: string, dispatched: number | null, fgDate: Date | null) =>
      prisma.productionBatch.create({ data: { preProduction: { connect: { id: first.preProductionId } }, createdBy: { connect: { id: user.id } }, batchNo, plannedQty: qty, outputQty: qty, dispatchedQty: dispatched, currentStageId: stage as never, fgStoreReceivedDate: fgDate } });
    await more("FGP-B2", 350, "DISPATCH_PLAN", 100, daysAgo(4));
    await more("FGP-B3", 250, "PACKAGING", null, null);
    // A second product of another customer
    await fgBatch(bd, user.id, { po: "FGP-PO-2", product: "FGP Whey", customer: "FGP Other", stage: "DISPATCH_PLAN", produced: 120, fgDate: daysAgo(2), batchNo: "FGP-B4" });

    const scope = "customer=FGP%20Customer&customer=FGP%20Other";
    const res = await request(app).get(`/api/inventory/fg-list?${scope}&group=product`).set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.headers["x-total-count"]).toBe("2"); // two products, not four batches
    const cocoa = res.body.find((r: { productName: string }) => r.productName === "FGP Cocoa");
    expect(cocoa).toMatchObject({ poNumber: "FGP-PO-1", customerName: "FGP Customer", plantName: "FGP Plant", unit: "Kg", batchCount: 2, producedQty: 750, dispatchedQty: 100, onHandQty: 650 });
    expect(cocoa.batches.map((b: { label: string }) => b.label).sort()).toEqual(["FGP-B1", "FGP-B2"]);
    // The oldest batch in the FG Store sets the date
    expect(cocoa.fgStoreDate.slice(0, 10)).toBe(daysAgo(10).toISOString().slice(0, 10));

    // The filters still apply: only FGP-B2 -> the product shows with just that batch
    const one = await request(app).get(`/api/inventory/fg-list?${scope}&group=product&batch=FGP-B2`).set(authHeader(token));
    expect(one.body).toHaveLength(1);
    expect(one.body[0]).toMatchObject({ batchCount: 1, producedQty: 350, onHandQty: 250 });

    // The batch-wise list is unchanged
    const batchWise = await request(app).get(`/api/inventory/fg-list?${scope}`).set(authHeader(token));
    expect(batchWise.headers["x-total-count"]).toBe("3");
  });
});
