import { describe, expect, it } from "vitest";
import { computeDelay, computeWastage, type DelayFields } from "./batch.engine";

describe("computeDelay", () => {
  const blankDelay: DelayFields = { dispatchDate: null, dispatchPlanDate: null, manufacturingStartDate: null, productionPlanDate: null };
  const now = new Date("2026-08-16T00:00:00.000Z");

  it("is never delayed once dispatched", () => {
    expect(computeDelay({ ...blankDelay, dispatchDate: new Date(), dispatchPlanDate: new Date("2026-01-01") }, now).isDelayed).toBe(false);
  });

  it("is not delayed with no plan dates set yet", () => {
    expect(computeDelay(blankDelay, now).isDelayed).toBe(false);
  });

  it("flags a missed dispatch plan date once passed and not yet dispatched", () => {
    const result = computeDelay({ ...blankDelay, dispatchPlanDate: new Date("2026-08-10T00:00:00.000Z") }, now);
    expect(result).toEqual({ isDelayed: true, against: "dispatchPlanDate", daysLate: 6 });
  });

  it("falls back to the production plan date only if manufacturing hasn't started", () => {
    const missed = computeDelay({ ...blankDelay, productionPlanDate: new Date("2026-08-05T00:00:00.000Z") }, now);
    expect(missed).toEqual({ isDelayed: true, against: "productionPlanDate", daysLate: 11 });

    const started = computeDelay(
      { ...blankDelay, productionPlanDate: new Date("2026-08-05T00:00:00.000Z"), manufacturingStartDate: new Date("2026-08-06T00:00:00.000Z") },
      now,
    );
    expect(started.isDelayed).toBe(false);
  });

  it("prefers the dispatch plan date over the production plan date when both are missed", () => {
    const result = computeDelay(
      { ...blankDelay, productionPlanDate: new Date("2026-08-01T00:00:00.000Z"), dispatchPlanDate: new Date("2026-08-10T00:00:00.000Z") },
      now,
    );
    expect(result.against).toBe("dispatchPlanDate");
  });
});

describe("computeWastage", () => {
  it("is null until both input and output are recorded", () => {
    expect(computeWastage({ inputQty: null, outputQty: null })).toEqual({ wastageQty: null, wastagePct: null });
    expect(computeWastage({ inputQty: 100, outputQty: null })).toEqual({ wastageQty: null, wastagePct: null });
    expect(computeWastage({ inputQty: null, outputQty: 99 })).toEqual({ wastageQty: null, wastagePct: null });
  });

  it("computes the loss and its percentage of input, e.g. sieving loss", () => {
    // 100 kg in, 99.9 kg out — 0.1 kg (0.1%) lost, matching the sieving example.
    expect(computeWastage({ inputQty: 100, outputQty: 99.9 })).toEqual({ wastageQty: 0.1, wastagePct: 0.1 });
  });

  it("never goes negative — output can't exceed input in a wastage sense, so it floors at 0", () => {
    expect(computeWastage({ inputQty: 100, outputQty: 105 })).toEqual({ wastageQty: 0, wastagePct: 0 });
  });

  it("no output at all means total wastage", () => {
    expect(computeWastage({ inputQty: 100, outputQty: 0 })).toEqual({ wastageQty: 100, wastagePct: 100 });
  });
});
