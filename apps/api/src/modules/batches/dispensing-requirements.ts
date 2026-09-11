import { prisma } from "../../common/lib/prisma";
import type { RmMasterResult } from "../rm-costing/rm-costing-engine";
import type { BomResult } from "../packaging-bom/bom-engine";

// --- What does this batch actually need to fully Dispense? Pulled from
// the PO item's own already-calculated RmPlan (RM ingredients) / BomPlan
// (PM components) — the exact same rollup "Send to Pre-Inventory"
// already turns into requirement rows (see rm-plan.routes.ts /
// bom-plan.routes.ts's own send-to-pre-inventory handlers), just read
// here instead of written. If neither plan exists (or neither is
// CALCULATED yet), there's nothing to check against — same "no data, no
// gate" rule as the PO Readiness gate on batch creation. ---

export interface RequiredDispensingItem {
  itemId: string;
  itemName: string;
  category: "RM" | "PM";
  unit: string;
  requiredQty: number;
}

interface SourceRow {
  category: "RM" | "PM";
  itemName: string;
  unit: string;
  requiredQty: number;
}

export async function getRequiredDispensingItems(purchaseOrderItemId: string): Promise<RequiredDispensingItem[]> {
  const [rmPlan, bomPlan] = await Promise.all([
    prisma.rmPlan.findFirst({ where: { purchaseOrderItemId, status: "CALCULATED" }, orderBy: { calculatedAt: "desc" } }),
    prisma.bomPlan.findFirst({ where: { purchaseOrderItemId, status: "CALCULATED" }, orderBy: { calculatedAt: "desc" } }),
  ]);
  if (!rmPlan && !bomPlan) return [];

  const rows: SourceRow[] = [];

  if (rmPlan?.resultSnapshot) {
    const result = rmPlan.resultSnapshot as unknown as RmMasterResult;
    for (const line of result.procurement) {
      if (line.totalKg > 0) rows.push({ category: "RM", itemName: line.name, unit: "Kg", requiredQty: line.totalKg });
    }
  }
  if (bomPlan?.resultSnapshot) {
    const result = bomPlan.resultSnapshot as unknown as BomResult;
    for (const line of result.lines) {
      if (line.totalQty > 0) rows.push({ category: "PM", itemName: `${line.component} — ${line.spec}`, unit: "Count", requiredQty: line.totalQty });
    }
  }
  if (rows.length === 0) return [];

  // Resolve every distinct (category, name) pair to a real InventoryItem
  // id, creating any item not already in the catalog — same
  // resolve-or-create pattern used identically in po-readiness.routes.ts /
  // bom-plan.routes.ts / rm-plan.routes.ts / pre-inventory.routes.ts. An
  // item mentioned by a calculated plan has to exist for Store to log
  // consumption against it in the first place (the Dispensing item
  // picker only offers real catalog items), so this can't just skip
  // creating it.
  const uniqueItems = new Map<string, { category: "RM" | "PM"; name: string }>();
  for (const row of rows) uniqueItems.set(`${row.category}::${row.itemName}`, { category: row.category, name: row.itemName });

  const itemIds = new Map<string, string>();
  for (const [key, { category, name }] of uniqueItems) {
    const existing = await prisma.inventoryItem.findUnique({ where: { category_name: { category, name } } });
    itemIds.set(key, existing ? existing.id : (await prisma.inventoryItem.create({ data: { category, name } })).id);
  }

  return rows.map((row) => ({
    itemId: itemIds.get(`${row.category}::${row.itemName}`)!,
    itemName: row.itemName,
    category: row.category,
    unit: row.unit,
    requiredQty: row.requiredQty,
  }));
}

// Scales the PO item's *full* required list (above) down to just this
// run's own share — PreProduction is 1:1 with a PO item now, so
// plannedQty is normally the item's whole ordered quantity and this is a
// no-op scale of 1; it stays a scale (rather than just returning
// `required` unchanged) so a run deliberately planned for less than the
// item's full quantity still gets a proportionally scaled requirement,
// same reasoning the old per-Batch version of this used.
export async function getScaledRequiredDispensingItems(preProductionId: string, purchaseOrderItemId: string): Promise<RequiredDispensingItem[]> {
  const [run, poItem] = await Promise.all([
    prisma.preProduction.findUnique({ where: { id: preProductionId }, select: { plannedQty: true } }),
    prisma.purchaseOrderItem.findUnique({ where: { id: purchaseOrderItemId }, select: { quantity: true } }),
  ]);
  const required = await getRequiredDispensingItems(purchaseOrderItemId);
  // No plannedQty yet or no ordered quantity to scale against — same
  // "no data, no gate change" rule as everywhere else in this app: fall
  // back to the full, unscaled amount rather than guessing.
  if (!run?.plannedQty || !poItem?.quantity) return required;
  const scale = run.plannedQty / poItem.quantity;
  return required.map((item) => ({ ...item, requiredQty: item.requiredQty * scale }));
}

// The same (now run-scaled) required list, plus how much of each has
// actually been logged against this run so far — used both by the
// Dispensing gate itself and by GET /:id/dispensing-requirements (the
// frontend checklist).
export interface DispensingRequirementStatus extends RequiredDispensingItem {
  consumedQty: number;
  covered: boolean;
}

export async function getDispensingRequirementStatus(preProductionId: string, purchaseOrderItemId: string): Promise<DispensingRequirementStatus[]> {
  const required = await getScaledRequiredDispensingItems(preProductionId, purchaseOrderItemId);
  if (required.length === 0) return [];

  // PRODUCTION-purpose only — a SAMPLE or WASTE line was dispensed too,
  // but neither one counts as "used in the run" against this requirement
  // (see BatchConsumptionPurpose's own comment in schema.prisma).
  const consumed = await prisma.batchMaterialConsumption.groupBy({ by: ["itemId"], where: { preProductionId, purpose: "PRODUCTION" }, _sum: { quantity: true } });
  const consumedByItem = new Map(consumed.map((c) => [c.itemId, c._sum.quantity ?? 0]));

  return required.map((item) => {
    const consumedQty = consumedByItem.get(item.itemId) ?? 0;
    return { ...item, consumedQty, covered: consumedQty >= item.requiredQty };
  });
}
