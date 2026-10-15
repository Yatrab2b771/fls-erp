import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/common/lib/prisma";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("Sample request: BD raises it, R&D makes it, BD enters the feedback", () => {
  it("keeps each colour with its department, makes a customer for the lead, and runs the rounds until the customer approves", async () => {
    const bd = await createUser(["BD"]);
    const otherBd = await createUser(["BD"]);
    const rnd = await createUser(["RND"]);
    const ra = await createUser(["REGULATORY"]);
    const store = await createUser(["STORE"]);
    const call = (token: string, method: "get" | "post" | "patch", path: string, body?: object) => {
      const r = request(app)[method](path).set(authHeader(token));
      return body ? r.send(body) : r;
    };
    const stamp = Date.now();

    // A lead that is asking for a sample
    const lead = (await call(bd.token, "post", "/api/leads", { brandName: `SR Lead ${stamp}`, contactPerson: "Neha", phones: ["+91 98215 67890"], customerTypes: ["D2C"], productFormats: ["Gummies"], status: "SAMPLING" })).body as { id: string };

    const base = { template: "GUMMIES", composition: "Kids vitamin gummies, mango\nno added sugar", neededBy: "2026-11-05", dosageForm: "Gummies", quantity: "10 gummies", remarks: "Soft texture", referenceSample: "Benchmark gummy" };
    // Only BD raises a request, and it needs a composition and a lead or customer
    expect((await call(rnd.token, "post", "/api/sample-requests", { ...base, leadId: lead.id })).status).toBe(403);
    expect((await call(bd.token, "post", "/api/sample-requests", { ...base, composition: "", leadId: lead.id })).status).toBe(400);
    expect((await call(bd.token, "post", "/api/sample-requests", base)).status).toBe(400);
    expect((await call(otherBd.token, "post", "/api/sample-requests", { ...base, leadId: lead.id })).status).toBe(404); // not his lead

    const created = await call(bd.token, "post", "/api/sample-requests", { ...base, leadId: lead.id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "REQUESTED", template: "GUMMIES", round: 1, leadBrand: `SR Lead ${stamp}`, customerName: `SR Lead ${stamp}`, productName: "Kids vitamin gummies, mango" });
    const id = created.body.id as string;
    // the lead now has a customer, so a second request uses the same one
    const customer = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { customerId: true } });
    expect(customer.customerId).toBe(created.body.customerId);
    expect((await call(bd.token, "post", "/api/sample-requests", { ...base, leadId: lead.id })).body.customerId).toBe(customer.customerId);

    // R&D is told; who sees what
    expect(await prisma.notification.count({ where: { recipientId: rnd.user.id, title: { contains: "new sample request" } } })).toBeGreaterThan(0);
    expect((await call(store.token, "get", "/api/sample-requests")).status).toBe(403);
    expect((await call(otherBd.token, "get", `/api/sample-requests/${id}`)).status).toBe(404);
    expect((await call(otherBd.token, "get", "/api/sample-requests")).body).toEqual([]);
    expect((await call(rnd.token, "get", "/api/sample-requests")).body.some((r: { id: string }) => r.id === id)).toBe(true);
    expect((await call(rnd.token, "get", "/api/sample-requests/rnd-team")).body.some((u: { id: string }) => u.id === rnd.user.id)).toBe(true);

    // Each colour belongs to one department
    expect((await call(rnd.token, "patch", `/api/sample-requests/${id}/sales`, { quantity: "20" })).status).toBe(403);
    expect((await call(bd.token, "patch", `/api/sample-requests/${id}/rnd`, { sampleCode: "X" })).status).toBe(403);
    expect((await call(bd.token, "patch", `/api/sample-requests/${id}/ra`, { exportDomestic: "Export" })).status).toBe(403);
    expect((await call(otherBd.token, "patch", `/api/sample-requests/${id}/sales`, { quantity: "20" })).status).toBe(404);
    expect((await call(bd.token, "patch", `/api/sample-requests/${id}/sales`, { quantity: "20 gummies" })).body.quantity).toBe("20 gummies");

    // RA fills the pink part, for Gummies only
    expect((await call(ra.token, "patch", `/api/sample-requests/${id}/ra`, { exportDomestic: "Export", labelClaim: "Vitamin C 40 mg" })).body).toMatchObject({ exportDomestic: "Export", labelClaim: "Vitamin C 40 mg" });

    // R&D: an ETA moves it from New to Planning and tells BD
    const planned = await call(rnd.token, "patch", `/api/sample-requests/${id}/rnd`, { expectedDate: "2026-10-30", preparedByName: "Rohit Joshi", sampleCode: "FLS/F&D/SR/001" });
    expect(planned.body).toMatchObject({ status: "PLANNING", expectedDate: expect.stringContaining("2026-10-30"), preparedByName: "Rohit Joshi" });
    expect(await prisma.notification.count({ where: { recipientId: bd.user.id, title: { contains: "gave an ETA" } } })).toBe(1);

    // The steps cannot be skipped; hold and cannot-make need a reason
    const status = (token: string, action: string, reason?: string) => call(token, "post", `/api/sample-requests/${id}/status`, { action, ...(reason ? { reason } : {}) });
    expect((await status(bd.token, "START")).status).toBe(403);
    expect((await status(rnd.token, "DISPATCH")).status).toBe(409); // not Ready
    expect((await status(rnd.token, "HOLD")).status).toBe(400);
    expect((await status(rnd.token, "HOLD", "Waiting for the flavour")).body).toMatchObject({ status: "ON_HOLD", rdRemarks: "Waiting for the flavour" });
    expect((await status(rnd.token, "START")).body.status).toBe("IN_PROCESS");
    await call(rnd.token, "patch", `/api/sample-requests/${id}/rnd`, { sampleCode: null });
    expect((await status(rnd.token, "READY")).status).toBe(409); // no sample code
    await call(rnd.token, "patch", `/api/sample-requests/${id}/rnd`, { sampleCode: "FLS/F&D/SR/001" });
    const ready = await status(rnd.token, "READY");
    expect(ready.body.status).toBe("READY");
    expect(ready.body.readyAt).not.toBeNull();
    expect(ready.body.preparedOn).not.toBeNull();
    expect((await call(bd.token, "post", `/api/sample-requests/${id}/feedback`, { feedback: "APPROVED", customerRemark: "ok" })).status).toBe(409); // not handed over yet
    expect((await call(bd.token, "patch", `/api/sample-requests/${id}/sales`, { quantity: "5" })).status).toBe(200); // still open to BD until handed over
    expect((await status(rnd.token, "DISPATCH")).body.status).toBe("DISPATCHED");
    expect((await call(bd.token, "patch", `/api/sample-requests/${id}/sales`, { quantity: "5" })).status).toBe(409); // handed over

    // Feedback: a remark is needed; only the owner gives it
    expect((await call(bd.token, "post", `/api/sample-requests/${id}/feedback`, { feedback: "CHANGE_REQUESTED", customerRemark: " " })).status).toBe(400);
    expect((await call(otherBd.token, "post", `/api/sample-requests/${id}/feedback`, { feedback: "APPROVED", customerRemark: "x" })).status).toBe(404);
    const again = await call(bd.token, "post", `/api/sample-requests/${id}/feedback`, { feedback: "CHANGE_REQUESTED", customerRemark: "Less sweet", internalRemark: "Price sensitive" });
    expect(again.body).toMatchObject({ status: "REQUESTED", round: 2, sampleCode: null, expectedDate: null, preparedByName: null, clientFeedback: "Less sweet", feedback: null });
    expect(await prisma.notification.count({ where: { recipientId: rnd.user.id, title: { contains: "change requested (round 2)" } } })).toBe(1);

    // Round 2 goes through again and the customer approves
    await call(rnd.token, "patch", `/api/sample-requests/${id}/rnd`, { sampleCode: "FLS/F&D/SR/002", expectedDate: "2026-11-02" });
    await status(rnd.token, "START");
    await status(rnd.token, "READY");
    await status(rnd.token, "DISPATCH");
    const approved = await call(bd.token, "post", `/api/sample-requests/${id}/feedback`, { feedback: "APPROVED", customerRemark: "Perfect" });
    expect(approved.body).toMatchObject({ status: "DISPATCHED", feedback: "APPROVED", round: 2 });
    expect((await call(bd.token, "post", `/api/sample-requests/${id}/feedback`, { feedback: "REJECTED", customerRemark: "no" })).status).toBe(409); // already given
    // R&D (upload the BOM) and Regulatory are told at the same time
    expect(await prisma.notification.count({ where: { recipientId: rnd.user.id, title: { contains: "approved by the customer" } } })).toBe(1);
    expect(await prisma.notification.count({ where: { recipientId: ra.user.id, title: { contains: "sample approved" } } })).toBe(1);

    // The detail keeps every finished round, newest first
    const detail = (await call(bd.token, "get", `/api/sample-requests/${id}`)).body;
    expect(detail.rounds.map((r: { round: number; feedback: string }) => [r.round, r.feedback])).toEqual([[2, "APPROVED"], [1, "CHANGE_REQUESTED"]]);
    expect(detail.rounds[1]).toMatchObject({ sampleCode: "FLS/F&D/SR/001", customerRemark: "Less sweet", internalRemark: "Price sensitive" });
  });

  it("limits the RA part to Gummies, lets R&D close a request it cannot make, and links raw material requests to it", async () => {
    const bd = await createUser(["BD"]);
    const rnd = await createUser(["RND"]);
    const ra = await createUser(["REGULATORY"]);
    const call = (token: string, method: "get" | "post" | "patch", path: string, body?: object) => {
      const r = request(app)[method](path).set(authHeader(token));
      return body ? r.send(body) : r;
    };
    const customer = (await call(bd.token, "post", "/api/customers", { companyName: `SR Customer ${Date.now()}` })).body as { id: string };
    const created = await call(bd.token, "post", "/api/sample-requests", { template: "POWDER", composition: "Clear whey, strawberry", neededBy: "2026-11-05", customerId: customer.id, referenceSample: "ignored for powder" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "REQUESTED", referenceSample: null });
    const id = created.body.id as string;

    expect((await call(ra.token, "patch", `/api/sample-requests/${id}/ra`, { exportDomestic: "Domestic" })).status).toBe(400); // Powder has no RA part

    // Raw material R&D asks for this sample comes back with it
    const item = await prisma.inventoryItem.create({ data: { category: "RM", name: `SR Whey ${Date.now()}`, unit: "Kg" } });
    const rm = await call(rnd.token, "post", "/api/rnd-store/requests", { itemId: item.id, quantity: 2, unit: "Kg", note: "for the sample", sampleRequestId: id });
    expect(rm.status).toBe(201);
    expect((await call(rnd.token, "post", "/api/rnd-store/requests", { itemId: item.id, quantity: 2, unit: "Kg", sampleRequestId: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    const detail = (await call(rnd.token, "get", `/api/sample-requests/${id}`)).body;
    expect(detail.rmRequests).toHaveLength(1);
    expect(detail.rmRequests[0]).toMatchObject({ itemName: item.name, quantity: 2, unit: "Kg", status: "PENDING" });

    const closed = await call(rnd.token, "post", `/api/sample-requests/${id}/status`, { action: "CANNOT_MAKE", reason: "Not possible without a sweetener we do not stock" });
    expect(closed.body).toMatchObject({ status: "CANNOT_MAKE", rdRemarks: "Not possible without a sweetener we do not stock" });
    expect((await call(rnd.token, "post", `/api/sample-requests/${id}/status`, { action: "START" })).status).toBe(409);
    expect((await call(bd.token, "patch", `/api/sample-requests/${id}/sales`, { quantity: "9" })).status).toBe(409);
    expect(await prisma.notification.count({ where: { recipientId: bd.user.id, title: { contains: "cannot make it" } } })).toBe(1);
  });
});
