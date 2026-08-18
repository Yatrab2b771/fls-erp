/**
 * RM formulation & commercial costing engine — a direct, pure-function port
 * of `calculateMasterRMBOM()` (plus the recipe-scaling math reused by
 * `printIndividualBMR()`) from `2/workplace/index copy.php`.
 *
 * Deliberately kept dependency-free (no Prisma, no Express) so it can be
 * unit-tested against fixed inputs/outputs and reused unchanged by the
 * calculate endpoint and the Excel/PDF exporters, same rationale as
 * `packaging-bom/bom-engine.ts`.
 */

export interface RecipeIngredientInput {
  name: string;
  brand: string;
  costPerKg: number;
  gPerServing: number;
  proteinPct: number;
}

export interface RecipeInput {
  name: string;
  totalServing: number;
  ingredients: RecipeIngredientInput[];
}

/** The shared costing profile — same fields/defaults as the prototype's costing panel. */
export interface CostingParams {
  mfgLossPct: number;
  packSizeG: number;
  testCost: number;
  jarCost: number;
  scoopCost: number;
  labelCost: number;
  convCost: number;
  ccbCost: number;
  profitPct: number;
  gstPct: number;
}

export interface RmBatchLineInput {
  recipe: RecipeInput;
  batchSizeKg: number;
}

export interface BatchIngredientResult {
  name: string;
  brand: string;
  proteinPct: number;
  costPerKg: number;
  ratePerGm: number;
  gPerServing: number;
  perBatchGrams: number;
  qtyInKg: number;
  amount: number;
}

export interface BatchCostingResult {
  recipeName: string;
  gmPerServing: number;
  batchSizeKg: number;
  servingsPerBatch: number;
  proteinPctInBatch: number;
  costPerKgWithoutPkg: number;

  totalRmCost: number;
  testCost: number;
  powderCostPlusTesting: number;
  mfgLossPct: number;
  mfgLossAmount: number;
  powderCostAdjusted: number;
  packSizeG: number;
  costPerPouchPowder: number;
  jarCost: number;
  scoopCost: number;
  labelCost: number;
  convCost: number;
  ccbCost: number;
  packagingTotal: number;
  cogsPerPouch: number;
  profitPct: number;
  profitAmount: number;
  gstPct: number;
  gstAmount: number;
  pricePerPouch: number;

  ingredients: BatchIngredientResult[];
}

export interface ProcurementLine {
  name: string;
  brand: string;
  estCostPerKg: number;
  totalKg: number;
  /** Recipe name -> quantity contributed, e.g. "CHOCOLATE PLANT NUTRITION": 12.5 */
  sources: Record<string, number>;
}

export interface RmMasterResult {
  batches: BatchCostingResult[];
  procurement: ProcurementLine[];
}

/**
 * Scales one recipe to one batch size and runs the full RM -> testing ->
 * mfg-loss -> packaging -> COGS -> margin -> GST waterfall. Pure and
 * side-effect free, matching the per-batch half of calculateMasterRMBOM().
 */
export function calculateBatchCosting(recipe: RecipeInput, batchSizeKg: number, costing: CostingParams): BatchCostingResult {
  const gmPerServing = recipe.totalServing;
  const servingsPerBatch = (batchSizeKg * 1000) / gmPerServing;

  let totalRmCost = 0;
  let totalProteinGrams = 0;

  const ingredients: BatchIngredientResult[] = recipe.ingredients.map((ing) => {
    const ratePerGm = (ing.costPerKg || 0) / 1000;
    const perBatchGrams = ing.gPerServing * servingsPerBatch;
    const qtyInKg = perBatchGrams / 1000;
    const amount = qtyInKg * (ing.costPerKg || 0);

    totalRmCost += amount;
    totalProteinGrams += (ing.proteinPct || 0) * ing.gPerServing;

    return {
      name: ing.name,
      brand: ing.brand,
      proteinPct: ing.proteinPct,
      costPerKg: ing.costPerKg,
      ratePerGm,
      gPerServing: ing.gPerServing,
      perBatchGrams,
      qtyInKg,
      amount,
    };
  });

  const proteinPctInBatch = (totalProteinGrams / gmPerServing) * 100;
  const costPerKgWithoutPkg = totalRmCost / batchSizeKg;

  const powderCostPlusTesting = totalRmCost + costing.testCost;
  const mfgLossAmount = powderCostPlusTesting * (costing.mfgLossPct / 100);
  const powderCostAdjusted = powderCostPlusTesting + mfgLossAmount;
  const costPerPouchPowder = (powderCostAdjusted / batchSizeKg) * (costing.packSizeG / 1000);

  const packagingTotal = costing.jarCost + costing.scoopCost + costing.labelCost + costing.convCost + costing.ccbCost;
  const cogsPerPouch = costPerPouchPowder + packagingTotal;

  const profitAmount = cogsPerPouch * (costing.profitPct / 100);
  const preGstPrice = cogsPerPouch + profitAmount;
  const gstAmount = preGstPrice * (costing.gstPct / 100);
  const pricePerPouch = preGstPrice + gstAmount;

  return {
    recipeName: recipe.name,
    gmPerServing,
    batchSizeKg,
    servingsPerBatch,
    proteinPctInBatch,
    costPerKgWithoutPkg,
    totalRmCost,
    testCost: costing.testCost,
    powderCostPlusTesting,
    mfgLossPct: costing.mfgLossPct,
    mfgLossAmount,
    powderCostAdjusted,
    packSizeG: costing.packSizeG,
    costPerPouchPowder,
    jarCost: costing.jarCost,
    scoopCost: costing.scoopCost,
    labelCost: costing.labelCost,
    convCost: costing.convCost,
    ccbCost: costing.ccbCost,
    packagingTotal,
    cogsPerPouch,
    profitPct: costing.profitPct,
    profitAmount,
    gstPct: costing.gstPct,
    gstAmount,
    pricePerPouch,
    ingredients,
  };
}

/**
 * Runs calculateBatchCosting() over every queued batch and aggregates their
 * ingredients into one RM procurement rollup, matching calculateMasterRMBOM()
 * in the prototype (per-batch cards + the "Consolidated Master Procurement"
 * table), keyed the same way as bom-engine.ts: name + brand.
 */
export function calculateMasterRMBOM(items: RmBatchLineInput[], costing: CostingParams): RmMasterResult {
  const batches: BatchCostingResult[] = [];
  const procurementMap = new Map<string, ProcurementLine>();

  for (const item of items) {
    const batchResult = calculateBatchCosting(item.recipe, item.batchSizeKg, costing);
    batches.push(batchResult);

    for (const ing of batchResult.ingredients) {
      const key = `${ing.name}_|_${ing.brand}`;
      let entry = procurementMap.get(key);
      if (!entry) {
        entry = { name: ing.name, brand: ing.brand, estCostPerKg: ing.costPerKg, totalKg: 0, sources: {} };
        procurementMap.set(key, entry);
      }
      entry.totalKg += ing.qtyInKg;
      entry.sources[item.recipe.name] = (entry.sources[item.recipe.name] ?? 0) + ing.qtyInKg;
    }
  }

  const procurement = Array.from(procurementMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  return { batches, procurement };
}
