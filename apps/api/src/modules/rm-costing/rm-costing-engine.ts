/**
 * RM formulation engine: scales a recipe to a batch size and rolls the
 * ingredient quantities up into one RM procurement list. Pure, dependency-free
 * (no Prisma, no Express) so it can be unit-tested and reused by the
 * calculate endpoint and the Excel/PDF exporters, same rationale as
 * `packaging-bom/bom-engine.ts`. Quantities only: the system does no costing.
 */

export interface RecipeIngredientInput {
  name: string;
  brand: string;
  itemCode?: string | null;
  gPerServing: number;
  proteinPct: number;
}

export interface RecipeInput {
  name: string;
  totalServing: number;
  ingredients: RecipeIngredientInput[];
}

export interface RmBatchLineInput {
  recipe: RecipeInput;
  batchSizeKg: number;
}

export interface BatchIngredientResult {
  name: string;
  brand: string;
  itemCode?: string | null;
  proteinPct: number;
  gPerServing: number;
  perBatchGrams: number;
  qtyInKg: number;
}

export interface BatchCostingResult {
  recipeName: string;
  gmPerServing: number;
  batchSizeKg: number;
  servingsPerBatch: number;
  proteinPctInBatch: number;
  ingredients: BatchIngredientResult[];
}

export interface ProcurementLine {
  name: string;
  brand: string;
  itemCode?: string | null;
  totalKg: number;
  /** Recipe name -> quantity contributed, e.g. "CHOCOLATE PLANT NUTRITION": 12.5 */
  sources: Record<string, number>;
}

export interface RmMasterResult {
  batches: BatchCostingResult[];
  procurement: ProcurementLine[];
}

/** Scales one recipe to one batch size: per-ingredient grams/kg and protein % in the batch. */
export function calculateBatchCosting(recipe: RecipeInput, batchSizeKg: number): BatchCostingResult {
  const gmPerServing = recipe.totalServing;
  const servingsPerBatch = (batchSizeKg * 1000) / gmPerServing;

  let totalProteinGrams = 0;

  const ingredients: BatchIngredientResult[] = recipe.ingredients.map((ing) => {
    const perBatchGrams = ing.gPerServing * servingsPerBatch;
    totalProteinGrams += (ing.proteinPct || 0) * ing.gPerServing;

    return {
      name: ing.name,
      brand: ing.brand,
      itemCode: ing.itemCode,
      proteinPct: ing.proteinPct,
      gPerServing: ing.gPerServing,
      perBatchGrams,
      qtyInKg: perBatchGrams / 1000,
    };
  });

  const proteinPctInBatch = (totalProteinGrams / gmPerServing) * 100;

  return { recipeName: recipe.name, gmPerServing, batchSizeKg, servingsPerBatch, proteinPctInBatch, ingredients };
}

/**
 * Runs calculateBatchCosting() over every queued batch and aggregates their
 * ingredients into one RM procurement rollup (per-batch cards + the
 * "Consolidated Master Procurement" table), keyed the same way as
 * bom-engine.ts: name + brand.
 */
export function calculateMasterRMBOM(items: RmBatchLineInput[]): RmMasterResult {
  const batches: BatchCostingResult[] = [];
  const procurementMap = new Map<string, ProcurementLine>();

  for (const item of items) {
    const batchResult = calculateBatchCosting(item.recipe, item.batchSizeKg);
    batches.push(batchResult);

    for (const ing of batchResult.ingredients) {
      const key = `${ing.name}_|_${ing.brand}`;
      let entry = procurementMap.get(key);
      if (!entry) {
        entry = { name: ing.name, brand: ing.brand, itemCode: ing.itemCode, totalKg: 0, sources: {} };
        procurementMap.set(key, entry);
      }
      entry.totalKg += ing.qtyInKg;
      entry.sources[item.recipe.name] = (entry.sources[item.recipe.name] ?? 0) + ing.qtyInKg;
    }
  }

  const procurement = Array.from(procurementMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  return { batches, procurement };
}
