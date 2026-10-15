import type { BoardMaterial } from "./hooks";

// Material Utilization maths for one material in one batch.
//   A = used in production, B = wastage, C = rejected, D = sample, E = leftover (stays in the Plant's stock until it is sent back)
//   Material Used = A + B + C + D            (what the batch really took out of stock)
//   Batch yield   = A / Material Used        (how much of it ended up in the product)
export const q3 = (n: number) => Math.round(n * 1000) / 1000;

export function materialUsed(m: Pick<BoardMaterial, "consumedQty" | "wastedQty" | "rejectedQty" | "sampleQty" | "returnedQty">): number {
  // E (leftover) is not used: it stays in the Plant's stock until it is sent back to the Day Store
  return q3(m.consumedQty + m.wastedQty + m.rejectedQty + m.sampleQty);
}

/** Yield as a percentage, or null when nothing was used. */
export function yieldPct(m: Pick<BoardMaterial, "consumedQty" | "wastedQty" | "rejectedQty" | "sampleQty" | "returnedQty">): number | null {
  const used = materialUsed(m);
  return used > 0 ? Math.round((m.consumedQty / used) * 1000) / 10 : null;
}

/** The batch's own yield: A over Material Used, summed across its materials that are counted in Kg-type units (RM). */
export function batchYieldPct(materials: BoardMaterial[]): number | null {
  const rm = materials.filter((m) => m.category === "RM");
  const list = rm.length ? rm : materials;
  const a = list.reduce((sum, m) => sum + m.consumedQty, 0);
  const used = list.reduce((sum, m) => sum + materialUsed(m), 0);
  return used > 0 ? Math.round((a / used) * 1000) / 10 : null;
}

/** The same material across several batches added up into one line per material. */
export function sumMaterials(lists: BoardMaterial[][]): BoardMaterial[] {
  const byItem = new Map<string, BoardMaterial>();
  for (const m of lists.flat()) {
    const have = byItem.get(m.itemId);
    if (!have) {
      byItem.set(m.itemId, { ...m });
      continue;
    }
    have.consumedQty += m.consumedQty;
    have.wastedQty += m.wastedQty;
    have.rejectedQty += m.rejectedQty;
    have.sampleQty += m.sampleQty;
    have.returnedQty += m.returnedQty;
  }
  return [...byItem.values()].sort((a, b) => a.itemName.localeCompare(b.itemName));
}

/** What a batch took out of stock, counting raw material only (falls back to everything when there is no RM). */
export function batchMaterialUsed(materials: BoardMaterial[]): number {
  const rm = materials.filter((m) => m.category === "RM");
  return q3((rm.length ? rm : materials).reduce((sum, m) => sum + materialUsed(m), 0));
}

/** Accounted (A+B+C+D+E) minus what the Day Store gave: positive = more than given, negative = left unaccounted. Information only. */
export function utilizationDifference(m: Pick<BoardMaterial, "consumedQty" | "wastedQty" | "rejectedQty" | "sampleQty" | "returnedQty">, givenQty: number): number {
  return q3(m.consumedQty + m.wastedQty + m.rejectedQty + m.sampleQty + m.returnedQty - givenQty);
}

export const UTILIZATION_COLUMNS = [
  { key: "consumedQty", short: "A", label: "Production" },
  { key: "wastedQty", short: "B", label: "Wastage" },
  { key: "rejectedQty", short: "C", label: "Rejected" },
  { key: "sampleQty", short: "D", label: "Sample" },
  { key: "returnedQty", short: "E", label: "Return to Store" },
] as const;
