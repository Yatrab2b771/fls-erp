import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { getOnHandByItemId } from "./stock";
import {
  createRequirementSchema,
  importPurchaseLogSchema,
  importRequirementsSchema,
  setPurchaseSchema,
  type CreateRequirementInput,
  type ImportPurchaseLogInput,
  type ImportRequirementsInput,
  type SetPurchaseInput,
} from "./pre-inventory.schemas";
import type { InventoryCategory, Prisma } from "@prisma/client";

// --- Pre-Inventory — the planning loop that runs before the Warehouse
// ledger (inventory.routes.ts): PPIC states an RM/PM requirement (S1),
// live current stock answers "what's already on hand" automatically
// (S2 — no manual Warehouse step, see stock.ts), Purchase raises a PO
// for whatever's genuinely short (S3), and Finance/Accounts reads the
// resulting vendor list (S4). See the PreInventoryRequirement
// schema.prisma comment for the full picture. ---

export const preInventoryRouter = Router();

preInventoryRouter.use(requireAuth);

function notifyFailed(req: AuthedRequest, label: string) {
  return (err: unknown) => req.log?.error({ err }, `notify failed: ${label}`);
}

const requirementInclude = {
  item: true,
  requestedBy: { select: { id: true, employeeId: true, fullName: true } },
  purchaseBy: { select: { id: true, employeeId: true, fullName: true } },
} satisfies Prisma.PreInventoryRequirementInclude;

type RequirementRow = Prisma.PreInventoryRequirementGetPayload<{ include: typeof requirementInclude }>;

/** Attaches live currentStock (and the derived shortQty) to each row — never persisted, always read fresh off the ledger. */
async function withLiveStock<T extends RequirementRow>(rows: T[]) {
  const onHand = await getOnHandByItemId([...new Set(rows.map((r) => r.itemId))]);
  return rows.map((r) => {
    const currentStock = onHand.get(r.itemId) ?? 0;
    return { ...r, currentStock, shortQty: Math.max(0, r.requiredQty - currentStock) };
  });
}

// PPIC sees only its own requirements (same "it's a request queue, not
// a window into the whole warehouse" rule as Material Requests);
// Store/Purchase/Accounts/Production/Admin see everything — Production
// is read-only here (no write routes below allow it), added so the
// "stock now available" notification (see stock.ts) has somewhere to
// actually link to.
preInventoryRouter.get("/", requireRole("PPIC", "STORE", "PURCHASE", "ACCOUNTS", "PRODUCTION"), async (req: AuthedRequest, res, next) => {
  try {
    const { category, short } = req.query as { category?: InventoryCategory; short?: string };
    const isPpicOnly = req.user!.roles.every((r) => r === "PPIC");

    const where: Prisma.PreInventoryRequirementWhereInput = {
      deletedAt: null,
      ...(category ? { category } : {}),
      ...(isPpicOnly ? { requestedById: req.user!.id } : {}),
    };

    const pagination = parsePagination(req);

    if (short === "true") {
      // shortQty is derived from live stock, not a DB column — it can't be
      // filtered or paginated in the query itself. Pull every matching row,
      // compute stock once, filter, then page the already-filtered set so
      // the count and slice both reflect what's actually short.
      const requirements = await prisma.preInventoryRequirement.findMany({ where, include: requirementInclude, orderBy: { createdAt: "desc" } });
      const withStock = (await withLiveStock(requirements)).filter((r) => r.shortQty > 0);
      setPaginationHeaders(res, withStock.length, pagination);
      res.json(withStock.slice(pagination.skip, pagination.skip + pagination.take));
      return;
    }

    const [total, requirements] = await Promise.all([
      prisma.preInventoryRequirement.count({ where }),
      prisma.preInventoryRequirement.findMany({ where, include: requirementInclude, orderBy: { createdAt: "desc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(await withLiveStock(requirements));
  } catch (err) {
    next(err);
  }
});

// PPIC-only used to be the rule — per the client, Purchase shouldn't have
// to wait for PPIC to log a shortfall it already knows about (e.g. a
// standing reorder, or something Purchase spotted before PPIC did).
// This is still just planning (raising the requirement) — logging the
// actual PO/Vendor/ETA against it stays Purchase-only, see PATCH
// /:id/purchase below: PPIC's job is deciding what's needed, not buying it.
preInventoryRouter.post("/", requireRole("PPIC", "PURCHASE"), validateBody(createRequirementSchema), async (req: AuthedRequest, res, next) => {
  try {
    const data = req.body as CreateRequirementInput;

    const item = await prisma.inventoryItem.findUnique({ where: { id: data.itemId } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });
    if (item.category !== data.category) return res.status(400).json({ error: "Category doesn't match the selected item" });

    const requirement = await prisma.preInventoryRequirement.create({ data: { ...data, requestedById: req.user!.id }, include: requirementInclude });
    const [withStock] = await withLiveStock([requirement]);

    await recordAudit({
      actorId: req.user!.id,
      action: "pre_inventory.requirement_created",
      entityType: "PreInventoryRequirement",
      entityId: requirement.id,
      metadata: { itemId: data.itemId, requiredQty: data.requiredQty },
    });

    // Per the client: telling Purchase there's a gap to cover is PPIC's
    // own call to make, not something the system decides on PPIC's
    // behalf the instant a shortfall exists — see POST /:id/notify-purchase
    // below, the explicit "Send to Purchase" action.

    res.status(201).json(withStock);
  } catch (err) {
    next(err);
  }
});

// Shared by the Excel bulk import below AND by Packaging BOM / RM
// Costing's "Send to Pre-Inventory" buttons — same resolve-or-create-
// item + create-rows behavior regardless of where the rows came from.
// `req` isn't used inside any more (telling Purchase is now a separate
// explicit PPIC action, not auto-fired here) but is kept in the
// signature so every existing caller doesn't need updating for it,
// typed loosely so callers from other modules don't need an exact
// AuthedRequest<P> match.
export interface RequirementSourceRow {
  date: Date;
  category: "RM" | "PM";
  itemName: string;
  unit: string;
  requiredQty: number;
  size?: string;
  note?: string;
}

export async function bulkCreateRequirements(
  rows: RequirementSourceRow[],
  requestedById: string,
  req: AuthedRequest,
): Promise<{ requirementsCreated: number; itemsCreated: number }> {
  const uniqueItems = new Map<string, { category: "RM" | "PM"; name: string }>();
  for (const row of rows) uniqueItems.set(`${row.category}::${row.itemName}`, { category: row.category, name: row.itemName });

  const itemIds = new Map<string, string>();
  let itemsCreated = 0;
  for (const [key, { category, name }] of uniqueItems) {
    const existing = await prisma.inventoryItem.findUnique({ where: { category_name: { category, name } } });
    if (existing) {
      itemIds.set(key, existing.id);
    } else {
      const created = await prisma.inventoryItem.create({ data: { category, name } });
      itemIds.set(key, created.id);
      itemsCreated += 1;
    }
  }

  await prisma.preInventoryRequirement.createMany({
    data: rows.map((row) => ({
      date: row.date,
      category: row.category,
      itemId: itemIds.get(`${row.category}::${row.itemName}`)!,
      unit: row.unit,
      requiredQty: row.requiredQty,
      size: row.size,
      note: row.note,
      requestedById,
    })),
  });

  // No auto-notify here either — same as the single-create path, telling
  // Purchase is PPIC's own explicit call (POST /:id/notify-purchase),
  // not something a bulk import decides on PPIC's behalf.
  return { requirementsCreated: rows.length, itemsCreated };
}

preInventoryRouter.post("/import", requireRole("PPIC"), validateBody(importRequirementsSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = req.body as ImportRequirementsInput;

    const outcome = await bulkCreateRequirements(rows, req.user!.id, req);

    await recordAudit({
      actorId: req.user!.id,
      action: "pre_inventory.requirements_imported",
      entityType: "PreInventoryRequirement",
      metadata: outcome,
    });

    res.status(201).json(outcome);
  } catch (err) {
    next(err);
  }
});

// Bulk PO logging — each row is matched to an existing, still-short,
// not-yet-ordered requirement by item name + category (oldest first),
// same eligibility rule as the single-item route below. A PO can't be
// logged against something PPIC never asked for, so unmatched rows are
// skipped and reported back rather than creating anything.
// Purchase-only — logging the PO/Vendor/ETA is Purchase's job, not
// PPIC's; PPIC's own role here stops at raising the requirement (see
// POST / above) — same split on the single-item route below.
preInventoryRouter.post("/purchase/import", requireRole("PURCHASE"), validateBody(importPurchaseLogSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = req.body as ImportPurchaseLogInput;

    const openRequirements = await prisma.preInventoryRequirement.findMany({
      where: { purchaseAt: null, deletedAt: null },
      include: { item: true },
      orderBy: { createdAt: "asc" },
    });
    const onHand = await getOnHandByItemId([...new Set(openRequirements.map((r) => r.itemId))]);

    const claimed = new Set<string>();
    const matches: { requirement: (typeof openRequirements)[number]; poNumber: string; vendorName: string; eta: Date }[] = [];
    const unmatched: string[] = [];

    for (const row of rows) {
      const candidate = openRequirements.find((r) => {
        if (claimed.has(r.id) || r.category !== row.category || r.item.name !== row.itemName) return false;
        const currentStock = onHand.get(r.itemId) ?? 0;
        return currentStock < r.requiredQty; // still genuinely short, same gate as the single-item route
      });
      if (!candidate) {
        unmatched.push(`${row.itemName} (${row.category})`);
        continue;
      }
      claimed.add(candidate.id);
      matches.push({ requirement: candidate, poNumber: row.poNumber, vendorName: row.vendorName, eta: row.eta });
    }

    if (matches.length > 0) {
      await prisma.$transaction(
        matches.map(({ requirement, poNumber, vendorName, eta }) =>
          prisma.preInventoryRequirement.update({
            where: { id: requirement.id },
            data: { poNumber, vendorName, eta, purchaseById: req.user!.id, purchaseAt: new Date() },
          }),
        ),
      );

      await recordAudit({
        actorId: req.user!.id,
        action: "pre_inventory.purchase_logged_bulk",
        entityType: "PreInventoryRequirement",
        metadata: { posLogged: matches.length, unmatchedCount: unmatched.length },
      });

      await Promise.all([
        ...matches.map(({ requirement, poNumber, vendorName, eta }) =>
          notifyUser(requirement.requestedById, {
            title: `PO logged for ${requirement.item.name}`,
            body: `${poNumber} — ${vendorName}, ETA ${eta.toLocaleDateString()}`,
            link: "/pre-inventory",
          }).catch(notifyFailed(req, `pre_inventory.purchase_logged_bulk.requester.${requirement.id}`)),
        ),
        notifyRoles(
          ["ACCOUNTS"],
          { title: `${matches.length} new PO${matches.length === 1 ? "" : "s"} logged from a bulk import`, body: "Check Pre-Inventory for the vendor list.", link: "/pre-inventory" },
          req.user!.id,
        ).catch(notifyFailed(req, "pre_inventory.purchase_logged_bulk.accounts")),
      ]);
    }

    res.status(201).json({ posLogged: matches.length, unmatched });
  } catch (err) {
    next(err);
  }
});

// Purchase-only — PPIC plans (raises the requirement, POST / above),
// Purchase buys (logs the PO/Vendor/ETA here). Kept as two separate
// roles rather than letting PPIC do both.
preInventoryRouter.patch("/:id/purchase", requireRole("PURCHASE"), validateBody(setPurchaseSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.preInventoryRequirement.findUnique({ where: { id: req.params.id }, include: { item: true } });
    if (!existing) return res.status(404).json({ error: "Requirement not found" });

    const onHand = await getOnHandByItemId([existing.itemId]);
    const currentStock = onHand.get(existing.itemId) ?? 0;
    if (currentStock >= existing.requiredQty) return res.status(409).json({ error: "This requirement is already fully covered by current stock — nothing to order" });

    const { poNumber, vendorName, eta } = req.body as SetPurchaseInput;
    // A PO can already be logged here — Purchase correcting a typo'd PO
    // number, or re-quoting a different vendor, is a real workflow this
    // route allows (unlike deleting the requirement, which is blocked
    // once purchaseAt is set). Without recording what it looked like
    // before, an overwrite would be indistinguishable from a first-time
    // log in the audit trail — the old vendor/PO/ETA is just gone.
    const isCorrection = !!existing.purchaseAt;
    const updated = await prisma.preInventoryRequirement.update({
      where: { id: req.params.id },
      data: { poNumber, vendorName, eta, purchaseById: req.user!.id, purchaseAt: new Date() },
      include: requirementInclude,
    });

    await recordAudit({
      actorId: req.user!.id,
      action: isCorrection ? "pre_inventory.purchase_corrected" : "pre_inventory.purchase_logged",
      entityType: "PreInventoryRequirement",
      entityId: updated.id,
      metadata: isCorrection
        ? { poNumber, vendorName, eta, from: { poNumber: existing.poNumber, vendorName: existing.vendorName, eta: existing.eta } }
        : { poNumber, vendorName, eta },
    });

    await Promise.all([
      notifyUser(updated.requestedById, {
        title: `PO logged for ${existing.item.name}`,
        body: `${poNumber} — ${vendorName}, ETA ${new Date(eta).toLocaleDateString()}`,
        link: "/pre-inventory",
      }).catch(notifyFailed(req, "pre_inventory.purchase_logged.requester")),
      notifyRoles(["ACCOUNTS"], { title: `New PO to plan for: ${poNumber}`, body: `${vendorName} — ${existing.item.name}`, link: "/pre-inventory" }, req.user!.id).catch(
        notifyFailed(req, "pre_inventory.purchase_logged.accounts"),
      ),
    ]);

    const [withStock] = await withLiveStock([updated]);
    res.json(withStock);
  } catch (err) {
    next(err);
  }
});

// PPIC's own explicit "Send to Purchase" — per the client, a shortfall
// existing isn't reason enough for the system to tell Purchase on its
// own; PPIC decides when it's actually worth raising. Doesn't touch the
// row itself (no new field, no state to track) — this is purely the
// notification POST /:id/purchase's own success already sends for other
// events, just triggerable by hand instead of tied to creation.
preInventoryRouter.post("/:id/notify-purchase", requireRole("PPIC"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.preInventoryRequirement.findUnique({ where: { id: req.params.id }, include: requirementInclude });
    if (!existing || existing.deletedAt) return res.status(404).json({ error: "Requirement not found" });
    if (existing.purchaseAt) return res.status(409).json({ error: "A PO has already been logged against this one." });

    const [withStock] = await withLiveStock([existing]);
    if (withStock!.shortQty <= 0) return res.status(400).json({ error: "This item isn't actually short against live stock right now — nothing to send." });

    await notifyRoles(
      ["PURCHASE"],
      { title: `Shortfall: ${existing.item.name}`, body: `${withStock!.shortQty} ${existing.unit} short (${withStock!.currentStock} on hand) — log a PO.`, link: "/pre-inventory" },
      req.user!.id,
    );

    await recordAudit({ actorId: req.user!.id, action: "pre_inventory.sent_to_purchase", entityType: "PreInventoryRequirement", entityId: existing.id, metadata: { shortQty: withStock!.shortQty } });

    res.json(withStock);
  } catch (err) {
    next(err);
  }
});

preInventoryRouter.delete("/:id", requireRole("PPIC", "STORE"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.preInventoryRequirement.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.deletedAt) return res.status(404).json({ error: "Requirement not found" });
    if (existing.purchaseAt) return res.status(409).json({ error: "A PO has already been logged against this — it can't be removed" });

    const isOwner = existing.requestedById === req.user!.id;
    const isStoreOrAdmin = req.user!.roles.includes("STORE") || req.user!.roles.includes("ADMIN");
    if (!isOwner && !isStoreOrAdmin) return res.status(403).json({ error: "You do not have permission to perform this action" });

    await prisma.preInventoryRequirement.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), deletedById: req.user!.id } });
    await recordAudit({ actorId: req.user!.id, action: "pre_inventory.requirement_removed", entityType: "PreInventoryRequirement", entityId: req.params.id });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
