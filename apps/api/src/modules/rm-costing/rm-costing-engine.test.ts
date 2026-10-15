import { describe, expect, it } from "vitest";
import { calculateBatchCosting, calculateMasterRMBOM, type RecipeInput } from "./rm-costing-engine";

// Same fixture as the prototype's sample formulation template
// (`downloadSampleFormulationExcel()`), trimmed to a few ingredients.
const chocolateRecipe: RecipeInput = {
  name: "CHOCOLATE PLANT NUTRITION",
  totalServing: 42,
  ingredients: [
    { name: "PEA PROTEIN EXTRACT", brand: "YANTAI CO", gPerServing: 7.0, proteinPct: 0.8 },
    { name: "YEAST PROTEIN", brand: "ANGEL", gPerServing: 23.0, proteinPct: 0.8 },
    { name: "SUCRALOSE PURE POWDER", brand: "TECHNO", gPerServing: 0.12, proteinPct: 0 },
  ],
};

describe("calculateBatchCosting", () => {
  it("scales the recipe to the batch size", () => {
    const result = calculateBatchCosting(chocolateRecipe, 100);

    expect(result.servingsPerBatch).toBeCloseTo((100 * 1000) / 42, 6);

    const pea = result.ingredients.find((i) => i.name === "PEA PROTEIN EXTRACT")!;
    expect(pea.perBatchGrams).toBeCloseTo(7.0 * result.servingsPerBatch, 6);
    expect(pea.qtyInKg).toBeCloseTo(pea.perBatchGrams / 1000, 9);

    // Protein % in batch = total protein grams / gm-per-serving * 100.
    const totalProteinGrams = 7.0 * 0.8 + 23.0 * 0.8;
    expect(result.proteinPctInBatch).toBeCloseTo((totalProteinGrams / 42) * 100, 6);

    // No costing in the result: quantities only.
    expect(result).not.toHaveProperty("pricePerPouch");
    expect(pea).not.toHaveProperty("amount");
  });
});

describe("calculateMasterRMBOM", () => {
  it("returns one costed batch per queued item plus a merged procurement rollup", () => {
    const secondRecipe: RecipeInput = {
      name: "VANILLA PLANT NUTRITION",
      totalServing: 40,
      ingredients: [{ name: "PEA PROTEIN EXTRACT", brand: "YANTAI CO", gPerServing: 8.0, proteinPct: 0.8 }],
    };

    const result = calculateMasterRMBOM(
      [
        { recipe: chocolateRecipe, batchSizeKg: 100 },
        { recipe: secondRecipe, batchSizeKg: 50 },
      ],
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
    const result = calculateMasterRMBOM([]);
    expect(result).toEqual({ batches: [], procurement: [] });
  });
});
