import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

/**
 * One approved PO "PO-PP-1" with five products in different states, plus a Draft
 * PO that PPIC must never see:
 *   Alpha   - nothing planned                    -> Not Planned
 *   Bravo   - both plans calculated, covered     -> Material Planning + PO Readiness
 *   Charlie - nothing planned, on hold           -> Hold only (never in the planning lists)
 *   Delta   - cancelled                          -> Cancelled
 *   Echo    - both plans calculated, sent to Production -> In Production (+ Material Planning)
 */
async function setup() {
  const { token: bdToken, user: bd } = await createUser(["BD"]);
  const { token: ppicToken } = await createUser(["PPIC"]);
  const customer = (await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "PPIC Server Customer" })).body;

  const item = (productName: string) => ({ productName, productCategory: "Powder", quantity: 10, unit: "KG" });
  const po = (
    await request(app)
      .post("/api/purchase-orders")
      .set(authHeader(bdToken))
      .send({ customerId: customer.id, poNumber: "PO-PP-1", items: ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map(item) })
  ).body;
  await request(app).patch(`/api/purchase-orders/${po.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
  const draft = (await request(app).post("/api/purchase-orders").set(authHeader(bdToken)).send({ customerId: customer.id, poNumber: "PO-PP-DRAFT", items: [item("Hidden Draft")] })).body;

  const id = (name: string) => po.items.find((i: { productName: string }) => i.productName === name).id as string;
  const plan = async (itemId: string) => {
    await prisma.rmPlan.create({
      data: { name: "rm", createdById: bd.id, purchaseOrderItemId: itemId, status: "CALCULATED", calculatedAt: new Date(), costingParams: {}, resultSnapshot: { procurement: [{ name: "PPIC-MAT", totalKg: 10 }], batches: [] } },
    });
    await prisma.bomPlan.create({ data: { name: "bom", createdById: bd.id, purchaseOrderItemId: itemId, status: "CALCULATED", calculatedAt: new Date(), resultSnapshot: { lines: [], totalYield: 0 } } });
  };
  await plan(id("Bravo"));
  await plan(id("Echo"));
  await prisma.purchaseOrderItem.update({ where: { id: id("Charlie") }, data: { materialHeldAt: new Date() } });
  await prisma.purchaseOrderItem.update({ where: { id: id("Delta") }, data: { cancelledAt: new Date(), cancelReason: "withdrawn" } });
  await prisma.purchaseOrderItem.update({ where: { id: id("Echo") }, data: { planSentToProductionAt: new Date() } });

  const stock = await prisma.inventoryItem.create({ data: { category: "RM", name: "PPIC-MAT", unit: "Kg" } });
  await prisma.inventoryTransaction.create({
    data: { itemId: stock.id, type: "RECEIVED", date: new Date(), unit: "Kg", quantity: 1000, vendorName: "V", createdById: bd.id, receiptStatus: "ACCEPTED", acceptedById: bd.id, acceptedAt: new Date() },
  });
  return { bdToken, ppicToken, po, draft };
}

const names = (rows: { item?: { productName: string } }[]) => rows.map((r) => r.item!.productName).sort();

describe("PPIC dashboard on the server - summary and paged lists", () => {
  it("summary: every tile's number counts every PO, and a Draft PO is invisible to PPIC", async () => {
    const { ppicToken } = await setup();
    const res = await request(app).get("/api/ppic/summary").set(authHeader(ppicToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalPos: 1, // the Draft PO is invisible to PPIC
      totalProducts: 4, // cancelled Delta excluded
      notPlannedPos: 1, // PO-PP-1 has unplanned products
      notPlannedProducts: 1, // Alpha only - Charlie is on Hold, so it is listed only there
      materialPlanning: 0, // Bravo is fully covered (PO Readiness), Echo is in Production, Charlie on Hold: nothing is short
      poReadiness: 1, // only Bravo: Echo already went to Production
      inProduction: 1, // Echo
      onHold: 1, // Charlie
      cancelled: 1, // Delta
      pendingPos: 1,
      qaAwaited: 0,
      poLogged: 0,
    });
  });

  it("tile lists: product by product, server-side filtered, paged, searched", async () => {
    const { ppicToken } = await setup();
    const list = (path: string) => request(app).get(`/api/ppic/lists/${path}`).set(authHeader(ppicToken));

    const notPlanned = await list("not-planned-pos");
    expect(notPlanned.headers["x-total-count"]).toBe("1");
    expect(names(notPlanned.body)).toEqual(["Alpha"]);
    expect(notPlanned.body[0].po.poNumber).toBe("PO-PP-1");
    expect(new Date(notPlanned.body[0].sinceAt).getTime()).not.toBeNaN(); // Aging counts from here
    expect(notPlanned.body[0].po.customer.companyName).toBe("PPIC Server Customer");

    expect(names((await list("plan-sent")).body)).toEqual(["Echo"]);
    expect(names((await list("on-hold")).body)).toEqual(["Charlie"]);
    expect(names((await list("cancelled")).body)).toEqual(["Delta"]);
    expect((await list("total-products")).headers["x-total-count"]).toBe("4"); // cancelled excluded; the Draft PO's product is invisible
    expect((await list("plan-not-sent")).headers["x-total-count"]).toBe("3"); // Alpha, Bravo, Charlie

    // Search + Search By run on the server over the whole list.
    expect((await list("not-planned-pos?search=alph")).headers["x-total-count"]).toBe("1");
    expect((await list("not-planned-pos?search=PO-PP-1&searchField=po")).headers["x-total-count"]).toBe("1");
    expect((await list("not-planned-pos?search=PO-PP-1&searchField=product")).headers["x-total-count"]).toBe("0");
    expect((await list("not-planned-pos?search=server customer&searchField=customer")).headers["x-total-count"]).toBe("1");

    // Paging: total is the full count, the body is one page.
    const page2 = await list("total-products?page=2&pageSize=3");
    expect(page2.headers["x-total-count"]).toBe("4");
    expect(page2.body).toHaveLength(1);

    // Date range on the PO's order date.
    expect((await list("not-planned-pos?dateFrom=2999-01-01")).headers["x-total-count"]).toBe("0");
    expect((await list("not-planned-pos?dateTo=2999-01-01")).headers["x-total-count"]).toBe("1");

    expect((await list("nonsense")).status).toBe(404);
  });

  it("pending POs: each product comes with its stage inputs and its material coverage", async () => {
    const { ppicToken } = await setup();
    const res = await request(app).get("/api/ppic/lists/pending-pos").set(authHeader(ppicToken));
    expect(res.headers["x-total-count"]).toBe("3"); // Charlie is on Hold: only in the On Hold list
    const bravo = res.body.find((r: { item: { productName: string } }) => r.item.productName === "Bravo");
    expect(bravo.materials.rmMaterials).toEqual([expect.objectContaining({ name: "PPIC-MAT", requiredQty: 10, short: false })]);
    expect(bravo.item.rmPlans[0].status).toBe("CALCULATED");
    expect(bravo.preProduction).toBeNull(); // Production hasn't started
  });

  it("Total POs is PO-level, with completion", async () => {
    const { ppicToken } = await setup();
    const res = await request(app).get("/api/ppic/lists/total-pos").set(authHeader(ppicToken));
    expect(res.headers["x-total-count"]).toBe("1"); // the Draft PO is not visible to PPIC
    expect(res.body[0]).toMatchObject({ poNumber: "PO-PP-1", completion: { isCompleted: false } });
  });

  it("Material Planning rows are paged / searched / filtered on the server, with matching header counts", async () => {
    const { ppicToken } = await setup();
    const get = (qs = "") => request(app).get(`/api/ppic/material-planning${qs}`).set(authHeader(ppicToken));

    // Bravo is fully covered, so it is not listed here (it is in PO Readiness); Echo is in Production.
    expect((await get()).headers["x-total-count"]).toBe("0");
    // Once its material is short, Bravo shows up - with all of its materials.
    await prisma.inventoryTransaction.updateMany({ where: { item: { name: "PPIC-MAT" } }, data: { quantity: 5 } });
    const all = await get();
    expect(all.headers["x-total-count"]).toBe("1"); // Bravo's one material
    expect(all.body[0]).toMatchObject({ material: "PPIC-MAT", status: "SHORT" });
    expect(all.body[0].product).toMatchObject({ state: expect.any(String), plannedPlantId: null });

    expect((await get("?search=bravo&searchField=product")).headers["x-total-count"]).toBe("1");
    expect((await get("?search=ppic-mat&searchField=material")).headers["x-total-count"]).toBe("1");
    expect((await get("?search=packaging&searchField=type")).headers["x-total-count"]).toBe("0");
    expect((await get("?onlyShort=true")).headers["x-total-count"]).toBe("1");
    expect((await get("?page=1&pageSize=1")).body).toHaveLength(1);
    expect((await get("?page=2&pageSize=1")).body).toHaveLength(0);

    const summary = await request(app).get("/api/ppic/material-planning/summary").set(authHeader(ppicToken));
    expect(summary.body).toEqual({ materials: 1, covered: 0, short: 1, notInCatalog: 0, onHold: 0 });
  });

  it("PO Readiness lists the products whose material is all covered, paged and searched", async () => {
    const { ppicToken } = await setup();
    const res = await request(app).get("/api/ppic/ready-products").set(authHeader(ppicToken));
    expect(res.headers["x-total-count"]).toBe("1");
    expect(res.body[0]).toMatchObject({ materials: 1, product: { productName: "Bravo", poNumber: "PO-PP-1" } });
    expect(new Date(res.body[0].sinceAt).getTime()).not.toBeNaN(); // when both plans were calculated
    expect((await request(app).get("/api/ppic/ready-products?search=nothing").set(authHeader(ppicToken))).headers["x-total-count"]).toBe("0");
  });

  it("tile filters: PO / customer / category / product picks, the tile's own date, and the options dropdowns", async () => {
    const { bdToken, ppicToken } = await setup();
    // A second PO for another customer and category.
    const other = (await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Zeta Foods" })).body;
    const po2 = (
      await request(app)
        .post("/api/purchase-orders")
        .set(authHeader(bdToken))
        .send({ customerId: other.id, poNumber: "PO-PP-2", items: [{ productName: "Zulu", productCategory: "Gummies", quantity: 5, unit: "KG" }] })
    ).body;
    await request(app).patch(`/api/purchase-orders/${po2.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });

    const total = async (path: string) => (await request(app).get(path).set(authHeader(ppicToken))).headers["x-total-count"];
    expect(await total("/api/ppic/lists/total-products")).toBe("5");
    expect(await total("/api/ppic/lists/total-products?customer=Zeta%20Foods")).toBe("1");
    expect(await total("/api/ppic/lists/total-products?customer=Zeta%20Foods&customer=PPIC%20Server%20Customer")).toBe("5"); // OR inside one filter
    expect(await total("/api/ppic/lists/total-products?po=PO-PP-1&category=Gummies")).toBe("0"); // AND across filters
    expect(await total("/api/ppic/lists/total-products?category=Gummies")).toBe("1");
    expect(await total("/api/ppic/lists/total-products?product=Alpha&product=Zulu")).toBe("2");
    expect(await total("/api/ppic/lists/total-pos?customer=Zeta%20Foods")).toBe("1");
    expect(await total("/api/ppic/lists/total-pos?po=PO-PP-1&po=PO-PP-2")).toBe("2");

    // Each tile's own date: Cancelled counts from the cancel date, so a range around today finds it and a past one doesn't.
    const today = new Date().toISOString().slice(0, 10);
    expect(await total(`/api/ppic/lists/cancelled?dateFrom=${today}&dateTo=${today}`)).toBe("1");
    expect(await total("/api/ppic/lists/cancelled?dateTo=2000-01-01")).toBe("0");
    expect(await total(`/api/ppic/lists/total-products?dateFrom=${today}&dateTo=${today}`)).toBe("5"); // PO approval date

    // Material Planning / PO Readiness filter in memory.
    expect(await total("/api/ppic/material-planning?product=Bravo")).toBe("0"); // covered: not listed
    expect(await total("/api/ppic/material-planning?product=Alpha")).toBe("0");
    expect(await total("/api/ppic/material-planning?customer=Zeta%20Foods")).toBe("0");
    expect(await total("/api/ppic/ready-products?category=Powder")).toBe("1");
    expect(await total("/api/ppic/ready-products?category=Gummies")).toBe("0");
    expect(await total(`/api/ppic/ready-products?dateFrom=2999-01-01`)).toBe("0");

    // Each tile's own pick.
    expect(await total("/api/ppic/lists/not-planned-pos?pending=RM")).toBe("2"); // Alpha and Zulu still lack an RM plan (Charlie is on Hold)
    expect(await total("/api/ppic/lists/not-planned-pos?pending=BOM&pending=RM")).toBe("2");
    expect(await total("/api/ppic/lists/total-products?sent=Sent")).toBe("1"); // Echo
    expect(await total("/api/ppic/lists/total-products?sent=Not%20Sent")).toBe("4");
    expect(await total("/api/ppic/lists/total-products?sent=Sent&sent=Not%20Sent")).toBe("5"); // both = no restriction
    expect(await total("/api/ppic/lists/total-pos?status=Approved")).toBe("2");
    expect(await total("/api/ppic/lists/total-pos?status=Draft")).toBe("0");
    expect(await total("/api/ppic/lists/plan-sent?plant=Nowhere")).toBe("0");
    expect(await total("/api/ppic/ready-products?regulatory=Not%20Sent")).toBe("1");
    expect(await total("/api/ppic/ready-products?regulatory=Approved")).toBe("0");
    // Material Planning's Short / Covered x RM / PM.
    expect(await total("/api/ppic/material-planning?mat=COVERED:RM")).toBe("0"); // covered products are not listed here (PO Readiness)
    expect(await total("/api/ppic/material-planning?mat=SHORT:RM&mat=SHORT:PM")).toBe("0"); // nothing short in this setup
    expect(await total("/api/ppic/material-planning?mat=COVERED:PM")).toBe("0");

    // Aging buckets: "how long in this tile's list". PO-PP-2 was approved 40 days ago, everything else just now.
    await prisma.purchaseOrder.update({ where: { id: po2.id }, data: { reviewedAt: new Date(Date.now() - 40 * 86_400_000) } });
    const aged = (buckets: string[]) => `aging=${buckets.map(encodeURIComponent).join("&aging=")}`;
    expect(await total(`/api/ppic/lists/total-products?${aged(["31-60 days"])}`)).toBe("1"); // Zulu
    expect(await total(`/api/ppic/lists/total-products?${aged(["0-7 days"])}`)).toBe("4");
    expect(await total(`/api/ppic/lists/total-products?${aged(["0-7 days", "31-60 days"])}`)).toBe("5"); // OR across buckets
    expect(await total(`/api/ppic/lists/total-products?${aged(["60+ days"])}`)).toBe("0");
    expect(await total(`/api/ppic/lists/total-pos?${aged(["31-60 days"])}`)).toBe("1");
    expect(await total(`/api/ppic/lists/cancelled?${aged(["0-7 days"])}`)).toBe("1"); // counted from the cancel date
    expect(await total(`/api/ppic/lists/cancelled?${aged(["8-15 days"])}`)).toBe("0");
    expect(await total(`/api/ppic/material-planning?${aged(["0-7 days"])}`)).toBe("0"); // nothing short here (Bravo is covered)
    expect(await total(`/api/ppic/material-planning?${aged(["16-30 days"])}`)).toBe("0");
    expect(await total(`/api/ppic/ready-products?${aged(["0-7 days"])}`)).toBe("1");
    expect(await total(`/api/ppic/ready-products?${aged(["60+ days"])}`)).toBe("0");

    // Options: the tile's own values, searchable.
    const options = async (qs: string) => (await request(app).get(`/api/ppic/filter-options?${qs}`).set(authHeader(ppicToken))).body as { values: string[]; hasMore: boolean };
    expect((await options("tile=total-products&field=customer")).values).toEqual(["PPIC Server Customer", "Zeta Foods"]);
    expect((await options("tile=total-products&field=product&q=zul")).values).toEqual(["Zulu"]);
    expect((await options("tile=cancelled&field=product")).values).toEqual(["Delta"]); // only what that tile lists
    expect((await options("tile=total-products&field=category")).values).toEqual(["Gummies", "Powder"]);
    expect((await options("tile=total-pos&field=po")).values).toEqual(["PO-PP-1", "PO-PP-2"]);
    expect((await options("tile=material-planning&field=product")).values).toEqual([]); // only products short of material are listed
    expect((await options("tile=po-readiness&field=po")).values).toEqual(["PO-PP-1"]);
    expect((await request(app).get("/api/ppic/filter-options?tile=total-products&field=bogus").set(authHeader(ppicToken))).status).toBe(400);
  });
});
