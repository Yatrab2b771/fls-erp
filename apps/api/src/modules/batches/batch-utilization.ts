import { prisma } from "../../common/lib/prisma";
import { effectiveBomSlot, getRequiredDispensingItems, type RequiredDispensingItem } from "./dispensing-requirements";

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

/** What Production entered for the whole batch (the four product-level numbers) for one kind of material. */
export interface UtilizationSheetValues {
  producedQty: number;
  wasteQty: number;
  rejectQty: number;
  sampleQty: number;
}

/** One material's saved Utilization on a batch (A used, B waste, C reject, D sample), plan material or extra. */
export interface UtilizationEntry {
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  consumedQty: number;
  wastedQty: number;
  rejectedQty: number;
  sampleQty: number;
}

export interface BatchUtilizationStatus extends UtilizationPart {
  /** The PM sheet (Packaging). The fields above are the RM sheet. */
  pm: UtilizationPart;
  items: UtilizationItem[];
  /** The product-level numbers saved for the batch, per kind of material (null = not saved yet). */
  sheets: { RM: UtilizationSheetValues | null; PM: UtilizationSheetValues | null };
  /** What is saved material by material on the batch (so the form opens with it). */
  entries: UtilizationEntry[];
  /** Material the Store issued as an extra request for this batch that is not in its plan (givenQty is what was issued): listed so Production fills in what it used. */
  extraItems: UtilizationItem[];
  /** How many finished packs this batch is planned to make (the PM plan's target yield, scaled to the batch): the basis the PM sheet is shared on. Null = no PM plan. */
  pmPacks: number | null;
}

const part = (items: { id: string; name: string }[], logged: Set<string>, batchId: string): UtilizationPart => {
  const missing = items.filter((i) => !logged.has(`${batchId}::${i.id}`)).map((i) => i.name);
  return { required: items.length, logged: items.length - missing.length, missing, complete: missing.length === 0 };
};

export async function utilizationOfBatches(purchaseOrderItemId: string, batches: { id: string; plannedQty: number }[]): Promise<Map<string, BatchUtilizationStatus>> {
  const result = new Map<string, BatchUtilizationStatus>();
  if (batches.length === 0) return result;
  const [poItem, bomPlan, batchSlots] = await Promise.all([
    prisma.purchaseOrderItem.findUnique({ where: { id: purchaseOrderItemId }, select: { quantity: true, productionBomSlot: true } }),
    prisma.bomPlan.findFirst({ where: { purchaseOrderItemId, status: "CALCULATED" }, orderBy: { calculatedAt: "desc" }, select: { items: { where: { deletedAt: null }, select: { targetYield: true } } } }),
    prisma.productionBatch.findMany({ where: { id: { in: batches.map((b) => b.id) } }, select: { id: true, bomSlot: true } }),
  ]);
  // Each batch follows its own BOM version (R&D can change it for the batches not dispensed yet): the plan's materials are worked out once per version.
  const slotOf = new Map(batchSlots.map((b) => [b.id, effectiveBomSlot(b.bomSlot, poItem?.productionBomSlot) ?? "BASE"]));
  const requiredBySlot = new Map<string, RequiredDispensingItem[]>();
  for (const key of new Set(slotOf.values())) requiredBySlot.set(key, await getRequiredDispensingItems(purchaseOrderItemId, key === "BASE" ? null : key));
  const required = [...new Map([...requiredBySlot.values()].flat().map((r) => [r.itemId, r])).values()];
  const ids = batches.map((b) => b.id);
  const [sheetRows, entryRows] = await Promise.all([
    prisma.batchUtilizationSheet.findMany({ where: { productionBatchId: { in: ids } } }),
    prisma.batchMaterialConsumption.groupBy({ by: ["productionBatchId", "itemId", "purpose"], where: { productionBatchId: { in: ids }, reworkId: null }, _sum: { quantity: true } }),
  ]);
  const entryItems = entryRows.length ? await prisma.inventoryItem.findMany({ where: { id: { in: [...new Set(entryRows.map((r) => r.itemId))] } }, select: { id: true, name: true, category: true, unit: true } }) : [];
  const itemOf = new Map(entryItems.map((i) => [i.id, i]));
  const totalPacks = bomPlan ? bomPlan.items.reduce((sum, i) => sum + i.targetYield, 0) : 0;
  const itemIds = required.map((r) => r.itemId);
  const [consumed, given] = required.length
    ? await Promise.all([
        prisma.batchMaterialConsumption.groupBy({ by: ["productionBatchId", "itemId"], where: { productionBatchId: { in: ids }, purpose: "PRODUCTION", itemId: { in: itemIds } }, _sum: { quantity: true } }),
        prisma.batchDispensingLine.groupBy({ by: ["productionBatchId", "itemId"], where: { productionBatchId: { in: ids }, itemId: { in: itemIds }, deliveryStatus: { not: "REFUSED" } }, _sum: { quantity: true } }),
      ])
    : [[], []];
  const logged = new Set(consumed.filter((r) => (r._sum.quantity ?? 0) > 0).map((r) => `${r.productionBatchId}::${r.itemId}`));
  const givenBy = new Map(given.map((r) => [`${r.productionBatchId}::${r.itemId}`, r._sum.quantity ?? 0]));
  // Material the Day Store issued as an extra request for the batch (R&D's change after it was dispensed) is part of what the batch was given.
  const extraIssued = await prisma.inventoryRequest.findMany({ where: { productionBatchId: { in: ids }, deletedAt: null }, select: { productionBatchId: true, itemId: true, fulfillments: { where: { deletedAt: null }, select: { quantity: true } } } });
  const planItemIds = new Set(itemIds);
  const extraGiven = new Map<string, number>(); // batch::item -> issued, for material outside the plan
  for (const x of extraIssued) {
    const key = `${x.productionBatchId}::${x.itemId}`;
    const qty = x.fulfillments.reduce((t, f) => t + f.quantity, 0);
    givenBy.set(key, (givenBy.get(key) ?? 0) + qty);
    if (!planItemIds.has(x.itemId)) extraGiven.set(key, (extraGiven.get(key) ?? 0) + qty);
  }
  const extraInfo = extraGiven.size ? new Map((await prisma.inventoryItem.findMany({ where: { id: { in: [...new Set([...extraGiven.keys()].map((k) => k.split("::")[1]!))] } }, select: { id: true, name: true, category: true, unit: true } })).map((i) => [i.id, i])) : new Map<string, { id: string; name: string; category: string; unit: string | null }>();
  for (const b of batches) {
    const requiredOfBatch = requiredBySlot.get(slotOf.get(b.id) ?? "BASE") ?? [];
    const rm = requiredOfBatch.filter((r) => r.category === "RM").map((r) => ({ id: r.itemId, name: r.itemName }));
    const pm = requiredOfBatch.filter((r) => r.category === "PM").map((r) => ({ id: r.itemId, name: r.itemName }));
    const scale = poItem && poItem.quantity > 0 ? b.plannedQty / poItem.quantity : 1;
    const mine = entryRows.filter((r) => r.productionBatchId === b.id);
    const entries: UtilizationEntry[] = [...new Set(mine.map((r) => r.itemId))].flatMap((itemId) => {
      const item = itemOf.get(itemId);
      if (!item || (item.category !== "RM" && item.category !== "PM")) return [];
      const sum = (purpose: string) => mine.filter((r) => r.itemId === itemId && r.purpose === purpose).reduce((t, r) => t + (r._sum.quantity ?? 0), 0);
      return [{ itemId, itemName: item.name, category: item.category, unit: item.unit ?? (item.category === "RM" ? "Kg" : "Count"), consumedQty: sum("PRODUCTION"), wastedQty: sum("WASTE"), rejectedQty: sum("REJECTED"), sampleQty: sum("SAMPLE") }];
    });
    const sheetOf = (category: string): UtilizationSheetValues | null => {
      const row = sheetRows.find((r) => r.productionBatchId === b.id && r.category === category);
      return row ? { producedQty: row.producedQty, wasteQty: row.wasteQty, rejectQty: row.rejectQty, sampleQty: row.sampleQty } : null;
    };
    result.set(b.id, {
      sheets: { RM: sheetOf("RM"), PM: sheetOf("PM") },
      entries,
      extraItems: [...extraGiven.entries()].flatMap(([key, qty]) => {
        const [batchId, itemId] = key.split("::") as [string, string];
        const item = extraInfo.get(itemId);
        if (batchId !== b.id || qty <= 0 || !item || (item.category !== "RM" && item.category !== "PM")) return [];
        return [{ itemId, itemName: item.name, category: item.category as "RM" | "PM", unit: item.unit ?? (item.category === "RM" ? "Kg" : "Count"), requiredQty: 0, givenQty: Math.round(qty * 1000) / 1000 }];
      }),
      pmPacks: totalPacks > 0 ? Math.round(totalPacks * scale * 1000) / 1000 : null,
      ...part(rm, logged, b.id),
      pm: part(pm, logged, b.id),
      items: requiredOfBatch.map((r) => ({ itemId: r.itemId, itemName: r.itemName, category: r.category, unit: r.unit, requiredQty: Math.round(r.requiredQty * scale * 1000) / 1000, givenQty: givenBy.get(`${b.id}::${r.itemId}`) ?? 0 })),
    });
  }
  return result;
}

/** The message shown when Production tries to go on before the Utilization is complete. */
export function utilizationGapMessage(u: UtilizationPart, what: string, kind: "RM" | "PM" = "RM"): string {
  const shown = u.missing.slice(0, 4).join(", ");
  return `Fill the ${kind} Utilization first: ${u.missing.length} of ${u.required} materials have no Production quantity on this batch yet (${shown}${u.missing.length > 4 ? ", ..." : ""}). Then ${what}.`;
}
