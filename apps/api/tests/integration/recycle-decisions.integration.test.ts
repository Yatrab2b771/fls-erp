import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";
import { getOnHandByPlantAndItem } from "../../src/modules/inventory/stock";

const app = createApp();
const call = (token: string, method: "get" | "post", path: string, body?: object) => {
  const r = request(app)[method](path).set(authHeader(token));
  return body ? r.send(body) : r;
};

/** A Plant, an item, and two Recycle Store entries the Plant wrote: 10 Kg REJECTED and 4 Kg WASTAGE. */
async function setup() {
  const qa = await createUser(["QA_QC"]);
  const store = await createUser(["STORE"]);
  const production = await createUser(["PRODUCTION"]);
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const plant = await prisma.plant.create({ data: { name: `RC Plant ${stamp}`, createdById: production.user.id } });
  const item = await prisma.inventoryItem.create({ data: { category: "RM", name: `RC Whey ${stamp}`, unit: "Kg" } });
  const entry = (quantity: number, kind: "REJECTED" | "WASTAGE") =>
    prisma.inventoryTransaction.create({ data: { itemId: item.id, type: "ISSUED_RECYCLE", recycleKind: kind, date: new Date(), unit: "Kg", quantity, plantId: plant.id, createdById: production.user.id, deliveredAt: new Date(), remark: `${kind === "REJECTED" ? "Rejected" : "Wasted"} at the Plant - test` } });
  const rejected = await entry(10, "REJECTED");
  const wasted = await entry(4, "WASTAGE");
  const onHand = async () => (await getOnHandByPlantAndItem(plant.id, [item.id])).get(item.id) ?? 0;
  const decide = (token: string, id: string, body: object) => call(token, "post", `/api/recycle-store/entries/${id}/decision`, body);
  return { qa, store, production, plant, item, rejected, wasted, onHand, decide };
}

describe("Recycle Store: QA decides what happens to rejected material", () => {
  it("lists what waits, and reuse puts the material back into the Plant's stock", async () => {
    const s = await setup();
    expect((await call(s.qa.token, "get", "/api/recycle-store/summary")).body.toDecide).toBeGreaterThanOrEqual(1);

    const feed = (await call(s.qa.token, "get", "/api/recycle-store/transactions")).body as { id: string; recycleKind: string; toDecide: number }[];
    expect(feed.find((r) => r.id === s.rejected.id)).toMatchObject({ recycleKind: "REJECTED", toDecide: 10 });
    expect(feed.find((r) => r.id === s.wasted.id)).toMatchObject({ recycleKind: "WASTAGE", toDecide: 0 });

    expect(await s.onHand()).toBe(0);
    // Only QA decides, and not more than what is left
    expect((await s.decide(s.store.token, s.rejected.id, { decision: "REUSE", quantity: 3 })).status).toBe(403);
    expect((await s.decide(s.qa.token, s.rejected.id, { decision: "REUSE", quantity: 11 })).status).toBe(409);
    const reuse = await s.decide(s.qa.token, s.rejected.id, { decision: "REUSE", quantity: 6, note: "Sieved and checked" });
    expect(reuse.status).toBe(201);
    expect(reuse.body.left).toBe(4);
    expect(await s.onHand()).toBe(6); // back in the Plant's stock

    // The rest is destroyed, with a certificate
    const destroy = await s.decide(s.qa.token, s.rejected.id, { decision: "DESTROY", quantity: 4, certificateNo: "DC-77" });
    expect(destroy.status).toBe(201);
    expect(destroy.body.left).toBe(0);
    expect(await s.onHand()).toBe(6); // destroying changes no stock

    const after = (await call(s.qa.token, "get", "/api/recycle-store/transactions")).body as { id: string; toDecide: number; decisions: { decision: string; quantity: number; certificateNo: string | null }[] }[];
    const row = after.find((r) => r.id === s.rejected.id)!;
    expect(row.toDecide).toBe(0);
    expect(row.decisions.map((d) => [d.decision, d.quantity, d.certificateNo])).toEqual([["REUSE", 6, null], ["DESTROY", 4, "DC-77"]]);
    expect((await s.decide(s.qa.token, s.rejected.id, { decision: "DESTROY", quantity: 1 })).status).toBe(409); // nothing left
  });

  it("wastage is gone for good: it needs no decision and cannot be decided", async () => {
    const s = await setup();
    const res = await s.decide(s.qa.token, s.wasted.id, { decision: "REUSE", quantity: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("gone for good");
    expect(await s.onHand()).toBe(0);
  });
});
