import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";
import { cleanLoad, seedLoad } from "../../scripts/seed-load";

const app = createApp();

// Thousands of rows through the paged endpoints. Slow to seed, so it only runs on
// request:  LOAD_TEST=1 npx vitest run --config vitest.integration.config.mts load
describe.skipIf(!process.env.LOAD_TEST)("paging at 3,000+ rows", () => {
  it("lists, tiles and searches stay correct and fast", async () => {
    const { user, token } = await createUser(["ADMIN", "PPIC"]);
    try {
      await seedLoad(prisma, user.id);
      const timed = async (label: string, path: string) => {
        const t = Date.now();
        const res = await request(app).get(path).set(authHeader(token));
        const ms = Date.now() - t;
        console.log(
          `${label.padEnd(34)} ${String(ms).padStart(5)} ms  total=${res.headers["x-total-count"] ?? "-"}`,
        );
        return { res, ms };
      };

      const po = await timed(
        "PO list page 1",
        "/api/purchase-orders?page=1&pageSize=50",
      );
      expect(po.res.headers["x-total-count"]).toBe("3000");
      expect(po.res.body).toHaveLength(50);
      expect(
        (
          await timed(
            "PO list page 60",
            "/api/purchase-orders?page=60&pageSize=50",
          )
        ).res.body,
      ).toHaveLength(50);
      expect(
        (await timed("PO search", "/api/purchase-orders?search=LOAD-PO-02999"))
          .res.headers["x-total-count"],
      ).toBe("1");
      expect(
        (await timed("PO summary tiles", "/api/purchase-orders/summary")).res
          .status,
      ).toBe(200);
      expect(
        (await timed("PPIC summary tiles", "/api/ppic/summary")).res.body
          .notPlannedPos,
      ).toBe(3000);
      expect(
        (
          await timed(
            "PPIC not-planned list",
            "/api/ppic/lists/not-planned-pos",
          )
        ).res.headers["x-total-count"],
      ).toBe("6000");
      expect((await timed("PPIC list + 3 filters", "/api/ppic/lists/total-products?customer=LOAD-Customer%200001&customer=LOAD-Customer%200002&category=Powder&dateFrom=2000-01-01")).res.status).toBe(200);
      expect((await timed("Filter options: product", "/api/ppic/filter-options?tile=total-products&field=product&q=Product%201")).res.status).toBe(200);
      expect((await timed("Filter options: customer", "/api/ppic/filter-options?tile=not-planned-pos&field=customer")).res.status).toBe(200);
      expect((await timed("Available stock by item", "/api/inventory/available-stock?view=item&page=1&pageSize=50")).res.status).toBe(200);
      expect((await timed("Available stock by location", "/api/inventory/available-stock?view=location&page=1&pageSize=50")).res.status).toBe(200);
      expect((await timed("Available stock summary", "/api/inventory/available-stock/summary")).res.status).toBe(200);
      expect(
        (await timed("Vendors page 2", "/api/vendors?page=2&pageSize=50")).res
          .headers["x-total-count"],
      ).toBe("400");
      expect(
        (
          await timed(
            "Inventory stock page 1",
            "/api/inventory/stock?page=1&pageSize=50",
          )
        ).res.headers["x-total-count"],
      ).toBe("3000");
      expect(
        (
          await timed(
            "Inventory txns page 1",
            "/api/inventory/transactions?page=1&pageSize=50",
          )
        ).res.headers["x-total-count"],
      ).toBe("5000");
      for (const r of [po]) expect(r.ms).toBeLessThan(5000);
    } finally {
      // vendors are RESTRICT-linked to users, which the suite's DB reset deletes
      await cleanLoad(prisma);
    }
  }, 300_000);
});
