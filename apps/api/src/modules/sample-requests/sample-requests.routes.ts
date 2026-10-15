import { Router } from "express";
import { z } from "zod";
import { Prisma, type SampleFeedback, type SampleRequestStatus, type SampleTemplate } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { logger } from "../../common/lib/logger";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { CLOSED_STATUSES, type LeadStatusName } from "../leads/lead-options";

/**
 * A sample a customer asked for. One record, two tiles (BD and R&D), laid out like the Sample Request Sheet:
 *   yellow (Sales / BD)  composition, Customer TAT (neededBy), dosage form, quantity, remarks, reference sample, the client's feedback
 *   blue   (R&D)         sample code, prepared by, expected date (ETA), date prepared, R&D remarks, and the status
 *   pink   (RA)          export / domestic and the label claim (Gummies only), filled by Regulatory
 * BD raises it (from a lead, or for a customer), R&D picks it up, gives an ETA, makes it and hands it over, BD enters the feedback. A Change
 * requested starts another round: the finished round is kept, and the blue part starts again.
 *
 *   GET   /                  the requests (BD sees its own, R&D / PPIC / Regulatory / Admin see all)
 *   GET   /rnd-team          who can be picked as "prepared by"
 *   GET   /:id               one request with its rounds and the raw material R&D asked for it
 *   POST  /                  BD: raise a request
 *   PATCH /:id/sales         BD: change the yellow part (until it is handed over)
 *   PATCH /:id/rnd           R&D: the blue part (an ETA moves a New request to Planning)
 *   POST  /:id/status        R&D: START, READY, DISPATCH, HOLD, CANNOT_MAKE
 *   PATCH /:id/ra            Regulatory: the pink part
 *   POST  /:id/feedback      BD: Approved / Change requested / Rejected
 *   POST  /:id/bom-uploaded  R&D: marks the BOM as uploaded once the customer approved the sample (BD is told)
 */
export const sampleRequestsRouter = Router();
sampleRequestsRouter.use(requireAuth);

const READERS = ["RND", "BD", "PPIC", "REGULATORY"] as const;
const hasRole = (req: AuthedRequest, ...roles: string[]) => req.user!.roles.some((r) => roles.includes(r as string));
const seesAll = (req: AuthedRequest) => hasRole(req, "ADMIN", "RND", "PPIC", "REGULATORY");
const visible = (req: AuthedRequest): Prisma.SampleRequestWhereInput => (seesAll(req) ? {} : { requestedById: req.user!.id });
const isOwnerOrAdmin = (req: AuthedRequest, requestedById: string) => hasRole(req, "ADMIN") || requestedById === req.user!.id;

const include = { customer: { select: { id: true, companyName: true } }, requestedBy: { select: { fullName: true } }, lead: { select: { id: true, brandName: true } } } satisfies Prisma.SampleRequestInclude;
type Row = Prisma.SampleRequestGetPayload<{ include: typeof include }>;

const iso = (d: Date | null) => d?.toISOString() ?? null;

function serialize(r: Row) {
  return {
    id: r.id,
    requestNo: r.requestNo,
    template: r.template,
    status: r.status,
    statusAt: r.statusAt.toISOString(),
    round: r.round,
    customerId: r.customerId,
    customerName: r.customer.companyName,
    leadId: r.leadId,
    leadBrand: r.lead?.brandName ?? null,
    pocName: r.requestedBy.fullName,
    requestedByName: r.requestedBy.fullName,
    createdAt: r.createdAt.toISOString(),
    // yellow
    productName: r.productName,
    composition: r.composition ?? r.productName,
    neededBy: iso(r.neededBy),
    dosageForm: r.dosageForm,
    quantity: r.quantity,
    remarks: r.remarks,
    referenceSample: r.referenceSample,
    clientFeedback: r.clientFeedback,
    feedback: r.feedback,
    internalRemark: r.internalRemark,
    // blue
    sampleCode: r.sampleCode,
    preparedByName: r.preparedByName,
    expectedDate: iso(r.expectedDate),
    preparedOn: iso(r.preparedOn),
    rdRemarks: r.rdRemarks,
    readyAt: iso(r.readyAt),
    dispatchedAt: iso(r.dispatchedAt),
    // pink
    exportDomestic: r.exportDomestic,
    labelClaim: r.labelClaim,
    bomUploadedAt: iso(r.bomUploadedAt),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------------------------------------------------

const text = (max: number) => z.string().trim().max(max);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-25");
const TEMPLATES = ["POWDER", "GUMMIES", "BARS"] as const;

const createSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    template: z.enum(TEMPLATES),
    composition: text(6000).min(1, "Write the composition the customer wants."),
    neededBy: day,
    dosageForm: text(120).optional(),
    quantity: text(120).optional(),
    remarks: text(2000).optional(),
    referenceSample: text(1000).optional(),
  })
  .refine((d) => !!d.leadId || !!d.customerId, { message: "Choose the lead or the customer this sample is for.", path: ["leadId"] });

const salesSchema = z
  .object({
    composition: text(6000).min(1, "Write the composition the customer wants."),
    neededBy: day,
    dosageForm: text(120).nullable(),
    quantity: text(120).nullable(),
    remarks: text(2000).nullable(),
    referenceSample: text(1000).nullable(),
  })
  .partial();

const rndSchema = z
  .object({
    sampleCode: text(300).nullable(),
    preparedByName: text(120).nullable(),
    expectedDate: day.nullable(),
    preparedOn: day.nullable(),
    rdRemarks: text(2000).nullable(),
  })
  .partial();

const statusSchema = z.object({ action: z.enum(["START", "READY", "DISPATCH", "HOLD", "CANNOT_MAKE"]), reason: text(1000).optional() });
const raSchema = z.object({ exportDomestic: z.enum(["Export", "Domestic"]).nullable().optional(), labelClaim: text(2000).nullable().optional() });
const feedbackSchema = z.object({
  feedback: z.enum(["APPROVED", "CHANGE_REQUESTED", "REJECTED"]),
  customerRemark: text(2000).min(1, "Write what the customer said."),
  internalRemark: text(2000).optional(),
});

const asDate = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00.000Z`) : null);
const titleOf = (composition: string) => composition.split("\n")[0]!.trim().slice(0, 120) || "Sample";
const no = (n: number) => `SR-${String(n).padStart(4, "0")}`;

const notifyFail = (what: string) => (err: unknown) => logger.error({ err }, `notify failed: ${what}`);

async function load(req: AuthedRequest<{ id: string }>) {
  return prisma.sampleRequest.findFirst({ where: { id: req.params.id, ...visible(req) }, include });
}

// ---------------------------------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------------------------------

sampleRequestsRouter.get("/", requireRole(...READERS), async (req: AuthedRequest, res, next) => {
  try {
    const rows = await prisma.sampleRequest.findMany({ where: visible(req), include, orderBy: { requestNo: "desc" }, take: 5000 });
    res.json(rows.map(serialize));
  } catch (err) {
    next(err);
  }
});

sampleRequestsRouter.get("/rnd-team", requireRole(...READERS), async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({ where: { isActive: true, roles: { some: { role: { name: "RND" } } } }, select: { id: true, fullName: true }, orderBy: { fullName: "asc" } });
    res.json(users);
  } catch (err) {
    next(err);
  }
});

sampleRequestsRouter.get("/:id", requireRole(...READERS), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const row = await prisma.sampleRequest.findFirst({
      where: { id: req.params.id, ...visible(req) },
      include: { ...include, rounds: { orderBy: { round: "desc" } }, rmRequests: { orderBy: { requestedAt: "desc" }, include: { item: { select: { name: true } } } } },
    });
    if (!row) return res.status(404).json({ error: "Sample request not found" });
    res.json({
      ...serialize(row),
      rounds: row.rounds.map((r) => ({
        id: r.id,
        round: r.round,
        sampleCode: r.sampleCode,
        preparedByName: r.preparedByName,
        expectedDate: iso(r.expectedDate),
        preparedOn: iso(r.preparedOn),
        rdRemarks: r.rdRemarks,
        readyAt: iso(r.readyAt),
        dispatchedAt: iso(r.dispatchedAt),
        feedback: r.feedback,
        customerRemark: r.customerRemark,
        internalRemark: r.internalRemark,
        createdAt: r.createdAt.toISOString(),
      })),
      rmRequests: row.rmRequests.map((m) => ({ id: m.id, itemName: m.item.name, quantity: m.quantity, unit: m.unit, status: m.status, requestedAt: m.requestedAt.toISOString() })),
    });
  } catch (err) {
    next(err);
  }
});

/** The customer for a lead: the one already made for it, one with the same name, or a new one made from the lead's details. */
async function customerForLead(leadId: string, actorId: string, canSeeAll: boolean) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, ...(canSeeAll ? {} : { pocId: actorId }) } });
  if (!lead) return { error: { status: 404, message: "Lead not found" } } as const;
  if (CLOSED_STATUSES.includes(lead.status as LeadStatusName)) return { error: { status: 409, message: "This lead is over (dropped or converted): no new sample can be asked for it." } } as const;
  if (lead.customerId) return { lead, customerId: lead.customerId } as const;
  const same = await prisma.customer.findFirst({ where: { companyName: { equals: lead.brandName, mode: "insensitive" } }, select: { id: true } });
  const customerId =
    same?.id ??
    (
      await prisma.customer.create({
        data: { companyName: lead.brandName, contactPerson: lead.contactPerson || null, contactNo: lead.phones[0] ?? null, email: lead.email || null, deliveryAddress: lead.address || null, createdById: actorId },
        select: { id: true },
      })
    ).id;
  await prisma.lead.update({ where: { id: lead.id }, data: { customerId } });
  return { lead, customerId } as const;
}

sampleRequestsRouter.post("/", requireRole("BD"), validateBody(createSchema), async (req: AuthedRequest, res, next) => {
  try {
    const b = req.body as z.infer<typeof createSchema>;
    let customerId = b.customerId;
    let leadId: string | null = null;
    if (b.leadId) {
      const found = await customerForLead(b.leadId, req.user!.id, hasRole(req, "ADMIN"));
      if ("error" in found && found.error) return res.status(found.error.status).json({ error: found.error.message });
      customerId = found.customerId;
      leadId = b.leadId;
    } else if (!(await prisma.customer.findUnique({ where: { id: customerId! }, select: { id: true } }))) {
      return res.status(400).json({ error: "Unknown customer" });
    }
    const row = await prisma.sampleRequest.create({
      data: {
        customerId: customerId!,
        leadId,
        template: b.template as SampleTemplate,
        productName: titleOf(b.composition),
        composition: b.composition,
        neededBy: asDate(b.neededBy),
        dosageForm: b.dosageForm || null,
        quantity: b.quantity || null,
        remarks: b.remarks || null,
        referenceSample: b.template === "POWDER" ? null : b.referenceSample || null,
        requestedById: req.user!.id,
      },
      include,
    });
    await recordAudit({ actorId: req.user!.id, action: "sample_request.created", entityType: "SampleRequest", entityId: row.id, metadata: { requestNo: row.requestNo, customerId, leadId } });
    await notifyRoles(["RND"], { title: `${no(row.requestNo)}: new sample request from ${row.customer.companyName}`, body: `${row.template.toLowerCase()} · needed by ${b.neededBy}`, link: `/sample-requests/${row.id}` }, req.user!.id).catch(notifyFail("sample_request.created"));
    res.status(201).json(serialize(row));
  } catch (err) {
    next(err);
  }
});

sampleRequestsRouter.patch("/:id/sales", requireRole("BD"), validateBody(salesSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const b = req.body as z.infer<typeof salesSchema>;
    const existing = await load(req);
    if (!existing) return res.status(404).json({ error: "Sample request not found" });
    if (!isOwnerOrAdmin(req, existing.requestedById)) return res.status(403).json({ error: "Only the salesman who raised this request can change it." });
    if (existing.status === "DISPATCHED" || existing.status === "CANNOT_MAKE") return res.status(409).json({ error: "This request is already handed over or closed: it cannot be changed." });
    const row = await prisma.sampleRequest.update({
      where: { id: existing.id },
      data: {
        ...(b.composition !== undefined ? { composition: b.composition, productName: titleOf(b.composition) } : {}),
        ...(b.neededBy !== undefined ? { neededBy: asDate(b.neededBy) } : {}),
        ...(b.dosageForm !== undefined ? { dosageForm: b.dosageForm || null } : {}),
        ...(b.quantity !== undefined ? { quantity: b.quantity || null } : {}),
        ...(b.remarks !== undefined ? { remarks: b.remarks || null } : {}),
        ...(b.referenceSample !== undefined && existing.template !== "POWDER" ? { referenceSample: b.referenceSample || null } : {}),
      },
      include,
    });
    await recordAudit({ actorId: req.user!.id, action: "sample_request.sales_updated", entityType: "SampleRequest", entityId: row.id, metadata: { requestNo: row.requestNo } });
    await notifyRoles(["RND"], { title: `${no(row.requestNo)}: Sales changed the request`, body: row.customer.companyName, link: `/sample-requests/${row.id}` }, req.user!.id).catch(notifyFail("sample_request.sales_updated"));
    res.json(serialize(row));
  } catch (err) {
    next(err);
  }
});

sampleRequestsRouter.patch("/:id/rnd", requireRole("RND"), validateBody(rndSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const b = req.body as z.infer<typeof rndSchema>;
    const existing = await load(req);
    if (!existing) return res.status(404).json({ error: "Sample request not found" });
    if (existing.status === "CANNOT_MAKE") return res.status(409).json({ error: "This request is closed: R&D said it cannot be made." });
    const gaveEta = b.expectedDate !== undefined && b.expectedDate !== null && !existing.expectedDate;
    const toPlanning = gaveEta && existing.status === "REQUESTED";
    const row = await prisma.sampleRequest.update({
      where: { id: existing.id },
      data: {
        ...(b.sampleCode !== undefined ? { sampleCode: b.sampleCode || null } : {}),
        ...(b.preparedByName !== undefined ? { preparedByName: b.preparedByName || null } : {}),
        ...(b.expectedDate !== undefined ? { expectedDate: asDate(b.expectedDate) } : {}),
        ...(b.preparedOn !== undefined ? { preparedOn: asDate(b.preparedOn) } : {}),
        ...(b.rdRemarks !== undefined ? { rdRemarks: b.rdRemarks || null } : {}),
        ...(toPlanning ? { status: "PLANNING" as SampleRequestStatus, statusAt: new Date() } : {}),
      },
      include,
    });
    await recordAudit({ actorId: req.user!.id, action: "sample_request.rnd_updated", entityType: "SampleRequest", entityId: row.id, metadata: { requestNo: row.requestNo, ...(toPlanning ? { status: "PLANNING" } : {}) } });
    if (gaveEta) {
      await notifyUser(existing.requestedById, { title: `${no(row.requestNo)}: R&D gave an ETA for ${row.customer.companyName}`, body: `Expected on ${b.expectedDate}. You can tell the customer.`, link: `/sample-requests/${row.id}` }).catch(notifyFail("sample_request.eta"));
    }
    res.json(serialize(row));
  } catch (err) {
    next(err);
  }
});

sampleRequestsRouter.post("/:id/status", requireRole("RND"), validateBody(statusSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const { action, reason } = req.body as z.infer<typeof statusSchema>;
    const existing = await load(req);
    if (!existing) return res.status(404).json({ error: "Sample request not found" });
    const from = existing.status;
    const bad = (message: string) => res.status(409).json({ error: message });
    const now = new Date();
    let data: Prisma.SampleRequestUpdateInput;
    let tellBd: { title: string; body?: string } | null = null;
    const label = `${no(existing.requestNo)}: ${existing.customer.companyName}`;

    if (action === "START") {
      if (!["REQUESTED", "PLANNING", "ON_HOLD"].includes(from)) return bad(`A request that is ${from.toLowerCase().replace("_", " ")} cannot be started.`);
      data = { status: "IN_PROCESS", statusAt: now };
    } else if (action === "READY") {
      if (!["PLANNING", "IN_PROCESS"].includes(from)) return bad("Only a request that is being made can be marked Ready.");
      if (!existing.sampleCode?.trim()) return bad("Enter the sample code before marking it Ready.");
      data = { status: "READY", statusAt: now, readyAt: now, ...(existing.preparedOn ? {} : { preparedOn: new Date(now.toISOString().slice(0, 10) + "T00:00:00.000Z") }) };
      tellBd = { title: `${label}: sample is Ready`, body: `Code ${existing.sampleCode}. R&D will hand it over.` };
    } else if (action === "DISPATCH") {
      if (from !== "READY") return bad("Only a Ready sample can be handed over.");
      data = { status: "DISPATCHED", statusAt: now, dispatchedAt: now };
      tellBd = { title: `${label}: sample handed over`, body: "Enter the client's feedback when you have it." };
    } else if (action === "HOLD") {
      if (!reason?.trim()) return res.status(400).json({ error: "Write why the sample is on hold." });
      if (["READY", "DISPATCHED", "CANNOT_MAKE", "ON_HOLD"].includes(from)) return bad("This request cannot be put on hold now.");
      data = { status: "ON_HOLD", statusAt: now, rdRemarks: reason.trim() };
      tellBd = { title: `${label}: put on Hold by R&D`, body: reason.trim() };
    } else {
      if (!reason?.trim()) return res.status(400).json({ error: "Write why the sample cannot be made." });
      if (["DISPATCHED", "CANNOT_MAKE"].includes(from)) return bad("This request cannot be closed now.");
      data = { status: "CANNOT_MAKE", statusAt: now, rdRemarks: reason.trim() };
      tellBd = { title: `${label}: R&D cannot make it`, body: reason.trim() };
    }

    const row = await prisma.sampleRequest.update({ where: { id: existing.id }, data, include });
    await recordAudit({ actorId: req.user!.id, action: "sample_request.status", entityType: "SampleRequest", entityId: row.id, metadata: { requestNo: row.requestNo, from, to: row.status } });
    if (tellBd) await notifyUser(existing.requestedById, { ...tellBd, link: `/sample-requests/${row.id}` }).catch(notifyFail("sample_request.status"));
    res.json(serialize(row));
  } catch (err) {
    next(err);
  }
});

sampleRequestsRouter.patch("/:id/ra", requireRole("REGULATORY"), validateBody(raSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const b = req.body as z.infer<typeof raSchema>;
    const existing = await load(req);
    if (!existing) return res.status(404).json({ error: "Sample request not found" });
    if (existing.template !== "GUMMIES") return res.status(400).json({ error: "The RA part is only for Gummies requests." });
    const row = await prisma.sampleRequest.update({
      where: { id: existing.id },
      data: { ...(b.exportDomestic !== undefined ? { exportDomestic: b.exportDomestic } : {}), ...(b.labelClaim !== undefined ? { labelClaim: b.labelClaim || null } : {}) },
      include,
    });
    await recordAudit({ actorId: req.user!.id, action: "sample_request.ra_updated", entityType: "SampleRequest", entityId: row.id, metadata: { requestNo: row.requestNo } });
    res.json(serialize(row));
  } catch (err) {
    next(err);
  }
});

sampleRequestsRouter.post("/:id/feedback", requireRole("BD"), validateBody(feedbackSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const b = req.body as z.infer<typeof feedbackSchema>;
    const existing = await load(req);
    if (!existing) return res.status(404).json({ error: "Sample request not found" });
    if (!isOwnerOrAdmin(req, existing.requestedById)) return res.status(403).json({ error: "Only the salesman who raised this request enters the feedback." });
    if (existing.status !== "DISPATCHED") return res.status(409).json({ error: "The feedback comes after the sample is handed over." });
    if (existing.feedback) return res.status(409).json({ error: "The feedback for this request is already given." });

    const snapshot = {
      sampleRequestId: existing.id,
      round: existing.round,
      sampleCode: existing.sampleCode,
      preparedByName: existing.preparedByName,
      expectedDate: existing.expectedDate,
      preparedOn: existing.preparedOn,
      rdRemarks: existing.rdRemarks,
      readyAt: existing.readyAt,
      dispatchedAt: existing.dispatchedAt,
      feedback: b.feedback as SampleFeedback,
      customerRemark: b.customerRemark,
      internalRemark: b.internalRemark || null,
      createdById: req.user!.id,
    };
    const common = { clientFeedback: b.customerRemark, internalRemark: b.internalRemark || null };
    const again = b.feedback === "CHANGE_REQUESTED";
    const row = await prisma.$transaction(async (tx) => {
      await tx.sampleRound.create({ data: snapshot });
      return tx.sampleRequest.update({
        where: { id: existing.id },
        data: again
          ? { ...common, feedback: null, round: existing.round + 1, status: "REQUESTED", statusAt: new Date(), sampleCode: null, preparedByName: null, expectedDate: null, preparedOn: null, rdRemarks: null, readyAt: null, dispatchedAt: null }
          : { ...common, feedback: b.feedback as SampleFeedback },
        include,
      });
    });
    await recordAudit({ actorId: req.user!.id, action: "sample_request.feedback", entityType: "SampleRequest", entityId: row.id, metadata: { requestNo: row.requestNo, feedback: b.feedback, round: existing.round } });

    const label = `${no(row.requestNo)}: ${row.customer.companyName}`;
    if (b.feedback === "APPROVED") {
      // The customer approved: R&D uploads the BOM and Regulatory starts its work, at the same time.
      await notifyRoles(["RND"], { title: `${label}: approved by the customer`, body: "Upload the BOM so planning can start.", link: `/sample-requests/${row.id}` }, req.user!.id).catch(notifyFail("sample_request.approved"));
      await notifyRoles(["REGULATORY"], { title: `${label}: sample approved`, body: "Start the regulatory work for this product.", link: `/sample-requests/${row.id}` }, req.user!.id).catch(notifyFail("sample_request.approved"));
    } else if (again) {
      await notifyRoles(["RND"], { title: `${label}: change requested (round ${row.round})`, body: b.customerRemark, link: `/sample-requests/${row.id}` }, req.user!.id).catch(notifyFail("sample_request.change"));
    }
    res.json(serialize(row));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return res.status(409).json({ error: "The feedback was saved a moment ago. Open the request again." });
    next(err);
  }
});

sampleRequestsRouter.post("/:id/bom-uploaded", requireRole("RND"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await load(req);
    if (!existing) return res.status(404).json({ error: "Sample request not found" });
    if (existing.feedback !== "APPROVED") return res.status(409).json({ error: "The BOM is uploaded after the customer approves the sample." });
    if (existing.bomUploadedAt) return res.status(409).json({ error: "The BOM is already marked as uploaded." });
    const row = await prisma.sampleRequest.update({ where: { id: existing.id }, data: { bomUploadedAt: new Date() }, include });
    await recordAudit({ actorId: req.user!.id, action: "sample_request.bom_uploaded", entityType: "SampleRequest", entityId: row.id, metadata: { requestNo: row.requestNo } });
    await notifyUser(existing.requestedById, { title: `${no(row.requestNo)}: R&D uploaded the BOM for ${row.customer.companyName}`, body: "You can convert the lead and enter the PO.", link: row.leadId ? `/leads/${row.leadId}` : `/sample-requests/${row.id}` }).catch(notifyFail("sample_request.bom_uploaded"));
    res.json(serialize(row));
  } catch (err) {
    next(err);
  }
});
