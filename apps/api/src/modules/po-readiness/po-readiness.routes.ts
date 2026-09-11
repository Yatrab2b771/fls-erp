import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles } from "../../common/lib/notify";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { createPoRequirementSchema, importPoRequirementsSchema, type CreatePoRequirementInput, type ImportPoRequirementsInput } from "./po-readiness.schemas";
import { computeReadiness } from "./readiness-engine";

// --- PO Material Readiness — from the PPIC requirement conversation
// (2026-08-25). PPIC bulk-uploads, per PO, exactly which RM/PM items and
// quantities that PO needs; as stock arrives, this module tells them
// which POs now have everything they need, without anyone checking a
// 450-item consolidated sheet PO by PO. See the schema.prisma comment on
// PoMaterialRequirement for the full business context. ---

export const poReadinessRouter = Router();

poReadinessRouter.use(requireAuth);

// --- Manual single-row add — "Add Manually" next to the bulk Excel
// upload, same pattern as every other module's manual-plus-bulk pair.
// purchaseOrderId/itemId are picked from real dropdowns (existing POs,
// existing catalog items), so unlike the bulk import there's no
// resolve-or-create/unmatched-number path to worry about here — both
// ids are already known-good by the time this fires. ---

poReadinessRouter.post("/", requireRole("PPIC"), validateBody(createPoRequirementSchema), async (req: AuthedRequest, res, next) => {
  try {
    const data = req.body as CreatePoRequirementInput;

    const purchaseOrder = await prisma.purchaseOrder.findUnique({ where: { id: data.purchaseOrderId } });
    if (!purchaseOrder) return res.status(400).json({ error: "Unknown purchase order" });

    const item = await prisma.inventoryItem.findUnique({ where: { id: data.itemId } });
    if (!item) return res.status(400).json({ error: "Unknown inventory item" });
    if (item.category !== data.category) return res.status(400).json({ error: "Category doesn't match the selected item" });

    // Same upsert-on-(PO, item) as the bulk path — re-adding the same
    // pair from the form is a correction (update the quantity), not a
    // duplicate row PPIC would have to notice and clean up themselves.
    // If that (PO, item) pair was previously soft-deleted, this same
    // unique key matches the deleted row — clearing deletedAt/deletedById
    // on the update branch "un-deletes" it in place instead of leaving a
    // resurrected-but-still-hidden row behind.
    const requirement = await prisma.poMaterialRequirement.upsert({
      where: { purchaseOrderId_itemId: { purchaseOrderId: data.purchaseOrderId, itemId: data.itemId } },
      create: { ...data, createdById: req.user!.id },
      update: { requiredQty: data.requiredQty, unit: data.unit, category: data.category, deletedAt: null, deletedById: null },
      include: { item: true, purchaseOrder: { select: { poNumber: true } } },
    });

    await recordAudit({
      actorId: req.user!.id,
      action: "po_readiness.requirement_added",
      entityType: "PoMaterialRequirement",
      entityId: requirement.id,
      metadata: { purchaseOrderId: data.purchaseOrderId, itemId: data.itemId, requiredQty: data.requiredQty },
    });

    res.status(201).json(requirement);
  } catch (err) {
    next(err);
  }
});

// --- Bulk upload — resolve-or-create items same as every other Inventory
// import, but poNumber is matched against an *existing* PurchaseOrder,
// never created here — a requirement has to belong to a PO BD already
// entered. Unmatched PO numbers are skipped and reported back, same
// "tell them what didn't match instead of silently dropping it" rule as
// the Dispatch Transfer bulk import's unknownCustomers. ---

poReadinessRouter.post("/import", requireRole("PPIC"), validateBody(importPoRequirementsSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = req.body as ImportPoRequirementsInput;

    const uniquePoNumbers = [...new Set(rows.map((r) => r.poNumber))];
    const purchaseOrders = await prisma.purchaseOrder.findMany({ where: { poNumber: { in: uniquePoNumbers } }, select: { id: true, poNumber: true } });
    const poIdByNumber = new Map(purchaseOrders.map((po) => [po.poNumber!, po.id]));

    const unmatchedPoNumbers = uniquePoNumbers.filter((n) => !poIdByNumber.has(n));
    const usableRows = rows.filter((r) => poIdByNumber.has(r.poNumber));

    // Resolve every distinct (category, name) pair to an item id up
    // front, creating any item this sheet mentions for the first time —
    // same one-upsert-per-unique-item pattern as every other bulk
    // import in this module.
    const uniqueItems = new Map<string, { category: "RM" | "PM"; name: string }>();
    for (const row of usableRows) uniqueItems.set(`${row.category}::${row.itemName}`, { category: row.category, name: row.itemName });

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

    // Upsert on (purchaseOrderId, itemId) — a corrected re-upload updates
    // the quantity in place instead of piling up a duplicate row PPIC
    // would have to notice and clean up themselves.
    let rowsImported = 0;
    for (const row of usableRows) {
      const purchaseOrderId = poIdByNumber.get(row.poNumber)!;
      const itemId = itemIds.get(`${row.category}::${row.itemName}`)!;
      await prisma.poMaterialRequirement.upsert({
        where: { purchaseOrderId_itemId: { purchaseOrderId, itemId } },
        create: { purchaseOrderId, itemId, category: row.category, requiredQty: row.requiredQty, unit: row.unit, createdById: req.user!.id },
        // deletedAt/deletedById cleared — see the manual-add route's own
        // comment on this same pattern for why.
        update: { requiredQty: row.requiredQty, unit: row.unit, category: row.category, deletedAt: null, deletedById: null },
      });
      rowsImported += 1;
    }

    await recordAudit({
      actorId: req.user!.id,
      action: "po_readiness.requirements_imported",
      entityType: "PoMaterialRequirement",
      metadata: { rowsImported, itemsCreated, poCount: new Set(usableRows.map((r) => r.poNumber)).size, unmatchedCount: unmatchedPoNumbers.length },
    });

    res.status(201).json({ rowsImported, itemsCreated, unmatchedPoNumbers });
  } catch (err) {
    next(err);
  }
});

// --- Reusable by other modules — Packaging BOM / RM Costing's own
// "Send to Pre-Inventory" button calls this too, when the plan being sent
// is linked to a real PO (BomPlan.purchaseOrderItemId /
// RmPlan.purchaseOrderItemId): if the system already knows which PO this
// packaging/formulation is for, PPIC shouldn't have to separately
// re-enter the exact same (item, quantity) pairs here by hand — same
// "Generate already knows the PO" reasoning as the PO detail page's
// Generate button. Same upsert-on-(PO, item) pattern as the manual-add
// and bulk-import routes above, including the same soft-delete
// resurrection handling. ---
export interface PoRequirementSourceRow {
  category: "RM" | "PM";
  itemName: string;
  unit: string;
  requiredQty: number;
}

export async function createPoMaterialRequirements(
  purchaseOrderId: string,
  rows: PoRequirementSourceRow[],
  actorId: string,
): Promise<{ rowsCreated: number; itemsCreated: number }> {
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

  let rowsCreated = 0;
  for (const row of rows) {
    const itemId = itemIds.get(`${row.category}::${row.itemName}`)!;
    await prisma.poMaterialRequirement.upsert({
      where: { purchaseOrderId_itemId: { purchaseOrderId, itemId } },
      create: { purchaseOrderId, itemId, category: row.category, requiredQty: row.requiredQty, unit: row.unit, createdById: actorId },
      update: { requiredQty: row.requiredQty, unit: row.unit, category: row.category, deletedAt: null, deletedById: null },
    });
    rowsCreated += 1;
  }
  return { rowsCreated, itemsCreated };
}

// --- Readiness computation itself lives in ./readiness-engine (computeReadiness) —
// pulled out so the Batch pipeline's creation gate can reuse it without
// importing a route file. ---

// GET /?ready=true — every PO with at least one requirement row, live
// readiness attached. ?ready=true narrows to only the ones fully
// covered — this is what the dashboard tile's count and the "click to
// see which POs" list both read.
poReadinessRouter.get("/", requireRole("PPIC"), async (req, res, next) => {
  try {
    const ready = req.query.ready === "true";
    const pagination = parsePagination(req);

    const all = await computeReadiness();
    const filtered = ready ? all.filter((r) => r.isReady) : all;

    setPaginationHeaders(res, filtered.length, pagination);
    res.json(filtered.slice(pagination.skip, pagination.skip + pagination.take));
  } catch (err) {
    next(err);
  }
});

poReadinessRouter.get("/:purchaseOrderId", requireRole("PPIC"), async (req: AuthedRequest<{ purchaseOrderId: string }>, res, next) => {
  try {
    const [row] = await computeReadiness([req.params.purchaseOrderId]);
    if (!row) return res.status(404).json({ error: "No material requirements logged for this PO" });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

poReadinessRouter.delete("/:purchaseOrderId/items/:itemId", requireRole("PPIC"), async (req: AuthedRequest<{ purchaseOrderId: string; itemId: string }>, res, next) => {
  try {
    const existing = await prisma.poMaterialRequirement.findUnique({
      where: { purchaseOrderId_itemId: { purchaseOrderId: req.params.purchaseOrderId, itemId: req.params.itemId } },
    });
    if (!existing || existing.deletedAt) return res.status(404).json({ error: "Requirement row not found" });

    await prisma.poMaterialRequirement.update({ where: { id: existing.id }, data: { deletedAt: new Date(), deletedById: req.user!.id } });
    await recordAudit({ actorId: req.user!.id, action: "po_readiness.requirement_removed", entityType: "PoMaterialRequirement", entityId: existing.id });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// --- Notification — fires when stock arriving for one item flips a PO
// from "not ready" to "ready". Same "0 -> positive crossing" reasoning
// as stock.ts notifyIfNewlyAvailable, extended to a whole PO's worth of
// items instead of one: since only *one* item's stock just changed
// (by addedQty), that item's "before" balance is just its current
// balance minus addedQty — every other item on the same PO already
// reflects its real current stock, unaffected by this receipt. So
// "was this PO ready a moment ago" is computable without storing any
// extra state, same as the single-item version. Called from the same
// three call sites notifyIfNewlyAvailable already is (accept, opening
// stock single + bulk) — anywhere stock genuinely goes up. ---

export async function notifyIfPoNewlyReady(params: { itemId: string; addedQty: number; actorId: string; onFail: (label: string) => (err: unknown) => void }): Promise<void> {
  const { itemId, addedQty, actorId, onFail } = params;
  if (addedQty <= 0) return;

  const referencingPos = await prisma.poMaterialRequirement.findMany({ where: { itemId }, select: { purchaseOrderId: true } });
  if (referencingPos.length === 0) return; // no PO asked for this item — nothing to check

  const affectedPos = await computeReadiness(referencingPos.map((r) => r.purchaseOrderId));

  const newlyReady = affectedPos.filter((po) => {
    if (!po.isReady) return false; // not ready now — nothing to announce
    // Reconstruct "a moment ago": only itemId's balance moves, by
    // subtracting this receipt back out of it.
    const wasReadyBefore = po.items.every((it) => (it.itemId === itemId ? it.onHand - addedQty : it.onHand) >= it.requiredQty);
    return !wasReadyBefore;
  });

  if (newlyReady.length === 0) return;

  await Promise.all(
    newlyReady.map((po) =>
      notifyRoles(
        ["PPIC"],
        {
          title: `PO ${po.purchaseOrder.poNumber ?? po.purchaseOrder.id.slice(0, 8)} is ready to execute`,
          body: `${po.purchaseOrder.customer.companyName} — all ${po.totalItems} required RM/PM items are now in stock.`,
          link: "/po-readiness",
        },
        actorId,
      ).catch(onFail(`po_readiness.newly_ready.${po.purchaseOrder.id}`)),
    ),
  );
}
