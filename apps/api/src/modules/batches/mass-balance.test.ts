import { describe, expect, it } from "vitest";
import { checkMassBalance } from "./mass-balance";

describe("checkMassBalance - IPQC", () => {
  it("lets the batch send up to what it produced to packing", () => {
    expect(checkMassBalance({ stage: "IPQC", outputQty: 100, unit: "KG", values: { bulkTransferToPackingQty: 100 } }).ok).toBe(true);
  });
  it("refuses more than was produced", () => {
    const r = checkMassBalance({ stage: "IPQC", outputQty: 100, unit: "KG", values: { bulkTransferToPackingQty: 101 } });
    expect(r.ok).toBe(false);
  });
});

describe("checkMassBalance - manufacturing QA gate", () => {
  it("works the approved quantity out when it is left blank", () => {
    const r = checkMassBalance({ stage: "QA_GATE_MFG", outputQty: 100, unit: "KG", values: { mfgRejectedQty: 5, mfgWastageQty: 3 } });
    expect(r).toEqual({ ok: true, defaults: { mfgApprovedQty: 92 } });
  });
  it("accepts approved + rejected + wasted up to the output", () => {
    expect(checkMassBalance({ stage: "QA_GATE_MFG", outputQty: 100, unit: "KG", values: { mfgApprovedQty: 90, mfgRejectedQty: 5, mfgWastageQty: 5 } }).ok).toBe(true);
  });
  it("refuses to approve more than the batch made", () => {
    const r = checkMassBalance({ stage: "QA_GATE_MFG", outputQty: 100, unit: "KG", values: { mfgApprovedQty: 98, mfgRejectedQty: 5 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("more than the batch produced");
  });
  it("refuses rejected + wasted above the output when approved is blank", () => {
    expect(checkMassBalance({ stage: "QA_GATE_MFG", outputQty: 10, unit: "KG", values: { mfgRejectedQty: 8, mfgWastageQty: 5 } }).ok).toBe(false);
  });
  it("tolerates floating-point noise", () => {
    expect(checkMassBalance({ stage: "QA_GATE_MFG", outputQty: 0.3, unit: "KG", values: { mfgApprovedQty: 0.1 + 0.2 } }).ok).toBe(true);
  });
});

describe("checkMassBalance - packaging QA gate", () => {
  it("works the packed quantity out of the approved bulk for a Kg order", () => {
    const r = checkMassBalance({ stage: "QA_GATE_PACKAGING", outputQty: 100, unit: "kg", values: { mfgApprovedQty: 90, packWastageQty: 2 } });
    expect(r).toEqual({ ok: true, defaults: { packApprovedQty: 88 } });
  });
  it("refuses packed + rejected + wasted above the approved bulk", () => {
    expect(checkMassBalance({ stage: "QA_GATE_PACKAGING", outputQty: 100, unit: "KG", values: { mfgApprovedQty: 90, packApprovedQty: 89, packRejectedQty: 2 } }).ok).toBe(false);
  });
  it("makes the packed quantity mandatory when it cannot be worked out (an order in pouches)", () => {
    const r = checkMassBalance({ stage: "QA_GATE_PACKAGING", outputQty: 100, unit: "SKU", values: { mfgApprovedQty: 90 } });
    expect(r.ok).toBe(false);
  });
  it("does not compare pouches with Kg", () => {
    expect(checkMassBalance({ stage: "QA_GATE_PACKAGING", outputQty: 100, unit: "SKU", values: { mfgApprovedQty: 90, packApprovedQty: 5000 } }).ok).toBe(true);
  });
});
