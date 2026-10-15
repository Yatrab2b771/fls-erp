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

describe("Visiting cards (BD)", () => {
  it("scans a card, lets BD verify it, finds duplicates, turns it into a customer, and keeps each BD's cards private", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token: otherBd } = await createUser(["BD"]);
    const { token: store } = await createUser(["STORE"]);

    // Only BD (and Admin) can use it
    expect((await request(app).get("/api/business-cards").set(authHeader(store))).status).toBe(403);

    // Scan: the photo is read and the card is saved as NEEDS_VERIFY, with the fields filled in
    const scan = await request(app).post("/api/business-cards/scan").set(authHeader(bd)).field("categories", JSON.stringify(["Powder", "Capsule"])).attach("photo", await cardPhoto(), "card.jpg");
    expect(scan.status).toBe(201);
    expect(scan.body).toMatchObject({ status: "NEEDS_VERIFY", source: "SCAN", hasPhoto: true, categories: ["Powder", "Capsule"], email: "neha.singh@medivita.com" });
    expect(scan.body.name).toContain("Neha Singh");
    expect(scan.body.phones).toContain("+91 98215 67890");
    expect(scan.body.company.toLowerCase()).toContain("medivita");
    expect(scan.body.confidence.email).toBeGreaterThan(0.5);
    expect(scan.body.ocrLines.length).toBeGreaterThan(3);
    const id = scan.body.id as string;

    // The photo can be fetched, by its owner only
    const photo = await request(app).get(`/api/business-cards/${id}/photo`).set(authHeader(bd));
    expect(photo.status).toBe(200);
    expect(photo.headers["content-type"]).toContain("image/jpeg");
    expect((await request(app).get(`/api/business-cards/${id}/photo`).set(authHeader(otherBd))).status).toBe(404);

    // Verify needs a category; BD corrects a field and saves
    expect((await request(app).patch(`/api/business-cards/${id}`).set(authHeader(bd)).send({ categories: [], verify: true })).status).toBe(400);
    const verified = await request(app).patch(`/api/business-cards/${id}`).set(authHeader(bd)).send({ name: "Dr. Neha Singh", designation: "Product Manager", notes: "Met at the expo", verify: true });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ status: "VERIFIED", notes: "Met at the expo" });
    expect(verified.body.verifiedAt).toBeTruthy();

    // A second BD typing in the same contact is told it already exists (same email, or same phone in another format)
    const dup = await request(app).get("/api/business-cards/duplicates").query({ email: "NEHA.singh@medivita.com", phone: "098215 67890" }).set(authHeader(otherBd));
    expect(dup.body).toHaveLength(1);
    expect(dup.body[0]).toMatchObject({ id });
    expect((await request(app).get("/api/business-cards/duplicates").query({ email: "nobody@nowhere.com" }).set(authHeader(otherBd))).body).toEqual([]);
    expect((await request(app).get("/api/business-cards/duplicates").query({ email: "neha.singh@medivita.com", excludeId: id }).set(authHeader(otherBd))).body).toEqual([]);

    // Privacy: the other BD sees nothing of it; Admin sees everything
    expect((await request(app).get("/api/business-cards").set(authHeader(otherBd))).body).toEqual([]);
    expect((await request(app).get(`/api/business-cards/${id}`).set(authHeader(otherBd))).status).toBe(404);
    const { token: admin } = await createUser(["ADMIN"]);
    expect((await request(app).get("/api/business-cards").set(authHeader(admin))).body.length).toBeGreaterThanOrEqual(1);

    // Create a Customer from the verified card (and a second press reuses it)
    const made = await request(app).post(`/api/business-cards/${id}/create-customer`).set(authHeader(bd));
    expect(made.status).toBe(201);
    expect(made.body.existed).toBe(false);
    const again = await request(app).post(`/api/business-cards/${id}/create-customer`).set(authHeader(bd));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ existed: true, customerId: made.body.customerId });
    const customers = (await request(app).get("/api/customers").set(authHeader(bd))).body as { id: string; contactPerson: string | null; email: string | null }[];
    expect(customers.find((c) => c.id === made.body.customerId)).toMatchObject({ contactPerson: "Dr. Neha Singh", email: "neha.singh@medivita.com" });

    // Delete
    expect((await request(app).delete(`/api/business-cards/${id}`).set(authHeader(bd))).status).toBe(204);
    expect((await request(app).get(`/api/business-cards/${id}`).set(authHeader(bd))).status).toBe(404);
  }, 120_000);

  it("takes a card typed in by hand (already verified), and refuses a bad photo", async () => {
    const { token: bd } = await createUser(["BD"]);
    expect((await request(app).post("/api/business-cards").set(authHeader(bd)).send({ name: "Manual Person" })).status).toBe(400); // no category
    expect((await request(app).post("/api/business-cards").set(authHeader(bd)).send({ categories: ["Others"] })).status).toBe(400); // no name or company
    const res = await request(app).post("/api/business-cards").set(authHeader(bd)).send({ name: "Manual Person", company: "Hand Typed Pvt Ltd", phones: ["+91 99999 11111", "+91 99999 11111"], email: "m@hand.com", categories: ["Others"] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "VERIFIED", source: "MANUAL", hasPhoto: false, phones: ["+91 99999 11111"] });

    const notPhoto = await request(app).post("/api/business-cards/scan").set(authHeader(bd)).attach("photo", Buffer.from("not an image at all"), "x.jpg");
    expect(notPhoto.status).toBe(400);
    const tiny = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const small = await request(app).post("/api/business-cards/scan").set(authHeader(bd)).attach("photo", tiny, "tiny.jpg");
    expect(small.status).toBe(400);
    expect(small.body.error).toMatch(/too small/i);
  });
});
