import { Router } from "express";
import { z } from "zod";
import { Prisma, type Lead, type LeadMeeting, type LeadReschedule } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { notifyUser } from "../../common/lib/notify";
import { CARD_CATEGORY_TO_FORMAT, CLOSED_STATUSES, CUSTOMER_TYPES, LEAD_SOURCES, LEAD_STATUSES, POWDER_TYPES, PRODUCT_FORMATS, normalizeOption, withTypedOptions, type LeadStatusName } from "./lead-options";

/**
 * BD's lead book. A lead has one person responsible for it (the POC). BD adds leads and hands them to whoever should follow them up (any department:
 * visiting cards are collected by everyone at an event); that person sees and works on their own leads (meetings, status, follow-up dates), while
 * adding leads, assigning them and Convert stay with BD. BD sees the leads they made or hold; Admin sees all of them.
 *   GET   /                 the leads (each with its meeting count and the last meeting's notes)
 *   GET   /summary          counts per status and what is due today / overdue (the dashboard tiles)
 *   GET   /forecast         the pipeline by closure month and by lead source, and the funnel from lead to PO
 *   POST  /                 add a lead (by hand, or from a visiting card: businessCardId)
 *   GET   /:id              one lead with all its meetings (newest first) and its moved follow-up dates
 *   PATCH /:id              change the lead's details or its status
 *   POST  /:id/meetings     log a meeting: notes, status afterwards, next follow-up (not for Dropped), closure month
 *   POST  /:id/reschedule   move the next follow-up date, with the reason
 *   POST  /:id/convert      Converted: only after a sample of the lead was approved, with the estimated order size. The lead then waits for its PO.
 * The estimated order size (quantity and value in Lac) opens once a sample is approved and is then mandatory (unless the lead is dropped).
 * A Converted lead waits for its PO until a purchase order of its customer is entered after the conversion; then it is done.
 */
export const leadsRouter = Router();
leadsRouter.use(requireAuth);

const isAdmin = (req: AuthedRequest) => req.user!.roles.includes("ADMIN" as never);
const isBd = (req: AuthedRequest) => req.user!.roles.includes("BD" as never);
/** Everyone: the leads they are responsible for. BD also: the leads they made (and maybe handed to someone else). Admin: all. */
const visible = (req: AuthedRequest): Prisma.LeadWhereInput => (isAdmin(req) ? {} : isBd(req) ? { OR: [{ pocId: req.user!.id }, { createdById: req.user!.id }] } : { pocId: req.user!.id });
const bdOnly = requireRole("BD");

type MeetingRow = LeadMeeting & { createdBy: { fullName: string } };
type LeadRow = Lead & { poc: { fullName: string }; _count: { meetings: number }; meetings: { number: number; meetingDate: Date; notes: string }[] };

type Extra = { sampleApproved: boolean; poNumbers: string[] };
const NO_EXTRA: Extra = { sampleApproved: false, poNumbers: [] };

function serialize(l: LeadRow, x: Extra = NO_EXTRA) {
  const last = l.meetings[0] ?? null;
  return {
    id: l.id,
    brandName: l.brandName,
    contactPerson: l.contactPerson,
    designation: l.designation,
    phones: l.phones,
    email: l.email,
    address: l.address,
    city: l.city,
    state: l.state,
    customerTypes: l.customerTypes,
    productFormats: l.productFormats,
    powderTypes: l.powderTypes,
    leadSource: l.leadSource,
    status: l.status,
    statusAt: l.statusAt.toISOString(),
    closureMonth: l.closureMonth,
    estimatedQty: l.estimatedQty,
    estimatedValueLac: l.estimatedValueLac,
    convertedAt: l.convertedAt?.toISOString() ?? null,
    sampleApproved: x.sampleApproved,
    poNumbers: x.poNumbers,
    waitingForPo: l.status === "CONVERTED" && x.poNumbers.length === 0,
    customerId: l.customerId,
    nextFollowUpAt: l.nextFollowUpAt?.toISOString() ?? null,
    businessCardId: l.businessCardId,
    pocId: l.pocId,
    pocName: l.poc.fullName,
    meetingCount: l._count.meetings,
    lastMeeting: last ? { number: last.number, meetingDate: last.meetingDate.toISOString(), notes: last.notes } : null,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

const listInclude = {
  poc: { select: { fullName: true } },
  _count: { select: { meetings: true } },
  meetings: { orderBy: { number: "desc" as const }, take: 1, select: { number: true, meetingDate: true, notes: true } },
} satisfies Prisma.LeadInclude;

/** Whether a sample of each lead was approved, and the POs a converted lead's customer has entered since the conversion. */
async function enrich(rows: LeadRow[]): Promise<Map<string, Extra>> {
  const out = new Map<string, Extra>(rows.map((l) => [l.id, { sampleApproved: false, poNumbers: [] }]));
  if (rows.length === 0) return out;
  const approved = await prisma.sampleRequest.findMany({ where: { leadId: { in: rows.map((l) => l.id) }, feedback: "APPROVED" }, select: { leadId: true } });
  for (const a of approved) if (a.leadId) out.get(a.leadId)!.sampleApproved = true;
  const converted = rows.filter((l) => l.status === "CONVERTED" && l.customerId && l.convertedAt);
  if (converted.length) {
    const pos = await prisma.purchaseOrder.findMany({ where: { customerId: { in: [...new Set(converted.map((l) => l.customerId!))] } }, select: { customerId: true, poNumber: true, createdAt: true }, orderBy: { createdAt: "asc" } });
    for (const l of converted) {
      out.get(l.id)!.poNumbers = pos.filter((p) => p.customerId === l.customerId && p.createdAt >= l.convertedAt!).map((p) => p.poNumber ?? "(no number)");
    }
  }
  return out;
}
const withExtra = async (l: LeadRow) => serialize(l, (await enrich([l])).get(l.id));

const serializeMeeting = (m: MeetingRow) => ({
  id: m.id,
  number: m.number,
  meetingDate: m.meetingDate.toISOString(),
  mode: m.mode,
  notes: m.notes,
  statusAfter: m.statusAfter,
  nextFollowUpAt: m.nextFollowUpAt?.toISOString() ?? null,
  closureMonth: m.closureMonth,
  createdByName: m.createdBy.fullName,
  createdAt: m.createdAt.toISOString(),
});

const serializeReschedule = (r: LeadReschedule & { by: { fullName: string } }) => ({
  id: r.id,
  fromAt: r.fromAt?.toISOString() ?? null,
  toAt: r.toAt.toISOString(),
  reason: r.reason,
  byName: r.by.fullName,
  createdAt: r.createdAt.toISOString(),
});

// ---------------------------------------------------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------------------------------------------------

const text = (max: number) => z.string().trim().max(max);
const pick = <T extends readonly [string, ...string[]]>(list: T) => z.enum(list);
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Closure month must look like 2026-12");
const dateTime = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), "Not a valid date and time").transform((v) => new Date(v));

const estimateFields = { estimatedQty: text(120).nullable(), estimatedValueLac: z.number().positive("The value must be more than zero.").max(100000).nullable() };

// The list's own names, or a name BD typed under "Others" (2 to 40 letters; one in the list in another case becomes the list's spelling)
const optionList = (fixed: readonly string[]) =>
  z
    .array(z.string().trim().min(2, "A name needs at least 2 letters.").max(40, "Keep each name under 40 letters."))
    .max(30)
    .transform((xs) => [...new Set(xs.map((x) => normalizeOption(fixed, x)))]);

const detailFields = {
  brandName: text(200).min(1, "Enter the brand / company name."),
  contactPerson: text(120),
  designation: text(160),
  phones: z.array(text(30).min(1)).max(6),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().email().max(200)]),
  address: text(500),
  city: text(80),
  state: text(80),
  customerTypes: optionList(CUSTOMER_TYPES),
  productFormats: optionList(PRODUCT_FORMATS),
  powderTypes: optionList(POWDER_TYPES),
  leadSource: pick(LEAD_SOURCES).nullable(),
};

const unique = <T>(xs: T[]) => [...new Set(xs)];
const cleanPhones = (phones: string[]) => unique(phones.map((p) => p.trim()).filter(Boolean));

const createSchema = z
  .object({
    ...detailFields,
    contactPerson: detailFields.contactPerson.optional(),
    designation: detailFields.designation.optional(),
    phones: detailFields.phones.optional(),
    email: detailFields.email.optional(),
    address: detailFields.address.optional(),
    city: detailFields.city.optional(),
    state: detailFields.state.optional(),
    powderTypes: detailFields.powderTypes.optional(),
    leadSource: detailFields.leadSource.optional(),
    status: pick(LEAD_STATUSES).optional(),
    nextFollowUpAt: dateTime.optional(),
    closureMonth: monthSchema.optional(),
    businessCardId: z.string().uuid().optional(),
    // Who follows this lead up (any active user); BD themself when not given
    assignToId: z.string().uuid().optional(),
  })
  .refine((d) => d.customerTypes.length > 0, { message: "Choose at least one customer type.", path: ["customerTypes"] })
  .refine((d) => d.productFormats.length > 0, { message: "Choose at least one product format.", path: ["productFormats"] })
  .refine((d) => !d.productFormats.includes("Powder") || (d.powderTypes?.length ?? 0) > 0, { message: "Powder is selected: choose its powder type.", path: ["powderTypes"] });

const updateSchema = z
  .object({
    ...detailFields,
    status: pick(LEAD_STATUSES),
    nextFollowUpAt: dateTime.nullable(),
    closureMonth: monthSchema.nullable(),
    ...estimateFields,
    // BD / Admin: hand the lead to someone else
    pocId: z.string().uuid(),
  })
  .partial()
  .refine((d) => d.customerTypes === undefined || d.customerTypes.length > 0, { message: "Choose at least one customer type.", path: ["customerTypes"] })
  .refine((d) => d.productFormats === undefined || d.productFormats.length > 0, { message: "Choose at least one product format.", path: ["productFormats"] });

const meetingSchema = z
  .object({
    meetingDate: dateTime,
    mode: z.enum(["CALL", "VIDEO", "IN_PERSON"]).default("CALL"),
    notes: text(4000).min(1, "Write the key points of this meeting."),
    statusAfter: pick(LEAD_STATUSES),
    nextFollowUpAt: dateTime.optional(),
    closureMonth: monthSchema.optional(),
    estimatedQty: text(120).optional(),
    estimatedValueLac: z.number().positive("The value must be more than zero.").max(100000).optional(),
  })
  .refine((d) => d.statusAfter !== "DROPPED" || !d.nextFollowUpAt, { message: "A dropped lead has no next follow-up.", path: ["nextFollowUpAt"] })
  .refine((d) => d.statusAfter === "DROPPED" || !!d.nextFollowUpAt, { message: "Choose the next follow-up date and time.", path: ["nextFollowUpAt"] });

const rescheduleSchema = z.object({ toAt: dateTime, reason: text(500).min(1, "Write why the follow-up is moving.") });

const CONVERTED_MESSAGE = "A lead can be Converted only after its sample is approved: use Convert lead on the lead's page.";
const ESTIMATE_LOCKED_MESSAGE = "The estimated order size opens after the sample is approved.";
const ESTIMATE_NEEDED_MESSAGE = "Enter the estimated order size (quantity and value in Lac): the sample was approved.";
const convertSchema = z.object({ estimatedQty: text(120).optional(), estimatedValueLac: z.number().positive("The value must be more than zero.").max(100000).optional() });
const hasEstimate = (qty: string | null | undefined, value: number | null | undefined) => !!qty?.trim() && value != null && value > 0;

const clean = (d: { phones?: string[]; powderTypes?: string[]; productFormats?: string[] }) => ({
  ...(d.phones ? { phones: cleanPhones(d.phones) } : {}),
});

// ---------------------------------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------------------------------

leadsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await prisma.lead.findMany({ where: visible(req), include: listInclude, orderBy: [{ nextFollowUpAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }], take: 5000 });
    const extra = await enrich(rows);
    res.json(rows.map((l) => serialize(l, extra.get(l.id))));
  } catch (err) {
    next(err);
  }
});

/** `from` / `until` (ISO) are the start and the end of the caller's today, so "today" means the salesman's day, not the server's. */
leadsRouter.get("/summary", async (req: AuthedRequest, res, next) => {
  try {
    const parse = (v: unknown, fallback: Date) => {
      const d = typeof v === "string" ? new Date(v) : fallback;
      return Number.isNaN(d.getTime()) ? fallback : d;
    };
    const startOfToday = new Date(new Date().toDateString());
    const endOfToday = new Date(startOfToday.getTime() + 24 * 3_600_000 - 1);
    const from = parse(req.query.from, startOfToday);
    const until = parse(req.query.until, endOfToday);
    const where = visible(req);
    const open: Prisma.LeadWhereInput = { ...where, status: { notIn: CLOSED_STATUSES } };
    const convertedRows = await prisma.lead.findMany({ where, include: listInclude });
    const waitingForPo = convertedRows.filter((l) => l.status === "CONVERTED");
    const waitingExtra = await enrich(waitingForPo);
    const waiting = waitingForPo.filter((l) => (waitingExtra.get(l.id)?.poNumbers.length ?? 0) === 0).length;
    const [groups, overdue, dueToday, noFollowUp, total] = await Promise.all([
      prisma.lead.groupBy({ by: ["status"], where, _count: { _all: true } }),
      prisma.lead.count({ where: { ...open, nextFollowUpAt: { lt: from } } }),
      prisma.lead.count({ where: { ...open, nextFollowUpAt: { gte: from, lte: until } } }),
      prisma.lead.count({ where: { ...open, nextFollowUpAt: null } }),
      prisma.lead.count({ where }),
    ]);
    const byStatus = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<LeadStatusName, number>;
    for (const g of groups) byStatus[g.status] = g._count._all;
    res.json({ total, byStatus, followUpToday: overdue + dueToday, overdue, dueToday, noFollowUp, waitingForPo: waiting });
  } catch (err) {
    next(err);
  }
});

/**
 * What BD can expect: for the leads the caller sees, the open pipeline by the month the order is expected (count, estimated value, how hot), by lead
 * source, and the funnel: leads, how many reached a sample, got it approved, were converted, and have their PO. The estimated value exists only for
 * leads whose sample was approved (that is when it is asked), so a month's value is what is already firm enough to be estimated.
 */
leadsRouter.get("/forecast", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await prisma.lead.findMany({ where: visible(req), include: listInclude, take: 5000 });
    const extra = await enrich(rows);
    const withSample = new Set((await prisma.sampleRequest.findMany({ where: { leadId: { in: rows.map((l) => l.id) } }, select: { leadId: true } })).map((s) => s.leadId));
    const value = (l: (typeof rows)[number]) => l.estimatedValueLac ?? 0;
    const temp = (l: (typeof rows)[number]) => (l.status === "HOT" ? "hot" : l.status === "WARM" ? "warm" : l.status === "COLD" ? "cold" : "other");

    // by month: open leads (not dropped), plus converted ones, in the month their order is expected
    type Bucket = { leads: number; valueLac: number; hot: number; warm: number; cold: number; other: number; converted: number };
    const empty = (): Bucket => ({ leads: 0, valueLac: 0, hot: 0, warm: 0, cold: 0, other: 0, converted: 0 });
    const byMonth = new Map<string, Bucket>();
    const bySource = new Map<string, Bucket>();
    const add = (map: Map<string, Bucket>, key: string, l: (typeof rows)[number]) => {
      const b = map.get(key) ?? empty();
      b.leads += 1;
      b.valueLac += value(l);
      b[temp(l)] += 1;
      if (l.status === "CONVERTED") b.converted += 1;
      map.set(key, b);
    };
    for (const l of rows) {
      add(bySource, l.leadSource ?? "Not set", l);
      if (l.status === "DROPPED") continue;
      add(byMonth, l.closureMonth ?? "none", l);
    }
    const round = (n: number) => Math.round(n * 100) / 100;
    const out = (map: Map<string, Bucket>) => [...map.entries()].map(([key, b]) => ({ key, ...b, valueLac: round(b.valueLac) }));

    const open = rows.filter((l) => !CLOSED_STATUSES.includes(l.status as LeadStatusName));
    const converted = rows.filter((l) => l.status === "CONVERTED");
    const waiting = converted.filter((l) => (extra.get(l.id)?.poNumbers.length ?? 0) === 0);
    res.json({
      totals: {
        leads: rows.length,
        open: open.length,
        dropped: rows.filter((l) => l.status === "DROPPED").length,
        openValueLac: round(open.reduce((s, l) => s + value(l), 0)),
        convertedValueLac: round(converted.reduce((s, l) => s + value(l), 0)),
        waitingValueLac: round(waiting.reduce((s, l) => s + value(l), 0)),
        waitingForPo: waiting.length,
        noClosureMonth: open.filter((l) => !l.closureMonth).length,
      },
      byMonth: out(byMonth).sort((a, b) => (a.key === "none" ? 1 : b.key === "none" ? -1 : a.key.localeCompare(b.key))),
      bySource: out(bySource).sort((a, b) => b.leads - a.leads),
      funnel: {
        leads: rows.length,
        sample: rows.filter((l) => withSample.has(l.id)).length,
        approved: rows.filter((l) => extra.get(l.id)?.sampleApproved).length,
        converted: converted.length,
        poReceived: converted.length - waiting.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

const DEPARTMENT: Record<string, string> = { BD: "BD", PPIC: "PPIC", STORE: "Store", PURCHASE: "Purchase", ACCOUNTS: "Accounts", PRODUCTION: "Production", QA_QC: "QA", DISPATCH: "Dispatch", RND: "R&D", REGULATORY: "Regulatory", ADMIN: "Admin" };

/** BD / Admin: the people a lead can be handed to (every active user, with their department). */
leadsRouter.get("/assignees", bdOnly, async (_req: AuthedRequest, res, next) => {
  try {
    const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true, fullName: true, roles: { select: { role: { select: { name: true } } } } }, orderBy: { fullName: "asc" }, take: 1000 });
    res.json(
      users.map((u) => {
        const names = u.roles.map((r) => r.role.name as string);
        const first = names.find((n) => n !== "ADMIN") ?? names[0];
        return { id: u.id, name: u.fullName, department: first ? (DEPARTMENT[first] ?? first) : "" };
      }),
    );
  } catch (err) {
    next(err);
  }
});

async function nameOf(userId: string): Promise<string> {
  return (await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } }))?.fullName ?? "BD";
}

/** The person a lead is handed to must be an active user. */
async function assignee(id: string) {
  return prisma.user.findFirst({ where: { id, isActive: true }, select: { id: true, fullName: true } });
}

leadsRouter.post("/", bdOnly, validateBody(createSchema), async (req: AuthedRequest, res, next) => {
  try {
    const d = req.body as z.infer<typeof createSchema>;
    const status = d.status ?? "DISCUSSION";
    if (status === "CONVERTED") return res.status(400).json({ error: CONVERTED_MESSAGE });
    if (d.businessCardId) {
      const card = await prisma.businessCard.findFirst({ where: { id: d.businessCardId }, select: { id: true, status: true } });
      if (!card) return res.status(404).json({ error: "Visiting card not found" });
      if (card.status === "READING") return res.status(409).json({ error: "The card is still being read. Wait a few seconds." });
      if (await prisma.lead.findUnique({ where: { businessCardId: card.id }, select: { id: true } })) return res.status(409).json({ error: "This visiting card is already a lead." });
    }
    const owner = d.assignToId && d.assignToId !== req.user!.id ? await assignee(d.assignToId) : null;
    if (d.assignToId && d.assignToId !== req.user!.id && !owner) return res.status(400).json({ error: "Choose an active user to follow this lead up." });
    const lead = await prisma.lead.create({
      data: {
        brandName: d.brandName,
        contactPerson: d.contactPerson ?? "",
        designation: d.designation ?? "",
        phones: cleanPhones(d.phones ?? []),
        email: d.email ?? "",
        address: d.address ?? "",
        city: d.city ?? "",
        state: d.state ?? "",
        customerTypes: unique(d.customerTypes),
        productFormats: unique(d.productFormats),
        powderTypes: d.productFormats.includes("Powder") ? unique(d.powderTypes ?? []) : [],
        leadSource: d.leadSource ?? null,
        status,
        closureMonth: d.closureMonth ?? null,
        nextFollowUpAt: status === "DROPPED" ? null : (d.nextFollowUpAt ?? null),
        businessCardId: d.businessCardId ?? null,
        pocId: owner?.id ?? req.user!.id,
        createdById: req.user!.id,
      },
      include: listInclude,
    });
    // A scanned card that becomes a lead is saved at the same moment: its fields follow what BD checked on the review screen
    if (d.businessCardId) {
      await prisma.businessCard.update({
        where: { id: d.businessCardId },
        data: { status: "VERIFIED", verifiedAt: new Date(), name: lead.contactPerson, company: lead.brandName, designation: lead.designation, phones: lead.phones, email: lead.email, address: lead.address, categories: lead.productFormats },
      });
    }
    await recordAudit({ actorId: req.user!.id, action: "lead.created", entityType: "Lead", entityId: lead.id, metadata: owner ? { assignedTo: owner.id } : undefined });
    if (owner) await notifyUser(owner.id, { title: `Lead for you: ${lead.brandName}`, body: `${await nameOf(req.user!.id)} gave you this lead to follow up.`, link: `/leads/${lead.id}` }).catch((err) => req.log?.error({ err }, "notify failed: lead.assigned"));
    res.status(201).json(serialize(lead));
  } catch (err) {
    next(err);
  }
});

leadsRouter.get("/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, ...visible(req) },
      include: { ...listInclude, meetings: { orderBy: { number: "desc" }, include: { createdBy: { select: { fullName: true } } } }, reschedules: { orderBy: { createdAt: "desc" }, include: { by: { select: { fullName: true } } } } },
    });
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    const extra = (await enrich([{ ...lead, meetings: lead.meetings.slice(0, 1) }])).get(lead.id);
    res.json({
      ...serialize({ ...lead, meetings: lead.meetings.slice(0, 1) }, extra),
      meetings: lead.meetings.map(serializeMeeting),
      reschedules: lead.reschedules.map(serializeReschedule),
    });
  } catch (err) {
    next(err);
  }
});

leadsRouter.patch("/:id", validateBody(updateSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const d = req.body as z.infer<typeof updateSchema>;
    const lead = await prisma.lead.findFirst({ where: { id: req.params.id, ...visible(req) } });
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (d.pocId !== undefined && !isBd(req) && !isAdmin(req)) return res.status(403).json({ error: "Only BD can hand a lead to someone else." });
    const newOwner = d.pocId && d.pocId !== lead.pocId ? await assignee(d.pocId) : null;
    if (d.pocId && d.pocId !== lead.pocId && !newOwner) return res.status(400).json({ error: "Choose an active user to follow this lead up." });
    if (d.status === "CONVERTED" && lead.status !== "CONVERTED") return res.status(400).json({ error: CONVERTED_MESSAGE });
    const touchesEstimate = (d.estimatedQty !== undefined && d.estimatedQty !== null) || (d.estimatedValueLac !== undefined && d.estimatedValueLac !== null);
    if (touchesEstimate && !(await enrich([lead as LeadRow])).get(lead.id)!.sampleApproved) return res.status(409).json({ error: ESTIMATE_LOCKED_MESSAGE });

    const formats = d.productFormats ?? lead.productFormats;
    const powder = d.powderTypes ?? lead.powderTypes;
    if (formats.includes("Powder") && powder.length === 0) return res.status(400).json({ error: "Powder is selected: choose its powder type." });

    // Status: a lead that is over has no follow-up; one that comes back needs a new date.
    const status = d.status ?? lead.status;
    let nextFollowUpAt = d.nextFollowUpAt !== undefined ? d.nextFollowUpAt : lead.nextFollowUpAt;
    if (status === "DROPPED") nextFollowUpAt = null;
    else if (d.status && CLOSED_STATUSES.includes(lead.status as LeadStatusName) && !CLOSED_STATUSES.includes(status as LeadStatusName) && !d.nextFollowUpAt) {
      return res.status(400).json({ error: "Choose the next follow-up date and time for this lead." });
    }

    const updated = await prisma.lead.update({
      where: { id: lead.id },
      data: {
        ...(d.brandName !== undefined ? { brandName: d.brandName } : {}),
        ...(d.contactPerson !== undefined ? { contactPerson: d.contactPerson } : {}),
        ...(d.designation !== undefined ? { designation: d.designation } : {}),
        ...clean(d),
        ...(d.email !== undefined ? { email: d.email } : {}),
        ...(d.address !== undefined ? { address: d.address } : {}),
        ...(d.city !== undefined ? { city: d.city } : {}),
        ...(d.state !== undefined ? { state: d.state } : {}),
        ...(d.customerTypes ? { customerTypes: unique(d.customerTypes) } : {}),
        productFormats: unique(formats),
        powderTypes: formats.includes("Powder") ? unique(powder) : [],
        ...(d.leadSource !== undefined ? { leadSource: d.leadSource } : {}),
        ...(newOwner ? { pocId: newOwner.id } : {}),
        ...(d.closureMonth !== undefined ? { closureMonth: d.closureMonth } : {}),
        ...(d.estimatedQty !== undefined ? { estimatedQty: d.estimatedQty?.trim() || null } : {}),
        ...(d.estimatedValueLac !== undefined ? { estimatedValueLac: d.estimatedValueLac } : {}),
        status,
        ...(status !== lead.status ? { statusAt: new Date() } : {}),
        nextFollowUpAt,
      },
      include: listInclude,
    });
    await recordAudit({ actorId: req.user!.id, action: "lead.updated", entityType: "Lead", entityId: lead.id, metadata: status !== lead.status || newOwner ? { ...(status !== lead.status ? { status } : {}), ...(newOwner ? { assignedTo: newOwner.id } : {}) } : undefined });
    if (newOwner) await notifyUser(newOwner.id, { title: `Lead for you: ${updated.brandName}`, body: `${await nameOf(req.user!.id)} gave you this lead to follow up.`, link: `/leads/${lead.id}` }).catch((err) => req.log?.error({ err }, "notify failed: lead.assigned"));
    res.json(await withExtra(updated));
  } catch (err) {
    next(err);
  }
});

leadsRouter.post("/:id/meetings", validateBody(meetingSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const d = req.body as z.infer<typeof meetingSchema>;
    if (d.statusAfter === "CONVERTED") return res.status(400).json({ error: CONVERTED_MESSAGE });
    const lead = await prisma.lead.findFirst({ where: { id: req.params.id, ...visible(req) }, select: { id: true, status: true, estimatedQty: true, estimatedValueLac: true } });
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    // The estimated order size: not before a sample is approved, and mandatory after it (unless the lead is dropped)
    const approved = !!(await prisma.sampleRequest.findFirst({ where: { leadId: lead.id, feedback: "APPROVED" }, select: { id: true } }));
    const gaveEstimate = d.estimatedQty !== undefined || d.estimatedValueLac !== undefined;
    if (gaveEstimate && !approved) return res.status(409).json({ error: ESTIMATE_LOCKED_MESSAGE });
    if (approved && d.statusAfter !== "DROPPED" && !hasEstimate(d.estimatedQty ?? lead.estimatedQty, d.estimatedValueLac ?? lead.estimatedValueLac)) return res.status(400).json({ error: ESTIMATE_NEEDED_MESSAGE });
    if (d.nextFollowUpAt && d.nextFollowUpAt.getTime() < new Date(d.meetingDate.toDateString()).getTime()) {
      return res.status(400).json({ error: "The next follow-up cannot be before the meeting date." });
    }

    const meeting = await prisma.$transaction(async (tx) => {
      const count = await tx.leadMeeting.count({ where: { leadId: lead.id } });
      const created = await tx.leadMeeting.create({
        data: {
          leadId: lead.id,
          number: count + 1,
          meetingDate: d.meetingDate,
          mode: d.mode,
          notes: d.notes,
          statusAfter: d.statusAfter,
          nextFollowUpAt: d.statusAfter === "DROPPED" ? null : (d.nextFollowUpAt ?? null),
          closureMonth: d.closureMonth ?? null,
          createdById: req.user!.id,
        },
        include: { createdBy: { select: { fullName: true } } },
      });
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          status: d.statusAfter,
          ...(d.statusAfter !== lead.status ? { statusAt: new Date() } : {}),
          nextFollowUpAt: d.statusAfter === "DROPPED" ? null : (d.nextFollowUpAt ?? null),
          ...(d.closureMonth ? { closureMonth: d.closureMonth } : {}),
          ...(d.estimatedQty !== undefined ? { estimatedQty: d.estimatedQty.trim() || null } : {}),
          ...(d.estimatedValueLac !== undefined ? { estimatedValueLac: d.estimatedValueLac } : {}),
        },
      });
      return created;
    });
    await recordAudit({ actorId: req.user!.id, action: "lead.meeting_logged", entityType: "Lead", entityId: lead.id, metadata: { number: meeting.number, status: d.statusAfter } });
    res.status(201).json(serializeMeeting(meeting));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return res.status(409).json({ error: "Another meeting was saved at the same time. Open the lead again." });
    next(err);
  }
});

leadsRouter.post("/:id/reschedule", validateBody(rescheduleSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const d = req.body as z.infer<typeof rescheduleSchema>;
    const lead = await prisma.lead.findFirst({ where: { id: req.params.id, ...visible(req) }, select: { id: true, status: true, nextFollowUpAt: true } });
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (CLOSED_STATUSES.includes(lead.status as LeadStatusName)) return res.status(409).json({ error: "This lead is over: there is no follow-up to move." });
    await prisma.$transaction([
      prisma.leadReschedule.create({ data: { leadId: lead.id, fromAt: lead.nextFollowUpAt, toAt: d.toAt, reason: d.reason, byId: req.user!.id } }),
      prisma.lead.update({ where: { id: lead.id }, data: { nextFollowUpAt: d.toAt } }),
    ]);
    await recordAudit({ actorId: req.user!.id, action: "lead.rescheduled", entityType: "Lead", entityId: lead.id });
    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id }, include: listInclude });
    res.json(await withExtra(updated));
  } catch (err) {
    next(err);
  }
});

leadsRouter.post("/:id/convert", bdOnly, validateBody(convertSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const d = req.body as z.infer<typeof convertSchema>;
    const lead = await prisma.lead.findFirst({ where: { id: req.params.id, ...visible(req) }, include: listInclude });
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (lead.status === "CONVERTED") return res.status(409).json({ error: "This lead is already Converted." });
    if (!(await enrich([lead])).get(lead.id)!.sampleApproved) return res.status(409).json({ error: CONVERTED_MESSAGE });
    const qty = d.estimatedQty?.trim() || lead.estimatedQty;
    const value = d.estimatedValueLac ?? lead.estimatedValueLac;
    if (!hasEstimate(qty, value)) return res.status(400).json({ error: ESTIMATE_NEEDED_MESSAGE });
    const now = new Date();
    const updated = await prisma.lead.update({
      where: { id: lead.id },
      data: { status: "CONVERTED", statusAt: now, convertedAt: now, nextFollowUpAt: null, estimatedQty: qty, estimatedValueLac: value },
      include: listInclude,
    });
    await recordAudit({ actorId: req.user!.id, action: "lead.converted", entityType: "Lead", entityId: lead.id, metadata: { estimatedQty: qty, estimatedValueLac: value } });
    res.json(await withExtra(updated));
  } catch (err) {
    next(err);
  }
});

/** The product formats a visiting card's categories stand for (used by the screen to prefill a lead made from a card). */
leadsRouter.get("/options/lists", async (_req, res, next) => {
  try {
    // the names typed under "Others" on any lead join the lists, for everyone
    const used = await prisma.lead.findMany({ select: { customerTypes: true, productFormats: true, powderTypes: true }, take: 20000 });
    res.json({
      customerTypes: withTypedOptions(CUSTOMER_TYPES, used.flatMap((l) => l.customerTypes)),
      productFormats: withTypedOptions(PRODUCT_FORMATS, used.flatMap((l) => l.productFormats)),
      powderTypes: withTypedOptions(POWDER_TYPES, used.flatMap((l) => l.powderTypes)),
      leadSources: LEAD_SOURCES,
      statuses: LEAD_STATUSES,
      cardCategoryToFormat: CARD_CATEGORY_TO_FORMAT,
    });
  } catch (err) {
    next(err);
  }
});
