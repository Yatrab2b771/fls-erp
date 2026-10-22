import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { getTotalAvailableByItemId } from "./stock";
import { poVisibilityWhere } from "../purchase-orders/po-visibility";
import {
  createRequirementSchema,
  importPurchaseLogSchema,
  importRequirementsSchema,
  setPurchaseSchema,
  updatePurchaseLineSchema,
  type CreateRequirementInput,
  type ImportPurchaseLogInput,
  type ImportRequirementsInput,
  type SetPurchaseInput,
  type UpdatePurchaseLineInput,
} from "./pre-inventory.schemas";
import { QTY_EPS, summarizeLines, syncRequirementSummary } from "./purchase-lines";
import { assertVendorAllowed } from "../product-vendors/vendor-rules";
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
  // The PI lines Purchase has split this shortfall into, earliest ETA first.
  purchaseLines: { orderBy: [{ eta: "asc" as const }, { loggedAt: "asc" as const }], include: { loggedBy: { select: { id: true, employeeId: true, fullName: true } }, finance: { select: { status: true, remarks: true, remarksAt: true } } } },
} satisfies Prisma.PreInventoryRequirementInclude;

type RequirementRow = Prisma.PreInventoryRequirementGetPayload<{ include: typeof requirementInclude }>;

/**
 * Attaches live currentStock (and the derived shortQty) to each row —
 * never persisted, always read fresh off the ledger. currentStock is
 * the company-wide total (Warehouse + every Day Store + every Plant +
 * R&D Store — see stock.ts's getTotalAvailableByItemId), not Warehouse
 * alone: a requirement PPIC raised shouldn't show short just because
 * its material already staged forward to a Day Store/Plant, or was
 * sent to R&D Store, while it's still real, usable company stock.
 *
 * Also attaches `sourcePo` - the customer PO and product a row came from
 * (rows sent from Material Planning carry sourcePoItemId) - so the page can
 * group them PO > product > material. Null for manual / imported rows.
 */
async function loadSourcePos(ids: (string | null)[]) {
  const sourceIds = [...new Set(ids.filter((id): id is string => !!id))];
  const sources = sourceIds.length
    ? await prisma.purchaseOrderItem.findMany({
        where: { id: { in: sourceIds } },
        select: { id: true, productName: true, quantity: true, unit: true, purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } } },
      })
    : [];
  return new Map(
    sources.map((s) => [s.id, { poId: s.purchaseOrder.id, poNumber: s.purchaseOrder.poNumber, customerName: s.purchaseOrder.customer.companyName, itemId: s.id, productName: s.productName, quantity: s.quantity, unit: s.unit }]),
  );
}

/** For a need raised from a Day Store / R&D material request: who asked, so PPIC can tell what each purchase is for. */
async function loadRequestSources(rows: RequirementRow[]) {
  const storeIds = [...new Set(rows.map((r) => r.sourceRequestId).filter((id): id is string => !!id))];
  const rndIds = [...new Set(rows.map((r) => r.sourceRndRequestId).filter((id): id is string => !!id))];
  const [storeReqs, rndReqs] = await Promise.all([
    storeIds.length ? prisma.inventoryRequest.findMany({ where: { id: { in: storeIds } }, select: { id: true, requestingDayStore: { select: { name: true } } } }) : [],
    rndIds.length ? prisma.rndSampleRequest.findMany({ where: { id: { in: rndIds } }, select: { id: true } }) : [],
  ]);
  const byId = new Map<string, { kind: "DAY_STORE" | "RND"; label: string }>();
  for (const r of storeReqs) byId.set(r.id, { kind: "DAY_STORE", label: r.requestingDayStore?.name ?? "Store" });
  for (const r of rndReqs) byId.set(r.id, { kind: "RND", label: "R&D Store" });
  return byId;
}

async function withLiveStock<T extends RequirementRow>(rows: T[]) {
  const onHand = await getTotalAvailableByItemId([...new Set(rows.map((r) => r.itemId))]);
  const sourceById = await loadSourcePos(rows.map((r) => r.sourcePoItemId ?? r.linkedPoItemId));
  const requestSources = await loadRequestSources(rows);
  return rows.map((r) => {
    const currentStock = onHand.get(r.itemId) ?? 0;
    const shortQty = Math.max(0, r.requiredQty - currentStock);
    // onOrderQty: the part of the shortfall covered by PI lines still to arrive; remainingToLog: what Purchase can still log.
    const { onOrderQty, remainingToLog } = summarizeLines(r.purchaseLines, shortQty);
    const requestSource = requestSources.get((r.sourceRequestId ?? r.sourceRndRequestId) ?? "") ?? null;
    return { ...r, currentStock, shortQty, onOrderQty, remainingToLog, requestSource, sourcePo: (r.sourcePoItemId ?? r.linkedPoItemId) ? (sourceById.get((r.sourcePoItemId ?? r.linkedPoItemId)!) ?? null) : null };
  });
}

// PPIC sees only its own requirements (same "it's a request queue, not
// a window into the whole warehouse" rule as Material Requests);
// Store/Purchase/Accounts/Production/Admin see everything — Production
// is read-only here (no write routes below allow it), added so the
// "stock now available" notification (see stock.ts) has somewhere to
// actually link to.
preInventoryRouter.get("/", requireRole("PPIC", "STORE", "PURCHASE", "ACCOUNTS"), async (req: AuthedRequest, res, next) => {
  try {
    const { category, short } = req.query as { category?: InventoryCategory; short?: string };
    const isPpicOnly = req.user!.roles.every((r) => r === "PPIC");
    const isPurchaseOnly = req.user!.roles.every((r) => r === "PURCHASE");
    const fromStoreRequest: Prisma.PreInventoryRequirementWhereInput = { OR: [{ sourceRequestId: { not: null } }, { sourceRndRequestId: { not: null } }] };

    const where: Prisma.PreInventoryRequirementWhereInput = {
      deletedAt: null,
      ...(category ? { category } : {}),
      // PPIC also sees every need a Day Store / R&D request turned into - those are PPIC's to send on.
      ...(isPpicOnly ? { OR: [{ requestedById: req.user!.id }, ...(fromStoreRequest.OR ?? [])] } : {}),
      // Purchase only sees such a need once PPIC has sent it to Purchase.
      ...(isPurchaseOnly ? { NOT: { AND: [fromStoreRequest, { purchaseNotifiedAt: null }] } } : {}),
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

    const { purchaseOrderItemId, ...fields } = data;
    if (purchaseOrderItemId) {
      const product = await prisma.purchaseOrderItem.findFirst({ where: { id: purchaseOrderItemId, deletedAt: null, purchaseOrder: poVisibilityWhere(req.user!.roles) }, select: { id: true } });
      if (!product) return res.status(400).json({ error: "That PO product doesn't exist (or isn't visible to you)" });
    }

    const requirement = await prisma.preInventoryRequirement.create({ data: { ...fields, ...(purchaseOrderItemId ? { linkedPoItemId: purchaseOrderItemId } : {}), requestedById: req.user!.id }, include: requirementInclude });
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

// ---------------------------------------------------------------------------
// Incoming Material - every PI line still to arrive, for Store (what to expect, when)
// and PPIC (when can the next product start). Open lines of requirements that are still
// short against live stock, earliest ETA first.
// ---------------------------------------------------------------------------

const INCOMING_ROLES = requireRole("PPIC", "STORE", "PURCHASE", "ACCOUNTS", "PRODUCTION");
const startOfToday = () => new Date(new Date().toDateString());

export async function loadIncoming() {
  const lines = await prisma.requirementPurchaseLine.findMany({
    where: { status: "OPEN", requirement: { deletedAt: null } },
    include: { requirement: { include: { item: true } } },
    orderBy: [{ eta: "asc" }, { loggedAt: "asc" }],
  });
  const onHand = await getTotalAvailableByItemId([...new Set(lines.map((l) => l.requirement.itemId))]);
  const sources = await loadSourcePos(lines.map((l) => l.requirement.sourcePoItemId ?? l.requirement.linkedPoItemId));
  const today = startOfToday().getTime();
  return lines
    .filter((l) => l.requirement.requiredQty - (onHand.get(l.requirement.itemId) ?? 0) > QTY_EPS) // a line whose requirement stock has since covered is not incoming any more
    .map((l) => ({
      lineId: l.id,
      requirementId: l.requirementId,
      itemName: l.requirement.item.name,
      shortQty: Math.round((l.requirement.requiredQty - (onHand.get(l.requirement.itemId) ?? 0)) * 100) / 100,
      loggedAt: l.correctedAt ?? l.loggedAt,
      category: l.requirement.category,
      unit: l.requirement.unit,
      quantity: Math.round((l.quantity - l.receivedQty) * 100) / 100, // still to arrive
      orderedQty: l.quantity,
      piNumber: l.piNumber,
      vendorName: l.vendorName,
      eta: l.eta,
      overdue: l.eta.getTime() < today,
      customerPo: (l.requirement.sourcePoItemId ?? l.requirement.linkedPoItemId) ? (sources.get((l.requirement.sourcePoItemId ?? l.requirement.linkedPoItemId)!) ?? null) : null,
    }));
}

type IncomingRow = Awaited<ReturnType<typeof loadIncoming>>[number];

function incomingFilters(req: AuthedRequest) {
  const many = (raw: unknown): string[] => (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const q = req.query;
  return { dateFrom: day(q.dateFrom), dateTo: day(q.dateTo), item: many(q.item), vendor: many(q.vendor), pi: many(q.pi), category: many(q.category), customerPo: many(q.customerPo), product: many(q.product) };
}

function applyIncomingFilters(rows: IncomingRow[], f: ReturnType<typeof incomingFilters>): IncomingRow[] {
  return rows.filter((r) => {
    const eta = r.eta.toISOString().slice(0, 10);
    return (
      (!f.dateFrom || eta >= f.dateFrom) &&
      (!f.dateTo || eta <= f.dateTo) &&
      (!f.item.length || f.item.includes(r.itemName)) &&
      (!f.vendor.length || f.vendor.includes(r.vendorName)) &&
      (!f.pi.length || f.pi.includes(r.piNumber)) &&
      (!f.category.length || f.category.includes(r.category)) &&
      (!f.customerPo.length || (r.customerPo?.poNumber != null && f.customerPo.includes(r.customerPo.poNumber))) &&
      (!f.product.length || (r.customerPo != null && f.product.includes(r.customerPo.productName)))
    );
  });
}

preInventoryRouter.get("/incoming", INCOMING_ROLES, async (req: AuthedRequest, res, next) => {
  try {
    const pagination = parsePagination(req);
    const rows = applyIncomingFilters(await loadIncoming(), incomingFilters(req));
    setPaginationHeaders(res, rows.length, pagination);
    res.json(rows.slice(pagination.skip, pagination.skip + pagination.take));
  } catch (err) {
    next(err);
  }
});

// The tile's numbers: PI lines on their way, how many are late, how many land within a week.
preInventoryRouter.get("/incoming/summary", INCOMING_ROLES, async (_req: AuthedRequest, res, next) => {
  try {
    const rows = await loadIncoming();
    const weekAhead = startOfToday().getTime() + 8 * 86_400_000;
    res.json({
      lines: rows.length,
      materials: new Set(rows.map((r) => r.requirementId)).size,
      overdue: rows.filter((r) => r.overdue).length,
      dueThisWeek: rows.filter((r) => !r.overdue && r.eta.getTime() < weekAhead).length,
    });
  } catch (err) {
    next(err);
  }
});

// Dropdown values for the list's filters (item / vendor / PI number), searched with ?q=.
preInventoryRouter.get("/incoming/options", INCOMING_ROLES, async (req: AuthedRequest, res, next) => {
  try {
    const field = String(req.query.field ?? "");
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const pick: Record<string, (r: IncomingRow) => string | null | undefined> = {
      item: (r) => r.itemName,
      vendor: (r) => r.vendorName,
      pi: (r) => r.piNumber,
      customerPo: (r) => r.customerPo?.poNumber, // rows not tied to a customer PO have nothing to pick
      product: (r) => r.customerPo?.productName,
    };
    if (!pick[field]) return res.status(400).json({ error: "Unknown filter field" });
    const all = [...new Set((await loadIncoming()).map(pick[field]!).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const matched = q ? all.filter((v) => v.toLowerCase().includes(q)) : all;
    res.json({ values: matched.slice(0, 100), hasMore: matched.length > 100 });
  } catch (err) {
    next(err);
  }
});

// Bulk PI logging — each row is matched to an existing requirement that still has
// quantity left to log, by item name + category (oldest first). A row may carry a
// quantity (one PI covering part of the shortfall); without one it covers everything
// still to log. A PI can't be logged against something PPIC never asked for, so
// unmatched rows are skipped and reported back rather than creating anything.
// Purchase-only — logging the PI/Vendor/ETA is Purchase's job, not PPIC's.
preInventoryRouter.post("/purchase/import", requireRole("PURCHASE"), validateBody(importPurchaseLogSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = req.body as ImportPurchaseLogInput;

    const openRequirements = await prisma.preInventoryRequirement.findMany({
      where: { deletedAt: null },
      include: { item: true, purchaseLines: true },
      orderBy: { createdAt: "asc" },
    });
    const onHand = await getTotalAvailableByItemId([...new Set(openRequirements.map((r) => r.itemId))]);
    // What each requirement still has to log, reduced as this import's own rows claim it.
    const remaining = new Map(openRequirements.map((r) => [r.id, summarizeLines(r.purchaseLines, r.requiredQty - (onHand.get(r.itemId) ?? 0)).remainingToLog]));

    const matches: { requirement: (typeof openRequirements)[number]; poNumber: string; vendorName: string; eta: Date; quantity: number }[] = [];
    const unmatched: string[] = [];

    for (const row of rows) {
      const candidate = openRequirements.find((r) => {
        if (r.category !== row.category || r.item.name !== row.itemName) return false;
        const left = remaining.get(r.id) ?? 0;
        return left > QTY_EPS && (row.quantity === undefined || left >= row.quantity - QTY_EPS);
      });
      if (!candidate) {
        unmatched.push(`${row.itemName} (${row.category})`);
        continue;
      }
      // Approved vendors: a row for a vendor the product's material may not come from is left out and named back, like an unmatched row.
      try {
        await assertVendorAllowed(candidate, row.vendorName);
      } catch {
        unmatched.push(`${row.itemName} (${row.category}) - ${row.vendorName} is not an approved vendor for it`);
        continue;
      }
      const quantity = row.quantity ?? remaining.get(candidate.id)!;
      remaining.set(candidate.id, (remaining.get(candidate.id) ?? 0) - quantity);
      matches.push({ requirement: candidate, poNumber: row.poNumber, vendorName: row.vendorName, eta: row.eta, quantity });
    }

    if (matches.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const { requirement, poNumber, vendorName, eta, quantity } of matches) {
          await tx.requirementPurchaseLine.create({ data: { requirementId: requirement.id, quantity, piNumber: poNumber, vendorName, eta, loggedById: req.user!.id } });
        }
        for (const id of new Set(matches.map((m) => m.requirement.id))) await syncRequirementSummary(id, tx);
      });

      await recordAudit({
        actorId: req.user!.id,
        action: "pre_inventory.purchase_logged_bulk",
        entityType: "PreInventoryRequirement",
        metadata: { posLogged: matches.length, unmatchedCount: unmatched.length },
      });

      await Promise.all([
        ...matches.map(({ requirement, poNumber, vendorName, eta, quantity }) =>
          notifyUser(requirement.requestedById, {
            title: `PI logged for ${requirement.item.name}`,
            body: `${quantity} ${requirement.unit} · ${poNumber} — ${vendorName}, ETA ${eta.toLocaleDateString()}`,
            link: "/pre-inventory",
          }).catch(notifyFailed(req, `pre_inventory.purchase_logged_bulk.requester.${requirement.id}`)),
        ),
        notifyRoles(
          ["ACCOUNTS"],
          { title: `${matches.length} new PI${matches.length === 1 ? "" : "s"} logged from a bulk import`, body: "Check Pre-Inventory for the vendor list.", link: "/pre-inventory" },
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
// Purchase buys (logs the PI/Vendor/ETA here). Kept as two separate
// roles rather than letting PPIC do both.
//
// One shortfall can be split across several PI lines (20 + 40 + 40 Kg), each with its
// own PI Number / Vendor / ETA: send `quantity` to add a line for that much. Without a
// quantity the PI covers everything still to log - and if the requirement already has
// lines, the request corrects the latest one (the original "edit the PI" behaviour).
preInventoryRouter.patch("/:id/purchase", requireRole("PURCHASE"), validateBody(setPurchaseSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.preInventoryRequirement.findUnique({ where: { id: req.params.id }, include: { item: true, purchaseLines: true } });
    if (!existing || existing.deletedAt) return res.status(404).json({ error: "Requirement not found" });

    const onHand = await getTotalAvailableByItemId([existing.itemId]);
    const currentStock = onHand.get(existing.itemId) ?? 0;
    if (currentStock >= existing.requiredQty) return res.status(409).json({ error: "This requirement is already fully covered by current stock — nothing to order" });

    const { poNumber, vendorName, eta, quantity } = req.body as SetPurchaseInput;
    // A shortfall that belongs to a product with approved vendors can only be ordered from one of them (unless R&D allowed another).
    await assertVendorAllowed(existing, vendorName);
    const { remainingToLog } = summarizeLines(existing.purchaseLines, existing.requiredQty - currentStock);
    const correcting = quantity === undefined && existing.purchaseLines.length > 0;

    let loggedQty = 0;
    let from: { poNumber: string; vendorName: string; eta: Date } | null = null;
    if (correcting) {
      // The latest line is the one being corrected - audit keeps what it looked like before.
      const latest = [...existing.purchaseLines].sort((a, b) => b.loggedAt.getTime() - a.loggedAt.getTime())[0]!;
      from = { poNumber: latest.piNumber, vendorName: latest.vendorName, eta: latest.eta };
      loggedQty = latest.quantity;
      await prisma.requirementPurchaseLine.update({ where: { id: latest.id }, data: { piNumber: poNumber, vendorName, eta, correctedAt: new Date() } });
    } else {
      if (remainingToLog <= QTY_EPS) return res.status(409).json({ error: "Everything that is short is already on a PI — nothing left to log" });
      loggedQty = quantity ?? remainingToLog;
      if (loggedQty > remainingToLog + QTY_EPS) return res.status(400).json({ error: `Only ${remainingToLog} ${existing.unit} is left to log against this shortfall` });
      await prisma.requirementPurchaseLine.create({ data: { requirementId: existing.id, quantity: loggedQty, piNumber: poNumber, vendorName, eta, loggedById: req.user!.id } });
    }
    await syncRequirementSummary(existing.id);
    const updated = await prisma.preInventoryRequirement.findUniqueOrThrow({ where: { id: existing.id }, include: requirementInclude });

    await recordAudit({
      actorId: req.user!.id,
      action: correcting ? "pre_inventory.purchase_corrected" : "pre_inventory.purchase_logged",
      entityType: "PreInventoryRequirement",
      entityId: updated.id,
      metadata: correcting ? { poNumber, vendorName, eta, quantity: loggedQty, from } : { poNumber, vendorName, eta, quantity: loggedQty },
    });

    await Promise.all([
      notifyUser(updated.requestedById, {
        title: correcting ? `PI details updated for ${existing.item.name}` : `PI logged for ${existing.item.name}`,
        body: `${loggedQty} ${existing.unit} · ${poNumber} — ${vendorName}, ETA ${new Date(eta).toLocaleDateString()}`,
        link: "/pre-inventory",
      }).catch(notifyFailed(req, "pre_inventory.purchase_logged.requester")),
      notifyRoles(["ACCOUNTS"], { title: `New PI to plan for: ${poNumber}`, body: `${vendorName} — ${loggedQty} ${existing.unit} ${existing.item.name}`, link: "/pre-inventory" }, req.user!.id).catch(
        notifyFailed(req, "pre_inventory.purchase_logged.accounts"),
      ),
    ]);

    const [withStock] = await withLiveStock([updated]);
    res.json(withStock);
  } catch (err) {
    next(err);
  }
});

// Edit one logged PI line - its PI Number / Vendor / ETA any time while it is open, its
// quantity too as long as the total stays within the shortfall and not below what has
// already arrived on it.
preInventoryRouter.patch("/:id/lines/:lineId", requireRole("PURCHASE"), validateBody(updatePurchaseLineSchema), async (req: AuthedRequest<{ id: string; lineId: string }>, res, next) => {
  try {
    const existing = await prisma.preInventoryRequirement.findUnique({ where: { id: req.params.id }, include: { item: true, purchaseLines: true } });
    if (!existing || existing.deletedAt) return res.status(404).json({ error: "Requirement not found" });
    const line = existing.purchaseLines.find((l) => l.id === req.params.lineId);
    if (!line) return res.status(404).json({ error: "PI line not found" });
    if (line.status === "RECEIVED") return res.status(409).json({ error: "This PI line has already been received — it can't be edited" });

    const { poNumber, vendorName, eta, quantity } = req.body as UpdatePurchaseLineInput;
    await assertVendorAllowed(existing, vendorName);
    const data: Prisma.RequirementPurchaseLineUpdateInput = { piNumber: poNumber, vendorName, eta, correctedAt: new Date() };

    if (quantity !== undefined && Math.abs(quantity - line.quantity) > QTY_EPS) {
      if (quantity < line.receivedQty - QTY_EPS) return res.status(400).json({ error: `${line.receivedQty} ${existing.unit} of this line has already arrived — the quantity can't go below that` });
      const onHand = await getTotalAvailableByItemId([existing.itemId]);
      const others = existing.purchaseLines.filter((l) => l.id !== line.id);
      const { remainingToLog } = summarizeLines(others, existing.requiredQty - (onHand.get(existing.itemId) ?? 0));
      if (quantity > remainingToLog + QTY_EPS) return res.status(400).json({ error: `Only ${remainingToLog} ${existing.unit} can go on this line` });
      data.quantity = quantity;
    }

    await prisma.requirementPurchaseLine.update({ where: { id: line.id }, data });
    await syncRequirementSummary(existing.id);
    await recordAudit({
      actorId: req.user!.id,
      action: "pre_inventory.purchase_line_corrected",
      entityType: "PreInventoryRequirement",
      entityId: existing.id,
      metadata: { lineId: line.id, to: { poNumber, vendorName, eta, quantity: data.quantity ?? line.quantity }, from: { poNumber: line.piNumber, vendorName: line.vendorName, eta: line.eta, quantity: line.quantity } },
    });
    await notifyUser(existing.requestedById, {
      title: `PI details updated for ${existing.item.name}`,
      body: `${data.quantity ?? line.quantity} ${existing.unit} · ${poNumber} — ${vendorName}, ETA ${new Date(eta).toLocaleDateString()}`,
      link: "/pre-inventory",
    }).catch(notifyFailed(req, "pre_inventory.purchase_line_corrected.requester"));

    const updated = await prisma.preInventoryRequirement.findUniqueOrThrow({ where: { id: existing.id }, include: requirementInclude });
    const [withStock] = await withLiveStock([updated]);
    res.json(withStock);
  } catch (err) {
    next(err);
  }
});

// Remove a PI line - only while nothing of it has arrived (a line that was received is history).
preInventoryRouter.delete("/:id/lines/:lineId", requireRole("PURCHASE"), async (req: AuthedRequest<{ id: string; lineId: string }>, res, next) => {
  try {
    const existing = await prisma.preInventoryRequirement.findUnique({ where: { id: req.params.id }, include: { item: true, purchaseLines: true } });
    if (!existing || existing.deletedAt) return res.status(404).json({ error: "Requirement not found" });
    const line = existing.purchaseLines.find((l) => l.id === req.params.lineId);
    if (!line) return res.status(404).json({ error: "PI line not found" });
    if (line.receivedQty > QTY_EPS || line.status === "RECEIVED") return res.status(409).json({ error: "Part of this PI line has already arrived — it can't be removed" });

    await prisma.requirementPurchaseLine.delete({ where: { id: line.id } });
    await syncRequirementSummary(existing.id);
    await recordAudit({
      actorId: req.user!.id,
      action: "pre_inventory.purchase_line_removed",
      entityType: "PreInventoryRequirement",
      entityId: existing.id,
      metadata: { lineId: line.id, poNumber: line.piNumber, vendorName: line.vendorName, quantity: line.quantity },
    });
    await notifyUser(existing.requestedById, {
      title: `PI removed for ${existing.item.name}`,
      body: `${line.quantity} ${existing.unit} · ${line.piNumber} — ${line.vendorName} is no longer on order.`,
      link: "/pre-inventory",
    }).catch(notifyFailed(req, "pre_inventory.purchase_line_removed.requester"));

    const updated = await prisma.preInventoryRequirement.findUniqueOrThrow({ where: { id: existing.id }, include: requirementInclude });
    const [withStock] = await withLiveStock([updated]);
    res.json(withStock);
  } catch (err) {
    next(err);
  }
});

// PPIC's own explicit "Send to Purchase" — per the client, a shortfall
// existing isn't reason enough for the system to tell Purchase on its
// own; PPIC decides when it's actually worth raising. One-time per
// requirement — purchaseNotifiedAt is stamped on success and the route
// (and the button, client-side) refuses a repeat until Purchase actually
// logs a PO, so a PPIC user double/triple-clicking doesn't spam Purchase
// with duplicate notifications for the same shortfall.
preInventoryRouter.post("/:id/notify-purchase", requireRole("PPIC"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.preInventoryRequirement.findUnique({ where: { id: req.params.id }, include: requirementInclude });
    if (!existing || existing.deletedAt) return res.status(404).json({ error: "Requirement not found" });
    if (existing.purchaseNotifiedAt) return res.status(409).json({ error: "Purchase has already been notified about this shortfall." });

    const [withStock] = await withLiveStock([existing]);
    if (withStock!.shortQty <= 0) return res.status(400).json({ error: "This item isn't actually short against live stock right now — nothing to send." });
    if (existing.purchaseLines.length > 0 && withStock!.remainingToLog <= QTY_EPS) return res.status(409).json({ error: "A PI has already been logged against this one." });

    await notifyRoles(
      ["PURCHASE"],
      { title: `Shortfall: ${existing.item.name}`, body: `${withStock!.shortQty} ${existing.unit} short (${withStock!.currentStock} on hand) — log a PI.`, link: "/pre-inventory" },
      req.user!.id,
    );

    const updated = await prisma.preInventoryRequirement.update({ where: { id: existing.id }, data: { purchaseNotifiedAt: new Date() }, include: requirementInclude });

    await recordAudit({ actorId: req.user!.id, action: "pre_inventory.sent_to_purchase", entityType: "PreInventoryRequirement", entityId: existing.id, metadata: { shortQty: withStock!.shortQty } });

    const [withStockUpdated] = await withLiveStock([updated]);
    res.json(withStockUpdated);
  } catch (err) {
    next(err);
  }
});

preInventoryRouter.delete("/:id", requireRole("PPIC", "STORE"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.preInventoryRequirement.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.deletedAt) return res.status(404).json({ error: "Requirement not found" });
    if (existing.purchaseAt) return res.status(409).json({ error: "A PI has already been logged against this — it can't be removed" });

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
