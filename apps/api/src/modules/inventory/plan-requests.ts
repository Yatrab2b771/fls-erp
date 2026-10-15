import { prisma } from "../../common/lib/prisma";
import { recordAudit } from "../../common/lib/audit";
import { notifyRoles, notifyUser } from "../../common/lib/notify";
import { createPoMaterialRequirements } from "../po-readiness/po-readiness.routes";
import { pmLineName, type BomResult } from "../packaging-bom/bom-engine";
import type { RmMasterResult } from "../rm-costing/rm-costing-engine";

/**
 * A product's plan reaches its Plant's Day Store by itself.
 *
 * Once BOTH the RM plan and the Packaging plan of a PO product are calculated (the same moment the product shows in Material
 * Planning) and a Plant is assigned, every material of the plan becomes a production request for that Plant's Day Store - the
 * Day Store approves it, fills what it holds and asks the Warehouse for the rest. There is no "Send to Pre-Inventory" click.
 *
 * It is safe to call again (a recalculation, a Plant assigned later): a request is matched by (product, item), a request nobody
 * has touched yet follows the new quantity, a request that already has material issued against it is never changed, and a
 * request for a material that left the plan is dropped only while it is untouched. Requests Production raises at Indent Issue
 * (they carry a run) are never touched here.
 */

type Logger = { error: (obj: unknown, msg: string) => void };

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const OPEN = ["PENDING", "APPROVED", "PARTIALLY_ISSUED"] as const;

export interface RaiseOutcome {
  created: number;
  updated: number;
  removed: number;
}

export async function raiseRequestsForPlannedItem(poItemId: string, actorId: string): Promise<RaiseOutcome | null> {
  const item = await prisma.purchaseOrderItem.findUnique({
    where: { id: poItemId },
    select: {
      id: true,
      productName: true,
      deletedAt: true,
      cancelledAt: true,
      plannedPlantId: true,
      plannedPlant: { select: { id: true, name: true, dayStoreId: true } },
      purchaseOrderId: true,
      purchaseOrder: { select: { poNumber: true, status: true } },
      rmPlans: { where: { status: "CALCULATED" }, orderBy: { calculatedAt: "desc" }, take: 1, select: { resultSnapshot: true } },
      bomPlans: { where: { status: "CALCULATED" }, orderBy: { calculatedAt: "desc" }, take: 1, select: { resultSnapshot: true } },
    },
  });
  if (!item || item.deletedAt || item.cancelledAt || !item.plannedPlant) return null;
  if (item.purchaseOrder.status !== "APPROVED") return null;
  const rm = item.rmPlans[0]?.resultSnapshot as unknown as RmMasterResult | undefined;
  const bom = item.bomPlans[0]?.resultSnapshot as unknown as BomResult | undefined;
  if (!rm || !bom) return null; // half a plan would raise half the materials

  const needs = new Map<string, { category: "RM" | "PM"; name: string; qty: number; unit: string }>();
  const add = (category: "RM" | "PM", name: string, qty: number, unit: string) => {
    if (!(qty > 0) || !name) return;
    const key = `${category}::${name}`;
    const cur = needs.get(key);
    needs.set(key, cur ? { ...cur, qty: cur.qty + qty } : { category, name, qty, unit });
  };
  for (const p of rm.procurement ?? []) add("RM", p.name.trim(), p.totalKg, "Kg");
  for (const l of bom.lines ?? []) add("PM", pmLineName(l), l.totalQty, "Count");
  if (needs.size === 0) return { created: 0, updated: 0, removed: 0 };

  const itemIds = new Map<string, string>();
  for (const [key, n] of needs) {
    const existing = await prisma.inventoryItem.findUnique({ where: { category_name: { category: n.category, name: n.name } } });
    itemIds.set(key, existing ? existing.id : (await prisma.inventoryItem.create({ data: { category: n.category, name: n.name } })).id);
  }

  const existing = await prisma.inventoryRequest.findMany({
    where: { purchaseOrderItemId: item.id, purpose: "ISSUED_PRODUCTION", preProductionId: null, deletedAt: null },
    select: { id: true, itemId: true, requestedQty: true, status: true, plantId: true, fulfillments: { where: { deletedAt: null }, select: { id: true } } },
  });
  const byItem = new Map(existing.map((r) => [r.itemId, r]));
  const wantedItemIds = new Set(itemIds.values());

  const note = `Auto-raised from the plan of ${item.productName} (PO ${item.purchaseOrder.poNumber ?? item.purchaseOrderId.slice(0, 8)})`;
  const out: RaiseOutcome = { created: 0, updated: 0, removed: 0 };

  for (const [key, n] of needs) {
    const itemId = itemIds.get(key)!;
    const qty = round3(n.qty);
    const cur = byItem.get(itemId);
    if (!cur) {
      await prisma.inventoryRequest.create({
        data: { itemId, category: n.category, requestedQty: qty, purpose: "ISSUED_PRODUCTION", note, requestedById: actorId, purchaseOrderItemId: item.id, plantId: item.plannedPlantId },
      });
      out.created += 1;
    } else if (cur.status === "PENDING" && cur.fulfillments.length === 0 && (Math.abs(cur.requestedQty - qty) > 1e-6 || cur.plantId !== item.plannedPlantId)) {
      await prisma.inventoryRequest.update({ where: { id: cur.id }, data: { requestedQty: qty, plantId: item.plannedPlantId, note } });
      out.updated += 1;
    }
  }
  for (const r of existing) {
    if (wantedItemIds.has(r.itemId)) continue;
    if (r.status === "PENDING" && r.fulfillments.length === 0) {
      await prisma.inventoryRequest.update({ where: { id: r.id }, data: { deletedAt: new Date() } });
      out.removed += 1;
    }
  }

  // PO Readiness reads the same plan materials (its own upsert is repeatable).
  await createPoMaterialRequirements(
    item.purchaseOrderId,
    [...needs.values()].map((n) => ({ category: n.category, itemName: n.name, unit: n.unit, requiredQty: round3(n.qty) })),
    actorId,
  );

  if (out.created + out.updated + out.removed > 0) {
    await recordAudit({ actorId, action: "plan.requests_auto_raised", entityType: "PurchaseOrderItem", entityId: item.id, metadata: { ...out, plantId: item.plannedPlantId } });
  }
  if (out.created > 0) {
    const content = {
      title: `Plan ready: ${item.productName}`,
      body: `${out.created} material request(s) for ${item.plannedPlant.name} (PO ${item.purchaseOrder.poNumber ?? ""}). Check what you hold and what is short.`.replace("  ", " "),
      link: "/my-store/production-requests",
    };
    await notifyPlantDayStore(item.plannedPlant.dayStoreId, content, actorId);
  }
  return out;
}

/** Tells the users of a Plant's Day Store (the Warehouse-side Store seat when the Plant has none assigned). */
export async function notifyPlantDayStore(dayStoreId: string | null | undefined, content: { title: string; body: string; link: string }, actorId: string): Promise<void> {
  const users = dayStoreId ? await prisma.dayStoreAssignment.findMany({ where: { dayStoreId, user: { isActive: true } }, select: { userId: true } }) : [];
  if (users.length > 0) {
    await Promise.all(users.filter((u) => u.userId !== actorId).map((u) => notifyUser(u.userId, content)));
  } else {
    await notifyRoles(["STORE"], content, actorId);
  }
}

/** Same, but a failure never breaks the plan action that triggered it. */
export async function raiseRequestsForPlannedItemSafe(poItemId: string | null | undefined, actorId: string, log?: Logger): Promise<void> {
  if (!poItemId) return;
  try {
    await raiseRequestsForPlannedItem(poItemId, actorId);
  } catch (err) {
    log?.error({ err }, "raiseRequestsForPlannedItem failed");
  }
}
