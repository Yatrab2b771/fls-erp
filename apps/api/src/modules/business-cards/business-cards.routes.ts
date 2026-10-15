import { Router, type NextFunction, type Request, type Response } from "express";
import multer, { MulterError } from "multer";
import { z } from "zod";
import type { BusinessCard, Prisma } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { deleteUploadedFile, detectFileType, resolveStoragePath, saveUploadedFile } from "../../common/lib/storage";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { CardPhotoError, readCard } from "./card-ocr";

// BD's visiting-card book: scan a card with the phone camera (OCR fills the fields), check them, save. Or type a card in by hand.
// A scan is saved at once as NEEDS_VERIFY, so an interrupted check is not lost; BD verifies it later from "Needs verify".

export const businessCardsRouter = Router();
businessCardsRouter.use(requireAuth, requireRole("BD"));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
function handleUploadErrors(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (err instanceof MulterError) return res.status(400).json({ error: err.message });
  next(err);
}

const isAdmin = (req: AuthedRequest) => req.user!.roles.includes("ADMIN" as never);
/** BD sees the cards they collected; Admin sees all of them. */
const visible = (req: AuthedRequest): Prisma.BusinessCardWhereInput => (isAdmin(req) ? {} : { createdById: req.user!.id });

const include = { createdBy: { select: { fullName: true } } } as const;
type Row = BusinessCard & { createdBy: { fullName: string } };

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
    createdByName: c.createdBy.fullName,
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

// ---------------------------------------------------------------------------------------------------------------------

businessCardsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await prisma.businessCard.findMany({ where: visible(req), include, orderBy: { createdAt: "desc" }, take: 3000 });
    res.json(rows.map(serialize));
  } catch (err) {
    next(err);
  }
});

/** Is this contact already in the book? (same email, or any phone number). Names only: it is a hint before saving. */
businessCardsRouter.get("/duplicates", async (req: AuthedRequest, res, next) => {
  try {
    const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
    const phones = (typeof req.query.phone === "string" ? req.query.phone.split(",") : []).map(last10).filter((p) => p.length === 10);
    const excludeId = typeof req.query.excludeId === "string" ? req.query.excludeId : undefined;
    if (!email && phones.length === 0) return res.json([]);
    // phones are stored formatted ("+91 98765 43210"), so they are compared here on their last 10 digits
    const others = await prisma.businessCard.findMany({
      where: { id: excludeId ? { not: excludeId } : undefined, status: "VERIFIED", OR: [...(email ? [{ email }] : []), { phones: { isEmpty: false } }] },
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

/** Photo in (multipart field "photo", optional "categories" as a JSON list): OCR runs, the card is saved as NEEDS_VERIFY and returned. */
businessCardsRouter.post("/scan", upload.single("photo"), handleUploadErrors, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded (expected multipart field "photo")' });
    const detected = detectFileType(req.file.buffer);
    if (!detected || ![".jpg", ".png", ".webp", ".bmp", ".gif"].includes(detected.ext)) return res.status(400).json({ error: "That file is not a photo (JPEG, PNG, WEBP)." });

    let categories: string[] = [];
    try {
      const raw: unknown = typeof req.body?.categories === "string" ? JSON.parse(req.body.categories) : [];
      categories = z.array(text(40).min(1)).max(10).parse(raw);
    } catch {
      return res.status(400).json({ error: "Categories were not understood." });
    }

    let reading;
    try {
      reading = await readCard(req.file.buffer, await knownCompanies());
    } catch (err) {
      if (err instanceof CardPhotoError) return res.status(400).json({ error: err.message });
      throw err;
    }

    const photoPath = saveUploadedFile(detected.ext, req.file.buffer);
    const card = await prisma.businessCard.create({
      data: {
        name: reading.name,
        designation: reading.designation,
        company: reading.company,
        phones: reading.phones,
        email: reading.email,
        website: reading.website,
        address: reading.address,
        gstNo: reading.gstNo,
        categories,
        status: "NEEDS_VERIFY",
        source: "SCAN",
        photoPath,
        photoMime: detected.mimeType,
        confidence: reading.confidence as unknown as Prisma.InputJsonValue,
        ocrLines: reading.lines.map((l) => l.text),
        createdById: req.user!.id,
      },
      include,
    });
    await recordAudit({ actorId: req.user!.id, action: "business_card.scanned", entityType: "BusinessCard", entityId: card.id, metadata: { company: card.company, name: card.name } });
    res.status(201).json(serialize(card));
  } catch (err) {
    next(err);
  }
});

/** A card typed in by hand: saved already verified. */
businessCardsRouter.post("/", validateBody(createSchema), async (req: AuthedRequest, res, next) => {
  try {
    const b = req.body as z.infer<typeof createSchema>;
    const card = await prisma.businessCard.create({
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
        status: "VERIFIED",
        source: "MANUAL",
        verifiedAt: new Date(),
        createdById: req.user!.id,
      },
      include,
    });
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

    const card = await prisma.businessCard.update({
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
        ...(b.verify && existing.status !== "VERIFIED" ? { status: "VERIFIED" as const, verifiedAt: new Date() } : {}),
      },
      include,
    });
    if (b.verify && existing.status !== "VERIFIED") await recordAudit({ actorId: req.user!.id, action: "business_card.verified", entityType: "BusinessCard", entityId: card.id });
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

/** Turn a verified card into a Customer (company, contact person, phone, email, address). If a customer of that name exists, link to it instead. */
businessCardsRouter.post("/:id/create-customer", async (req: AuthedRequest<{ id: string }>, res, next) => {
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
