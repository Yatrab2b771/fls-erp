import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { parsePagination, setPaginationHeaders } from "../../common/lib/pagination";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";
import { validateBody } from "../../common/middleware/validate";
import { addPlanItemSchema, createPlanSchema } from "./bom-plan.schemas";
import { calculateMasterBOM, type BomPlanLineInput, type BomResult } from "./bom-engine";
import { buildMasterBomWorkbook } from "./bom-export";
import { buildMasterBomPdf } from "./bom-pdf";
import { bulkCreateRequirements, type RequirementSourceRow } from "../inventory/pre-inventory.routes";
import { Prisma } from "@prisma/client";

export const bomPlanRouter = Router();

bomPlanRouter.use(requireAuth);

function serializePlan(plan: {
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
  items: { id: string; targetYield: number; sku: { id: string; productName: string; brand: { name: string } } }[];
  purchaseOrderItemId: string | null;
  purchaseOrderItem: { id: string; productName: string; purchaseOrder: { id: string; poNumber: string | null } } | null;
}) {
  return {
    id: plan.id,
    name: plan.name,
    dateFrom: plan.dateFrom,
    dateTo: plan.dateTo,
    status: plan.status,
    calculatedAt: plan.calculatedAt,
    createdAt: plan.createdAt,
    result: plan.resultSnapshot ?? null,
    items: plan.items.map((i) => ({
      id: i.id,
      skuId: i.sku.id,
      brandName: i.sku.brand.name,
      productName: i.sku.productName,
      targetYield: i.targetYield,
    })),
    purchaseOrderItemId: plan.purchaseOrderItemId,
    linkedOrder: plan.purchaseOrderItem
      ? { productName: plan.purchaseOrderItem.productName, poNumber: plan.purchaseOrderItem.purchaseOrder.poNumber, purchaseOrderId: plan.purchaseOrderItem.purchaseOrder.id }
      : null,
  };
}

const planInclude = {
  items: { include: { sku: { include: { brand: true } } } },
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
    res.json(plans.map(serializePlan));
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

    if (purchaseOrderItemId) {
      const item = await prisma.purchaseOrderItem.findUnique({ where: { id: purchaseOrderItemId } });
      if (!item) return res.status(400).json({ error: "Unknown purchase order item" });
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

    res.status(201).json(serializePlan(plan));
  } catch (err) {
    next(err);
  }
});

bomPlanRouter.get("/plans/:id", async (req: AuthedRequest<{ id: string }>, res, next) => {
  try {
    const plan = await prisma.bomPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    res.json(serializePlan(plan));
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
      await prisma.bomPlanItem.deleteMany({ where: { id: req.params.itemId, planId: req.params.id } });
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

    const inputs: BomPlanLineInput[] = plan.items.map((item) => ({
      brandName: item.sku.brand.name,
      productName: item.sku.productName,
      targetYield: item.targetYield,
      spec: item.sku,
    }));

    const result = calculateMasterBOM(inputs);

    const updated = await prisma.bomPlan.update({
      where: { id: plan.id },
      data: {
        status: "CALCULATED",
        calculatedAt: new Date(),
        resultSnapshot: result as unknown as Prisma.InputJsonValue,
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

    await recordAudit({ actorId: req.user!.id, action: "bom_plan.sent_to_pre_inventory", entityType: "BomPlan", entityId: plan.id, metadata: outcome });

    res.status(201).json(outcome);
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
