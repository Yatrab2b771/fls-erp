import { describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

// A card drawn as an image, so the real OCR runs end to end.
async function cardPhoto(): Promise<Buffer> {
  const rows = [
    ["MEDIVITA", 64, "bold", 90],
    ["PHARMACEUTICALS PVT. LTD.", 30, "normal", 135],
    ["Dr. Neha Singh", 44, "bold", 230],
    ["Product Manager", 28, "normal", 270],
    ["M: +91 98215 67890", 28, "normal", 340],
    ["E: neha.singh@medivita.com", 28, "normal", 380],
    ["A-12, BioTech Park, Knowledge City,", 26, "normal", 480],
    ["Greater Noida, Uttar Pradesh - 201310", 26, "normal", 515],
  ] as const;
  const text = rows.map(([t, size, weight, y]) => `<text x="60" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" fill="#222">${t}</text>`).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1050" height="600"><rect width="1050" height="600" fill="#fff"/>${text}</svg>`);
  return sharp(svg).rotate(2, { background: "#999" }).blur(0.6).jpeg({ quality: 75 }).toBuffer();
}

// A scan is saved at once as READING and read in the background: wait until its fields are in.
async function untilRead(token: string, id: string) {
  for (let i = 0; i < 160; i++) {
    const res = await request(app).get(`/api/business-cards/${id}`).set(authHeader(token));
    if (res.body.status && res.body.status !== "READING") return res.body;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("the card is still being read");
}

describe("Visiting cards", () => {
  it("scans a card (read in the background), lets its collector verify it, finds duplicates, lets BD turn it into a customer, and keeps each person's cards private", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token: otherBd } = await createUser(["BD"]);
    const { token: store } = await createUser(["STORE"]);

    // Every department can use it: a person with no cards sees an empty book
    expect((await request(app).get("/api/business-cards").set(authHeader(store))).body).toEqual([]);

    // Scan: the card is saved at once as READING, then the photo is read and the fields fill in (NEEDS_VERIFY)
    const scan = await request(app).post("/api/business-cards/scan").set(authHeader(bd)).field("categories", JSON.stringify(["Powder", "Capsule"])).field("event", "Expo Delhi 2026").attach("photo", await cardPhoto(), "card.jpg");
    expect(scan.status).toBe(201);
    expect(scan.body).toMatchObject({ status: "READING", source: "SCAN", hasPhoto: true, categories: ["Powder", "Capsule"], event: "Expo Delhi 2026", email: "" });
    const id = scan.body.id as string;
    expect((await request(app).patch(`/api/business-cards/${id}`).set(authHeader(bd)).send({ name: "x" })).status).toBe(409); // not while it is being read
    const read = await untilRead(bd, id);
    expect(read).toMatchObject({ status: "NEEDS_VERIFY", readError: null, email: "neha.singh@medivita.com", event: "Expo Delhi 2026", duplicateOf: null });
    expect(read.name).toContain("Neha Singh");
    expect(read.phones).toContain("+91 98215 67890");
    expect(read.company.toLowerCase()).toContain("medivita");
    expect(read.confidence.email).toBeGreaterThan(0.5);
    expect(read.ocrLines.length).toBeGreaterThan(3);

    // The photo can be fetched by its collector and by BD, not by another department's login
    const photo = await request(app).get(`/api/business-cards/${id}/photo`).set(authHeader(bd));
    expect(photo.status).toBe(200);
    expect(photo.headers["content-type"]).toContain("image/jpeg");
    expect((await request(app).get(`/api/business-cards/${id}/photo`).set(authHeader(otherBd))).status).toBe(200);
    expect((await request(app).get(`/api/business-cards/${id}/photo`).set(authHeader(store))).status).toBe(404);

    // Verify needs a category; the collector corrects a field and saves
    expect((await request(app).patch(`/api/business-cards/${id}`).set(authHeader(bd)).send({ categories: [], verify: true })).status).toBe(400);
    const verified = await request(app).patch(`/api/business-cards/${id}`).set(authHeader(bd)).send({ name: "Dr. Neha Singh", designation: "Product Manager", notes: "Met at the expo", verify: true });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ status: "VERIFIED", notes: "Met at the expo" });
    expect(verified.body.verifiedAt).toBeTruthy();

    // Someone typing in the same contact is told it already exists (same email, or same phone in another format)
    const dup = await request(app).get("/api/business-cards/duplicates").query({ email: "NEHA.singh@medivita.com", phone: "098215 67890" }).set(authHeader(store));
    expect(dup.body).toHaveLength(1);
    expect(dup.body[0]).toMatchObject({ id });
    expect((await request(app).get("/api/business-cards/duplicates").query({ email: "nobody@nowhere.com" }).set(authHeader(store))).body).toEqual([]);
    expect((await request(app).get("/api/business-cards/duplicates").query({ email: "neha.singh@medivita.com", excludeId: id }).set(authHeader(store))).body).toEqual([]);

    // Privacy: another department sees nothing of it; BD (any BD) and Admin see everything
    expect((await request(app).get("/api/business-cards").set(authHeader(store))).body).toEqual([]);
    expect((await request(app).get(`/api/business-cards/${id}`).set(authHeader(store))).status).toBe(404);
    expect((await request(app).get(`/api/business-cards/${id}`).set(authHeader(otherBd))).status).toBe(200);
    const { token: admin } = await createUser(["ADMIN"]);
    expect((await request(app).get("/api/business-cards").set(authHeader(admin))).body.length).toBeGreaterThanOrEqual(1);

    // A customer comes only from BD
    expect((await request(app).post(`/api/business-cards/${id}/create-customer`).set(authHeader(store))).status).toBe(403);
    const made = await request(app).post(`/api/business-cards/${id}/create-customer`).set(authHeader(bd));
    expect(made.status).toBe(201);
    expect(made.body.existed).toBe(false);
    const again = await request(app).post(`/api/business-cards/${id}/create-customer`).set(authHeader(otherBd));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ existed: true, customerId: made.body.customerId });
    const customers = (await request(app).get("/api/customers").set(authHeader(bd))).body as { id: string; contactPerson: string | null; email: string | null }[];
    expect(customers.find((c) => c.id === made.body.customerId)).toMatchObject({ contactPerson: "Dr. Neha Singh", email: "neha.singh@medivita.com" });

    // Delete (only the collector or BD)
    expect((await request(app).delete(`/api/business-cards/${id}`).set(authHeader(store))).status).toBe(404);
    expect((await request(app).delete(`/api/business-cards/${id}`).set(authHeader(bd))).status).toBe(204);
    expect((await request(app).get(`/api/business-cards/${id}`).set(authHeader(bd))).status).toBe(404);
  }, 120_000);

  it("is collected by every department at an event: own cards only, BD sees all, a repeat contact is flagged (not blocked), and BD sorts it out", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token: store } = await createUser(["STORE"]);
    const { token: production } = await createUser(["PRODUCTION"]);
    const card = (token: string, body: object) => request(app).post("/api/business-cards").set(authHeader(token)).send({ categories: ["Powder"], event: "Expo Delhi 2026", ...body });

    // Two departments collect; the second person met the same contact (same phone, written differently): saved all the same, flagged as a duplicate
    const first = await card(store, { name: "Ravi Kumar", company: "Zenith Foods", phones: ["+91 98111 22233"], email: "ravi@zenith.com" });
    const second = await card(production, { name: "R. Kumar", company: "Zenith Foods Pvt", phones: ["098111 22233"] });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body).toMatchObject({ duplicateOf: null, event: "Expo Delhi 2026", collectedBy: { name: expect.any(String), department: "Store" } });
    expect(second.body.collectedBy.department).toBe("Production");
    expect(second.body.duplicateOf).toMatchObject({ id: first.body.id, name: "Ravi Kumar", company: "Zenith Foods" });
    const third = await card(store, { name: "Someone Else", company: "Other Co", phones: ["+91 90000 00001"] });
    expect(third.body.duplicateOf).toBeNull();

    // Everyone sees their own cards; BD sees all, with who collected each
    const mine = (token: string) => request(app).get("/api/business-cards").set(authHeader(token));
    expect((await mine(production)).body.map((c: { id: string }) => c.id)).toEqual([second.body.id]);
    expect((await mine(store)).body).toHaveLength(2);
    const all = (await mine(bd)).body as { id: string; collectedBy: { department: string } }[];
    expect(all).toHaveLength(3);
    expect(all.find((c) => c.id === second.body.id)!.collectedBy.department).toBe("Production");
    expect((await request(app).get("/api/business-cards/events").set(authHeader(production))).body).toEqual(["Expo Delhi 2026"]);

    // Only BD clears the flag ("two different people"); the flag also goes when the other card is deleted
    expect((await request(app).post(`/api/business-cards/${second.body.id}/clear-duplicate`).set(authHeader(production))).status).toBe(403);
    expect((await request(app).post(`/api/business-cards/${second.body.id}/clear-duplicate`).set(authHeader(bd))).body.duplicateOf).toBeNull();
    const fourth = await card(production, { name: "Ravi again", phones: ["+91 98111 22233"] });
    expect(fourth.body.duplicateOf).toMatchObject({ id: first.body.id }); // the oldest card with that phone
    expect((await request(app).delete(`/api/business-cards/${first.body.id}`).set(authHeader(bd))).status).toBe(204);
    expect((await request(app).get(`/api/business-cards/${fourth.body.id}`).set(authHeader(bd))).body.duplicateOf).toBeNull();

    // Changing the phone on a card looks again for the earlier card it repeats
    const edited = await request(app).patch(`/api/business-cards/${third.body.id}`).set(authHeader(store)).send({ phones: ["+91 98111 22233"] });
    expect(edited.body.duplicateOf).toMatchObject({ id: second.body.id });
  });

  it("flags a scanned card that repeats an earlier one once it has been read, and refuses a bad photo at once", async () => {
    const { token: store } = await createUser(["STORE"]);
    const { token: production } = await createUser(["PRODUCTION"]);
    const photo = await cardPhoto();
    const scan = (token: string) => request(app).post("/api/business-cards/scan").set(authHeader(token)).field("categories", JSON.stringify(["Powder"])).attach("photo", photo, "card.jpg");

    // Two people scan the same card: they are queued and read one after the other
    const [a, b] = [await scan(store), await scan(production)];
    expect([a.status, b.status]).toEqual([201, 201]);
    const readA = await untilRead(store, a.body.id);
    const readB = await untilRead(production, b.body.id);
    expect(readA.duplicateOf).toBeNull();
    expect(readB.duplicateOf).toMatchObject({ id: a.body.id });

    const notPhoto = await request(app).post("/api/business-cards/scan").set(authHeader(store)).attach("photo", Buffer.from("not an image at all"), "x.jpg");
    expect(notPhoto.status).toBe(400);
    const tiny = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const small = await request(app).post("/api/business-cards/scan").set(authHeader(store)).attach("photo", tiny, "tiny.jpg");
    expect(small.status).toBe(400);
    expect(small.body.error).toMatch(/too small/i);
  }, 180_000);

  it("takes a card typed in by hand (already verified)", async () => {
    const { token: bd } = await createUser(["BD"]);
    expect((await request(app).post("/api/business-cards").set(authHeader(bd)).send({ name: "Manual Person" })).status).toBe(400); // no category
    expect((await request(app).post("/api/business-cards").set(authHeader(bd)).send({ categories: ["Others"] })).status).toBe(400); // no name or company
    const res = await request(app).post("/api/business-cards").set(authHeader(bd)).send({ name: "Manual Person", company: "Hand Typed Pvt Ltd", phones: ["+91 99999 11111", "+91 99999 11111"], email: "m@hand.com", categories: ["Others"] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "VERIFIED", source: "MANUAL", hasPhoto: false, phones: ["+91 99999 11111"], event: "" });
  });
});
