import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

// Every paginated list shares one contract: ?page= &pageSize= &search=, the
// total in X-Total-Count - so a 3,000-row table never has to be loaded whole.
describe("Paginated lists - page, search and total", () => {
  it("vendors: pages through the directory, searches on the server, reports the total", async () => {
    const { token, user } = await createUser(["PURCHASE"]);
    // The test DB's reset clears users but not vendors (a RESTRICT FK), so
    // these rows are removed again at the end of the test.
    const names = ["Alpha Chem", "Beta Chem", "Gamma Pack", "Delta Pack", "Epsilon Labs"];
    await prisma.vendor.createMany({ data: names.map((name, i) => ({ name, code: `V-${i}`, createdById: user.id })) });
    try {

    const first = await request(app).get("/api/vendors?page=1&pageSize=2").set(authHeader(token));
    expect(first.status).toBe(200);
    expect(first.headers["x-total-count"]).toBe("5");
    expect(first.body.map((v: { name: string }) => v.name)).toEqual(["Alpha Chem", "Beta Chem"]);

    const third = await request(app).get("/api/vendors?page=3&pageSize=2").set(authHeader(token));
    expect(third.body.map((v: { name: string }) => v.name)).toEqual(["Gamma Pack"]); // the last, short page

    const search = await request(app).get("/api/vendors?search=pack&page=1&pageSize=50").set(authHeader(token));
    expect(search.headers["x-total-count"]).toBe("2"); // case-insensitive, over the whole directory
    expect(search.body.map((v: { name: string }) => v.name)).toEqual(["Delta Pack", "Gamma Pack"]);

    expect((await request(app).get("/api/vendors?search=nothing-like-this").set(authHeader(token))).headers["x-total-count"]).toBe("0");
    } finally {
      await prisma.vendor.deleteMany({ where: { name: { in: names } } });
    }
  });

  it("customers: same contract", async () => {
    const { token, user } = await createUser(["BD"]);
    await prisma.customer.createMany({ data: ["Acme Foods", "Acme Labs", "Zed Nutrition"].map((companyName) => ({ companyName, createdById: user.id })) });

    const res = await request(app).get("/api/customers?search=acme&pageSize=1&page=2").set(authHeader(token));
    expect(res.headers["x-total-count"]).toBe("2");
    expect(res.body).toHaveLength(1);
    expect(res.body[0].companyName).toBe("Acme Labs");
  });

  it("inventory stock: server-side search + paging, and a summary over EVERY item (not the page)", async () => {
    const { token, user } = await createUser(["STORE"]);
    const items = [];
    for (const name of ["PG-Whey", "PG-Cocoa", "PG-Sugar", "PG-Salt"]) items.push(await prisma.inventoryItem.create({ data: { category: "RM", name, unit: "Kg" } }));
    // PG-Salt goes negative: issued with nothing ever received.
    await prisma.inventoryTransaction.create({ data: { itemId: items[3]!.id, type: "ISSUED_DAY_STORE", date: new Date(), unit: "Kg", quantity: 5, createdById: user.id } });
    // PG-Whey has real stock.
    await prisma.inventoryTransaction.create({
      data: { itemId: items[0]!.id, type: "RECEIVED", date: new Date(), unit: "Kg", quantity: 40, vendorName: "V", createdById: user.id, receiptStatus: "ACCEPTED", acceptedById: user.id, acceptedAt: new Date() },
    });

    const page = await request(app).get("/api/inventory/stock?page=1&pageSize=2").set(authHeader(token));
    expect(page.headers["x-total-count"]).toBe("4");
    expect(page.body).toHaveLength(2);

    const search = await request(app).get("/api/inventory/stock?search=whey&page=1&pageSize=50").set(authHeader(token));
    expect(search.headers["x-total-count"]).toBe("1");
    expect(search.body[0]).toMatchObject({ item: { name: "PG-Whey" }, onHand: 40 });

    // No page params = everything, for the callers that build their own views.
    expect((await request(app).get("/api/inventory/stock").set(authHeader(token))).body).toHaveLength(4);

    const summary = await request(app).get("/api/inventory/stock/summary").set(authHeader(token));
    expect(summary.body).toEqual({ itemsTracked: 4, negativeStock: 1 });
    expect((await request(app).get("/api/inventory/stock/summary?category=PM").set(authHeader(token))).body).toEqual({ itemsTracked: 0, negativeStock: 0 });
  });

  it("inventory items and the transaction ledger: search + total", async () => {
    const { token, user } = await createUser(["STORE"]);
    const a = await prisma.inventoryItem.create({ data: { category: "RM", name: "LG-Protein", unit: "Kg", code: "LG-1" } });
    await prisma.inventoryItem.create({ data: { category: "PM", name: "LG-Jar", unit: "Nos" } });
    for (let i = 0; i < 3; i++) {
      await prisma.inventoryTransaction.create({
        data: { itemId: a.id, type: "RECEIVED", date: new Date(Date.now() - i * 1000), unit: "Kg", quantity: 10 + i, vendorName: i === 0 ? "Findable Vendor" : "Other", createdById: user.id, receiptStatus: "ACCEPTED", acceptedById: user.id, acceptedAt: new Date() },
      });
    }

    const items = await request(app).get("/api/inventory/items?search=lg-1&page=1&pageSize=10").set(authHeader(token));
    expect(items.headers["x-total-count"]).toBe("1"); // matches on code too
    expect((await request(app).get("/api/inventory/items").set(authHeader(token))).body).toHaveLength(2); // no params -> all (dropdown pickers)

    const ledger = await request(app).get("/api/inventory/transactions?type=RECEIVED&page=1&pageSize=2").set(authHeader(token));
    expect(ledger.headers["x-total-count"]).toBe("3");
    expect(ledger.body).toHaveLength(2);
    const byVendor = await request(app).get("/api/inventory/transactions?type=RECEIVED&search=findable").set(authHeader(token));
    expect(byVendor.headers["x-total-count"]).toBe("1");
  });

  it("purchase orders: server-side search over PO / customer / product, and the tiles count every PO", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const { token: ppicToken } = await createUser(["PPIC"]);
    const customer = (await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Pagination Customer" })).body;
    const make = async (poNumber: string, productName: string, approve: boolean) => {
      const po = (
        await request(app)
          .post("/api/purchase-orders")
          .set(authHeader(bdToken))
          .send({ customerId: customer.id, poNumber, items: [{ productName, productCategory: "Powder", quantity: 10, unit: "KG" }] })
      ).body;
      if (approve) await request(app).patch(`/api/purchase-orders/${po.id}/review`).set(authHeader(bdToken)).send({ status: "APPROVED" });
      return po;
    };
    await make("PO-PG-1", "Whey Gold", true);
    await make("PO-PG-2", "Creatine Pure", true);
    await make("PO-PG-3", "Draft Only Product", false);

    // BD sees all three, PPIC only the approved two - and the total says so.
    expect((await request(app).get("/api/purchase-orders?page=1&pageSize=50").set(authHeader(bdToken))).headers["x-total-count"]).toBe("3");
    expect((await request(app).get("/api/purchase-orders?page=1&pageSize=50").set(authHeader(ppicToken))).headers["x-total-count"]).toBe("2");

    const byProduct = await request(app).get("/api/purchase-orders?search=creatine").set(authHeader(ppicToken));
    expect(byProduct.headers["x-total-count"]).toBe("1");
    expect(byProduct.body[0].poNumber).toBe("PO-PG-2");
    expect((await request(app).get("/api/purchase-orders?search=draft only").set(authHeader(ppicToken))).headers["x-total-count"]).toBe("0"); // invisible to PPIC
    expect((await request(app).get("/api/purchase-orders?search=pagination customer").set(authHeader(bdToken))).headers["x-total-count"]).toBe("3");

    const summary = await request(app).get("/api/purchase-orders/summary").set(authHeader(bdToken));
    expect(summary.body).toEqual({ purchaseOrders: 3, products: 3, inProduction: 2 });
    expect((await request(app).get("/api/purchase-orders/summary").set(authHeader(ppicToken))).body).toEqual({ purchaseOrders: 2, products: 2, inProduction: 2 });
  });
});
