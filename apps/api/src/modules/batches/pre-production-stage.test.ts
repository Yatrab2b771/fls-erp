import { describe, expect, it } from "vitest";
import { actorCanActOnStage, PRE_PRODUCTION_STAGE_ORDER, PRE_PRODUCTION_STAGE_ROLE, getForwardTarget, getRejectTarget } from "./pre-production-stage";

describe("pre-production stage order", () => {
  it("has 5 stages, Material Received through Sample QC Approval", () => {
    expect(PRE_PRODUCTION_STAGE_ORDER).toHaveLength(5);
    expect(PRE_PRODUCTION_STAGE_ORDER[0]).toBe("MATERIAL_RECEIVED");
    expect(PRE_PRODUCTION_STAGE_ORDER.at(-1)).toBe("SAMPLE_QC_APPROVAL");
  });

  it("inserts Line Clearance between Indent Issue and Dispensing, per the client's Production Process Flow doc", () => {
    expect(PRE_PRODUCTION_STAGE_ORDER.indexOf("LINE_CLEARANCE")).toBe(PRE_PRODUCTION_STAGE_ORDER.indexOf("INDENT_ISSUE") + 1);
    expect(PRE_PRODUCTION_STAGE_ORDER.indexOf("LINE_CLEARANCE") + 1).toBe(PRE_PRODUCTION_STAGE_ORDER.indexOf("DISPENSING"));
  });

  it("every stage has exactly one owning department", () => {
    for (const stage of PRE_PRODUCTION_STAGE_ORDER) {
      expect(PRE_PRODUCTION_STAGE_ROLE[stage]).toHaveLength(1);
    }
  });
});

describe("getForwardTarget", () => {
  it("walks the sequence one step at a time", () => {
    expect(getForwardTarget("MATERIAL_RECEIVED")).toBe("INDENT_ISSUE");
    expect(getForwardTarget("INDENT_ISSUE")).toBe("LINE_CLEARANCE");
    expect(getForwardTarget("LINE_CLEARANCE")).toBe("DISPENSING");
    expect(getForwardTarget("DISPENSING")).toBe("SAMPLE_QC_APPROVAL");
  });

  it("completes in place at Sample QC Approval — this pipeline's own terminal stage", () => {
    expect(getForwardTarget("SAMPLE_QC_APPROVAL")).toBe("SAMPLE_QC_APPROVAL");
  });
});

describe("getRejectTarget", () => {
  it("sends every stage back to whichever stage precedes it", () => {
    expect(getRejectTarget("DISPENSING")).toBe("LINE_CLEARANCE");
    expect(getRejectTarget("LINE_CLEARANCE")).toBe("INDENT_ISSUE");
    expect(getRejectTarget("SAMPLE_QC_APPROVAL")).toBe("DISPENSING");
  });

  it("has nothing before the first stage", () => {
    expect(getRejectTarget("MATERIAL_RECEIVED")).toBeNull();
  });
});

describe("actorCanActOnStage", () => {
  it("allows the department whose role owns the stage", () => {
    expect(actorCanActOnStage("MATERIAL_RECEIVED", ["STORE"])).toBe(true);
    expect(actorCanActOnStage("LINE_CLEARANCE", ["QA_QC"])).toBe(true);
  });

  it("blocks every other department", () => {
    expect(actorCanActOnStage("MATERIAL_RECEIVED", ["PRODUCTION"])).toBe(false);
    expect(actorCanActOnStage("SAMPLE_QC_APPROVAL", [])).toBe(false);
  });

  it("lets ADMIN act on any stage", () => {
    expect(actorCanActOnStage("SAMPLE_QC_APPROVAL", ["ADMIN"])).toBe(true);
  });
});
