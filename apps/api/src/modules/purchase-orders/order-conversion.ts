import { prisma } from "../../common/lib/prisma";

// A PO line is ordered in Kg or in SKU (packs). The packaging BOM works in packs and the RM BOM works in Kg, so one is turned into the other with
// the pack size (how much one pack weighs):  SKU -> Kg = packs x pack size;  Kg -> packs = Kg / pack size.
// The pack size comes from the PO line ("120 g", "1 kg"), else from the product's Packaging BOM header. A gummies pack such as "60 Gummies"
// weighs 60 x the average gummy weight of the product's RM BOM.

export const isKgUnit = (unit: string) => /^kgs?$/i.test(unit.trim());
export const isSkuUnit = (unit: string) => /^skus?$/i.test(unit.trim());
/** Only Kg and SKU orders are worked out automatically. */
export const isWorkableUnit = (unit: string) => isKgUnit(unit) || isSkuUnit(unit);

/** Kg that one pack weighs, from text such as "120 g", "1kg", "0.5 Kg" or "60 Gummies" (with the average gummy weight in mg). */
export function parsePackKg(text: string | null | undefined, gummyMg?: number | null): number | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const w = t.match(/(\d+(?:[.,]\d+)?)\s*(kgs?|kilograms?|gms?|grams?|g)\b/i);
  if (w) {
    const v = Number(w[1]!.replace(",", "."));
    if (!(v > 0)) return null;
    return /^k/i.test(w[2]!) ? v : v / 1000;
  }
  const c = t.match(/(\d+)\s*(gummies|gummy|gum)\b/i);
  if (c && gummyMg && gummyMg > 0) return (Number(c[1]) * gummyMg) / 1_000_000;
  return null;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const fmtPack = (kg: number) => (kg >= 1 ? `${fmt(kg)} Kg` : `${fmt(kg * 1000)} g`);

export interface OrderConversion {
  /** Packs for the packaging BOM, or null when it cannot be worked out. */
  packs: number | null;
  /** Kg for the RM BOM, or null when it cannot be worked out. */
  kg: number | null;
  packSizeText: string | null;
  packSizeSource: "PO line" | "Packaging BOM" | null;
  /** One line that shows the working, e.g. "600 SKU x 120 g = 72 Kg". */
  note: string | null;
  packsProblem: string | null;
  kgProblem: string | null;
}

export function convertOrder(input: { quantity: number; unit: string; poPackSize: string | null | undefined; bomPackSize: string | null | undefined; gummyMg?: number | null }): OrderConversion {
  const { quantity, unit } = input;
  const fromPo = parsePackKg(input.poPackSize, input.gummyMg);
  const fromBom = parsePackKg(input.bomPackSize, input.gummyMg);
  const kgPerPack = fromPo ?? fromBom;
  const packSizeText = fromPo != null ? (input.poPackSize ?? "").trim() : fromBom != null ? (input.bomPackSize ?? "").trim() : null;
  const packSizeSource = fromPo != null ? ("PO line" as const) : fromBom != null ? ("Packaging BOM" as const) : null;
  const missing = "Pack size is missing. Enter it on the PO line (for example 120 g or 1 kg) or in the product's Packaging BOM.";
  const base = { packSizeText, packSizeSource };

  if (isKgUnit(unit)) {
    const packs = kgPerPack ? Math.max(1, Math.round(quantity / kgPerPack)) : null;
    return { ...base, kg: quantity, packs, note: kgPerPack ? `${fmt(quantity)} Kg / ${fmtPack(kgPerPack)} = ${packs} packs` : null, packsProblem: kgPerPack ? null : missing, kgProblem: null };
  }
  if (isSkuUnit(unit)) {
    const packs = Math.max(1, Math.round(quantity));
    const kg = kgPerPack ? quantity * kgPerPack : null;
    return { ...base, packs, kg, note: kgPerPack ? `${fmt(quantity)} SKU x ${fmtPack(kgPerPack)} = ${fmt(kg!)} Kg` : null, packsProblem: null, kgProblem: kgPerPack ? null : missing };
  }
  const only = `This order is in ${unit}. Only Kg and SKU orders are worked out automatically.`;
  return { ...base, packs: null, kg: null, note: null, packsProblem: only, kgProblem: only };
}

/** The conversion of one PO line, looking up its product's pack size (Packaging BOM) and gummy weight (RM BOM) for that customer. */
export async function loadOrderConversion(item: { productName: string; quantity: number; unit: string; packSize: string | null }, customerId: string): Promise<OrderConversion> {
  const [sku, recipe] = await Promise.all([
    prisma.sku.findFirst({ where: { customerId, productName: { equals: item.productName, mode: "insensitive" } }, select: { packSize: true } }),
    prisma.recipe.findFirst({ where: { customerId, name: { equals: item.productName, mode: "insensitive" } }, select: { avgUnitWeightMg: true } }),
  ]);
  return convertOrder({ quantity: item.quantity, unit: item.unit, poPackSize: item.packSize, bomPackSize: sku?.packSize, gummyMg: recipe?.avgUnitWeightMg });
}
