import { describe, expect, it } from "vitest";
import { calculateBatchCosting, calculateMasterRMBOM, type CostingParams, type RecipeInput } from "./rm-costing-engine";

// Same fixture as the prototype's sample formulation template
// (`downloadSampleFormulationExcel()`), trimmed to a few ingredients.
const chocolateRecipe: RecipeInput = {
  name: "CHOCOLATE PLANT NUTRITION",
  totalServing: 42,
  ingredients: [
    { name: "PEA PROTEIN EXTRACT", brand: "YANTAI CO", costPerKg: 360, gPerServing: 7.0, proteinPct: 0.8 },
    { name: "YEAST PROTEIN", brand: "ANGEL", costPerKg: 680, gPerServing: 23.0, proteinPct: 0.8 },
    { name: "SUCRALOSE PURE POWDER", brand: "TECHNO", costPerKg: 1400, gPerServing: 0.12, proteinPct: 0 },
  ],
};

const defaultCosting: CostingParams = {
  mfgLossPct: 3,
  packSizeG: 400,
  testCost: 2000,
  jarCost: 25,
  scoopCost: 8,
  labelCost: 23,
  convCost: 25,
  ccbCost: 8,
  profitPct: 10,
  gstPct: 0,
};

describe("calculateBatchCosting", () => {
  it("scales the recipe to the batch size and runs the RM->COGS->price waterfall", () => {
    const result = calculateBatchCosting(chocolateRecipe, 100, defaultCosting);

    expect(result.servingsPerBatch).toBeCloseTo((100 * 1000) / 42, 6);

    const pea = result.ingredients.find((i) => i.name === "PEA PROTEIN EXTRACT")!;
    expect(pea.perBatchGrams).toBeCloseTo(7.0 * result.servingsPerBatch, 6);
    expect(pea.qtyInKg).toBeCloseTo(pea.perBatchGrams / 1000, 9);
    expect(pea.amount).toBeCloseTo(pea.qtyInKg * 360, 6);

    // Protein % in batch = total protein grams / gm-per-serving * 100.
    const totalProteinGrams = 7.0 * 0.8 + 23.0 * 0.8;
    expect(result.proteinPctInBatch).toBeCloseTo((totalProteinGrams / 42) * 100, 6);

    // Waterfall: RM -> +testing -> +mfg loss -> per-pouch powder -> +packaging -> +profit -> +GST.
    expect(result.powderCostPlusTesting).toBeCloseTo(result.totalRmCost + 2000, 6);
    expect(result.mfgLossAmount).toBeCloseTo(result.powderCostPlusTesting * 0.03, 6);
    expect(result.powderCostAdjusted).toBeCloseTo(result.powderCostPlusTesting + result.mfgLossAmount, 6);
    expect(result.costPerPouchPowder).toBeCloseTo((result.powderCostAdjusted / 100) * (400 / 1000), 6);
    expect(result.packagingTotal).toBe(25 + 8 + 23 + 25 + 8);
    expect(result.cogsPerPouch).toBeCloseTo(result.costPerPouchPowder + result.packagingTotal, 6);
    expect(result.profitAmount).toBeCloseTo(result.cogsPerPouch * 0.1, 6);
    expect(result.gstAmount).toBe(0); // gstPct is 0 in defaultCosting
    expect(result.pricePerPouch).toBeCloseTo(result.cogsPerPouch + result.profitAmount, 6);
  });

  it("applies GST on top of the post-profit price when gstPct is non-zero", () => {
    const result = calculateBatchCosting(chocolateRecipe, 100, { ...defaultCosting, gstPct: 18 });
    const preGst = result.cogsPerPouch + result.profitAmount;
    expect(result.gstAmount).toBeCloseTo(preGst * 0.18, 6);
    expect(result.pricePerPouch).toBeCloseTo(preGst + result.gstAmount, 6);
  });
});

describe("calculateMasterRMBOM", () => {
  it("returns one costed batch per queued item plus a merged procurement rollup", () => {
    const secondRecipe: RecipeInput = {
      name: "VANILLA PLANT NUTRITION",
      totalServing: 40,
      ingredients: [{ name: "PEA PROTEIN EXTRACT", brand: "YANTAI CO", costPerKg: 360, gPerServing: 8.0, proteinPct: 0.8 }],
    };

    const result = calculateMasterRMBOM(
      [
        { recipe: chocolateRecipe, batchSizeKg: 100 },
        { recipe: secondRecipe, batchSizeKg: 50 },
      ],
      defaultCosting,
    );

    expect(result.batches).toHaveLength(2);
    expect(result.batches.map((b) => b.recipeName)).toEqual(["CHOCOLATE PLANT NUTRITION", "VANILLA PLANT NUTRITION"]);

    // Same ingredient/brand pair used by both recipes aggregates into one line.
    const pea = result.procurement.find((p) => p.name === "PEA PROTEIN EXTRACT" && p.brand === "YANTAI CO")!;
    expect(pea).toBeDefined();
    expect(Object.keys(pea.sources).sort()).toEqual(["CHOCOLATE PLANT NUTRITION", "VANILLA PLANT NUTRITION"]);

    const chocPea = result.batches[0]!.ingredients.find((i) => i.name === "PEA PROTEIN EXTRACT")!;
    const vanillaPea = result.batches[1]!.ingredients.find((i) => i.name === "PEA PROTEIN EXTRACT")!;
    expect(pea.totalKg).toBeCloseTo(chocPea.qtyInKg + vanillaPea.qtyInKg, 9);
    expect(pea.sources["CHOCOLATE PLANT NUTRITION"]).toBeCloseTo(chocPea.qtyInKg, 9);
    expect(pea.sources["VANILLA PLANT NUTRITION"]).toBeCloseTo(vanillaPea.qtyInKg, 9);

    // Sucralose only appears in the chocolate recipe.
    const sucralose = result.procurement.find((p) => p.name === "SUCRALOSE PURE POWDER")!;
    expect(Object.keys(sucralose.sources)).toEqual(["CHOCOLATE PLANT NUTRITION"]);

    // Procurement lines are sorted by ingredient name.
    expect(result.procurement.map((p) => p.name)).toEqual([...result.procurement.map((p) => p.name)].sort());
  });

  it("returns empty batches/procurement for an empty plan", () => {
    const result = calculateMasterRMBOM([], defaultCosting);
    expect(result).toEqual({ batches: [], procurement: [] });
  });
});
