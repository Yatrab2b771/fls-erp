import { Router, type NextFunction, type Request, type Response } from "express";
import multer, { MulterError } from "multer";
import { z } from "zod";
import type { BusinessCard, Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { deleteUploadedFile, detectFileType, resolveStoragePath, saveUploadedFile } from "../../common/lib/storage";
import { logger } from "../../common/lib/logger";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { CardPhotoError, checkCardPhoto, readCard } from "./card-ocr";

// The visiting-card book. Every department can collect cards (at an event, for instance): scan a card with the phone camera, or type one in by hand.
// A scan is saved at once as READING and the photo is read in the background (OCR fills the fields in a few seconds), so the next card can be
// scanned straight away; it then waits as NEEDS_VERIFY, so an interrupted check is not lost. The collector verifies it later from "Needs verify".
// A card with the same email or phone as an earlier one is flagged "possible duplicate", never blocked.
// Each person sees the cards they collected; BD and Admin see everyone's, follow them up (customer, lead) and sort out the duplicates.

export const businessCardsRouter = Router();
businessCardsRouter.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
function handleUploadErrors(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (err instanceof MulterError) return res.status(400).json({ error: err.message });
  next(err);
}

const isAdmin = (req: AuthedRequest) => req.user!.roles.includes("ADMIN" as never);
const isBd = (req: AuthedRequest) => req.user!.roles.includes("BD" as never);
/** Everyone sees the cards they collected; BD and Admin see all of them. */
const visible = (req: AuthedRequest): Prisma.BusinessCardWhereInput => (isAdmin(req) || isBd(req) ? {} : { createdById: req.user!.id });

const DEPARTMENT: Record<string, string> = { BD: "BD", PPIC: "PPIC", STORE: "Store", PURCHASE: "Purchase", ACCOUNTS: "Accounts", PRODUCTION: "Production", QA_QC: "QA", DISPATCH: "Dispatch", RND: "R&D", REGULATORY: "Regulatory", ADMIN: "Admin" };

const include = {
  createdBy: { select: { id: true, fullName: true, roles: { select: { role: { select: { name: true } } } } } },
  duplicateOf: { select: { id: true, name: true, company: true, createdBy: { select: { fullName: true } } } },
} as const;
type Row = BusinessCard & { createdBy: { id: string; fullName: string; roles: { role: { name: string } }[] }; duplicateOf: { id: string; name: string; company: string; createdBy: { fullName: string } } | null };

function departmentOf(roles: { role: { name: string } }[]): string {
  const names = roles.map((r) => r.role.name);
  const first = names.find((n) => n !== "ADMIN") ?? names[0];
  return first ? (DEPARTMENT[first] ?? first) : "";
}

function serialize(c: Row) {
  return {
    id: c.id,
    name: c.name,
    designation: c.designation,
    company: c.company,
    phones: c.phones,
    email: c.email,
    website: c.website,
    address: c.address,
    gstNo: c.gstNo,
    categories: c.categories,
    notes: c.notes,
    status: c.status,
    source: c.source,
    hasPhoto: !!c.photoPath,
    confidence: (c.confidence ?? null) as Record<string, number> | null,
    ocrLines: (c.ocrLines ?? null) as string[] | null,
    customerId: c.customerId,
    event: c.event,
    readError: c.readError,
    duplicateOf: c.duplicateOf ? { id: c.duplicateOf.id, name: c.duplicateOf.name, company: c.duplicateOf.company, addedBy: c.duplicateOf.createdBy.fullName } : null,
    createdByName: c.createdBy.fullName,
    collectedBy: { id: c.createdBy.id, name: c.createdBy.fullName, department: departmentOf(c.createdBy.roles) },
    verifiedAt: c.verifiedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

const text = (max: number) => z.string().trim().max(max);
const fieldsSchema = z.object({
  name: text(120).optional(),
  designation: text(160).optional(),
  company: text(200).optional(),
  phones: z.array(text(30).min(1)).max(6).optional(),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().email().max(200)]).optional(),
  website: text(200).optional(),
  address: text(500).optional(),
  gstNo: text(20).optional(),
  categories: z.array(text(40).min(1)).max(10).optional(),
  notes: text(1000).optional(),
  event: text(80).optional(),
});

const createSchema = fieldsSchema.refine((d) => !!(d.name || d.company), { message: "Enter at least a name or a company." }).refine((d) => (d.categories?.length ?? 0) > 0, { message: "Choose at least one category." });
const updateSchema = fieldsSchema.extend({ verify: z.boolean().optional() });

const cleanPhones = (phones: string[] | undefined) => [...new Set((phones ?? []).map((p) => p.trim()).filter(Boolean))];

/** Company names we already know (customers, vendors, earlier cards): the OCR uses them to spell a company the way we do. */
async function knownCompanies(): Promise<string[]> {
  const [customers, vendors, cards] = await Promise.all([
    prisma.customer.findMany({ select: { companyName: true }, take: 5000 }),
    prisma.vendor.findMany({ select: { name: true }, take: 5000 }),
    prisma.businessCard.findMany({ where: { status: "VERIFIED", company: { not: "" } }, select: { company: true }, distinct: ["company"], take: 5000 }),
  ]);
  return [...new Set([...customers.map((c) => c.companyName), ...vendors.map((v) => v.name), ...cards.map((c) => c.company)])];
}

const last10 = (p: string) => p.replace(/\D/g, "").slice(-10);

/**
 * The earlier card this contact may already be: the oldest card (any status, anyone's) with the same email or any of the same phone numbers
 * (compared on their last 10 digits, since phones are stored formatted). Only EARLIER cards count, so of two copies only the later one is flagged.
 */
async function findEarlierCard(card: { id: string; email: string; phones: string[]; createdAt: Date }): Promise<string | null> {
  const email = card.email.trim().toLowerCase();
  const phones = card.phones.map(last10).filter((p) => p.length === 10);
  if (!email && phones.length === 0) return null;
  const others = await prisma.businessCard.findMany({
    where: { id: { not: card.id }, status: { not: "READING" }, createdAt: { lt: card.createdAt }, OR: [...(email ? [{ email }] : []), { phones: { isEmpty: false } }] },
    select: { id: true, email: true, phones: true },
    orderBy: { createdAt: "asc" },
    take: 5000,
  });
  const hit = others.find((c) => (email && c.email === email) || c.phones.some((p) => phones.includes(last10(p))));
  return hit?.id ?? null;
}

// --- Reading scans in the background, one photo at a time (OCR is heavy; a queue keeps a rush of scans from swamping the server) ---------------------
let queue: Promise<void> = Promise.resolve();
let pendingReadings = 0;

function enqueueReading(cardId: string, photo: Buffer) {
  pendingReadings += 1;
  queue = queue.then(() => readInBackground(cardId, photo)).finally(() => (pendingReadings -= 1));
}

async function readInBackground(cardId: string, photo: Buffer) {
  try {
    const reading = await readCard(photo, await knownCompanies());
    const existing = await prisma.businessCard.findUnique({ where: { id: cardId }, select: { createdAt: true } });
    if (!existing) return; // deleted while it was being read
    const duplicateOfId = await findEarlierCard({ id: cardId, email: reading.email, phones: reading.phones, createdAt: existing.createdAt });
    await prisma.businessCard.update({
      where: { id: cardId },
      data: {
        name: reading.name,
        designation: reading.designation,
        company: reading.company,
        phones: reading.phones,
        email: reading.email,
        website: reading.website,
        address: reading.address,
        gstNo: reading.gstNo,
        status: "NEEDS_VERIFY",
        confidence: reading.confidence as unknown as Prisma.InputJsonValue,
        ocrLines: reading.lines.map((l) => l.text),
        duplicateOfId,
      },
    });
  } catch (err) {
    logger.error({ err, cardId }, "visiting card could not be read");
    const message = err instanceof CardPhotoError ? err.message : "The photo could not be read. Type the details in, or scan the card again.";
    await prisma.businessCard.update({ where: { id: cardId }, data: { status: "NEEDS_VERIFY", readError: message } }).catch(() => undefined);
  }
}

/** A card still READING when nothing is being read is an orphan (the server restarted while it was queued): let its collector type it in. */
async function releaseOrphanedReadings() {
  if (pendingReadings > 0) return;
  await prisma.businessCard.updateMany({ where: { status: "READING" }, data: { status: "NEEDS_VERIFY", readError: "Reading was interrupted. Type the details in, or scan the card again." } });
}

// ---------------------------------------------------------------------------------------------------------------------

businessCardsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    await releaseOrphanedReadings();
    const rows = await prisma.businessCard.findMany({ where: visible(req), include, orderBy: { createdAt: "desc" }, take: 3000 });
    res.json(rows.map(serialize));
  } catch (err) {
    next(err);
  }
});

/** The events cards were collected at (names only), for the picker. */
businessCardsRouter.get("/events", async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await prisma.businessCard.findMany({ where: { event: { not: "" } }, distinct: ["event"], select: { event: true }, orderBy: { event: "asc" }, take: 200 });
    res.json(rows.map((r) => r.event));
  } catch (err) {
    next(err);
  }
});

/** Is this contact already in the book? (same email, or any phone number; any card, anyone's). Names only: it is a hint before saving. */
businessCardsRouter.get("/duplicates", async (req: AuthedRequest, res, next) => {
  try {
    const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
    const phones = (typeof req.query.phone === "string" ? req.query.phone.split(",") : []).map(last10).filter((p) => p.length === 10);
    const excludeId = typeof req.query.excludeId === "string" ? req.query.excludeId : undefined;
    if (!email && phones.length === 0) return res.json([]);
    // phones are stored formatted ("+91 98765 43210"), so they are compared here on their last 10 digits
    const others = await prisma.businessCard.findMany({
      where: { id: excludeId ? { not: excludeId } : undefined, status: { not: "READING" }, OR: [...(email ? [{ email }] : []), { phones: { isEmpty: false } }] },
      select: { id: true, name: true, company: true, email: true, phones: true, createdBy: { select: { fullName: true } } },
      take: 5000,
    });
    const hits = new Map<string, (typeof others)[number]>();
    for (const c of others) if ((email && c.email === email) || c.phones.some((p) => phones.includes(last10(p)))) hits.set(c.id, c);
    res.json([...hits.values()].map((c) => ({ id: c.id, name: c.name, company: c.company, addedBy: c.createdBy.fullName })));
  } catch (err) {
    next(err);
  }
});

businessCardsRouter.get("/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const card = await prisma.businessCard.findFirst({ where: { id: req.params.id, ...visible(req) }, include });
    if (!card) return res.status(404).json({ error: "Card not found" });
    res.json(serialize(card));
  } catch (err) {
    next(err);
  }
});

businessCardsRouter.get("/:id/photo", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const card = await prisma.businessCard.findFirst({ where: { id: req.params.id, ...visible(req) }, select: { photoPath: true, photoMime: true } });
    if (!card?.photoPath) return res.status(404).json({ error: "No photo" });
    res.setHeader("Content-Type", card.photoMime ?? "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(resolveStoragePath(card.photoPath));
  } catch (err) {
    next(err);
  }
});

/**
 * Photo in (multipart field "photo", optional "categories" as a JSON list and "event"): the photo is checked and saved, the card is returned at once as
 * READING, and its fields fill in when the OCR (which runs in the background) is done.
 */
businessCardsRouter.post("/scan", upload.single("photo"), handleUploadErrors, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded (expected multipart field "photo")' });
    const detected = detectFileType(req.file.buffer);
    if (!detected || ![".jpg", ".png", ".webp", ".bmp", ".gif"].includes(detected.ext)) return res.status(400).json({ error: "That file is not a photo (JPEG, PNG, WEBP)." });

    let categories: string[] = [];
    let event = "";
    try {
      const raw: unknown = typeof req.body?.categories === "string" ? JSON.parse(req.body.categories) : [];
      categories = z.array(text(40).min(1)).max(10).parse(raw);
      event = text(80).parse(typeof req.body?.event === "string" ? req.body.event : "");
    } catch {
      return res.status(400).json({ error: "Categories or the event name were not understood." });
    }

    try {
      await checkCardPhoto(req.file.buffer);
    } catch (err) {
      if (err instanceof CardPhotoError) return res.status(400).json({ error: err.message });
      throw err;
    }

    const photoPath = saveUploadedFile(detected.ext, req.file.buffer);
    const card = await prisma.businessCard.create({
      data: { categories, event, status: "READING", source: "SCAN", photoPath, photoMime: detected.mimeType, createdById: req.user!.id },
      include,
    });
    await recordAudit({ actorId: req.user!.id, action: "business_card.scanned", entityType: "BusinessCard", entityId: card.id, metadata: { event: event || undefined } });
    enqueueReading(card.id, req.file.buffer);
    res.status(201).json(serialize(card));
  } catch (err) {
    next(err);
  }
});

/** A card typed in by hand: saved already verified. */
businessCardsRouter.post("/", validateBody(createSchema), async (req: AuthedRequest, res, next) => {
  try {
    const b = req.body as z.infer<typeof createSchema>;
    const created = await prisma.businessCard.create({
      data: {
        name: b.name ?? "",
        designation: b.designation ?? "",
        company: b.company ?? "",
        phones: cleanPhones(b.phones),
        email: b.email ?? "",
        website: b.website ?? "",
        address: b.address ?? "",
        gstNo: (b.gstNo ?? "").toUpperCase(),
        categories: b.categories ?? [],
        notes: b.notes ?? "",
        event: b.event ?? "",
        status: "VERIFIED",
        source: "MANUAL",
        verifiedAt: new Date(),
        createdById: req.user!.id,
      },
    });
    const duplicateOfId = await findEarlierCard(created);
    const card = await prisma.businessCard.update({ where: { id: created.id }, data: { duplicateOfId }, include });
    await recordAudit({ actorId: req.user!.id, action: "business_card.created", entityType: "BusinessCard", entityId: card.id });
    res.status(201).json(serialize(card));
  } catch (err) {
    next(err);
  }
});

businessCardsRouter.patch("/:id", validateBody(updateSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.businessCard.findFirst({ where: { id: req.params.id, ...visible(req) } });
    if (!existing) return res.status(404).json({ error: "Card not found" });
    if (existing.status === "READING") return res.status(409).json({ error: "The photo is still being read. Wait a few seconds." });
    const b = req.body as z.infer<typeof updateSchema>;

    const next_ = {
      name: b.name ?? existing.name,
      company: b.company ?? existing.company,
      categories: b.categories ?? existing.categories,
    };
    if (b.verify) {
      if (!next_.name && !next_.company) return res.status(400).json({ error: "Enter at least a name or a company." });
      if (next_.categories.length === 0) return res.status(400).json({ error: "Choose at least one category." });
    }

    const updated = await prisma.businessCard.update({
      where: { id: existing.id },
      data: {
        name: b.name,
        designation: b.designation,
        company: b.company,
        phones: b.phones ? cleanPhones(b.phones) : undefined,
        email: b.email,
        website: b.website,
        address: b.address,
        gstNo: b.gstNo?.toUpperCase(),
        categories: b.categories,
        notes: b.notes,
        event: b.event,
        ...(b.verify && existing.status !== "VERIFIED" ? { status: "VERIFIED" as const, verifiedAt: new Date() } : {}),
      },
    });
    // The contact details may have changed: look again for the earlier card it duplicates
    const duplicateOfId = await findEarlierCard(updated);
    const card = await prisma.businessCard.update({ where: { id: updated.id }, data: { duplicateOfId }, include });
    if (b.verify && existing.status !== "VERIFIED") await recordAudit({ actorId: req.user!.id, action: "business_card.verified", entityType: "BusinessCard", entityId: card.id });
    res.json(serialize(card));
  } catch (err) {
    next(err);
  }
});

/** BD / Admin: "these are two different people": take the duplicate flag off the card. */
businessCardsRouter.post("/:id/clear-duplicate", requireRole("BD"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.businessCard.findFirst({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) return res.status(404).json({ error: "Card not found" });
    const card = await prisma.businessCard.update({ where: { id: existing.id }, data: { duplicateOfId: null }, include });
    res.json(serialize(card));
  } catch (err) {
    next(err);
  }
});

businessCardsRouter.delete("/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.businessCard.findFirst({ where: { id: req.params.id, ...visible(req) }, select: { id: true, photoPath: true, company: true, name: true } });
    if (!existing) return res.status(404).json({ error: "Card not found" });
    await prisma.businessCard.delete({ where: { id: existing.id } });
    if (existing.photoPath) deleteUploadedFile(existing.photoPath);
    await recordAudit({ actorId: req.user!.id, action: "business_card.deleted", entityType: "BusinessCard", entityId: existing.id, metadata: { company: existing.company, name: existing.name } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/** BD / Admin: the customer behind a verified card. */
businessCardsRouter.post("/:id/create-customer", requireRole("BD"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const card = await prisma.businessCard.findFirst({ where: { id: req.params.id, ...visible(req) } });
    if (!card) return res.status(404).json({ error: "Card not found" });
    if (card.status !== "VERIFIED") return res.status(400).json({ error: "Verify the card first." });
    if (!card.company.trim()) return res.status(400).json({ error: "The card has no company name, so there is no customer to create." });

    const existing = await prisma.customer.findFirst({ where: { companyName: { equals: card.company.trim(), mode: "insensitive" } }, select: { id: true, companyName: true } });
    const customer =
      existing ??
      (await prisma.customer.create({
        data: {
          companyName: card.company.trim(),
          contactPerson: card.name || null,
          contactNo: card.phones[0] ?? null,
          email: card.email || null,
          gstNo: card.gstNo || null,
          deliveryAddress: card.address || null,
          createdById: req.user!.id,
        },
        select: { id: true, companyName: true },
      }));
    await prisma.businessCard.update({ where: { id: card.id }, data: { customerId: customer.id } });
    if (!existing) await recordAudit({ actorId: req.user!.id, action: "customer.created", entityType: "Customer", entityId: customer.id, metadata: { fromBusinessCard: card.id } });
    res.status(existing ? 200 : 201).json({ customerId: customer.id, companyName: customer.companyName, existed: !!existing });
  } catch (err) {
    next(err);
  }
});
