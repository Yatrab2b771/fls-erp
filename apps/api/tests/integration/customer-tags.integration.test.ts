import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("Customer tags: New (90 days, automatic), Top 10 (BD's pick), Others", () => {
  it("tags customers, lets only BD pick the Top 10, and filters the directory by type", async () => {
    const { token: bd, user } = await createUser(["BD"]);
    const { token: ppic } = await createUser(["PPIC"]);
    const stamp = Date.now();
    const make = (name: string, daysAgo: number) => prisma.customer.create({ data: { companyName: `${name} ${stamp}`, createdById: user.id, createdAt: new Date(Date.now() - daysAgo * 86_400_000) } });
    const fresh = await make("CT Fresh", 10);
    const old = await make("CT Old", 200);
    const oldTop = await make("CT OldTop", 400);

    // BD picks who is in the Top 10; nobody else can
    expect((await request(app).patch(`/api/customers/${oldTop.id}/top10`).set(authHeader(ppic)).send({ isTop10: true })).status).toBe(403);
    expect((await request(app).patch(`/api/customers/${oldTop.id}/top10`).set(authHeader(bd)).send({ isTop10: true })).status).toBe(200);
    expect((await request(app).patch(`/api/customers/${fresh.id}/top10`).set(authHeader(bd)).send({ isTop10: true })).status).toBe(200); // New and Top 10 at once

    // Everyone can read the tags
    const tags = (await request(app).get("/api/customers/tags").set(authHeader(ppic))).body as { id: string; isNew: boolean; isTop10: boolean }[];
    const tagOf = (id: string) => tags.find((t) => t.id === id)!;
    expect(tagOf(fresh.id)).toMatchObject({ isNew: true, isTop10: true });
    expect(tagOf(old.id)).toMatchObject({ isNew: false, isTop10: false }); // Others
    expect(tagOf(oldTop.id)).toMatchObject({ isNew: false, isTop10: true });

    // The directory filters by type
    const names = async (type: string[]) => ((await request(app).get("/api/customers").query({ type, search: String(stamp), pageSize: 50 }).set(authHeader(ppic))).body as { id: string }[]).map((c) => c.id).sort();
    expect(await names(["New"])).toEqual([fresh.id]);
    expect(await names(["Top 10"])).toEqual([fresh.id, oldTop.id].sort());
    expect(await names(["Others"])).toEqual([old.id]);
    expect(await names(["New", "Others"])).toEqual([fresh.id, old.id].sort());

    // The PO form's dropdown: tag a customer as New / Top 10 / Others in one pick (only BD)
    const setType = (id: string, type: string, token = bd) => request(app).patch(`/api/customers/${id}/type`).set(authHeader(token)).send({ type });
    expect((await setType(old.id, "New", ppic)).status).toBe(403);
    expect((await setType(old.id, "New")).status).toBe(200); // joined long ago, but BD tags it New
    expect(await names(["New"])).toEqual([fresh.id, old.id].sort());
    expect((await setType(fresh.id, "Others")).status).toBe(200); // joined 10 days ago, but BD says Others
    const retagged = (await request(app).get("/api/customers/tags").set(authHeader(ppic))).body as { id: string; isNew: boolean; isTop10: boolean }[];
    expect(retagged.find((t) => t.id === fresh.id)).toMatchObject({ isNew: false, isTop10: false });
    expect(retagged.find((t) => t.id === old.id)).toMatchObject({ isNew: true, isTop10: false });
    expect((await setType(oldTop.id, "Top 10")).status).toBe(200);

    // Taking someone out of the Top 10
    await request(app).patch(`/api/customers/${oldTop.id}/top10`).set(authHeader(bd)).send({ isTop10: false });
    expect(await names(["Others"])).toEqual([fresh.id, oldTop.id].sort());
  });
});
