import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("An admin viewing as one Store / Plant is scoped like that store's own login", () => {
  it("scopes the admin by X-View-As-Scope, and ignores the header for anyone who is not an admin", async () => {
    const { token: admin } = await createUser(["ADMIN"]);
    const { token: store, user: storeUser } = await createUser(["STORE"]);
    const a = await prisma.dayStore.create({ data: { name: `VS Store A ${Date.now()}`, createdById: storeUser.id } });
    const b = await prisma.dayStore.create({ data: { name: `VS Store B ${Date.now()}`, createdById: storeUser.id } });
    const plantA = await prisma.plant.create({ data: { name: `VS Plant A ${Date.now()}`, createdById: storeUser.id, dayStoreId: a.id } });

    const info = (token: string, scope?: string) => request(app).get("/api/inventory/my-store/info").set(authHeader(token)).set(scope ? { "X-View-As-Scope": scope } : {});

    // Plain admin: not limited to any store
    expect((await info(admin)).body).toMatchObject({ scoped: false });

    // Viewing as Day Store A: limited to that store only
    const asA = await info(admin, `DAYSTORE:${a.id}`);
    expect(asA.body.scoped).toBe(true);
    expect(asA.body.stores.map((s: { id: string }) => s.id)).toEqual([a.id]);
    const asB = await info(admin, `DAYSTORE:${b.id}`);
    expect(asB.body.stores.map((s: { id: string }) => s.id)).toEqual([b.id]);

    // A bad value is ignored (the admin stays unscoped)
    expect((await info(admin, "DAYSTORE:not-an-id")).body.scoped).toBe(false);

    // Anybody who is not an admin cannot use the header to widen or change their own scope
    expect((await info(store, `DAYSTORE:${a.id}`)).body.scoped).toBe(false);

    // Viewing as a Plant is read for Production's scope only (not a Day Store scope)
    expect((await info(admin, `PLANT:${plantA.id}`)).body.scoped).toBe(false);
  });
});
