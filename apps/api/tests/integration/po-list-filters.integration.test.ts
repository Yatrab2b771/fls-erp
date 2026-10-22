import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe("Order Tracking list: customer and Aging filters (server side)", () => {
  it("filters the whole list by customer, by Aging bucket (days since the order date) and by order date, with the search still working", async () => {
    const { token: bd } = await createUser(["BD"]);
    const customerA = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "PF Alpha Foods" });
    const customerB = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: "PF Beta Nutrition" });
    const po = (customerId: string, poNumber: string, orderDate: string) =>
      request(app).post("/api/purchase-orders").set(authHeader(bd)).send({ customerId, poNumber, orderDate, items: [{ productName: `PF Product ${poNumber}`, productCategory: "Powder", quantity: 100, unit: "KG" }] });
    expect((await po(customerA.body.id, "PF-NEW", daysAgo(2))).status).toBe(201);
    expect((await po(customerA.body.id, "PF-MID", daysAgo(20))).status).toBe(201);
    expect((await po(customerB.body.id, "PF-OLD", daysAgo(45))).status).toBe(201);
    expect((await po(customerB.body.id, "PF-OLDER", daysAgo(90))).status).toBe(201);

    const list = async (query: string) => {
      const res = await request(app).get(`/api/purchase-orders?pageSize=50&${query}`).set(authHeader(bd));
      expect(res.status).toBe(200);
      return (res.body as { poNumber: string }[]).map((p) => p.poNumber).sort();
    };

    expect(await list("")).toEqual(["PF-MID", "PF-NEW", "PF-OLD", "PF-OLDER"]);
    // Customer (picked by name; several can be picked)
    expect(await list("customer=PF%20Beta%20Nutrition")).toEqual(["PF-OLD", "PF-OLDER"]);
    expect(await list("customer=PF%20Alpha%20Foods&customer=PF%20Beta%20Nutrition")).toHaveLength(4);
    // Aging: whole days since the order date
    expect(await list("aging=0-7%20days")).toEqual(["PF-NEW"]);
    expect(await list("aging=16-30%20days")).toEqual(["PF-MID"]);
    expect(await list("aging=31-60%20days")).toEqual(["PF-OLD"]);
    expect(await list("aging=60%2B%20days")).toEqual(["PF-OLDER"]);
    expect(await list("aging=0-7%20days&aging=60%2B%20days")).toEqual(["PF-NEW", "PF-OLDER"]); // several buckets
    // Together with a customer, with the order date range, and with the search
    expect(await list("customer=PF%20Beta%20Nutrition&aging=31-60%20days")).toEqual(["PF-OLD"]);
    expect(await list(`dateFrom=${daysAgo(25)}&dateTo=${daysAgo(1)}`)).toEqual(["PF-MID", "PF-NEW"]);
    expect(await list("search=PF-OLD&aging=60%2B%20days")).toEqual(["PF-OLDER"]);
    // The total used by the pager follows the filter
    const paged = await request(app).get("/api/purchase-orders?pageSize=1&aging=31-60%20days").set(authHeader(bd));
    expect(paged.headers["x-total-count"]).toBe("1");
  });
});
