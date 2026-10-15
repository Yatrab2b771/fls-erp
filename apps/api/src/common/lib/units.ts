import { RouteError } from "./route-error";

// Stock is added up per item as plain numbers, so a "Kg" entry and a "gm" entry for the same item would silently be summed as if
// they were the same unit. Units are free text on every movement; this is the one place that says whether two spellings mean the
// same thing ("Kg", "kgs", "KG." ...) and refuses the ones that do not ("gm" against an item kept in Kg).

const ALIASES: Record<string, string> = {
  kg: "kg",
  kgs: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  g: "g",
  gm: "g",
  gms: "g",
  gram: "g",
  grams: "g",
  mg: "mg",
  l: "l",
  lt: "l",
  ltr: "l",
  ltrs: "l",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  ml: "ml",
  no: "count",
  nos: "count",
  count: "count",
  pc: "count",
  pcs: "count",
  piece: "count",
  pieces: "count",
  unit: "count",
  units: "count",
  each: "count",
  ea: "count",
};

/** "Kgs." -> "kg"; a unit with no known alias is just lower-cased and trimmed. */
export function canonicalUnit(unit: string): string {
  const key = unit.trim().toLowerCase().replace(/\.$/, "").replace(/\s+/g, "");
  return ALIASES[key] ?? key;
}

export function unitsMatch(a: string, b: string): boolean {
  return canonicalUnit(a) === canonicalUnit(b);
}

/** The item is kept in one unit: a movement in another one is refused. An item with no unit set yet accepts anything. */
export function assertUnitMatchesItem(item: { name: string; unit: string | null }, unit: string): void {
  if (!item.unit || !item.unit.trim()) return;
  if (!unitsMatch(item.unit, unit)) {
    throw new RouteError(400, `${item.name} is kept in ${item.unit}, not ${unit}. Enter the quantity in ${item.unit} (convert it first) so stock is not mixed up.`);
  }
}
