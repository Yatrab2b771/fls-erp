import { Router } from "express";
import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { requireAuth, requireRole, type AuthedRequest } from "../../common/middleware/auth";

// --- Recycle Bin — nothing in this app hard-deletes real data any more.
// Every "delete" button across every module (see each model's own
// "Soft delete" comment in schema.prisma) sets deletedAt/deletedById
// instead of removing the row, and every read that lists/aggregates
// that data filters deletedAt: null so a soft-deleted row disappears
// from normal use immediately — the exact same behavior a hard delete
// used to have, except the row is still there to bring back.
//
// This module is the one place all nine soft-deletable entity types
// come back together: list what's currently in the bin (Admin-only, by
// design — one place to review and undo any department's accidental
// delete, rather than restore power scattered across every role that
// could delete something), and restore any one of them.
//
// Deliberately NOT covered here: DayStoreAssignment (an access grant,
// trivially "restored" by re-assigning through the existing Store UI —
// it isn't data anyone would think of as lost) and UserRole revocation
// (a security action, reversible the same way — Admin re-grants it;
// putting it in a bin next to real records would blur what this page
// is for).

export const recycleBinRouter = Router();

recycleBinRouter.use(requireAuth);

type BinEntityType =
  | "inventory-transaction"
  | "dispatch-transfer"
  | "inventory-request"
  | "po-material-requirement"
  | "purchase-order-item"
  | "purchase-order-document"
  | "bom-plan-item"
  | "rm-plan-item"
  | "pre-inventory-requirement";

interface BinRow {
  entityType: BinEntityType;
  id: string;
  label: string;
  detail: string;
  deletedAt: string;
  deletedBy: { id: string; employeeId: number; fullName: string } | null;
}

const personSelect = { select: { id: true, employeeId: true, fullName: true } } as const;

async function collectAll(): Promise<BinRow[]> {
  const [txns, transfers, requests, poReqs, poItems, poDocs, bomItems, rmItems, preInvReqs] = await Promise.all([
    prisma.inventoryTransaction.findMany({
      where: { deletedAt: { not: null } },
      include: { item: true, dayStore: true, plant: true, deletedBy: personSelect },
      orderBy: { deletedAt: "desc" },
    }),
    prisma.dispatchTransfer.findMany({
      where: { deletedAt: { not: null } },
      include: { customer: { select: { companyName: true } }, deletedBy: personSelect },
      orderBy: { deletedAt: "desc" },
    }),
    prisma.inventoryRequest.findMany({
      where: { deletedAt: { not: null } },
      include: { item: true, deletedBy: personSelect },
      orderBy: { deletedAt: "desc" },
    }),
    prisma.poMaterialRequirement.findMany({
      where: { deletedAt: { not: null } },
      include: { item: true, purchaseOrder: { select: { poNumber: true } }, deletedBy: personSelect },
      orderBy: { deletedAt: "desc" },
    }),
    prisma.purchaseOrderItem.findMany({
      where: { deletedAt: { not: null } },
      include: { purchaseOrder: { select: { poNumber: true } }, deletedBy: personSelect },
      orderBy: { deletedAt: "desc" },
    }),
    prisma.purchaseOrderDocument.findMany({
      where: { deletedAt: { not: null } },
      include: { purchaseOrder: { select: { poNumber: true } }, deletedBy: personSelect },
      orderBy: { deletedAt: "desc" },
    }),
    prisma.bomPlanItem.findMany({
      where: { deletedAt: { not: null } },
      include: { plan: { select: { name: true } }, sku: { include: { customer: true } }, deletedBy: personSelect },
      orderBy: { deletedAt: "desc" },
    }),
    prisma.rmPlanItem.findMany({
      where: { deletedAt: { not: null } },
      include: { plan: { select: { name: true } }, recipe: { select: { name: true } }, deletedBy: personSelect },
      orderBy: { deletedAt: "desc" },
    }),
    prisma.preInventoryRequirement.findMany({
      where: { deletedAt: { not: null } },
      include: { item: true, deletedBy: personSelect },
      orderBy: { deletedAt: "desc" },
    }),
  ]);

  const TXN_TYPE_LABEL: Record<string, string> = { RECEIVED: "Received", ISSUED_DAY_STORE: "Issued to Store", ISSUED_PRODUCTION: "Issued to Production", ISSUED_RND: "Sent to R&D Store" };

  const rows: BinRow[] = [
    ...txns.map((t) => ({
      entityType: "inventory-transaction" as const,
      id: t.id,
      label: `${TXN_TYPE_LABEL[t.type] ?? t.type} — ${t.item.name}`,
      detail: `${t.quantity} ${t.unit}${t.dayStore ? ` · ${t.dayStore.name}` : ""}${t.plant ? ` · ${t.plant.name}` : ""}${t.vendorName ? ` · ${t.vendorName}` : ""}${t.batchNo ? ` · Batch ${t.batchNo}` : ""}`,
      deletedAt: t.deletedAt!.toISOString(),
      deletedBy: t.deletedBy,
    })),
    ...transfers.map((d) => ({
      entityType: "dispatch-transfer" as const,
      id: d.id,
      label: `${d.type === "FG" ? "FG" : "Bill"} Transfer — ${d.productName}`,
      detail: `${d.quantity} → ${d.customer.companyName}`,
      deletedAt: d.deletedAt!.toISOString(),
      deletedBy: d.deletedBy,
    })),
    ...requests.map((r) => ({
      entityType: "inventory-request" as const,
      id: r.id,
      label: `Material Request — ${r.item.name}`,
      detail: `${r.requestedQty} — ${r.purpose === "ISSUED_PRODUCTION" ? "for Production" : "for Day Store"}`,
      deletedAt: r.deletedAt!.toISOString(),
      deletedBy: r.deletedBy,
    })),
    ...poReqs.map((p) => ({
      entityType: "po-material-requirement" as const,
      id: p.id,
      label: `PO Requirement — ${p.item.name}`,
      detail: `${p.requiredQty} ${p.unit} on PO ${p.purchaseOrder.poNumber ?? "(no number)"}`,
      deletedAt: p.deletedAt!.toISOString(),
      deletedBy: p.deletedBy,
    })),
    ...poItems.map((i) => ({
      entityType: "purchase-order-item" as const,
      id: i.id,
      label: `PO Line Item — ${i.productName}`,
      detail: `${i.quantity} ${i.unit} on PO ${i.purchaseOrder.poNumber ?? "(no number)"}`,
      deletedAt: i.deletedAt!.toISOString(),
      deletedBy: i.deletedBy,
    })),
    ...poDocs.map((d) => ({
      entityType: "purchase-order-document" as const,
      id: d.id,
      label: `PO Document — ${d.filename}`,
      detail: `On PO ${d.purchaseOrder.poNumber ?? "(no number)"}`,
      deletedAt: d.deletedAt!.toISOString(),
      deletedBy: d.deletedBy,
    })),
    ...bomItems.map((b) => ({
      entityType: "bom-plan-item" as const,
      id: b.id,
      label: `BOM Plan Item — ${b.sku.customer.companyName} ${b.sku.productName}`,
      detail: `Target yield ${b.targetYield} on plan "${b.plan.name}"`,
      deletedAt: b.deletedAt!.toISOString(),
      deletedBy: b.deletedBy,
    })),
    ...rmItems.map((r) => ({
      entityType: "rm-plan-item" as const,
      id: r.id,
      label: `RM Plan Item — ${r.recipe.name}`,
      detail: `${r.batchSizeKg} Kg batch on plan "${r.plan.name}"`,
      deletedAt: r.deletedAt!.toISOString(),
      deletedBy: r.deletedBy,
    })),
    ...preInvReqs.map((p) => ({
      entityType: "pre-inventory-requirement" as const,
      id: p.id,
      label: `Pre-Inventory Requirement — ${p.item.name}`,
      detail: `${p.requiredQty} ${p.unit}`,
      deletedAt: p.deletedAt!.toISOString(),
      deletedBy: p.deletedBy,
    })),
  ];

  return rows.sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
}

recycleBinRouter.get("/", requireRole("ADMIN"), async (_req, res, next) => {
  try {
    res.json(await collectAll());
  } catch (err) {
    next(err);
  }
});

// One restore action per entity type — each just clears deletedAt/
// deletedById; every read path this row feeds already filters
// deletedAt: null, so the row reappears in ordinary use the instant
// this runs, no other state to reconcile.
const RESTORE_HANDLERS: Record<BinEntityType, (id: string) => Promise<{ found: boolean }>> = {
  "inventory-transaction": async (id) => {
    const result = await prisma.inventoryTransaction.updateMany({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null, deletedById: null } });
    return { found: result.count > 0 };
  },
  "dispatch-transfer": async (id) => {
    const result = await prisma.dispatchTransfer.updateMany({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null, deletedById: null } });
    return { found: result.count > 0 };
  },
  "inventory-request": async (id) => {
    const result = await prisma.inventoryRequest.updateMany({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null, deletedById: null } });
    return { found: result.count > 0 };
  },
  "po-material-requirement": async (id) => {
    const result = await prisma.poMaterialRequirement.updateMany({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null, deletedById: null } });
    return { found: result.count > 0 };
  },
  "purchase-order-item": async (id) => {
    const result = await prisma.purchaseOrderItem.updateMany({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null, deletedById: null } });
    return { found: result.count > 0 };
  },
  "purchase-order-document": async (id) => {
    const result = await prisma.purchaseOrderDocument.updateMany({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null, deletedById: null } });
    return { found: result.count > 0 };
  },
  "bom-plan-item": async (id) => {
    const result = await prisma.bomPlanItem.updateMany({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null, deletedById: null } });
    return { found: result.count > 0 };
  },
  "rm-plan-item": async (id) => {
    const result = await prisma.rmPlanItem.updateMany({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null, deletedById: null } });
    return { found: result.count > 0 };
  },
  "pre-inventory-requirement": async (id) => {
    const result = await prisma.preInventoryRequirement.updateMany({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null, deletedById: null } });
    return { found: result.count > 0 };
  },
};

recycleBinRouter.post("/:entityType/:id/restore", requireRole("ADMIN"), async (req: AuthedRequest<{ entityType: string; id: string }>, res, next) => {
  try {
    const entityType = req.params.entityType as BinEntityType;
    const handler = RESTORE_HANDLERS[entityType];
    if (!handler) return res.status(400).json({ error: "Unknown entity type" });

    const { found } = await handler(req.params.id);
    if (!found) return res.status(404).json({ error: "Nothing in the Recycle Bin matches that — it may have already been restored." });

    await recordAudit({ actorId: req.user!.id, action: "recycle_bin.restored", entityType, entityId: req.params.id });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
