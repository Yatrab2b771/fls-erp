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

export interface BomPlanLineInput {
  brandName: string;
  productName: string;
  targetYield: number;
  spec: SkuSpec;
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
