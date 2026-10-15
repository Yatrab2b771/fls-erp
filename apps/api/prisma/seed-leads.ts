import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/common/lib/prisma";
import { signAccessToken } from "../src/common/lib/jwt";

/**
 * Demo leads for the BD login (dev data only): a few companies at different statuses, some with meetings, some due today or overdue.
 * Running it again adds nothing if the demo leads are already there.
 *
 *   npx tsx prisma/seed-leads.ts
 */
const app = createApp();

async function main() {
  const user = await prisma.user.findFirstOrThrow({ where: { email: "bd@fls.local" }, include: { roles: { include: { role: true } } } });
  const token = signAccessToken({ sub: user.id, roles: user.roles.map((r) => r.role.name), tokenVersion: user.tokenVersion });
  const call = async (method: "get" | "post", path: string, body?: object) => {
    const r = request(app)[method](path).set("Authorization", `Bearer ${token}`);
    const res = await (body ? r.send(body) : r);
    if (![200, 201].includes(res.status)) throw new Error(`${method.toUpperCase()} ${path} -> ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body as { id: string };
  };
  if (await prisma.lead.count({ where: { brandName: { startsWith: "DEMO " }, pocId: user.id } })) return console.log("Demo leads are already there.");

  const at = (days: number, hour = 10) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const month = (n: number) => {
    const d = new Date();
    d.setMonth(d.getMonth() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  type Meeting = { daysAgo: number; notes: string; status: string; followUp?: number; closure?: string };
  const demo: { lead: object; meetings: Meeting[] }[] = [
    {
      lead: { brandName: "DEMO Medivita Pharma", contactPerson: "Dr. Neha Singh", designation: "Product Manager", phones: ["+91 98215 67890"], email: "neha.singh@demo-medivita.com", city: "Greater Noida", state: "Uttar Pradesh", customerTypes: ["Exports"], productFormats: ["Capsules", "Tablets", "Powder"], powderTypes: ["Yeast"], leadSource: "Referral" },
      meetings: [
        { daysAgo: 24, notes: "First call after the card was scanned. Introduced the company, shared the corporate presentation on email.", status: "DISCUSSION", followUp: -12 },
        { daysAgo: 12, notes: "Met at their office. Looked at our capsule and tablet range. They also want a powder line later.", status: "DISCUSSION", followUp: -1 },
        { daysAgo: 1, notes: "Wants yeast protein for the export market. Asked for the price list and a sample plan. Decision will take 2 months.", status: "COLD", followUp: 0, closure: month(2) },
      ],
    },
    {
      lead: { brandName: "DEMO Fit Fuel Brands", contactPerson: "Rohan Mehta", designation: "Founder", phones: ["+91 98765 43210"], city: "Mumbai", state: "Maharashtra", customerTypes: ["D2C", "Sports"], productFormats: ["Powder", "Bars"], powderTypes: ["Whey", "Clear"], leadSource: "LinkedIn" },
      meetings: [
        { daysAgo: 30, notes: "Intro call. Looking for a new whey supplier.", status: "DISCUSSION", followUp: -20 },
        { daysAgo: 20, notes: "Discussed flavours and the minimum order size.", status: "WARM", followUp: -10, closure: month(2) },
        { daysAgo: 9, notes: "Liked the whey samples. Needs the final quotation and the labels checked before the PO.", status: "HOT", followUp: 0, closure: month(1) },
      ],
    },
    {
      lead: { brandName: "DEMO Gummy Labs", contactPerson: "Priya Nair", designation: "Category Head", phones: ["+91 99887 76655"], city: "Pune", state: "Maharashtra", customerTypes: ["D2C", "Distribution"], productFormats: ["Gummies"], leadSource: "Website" },
      meetings: [{ daysAgo: 6, notes: "Wants vitamin gummies for kids. Needs a sample first.", status: "SAMPLING", followUp: 4, closure: month(3) }],
    },
    {
      lead: { brandName: "DEMO Wellness Cart", contactPerson: "Sandeep Kaur", designation: "Purchase Lead", phones: ["+91 91234 56780"], city: "Delhi", state: "Delhi", customerTypes: ["Distribution"], productFormats: ["Powder", "Liquid"], powderTypes: ["Protein"], leadSource: "E-com platforms" },
      meetings: [
        { daysAgo: 15, notes: "Called twice. Interested in two protein flavours.", status: "DISCUSSION", followUp: -8 },
        { daysAgo: 8, notes: "Wants a price for two protein flavours. Will confirm the quantity after talking to her partner.", status: "WARM", followUp: -2, closure: month(2) },
      ],
    },
    {
      lead: { brandName: "DEMO Green Roots", contactPerson: "Arjun Rao", designation: "Director", phones: ["+91 90000 11122"], city: "Bengaluru", state: "Karnataka", customerTypes: ["D2C", "MLM"], productFormats: ["Capsules", "Omega"], leadSource: "Referral" },
      meetings: [{ daysAgo: 2, notes: "Introduced capsules and omega. Asked for the minimum order size.", status: "DISCUSSION", followUp: 5 }],
    },
    {
      lead: { brandName: "DEMO Sleep Easy", contactPerson: "Meera Joshi", designation: "Owner", phones: ["+91 98989 12121"], city: "Jaipur", state: "Rajasthan", customerTypes: ["Others"], productFormats: ["Gummies", "Soft gel"], leadSource: "Paid campaigns" },
      meetings: [
        { daysAgo: 40, notes: "Interested but the budget is not ready.", status: "COLD", followUp: -25, closure: month(4) },
        { daysAgo: 20, notes: "Asked to talk again after the festive season.", status: "HOLD", followUp: 60, closure: month(5) },
      ],
    },
    {
      lead: { brandName: "DEMO Iron Pulse", contactPerson: "Karan Malhotra", designation: "Buyer", phones: ["+91 97777 00011"], city: "Chandigarh", state: "Punjab", customerTypes: ["Sports"], productFormats: ["Tablets"], leadSource: "Regional brands" },
      meetings: [
        { daysAgo: 18, notes: "Wanted tablets at a price we cannot meet.", status: "DISCUSSION", followUp: -10 },
        { daysAgo: 10, notes: "Not interested at our price.", status: "DROPPED" },
      ],
    },
  ];

  for (const d of demo) {
    const created = await call("post", "/api/leads", d.lead);
    for (const m of d.meetings) {
      const meetingDate = at(-m.daysAgo, 11);
      await call("post", `/api/leads/${created.id}/meetings`, {
        meetingDate,
        mode: m.daysAgo % 3 === 0 ? "IN_PERSON" : "CALL",
        notes: m.notes,
        statusAfter: m.status,
        ...(m.status === "DROPPED" ? {} : { nextFollowUpAt: at(m.followUp ?? 3, m.followUp === 0 ? 16 : 10) }),
        ...(m.closure ? { closureMonth: m.closure } : {}),
      });
    }
  }
  console.log(`Added ${demo.length} demo leads for ${user.email}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
