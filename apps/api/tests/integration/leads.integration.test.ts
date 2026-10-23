import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/common/lib/prisma";
import { authHeader, createUser } from "./helpers";

const app = createApp();

const lead = (extra: object = {}) => ({ brandName: `LD Brand ${Math.random().toString(36).slice(2, 8)}`, contactPerson: "Dr. Neha Singh", customerTypes: ["Exports"], productFormats: ["Capsules", "Powder"], powderTypes: ["Yeast"], ...extra });
const inDays = (n: number, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

describe("Lead management (BD)", () => {
  it("keeps the lead rules: pick lists, mandatory meeting notes and follow-up, Dropped has none, Converted only after a sample", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token: store } = await createUser(["STORE"]);
    const call = (token: string, method: "get" | "post" | "patch", path: string, body?: object) => {
      const r = request(app)[method](path).set(authHeader(token));
      return body ? r.send(body) : r;
    };
    // Every department has the page (a lead is handed to whoever follows it up), but adding leads is BD's
    expect((await call(store, "get", "/api/leads")).body).toEqual([]);
    expect((await call(store, "post", "/api/leads", lead())).status).toBe(403);

    // A lead needs a customer type, a product format, and a powder type when Powder is chosen
    expect((await call(bd, "post", "/api/leads", lead({ customerTypes: [] }))).status).toBe(400);
    expect((await call(bd, "post", "/api/leads", lead({ productFormats: [] }))).status).toBe(400);
    expect((await call(bd, "post", "/api/leads", lead({ powderTypes: [] }))).status).toBe(400);
    // A name typed under "Others" is kept (2 to 40 letters); a listed name in another case takes the list's spelling; it joins the lists for everyone
    expect((await call(bd, "post", "/api/leads", lead({ customerTypes: ["N"] }))).status).toBe(400);
    expect((await call(bd, "post", "/api/leads", lead({ productFormats: ["x".repeat(41)], powderTypes: [] }))).status).toBe(400);
    const typed = await call(bd, "post", "/api/leads", lead({ customerTypes: ["  hospital   chains ", "d2c", "D2C"], productFormats: ["Softgel Premium", "gummies"], powderTypes: [] }));
    expect(typed.status).toBe(201);
    expect(typed.body).toMatchObject({ customerTypes: ["Hospital chains", "D2C"], productFormats: ["Softgel Premium", "Gummies"], powderTypes: [] });
    const lists = (await call(store, "get", "/api/leads/options/lists")).body;
    expect(lists.customerTypes).toEqual(["D2C", "Exports", "Distribution", "MLM", "Medical", "Sports", "Hospital chains", "Others"]);
    expect(lists.productFormats).toContain("Softgel Premium");
    expect(lists.productFormats.at(-1)).toBe("Others");
    expect((await call(bd, "patch", `/api/leads/${typed.body.id}`, { powderTypes: ["Black Lentil"], productFormats: ["Powder"] })).body.powderTypes).toEqual(["Black Lentil"]);
    expect((await call(bd, "post", "/api/leads", lead({ status: "CONVERTED" }))).status).toBe(400);

    // Powder types are dropped when Powder is not a format
    const noPowder = await call(bd, "post", "/api/leads", lead({ productFormats: ["Gummies"], powderTypes: ["Whey"] }));
    expect(noPowder.status).toBe(201);
    expect(noPowder.body.powderTypes).toEqual([]);

    const created = await call(bd, "post", "/api/leads", lead());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "DISCUSSION", meetingCount: 0, lastMeeting: null, powderTypes: ["Yeast"] });
    const id = created.body.id as string;

    // A meeting: notes are mandatory, so is the next follow-up (except for Dropped)
    const meeting = (body: object) => call(bd, "post", `/api/leads/${id}/meetings`, { meetingDate: new Date().toISOString(), statusAfter: "COLD", ...body });
    expect((await meeting({ notes: "  ", nextFollowUpAt: inDays(3) })).status).toBe(400);
    expect((await meeting({ notes: "Intro call" })).status).toBe(400); // no next follow-up
    expect((await meeting({ notes: "Intro call", statusAfter: "DROPPED", nextFollowUpAt: inDays(3) })).status).toBe(400);
    expect((await meeting({ notes: "Intro call", statusAfter: "CONVERTED", nextFollowUpAt: inDays(3) })).status).toBe(400);
    expect((await meeting({ notes: "Intro call", nextFollowUpAt: inDays(-5) })).status).toBe(400); // before the meeting date
    const first = await meeting({ notes: "Intro call, sent the presentation", nextFollowUpAt: inDays(3), closureMonth: "2026-12" });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ number: 1, statusAfter: "COLD", closureMonth: "2026-12" });
    const second = await meeting({ notes: "Met them. Wants a price list.", statusAfter: "WARM", nextFollowUpAt: inDays(7) });
    expect(second.body.number).toBe(2);

    // The lead follows its last meeting; the log lists the meetings newest first
    const detail = (await call(bd, "get", `/api/leads/${id}`)).body;
    expect(detail).toMatchObject({ status: "WARM", meetingCount: 2, closureMonth: "2026-12", lastMeeting: { number: 2 } });
    expect(detail.meetings.map((m: { number: number }) => m.number)).toEqual([2, 1]);

    // Moving the follow-up date is logged with the reason
    const moved = await call(bd, "post", `/api/leads/${id}/reschedule`, { toAt: inDays(10), reason: "Client is travelling" });
    expect(moved.status).toBe(200);
    expect((await call(bd, "post", `/api/leads/${id}/reschedule`, { toAt: inDays(11), reason: " " })).status).toBe(400);
    expect((await call(bd, "get", `/api/leads/${id}`)).body.reschedules).toHaveLength(1);

    // Dropped ends the follow-ups; bringing it back needs a new date
    const dropped = await meeting({ notes: "Not interested now", statusAfter: "DROPPED" });
    expect(dropped.status).toBe(201);
    expect((await call(bd, "get", `/api/leads/${id}`)).body).toMatchObject({ status: "DROPPED", nextFollowUpAt: null });
    expect((await call(bd, "post", `/api/leads/${id}/reschedule`, { toAt: inDays(5), reason: "Try again" })).status).toBe(409);
    expect((await call(bd, "patch", `/api/leads/${id}`, { status: "HOT" })).status).toBe(400);
    const back = await call(bd, "patch", `/api/leads/${id}`, { status: "HOT", nextFollowUpAt: inDays(2) });
    expect(back.status).toBe(200);
    expect(back.body.status).toBe("HOT");
    expect((await call(bd, "patch", `/api/leads/${id}`, { status: "CONVERTED" })).status).toBe(400);
    expect((await call(bd, "patch", `/api/leads/${id}`, { productFormats: ["Powder"], powderTypes: [] })).status).toBe(400);
  });

  it("counts what is due today and overdue, keeps each salesman's leads private, and makes a lead from a visiting card once", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token: other } = await createUser(["BD"]);
    const { token: admin } = await createUser(["ADMIN"]);
    const call = (token: string, method: "get" | "post" | "patch", path: string, body?: object) => {
      const r = request(app)[method](path).set(authHeader(token));
      return body ? r.send(body) : r;
    };
    const startOfToday = new Date(new Date().toDateString());
    const from = startOfToday.toISOString();
    const until = new Date(startOfToday.getTime() + 24 * 3_600_000 - 1).toISOString();
    const summary = async (token = bd) => (await call(token, "get", `/api/leads/summary?from=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}`)).body;

    const mk = async (extra: object) => (await call(bd, "post", "/api/leads", lead(extra))).body as { id: string };
    const overdue = await mk({ status: "WARM", nextFollowUpAt: inDays(-2) });
    const today = await mk({ status: "HOT", nextFollowUpAt: new Date(startOfToday.getTime() + 15 * 3_600_000).toISOString() });
    await mk({ status: "COLD", nextFollowUpAt: inDays(5) });
    await mk({ status: "DROPPED" });
    await mk({});
    expect([overdue.id, today.id].every(Boolean)).toBe(true);

    expect(await summary()).toMatchObject({ total: 5, followUpToday: 2, overdue: 1, dueToday: 1, noFollowUp: 1, byStatus: { WARM: 1, HOT: 1, COLD: 1, DROPPED: 1, DISCUSSION: 1 } });
    // another salesman sees none of it; Admin sees all
    expect((await summary(other)).total).toBe(0);
    expect((await call(other, "get", `/api/leads/${overdue.id}`)).status).toBe(404);
    expect((await call(other, "post", `/api/leads/${overdue.id}/meetings`, { meetingDate: new Date().toISOString(), notes: "x", statusAfter: "HOT", nextFollowUpAt: inDays(2) })).status).toBe(404);
    expect((await call(admin, "get", `/api/leads/${overdue.id}`)).status).toBe(200);
    expect((await call(admin, "get", "/api/leads")).body.length).toBeGreaterThanOrEqual(5);

    // A visiting card becomes a lead once, and only through BD
    const card = await call(bd, "post", "/api/business-cards", { name: "Dr. Neha Singh", company: "LD Medivita Pharma", phones: ["+91 98215 67890"], email: "neha@ld-medivita.com", categories: ["Capsule", "Powder"] });
    expect(card.status).toBe(201);
    const { token: storeUser } = await createUser(["STORE"]);
    expect((await call(storeUser, "post", "/api/leads", lead({ brandName: "LD Medivita Pharma", businessCardId: card.body.id }))).status).toBe(403);
    const fromCard = await call(bd, "post", "/api/leads", lead({ brandName: "LD Medivita Pharma", businessCardId: card.body.id }));
    expect(fromCard.status).toBe(201);
    expect(fromCard.body.businessCardId).toBe(card.body.id);
    expect((await call(bd, "post", "/api/leads", lead({ brandName: "LD Medivita Pharma", businessCardId: card.body.id }))).status).toBe(409);

    // A scanned card that was not saved yet (needs verify) is saved at the same moment it becomes a lead, with what BD checked
    const scanned = await call(bd, "post", "/api/business-cards", { name: "R. Mehta", company: "LD Misread Co", phones: ["+91 91111 22222"], categories: ["Bar"] });
    await prisma.businessCard.update({ where: { id: scanned.body.id }, data: { status: "NEEDS_VERIFY", verifiedAt: null } });
    const checked = await call(bd, "post", "/api/leads", lead({ brandName: "LD Checked Brand", contactPerson: "Rohan Mehta", businessCardId: scanned.body.id, phones: ["+91 98765 43210"], city: "Mumbai", state: "Maharashtra", productFormats: ["Bars"], powderTypes: [] }));
    expect(checked.status).toBe(201);
    expect(checked.body).toMatchObject({ city: "Mumbai", state: "Maharashtra" });
    const after = await prisma.businessCard.findUniqueOrThrow({ where: { id: scanned.body.id } });
    expect(after).toMatchObject({ status: "VERIFIED", company: "LD Checked Brand", name: "Rohan Mehta", phones: ["+91 98765 43210"], categories: ["Bars"] });
    expect(after.verifiedAt).not.toBeNull();
  });

  it("opens the estimated order size and Converted only after a sample is approved, then waits for the PO until one is entered", async () => {
    const bd = await createUser(["BD"]);
    const rnd = await createUser(["RND"]);
    const call = (token: string, method: "get" | "post" | "patch", path: string, body?: object) => {
      const r = request(app)[method](path).set(authHeader(token));
      return body ? r.send(body) : r;
    };
    const startOfToday = new Date(new Date().toDateString());
    const bounds = `from=${encodeURIComponent(startOfToday.toISOString())}&until=${encodeURIComponent(new Date(startOfToday.getTime() + 86_400_000 - 1).toISOString())}`;
    const created = await call(bd.token, "post", "/api/leads", lead({ status: "SAMPLING", nextFollowUpAt: inDays(2) }));
    const id = created.body.id as string;
    const meeting = (body: object) => call(bd.token, "post", `/api/leads/${id}/meetings`, { meetingDate: new Date().toISOString(), notes: "Talked", statusAfter: "HOT", nextFollowUpAt: inDays(3), ...body });

    // Before any approval: locked
    expect(created.body).toMatchObject({ sampleApproved: false, waitingForPo: false, estimatedQty: null, convertedAt: null });
    expect((await call(bd.token, "patch", `/api/leads/${id}`, { estimatedQty: "1 ton", estimatedValueLac: 12 })).status).toBe(409);
    expect((await meeting({ estimatedQty: "1 ton", estimatedValueLac: 12 })).status).toBe(409);
    expect((await call(bd.token, "post", `/api/leads/${id}/convert`, { estimatedQty: "1 ton", estimatedValueLac: 12 })).status).toBe(409);

    // A sample goes out and the customer approves it
    const sample = (await call(bd.token, "post", "/api/sample-requests", { leadId: id, template: "POWDER", composition: "Whey isolate", neededBy: "2026-12-01" })).body as { id: string };
    const step = (path: string, body: object) => call(rnd.token, "post", `/api/sample-requests/${sample.id}/${path}`, body);
    await call(rnd.token, "patch", `/api/sample-requests/${sample.id}/rnd`, { sampleCode: "FLS/F&D/LD/001" });
    expect((await step("bom-uploaded", {})).status).toBe(409); // not approved yet
    await step("status", { action: "START" });
    await step("status", { action: "READY" });
    await step("status", { action: "DISPATCH" });
    expect((await call(bd.token, "post", `/api/sample-requests/${sample.id}/feedback`, { feedback: "APPROVED", customerRemark: "Perfect" })).status).toBe(200);
    expect((await call(bd.token, "get", `/api/leads/${id}`)).body.sampleApproved).toBe(true);

    // The estimate is now mandatory for a meeting (unless the lead is dropped), and is kept on the lead
    expect((await meeting({})).status).toBe(400);
    expect((await meeting({ estimatedQty: "1 ton" })).status).toBe(400); // the value is missing too
    const saved = await meeting({ estimatedQty: "1 ton", estimatedValueLac: 12.5 });
    expect(saved.status).toBe(201);
    expect((await call(bd.token, "get", `/api/leads/${id}`)).body).toMatchObject({ estimatedQty: "1 ton", estimatedValueLac: 12.5, status: "HOT" });
    expect((await call(bd.token, "patch", `/api/leads/${id}`, { status: "CONVERTED" })).status).toBe(400); // only through Convert lead
    expect((await meeting({ statusAfter: "CONVERTED" })).status).toBe(400);

    // R&D marks the BOM uploaded; BD is told, once
    expect((await step("bom-uploaded", {})).status).toBe(200);
    expect((await step("bom-uploaded", {})).status).toBe(409);
    expect(await prisma.notification.count({ where: { recipientId: bd.user.id, title: { contains: "uploaded the BOM" } } })).toBe(1);

    // Convert: the lead is over for follow-ups and now waits for its PO
    const converted = await call(bd.token, "post", `/api/leads/${id}/convert`, { estimatedQty: "1.2 ton", estimatedValueLac: 14 });
    expect(converted.status).toBe(200);
    expect(converted.body).toMatchObject({ status: "CONVERTED", nextFollowUpAt: null, estimatedQty: "1.2 ton", estimatedValueLac: 14, waitingForPo: true, poNumbers: [] });
    expect(converted.body.convertedAt).not.toBeNull();
    expect((await call(bd.token, "post", `/api/leads/${id}/convert`, {})).status).toBe(409);
    expect((await call(bd.token, "get", `/api/leads/summary?${bounds}`)).body).toMatchObject({ waitingForPo: 1 });

    // The PO of that customer, entered after the conversion, takes it off the waiting list
    const po = await call(bd.token, "post", "/api/purchase-orders", { customerId: converted.body.customerId, poNumber: `LD-PO-${Date.now()}`, items: [{ productName: "Whey isolate", productCategory: "Powder", quantity: 100, unit: "KG" }] });
    expect(po.status).toBe(201);
    const after = (await call(bd.token, "get", `/api/leads/${id}`)).body;
    expect(after).toMatchObject({ waitingForPo: false, status: "CONVERTED" });
    expect(after.poNumbers).toEqual([po.body.poNumber]);
    expect((await call(bd.token, "get", `/api/leads/summary?${bounds}`)).body.waitingForPo).toBe(0);

    // The forecast: the funnel from lead to PO, the converted value, and the month / source tables
    const other = await createUser(["BD"]);
    const forecast = (await call(bd.token, "get", "/api/leads/forecast")).body;
    expect(forecast.funnel).toEqual({ leads: 1, sample: 1, approved: 1, converted: 1, poReceived: 1 });
    expect(forecast.totals).toMatchObject({ leads: 1, open: 0, convertedValueLac: 14, waitingForPo: 0, waitingValueLac: 0 });
    expect(forecast.byMonth).toEqual([expect.objectContaining({ key: "none", leads: 1, converted: 1, valueLac: 14 })]);
    expect(forecast.bySource).toEqual([expect.objectContaining({ key: "Not set", leads: 1 })]);
    expect((await call(other.token, "get", "/api/leads/forecast")).body.totals.leads).toBe(0); // each salesman's own
  });
});

describe("Leads handed to any department", () => {
  it("BD makes a lead from someone else's card and hands it over; that person follows it up, nobody else sees it, and adding, handing on and Convert stay with BD", async () => {
    const { token: bd, user: bdUser } = await createUser(["BD"]);
    const { token: otherBd } = await createUser(["BD"]);
    const { token: store, user: storeUser } = await createUser(["STORE"]);
    const { token: production, user: productionUser } = await createUser(["PRODUCTION"]);
    const { token: nobody } = await createUser(["QA_QC"]);
    const call = (token: string, method: "get" | "post" | "patch", path: string, body?: object) => {
      const r = request(app)[method](path).set(authHeader(token));
      return body ? r.send(body) : r;
    };

    // A Store person collected the card at an event; BD makes the lead from it and hands it to a Production person
    const card = await call(store, "post", "/api/business-cards", { name: "Asha Rao", company: "LD Event Foods", phones: ["+91 97000 11122"], categories: ["Powder"], event: "Expo Delhi 2026" });
    expect(card.status).toBe(201);
    expect((await call(store, "get", "/api/leads/assignees")).status).toBe(403); // BD picks the person
    const people = (await call(bd, "get", "/api/leads/assignees")).body as { id: string; name: string; department: string }[];
    expect(people.find((p) => p.id === productionUser.id)).toMatchObject({ department: "Production" });
    expect((await call(bd, "post", "/api/leads", lead({ brandName: "LD Event Foods", businessCardId: card.body.id, assignToId: "00000000-0000-0000-0000-000000000000" }))).status).toBe(400); // not a user
    const made = await call(bd, "post", "/api/leads", lead({ brandName: "LD Event Foods", businessCardId: card.body.id, assignToId: productionUser.id }));
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ pocId: productionUser.id, businessCardId: card.body.id });
    const id = made.body.id as string;
    const told = await prisma.notification.findMany({ where: { recipientId: productionUser.id } });
    expect(told.some((n) => n.title.includes("LD Event Foods") && n.link === `/leads/${id}`)).toBe(true);

    // The person it was handed to sees it and works on it: meetings, status, follow-up date
    expect(((await call(production, "get", "/api/leads")).body as { id: string }[]).map((l) => l.id)).toEqual([id]);
    expect((await call(production, "get", `/api/leads/${id}`)).status).toBe(200);
    const meeting = await call(production, "post", `/api/leads/${id}/meetings`, { meetingDate: new Date().toISOString(), notes: "Called her, sending samples", statusAfter: "WARM", nextFollowUpAt: inDays(4) });
    expect(meeting.status).toBe(201);
    expect((await call(production, "patch", `/api/leads/${id}`, { city: "Delhi" })).body).toMatchObject({ city: "Delhi", status: "WARM" });
    expect((await call(production, "get", "/api/leads/summary")).body.total).toBe(1);

    // BD who made it still sees it; another BD, the card's collector and other departments do not
    expect((await call(bd, "get", `/api/leads/${id}`)).status).toBe(200);
    expect(((await call(bd, "get", "/api/leads")).body as { id: string }[]).map((l) => l.id)).toContain(id);
    expect((await call(otherBd, "get", `/api/leads/${id}`)).status).toBe(404);
    expect((await call(store, "get", `/api/leads/${id}`)).status).toBe(404);
    expect((await call(nobody, "get", `/api/leads/${id}`)).status).toBe(404);

    // Adding a lead, handing it on and Convert are BD's
    expect((await call(production, "post", "/api/leads", lead())).status).toBe(403);
    expect((await call(production, "patch", `/api/leads/${id}`, { pocId: storeUser.id })).status).toBe(403);
    expect((await call(production, "post", `/api/leads/${id}/convert`, {})).status).toBe(403);

    // BD hands it on to someone else: it moves to them, and the first person no longer has it
    const moved = await call(bd, "patch", `/api/leads/${id}`, { pocId: storeUser.id });
    expect(moved.status).toBe(200);
    expect(moved.body.pocId).toBe(storeUser.id);
    expect((await call(production, "get", `/api/leads/${id}`)).status).toBe(404);
    expect((await call(store, "get", `/api/leads/${id}`)).status).toBe(200);
    expect((await call(bd, "patch", `/api/leads/${id}`, { pocId: "00000000-0000-0000-0000-000000000000" })).status).toBe(400);
    await prisma.user.update({ where: { id: productionUser.id }, data: { isActive: false } });
    expect((await call(bd, "patch", `/api/leads/${id}`, { pocId: productionUser.id })).status).toBe(400); // a switched-off user cannot follow it up
    void bdUser;
  });

  it("BD can delete a lead that has gone nowhere, never one with a meeting or a conversion; a department that was handed it cannot", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token: other, user: otherUser } = await createUser(["PRODUCTION"]);
    const call = (token: string, method: "get" | "post" | "patch" | "delete", path: string, body?: object) => {
      const r = request(app)[method](path).set(authHeader(token));
      return body ? r.send(body) : r;
    };
    const add = async () => (await call(bd, "post", "/api/leads", lead())).body.id as string;

    // Handed to a department: that person works the lead but cannot delete it; BD can
    const first = await add();
    expect((await call(bd, "patch", `/api/leads/${first}`, { pocId: otherUser.id })).status).toBe(200);
    expect((await call(other, "delete", `/api/leads/${first}`)).status).toBe(403);
    expect((await call(bd, "delete", `/api/leads/${first}`)).status).toBe(204);
    expect((await call(bd, "get", `/api/leads/${first}`)).status).toBe(404);
    expect((await call(bd, "delete", `/api/leads/${first}`)).status).toBe(404);
    expect((await prisma.auditLog.findMany({ where: { action: "lead.deleted", entityId: first } })).length).toBe(1);

    // A meeting is a history: the lead stays
    const talked = await add();
    expect((await call(bd, "post", `/api/leads/${talked}/meetings`, { meetingDate: new Date().toISOString(), notes: "Talked", statusAfter: "WARM", nextFollowUpAt: inDays(3) })).status).toBe(201);
    const refused = await call(bd, "delete", `/api/leads/${talked}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Dropped instead/);
    expect((await call(bd, "get", `/api/leads/${talked}`)).status).toBe(200);

    // A converted lead stays too
    const converted = await add();
    await prisma.lead.update({ where: { id: converted }, data: { status: "CONVERTED" } });
    expect((await call(bd, "delete", `/api/leads/${converted}`)).status).toBe(409);
  });
});
