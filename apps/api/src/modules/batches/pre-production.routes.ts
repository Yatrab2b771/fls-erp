import { assertPlantAccess, assertRunDayStoreAccess, getScopedDayStoreIds, getScopedPlantIds } from "../inventory/day-store-access";
import { Router } from "express";
import { productionBlockedByHoldOrCancel } from "../purchase-orders/hold-guards";
import { getMaterialCoverage } from "./material-coverage";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { notifyRoles } from "../../common/lib/notify";
import { getPoReadinessForOne } from "../po-readiness/readiness-engine";
import { getPoItemPlanAvailability } from "../planning/add-on-plan";
import { getOnHandByDayStoreAndItem, getOnHandByPlantAndItem } from "../inventory/stock";
import { getDispensingRequirementStatus } from "./dispensing-requirements";
import { preProductionInclude, serializePreProduction, type PreProductionWithRelations } from "./batch-include";
import { transitionPreProductionStage } from "./pre-production-transition";
import { importBatchStages } from "./batch-import";
import { PRE_PRODUCTION_STAGE_LABEL, PRE_PRODUCTION_STAGE_ROLE } from "./pre-production-stage";
import {
  createPreProductionSchema,
  importBatchStagesSchema,
  checklistUpdateSchema,
  preProductionTransitionEnvelopeSchema,
  updatePreProductionPlantSchema,
  type CreatePreProductionInput,
  type ImportBatchStagesInput,
  type ChecklistUpdateInput,
  type UpdatePreProductionPlantInput,
} from "./batch.schemas";
import { preProductionChecklistKeys, combinedLotChecklistKeys } from "./batch-checklists";
import type { Prisma } from "@prisma/client";

// --- Tier 1 of the three-tier pipeline (see schema.prisma's own comment
// block above PreProduction): Material Received through Sample QC
// Approval, one run per PO line item. See production-batches.routes.ts
// for Tier 2 (the small manufacturing runs against this) and
// combined-lot.routes.ts for Tier 3 (the pooled lot they combine into).
// This module is what batches.routes.ts used to be, before the split. ---

export const preProductionRouter = Router();

preProductionRouter.use(requireAuth);

export { preProductionInclude, serializePreProduction, type PreProductionWithRelations };

// Every department needs to see the pipeline board and every run's
// current status — read access is open to any authenticated user; only
// acting on the current stage is role-gated below.
preProductionRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const pagination = parsePagination(req);
    const where: Prisma.PreProductionWhereInput = {};
    if (typeof req.query.purchaseOrderItemId === "string") where.purchaseOrderItemId = req.query.purchaseOrderItemId;
    // Plant Consumption's own "which runs are at my Plant" list (see
    // plant-consumption.routes.ts) — not filtered by role/assignment,
    // same "Plant is unrestricted" reasoning day-store-access.ts already
    // documents for PRODUCTION/PPIC.
    if (typeof req.query.plantId === "string") where.plantId = req.query.plantId;
    // A Plant-limited Production login sees only its own Plant's runs.
    const plantScope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    if (plantScope) where.plantId = typeof where.plantId === "string" ? (plantScope.includes(where.plantId) ? where.plantId : "none") : { in: plantScope };
    // ...and a Day Store login sees only the runs at its own store's Plant.
    const storeScope = await getScopedDayStoreIds(req.user!.id, req.user!.roles);
    if (storeScope) where.plant = { dayStoreId: { in: storeScope } };

    const [total, runs] = await Promise.all([
      prisma.preProduction.count({ where }),
      prisma.preProduction.findMany({ where, include: preProductionInclude, orderBy: { createdAt: "desc" }, skip: pagination.skip, take: pagination.take }),
    ]);
    setPaginationHeaders(res, total, pagination);
    res.json(runs.map(serializePreProduction));
  } catch (err) {
    next(err);
  }
});

// PreProduction creation is Production's call, full stop — the client
// was explicit that PPIC should have no part in it, not even a disabled
// button's worth of visibility (see the PO detail page's ProductLineItem,
// which gates the whole "Start Production" section the same way). PPIC
// still owns production scheduling upstream of this (RM/BOM plans, PO
// review) and can see runs once they exist; it just doesn't start one.
// The run then starts life at MATERIAL_RECEIVED. plannedQty is always
// the item's own full ordered quantity — one PreProduction run per item,
// no more per-batch splitting at this tier (see schema.prisma's comment
// on PreProduction.plannedQty for the ProductionBatch-level split that
// replaces it).
preProductionRouter.post("/", requireRole("PRODUCTION"), async (req: AuthedRequest, res, next) => {
  try {
    const parsed = createPreProductionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { purchaseOrderItemId, plantId: requestedPlantId, confirmNotReady, batchFlow } = parsed.data as CreatePreProductionInput;

    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: purchaseOrderItemId }, include: { purchaseOrder: { select: { id: true, status: true } }, preProduction: true } });
    if (!item) return res.status(400).json({ error: "Unknown purchase order item" });
    if (item.preProduction) return res.status(409).json({ error: "Production has already started on this line item." });
    const blocked = await productionBlockedByHoldOrCancel(purchaseOrderItemId);
    if (blocked) return res.status(409).json({ error: blocked });
    if (item.purchaseOrder.status !== "APPROVED") {
      return res.status(400).json({ error: "This purchase order hasn't been approved yet — BD must approve it before production can start against it." });
    }

    // PPIC's own planning call locks the Plant, once set — Production no
    // longer picks one for this run (see PurchaseOrderItem.plannedPlantId's
    // own schema comment). Falls back to whatever Production sends when
    // PPIC hasn't planned ahead, same behavior as before this existed.
    const plantId = item.plannedPlantId ?? requestedPlantId;
    if (requestedPlantId && item.plannedPlantId && requestedPlantId !== item.plannedPlantId) {
      return res.status(400).json({ error: "PPIC has already planned this product for a different Plant — Production can't override it here." });
    }
    // A Plant-limited Production login starts runs only for products planned at its own Plant.
    await assertPlantAccess(req.user!.id, req.user!.roles, plantId);
    if (plantId && !(await prisma.plant.findUnique({ where: { id: plantId } }))) {
      return res.status(400).json({ error: "Unknown Plant" });
    }

    // Recipe/BOM hard-block — no override, unlike the PO Readiness check
    // below. A production run can't start without knowing what it's
    // making: if PPIC's own request to R&D for this product's missing
    // Recipe/SKU is still open, the run simply can't be created yet. See
    // recipe-request.routes.ts.
    const openRequest = await prisma.recipeRequest.findFirst({ where: { purchaseOrderItemId, status: { in: ["PENDING", "ETA_GIVEN"] } } });
    if (openRequest) {
      return res.status(400).json({
        error:
          openRequest.status === "ETA_GIVEN" && openRequest.etaDate
            ? `Waiting on R&D for "${openRequest.productName}" — ETA ${new Date(openRequest.etaDate).toLocaleDateString()}. Production can't start until the Recipe/BOM is ready.`
            : `Waiting on R&D for "${openRequest.productName}" — no ETA given yet. Production can't start until the Recipe/BOM is ready.`,
      });
    }

    // PPIC's own hand-off hard-block — no override, same as the R&D one
    // above. PPIC's calculated plan (and Regulatory's Approved sign-off
    // behind it) has to have actually been sent — see purchase-orders.
    // routes.ts's POST /:id/items/:itemId/send-plan-to-production.
    if (!item.planSentToProductionAt) {
      return res.status(400).json({ error: "Waiting on PPIC to send this product's plan to Production before a run can be opened." });
    }

    // PO Readiness soft-block — only when PPIC has actually tracked
    // material requirements for this PO (no rows = nothing to check,
    // same "no data = unrestricted" convention as the rest of this app).
    // A 409 here isn't final: the caller can resend with
    // confirmNotReady: true once they've seen and accepted the shortfall.
    if (!confirmNotReady) {
      const readiness = await getPoReadinessForOne(item.purchaseOrder.id);
      if (readiness && !readiness.isReady) {
        return res.status(409).json({
          error: "This PO isn't showing as material-ready yet — some tracked RM/PM items are short of stock. Confirm again to start production anyway.",
          details: { items: readiness.items.filter((i) => !i.covered) },
        });
      }
    }

    const run = await prisma.preProduction.create({
      // Per-batch flow: the run has no stages of its own, so it starts already past them (Line Clearance "Approved" is what lets batches be
      // made); each batch then goes through its own Indent, Batch No, Dispensing and Line Clearance.
      data: { purchaseOrderItemId, plantId, plannedQty: item.quantity, ...(batchFlow ? { batchFlow: true, currentStageId: "SAMPLE_QC_APPROVAL" as const, sampleQcStatus: "Approved" } : {}) },
      include: preProductionInclude,
    });

    await recordAudit({ actorId: req.user!.id, action: "pre_production.created", entityType: "PreProduction", entityId: run.id });

    res.status(201).json(serializePreProduction(run));
  } catch (err) {
    next(err);
  }
});

// Bulk "forward the current stage" — one row per (PO Number, Product
// Name), each run through the exact same gating a manual Forward uses
// (see batch-import.ts). Open to any authenticated user, same as the
// single endpoint — per-row department RBAC is what actually decides
// whether a given row succeeds.
preProductionRouter.post("/import", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = importBatchStagesSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { rows } = parsed.data as ImportBatchStagesInput;

    const summary = await importBatchStages(rows, req.user!.id, req.user!.roles);
    res.status(201).json(summary);
  } catch (err) {
    next(err);
  }
});

// New Plans: the products PPIC has sent to Production whose run has not been started yet - the details come ready-filled from
// the PO (customer, product, type, quantity) and the Plant PPIC planned. A Plant-limited Production login sees only its own Plant's.
preProductionRouter.get("/new-plans", requireRole("PRODUCTION", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const plantScope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    const running = req.query.status === "running"; // ?status=running: the plans whose run has started (default: not started)
    const items = await prisma.purchaseOrderItem.findMany({
      where: {
        cancelledAt: null,
        materialHeldAt: null, // a product on Hold is listed only under On Hold
        productionHeldAt: null, // and one Production holds, only on Held Products
        planSentToProductionAt: { not: null },
        preProduction: running ? { isNot: null } : null,
        ...(plantScope ? { plannedPlantId: { in: plantScope } } : {}),
      },
      select: {
        id: true,
        productName: true,
        productCategory: true,
        productType: true,
        quantity: true,
        releasedQty: true,
        unit: true,
        volume: true,
        packSize: true,
        planSentToProductionAt: true,
        preProduction: { select: { id: true, currentStageId: true, plannedQty: true, combinedQty: true } },
        plannedPlant: { select: { id: true, name: true } },
        purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } },
      },
      orderBy: { planSentToProductionAt: "asc" },
    });
    res.json(
      items.map((i) => ({
        itemId: i.id,
        poId: i.purchaseOrder.id,
        poNumber: i.purchaseOrder.poNumber,
        customerName: i.purchaseOrder.customer.companyName,
        productName: i.productName,
        productCategory: i.productCategory,
        productType: i.productType,
        quantity: i.quantity,
        releasedQty: Math.min(i.quantity, i.releasedQty ?? i.quantity),
        unit: i.unit,
        volume: i.volume,
        packSize: i.packSize,
        plant: i.plannedPlant,
        sentAt: i.planSentToProductionAt,
        run: i.preProduction,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// The "Material Received" page: for every plan PPIC has sent to Production, each material of its plan (RM + PM) with how much was
// required (for the part released so far), how much has reached the Plant against it, what is on the way, what is still to come,
// how much of it is in production, and what is on hand at the Plant now. A Plant-limited Production login sees only its own Plant.
//   Received      issued by the Day Store to the Plant for this product's requests and delivered
//   In transit    issued but not yet received by the Plant
//   Balance       Required - Received - In transit (still to come)
//   Used          A + B + C + D - E over the run (production, wastage, rejected, sample, minus what went back to the store)
//   Left          Received - Used (with Production for this product)
//   Available     whole-Plant on hand for the material (shared by every run at the Plant)
preProductionRouter.get("/material-board", requireRole("PRODUCTION", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const plantScope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    const items = await prisma.purchaseOrderItem.findMany({
      where: {
        cancelledAt: null,
        materialHeldAt: null,
        productionHeldAt: null,
        deletedAt: null,
        planSentToProductionAt: { not: null },
        // ?legacyOnly=1: leave out the products whose run works batch by batch - the Material Received page lists those batch-wise instead.
        ...(req.query.legacyOnly === "1" ? { NOT: { preProduction: { is: { batchFlow: true } } } } : {}),
        ...(plantScope ? { plannedPlantId: { in: plantScope } } : {}),
      },
      select: {
        id: true,
        productName: true,
        productCategory: true,
        quantity: true,
        releasedQty: true,
        unit: true,
        planSentToProductionAt: true,
        plannedPlant: { select: { id: true, name: true } },
        purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } },
        preProduction: { select: { id: true, currentStageId: true } },
      },
      orderBy: { planSentToProductionAt: "asc" },
    });
    if (items.length === 0) return res.json([]);

    const itemIds = items.map((i) => i.id);
    const runIds = items.flatMap((i) => (i.preProduction ? [i.preProduction.id] : []));
    const [plans, requests, consumptions, returns] = await Promise.all([
      Promise.all(items.map((i) => getPoItemPlanAvailability(i.id))),
      prisma.inventoryRequest.findMany({
        where: { purpose: "ISSUED_PRODUCTION", deletedAt: null, purchaseOrderItemId: { in: itemIds } },
        select: { purchaseOrderItemId: true, itemId: true, fulfillments: { where: { deletedAt: null }, select: { quantity: true, deliveredAt: true } } },
      }),
      prisma.batchMaterialConsumption.findMany({ where: { preProductionId: { in: runIds } }, select: { preProductionId: true, itemId: true, quantity: true, purpose: true } }),
      prisma.stockTransfer.findMany({ where: { preProductionId: { in: runIds }, deletedAt: null }, select: { preProductionId: true, itemId: true, quantity: true } }),
    ]);

    // Plan materials are named; match them to catalog items (by category + name) to find their stock and requests.
    const names = new Set<string>();
    for (const p of plans) for (const m of [...(p.rm?.materials ?? []), ...(p.bom?.materials ?? [])]) names.add(m.name);
    const catalog = await prisma.inventoryItem.findMany({ where: { name: { in: [...names] } }, select: { id: true, category: true, name: true } });
    const catalogByKey = new Map(catalog.map((c) => [`${c.category}::${c.name}`, c.id]));

    const onHandByPlant = new Map<string, Map<string, number>>();
    for (const plantId of new Set(items.flatMap((i) => (i.plannedPlant ? [i.plannedPlant.id] : [])))) {
      onHandByPlant.set(plantId, await getOnHandByPlantAndItem(plantId, catalog.map((c) => c.id)));
    }

    const key = (a: string, b: string) => `${a}::${b}`;
    const received = new Map<string, { delivered: number; transit: number }>();
    for (const r of requests) {
      const k = key(r.purchaseOrderItemId!, r.itemId);
      const cur = received.get(k) ?? { delivered: 0, transit: 0 };
      for (const f of r.fulfillments) {
        if (f.deliveredAt) cur.delivered += f.quantity;
        else cur.transit += f.quantity;
      }
      received.set(k, cur);
    }
    const usedByRunItem = new Map<string, number>();
    // What the Day Store has dispensed to Production so far, per run and item (the Dispensing stage's own lines).
    const dispensedByRunItem = new Map<string, number>();
    for (const c of consumptions) if (c.purpose === "PRODUCTION") dispensedByRunItem.set(key(c.preProductionId, c.itemId), (dispensedByRunItem.get(key(c.preProductionId, c.itemId)) ?? 0) + c.quantity);
    for (const c of consumptions) usedByRunItem.set(key(c.preProductionId, c.itemId), (usedByRunItem.get(key(c.preProductionId, c.itemId)) ?? 0) + c.quantity);
    for (const r of returns) if (r.preProductionId) usedByRunItem.set(key(r.preProductionId, r.itemId), (usedByRunItem.get(key(r.preProductionId, r.itemId)) ?? 0) - r.quantity);

    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const rows = items.flatMap((item, idx) => {
      const released = Math.min(item.quantity, item.releasedQty ?? item.quantity);
      const factor = item.quantity > 0 ? released / item.quantity : 1;
      const plan = plans[idx]!;
      const materials = [...(plan.rm?.materials ?? []).map((m) => ({ ...m, category: "RM" as const })), ...(plan.bom?.materials ?? []).map((m) => ({ ...m, category: "PM" as const }))];
      return materials.map((m) => {
        const invId = catalogByKey.get(key(m.category, m.name)) ?? null;
        const required = r3(m.requiredQty * factor);
        // Production sees material only once it has been dispensed to it: nothing before Dispensing, what has been dispensed so far during
        // it, and (as before) what reached the Plant after it.
        const stageId = item.preProduction?.currentStageId ?? null;
        const notDispensed = !stageId || stageId === "MATERIAL_RECEIVED" || stageId === "INDENT_ISSUE";
        const got = invId && !notDispensed ? received.get(key(item.id, invId)) : undefined;
        const receivedQty = notDispensed ? 0 : stageId === "DISPENSING" ? r3(invId && item.preProduction ? (dispensedByRunItem.get(key(item.preProduction.id, invId)) ?? 0) : 0) : r3(got?.delivered ?? 0);
        const inTransitQty = notDispensed || stageId === "DISPENSING" ? 0 : r3(got?.transit ?? 0);
        const usedQty = invId && item.preProduction ? r3(usedByRunItem.get(key(item.preProduction.id, invId)) ?? 0) : 0;
        const available = invId && item.plannedPlant && !notDispensed ? r3(onHandByPlant.get(item.plannedPlant.id)?.get(invId) ?? 0) : null;
        const status = !invId ? "NOT_IN_CATALOG" : notDispensed ? "NOT_DISPENSED" : receivedQty >= required - 1e-6 ? "FULL" : receivedQty > 0 ? "PARTIAL" : inTransitQty > 0 ? "IN_TRANSIT" : "NOT_RECEIVED";
        return {
          itemId: item.id,
          poId: item.purchaseOrder.id,
          poNumber: item.purchaseOrder.poNumber,
          customerName: item.purchaseOrder.customer.companyName,
          productName: item.productName,
          productCategory: item.productCategory,
          plant: item.plannedPlant,
          releasedQty: released,
          orderQty: item.quantity,
          productUnit: item.unit,
          material: m.name,
          category: m.category,
          unit: m.unit,
          requiredQty: required,
          receivedQty,
          inTransitQty,
          balanceQty: Math.max(0, r3(required - receivedQty - inTransitQty)),
          usedQty,
          leftQty: r3(receivedQty - usedQty),
          availableQty: available,
          status,
          sentAt: item.planSentToProductionAt,
        };
      });
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// The New Plan page's list: every plan PPIC has sent to Production (run started or not), one entry per product. Each carries what the
// page's three dropdowns show: the run and its batches (shift, manpower, start / end time) and, per batch, the Material Utilization
// (A used in production, B wastage, C rejected, D sample, E returned to store). Usage logged without a batch comes back under
// `unassigned`. A Plant-limited Production login sees only its own Plant's plans.
preProductionRouter.get("/plans-board", requireRole("PRODUCTION", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const plantScope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    const items = await prisma.purchaseOrderItem.findMany({
      where: { cancelledAt: null, materialHeldAt: null, productionHeldAt: null, deletedAt: null, planSentToProductionAt: { not: null }, ...(plantScope ? { plannedPlantId: { in: plantScope } } : {}) },
      select: {
        id: true,
        productName: true,
        productCategory: true,
        productType: true,
        quantity: true,
        releasedQty: true,
        unit: true,
        planSentToProductionAt: true,
        closedShortAt: true,
        closedShortQty: true,
        closedShortReason: true,
        plannedPlant: { select: { id: true, name: true } },
        purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } },
        preProduction: {
          select: {
            id: true,
            currentStageId: true,
            sampleQcStatus: true,
            batchFlow: true,
            plannedQty: true,
            combinedQty: true,
            plant: { select: { id: true, name: true } },
            productionBatches: {
              orderBy: { createdAt: "asc" },
              select: { id: true, batchNo: true, status: true, prepStageId: true, plannedQty: true, inputQty: true, outputQty: true, shift: true, manpowerCount: true, shiftStartAt: true, shiftEndAt: true },
            },
          },
        },
      },
      orderBy: { planSentToProductionAt: "asc" },
    });

    const runIds = items.flatMap((i) => (i.preProduction ? [i.preProduction.id] : []));
    const [consumptions, returns, leftovers] = await Promise.all([
      prisma.batchMaterialConsumption.findMany({
        where: { preProductionId: { in: runIds } },
        select: { preProductionId: true, productionBatchId: true, itemId: true, quantity: true, unit: true, purpose: true, item: { select: { name: true, category: true } } },
      }),
      prisma.stockTransfer.findMany({
        where: { preProductionId: { in: runIds }, deletedAt: null },
        select: { preProductionId: true, productionBatchId: true, itemId: true, quantity: true, unit: true, item: { select: { name: true, category: true } } },
      }),
      prisma.batchLeftover.findMany({ where: { productionBatch: { preProductionId: { in: runIds } } }, select: { productionBatchId: true, itemId: true, quantity: true, unit: true, productionBatch: { select: { preProductionId: true } } } }),
    ]);
    const leftoverItems = new Map((leftovers.length ? await prisma.inventoryItem.findMany({ where: { id: { in: [...new Set(leftovers.map((l) => l.itemId))] } }, select: { id: true, name: true, category: true } }) : []).map((i) => [i.id, i]));

    type Material = { itemId: string; itemName: string; category: string; unit: string; consumedQty: number; wastedQty: number; rejectedQty: number; sampleQty: number; returnedQty: number };
    // run -> batch id (or "" for no batch) -> item -> totals
    const usage = new Map<string, Map<string, Map<string, Material>>>();
    const bucket = (runId: string, batchId: string | null, itemId: string, name: string, category: string, unit: string) => {
      const byBatch = usage.get(runId) ?? new Map<string, Map<string, Material>>();
      usage.set(runId, byBatch);
      const byItem = byBatch.get(batchId ?? "") ?? new Map<string, Material>();
      byBatch.set(batchId ?? "", byItem);
      let m = byItem.get(itemId);
      if (!m) {
        m = { itemId, itemName: name, category, unit, consumedQty: 0, wastedQty: 0, rejectedQty: 0, sampleQty: 0, returnedQty: 0 };
        byItem.set(itemId, m);
      }
      return m;
    };
    for (const c of consumptions) {
      const m = bucket(c.preProductionId, c.productionBatchId, c.itemId, c.item.name, c.item.category, c.unit);
      if (c.purpose === "PRODUCTION") m.consumedQty += c.quantity;
      else if (c.purpose === "WASTE") m.wastedQty += c.quantity;
      else if (c.purpose === "REJECTED") m.rejectedQty += c.quantity;
      else if (c.purpose === "SAMPLE") m.sampleQty += c.quantity;
    }
    for (const r of returns) {
      if (r.preProductionId) bucket(r.preProductionId, r.productionBatchId, r.itemId, r.item.name, r.item.category, r.unit).returnedQty += r.quantity;
    }
    // A batch's leftover (E) stays in the Plant's stock until it is sent back from Plant Stock.
    for (const l of leftovers) bucket(l.productionBatch.preProductionId, l.productionBatchId, l.itemId, leftoverItems.get(l.itemId)?.name ?? "", leftoverItems.get(l.itemId)?.category ?? "RM", l.unit).returnedQty += l.quantity;
    const materialsOf = (runId: string, batchId: string) => [...(usage.get(runId)?.get(batchId)?.values() ?? [])];

    const rows = items.map((i) => {
      const run = i.preProduction;
      return {
        itemId: i.id,
        poId: i.purchaseOrder.id,
        poNumber: i.purchaseOrder.poNumber,
        customerName: i.purchaseOrder.customer.companyName,
        productName: i.productName,
        productCategory: i.productCategory,
        productType: i.productType,
        quantity: i.quantity,
        releasedQty: Math.min(i.quantity, i.releasedQty ?? i.quantity),
        unit: i.unit,
        plant: run?.plant ?? i.plannedPlant,
        sentAt: i.planSentToProductionAt,
        closedShort: i.closedShortAt ? { at: i.closedShortAt, qty: i.closedShortQty, reason: i.closedShortReason } : null,
        run: run && { id: run.id, currentStageId: run.currentStageId, sampleQcStatus: run.sampleQcStatus, batchFlow: run.batchFlow, plannedQty: run.plannedQty, combinedQty: run.combinedQty },
        batches: (run?.productionBatches ?? []).map((b) => ({ ...b, materials: materialsOf(run!.id, b.id) })),
        unassigned: run ? materialsOf(run.id, "") : [],
      };
    });
    // Plans whose run has not started come first (that is Production's next move), oldest first; the rest follow, newest first.
    res.json([...rows.filter((r) => !r.run), ...rows.filter((r) => r.run).reverse()]);
  } catch (err) {
    next(err);
  }
});

// Production's Indent Issue tile: every run waiting at Indent Issue (Stage 1 is done), with the plan's materials for the released
// quantity. The indent is the plan's own list, so nothing is typed per material - Production fills the slip and dates and forwards
// the run through PATCH /:id/stage. A Plant-limited Production login sees only its own Plant's runs.
preProductionRouter.get("/indent-board", requireRole("PRODUCTION", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const plantScope = await getScopedPlantIds(req.user!.id, req.user!.roles);
    const runs = await prisma.preProduction.findMany({
      where: { currentStageId: "INDENT_ISSUE", purchaseOrderItem: { cancelledAt: null, materialHeldAt: null, productionHeldAt: null }, ...(plantScope ? { plantId: { in: plantScope } } : {}) },
      select: {
        id: true,
        purchaseOrderItemId: true,
        grnNo: true,
        grnDate: true,
        prodIndentSlipSign: true,
        productionPlanDate: true,
        dispatchPlanDate: true,
        unit: true,
        plantId: true,
        updatedAt: true,
        purchaseOrderItem: {
          select: { productName: true, productCategory: true, quantity: true, releasedQty: true, unit: true, plannedPlant: { select: { id: true, name: true } }, purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } } },
        },
      },
      orderBy: { updatedAt: "asc" },
    });
    const rows = await Promise.all(
      runs.map(async (r) => {
        const coverage = await getMaterialCoverage(r.purchaseOrderItemId);
        const item = r.purchaseOrderItem;
        return {
          id: r.id,
          purchaseOrderItemId: r.purchaseOrderItemId,
          poId: item.purchaseOrder.id,
          poNumber: item.purchaseOrder.poNumber,
          customerName: item.purchaseOrder.customer.companyName,
          productName: item.productName,
          productCategory: item.productCategory,
          plantName: item.plannedPlant?.name ?? null,
          orderQty: item.quantity,
          releasedQty: coverage?.releasedQty ?? Math.min(item.quantity, item.releasedQty ?? item.quantity),
          productUnit: item.unit,
          grnNo: r.grnNo,
          grnDate: r.grnDate,
          prodIndentSlipSign: r.prodIndentSlipSign,
          productionPlanDate: r.productionPlanDate,
          dispatchPlanDate: r.dispatchPlanDate,
          unit: r.unit,
          waitingSince: r.updatedAt,
          materials: coverage?.lines ?? [],
          allCovered: coverage?.allCovered ?? true,
        };
      }),
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// The Day Store's two tiles: runs waiting at Material Received & GRN (?stage=MATERIAL_RECEIVED) or at Dispensing (?stage=DISPENSING)
// at the Plant of the logged-in Day Store. Each row carries what the form needs: the plan's materials with what the Day Store and the
// Plant hold, and (Dispensing) what is still to be dispensed. The stage itself is moved through PATCH /:id/stage.
preProductionRouter.get("/store-board", requireRole("STORE", "PPIC"), async (req: AuthedRequest, res, next) => {
  try {
    const stage = req.query.stage === "DISPENSING" ? "DISPENSING" : "MATERIAL_RECEIVED";
    const scope = await getScopedDayStoreIds(req.user!.id, req.user!.roles);
    const runs = await prisma.preProduction.findMany({
      where: { currentStageId: stage, purchaseOrderItem: { cancelledAt: null, materialHeldAt: null, productionHeldAt: null }, ...(scope ? { plant: { dayStoreId: { in: scope } } } : {}) },
      select: {
        id: true,
        purchaseOrderItemId: true,
        grnNo: true,
        grnDate: true,
        materialReceivedRemarks: true,
        prodIndentSlipSign: true,
        rmDispensingDate: true,
        pmIssuedDate: true,
        rmDispensingRemarks: true,
        pmDispensingRemarks: true,
        updatedAt: true,
        plant: { select: { id: true, name: true, dayStoreId: true } },
        purchaseOrderItem: { select: { productName: true, productCategory: true, quantity: true, releasedQty: true, unit: true, purchaseOrder: { select: { id: true, poNumber: true, customer: { select: { companyName: true } } } } } },
      },
      orderBy: { updatedAt: "asc" },
    });
    const rows = await Promise.all(
      runs.map(async (r) => {
        const item = r.purchaseOrderItem;
        const coverage = await getMaterialCoverage(r.purchaseOrderItemId);
        let required: { itemId: string; itemName: string; category: string; unit: string; requiredQty: number; consumedQty: number; covered: boolean; dayStoreQty: number; plantQty: number }[] = [];
        if (stage === "DISPENSING") {
          const status = await getDispensingRequirementStatus(r.id, r.purchaseOrderItemId);
          const ids = status.map((s) => s.itemId);
          const [shelf, plantHeld] = await Promise.all([
            r.plant?.dayStoreId ? getOnHandByDayStoreAndItem(r.plant.dayStoreId, ids) : Promise.resolve(new Map<string, { onHand: number }>()),
            r.plant ? getOnHandByPlantAndItem(r.plant.id, ids) : Promise.resolve(new Map<string, number>()),
          ]);
          required = status.map((s) => ({ ...s, dayStoreQty: Math.round((shelf.get(s.itemId)?.onHand ?? 0) * 1000) / 1000, plantQty: Math.round((plantHeld.get(s.itemId) ?? 0) * 1000) / 1000 }));
        }
        return {
          id: r.id,
          purchaseOrderItemId: r.purchaseOrderItemId,
          poId: item.purchaseOrder.id,
          poNumber: item.purchaseOrder.poNumber,
          customerName: item.purchaseOrder.customer.companyName,
          productName: item.productName,
          productCategory: item.productCategory,
          plantName: r.plant?.name ?? null,
          orderQty: item.quantity,
          releasedQty: coverage?.releasedQty ?? Math.min(item.quantity, item.releasedQty ?? item.quantity),
          productUnit: item.unit,
          grnNo: r.grnNo,
          grnDate: r.grnDate,
          materialReceivedRemarks: r.materialReceivedRemarks,
          prodIndentSlipSign: r.prodIndentSlipSign,
          rmDispensingDate: r.rmDispensingDate,
          pmIssuedDate: r.pmIssuedDate,
          rmDispensingRemarks: r.rmDispensingRemarks,
          pmDispensingRemarks: r.pmDispensingRemarks,
          waitingSince: r.updatedAt,
          materials: coverage?.lines ?? [],
          allCovered: coverage?.allCovered ?? true,
          required,
        };
      }),
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Stage 1's panel: what the released quantity needs, what has reached the Plant, what is on its way, what is still short.
preProductionRouter.get("/:id/material-coverage", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const run = await prisma.preProduction.findUnique({ where: { id: req.params.id }, select: { id: true, purchaseOrderItemId: true, plantId: true } });
    if (!run) return res.status(404).json({ error: "Run not found" });
    await assertPlantAccess(req.user!.id, req.user!.roles, run.plantId);
    res.json(await getMaterialCoverage(run.purchaseOrderItemId));
  } catch (err) {
    next(err);
  }
});

preProductionRouter.get("/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const run = await prisma.preProduction.findUnique({ where: { id: req.params.id }, include: preProductionInclude });
    if (!run) return res.status(404).json({ error: "Pre-production run not found" });
    await assertPlantAccess(req.user!.id, req.user!.roles, run.plantId);
    // A Day Store login opens only the runs at its own Plant (the Warehouse seat and every other role still read any run).
    const storeScope = await getScopedDayStoreIds(req.user!.id, req.user!.roles);
    if (storeScope) {
      const plant = run.plantId ? await prisma.plant.findUnique({ where: { id: run.plantId }, select: { dayStoreId: true } }) : null;
      if (!plant?.dayStoreId || !storeScope.includes(plant.dayStoreId)) return res.status(403).json({ error: "This run belongs to another Plant." });
    }
    res.json(serializePreProduction(run));
  } catch (err) {
    next(err);
  }
});

// What this run's product actually needs (per its linked, calculated
// RmPlan/BomPlan) versus what's been logged so far — read access open to
// any authenticated user, same as the run itself, so the Dispensing
// checklist can show Store what's still short *before* they attempt to
// forward, not just after the PATCH /:id/stage gate blocks it.
preProductionRouter.get("/:id/dispensing-requirements", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const run = await prisma.preProduction.findUnique({ where: { id: req.params.id }, select: { id: true, purchaseOrderItemId: true } });
    if (!run) return res.status(404).json({ error: "Pre-production run not found" });
    const items = await getDispensingRequirementStatus(run.id, run.purchaseOrderItemId);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// Assign/change which Plant a run runs at — not a stage transition, just
// metadata PPIC can fix any time (e.g. the run was created before a
// Plant was picked, or it turns out wrong). PPIC owns run scheduling the
// same way it owns assigning a Plant in the first place.
preProductionRouter.patch("/:id/plant", requireRole("PPIC"), async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const parsed = updatePreProductionPlantSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { plantId } = parsed.data as UpdatePreProductionPlantInput;

    const existing = await prisma.preProduction.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Pre-production run not found" });
    if (plantId && !(await prisma.plant.findUnique({ where: { id: plantId } }))) {
      return res.status(400).json({ error: "Unknown Plant" });
    }

    // BatchMaterialConsumption rows don't record their own plant — they're
    // joined to one through this very field (see stock.ts
    // getOnHandByPlantAndItem's `preProduction: { plantId }` filter).
    // Changing it after real consumption has already been logged would
    // silently rewrite which Plant's balance that consumption counts
    // against, so once Dispensing has logged real usage, the Plant is
    // locked in.
    if (existing.plantId !== plantId) {
      const consumptionCount = await prisma.batchMaterialConsumption.count({ where: { preProductionId: existing.id } });
      if (consumptionCount > 0) {
        return res.status(409).json({ error: "This run already has RM/PM consumption logged against its current Plant — the Plant can't be changed once Dispensing has recorded real usage." });
      }
    }

    const run = await prisma.preProduction.update({ where: { id: existing.id }, data: { plantId }, include: preProductionInclude });
    await recordAudit({ actorId: req.user!.id, action: "pre_production.plant_assigned", entityType: "PreProduction", entityId: run.id, metadata: { plantId } });

    res.json(serializePreProduction(run));
  } catch (err) {
    next(err);
  }
});

// Two itemized checklists live on PreProduction now, distinguished only
// by itemKey (the two sets never overlap): the dispensing-area one (BMR
// 1.0, Store's own column) at LINE_CLEARANCE, and the bulk-manufacturing
// one (BMR 4.0, Production's own column instead of Store's) at
// SAMPLE_QC_APPROVAL — see batch-checklists.ts. Not itself the gate
// (PreProduction.lineClearanceStatus / sampleQcStatus, set via PATCH
// /:id/stage, still is) — this is the itemized detail behind that one
// sign-off. Each call only ever writes the one column the caller's role
// owns; DEPT means Store on the dispensing set, Production on the bulk
// set.
preProductionRouter.patch("/:id/checklist", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const parsed = checklistUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    const { column, items } = parsed.data as ChecklistUpdateInput;

    const isAdmin = req.user!.roles.includes("ADMIN");
    if (column === "QA" && !req.user!.roles.includes("QA_QC") && !isAdmin) return res.status(403).json({ error: "Only QA/QC can fill in the QA column." });

    const existing = await prisma.preProduction.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Pre-production run not found" });
    await assertPlantAccess(req.user!.id, req.user!.roles, existing.plantId);

    const dispensingKeys = preProductionChecklistKeys();
    const bulkMfgKeys = combinedLotChecklistKeys();
    const unknownKeys = items.map((i) => i.itemKey).filter((k) => !dispensingKeys.has(k) && !bulkMfgKeys.has(k));
    if (unknownKeys.length > 0) return res.status(400).json({ error: `Unknown checklist item(s): ${unknownKeys.join(", ")}` });

    if (column === "DEPT" && !isAdmin) {
      const needsStore = items.some((i) => dispensingKeys.has(i.itemKey));
      const needsProduction = items.some((i) => bulkMfgKeys.has(i.itemKey));
      if (needsStore && !req.user!.roles.includes("STORE")) return res.status(403).json({ error: "Only Store can fill in this column." });
      // The Dispensing checklist is the run's own Day Store's.
      if (needsStore) await assertRunDayStoreAccess(req.user!.id, req.user!.roles, existing.plantId);
      if (needsProduction && !req.user!.roles.includes("PRODUCTION")) return res.status(403).json({ error: "Only Production can fill in this column." });
    }

    await prisma.$transaction(
      items.map((i) =>
        prisma.preProductionChecklistItem.upsert({
          where: { preProductionId_itemKey: { preProductionId: existing.id, itemKey: i.itemKey } },
          create: { preProductionId: existing.id, itemKey: i.itemKey, ...(column === "DEPT" ? { deptOk: i.ok } : { qaOk: i.ok }) },
          update: column === "DEPT" ? { deptOk: i.ok } : { qaOk: i.ok },
        }),
      ),
    );

    await recordAudit({ actorId: req.user!.id, action: "pre_production.checklist_updated", entityType: "PreProduction", entityId: existing.id, metadata: { column, itemCount: items.length } });

    const updated = await prisma.preProduction.findUniqueOrThrow({ where: { id: existing.id }, include: preProductionInclude });
    res.json(serializePreProduction(updated));
  } catch (err) {
    next(err);
  }
});

// QA's own sign-off on one Dispensing Sheet line ("Verified By (QA)" on
// the paper form) — separate from Sample QC Approval further down the
// pipeline, this is QC confirming the weighing itself (gross/tare/net,
// A.R. No.) was done correctly. Append-only: once verified, this can't
// be un-set.
preProductionRouter.post("/:id/consumptions/:consumptionId/verify", requireRole("QA_QC", "RND"), async (req: AuthedRequest<{ id: string; consumptionId: string }>, res, next) => {
  try {
    const line = await prisma.batchMaterialConsumption.findUnique({ where: { id: req.params.consumptionId } });
    if (!line || line.preProductionId !== req.params.id) return res.status(404).json({ error: "Consumption line not found on this run" });
    if (line.qaVerifiedById) return res.status(409).json({ error: "Already verified." });

    await prisma.batchMaterialConsumption.update({ where: { id: line.id }, data: { qaVerifiedById: req.user!.id, qaVerifiedAt: new Date() } });
    await recordAudit({ actorId: req.user!.id, action: "pre_production.consumption_qa_verified", entityType: "PreProduction", entityId: req.params.id, metadata: { consumptionId: line.id } });

    const updated = await prisma.preProduction.findUniqueOrThrow({ where: { id: req.params.id }, include: preProductionInclude });
    res.json(serializePreProduction(updated));
  } catch (err) {
    next(err);
  }
});

// The one transition endpoint for this tier's pipeline: fill in the
// current stage's fields (if it has any), then either forward it to the
// next stage or send it back.
preProductionRouter.patch("/:id/stage", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const run = await prisma.preProduction.findUnique({ where: { id: req.params.id } });
    if (!run) return res.status(404).json({ error: "Pre-production run not found" });
    await assertPlantAccess(req.user!.id, req.user!.roles, run.plantId);
    // Material Received & GRN and Dispensing belong to the Day Store of the run's own Plant.
    if (run.currentStageId === "MATERIAL_RECEIVED" || run.currentStageId === "DISPENSING") await assertRunDayStoreAccess(req.user!.id, req.user!.roles, run.plantId);

    const currentStage = run.currentStageId;

    const envelope = preProductionTransitionEnvelopeSchema.safeParse(req.body);
    if (!envelope.success) return res.status(400).json({ error: "Validation failed", details: envelope.error.flatten() });
    const { action, note, targetStageId } = envelope.data;

    // Admin override — move the run straight to any stage, bypassing the
    // normal forward/reject sequence and skipping field validation.
    if (action === "JUMP") {
      if (!req.user!.roles.includes("ADMIN")) {
        return res.status(403).json({ error: "Only an admin can move a run directly to another stage." });
      }
      if (!targetStageId) {
        return res.status(400).json({ error: "targetStageId is required for a jump." });
      }
      const updated = await prisma.$transaction(async (tx) => {
        await tx.preProduction.update({ where: { id: run.id }, data: { currentStageId: targetStageId } });
        await tx.preProductionStageEvent.create({
          data: { preProductionId: run.id, fromStageId: currentStage, toStageId: targetStageId, action: "JUMP", note: note ?? null, actorId: req.user!.id },
        });
        return tx.preProduction.findUniqueOrThrow({ where: { id: run.id }, include: preProductionInclude });
      });
      await recordAudit({ actorId: req.user!.id, action: "pre_production.stage_jumped", entityType: "PreProduction", entityId: run.id, metadata: { from: currentStage, to: targetStageId } });
      if (targetStageId !== currentStage) {
        await notifyRoles(
          PRE_PRODUCTION_STAGE_ROLE[targetStageId],
          { title: `${updated.purchaseOrderItem.productName} moved to ${PRE_PRODUCTION_STAGE_LABEL[targetStageId]}`, body: "Moved by an admin.", link: `/pre-productions/${updated.id}` },
          req.user!.id,
        ).catch((err) => req.log?.error({ err }, "notify failed: pre_production.stage_jumped"));
      }
      return res.json(serializePreProduction(updated));
    }

    const result = await transitionPreProductionStage({
      run,
      action: action as "FORWARD" | "REJECT",
      note,
      rawBody: req.body as Record<string, unknown>,
      actorId: req.user!.id,
      actorRoles: req.user!.roles,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, ...(result.details !== undefined ? { details: result.details } : {}) });
    }
    res.json({ ...serializePreProduction(result.updated), ...(result.dispensingShortfall.length > 0 ? { dispensingShortfall: result.dispensingShortfall } : {}) });
  } catch (err) {
    next(err);
  }
});
