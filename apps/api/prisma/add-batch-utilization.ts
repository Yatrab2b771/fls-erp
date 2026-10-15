import request from "supertest";
import { BATCH_LINE_CLEARANCE_ITEMS } from "../src/modules/batches/batch-checklists";
import type { RoleName } from "@prisma/client";
import { createApp } from "../src/app";
import { prisma } from "../src/common/lib/prisma";
import { signAccessToken } from "../src/common/lib/jwt";

/**
 * A multi-batch demo for a run that has been started but not divided yet: the plan is split into batches, two of them go all the way
 * through Indent Issue, Batch No (the system's serial), Dispensing and Line Clearance, are produced with their own Utilization (used, waste,
 * reject, sample) and completed; the last one waits at Dispensing.
 *
 *   npx tsx prisma/add-batch-utilization.ts
 */
const app = createApp();
const tokens: Record<string, string> = {};

async function tokenFor(role: RoleName) {
  const user = await prisma.user.findFirstOrThrow({ where: { email: `${role.toLowerCase()}@fls.local` }, include: { roles: { include: { role: true } } } });
  tokens[role] = signAccessToken({ sub: user.id, roles: user.roles.map((r) => r.role.name), tokenVersion: user.tokenVersion });
}

async function call<T = any>(role: RoleName, method: "get" | "post" | "patch", path: string, body?: unknown): Promise<T> {
  const req = request(app)[method](path).set("Authorization", `Bearer ${tokens[role]}`);
  const res = await (body === undefined ? req : req.send(body as object));
  if (![200, 201, 204].includes(res.status)) throw new Error(`${role} ${method.toUpperCase()} ${path} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function main() {
  for (const role of ["PRODUCTION", "RND", "QA_QC", "ADMIN"] as RoleName[]) await tokenFor(role);
  const run = await prisma.preProduction.findFirst({ where: { batchFlow: true, productionBatches: { none: {} } }, select: { id: true, plannedQty: true }, orderBy: { createdAt: "asc" } });
  if (!run) return console.log("No started run is waiting to be divided into batches.");

  const parts = [0.4, 0.35, 0.25];
  for (const [b, share] of parts.entries()) {
    const qty = round3(run.plannedQty * share);
    const last = b === parts.length - 1;
    const batch = await call<{ id: string }>("PRODUCTION", "post", `/api/pre-productions/${run.id}/production-batches`, { plannedQty: qty });
    await call("PRODUCTION", "post", `/api/production-batches/${batch.id}/indent`, { prodIndentSlipSign: "DEMO Production Head", productionPlanDate: day(-4) });
    const allocated = await call<{ batchNo: string }>("RND", "post", `/api/production-batches/${batch.id}/batch-no/allocate`, {});
    await call("ADMIN", "post", `/api/production-batches/${batch.id}/dispense`, { rmDispensingDate: day(-3), pmIssuedDate: day(-3), dispensingRemarks: "DEMO: batch material dispensed" });
    if (last) {
      console.log(`batch ${b + 1}: ${qty} · ${allocated.batchNo} · waits at Line Clearance`);
      continue;
    }
    await call("QA_QC", "post", `/api/production-batches/${batch.id}/line-clearance`, { lineClearanceStatus: "Approved", lineClearanceRemarks: "DEMO: line clear", lineClearanceChecks: Object.fromEntries(BATCH_LINE_CLEARANCE_ITEMS.map((i) => [i.key, true])) });

    // Production: start fields, then its Utilization (what it was given: mostly used, a little waste, reject and sample), then the end
    const start = new Date(Date.now() - (parts.length - b) * 86_400_000);
    await call("PRODUCTION", "patch", `/api/production-batches/${batch.id}`, { shift: b % 2 === 0 ? "Day" : "Night", manpowerCount: 8, shiftStartAt: start.toISOString() });
    const items = (await call<{ id: string; utilization: { items: { itemId: string; category: string; unit: string; givenQty: number }[] } }[]>("PRODUCTION", "get", `/api/pre-productions/${run.id}/production-batches`)).find((x) => x.id === batch.id)!.utilization.items;
    for (const n of items.filter((x) => x.category === "RM")) {
      const given = n.givenQty;
      await call("PRODUCTION", "post", `/api/plant-consumption/${run.id}/entries`, {
        itemId: n.itemId,
        unit: n.unit,
        productionBatchId: batch.id,
        consumedQty: round3(given * 0.97),
        wastedQty: round3(given * 0.01),
        rejectedQty: round3(given * 0.01),
        sampleQty: round3(given * 0.01),
        note: "DEMO: batch usage",
      });
    }
    await call("PRODUCTION", "patch", `/api/production-batches/${batch.id}`, { shiftEndAt: new Date(start.getTime() + 9 * 3_600_000).toISOString(), manufacturingStatus: "Completed" });
    const done = await call<{ productionBatch: { inputQty: number; outputQty: number } }>("PRODUCTION", "post", `/api/production-batches/${batch.id}/complete`, {});
    console.log(`batch ${b + 1}: ${qty} · ${allocated.batchNo} · completed (input ${done.productionBatch.inputQty}, output ${done.productionBatch.outputQty})`);
  }
}

main().finally(() => prisma.$disconnect());
