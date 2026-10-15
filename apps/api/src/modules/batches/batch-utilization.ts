import { prisma } from "../../common/lib/prisma";
import { getRequiredDispensingItems } from "./dispensing-requirements";

/**
 * A batch's Utilization is the account of the material of its plan. Two sheets, because the two kinds are used at different steps:
 *   RM  (raw material)       used while the batch is manufactured; complete -> end time, remarks and Mark Completed open
 *   PM  (packaging material) used at Packaging; complete -> Packaging status Completed, end time and remarks open
 * A sheet is complete when every material of its kind in the batch's plan has a Production quantity (A) logged against THAT batch.
 * A run with no calculated plan has no materials, so it is complete from the start (same "no plan, no gate" rule as Dispensing).
 * "Given" is what the Day Store dispensed for the batch; it is information (the Difference), never a rule.
 */
export interface UtilizationPart {
  required: number;
  logged: number;
  missing: string[]; // names of the materials that have no Production quantity on this batch yet
  complete: boolean;
}

export interface UtilizationItem {
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  requiredQty: number; // this batch's share of the plan
  givenQty: number; // what was dispensed for this batch
}

export interface BatchUtilizationStatus extends UtilizationPart {
  /** The PM sheet (Packaging). The fields above are the RM sheet. */
  pm: UtilizationPart;
  items: UtilizationItem[];
}

const part = (items: { id: string; name: string }[], logged: Set<string>, batchId: string): UtilizationPart => {
  const missing = items.filter((i) => !logged.has(`${batchId}::${i.id}`)).map((i) => i.name);
  return { required: items.length, logged: items.length - missing.length, missing, complete: missing.length === 0 };
};

export async function utilizationOfBatches(purchaseOrderItemId: string, batches: { id: string; plannedQty: number }[]): Promise<Map<string, BatchUtilizationStatus>> {
  const result = new Map<string, BatchUtilizationStatus>();
  if (batches.length === 0) return result;
  const [required, poItem] = await Promise.all([getRequiredDispensingItems(purchaseOrderItemId), prisma.purchaseOrderItem.findUnique({ where: { id: purchaseOrderItemId }, select: { quantity: true } })]);
  const ids = batches.map((b) => b.id);
  const itemIds = required.map((r) => r.itemId);
  const [consumed, given] = required.length
    ? await Promise.all([
        prisma.batchMaterialConsumption.groupBy({ by: ["productionBatchId", "itemId"], where: { productionBatchId: { in: ids }, purpose: "PRODUCTION", itemId: { in: itemIds } }, _sum: { quantity: true } }),
        prisma.batchDispensingLine.groupBy({ by: ["productionBatchId", "itemId"], where: { productionBatchId: { in: ids }, itemId: { in: itemIds } }, _sum: { quantity: true } }),
      ])
    : [[], []];
  const logged = new Set(consumed.filter((r) => (r._sum.quantity ?? 0) > 0).map((r) => `${r.productionBatchId}::${r.itemId}`));
  const givenBy = new Map(given.map((r) => [`${r.productionBatchId}::${r.itemId}`, r._sum.quantity ?? 0]));
  const rm = required.filter((r) => r.category === "RM").map((r) => ({ id: r.itemId, name: r.itemName }));
  const pm = required.filter((r) => r.category === "PM").map((r) => ({ id: r.itemId, name: r.itemName }));
  for (const b of batches) {
    const scale = poItem && poItem.quantity > 0 ? b.plannedQty / poItem.quantity : 1;
    result.set(b.id, {
      ...part(rm, logged, b.id),
      pm: part(pm, logged, b.id),
      items: required.map((r) => ({ itemId: r.itemId, itemName: r.itemName, category: r.category, unit: r.unit, requiredQty: Math.round(r.requiredQty * scale * 1000) / 1000, givenQty: givenBy.get(`${b.id}::${r.itemId}`) ?? 0 })),
    });
  }
  return result;
}

/** The message shown when Production tries to go on before the Utilization is complete. */
export function utilizationGapMessage(u: UtilizationPart, what: string, kind: "RM" | "PM" = "RM"): string {
  const shown = u.missing.slice(0, 4).join(", ");
  return `Fill the ${kind} Utilization first: ${u.missing.length} of ${u.required} materials have no Production quantity on this batch yet (${shown}${u.missing.length > 4 ? ", ..." : ""}). Then ${what}.`;
}
