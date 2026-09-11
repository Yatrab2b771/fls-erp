import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { findSimilar } from "../../common/lib/fuzzy-match";
import { ensureRecipeRequest } from "../recipe-requests/recipe-request.routes";
import { addPlanItemSchema, createPlanSchema } from "./bom-plan.schemas";
import { calculateMasterBOM, hasBomSpec, type BomPlanLineInput, type BomResult } from "./bom-engine";
import { buildMasterBomWorkbook } from "./bom-export";
import { buildMasterBomPdf } from "./bom-pdf";
import { bulkCreateRequirements, type RequirementSourceRow } from "../inventory/pre-inventory.routes";
import { createPoMaterialRequirements } from "../po-readiness/po-readiness.routes";
import { createMaterialRequestsFromPlan } from "../inventory/inventory.routes";
import { Prisma } from "@prisma/client";

export const bomPlanRouter = Router();

bomPlanRouter.use(requireAuth);

function serializePlan(
  plan: {
    id: string;
    name: string;
    dateFrom: Date | null;
    dateTo: Date | null;
    status: string;
    calculatedAt: Date | null;
    createdAt: Date;
    // Included so reopening an already-calculated plan can render its last
    // result immediately, instead of showing an empty table until Calculate
    // is clicked again — same snapshot POST /calculate and the export
    // endpoints already read, just also exposed on GET.
    resultSnapshot: unknown;
    // Set once Send to Pre-Inventory succeeds — the frontend disables the
    // button while this is set, and POST /send-to-pre-inventory refuses a
    // second send server-side too, not just a UI-level disable.
    sentToPreInventoryAt: Date | null;
    items: { id: string; targetYield: number; sku: { id: string; productName: string; customer: { companyName: string } } }[];
    purchaseOrderItemId: string | null;
    purchaseOrderItem: { id: string; productName: string; purchaseOrder: { id: string; poNumber: string | null } } | null;
  },
  // Populated only when this plan is linked to a PO item, still has no
  // queued SKUs, and a near-name-match exists in the catalog — see
  // findSkuSuggestions. Lets the frontend offer "did you mean X?" instead
  // of only the "request from R&D" framing when the real problem is a
  // typo, not a missing formulation.
  suggestions?: { skuId: string; customerName: string; productName: string; score: number; targetYield: number }[],
) {
  return {
    id: plan.id,
    name: plan.name,
    dateFrom: plan.dateFrom,
    dateTo: plan.dateTo,
    status: plan.status,
    calculatedAt: plan.calculatedAt,
    createdAt: plan.createdAt,
    sentToPreInventoryAt: plan.sentToPreInventoryAt,
    result: plan.resultSnapshot ?? null,
    items: plan.items.map((i) => ({
      id: i.id,
      skuId: i.sku.id,
      customerName: i.sku.customer.companyName,
      productName: i.sku.productName,
      targetYield: i.targetYield,
    })),
    purchaseOrderItemId: plan.purchaseOrderItemId,
    linkedOrder: plan.purchaseOrderItem
      ? { productName: plan.purchaseOrderItem.productName, poNumber: plan.purchaseOrderItem.purchaseOrder.poNumber, purchaseOrderId: plan.purchaseOrderItem.purchaseOrder.id }
      : null,
    suggestedSkus: suggestions && suggestions.length > 0 ? suggestions : undefined,
  };
}

// Only ever worth computing when the plan is otherwise stuck (linked to
// a PO item, but nothing's queued yet) — an already-queued plan has
// nothing to suggest a fix for. Scoped to the PO's own Customer the same
// way the exact-match lookup above already is, so a same-named product
// under a different customer never shows up as a false "did you mean".
async function findSkuSuggestions(poItem: { productName: string; quantity: number; purchaseOrderId: string } | null) {
  if (!poItem) return undefined;
  const order = await prisma.purchaseOrder.findUnique({ where: { id: poItem.purchaseOrderId }, select: { customerId: true } });
  const catalog = await prisma.sku.findMany({
    where: order ? { customerId: order.customerId } : {},
    include: { customer: true },
  });
  const targetYield = Math.max(1, Math.round(poItem.quantity));
  return findSimilar(poItem.productName, catalog, (s) => s.productName).map((c) => ({
    skuId: c.item.id,
    customerName: c.item.customer.companyName,
    productName: c.item.productName,
    score: c.score,
    targetYield,
  }));
}

const planInclude = {
  // deletedAt: null — a soft-deleted SKU line drops out of the plan the
  // instant it's removed, same as before, just recoverable now.
  items: { where: { deletedAt: null }, include: { sku: { include: { customer: true, packagingComponents: true } } } },
  purchaseOrderItem: { include: { purchaseOrder: { select: { id: true, poNumber: true } } } },
} satisfies Prisma.BomPlanInclude;

// Shared across the team, not scoped per-user — this is the persistent
// replacement for a browser-local "Plan Queue".
bomPlanRouter.get("/plans", async (req, res, next) => {
  try {
    const pagination = parsePagination(req);
    const [total, plans] = await Promise.all([
      prisma.bomPlan.count(),
      prisma.bomPlan.findMany({
        include: planInclude,
        orderBy: { createdAt: "desc" },
        skip: pagination.skip,
        take: pagination.take,
      }),
    ]);
    setPaginationHeaders(res, total, pagination);
    // Suggestions aren't computed for the list view — only worth the
    // extra lookups on a single plan someone's actually looking at.
    res.json(plans.map((p) => serializePlan(p)));
  } catch (err) {
    next(err);
  }
});

bomPlanRouter.post("/plans", validateBody(createPlanSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { name, dateFrom, dateTo, purchaseOrderItemId } = req.body as {
      name: string;
      dateFrom?: string;
      dateTo?: string;
      purchaseOrderItemId?: string;
    };

    let poItem: { productName: string; quantity: number; purchaseOrderId: string; productType: "EXISTING" | "NEW" } | null = null;
    if (purchaseOrderItemId) {
      poItem = await prisma.purchaseOrderItem.findUnique({ where: { id: purchaseOrderItemId }, select: { productName: true, quantity: true, purchaseOrderId: true, productType: true } });
      if (!poItem) return res.status(400).json({ error: "Unknown purchase order item" });
    }

    const plan = await prisma.bomPlan.create({
      data: {
        name,
        dateFrom: dateFrom ? new Date(dateFrom) : null,
        dateTo: dateTo ? new Date(dateTo) : null,
        createdById: req.user!.id,
        purchaseOrderItemId: purchaseOrderItemId ?? null,
      },
      include: planInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "bom_plan.created", entityType: "BomPlan", entityId: plan.id });

    // productType NEW — the gap is already known, not discovered by a
    // failed match, so skip straight to raising the RecipeRequest (or
    // handing back the one already open) instead of even attempting a
    // catalog match that can't succeed.
    if (poItem && poItem.productType === "NEW") {
      await ensureRecipeRequest(purchaseOrderItemId!, req.user!.id);
    }

    // "Generate" on the PO detail page — one click, both engines. If the
    // PO product's name matches exactly one catalog SKU (scoped to the
    // PO's own Customer, a real id now, not a free-text brand name),
    // queue it and calculate immediately so this plan comes back already
    // CALCULATED with a real result, instead of an empty Draft the
    // caller has to go fill in by hand on the full Packaging BOM page.
    // No match (zero or more than one candidate) just falls back to
    // today's empty-Draft behavior — same as before this existed.
    if (poItem && poItem.productType !== "NEW") {
      const order = await prisma.purchaseOrder.findUnique({ where: { id: poItem.purchaseOrderId }, select: { customerId: true } });
      const candidates = await prisma.sku.findMany({
        where: {
          productName: { equals: poItem.productName, mode: "insensitive" },
          ...(order ? { customerId: order.customerId } : {}),
        },
        include: { packagingComponents: true },
      });
      // A Sku row existing isn't the same as R&D having actually defined
      // its packaging — the PO form's own "+ New" product quick-add (and
      // R&D's manual "+ Add" before filling it in) both create a bare Sku
      // with neither the legacy flat fields nor any packagingComponents.
      // Auto-calculating off that produces a hollow, misleading
      // "CALCULATED" plan with nothing in it and ₹0 cost — so a real
      // match needs actual spec data too, same bar checkGap() now uses to
      // decide whether R&D still needs to hear about this.
      const realMatch = candidates.length === 1 && hasBomSpec({ spec: candidates[0]!, packagingComponents: candidates[0]!.packagingComponents }) ? candidates[0]! : null;
      if (realMatch) {
        const targetYield = Math.max(1, Math.round(poItem.quantity));
        await prisma.bomPlanItem.create({ data: { planId: plan.id, skuId: realMatch.id, targetYield, addedById: req.user!.id } });

        const withItems = await prisma.bomPlan.findUniqueOrThrow({ where: { id: plan.id }, include: planInclude });
        const inputs: BomPlanLineInput[] = withItems.items.map((i) => ({
          brandName: i.sku.customer.companyName,
          productName: i.sku.productName,
          targetYield: i.targetYield,
          spec: i.sku,
          packagingComponents: i.sku.packagingComponents,
        }));
        const result = calculateMasterBOM(inputs);

        await prisma.bomPlan.update({
          where: { id: plan.id },
          data: { status: "CALCULATED", calculatedAt: new Date(), resultSnapshot: result as unknown as Prisma.InputJsonValue },
        });
        await recordAudit({
          actorId: req.user!.id,
          action: "bom_plan.calculated",
          entityType: "BomPlan",
          entityId: plan.id,
          metadata: { totalYield: result.totalYield, lineCount: result.lines.length, autoGenerated: true },
        });
      } else {
        // No real match — don't make PPIC come back and click "Request
        // from R&D" by hand; the gap is already known the moment Generate
        // fails, same reasoning productType NEW already gets above.
        // ensureRecipeRequest is itself a no-op if a request is already
        // open, or if the catalog actually does cover this (nothing to
        // raise), so this is safe to call unconditionally here.
        await ensureRecipeRequest(purchaseOrderItemId!, req.user!.id);
      }
    }

    const finalPlan = await prisma.bomPlan.findUniqueOrThrow({ where: { id: plan.id }, include: planInclude });
    // Still empty after the exact-match attempt above? Look for a
    // near-name match before handing back a bare empty Draft — a typo'd
    // product name shouldn't read the same as a genuinely new one. Never
    // worth attempting for a declared-NEW product — there's nothing to
    // suggest, it's genuinely not in the catalog yet.
    const suggestions = finalPlan.items.length === 0 && poItem?.productType !== "NEW" ? await findSkuSuggestions(poItem) : undefined;
    res.status(201).json(serializePlan(finalPlan, suggestions));
  } catch (err) {
    next(err);
  }
});

bomPlanRouter.get("/plans/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const plan = await prisma.bomPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    const poItem = plan.purchaseOrderItemId
      ? await prisma.purchaseOrderItem.findUnique({ where: { id: plan.purchaseOrderItemId }, select: { productName: true, quantity: true, purchaseOrderId: true, productType: true } })
      : null;
    const suggestions = plan.items.length === 0 && poItem?.productType !== "NEW" ? await findSkuSuggestions(poItem) : undefined;
    res.json(serializePlan(plan, suggestions));
  } catch (err) {
    next(err);
  }
});

bomPlanRouter.post(
  "/plans/:id/items",
  validateBody(addPlanItemSchema),
  async (req: AuthedRequest<{ id: string }>, res, next) => {
    try {
      const plan = await prisma.bomPlan.findUnique({ where: { id: req.params.id } });
      if (!plan) return res.status(404).json({ error: "Plan not found" });

      const { skuId, targetYield } = req.body as { skuId: string; targetYield: number };
      const sku = await prisma.sku.findUnique({ where: { id: skuId } });
      if (!sku) return res.status(400).json({ error: "Unknown SKU" });

      await prisma.bomPlanItem.create({
        data: { planId: plan.id, skuId, targetYield, addedById: req.user!.id },
      });

      // Adding to the queue invalidates any prior calculation for this plan.
      await prisma.bomPlan.update({
        where: { id: plan.id },
        data: { status: "DRAFT", resultSnapshot: Prisma.JsonNull },
      });

      const updated = await prisma.bomPlan.findUniqueOrThrow({ where: { id: plan.id }, include: planInclude });
      res.status(201).json(serializePlan(updated));
    } catch (err) {
      next(err);
    }
  },
);

bomPlanRouter.delete(
  "/plans/:id/items/:itemId",
  async (req: AuthedRequest<{ id: string; itemId: string }>, res, next) => {
    try {
      await prisma.bomPlanItem.updateMany({
        where: { id: req.params.itemId, planId: req.params.id, deletedAt: null },
        data: { deletedAt: new Date(), deletedById: req.user!.id },
      });
      // Removing an item invalidates any prior calculation for this plan —
      // same rule POST /items already applies, previously missing here,
      // which left a stale resultSnapshot (for SKUs no longer queued)
      // sitting under a still-"CALCULATED" status.
      await prisma.bomPlan.updateMany({ where: { id: req.params.id }, data: { status: "DRAFT", resultSnapshot: Prisma.JsonNull } });
      const updated = await prisma.bomPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
      if (!updated) return res.status(404).json({ error: "Plan not found" });
      res.json(serializePlan(updated));
    } catch (err) {
      next(err);
    }
  },
);

// The server-side equivalent of the prototype's calculateMasterBOM() button —
// runs the same pure engine, but persists the result instead of holding it
// only in one browser tab's memory.
bomPlanRouter.post("/plans/:id/calculate", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const plan = await prisma.bomPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    if (plan.items.length === 0) return res.status(400).json({ error: "Plan has no queued SKUs" });

    // Same "existing isn't the same as defined" guard as Generate's own
    // auto-match — a manually-queued SKU with no real spec (R&D added it
    // by name but hasn't filled in packaging yet) would otherwise
    // "calculate" successfully into an empty, ₹0 result that reads as
    // done when it isn't.
    const emptySkus = plan.items.filter((item) => !hasBomSpec({ spec: item.sku, packagingComponents: item.sku.packagingComponents })).map((item) => item.sku.productName);
    if (emptySkus.length > 0) {
      return res.status(400).json({ error: `${emptySkus.join(", ")} has no packaging components yet — ask R&D to add its BOM spec before calculating.` });
    }

    const inputs: BomPlanLineInput[] = plan.items.map((item) => ({
      brandName: item.sku.customer.companyName,
      productName: item.sku.productName,
      targetYield: item.targetYield,
      spec: item.sku,
      packagingComponents: item.sku.packagingComponents,
    }));

    const result = calculateMasterBOM(inputs);

    const updated = await prisma.bomPlan.update({
      where: { id: plan.id },
      data: {
        status: "CALCULATED",
        calculatedAt: new Date(),
        resultSnapshot: result as unknown as Prisma.InputJsonValue,
        // A recalculation means the numbers may genuinely be different
        // now (items added/removed, catalog changed) — re-enable Send to
        // Pre-Inventory so the fresh result can go out, same "a real
        // change re-opens it" reasoning as sentToPreInventoryAt's own
        // comment on the model.
        sentToPreInventoryAt: null,
      },
      include: planInclude,
    });

    await recordAudit({
      actorId: req.user!.id,
      action: "bom_plan.calculated",
      entityType: "BomPlan",
      entityId: plan.id,
      metadata: { totalYield: result.totalYield, lineCount: result.lines.length },
    });

    res.json({ plan: serializePlan(updated), result });
  } catch (err) {
    next(err);
  }
});

// Turns a calculated BOM into Pre-Inventory requirements (S1) in one
// click — one PM requirement per component/spec line, quantity already
// including the wastage buffer. PPIC-only, matching who's allowed to
// raise a Pre-Inventory requirement by hand. Every packaging component
// here is a countable unit (jars, stickers, boxes...), never weighed,
// so unit is always "Count".
bomPlanRouter.post("/plans/:id/send-to-pre-inventory", requireRole("PPIC"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const plan = await prisma.bomPlan.findUnique({ where: { id: req.params.id } });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    if (!plan.resultSnapshot) return res.status(400).json({ error: "Plan has not been calculated yet — POST /plans/:id/calculate first" });
    // Server-side guard, not just the button being disabled client-side —
    // PreInventoryRequirement has no unique constraint to fall back on,
    // so a second send from the same unchanged result would silently
    // create a full duplicate set of rows. Recalculating (POST
    // /calculate) clears this and opens the door to a fresh send.
    if (plan.sentToPreInventoryAt) {
      return res.status(400).json({ error: "This plan's result was already sent to Pre-Inventory. Recalculate it first if you need to send an updated result." });
    }

    const result = plan.resultSnapshot as unknown as BomResult;
    const rows: RequirementSourceRow[] = result.lines
      .filter((line) => line.totalQty > 0)
      .map((line) => ({
        date: new Date(),
        category: "PM",
        itemName: `${line.component} — ${line.spec}`,
        unit: "Count",
        requiredQty: line.totalQty,
        note: `From BOM Plan "${plan.name}"`,
      }));

    if (rows.length === 0) return res.status(400).json({ error: "This plan's calculated result has nothing to send" });

    const outcome = await bulkCreateRequirements(rows, req.user!.id, req);

    // Also feed PO Readiness, and raise this PO's Material Requests, when
    // this plan is linked to a real PO — see createPoMaterialRequirements'
    // and createMaterialRequestsFromPlan's own comments for why.
    let poReadiness: { rowsCreated: number; itemsCreated: number } | null = null;
    let materialRequests: { rowsCreated: number } | null = null;
    if (plan.purchaseOrderItemId) {
      const poItem = await prisma.purchaseOrderItem.findUnique({
        where: { id: plan.purchaseOrderItemId },
        select: { purchaseOrderId: true, purchaseOrder: { select: { poNumber: true } } },
      });
      if (poItem) {
        poReadiness = await createPoMaterialRequirements(
          poItem.purchaseOrderId,
          rows.map((r) => ({ category: r.category, itemName: r.itemName, unit: r.unit, requiredQty: r.requiredQty })),
          req.user!.id,
        );
        materialRequests = await createMaterialRequestsFromPlan(
          rows.map((r) => ({ category: r.category, itemName: r.itemName, requiredQty: r.requiredQty })),
          req.user!.id,
          `Auto-raised from BOM Plan "${plan.name}" for PO ${poItem.purchaseOrder.poNumber ?? poItem.purchaseOrderId.slice(0, 8)}`,
        );
      }
    }

    await prisma.bomPlan.update({ where: { id: plan.id }, data: { sentToPreInventoryAt: new Date() } });

    await recordAudit({
      actorId: req.user!.id,
      action: "bom_plan.sent_to_pre_inventory",
      entityType: "BomPlan",
      entityId: plan.id,
      metadata: { ...outcome, poReadiness, materialRequests },
    });

    res.status(201).json({ ...outcome, poReadiness, materialRequests });
  } catch (err) {
    next(err);
  }
});

bomPlanRouter.get("/plans/:id/export.xlsx", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const plan = await prisma.bomPlan.findUnique({ where: { id: req.params.id } });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    if (!plan.resultSnapshot) {
      return res.status(400).json({ error: "Plan has not been calculated yet — POST /plans/:id/calculate first" });
    }

    const buffer = await buildMasterBomWorkbook(plan.resultSnapshot as never, {
      planName: plan.name,
      dateFrom: plan.dateFrom?.toISOString().slice(0, 10),
      dateTo: plan.dateTo?.toISOString().slice(0, 10),
    });

    await recordAudit({ actorId: req.user!.id, action: "bom_plan.exported", entityType: "BomPlan", entityId: plan.id });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="FLS_Master_BOM_${plan.id}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
});

bomPlanRouter.get("/plans/:id/export.pdf", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const plan = await prisma.bomPlan.findUnique({ where: { id: req.params.id } });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    if (!plan.resultSnapshot) {
      return res.status(400).json({ error: "Plan has not been calculated yet — POST /plans/:id/calculate first" });
    }

    const doc = buildMasterBomPdf(plan.resultSnapshot as never, {
      planName: plan.name,
      dateFrom: plan.dateFrom?.toISOString().slice(0, 10),
      dateTo: plan.dateTo?.toISOString().slice(0, 10),
    });

    await recordAudit({ actorId: req.user!.id, action: "bom_plan.exported_pdf", entityType: "BomPlan", entityId: plan.id });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="FLS_Master_BOM_${plan.id}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    next(err);
  }
});
