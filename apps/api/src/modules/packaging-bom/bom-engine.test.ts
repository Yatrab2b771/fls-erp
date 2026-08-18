import { describe, expect, it } from "vitest";
import { calculateMasterBOM } from "./bom-engine";

describe("calculateMasterBOM", () => {
  it("aggregates a single SKU's primary/secondary/tertiary materials with the right wastage buffer", () => {
    const result = calculateMasterBOM([
      {
        brandName: "AlphaBrand",
        productName: "Whey Gold 1kg",
        targetYield: 1000,
        spec: {
          jar: "1kg HDPE Jar",
          wadMm: "83mm",
          scoopMl: "30ml",
          silicaGelGms: "2",
          silicaGelQtyNos: "1",
          authenticationSticker: "Yes",
          leaflet: "Yes",
          corrugatedBoxMm: "5-ply",
          packagingSizeNos: "12",
        },
      },
    ]);

    expect(result.totalYield).toBe(1000);
    expect(result.brands).toEqual(["AlphaBrand"]);

    const jar = result.lines.find((l) => l.component === "Jar/Container");
    expect(jar).toMatchObject({
      category: "1-Primary",
      spec: "1kg HDPE Jar",
      baseQty: 1000,
      wastageRate: 0.02,
      bufferQty: 20, // ceil(1000 * 0.02)
      totalQty: 1020,
      sources: { "AlphaBrand (Whey Gold 1kg)": 1000 },
    });

    // Silica gel scales by qty-per-unit, not a flat pass-through.
    const silica = result.lines.find((l) => l.component === "Silica Gel Desiccant");
    expect(silica?.baseQty).toBe(1000); // 1000 units * 1 sachet each

    // Tertiary carries zero wastage and is pack-size-driven, not yield-driven.
    const box = result.lines.find((l) => l.component === "Corrugated Master Box");
    expect(box).toMatchObject({
      category: "3-Tertiary",
      baseQty: Math.ceil(1000 / 12), // 84 boxes
      wastageRate: 0,
      bufferQty: 0,
      totalQty: Math.ceil(1000 / 12),
    });
  });

  it("aggregates the same material across multiple SKUs and tracks per-source allocation", () => {
    const spec = { jar: "500g Jar" };
    const result = calculateMasterBOM([
      { brandName: "Alpha", productName: "SKU A", targetYield: 300, spec },
      { brandName: "Beta", productName: "SKU B", targetYield: 200, spec },
    ]);

    const jar = result.lines.find((l) => l.component === "Jar/Container");
    expect(jar?.baseQty).toBe(500);
    expect(jar?.sources).toEqual({
      "Alpha (SKU A)": 300,
      "Beta (SKU B)": 200,
    });
    expect(result.brands.sort()).toEqual(["Alpha", "Beta"]);
  });

  it("treats 0, N/A, NaN and blank as 'not applicable' — matching the prototype's isValid()", () => {
    const result = calculateMasterBOM([
      {
        brandName: "Alpha",
        productName: "SKU A",
        targetYield: 100,
        spec: {
          jar: "0",
          wadMm: "N/A",
          scoopMl: "nan",
          leaflet: "",
        },
      },
    ]);

    expect(result.lines).toHaveLength(0);
  });

  it("only counts silica gel when both grams and quantity-per-unit are present and positive", () => {
    const withoutQty = calculateMasterBOM([
      { brandName: "A", productName: "P", targetYield: 100, spec: { silicaGelGms: "2" } },
    ]);
    expect(withoutQty.lines.find((l) => l.component === "Silica Gel Desiccant")).toBeUndefined();

    const zeroQty = calculateMasterBOM([
      { brandName: "A", productName: "P", targetYield: 100, spec: { silicaGelGms: "2", silicaGelQtyNos: "0" } },
    ]);
    expect(zeroQty.lines.find((l) => l.component === "Silica Gel Desiccant")).toBeUndefined();
  });

  it("skips the corrugated box line when pack size is missing or zero", () => {
    const result = calculateMasterBOM([
      { brandName: "A", productName: "P", targetYield: 100, spec: { corrugatedBoxMm: "5-ply", packagingSizeNos: "0" } },
    ]);
    expect(result.lines.find((l) => l.component === "Corrugated Master Box")).toBeUndefined();
  });

  it("sorts lines by category then component name", () => {
    const result = calculateMasterBOM([
      {
        brandName: "A",
        productName: "P",
        targetYield: 10,
        spec: {
          leaflet: "Yes", // 2-Secondary
          jar: "Jar", // 1-Primary
          corrugatedBoxMm: "box",
          packagingSizeNos: "5", // 3-Tertiary
        },
      },
    ]);
    expect(result.lines.map((l) => l.category)).toEqual(["1-Primary", "2-Secondary", "3-Tertiary"]);
  });

  it("returns an empty result for an empty plan", () => {
    const result = calculateMasterBOM([]);
    expect(result).toEqual({ totalYield: 0, brands: [], lines: [] });
  });
});
