import { describe, expect, it } from "vitest";
import { convertOrder, parsePackKg } from "./order-conversion";

describe("parsePackKg", () => {
  it("reads grams, kilograms and a gummy count", () => {
    expect(parsePackKg("120 g")).toBeCloseTo(0.12, 6);
    expect(parsePackKg("120g")).toBeCloseTo(0.12, 6);
    expect(parsePackKg("1kg")).toBe(1);
    expect(parsePackKg("0.5 Kg")).toBe(0.5);
    expect(parsePackKg("500 gms")).toBeCloseTo(0.5, 6);
    expect(parsePackKg("60 Gummies", 3491.714)).toBeCloseTo(0.2095, 4);
    expect(parsePackKg("60 Gummies")).toBeNull(); // no gummy weight known
    expect(parsePackKg("")).toBeNull();
    expect(parsePackKg("big jar")).toBeNull();
  });
});

describe("convertOrder", () => {
  it("SKU: packs are the quantity, Kg = packs x pack size", () => {
    const c = convertOrder({ quantity: 600, unit: "SKU", poPackSize: null, bomPackSize: "120 g" });
    expect(c).toMatchObject({ packs: 600, packSizeSource: "Packaging BOM", packsProblem: null, kgProblem: null });
    expect(c.kg).toBeCloseTo(72, 6);
    expect(c.note).toBe("600 SKU x 120 g = 72 Kg");
  });
  it("KG: Kg is the quantity, packs = Kg / pack size", () => {
    const c = convertOrder({ quantity: 100, unit: "KG", poPackSize: "120 g", bomPackSize: "1 kg" });
    expect(c).toMatchObject({ kg: 100, packs: 833, packSizeSource: "PO line" }); // the PO line wins over the BOM
    expect(c.note).toBe("100 Kg / 120 g = 833 packs");
  });
  it("says what is missing instead of guessing", () => {
    expect(convertOrder({ quantity: 100, unit: "KG", poPackSize: null, bomPackSize: null })).toMatchObject({ kg: 100, packs: null, kgProblem: null });
    expect(convertOrder({ quantity: 100, unit: "KG", poPackSize: null, bomPackSize: null }).packsProblem).toMatch(/Pack size is missing/);
    expect(convertOrder({ quantity: 100, unit: "SKU", poPackSize: null, bomPackSize: null })).toMatchObject({ packs: 100, kg: null });
    expect(convertOrder({ quantity: 50, unit: "Litres", poPackSize: "1kg", bomPackSize: null })).toMatchObject({ packs: null, kg: null });
  });
});
