import { describe, expect, it } from "vitest";
import { actorCanActOnStage, BATCH_STAGE_ORDER, BATCH_STAGE_ROLE, getForwardTarget, getRejectTarget } from "./batch-stage";

describe("batch stage order", () => {
  it("has 10 stages, PO Release through Dispatch Plan", () => {
    expect(BATCH_STAGE_ORDER).toHaveLength(10);
    expect(BATCH_STAGE_ORDER[0]).toBe("PO_RELEASE");
    expect(BATCH_STAGE_ORDER.at(-1)).toBe("DISPATCH_PLAN");
  });

  it("every stage has exactly one owning department", () => {
    for (const stage of BATCH_STAGE_ORDER) {
      expect(BATCH_STAGE_ROLE[stage]).toBeTruthy();
    }
  });
});

describe("getForwardTarget", () => {
  it("walks the main sequence one step at a time", () => {
    expect(getForwardTarget("PO_RELEASE")).toBe("MATERIAL_RECEIVED");
    expect(getForwardTarget("INDENT_ISSUE")).toBe("DISPENSING");
    expect(getForwardTarget("QA_GATE_MFG")).toBe("PACKAGING");
  });

  it("completes in place at Dispatch Plan — the last stage still needs its own fields recorded", () => {
    expect(getForwardTarget("DISPATCH_PLAN")).toBe("DISPATCH_PLAN");
  });
});

describe("getRejectTarget", () => {
  it("sends every stage back to whichever stage precedes it", () => {
    expect(getRejectTarget("DISPENSING")).toBe("INDENT_ISSUE");
    expect(getRejectTarget("QA_GATE_PACKAGING")).toBe("PACKAGING");
    expect(getRejectTarget("DISPATCH_PLAN")).toBe("BILLING_EWAY_BILL");
  });

  it("has nothing before the first stage", () => {
    expect(getRejectTarget("PO_RELEASE")).toBeNull();
  });
});

describe("actorCanActOnStage", () => {
  it("allows the department whose role owns the stage", () => {
    expect(actorCanActOnStage("PO_RELEASE", ["PURCHASE"])).toBe(true);
    expect(actorCanActOnStage("QA_GATE_MFG", ["QA_QC"])).toBe(true);
  });

  it("blocks every other department", () => {
    expect(actorCanActOnStage("PO_RELEASE", ["STORE"])).toBe(false);
    expect(actorCanActOnStage("DISPATCH_PLAN", [])).toBe(false);
  });

  it("lets ADMIN act on any stage", () => {
    expect(actorCanActOnStage("DISPATCH_PLAN", ["ADMIN"])).toBe(true);
  });
});
