import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/common/lib/prisma";
import { authHeader, createUser } from "./helpers";

const app = createApp();

describe("POST /api/customers", () => {
  it("is restricted to BD (ADMIN bypasses)", async () => {
    const { token: storeToken } = await createUser(["STORE"]);
    const denied = await request(app).post("/api/customers").set(authHeader(storeToken)).send({ companyName: "X" });
    expect(denied.status).toBe(403);

    const { token: bdToken } = await createUser(["BD"]);
    const asBd = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "BD Created Co." });
    expect(asBd.status).toBe(201);
  });

  it("read access is open to any authenticated user", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Acme Co." });

    const { token: plainToken } = await createUser([]);
    const res = await request(app).get("/api/customers").set(authHeader(plainToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
  });

  it("contactNo must be exactly 10 digits when given; email must be a valid address (any domain, not just Gmail)", async () => {
    const { token: bdToken } = await createUser(["BD"]);

    const shortPhone = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Short Phone Co.", contactNo: "98765" });
    expect(shortPhone.status).toBe(400);

    const nonDigitPhone = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Non-Digit Phone Co.", contactNo: "98765-43210" });
    expect(nonDigitPhone.status).toBe(400);

    const badEmail = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Bad Email Co.", email: "not-an-email" });
    expect(badEmail.status).toBe(400);

    // A real business-domain email (not @gmail.com) is accepted — the
    // rule is "valid email format," not "Gmail only."
    const ok = await request(app)
      .post("/api/customers")
      .set(authHeader(bdToken))
      .send({ companyName: "Valid Contact Co.", contactNo: "9876543210", email: "purchasing@somecompany.com" });
    expect(ok.status).toBe(201);
    expect(ok.body.contactNo).toBe("9876543210");
    expect(ok.body.email).toBe("purchasing@somecompany.com");
  });
});

describe("POST /api/customers/import-updates", () => {
  it("is restricted to BD (ADMIN bypasses)", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Gate Co." });

    const { token: storeToken } = await createUser(["STORE"]);
    const denied = await request(app)
      .post("/api/customers/import-updates")
      .set(authHeader(storeToken))
      .send({ rows: [{ companyName: "Gate Co.", email: "x@y.com" }] });
    expect(denied.status).toBe(403);

    const asBd = await request(app)
      .post("/api/customers/import-updates")
      .set(authHeader(bdToken))
      .send({ rows: [{ companyName: "Gate Co.", email: "x@y.com" }] });
    expect(asBd.status).toBe(200);
    expect(asBd.body.updated).toBe(1);
  });

  it("matches by Company Name case-insensitively and only touches fields the row actually supplies — an omitted field is left alone, not cleared", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const created = await request(app)
      .post("/api/customers")
      .set(authHeader(bdToken))
      .send({ companyName: "Blank Cell Co.", contactPerson: "Original Person", gstNo: "27ORIGINAL0000A1Z5" });
    expect(created.status).toBe(201);

    // Row only supplies email — companyName is matched case-insensitively,
    // contactPerson/gstNo are entirely omitted from the row.
    const res = await request(app)
      .post("/api/customers/import-updates")
      .set(authHeader(bdToken))
      .send({ rows: [{ companyName: "blank cell co.", email: "new-email@somecompany.com" }] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.results[0].status).toBe("updated");

    const refetched = await request(app).get(`/api/customers/${created.body.id}`).set(authHeader(bdToken));
    expect(refetched.body.email).toBe("new-email@somecompany.com");
    expect(refetched.body.contactPerson).toBe("Original Person");
    expect(refetched.body.gstNo).toBe("27ORIGINAL0000A1Z5");
  });

  it("reports an unmatched Company Name instead of creating a new customer", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const res = await request(app)
      .post("/api/customers/import-updates")
      .set(authHeader(bdToken))
      .send({ rows: [{ companyName: "Nobody Registered This Co." }] });
    expect(res.status).toBe(200);
    expect(res.body.unmatched).toBe(1);
    expect(res.body.results[0].status).toBe("unmatched");

    const list = await request(app).get("/api/customers").set(authHeader(bdToken));
    expect(list.body.some((c: { companyName: string }) => c.companyName === "Nobody Registered This Co.")).toBe(false);
  });

  it("reports ambiguous when two customers share a Company Name, and updates neither", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const first = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Duplicate Name Co." });
    const second = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Duplicate Name Co." });

    const res = await request(app)
      .post("/api/customers/import-updates")
      .set(authHeader(bdToken))
      .send({ rows: [{ companyName: "Duplicate Name Co.", email: "should-not-land@anywhere.com" }] });
    expect(res.status).toBe(200);
    expect(res.body.ambiguous).toBe(1);
    expect(res.body.results[0].status).toBe("ambiguous");

    const refetchedFirst = await request(app).get(`/api/customers/${first.body.id}`).set(authHeader(bdToken));
    const refetchedSecond = await request(app).get(`/api/customers/${second.body.id}`).set(authHeader(bdToken));
    expect(refetchedFirst.body.email).toBeFalsy();
    expect(refetchedSecond.body.email).toBeFalsy();
  });

  it("an invalid row (bad phone format) doesn't block the rest of the batch, and writes an audit log entry per successful update", async () => {
    const { token: bdToken } = await createUser(["BD"]);
    const rowA = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Row A Co." });
    await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Row B Co." });
    const rowC = await request(app).post("/api/customers").set(authHeader(bdToken)).send({ companyName: "Row C Co." });

    const res = await request(app)
      .post("/api/customers/import-updates")
      .set(authHeader(bdToken))
      .send({
        rows: [
          { companyName: "Row A Co.", email: "a@somecompany.com" },
          { companyName: "Row B Co.", contactNo: "98765" }, // malformed — not 10 digits
          { companyName: "Row C Co.", email: "c@somecompany.com" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(res.body.invalid).toBe(1);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(["updated", "invalid", "updated"]);

    const log = await prisma.auditLog.findFirst({ where: { action: "customer.updated", entityId: rowA.body.id }, orderBy: { createdAt: "desc" } });
    expect(log).toBeTruthy();
    expect(log?.entityType).toBe("Customer");

    const refetchedC = await request(app).get(`/api/customers/${rowC.body.id}`).set(authHeader(bdToken));
    expect(refetchedC.body.email).toBe("c@somecompany.com");
  });
});
