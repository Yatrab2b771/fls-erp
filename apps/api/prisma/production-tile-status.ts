import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/common/lib/prisma";
import { signAccessToken } from "../src/common/lib/jwt";

/**
 * What each Production dashboard tile shows, through the real API as a Production login (one per Plant).
 *   npx tsx prisma/production-tile-status.ts
 * A 0 means that tile is empty.
 */
const app = createApp();

async function main() {
  const users = await prisma.user.findMany({
    where: { roles: { some: { role: { name: "PRODUCTION" } } } },
    orderBy: { email: "asc" },
    include: { roles: { include: { role: true } } },
  });
  for (const user of users) {
    const token = signAccessToken({ sub: user.id, roles: user.roles.map((r) => r.role.name), tokenVersion: user.tokenVersion });
    const get = async (path: string) => {
      const res = await request(app).get(path).set("Authorization", `Bearer ${token}`);
      return res.status === 200 ? res.body : { __error: res.status };
    };
    const len = (b: any) => (b?.__error ? `ERR ${b.__error}` : Array.isArray(b) ? b.length : (b?.rows?.length ?? "?"));
    const plans = await get("/api/pre-productions/plans-board");
    const prep = await get("/api/production-batches/prep-summary");
    console.log(`\n== ${user.email}`);
    console.log("New Plan (plans board rows):", len(plans));
    console.log("Prep summary:", JSON.stringify(prep));
    console.log("Held Products:", len(await get("/api/production-batches/held-products")));
    console.log("Material board rows:", len(await get("/api/pre-productions/material-board")));
    console.log("Packaging board:", len(await get("/api/production-batches/packaging-board")));
    console.log("Plant Stock rows:", len(await get("/api/plant-stock")));
    console.log("Extra Material:", len(await get("/api/inventory/extra-requests")));
    console.log("Handover board:", len(await get("/api/production-batches/handover-board")));
    console.log("Rework summary:", JSON.stringify(await get("/api/customer-returns/summary")));
    console.log("Plans with batches (Production Report):", Array.isArray(plans) ? plans.filter((r: any) => r.batches?.length > 0).length : "?");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
