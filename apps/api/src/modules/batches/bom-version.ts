import type { RoleName } from "@prisma/client";
import { prisma } from "../../common/lib/prisma";
import { effectiveBomSlot } from "./dispensing-requirements";

/**
 * Which BOM version a batch was made from (Display BOM, or R&D's V1 / V2), and why, for the batch reports and the BMR.
 *
 * A batch follows the version R&D chose for it once the product was with Production (ProductionBatch.bomSlot / the product's productionBomSlot);
 * otherwise the plan PPIC knows (the product's activeBomSlot). What R&D changed once the product was with Production is not PPIC's to see, so
 * for a viewer who is only PPIC the version shown is the plan's own, and the Production-phase reasons are left out.
 */
export const BOM_SLOT_LABEL: Record<string, string> = { DISPLAY: "Display BOM", V1: "V1", V2: "V2" };

export interface BatchBomVersion {
  /** DISPLAY / V1 / V2 */
  slot: string;
  label: string;
  /** The latest change that made the product use this version: who, when and why (null for the Display BOM or when nothing was recorded). */
  note: string | null;
}

const PRODUCTION_SIDE: RoleName[] = ["RND", "PRODUCTION", "STORE", "ADMIN"] as RoleName[];

export async function bomVersionsOfBatches(batches: { id: string; bomSlot: string | null; purchaseOrderItemId: string }[], roles: RoleName[]): Promise<Map<string, BatchBomVersion>> {
  const out = new Map<string, BatchBomVersion>();
  if (batches.length === 0) return out;
  const seesProduction = roles.some((r) => PRODUCTION_SIDE.includes(r));
  const itemIds = [...new Set(batches.map((b) => b.purchaseOrderItemId))];
  const [items, switches] = await Promise.all([
    prisma.purchaseOrderItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, activeBomSlot: true, productionBomSlot: true } }),
    prisma.itemBomSwitch.findMany({ where: { purchaseOrderItemId: { in: itemIds }, ...(seesProduction ? {} : { phase: "PLANNING" }) }, orderBy: { createdAt: "desc" } }),
  ]);
  const itemOf = new Map(items.map((i) => [i.id, i]));
  const actorIds = [...new Set(switches.map((s) => s.actorId))];
  const users = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true } }) : [];
  const nameOf = new Map(users.map((u) => [u.id, u.fullName]));

  for (const b of batches) {
    const item = itemOf.get(b.purchaseOrderItemId);
    if (!item) continue;
    const slot = (seesProduction ? effectiveBomSlot(b.bomSlot, item.productionBomSlot) : null) ?? item.activeBomSlot;
    const change = slot === "DISPLAY" ? null : switches.find((s) => s.purchaseOrderItemId === item.id && s.toSlot === slot);
    const note = change ? `${nameOf.get(change.actorId) ?? "R&D"}, ${change.createdAt.toISOString().slice(0, 10)}: ${change.reason}` : null;
    out.set(b.id, { slot, label: BOM_SLOT_LABEL[slot] ?? slot, note });
  }
  return out;
}
