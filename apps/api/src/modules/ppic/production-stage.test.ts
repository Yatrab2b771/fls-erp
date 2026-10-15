import { describe, expect, it } from "vitest";
import { productionStageOf } from "./production-stage";

const sent = new Date();
const batch = (currentStageId: string, over: Partial<{ handedOverToDispatchAt: Date | null; customerShippedQty: number }> = {}) => ({ currentStageId, handedOverToDispatchAt: null, customerShippedQty: 0, ...over });

describe("productionStageOf: the one rule for where a product sent to Production is", () => {
  it("is null until the plan is sent to Production", () => {
    expect(productionStageOf({ planSentToProductionAt: null, quantity: 100, batches: [] })).toBeNull();
  });

  it("is Pre-production until a batch exists", () => {
    expect(productionStageOf({ planSentToProductionAt: sent, quantity: 100, batches: [] })).toBe("PRE_PRODUCTION");
  });

  it("is In production through manufacturing, QC and packaging, up to QA's packaging gate", () => {
    for (const s of ["IPQC", "QA_GATE_MFG", "BULK_QC", "PACKAGING", "QA_GATE_PACKAGING"]) {
      expect(productionStageOf({ planSentToProductionAt: sent, quantity: 100, batches: [batch(s)] })).toBe("IN_PRODUCTION");
    }
  });

  it("is Finished goods once past the packaging gate, until the Day Store hands it to Dispatch", () => {
    for (const s of ["FG_STORE", "FG_QC_RELEASE", "FG_HANDOVER"]) {
      expect(productionStageOf({ planSentToProductionAt: sent, quantity: 100, batches: [batch(s)] })).toBe("FINISHED_GOODS");
    }
  });

  it("is With Dispatch once handed over (even part-shipped), and Completed only when the whole quantity has gone to the customer", () => {
    const handed = new Date();
    expect(productionStageOf({ planSentToProductionAt: sent, quantity: 100, batches: [batch("FG_HANDOVER", { handedOverToDispatchAt: handed })] })).toBe("DISPATCH");
    expect(productionStageOf({ planSentToProductionAt: sent, quantity: 100, batches: [batch("FG_HANDOVER", { handedOverToDispatchAt: handed, customerShippedQty: 60 })] })).toBe("DISPATCH");
    expect(productionStageOf({ planSentToProductionAt: sent, quantity: 100, batches: [batch("FG_HANDOVER", { handedOverToDispatchAt: handed, customerShippedQty: 100 })] })).toBe("COMPLETED");
  });

  it("with several batches, the product is as far as its most advanced batch (but never complete before everything shipped)", () => {
    const handed = new Date();
    expect(productionStageOf({ planSentToProductionAt: sent, quantity: 100, batches: [batch("IPQC"), batch("FG_STORE")] })).toBe("FINISHED_GOODS");
    expect(productionStageOf({ planSentToProductionAt: sent, quantity: 100, batches: [batch("IPQC"), batch("FG_HANDOVER", { handedOverToDispatchAt: handed, customerShippedQty: 50 })] })).toBe("DISPATCH");
  });
});
