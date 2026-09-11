import { describe, expect, it } from "vitest";
import { canViewPricing, stripPricing, stripPricingFromAll } from "./item-pricing";

const priced = { id: "1", name: "Whey Protein", costPrice: 300, mrp: 450, purchasePrice: 280, salesPrice: 400 };

describe("canViewPricing", () => {
  it("is true for PURCHASE, ACCOUNTS, ADMIN — false for everyone else", () => {
    expect(canViewPricing(["PURCHASE"])).toBe(true);
    expect(canViewPricing(["ACCOUNTS"])).toBe(true);
    expect(canViewPricing(["ADMIN"])).toBe(true);
    expect(canViewPricing(["STORE"])).toBe(false);
    expect(canViewPricing(["PPIC"])).toBe(false);
    expect(canViewPricing([])).toBe(false);
  });
});

describe("stripPricing", () => {
  it("leaves pricing fields untouched for a role allowed to see them", () => {
    expect(stripPricing(priced, ["ACCOUNTS"])).toEqual(priced);
  });

  it("removes pricing fields entirely (not nulled) for every other role", () => {
    const stripped = stripPricing(priced, ["STORE"]);
    expect(stripped).toEqual({ id: "1", name: "Whey Protein" });
    expect("costPrice" in stripped).toBe(false);
  });
});

describe("stripPricingFromAll", () => {
  it("applies the same rule across a whole list", () => {
    const list = [priced, { ...priced, id: "2" }];
    expect(stripPricingFromAll(list, ["ACCOUNTS"])).toEqual(list);
    const stripped = stripPricingFromAll(list, ["PRODUCTION"]);
    expect(stripped.every((i) => !("costPrice" in i))).toBe(true);
  });
});
