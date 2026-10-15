import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("A product is complete as soon as its own quantity is dispatched to the customer", () => {
  it("marks the dispatched product complete while the other product, and so the PO, is still open", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { user: owner } = await createUser(["STORE"]);
    const customer = (await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: `ID Customer ${Date.now()}` })).body;
    const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({
      customerId: customer.id,
      poNumber: `ID-PO-${Date.now()}`,
      items: [
        { productName: "ID Sent", productCategory: "Powder", quantity: 100, unit: "KG" },
        { productName: "ID Waiting", productCategory: "Powder", quantity: 50, unit: "KG" },
      ],
    });
    const sentItem = po.body.items.find((i: { productName: string }) => i.productName === "ID Sent").id as string;
    const run = await prisma.preProduction.create({ data: { purchaseOrderItemId: sentItem, plannedQty: 100, currentStageId: "SAMPLE_QC_APPROVAL", sampleQcStatus: "Approved" } });
    const batch = await prisma.productionBatch.create({
      data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: owner.id } }, batchNo: "ID-1", plannedQty: 100, outputQty: 100, status: "COMPLETED", completedAt: new Date(), currentStageId: "FG_HANDOVER", packApprovedQty: 100, handedOverToDispatchAt: new Date() },
    });

    const read = async () => (await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authHeader(bd))).body as { completion: { isCompleted: boolean }; items: { productName: string; dispatch: { dispatchedQty: number; isCompleted: boolean; completionDate: string | null } }[] };
    const of = (b: Awaited<ReturnType<typeof read>>, n: string) => b.items.find((i) => i.productName === n)!;

    // A part is dispatched: not complete yet
    await prisma.fgShipment.create({ data: { productionBatchId: batch.id, type: "CUSTOMER", status: "DISPATCHED", quantity: 60, requestedById: owner.id, sentById: owner.id, sentAt: new Date(), dispatchDate: new Date() } });
    expect(of(await read(), "ID Sent").dispatch).toMatchObject({ dispatchedQty: 60, isCompleted: false });

    // The rest goes: this product is complete, the other one and the PO are not
    await prisma.fgShipment.create({ data: { productionBatchId: batch.id, type: "CUSTOMER", status: "DISPATCHED", quantity: 40, requestedById: owner.id, sentById: owner.id, sentAt: new Date(), dispatchDate: new Date() } });
    const after = await read();
    expect(of(after, "ID Sent").dispatch).toMatchObject({ dispatchedQty: 100, isCompleted: true });
    expect(of(after, "ID Sent").dispatch.completionDate).toBeTruthy();
    expect(of(after, "ID Waiting").dispatch).toMatchObject({ dispatchedQty: 0, isCompleted: false });
    expect(after.completion.isCompleted).toBe(false);

    // A shipment to the Warehouse is not a sale: it does not count
    await prisma.fgShipment.create({ data: { productionBatchId: batch.id, type: "WAREHOUSE", status: "RECEIVED", quantity: 10, requestedById: owner.id } });
    expect(of(await read(), "ID Sent").dispatch.dispatchedQty).toBe(100);
  });
});
