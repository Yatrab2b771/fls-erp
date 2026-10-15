import request from "supertest";
import type { RoleName } from "@prisma/client";
import { createApp } from "../src/app";
import { prisma } from "../src/common/lib/prisma";
import { signAccessToken } from "../src/common/lib/jwt";

/**
 * Demo sample requests (dev data only) for the demo leads: BD raises them, R&D gives ETAs, makes some, hands some over, and BD enters feedback
 * on a few (one asks for a change, so it is in round 2). Needs prisma/seed-leads.ts to have been run.
 *
 *   npx tsx prisma/seed-samples.ts
 */
const app = createApp();
const tokens: Record<string, string> = {};

async function tokenFor(role: RoleName) {
  const user = await prisma.user.findFirstOrThrow({ where: { email: `${role.toLowerCase()}@fls.local` }, include: { roles: { include: { role: true } } } });
  tokens[role] = signAccessToken({ sub: user.id, roles: user.roles.map((r) => r.role.name), tokenVersion: user.tokenVersion });
}

async function call<T = { id: string }>(role: RoleName, method: "get" | "post" | "patch", path: string, body?: object): Promise<T> {
  const r = request(app)[method](path).set("Authorization", `Bearer ${tokens[role]}`);
  const res = await (body ? r.send(body) : r);
  if (![200, 201].includes(res.status)) throw new Error(`${role} ${method.toUpperCase()} ${path} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T;
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function main() {
  for (const role of ["BD", "RND", "REGULATORY"] as RoleName[]) await tokenFor(role);
  if (await prisma.sampleRequest.count({ where: { composition: { startsWith: "DEMO" } } })) return console.log("Demo sample requests are already there.");
  const leads = await call<{ id: string; brandName: string }[]>("BD", "get", "/api/leads");
  const lead = (name: string) => leads.find((l) => l.brandName === name);
  const need = (name: string) => {
    const l = lead(name);
    if (!l) throw new Error(`Lead "${name}" is missing: run prisma/seed-leads.ts first.`);
    return l.id;
  };

  const ask = (leadName: string, body: object) => call("BD", "post", "/api/sample-requests", { leadId: need(leadName), ...body });
  const code = (n: number, who: string) => `FLS/F&D/${who}/${String(n).padStart(3, "0")}`;
  const status = (id: string, action: string, reason?: string) => call("RND", "post", `/api/sample-requests/${id}/status`, { action, ...(reason ? { reason } : {}) });
  const rnd = (id: string, body: object) => call("RND", "patch", `/api/sample-requests/${id}/rnd`, body);

  // New: R&D has not picked it up
  const gummies = await ask("DEMO Gummy Labs", { template: "GUMMIES", composition: "DEMO Kids vitamin gummies, mango flavour, no added sugar", neededBy: day(11), dosageForm: "Gummies", quantity: "10 gummies", remarks: "Soft texture, pectin based", referenceSample: "Customer's current gummy" });
  await call("REGULATORY", "patch", `/api/sample-requests/${gummies.id}/ra`, { exportDomestic: "Domestic", labelClaim: "Vitamin C 40 mg, Vitamin D3 400 IU per gummy" });

  // Planning: an ETA was given
  const whey = await ask("DEMO Fit Fuel Brands", { template: "POWDER", composition: "DEMO Whey isolate, chocolate, 25 g protein per scoop\nNo sucralose, no added sugar", neededBy: day(6), quantity: "Standard x 3", remarks: "Needs to match or beat the benchmark" });
  await rnd(whey.id, { sampleCode: code(1, "FF"), preparedByName: "Rohit Joshi", expectedDate: day(2) });

  // In process
  const plant = await ask("DEMO Wellness Cart", { template: "POWDER", composition: "DEMO Plant protein, coffee flavour, monk fruit sweetened", neededBy: day(4), quantity: "Standard x 3" });
  await rnd(plant.id, { sampleCode: code(1, "WC"), preparedByName: "Heman", expectedDate: day(1) });
  await status(plant.id, "START");

  // Ready, waiting to be handed over
  const yeast = await ask("DEMO Medivita Pharma", { template: "POWDER", composition: "DEMO Yeast protein, cold coffee", neededBy: day(-2), quantity: "Standard x 3", remarks: "Labels pending" });
  await rnd(yeast.id, { sampleCode: code(1, "MV"), preparedByName: "Rohit Joshi", expectedDate: day(-4), rdRemarks: "Ready, labels pending" });
  await status(yeast.id, "START");
  await status(yeast.id, "READY");

  // Dispatched, feedback awaited
  const bars = await ask("DEMO Green Roots", { template: "BARS", composition: "DEMO Yeast protein bar, chocolate, 15 g protein", neededBy: day(-6), quantity: "6 bars", referenceSample: "Market benchmark bar" });
  await rnd(bars.id, { sampleCode: code(1, "GR"), preparedByName: "Mukesh", expectedDate: day(-9) });
  await status(bars.id, "START");
  await status(bars.id, "READY");
  await status(bars.id, "DISPATCH");

  // Dispatched, the customer asked for a change: round 2 is with R&D
  const hydration = await ask("DEMO Sleep Easy", { template: "POWDER", composition: "DEMO Hydration mix, mojito, no sugar", neededBy: day(-12), quantity: "Standard x 3" });
  await rnd(hydration.id, { sampleCode: code(1, "IP"), preparedByName: "Jagdish Joshi", expectedDate: day(-14) });
  await status(hydration.id, "START");
  await status(hydration.id, "READY");
  await status(hydration.id, "DISPATCH");
  await call("BD", "post", `/api/sample-requests/${hydration.id}/feedback`, { feedback: "CHANGE_REQUESTED", customerRemark: "Slightly less sweet. Wants the mojito flavour stronger.", internalRemark: "Customer is price sensitive. Do not increase the cost." });
  await rnd(hydration.id, { sampleCode: code(2, "IP"), preparedByName: "Jagdish Joshi", expectedDate: day(3) });

  // On hold
  const creatine = await ask("DEMO Fit Fuel Brands", { template: "POWDER", composition: "DEMO Creatine monohydrate, lemon, 3 g per serving", neededBy: day(9), quantity: "Standard x 3" });
  await rnd(creatine.id, { expectedDate: day(7) });
  await status(creatine.id, "HOLD", "Waiting for the creatine lot to clear Inward QC");

  console.log("Added 7 demo sample requests.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
