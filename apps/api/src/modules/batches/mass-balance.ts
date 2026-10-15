import { canonicalUnit } from "../../common/lib/units";

/**
 * Quantities may not appear out of nowhere between the stages of a batch. What a batch produced (its output) is split at the
 * manufacturing QA gate into approved + rejected + wasted; what is packed and approved at the packaging gate comes out of the
 * approved bulk. Each number was a free box before, so a batch could "approve" more than it ever made and the surplus flowed on
 * into finished-goods stock and dispatch.
 *
 * Checked only when a gate actually clears (a gate that is on Hold may be saved half-filled). Where a quantity is left blank it is
 * worked out from the stage before, so the usual case is still one click.
 */
export type MassBalanceStage = "IPQC" | "QA_GATE_MFG" | "QA_GATE_PACKAGING";

export interface MassBalanceValues {
  bulkTransferToPackingQty?: number | null;
  mfgApprovedQty?: number | null;
  mfgRejectedQty?: number | null;
  mfgWastageQty?: number | null;
  packApprovedQty?: number | null;
  packRejectedQty?: number | null;
  packWastageQty?: number | null;
}

export type MassBalanceResult = { ok: true; defaults: Partial<Record<keyof MassBalanceValues, number>> } | { ok: false; error: string };

const EPS = 1e-6;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `values` = this stage's input over what the batch already holds. `unit` = the order's unit (packed counts are only comparable with bulk when it is Kg). */
export function checkMassBalance(input: { stage: MassBalanceStage; outputQty: number | null; unit: string; values: MassBalanceValues }): MassBalanceResult {
  const { stage, unit, values } = input;
  const output = num(input.outputQty);
  const kgLike = canonicalUnit(unit) === "kg";

  if (stage === "IPQC") {
    const toPacking = num(values.bulkTransferToPackingQty);
    if (toPacking !== null && output !== null && toPacking > output + EPS) {
      return { ok: false, error: `Bulk sent to packing (${r3(toPacking)}) can't be more than the batch produced (${r3(output)}).` };
    }
    return { ok: true, defaults: {} };
  }

  if (stage === "QA_GATE_MFG") {
    if (output === null) return { ok: true, defaults: {} };
    const rejected = num(values.mfgRejectedQty) ?? 0;
    const wasted = num(values.mfgWastageQty) ?? 0;
    const approved = num(values.mfgApprovedQty);
    if (approved === null) {
      const rest = output - rejected - wasted;
      if (rest < -EPS) return { ok: false, error: `Rejected (${r3(rejected)}) + wasted (${r3(wasted)}) is more than the batch produced (${r3(output)}).` };
      return { ok: true, defaults: { mfgApprovedQty: r3(Math.max(0, rest)) } };
    }
    const total = approved + rejected + wasted;
    if (total > output + EPS) return { ok: false, error: `Approved (${r3(approved)}) + rejected (${r3(rejected)}) + wasted (${r3(wasted)}) = ${r3(total)} is more than the batch produced (${r3(output)}).` };
    return { ok: true, defaults: {} };
  }

  // QA_GATE_PACKAGING
  const mfgApproved = num(values.mfgApprovedQty);
  const rejected = num(values.packRejectedQty) ?? 0;
  const wasted = num(values.packWastageQty) ?? 0;
  const approved = num(values.packApprovedQty);
  if (approved === null) {
    if (!kgLike || mfgApproved === null) return { ok: false, error: "Enter how many were packed and approved." };
    const rest = mfgApproved - rejected - wasted;
    if (rest < -EPS) return { ok: false, error: `Rejected (${r3(rejected)}) + wasted (${r3(wasted)}) is more than the approved bulk (${r3(mfgApproved)}).` };
    return { ok: true, defaults: { packApprovedQty: r3(Math.max(0, rest)) } };
  }
  // Packed counts (pouches, cartons) are not comparable with bulk Kg, so the check applies to Kg orders only.
  if (kgLike && mfgApproved !== null) {
    const total = approved + rejected + wasted;
    if (total > mfgApproved + EPS) return { ok: false, error: `Packed approved (${r3(approved)}) + rejected (${r3(rejected)}) + wasted (${r3(wasted)}) = ${r3(total)} is more than the approved bulk (${r3(mfgApproved)}).` };
  }
  return { ok: true, defaults: {} };
}
