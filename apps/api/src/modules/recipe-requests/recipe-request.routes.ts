import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { logger } from "../../common/lib/logger";
import { createRecipeRequestSchema, giveEtaSchema, type CreateRecipeRequestInput, type GiveEtaInput } from "./recipe-request.schemas";
import { hasBomSpec } from "../packaging-bom/bom-engine";
import type { RecipeRequestStatus } from "@prisma/client";

export const recipeRequestRouter = Router();

recipeRequestRouter.use(requireAuth);

const requestInclude = {
  purchaseOrderItem: { select: { id: true, productName: true, purchaseOrder: { select: { id: true, poNumber: true } } } },
  requestedBy: { select: { fullName: true, email: true } },
  respondedBy: { select: { fullName: true, email: true } },
} as const;

function serializeRequest(r: {
  id: string;
  productName: string;
  customerName: string | null;
  bomNeeded: boolean;
  rmNeeded: boolean;
  bomFulfilledAt: Date | null;
  rmFulfilledAt: Date | null;
  status: string;
  requestedAt: Date;
  etaDate: Date | null;
  etaNote: string | null;
  respondedAt: Date | null;
  readyAt: Date | null;
  purchaseOrderItem: { id: string; productName: string; purchaseOrder: { id: string; poNumber: string | null } };
  requestedBy: { fullName: string; email: string };
  respondedBy: { fullName: string; email: string } | null;
}) {
  return {
    id: r.id,
    productName: r.productName,
    customerName: r.customerName,
    bomNeeded: r.bomNeeded,
    rmNeeded: r.rmNeeded,
    bomFulfilledAt: r.bomFulfilledAt,
    rmFulfilledAt: r.rmFulfilledAt,
    status: r.status,
    requestedAt: r.requestedAt,
    etaDate: r.etaDate,
    etaNote: r.etaNote,
    respondedAt: r.respondedAt,
    readyAt: r.readyAt,
    requestedByName: r.requestedBy.fullName || r.requestedBy.email,
    respondedByName: r.respondedBy ? r.respondedBy.fullName || r.respondedBy.email : null,
    purchaseOrderId: r.purchaseOrderItem.purchaseOrder.id,
    poNumber: r.purchaseOrderItem.purchaseOrder.poNumber,
  };
}

// Same auto-match rules "Generate" itself uses (see bom-plan.routes.ts /
// rm-plan.routes.ts POST /plans) — a request should only ever cover
// whichever side genuinely has no catalog match yet, never re-derived
// from anything the client sends.
async function checkGap(purchaseOrderItemId: string): Promise<{ productName: string; customerId: string; customerName: string; bomNeeded: boolean; rmNeeded: boolean } | null> {
  const poItem = await prisma.purchaseOrderItem.findUnique({
    where: { id: purchaseOrderItemId },
    select: { productName: true, unit: true, purchaseOrder: { select: { customerId: true, customer: { select: { companyName: true } } } } },
  });
  if (!poItem) return null;

  const skuMatch = await prisma.sku.findFirst({
    where: { productName: { equals: poItem.productName, mode: "insensitive" }, customerId: poItem.purchaseOrder.customerId },
    include: { packagingComponents: true },
  });
  // A Sku existing isn't the same as R&D having defined its packaging —
  // see bom-engine.ts's hasBomSpec, the one shared definition of "real
  // match" bom-plan.routes.ts's Generate/Calculate also use. Only a Sku
  // that actually carries real spec data (flat fields or the components
  // list) closes the gap.
  const bomNeeded = !skuMatch || !hasBomSpec({ spec: skuMatch, packagingComponents: skuMatch.packagingComponents });

  // Same Kg-only gate RM Costing's own auto-match uses — if the PO
  // line's unit isn't Kg, RM Costing was never going to apply here
  // regardless of the catalog, so there's nothing to ask R&D for.
  const isKgUnit = /^kgs?$/i.test(poItem.unit.trim());
  const recipeMatch = isKgUnit ? await prisma.recipe.findFirst({ where: { name: { equals: poItem.productName, mode: "insensitive" } } }) : true;
  const rmNeeded = isKgUnit && !recipeMatch;

  return { productName: poItem.productName, customerId: poItem.purchaseOrder.customerId, customerName: poItem.purchaseOrder.customer.companyName, bomNeeded, rmNeeded };
}

// The shared "raise it (or hand back the one already open)" logic —
// factored out so it's callable both from the route below (PPIC's own
// explicit "Request from R&D" click after Generate finds no match) and
// from bom-plan.routes.ts/rm-plan.routes.ts's own POST /plans, when the
// linked PO item's productType is NEW: there the gap isn't discovered by
// a failed catalog match, it's already known upfront, so this fires
// immediately instead of waiting for a Generate attempt to fail first.
// `created: false` distinguishes "here's the one already open" (the
// route below turns this into a 200) from "just raised a new one" (201)
// — callers that don't care (bom-plan.routes.ts/rm-plan.routes.ts's own
// auto-raise) can just ignore it. Returns null only when the item
// doesn't exist or the catalog actually already covers it (nothing to
// raise) — never throws for that case, so callers that just want to
// "try and move on" don't need a try/catch.
export async function ensureRecipeRequest(purchaseOrderItemId: string, requestedById: string): Promise<{ created: boolean; request: ReturnType<typeof serializeRequest> } | null> {
  const existing = await prisma.recipeRequest.findFirst({
    where: { purchaseOrderItemId, status: { in: ["PENDING", "ETA_GIVEN"] } },
    include: requestInclude,
  });
  if (existing) return { created: false, request: serializeRequest(existing) };

  const gap = await checkGap(purchaseOrderItemId);
  if (!gap || (!gap.bomNeeded && !gap.rmNeeded)) return null;

  const request = await prisma.recipeRequest.create({
    data: {
      purchaseOrderItemId,
      productName: gap.productName,
      customerName: gap.customerName,
      bomNeeded: gap.bomNeeded,
      rmNeeded: gap.rmNeeded,
      requestedById,
    },
    include: requestInclude,
  });

  await recordAudit({
    actorId: requestedById,
    action: "recipe_request.created",
    entityType: "RecipeRequest",
    entityId: request.id,
    metadata: { productName: gap.productName, bomNeeded: gap.bomNeeded, rmNeeded: gap.rmNeeded },
  });

  await notifyRoles(
    ["RND"],
    { title: `Recipe/BOM needed: ${gap.productName}`, body: `Requested by ${request.requestedBy.fullName || request.requestedBy.email}`, link: "/rnd" },
    requestedById,
  ).catch((err) => logger.error({ err }, "notify failed: recipe_request.created"));

  return { created: true, request: serializeRequest(request) };
}

// PPIC's own call — "Generate" found no match, and PPIC (not the system)
// decides this is worth asking R&D for, rather than every unmatched
// Generate silently spawning a request no one asked for.
recipeRequestRouter.post("/", requireRole("PPIC"), validateBody(createRecipeRequestSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { purchaseOrderItemId } = req.body as CreateRecipeRequestInput;

    const poItem = await prisma.purchaseOrderItem.findUnique({ where: { id: purchaseOrderItemId } });
    if (!poItem) return res.status(400).json({ error: "Unknown purchase order item" });

    const gapCheck = await checkGap(purchaseOrderItemId);
    if (gapCheck && !gapCheck.bomNeeded && !gapCheck.rmNeeded) {
      return res.status(400).json({ error: "The catalog already has a match for this product — use Generate directly, no need to ask R&D." });
    }

    const result = await ensureRecipeRequest(purchaseOrderItemId, req.user!.id);
    if (!result) return res.status(400).json({ error: "Unknown purchase order item" });

    res.status(result.created ? 201 : 200).json(result.request);
  } catch (err) {
    next(err);
  }
});

// PPIC sees its own asks; R&D/ADMIN see the whole queue.
recipeRequestRouter.get("/", requireRole("PPIC", "RND"), async (req: AuthedRequest, res, next) => {
  try {
    const { status, purchaseOrderItemId } = req.query as { status?: string; purchaseOrderItemId?: string };
    const isRnd = req.user!.roles.includes("RND") || req.user!.roles.includes("ADMIN");
    const requests = await prisma.recipeRequest.findMany({
      where: {
        ...(status ? { status: status as RecipeRequestStatus } : {}),
        ...(purchaseOrderItemId ? { purchaseOrderItemId } : {}),
        ...(isRnd ? {} : { requestedById: req.user!.id }),
      },
      include: requestInclude,
      orderBy: { requestedAt: "desc" },
    });
    res.json(requests.map(serializeRequest));
  } catch (err) {
    next(err);
  }
});

// R&D commits to a date — editable again later if it slips, same
// "correct it, don't re-litigate it" reasoning as anywhere else in this
// app that supports amending a call after the fact.
recipeRequestRouter.patch("/:id/eta", requireRole("RND"), validateBody(giveEtaSchema), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const existing = await prisma.recipeRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Request not found" });
    if (existing.status === "READY") return res.status(400).json({ error: "This request is already fulfilled." });

    const { etaDate, etaNote } = req.body as GiveEtaInput;
    const updated = await prisma.recipeRequest.update({
      where: { id: existing.id },
      data: { etaDate, etaNote, status: "ETA_GIVEN", respondedById: req.user!.id, respondedAt: new Date() },
      include: requestInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "recipe_request.eta_given", entityType: "RecipeRequest", entityId: updated.id, metadata: { etaDate } });

    await notifyUser(updated.requestedById, {
      title: `R&D ETA: ${updated.productName}`,
      body: `Ready by ${new Date(etaDate).toLocaleDateString()}${etaNote ? ` — ${etaNote}` : ""}`,
      link: "/rnd",
    }).catch((err) => req.log?.error({ err }, "notify failed: recipe_request.eta_given"));

    res.json(serializeRequest(updated));
  } catch (err) {
    next(err);
  }
});

// --- Called from catalog.routes.ts POST /import and
// recipe-catalog.routes.ts POST /recipes/import right after each
// Sku/Recipe upsert — not a route of its own. This is how a request
// actually gets fulfilled: R&D uploading a matching catalog entry, not a
// separate manual "mark ready" click. A request needing both sides isn't
// READY until both have shown up. ---

export async function resolveBomRequests(customerId: string, productName: string): Promise<void> {
  // A Sku upsert alone doesn't mean R&D actually defined the packaging —
  // same bar checkGap() uses. Re-checked here (not passed in by the
  // caller) so every call site — quick-add, manual edit, bulk Import
  // Catalog — gets this for free without each one having to remember it.
  const sku = await prisma.sku.findFirst({ where: { customerId, productName: { equals: productName, mode: "insensitive" } }, include: { packagingComponents: true } });
  if (!sku || !hasBomSpec({ spec: sku, packagingComponents: sku.packagingComponents })) return;

  const requests = await prisma.recipeRequest.findMany({
    where: { status: { in: ["PENDING", "ETA_GIVEN"] }, bomNeeded: true, bomFulfilledAt: null, productName: { equals: productName, mode: "insensitive" } },
    include: { purchaseOrderItem: { select: { purchaseOrder: { select: { customerId: true } } } } },
  });
  for (const r of requests) {
    if (r.purchaseOrderItem.purchaseOrder.customerId !== customerId) continue;
    const nowReady = !r.rmNeeded || !!r.rmFulfilledAt;
    const updated = await prisma.recipeRequest.update({
      where: { id: r.id },
      data: { bomFulfilledAt: new Date(), ...(nowReady ? { status: "READY", readyAt: new Date() } : {}) },
    });
    if (nowReady) {
      await notifyUser(updated.requestedById, { title: `Recipe/BOM ready: ${updated.productName}`, body: "R&D has uploaded what was missing — Generate again.", link: "/rnd" }).catch(() => {});
    }
  }
}

export async function resolveRmRequests(recipeName: string): Promise<void> {
  const requests = await prisma.recipeRequest.findMany({
    where: { status: { in: ["PENDING", "ETA_GIVEN"] }, rmNeeded: true, rmFulfilledAt: null, productName: { equals: recipeName, mode: "insensitive" } },
  });
  for (const r of requests) {
    const nowReady = !r.bomNeeded || !!r.bomFulfilledAt;
    const updated = await prisma.recipeRequest.update({
      where: { id: r.id },
      data: { rmFulfilledAt: new Date(), ...(nowReady ? { status: "READY", readyAt: new Date() } : {}) },
    });
    if (nowReady) {
      await notifyUser(updated.requestedById, { title: `Recipe/BOM ready: ${updated.productName}`, body: "R&D has uploaded what was missing — Generate again.", link: "/rnd" }).catch(() => {});
    }
  }
}
