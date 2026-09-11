import { describe, expect, it } from "vitest";
import { actorCanActOnStage, COMBINED_LOT_STAGE_ORDER, COMBINED_LOT_STAGE_ROLE, getForwardTarget, getRejectTarget } from "./combined-lot-stage";

describe("combined lot stage order", () => {
  it("has 7 stages, IPQC through Dispatch Plan", () => {
    expect(COMBINED_LOT_STAGE_ORDER).toHaveLength(7);
    expect(COMBINED_LOT_STAGE_ORDER[0]).toBe("IPQC");
    expect(COMBINED_LOT_STAGE_ORDER.at(-1)).toBe("DISPATCH_PLAN");
  });

  it("every stage has at least one owning department", () => {
    for (const stage of COMBINED_LOT_STAGE_ORDER) {
      expect(COMBINED_LOT_STAGE_ROLE[stage].length).toBeGreaterThan(0);
    }
  });

  // Production Process Flow.docx tags Bulk QC Sampling & Testing as R&D's
  // own work, not generic QA — R&D gets access alongside QA_QC (not
  // replacing it) here, the one stage with more than one owning role.
  it("BULK_QC is owned by both QA_QC and RND; every other stage still has exactly one owner", () => {
    expect(COMBINED_LOT_STAGE_ROLE.BULK_QC).toEqual(["QA_QC", "RND"]);
    for (const stage of COMBINED_LOT_STAGE_ORDER) {
      if (stage === "BULK_QC") continue;
      expect(COMBINED_LOT_STAGE_ROLE[stage]).toHaveLength(1);
    }
  });
});

describe("getForwardTarget", () => {
  it("walks the sequence one step at a time", () => {
    expect(getForwardTarget("IPQC")).toBe("QA_GATE_MFG");
    expect(getForwardTarget("QA_GATE_MFG")).toBe("BULK_QC");
    expect(getForwardTarget("BULK_QC")).toBe("PACKAGING");
    expect(getForwardTarget("PACKAGING")).toBe("QA_GATE_PACKAGING");
    expect(getForwardTarget("QA_GATE_PACKAGING")).toBe("BILLING_EWAY_BILL");
    expect(getForwardTarget("BILLING_EWAY_BILL")).toBe("DISPATCH_PLAN");
  });

  it("completes in place at Dispatch Plan — the last stage still needs its own fields recorded", () => {
    expect(getForwardTarget("DISPATCH_PLAN")).toBe("DISPATCH_PLAN");
  });
});

describe("getRejectTarget", () => {
  it("sends every stage back to whichever stage precedes it", () => {
    expect(getRejectTarget("QA_GATE_PACKAGING")).toBe("PACKAGING");
    expect(getRejectTarget("PACKAGING")).toBe("BULK_QC");
    expect(getRejectTarget("DISPATCH_PLAN")).toBe("BILLING_EWAY_BILL");
  });

  it("has nothing before the first stage", () => {
    expect(getRejectTarget("IPQC")).toBeNull();
  });
});

describe("actorCanActOnStage", () => {
  it("allows the department whose role owns the stage", () => {
    expect(actorCanActOnStage("IPQC", ["QA_QC"])).toBe(true);
    expect(actorCanActOnStage("QA_GATE_MFG", ["QA_QC"])).toBe(true);
  });

  it("blocks every other department", () => {
    expect(actorCanActOnStage("IPQC", ["STORE"])).toBe(false);
    expect(actorCanActOnStage("DISPATCH_PLAN", [])).toBe(false);
  });

  it("lets ADMIN act on any stage", () => {
    expect(actorCanActOnStage("DISPATCH_PLAN", ["ADMIN"])).toBe(true);
  });
});
