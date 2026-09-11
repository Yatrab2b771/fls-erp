/**
 * Master Procurement BOM engine — a direct, pure-function port of
 * `calculateMasterBOM()` from workplace/index (2).html.
 *
 * Deliberately kept dependency-free (no Prisma, no Express) so it can be
 * unit-tested against fixed inputs/outputs and reused unchanged by both the
 * calculate endpoint and, later, the Excel/PDF exporters.
 */

export type BomCategory = "1-Primary" | "2-Secondary" | "3-Tertiary";

/** Packaging spec fields, named exactly like the source spreadsheet columns. */
export interface SkuSpec {
  jar?: string | null;
  wadMm?: string | null;
  scoopMl?: string | null;
  silicaGelGms?: string | null;
  silicaGelQtyNos?: string | null;
  authenticationSticker?: string | null;
  capSticker?: string | null;
  capLockSticker?: string | null;
  neckSleeve?: string | null;
  shrink?: string | null;
  innerPackaging?: string | null;
  leaflet?: string | null;
  corrugatedBoxMm?: string | null;
  packagingSizeNos?: string | null;
}

// One row of the real, list-based Packaging BOM checklist (see
// SkuPackagingComponent's own schema comment) — a product's own
// component list, alongside (not replacing) the fixed spec fields above.
export interface PackagingComponentInput {
  type: string;
  quantity: number | null;
  unit: string;
  pmCode?: string | null;
}

export interface BomPlanLineInput {
  brandName: string;
  productName: string;
  targetYield: number;
  spec: SkuSpec;
  packagingComponents?: PackagingComponentInput[];
}

export interface BomResultLine {
  category: BomCategory;
  component: string;
  spec: string;
  baseQty: number;
  wastageRate: number;
  bufferQty: number;
  totalQty: number;
  /** Brand+SKU label -> quantity contributed, e.g. "BrandX (Product Y)": 500 */
  sources: Record<string, number>;
}

export interface BomResult {
  totalYield: number;
  brands: string[];
  lines: BomResultLine[];
}

// Same "is this cell meaningfully filled in" rule as the prototype: blank,
// zero, "N/A" and "NaN" (any case) all mean "this SKU doesn't use this component".
function isValid(val: unknown): boolean {
  if (val === undefined || val === null || val === "") return false;
  const str = String(val).trim().toLowerCase();
  if (str === "0" || str === "0.0" || str === "n/a" || str === "nan") return false;
  return true;
}

// Whether a Sku actually carries real packaging data — either the legacy
// flat spec fields (the 826-SKU original import) or the newer
// packagingComponents checklist, same two sources calculateMasterBOM
// itself reads below. A bare Sku row with neither (the PO form's own
// "+ New" quick-add, or R&D's manual "+ Add" before ticking anything)
// doesn't count as "R&D has defined this product's BOM" just because the
// row exists — see bom-plan.routes.ts's Generate/Calculate and
// recipe-request.routes.ts's checkGap/resolveBomRequests, all of which
// share this one definition of "real match" rather than each re-deriving
// their own.
export function hasBomSpec(input: { spec?: SkuSpec | null; packagingComponents?: PackagingComponentInput[] | null }): boolean {
  const spec = input.spec;
  const flatFieldsFilled =
    !!spec &&
    (isValid(spec.jar) ||
      isValid(spec.wadMm) ||
      isValid(spec.scoopMl) ||
      (isValid(spec.silicaGelGms) && isValid(spec.silicaGelQtyNos)) ||
      isValid(spec.authenticationSticker) ||
      isValid(spec.capSticker) ||
      isValid(spec.capLockSticker) ||
      isValid(spec.neckSleeve) ||
      isValid(spec.shrink) ||
      isValid(spec.innerPackaging) ||
      isValid(spec.leaflet) ||
      (isValid(spec.corrugatedBoxMm) && isValid(spec.packagingSizeNos)));
  return flatFieldsFilled || (input.packagingComponents?.length ?? 0) > 0;
}

function cleanString(str: unknown): string {
  return String(str ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

export function calculateMasterBOM(items: BomPlanLineInput[]): BomResult {
  interface AggEntry {
    category: BomCategory;
    component: string;
    spec: string;
    base: number;
    wastageRate: number;
    sources: Record<string, number>;
  }

  const aggregatedMap = new Map<string, AggEntry>();
  let totalYield = 0;
  const brandsInvolved = new Set<string>();

  for (const item of items) {
    const { targetYield, spec, brandName, productName } = item;
    totalYield += targetYield;
    brandsInvolved.add(brandName);

    const sourceKey = `${brandName} (${productName})`;

    const pushMaterial = (category: BomCategory, component: string, rawSpec: unknown, baseQty: number) => {
      const cleanSpec = cleanString(rawSpec);
      if (!cleanSpec) return;

      const key = `${category}_|_${component}_|_${cleanSpec}`;
      let entry = aggregatedMap.get(key);
      if (!entry) {
        entry = {
          category,
          component,
          spec: cleanSpec,
          base: 0,
          wastageRate: category === "3-Tertiary" ? 0 : 0.02,
          sources: {},
        };
        aggregatedMap.set(key, entry);
      }
      entry.base += baseQty;
      entry.sources[sourceKey] = (entry.sources[sourceKey] ?? 0) + baseQty;
    };

    // 1. Primary
    if (isValid(spec.jar)) pushMaterial("1-Primary", "Jar/Container", spec.jar, targetYield);
    if (isValid(spec.wadMm)) pushMaterial("1-Primary", "Seal Wad", spec.wadMm, targetYield);
    if (isValid(spec.scoopMl)) pushMaterial("1-Primary", "Measuring Scoop", spec.scoopMl, targetYield);

    if (isValid(spec.silicaGelGms) && isValid(spec.silicaGelQtyNos)) {
      const qtyPerUnit = parseFloat(String(spec.silicaGelQtyNos));
      if (qtyPerUnit > 0) {
        pushMaterial("1-Primary", "Silica Gel Desiccant", `${spec.silicaGelGms} Gms`, targetYield * qtyPerUnit);
      }
    }

    // 2. Secondary
    if (isValid(spec.authenticationSticker)) pushMaterial("2-Secondary", "Auth Hologram", "Standard Sticker", targetYield);
    if (isValid(spec.capSticker) || isValid(spec.capLockSticker)) {
      pushMaterial("2-Secondary", "Cap Branding/Lock", "Standard Seal", targetYield);
    }
    if (isValid(spec.neckSleeve) || isValid(spec.shrink)) {
      pushMaterial("2-Secondary", "Neck Sleeve / Shrink", spec.shrink || "Tamper Wrap", targetYield);
    }
    if (isValid(spec.innerPackaging)) pushMaterial("2-Secondary", "Inner Protection", spec.innerPackaging, targetYield);
    if (isValid(spec.leaflet)) pushMaterial("2-Secondary", "Product Leaflet", "Standard Insert", targetYield);

    // 3. Tertiary
    if (isValid(spec.corrugatedBoxMm) && isValid(spec.packagingSizeNos)) {
      const packSize = parseFloat(String(spec.packagingSizeNos));
      if (packSize > 0) {
        const boxesRequired = Math.ceil(targetYield / packSize);
        pushMaterial("3-Tertiary", "Corrugated Master Box", `${spec.corrugatedBoxMm} (Pack of ${packSize})`, boxesRequired);
      }
    }

    // 4. The real Packaging BOM checklist (SkuPackagingComponent) — a
    // list, not more fixed fields, so it covers types 1-3 above never
    // had a field for (Sachet, Tin Jar, Laminate, two simultaneous
    // Silica sizes, ...). Category is a best-effort guess from the type
    // name, since this list has no fixed category of its own: a
    // box/carton/shipper type gets the same "how many finished units
    // per box" math as corrugatedBoxMm/packagingSizeNos above (its
    // quantity means units-per-box, not boxes-per-unit); everything else
    // is a straight qty-per-unit multiply, same as every fixed field
    // above. The PM Code (when known) is what actually distinguishes two
    // same-named components as different physical items when aggregating
    // across products — without one, same-named components merge, same
    // limitation the fixed fields above already have with a generic spec.
    for (const comp of item.packagingComponents ?? []) {
      const typeLower = comp.type.toLowerCase();
      const isBoxType = /box|carton|shipper/.test(typeLower);
      const isPrimaryType = /jar|pouch|sachet|tin|monocarton|scoop|wad/.test(typeLower);
      const category: BomCategory = isBoxType ? "3-Tertiary" : isPrimaryType ? "1-Primary" : "2-Secondary";
      const specLabel = comp.pmCode?.trim() || comp.unit || "Standard";

      if (isBoxType && comp.quantity && comp.quantity > 0) {
        const boxesRequired = Math.ceil(targetYield / comp.quantity);
        pushMaterial(category, comp.type, `${specLabel} (Pack of ${comp.quantity})`, boxesRequired);
      } else {
        const perUnitQty = comp.quantity && comp.quantity > 0 ? comp.quantity : 1;
        pushMaterial(category, comp.type, specLabel, targetYield * perUnitQty);
      }
    }
  }

  const lines: BomResultLine[] = Array.from(aggregatedMap.values())
    .map((entry) => {
      const bufferQty = Math.ceil(entry.base * entry.wastageRate);
      return {
        category: entry.category,
        component: entry.component,
        spec: entry.spec,
        baseQty: entry.base,
        wastageRate: entry.wastageRate,
        bufferQty,
        totalQty: entry.base + bufferQty,
        sources: entry.sources,
      };
    })
    .sort((a, b) => (a.category !== b.category ? a.category.localeCompare(b.category) : a.component.localeCompare(b.component)));

  return {
    totalYield,
    brands: Array.from(brandsInvolved),
    lines,
  };
}
