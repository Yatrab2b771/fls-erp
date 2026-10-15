import { Router } from "express";
import { z } from "zod";
import type { Prisma, PrismaClient, StockAdjustmentLocation } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { runSerializable } from "../../common/lib/serializable-transaction";
import { RouteError } from "../../common/lib/route-error";
import { assertUnitMatchesItem } from "../../common/lib/units";
import { getRndStoreOnHand } from "../rnd-store/rnd-stock";
import { assertDayStoreAccess, assertPlantAccess, getScopedDayStoreIds, getScopedPlantIds } from "./day-store-access";
import { getExpiredRemainingByItemId, getOnHandByDayStoreAndItem, getOnHandByItemId, getOnHandByPlantAndItem } from "./stock";

/**
 * Stock adjustments - the way to correct a wrong balance. Until now the only fix was deleting entries, which is blocked once other
 * stock depends on them. An adjustment is a signed correction at ONE place (Warehouse, a Day Store, a Plant, or the R&D Store):
 *
 *   Store / Production / R&D raises it   either "add / take out this much" or, for a physical count, "I counted this much" (the
 *                                        system works out the difference from what it currently shows)
 *   Admin or Accounts approves it        and ONLY THEN does any balance change (stock.ts reads APPROVED rows only)
 *
 * Everything that makes stock disappear without a production entry goes through here - damage, spillage, expired stock thrown
 * away (EXPIRED_DISPOSAL, which comes out of Quarantine) - and so does stock found that was never booked in (FOUND_EXTRA).
 *
 *   GET    /                list (?status, ?locationType, ?itemId; paged)
 *   GET    /summary         how many wait for approval
 *   GET    /position        what the system shows right now for item + place (the count form uses it)
 *   POST   /                raise one
 *   POST   /:id/review      approve / reject (Admin, Accounts)
 *   DELETE /:id             withdraw one of your own pending requests
 */
export const stockAdjustmentsRouter = Router();
stockAdjustmentsRouter.use(requireAuth);

const REQUESTERS = ["STORE", "PRODUCTION", "RND"] as const;
const REVIEWERS = ["ACCOUNTS"] as const; // ADMIN always passes requireRole
const EPS = 1e-9;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const locationFields = {
  locationType: z.enum(["WAREHOUSE", "DAY_STORE", "PLANT", "RND_STORE"]),
  dayStoreId: z.string().uuid().optional(),
  plantId: z.string().uuid().optional(),
};

export const createAdjustmentSchema = z
  .object({
    itemId: z.string().uuid(),
    ...locationFields,
    /** DELTA: the signed change is given. COUNT: the physical count is given and the change is worked out. */
    mode: z.enum(["DELTA", "COUNT"]).default("DELTA"),
    quantityDelta: z.coerce.number().optional(),
    countedQty: z.coerce.number().nonnegative().optional(),
    reason: z.enum(["COUNT_CORRECTION", "DAMAGED", "SPILLAGE", "EXPIRED_DISPOSAL", "FOUND_EXTRA", "OTHER"]).optional(),
    unit: z.string().trim().min(1).max(40).optional(),
    note: z.string().trim().min(3, "Write why the stock is being corrected.").max(500),
  })
  .superRefine((d, ctx) => {
    if (d.locationType === "DAY_STORE" && !d.dayStoreId) ctx.addIssue({ code: "custom", path: ["dayStoreId"], message: "Pick the Day Store." });
    if (d.locationType === "PLANT" && !d.plantId) ctx.addIssue({ code: "custom", path: ["plantId"], message: "Pick the Plant." });
    if (d.mode === "DELTA" && (d.quantityDelta === undefined || Math.abs(d.quantityDelta) < EPS)) ctx.addIssue({ code: "custom", path: ["quantityDelta"], message: "Enter how much to add (+) or take out (-)." });
    if (d.mode === "COUNT" && d.countedQty === undefined) ctx.addIssue({ code: "custom", path: ["countedQty"], message: "Enter the quantity you counted." });
  });
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;

export const reviewAdjustmentSchema = z
  .object({ action: z.enum(["APPROVE", "REJECT"]), note: z.string().trim().max(500).optional() })
  .refine((d) => d.action === "APPROVE" || !!d.note, { path: ["note"], message: "Say why it is being rejected." });

type Db = Prisma.TransactionClient | PrismaClient;

/** What the system currently shows at one place for one item (the usable quantity - Quarantine is separate). */
async function positionAt(db: Db, locationType: StockAdjustmentLocation, itemId: string, dayStoreId?: string | null, plantId?: string | null): Promise<number> {
  const typed = db as unknown as Parameters<typeof getOnHandByItemId>[1];
  if (locationType === "WAREHOUSE") return (await getOnHandByItemId([itemId], typed)).get(itemId) ?? 0;
  if (locationType === "DAY_STORE") return (await getOnHandByDayStoreAndItem(dayStoreId!, [itemId], typed)).get(itemId)?.onHand ?? 0;
  if (locationType === "PLANT") return (await getOnHandByPlantAndItem(plantId!, [itemId], typed)).get(itemId) ?? 0;
  return (await getRndStoreOnHand([itemId], db as unknown as Parameters<typeof getRndStoreOnHand>[1])).get(itemId) ?? 0;
}

/** Throws unless taking `take` out of the place leaves it at zero or more. */
async function assertEnoughToTakeOut(db: Db, adj: { locationType: StockAdjustmentLocation; itemId: string; dayStoreId: string | null; plantId: string | null; reason: string; unit: string }, take: number) {
  if (adj.reason === "EXPIRED_DISPOSAL") {
    const typed = db as unknown as Parameters<typeof getExpiredRemainingByItemId>[1];
    const expired = (await getExpiredRemainingByItemId([adj.itemId], typed)).get(adj.itemId) ?? 0;
    if (take > expired + EPS) throw new RouteError(409, `Only ${round3(expired)} ${adj.unit} of expired stock is in Quarantine - can't dispose of ${round3(take)}.`);
    return;
  }
  const onHand = await positionAt(db, adj.locationType, adj.itemId, adj.dayStoreId, adj.plantId);
  if (take > onHand + EPS) throw new RouteError(409, `Only ${round3(onHand)} ${adj.unit} is on hand there - can't take out ${round3(take)}.`);
}

const adjustmentInclude = {
  item: { select: { id: true, name: true, category: true, unit: true } },
  dayStore: { select: { id: true, name: true } },
  plant: { select: { id: true, name: true } },
} satisfies Prisma.StockAdjustmentInclude;

async function serialize(rows: Prisma.StockAdjustmentGetPayload<{ include: typeof adjustmentInclude }>[]) {
  const userIds = [...new Set(rows.flatMap((r) => [r.requestedById, ...(r.reviewedById ? [r.reviewedById] : [])]))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, email: true } }) : [];
  const nameOf = new Map(users.map((u) => [u.id, u.fullName || u.email]));
  return rows.map((r) => ({
    id: r.id,
    itemId: r.itemId,
    itemName: r.item.name,
    category: r.item.category,
    locationType: r.locationType,
    locationName: r.locationType === "WAREHOUSE" ? "Warehouse" : r.locationType === "RND_STORE" ? "R&D Store" : (r.dayStore?.name ?? r.plant?.name ?? "—"),
    dayStoreId: r.dayStoreId,
    plantId: r.plantId,
    quantityDelta: r.quantityDelta,
    unit: r.unit,
    reason: r.reason,
    note: r.note,
    systemQty: r.systemQty,
    countedQty: r.countedQty,
    status: r.status,
    requestedAt: r.requestedAt,
    requestedByName: nameOf.get(r.requestedById) ?? "—",
    requestedById: r.requestedById,
    reviewedAt: r.reviewedAt,
    reviewedByName: r.reviewedById ? (nameOf.get(r.reviewedById) ?? "—") : null,
    reviewNote: r.reviewNote,
  }));
}

/** Which places this caller may see / raise corrections for: a Day Store login its own store, a Plant-limited Production login its own Plant. */
async function visibleWhere(req: AuthedRequest): Promise<Prisma.StockAdjustmentWhereInput> {
  const roles = req.user!.roles;
  if (roles.includes("ADMIN") || roles.includes("ACCOUNTS")) return {};
  const or: Prisma.StockAdjustmentWhereInput[] = [{ requestedById: req.user!.id }];
  if (roles.includes("STORE")) {
    const scope = await getScopedDayStoreIds(req.user!.id, roles);
    or.push(scope === null ? { locationType: { in: ["WAREHOUSE", "DAY_STORE"] } } : { locationType: "DAY_STORE", dayStoreId: { in: scope } });
  }
  if (roles.includes("PRODUCTION")) {
    const scope = await getScopedPlantIds(req.user!.id, roles);
    or.push(scope === null ? { locationType: "PLANT" } : { locationType: "PLANT", plantId: { in: scope } });
  }
  if (roles.includes("RND")) or.push({ locationType: "RND_STORE" });
  return { OR: or };
}

stockAdjustmentsRouter.get("/", requireRole(...REQUESTERS, ...REVIEWERS), async (req: AuthedRequest, res, next) => {
  try {
    const { status, locationType, itemId } = req.query as { status?: string; locationType?: string; itemId?: string };
    const pagination = parsePagination(req);
    const where: Prisma.StockAdjustmentWhereInput = {
      deletedAt: null,
      ...(status && ["PENDING", "APPROVED", "REJECTED"].includes(status) ? { status: status as "PENDING" | "APPROVED" | "REJECTED" } : {}),
      ...(locationType && ["WAREHOUSE", "DAY_STORE", "PLANT", "RND_STORE"].includes(locationType) ? { locationType: locationType as StockAdjustmentLocation } : {}),
      ...(itemId ? { itemId } : {}),
      AND: [await visibleWhere(req)],
    };
    const [total, rows] = await Promise.all([
      prisma.stockAdjustment.count({ where }),
      prisma.stockAdjustment.findMany({ where, include: adjustmentInclude, orderBy: { requestedAt: "desc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(await serialize(rows));
  } catch (err) {
    next(err);
  }
});

stockAdjustmentsRouter.get("/summary", requireRole(...REQUESTERS, ...REVIEWERS), async (req: AuthedRequest, res, next) => {
  try {
    const visible = await visibleWhere(req);
    const [pending, approved, rejected] = await Promise.all(
      (["PENDING", "APPROVED", "REJECTED"] as const).map((status) => prisma.stockAdjustment.count({ where: { deletedAt: null, status, AND: [visible] } })),
    );
    res.json({ pending, approved, rejected });
  } catch (err) {
    next(err);
  }
});

// What the system shows now at one place for one item - the physical-count form compares the count against it.
stockAdjustmentsRouter.get("/position", requireRole(...REQUESTERS, ...REVIEWERS), async (req: AuthedRequest, res, next) => {
  try {
    const q = z.object({ itemId: z.string().uuid(), ...locationFields }).safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: "Pick the item and the place." });
    const { itemId, locationType, dayStoreId, plantId } = q.data;
    const item = await prisma.inventoryItem.findUnique({ where: { id: itemId }, select: { unit: true } });
    if (!item) return res.status(404).json({ error: "Item not found" });
    const [onHand, expired] = await Promise.all([
      positionAt(prisma, locationType, itemId, dayStoreId, plantId),
      locationType === "WAREHOUSE" ? getExpiredRemainingByItemId([itemId]).then((m) => m.get(itemId) ?? 0) : Promise.resolve(0),
    ]);
    res.json({ onHand: round3(onHand), expiredInQuarantine: round3(expired), unit: item.unit });
  } catch (err) {
    next(err);
  }
});

/** The caller may correct stock at this place. */
async function assertMayAdjust(req: AuthedRequest, input: Pick<CreateAdjustmentInput, "locationType" | "dayStoreId" | "plantId">) {
  const roles = req.user!.roles;
  if (roles.includes("ADMIN")) return;
  if (input.locationType === "WAREHOUSE") {
    if (!roles.includes("STORE") || (await getScopedDayStoreIds(req.user!.id, roles)) !== null) throw new RouteError(403, "Only the Warehouse can correct Warehouse stock.");
  } else if (input.locationType === "DAY_STORE") {
    if (!roles.includes("STORE")) throw new RouteError(403, "Only Store can correct a Day Store's stock.");
    await assertDayStoreAccess(req.user!.id, roles, input.dayStoreId!);
  } else if (input.locationType === "PLANT") {
    if (!roles.includes("PRODUCTION")) throw new RouteError(403, "Only Production can correct a Plant's stock.");
    await assertPlantAccess(req.user!.id, roles, input.plantId!);
  } else if (!roles.includes("RND")) {
    throw new RouteError(403, "Only R&D can correct the R&D Store's stock.");
  }
}

stockAdjustmentsRouter.post("/", requireRole(...REQUESTERS), validateBody(createAdjustmentSchema), async (req: AuthedRequest, res, next) => {
  try {
    const input = req.body as CreateAdjustmentInput;
    await assertMayAdjust(req, input);
    const item = await prisma.inventoryItem.findUnique({ where: { id: input.itemId }, select: { id: true, name: true, unit: true } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });
    if (input.locationType === "DAY_STORE" && !(await prisma.dayStore.findUnique({ where: { id: input.dayStoreId! }, select: { id: true } }))) return res.status(400).json({ error: "Unknown Day Store" });
    if (input.locationType === "PLANT" && !(await prisma.plant.findUnique({ where: { id: input.plantId! }, select: { id: true } }))) return res.status(400).json({ error: "Unknown Plant" });

    const unit = input.unit ?? item.unit ?? "";
    if (!unit) return res.status(400).json({ error: "This item has no unit yet - enter the unit." });
    assertUnitMatchesItem(item, unit);

    const dayStoreId = input.locationType === "DAY_STORE" ? input.dayStoreId! : null;
    const plantId = input.locationType === "PLANT" ? input.plantId! : null;

    let delta: number;
    let systemQty: number | null = null;
    let countedQty: number | null = null;
    if (input.mode === "COUNT") {
      systemQty = round3(await positionAt(prisma, input.locationType, item.id, dayStoreId, plantId));
      countedQty = round3(input.countedQty!);
      delta = round3(countedQty - systemQty);
      if (Math.abs(delta) < EPS) return res.status(400).json({ error: `The system already shows ${systemQty} ${unit} - nothing to correct.` });
    } else {
      delta = round3(input.quantityDelta!);
    }

    const reason = input.reason ?? (input.mode === "COUNT" ? "COUNT_CORRECTION" : delta > 0 ? "FOUND_EXTRA" : "OTHER");
    if (reason === "EXPIRED_DISPOSAL" && (input.locationType !== "WAREHOUSE" || delta >= 0)) return res.status(400).json({ error: "Disposing of expired stock takes it out of the Warehouse's Quarantine." });
    if (reason === "FOUND_EXTRA" && delta <= 0) return res.status(400).json({ error: "Stock found extra has to be a quantity to add." });
    if ((reason === "DAMAGED" || reason === "SPILLAGE") && delta >= 0) return res.status(400).json({ error: "Damage or spillage takes stock out - enter a negative quantity." });

    // A request that could never be approved is refused now; the check is made again when it is approved.
    if (delta < 0) await assertEnoughToTakeOut(prisma, { locationType: input.locationType, itemId: item.id, dayStoreId, plantId, reason, unit }, -delta);

    const created = await prisma.stockAdjustment.create({
      data: { itemId: item.id, locationType: input.locationType, dayStoreId, plantId, quantityDelta: delta, unit, reason, note: input.note, systemQty, countedQty, requestedById: req.user!.id },
      include: adjustmentInclude,
    });
    await recordAudit({ actorId: req.user!.id, action: "stock_adjustment.requested", entityType: "StockAdjustment", entityId: created.id, metadata: { itemId: item.id, locationType: input.locationType, delta, reason } });
    await notifyRoles(["ACCOUNTS", "ADMIN"], { title: `Stock correction to approve: ${item.name}`, body: `${delta > 0 ? "+" : ""}${delta} ${unit} (${reason.replace(/_/g, " ").toLowerCase()}) - ${input.note}`, link: "/stock-adjustments" }, req.user!.id).catch((err) =>
      req.log?.error({ err }, "notify failed: stock_adjustment.requested"),
    );
    res.status(201).json((await serialize([created]))[0]);
  } catch (err) {
    next(err);
  }
});

stockAdjustmentsRouter.post("/:id/review", requireRole(...REVIEWERS), validateBody(reviewAdjustmentSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const { action, note } = req.body as z.infer<typeof reviewAdjustmentSchema>;
    const isAdmin = req.user!.roles.includes("ADMIN");

    const result = await runSerializable(async (tx) => {
      const adj = await tx.stockAdjustment.findUnique({ where: { id: req.params.id }, include: adjustmentInclude });
      if (!adj || adj.deletedAt) throw new RouteError(404, "Adjustment not found");
      if (adj.status !== "PENDING") throw new RouteError(409, `This correction is already ${adj.status.toLowerCase()}.`);
      // Two people: whoever raised it can't be the one who approves it (an Admin may, for a data correction).
      if (action === "APPROVE" && adj.requestedById === req.user!.id && !isAdmin) throw new RouteError(403, "Someone else has to approve a correction you raised.");
      if (action === "APPROVE" && adj.quantityDelta < 0) {
        await assertEnoughToTakeOut(tx, { locationType: adj.locationType, itemId: adj.itemId, dayStoreId: adj.dayStoreId, plantId: adj.plantId, reason: adj.reason, unit: adj.unit }, -adj.quantityDelta);
      }
      return tx.stockAdjustment.update({
        where: { id: adj.id },
        data: { status: action === "APPROVE" ? "APPROVED" : "REJECTED", reviewedById: req.user!.id, reviewedAt: new Date(), reviewNote: note ?? null },
        include: adjustmentInclude,
      });
    });

    await recordAudit({ actorId: req.user!.id, action: action === "APPROVE" ? "stock_adjustment.approved" : "stock_adjustment.rejected", entityType: "StockAdjustment", entityId: result.id, metadata: { delta: result.quantityDelta, note } });
    await notifyUser(result.requestedById, {
      title: `Stock correction ${action === "APPROVE" ? "approved" : "rejected"}: ${result.item.name}`,
      body: action === "APPROVE" ? `${result.quantityDelta > 0 ? "+" : ""}${result.quantityDelta} ${result.unit} is now in the books.` : (note ?? ""),
      link: "/stock-adjustments",
    }).catch((err) => req.log?.error({ err }, "notify failed: stock_adjustment.reviewed"));
    res.json((await serialize([result]))[0]);
  } catch (err) {
    next(err);
  }
});

stockAdjustmentsRouter.delete("/:id", requireRole(...REQUESTERS), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const adj = await prisma.stockAdjustment.findUnique({ where: { id: req.params.id } });
    if (!adj || adj.deletedAt) return res.status(404).json({ error: "Adjustment not found" });
    if (adj.status !== "PENDING") return res.status(409).json({ error: "Only a correction still waiting for approval can be withdrawn." });
    if (adj.requestedById !== req.user!.id && !req.user!.roles.includes("ADMIN")) return res.status(403).json({ error: "Only the person who raised it can withdraw it." });
    await prisma.stockAdjustment.update({ where: { id: adj.id }, data: { deletedAt: new Date() } });
    await recordAudit({ actorId: req.user!.id, action: "stock_adjustment.withdrawn", entityType: "StockAdjustment", entityId: adj.id });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
