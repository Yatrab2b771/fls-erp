import type { FieldDef } from "../components/FieldGrid";
import type { CombinedLotStageId, RoleName } from "./types";

// Mirrors apps/api/src/modules/batches/combined-lot-stage.ts — Tier 3 of
// the three-tier pipeline: IPQC through Dispatch Plan, walked exactly
// once per pooled lot (created automatically once every planned
// ProductionBatch has completed and combined — see
// production-batches.routes.ts on the API side).

export const COMBINED_LOT_STAGE_ORDER: CombinedLotStageId[] = ["IPQC", "QA_GATE_MFG", "BULK_QC", "PACKAGING", "QA_GATE_PACKAGING", "BILLING_EWAY_BILL", "DISPATCH_PLAN"];

// One or more roles per stage — BULK_QC is the one stage with two:
// Production Process Flow.docx tags "Bulk QC Sampling & Testing" as
// R&D's own work, not generic QA — R&D gets access alongside QA_QC here,
// not replacing it.
export const COMBINED_LOT_STAGE_ROLE: Record<CombinedLotStageId, RoleName[]> = {
  IPQC: ["QA_QC"],
  QA_GATE_MFG: ["QA_QC"],
  BULK_QC: ["QA_QC", "RND"],
  PACKAGING: ["PRODUCTION"],
  QA_GATE_PACKAGING: ["QA_QC"],
  BILLING_EWAY_BILL: ["ACCOUNTS"],
  DISPATCH_PLAN: ["DISPATCH"],
};

export const COMBINED_LOT_STAGE_LABEL: Record<CombinedLotStageId, string> = {
  IPQC: "In-Process QA (IPQC)",
  QA_GATE_MFG: "QA Gate — Manufacturing",
  BULK_QC: "Bulk QC",
  PACKAGING: "Packaging",
  QA_GATE_PACKAGING: "QA Gate — Packaging",
  BILLING_EWAY_BILL: "Billing & E-Way Bill",
  DISPATCH_PLAN: "Dispatch Plan",
};

const MFG_APPROVAL_STATUSES = ["Approved", "Not Approved", "Hold"] as const;
const PACK_APPROVAL_STATUSES = ["Approved", "Not approved", "Hold"] as const;
const IPQC_STATUSES = ["Approved", "Not Approved", "Hold"] as const;
const BULK_QC_STATUSES = ["Approved", "Not Approved", "Hold"] as const;
const COA_RESULTS = ["Complies", "Does Not Comply"] as const;
const TRANSPORT_TYPES = ["By Land", "By Courier", "By Air"] as const;
// Process-phase names for Packaging's free-text status field — a
// combobox, not a strict enum, since the actual phase still varies by
// product and this list still can't be fully exhaustive. Verbatim from
// Date.docx's dropdown spec. "Completed" has to stay — it's the literal
// value combined-lot-transition.ts's FORWARD gate checks for
// (case-insensitive), not just a suggestion.
const PACKAGING_STATUSES = [
  "Not Started",
  "Filling",
  "Labelling",
  "Wad Sealing",
  "Shrinking",
  "Corrugated Packing",
  "Sorting",
  "Bottling",
  "Scooping",
  "Silica",
  "Counting",
  "Pouch Filling",
  "Canister Packing",
  "Pouch Packing",
  "Sachet Filling",
  "Monocartoning",
  "In Progress",
  "Completed",
  "On Hold",
] as const;

export const COMBINED_LOT_STAGE_FIELDS: Partial<Record<CombinedLotStageId, FieldDef[]>> = {
  // In-Process QA, plus Bulk Reconciliation (BMR-1.docx 8.0) — captured
  // here since IPQC is the first stage to weigh the pooled bulk.
  // yieldPct/processLoss derived server-side — see
  // computeBulkReconciliation in batch.engine.ts.
  IPQC: [
    { name: "ipqcStatus", label: "IPQC Status", type: "select", options: IPQC_STATUSES },
    { name: "ipqcRemarks", label: "Remarks", type: "text" },
    { name: "bulkTheoreticalWeight", label: "Theoretical Weight of Bulk (a)", type: "number" },
    { name: "bulkActualWeight", label: "Actual Weight of Bulk (b)", type: "number" },
    { name: "bulkQcSampleWeight", label: "QC Sample (c)", type: "number" },
    { name: "bulkTransferToPackingQty", label: "Total Bulk Transfer to Packing", type: "number" },
  ],
  // Phase F — the Approved/Rejected/Wastage split. The status fields
  // still gate FORWARD (Hold parks the lot here, unchanged); these three
  // are the real partial breakdown of what QC found. Wastage is the one
  // bucket that's a permanent loss — a positive number here, on the save
  // that actually clears this gate, logs to the Recycle Store's own
  // ledger (see BatchRecycleLogPanel and combined-lot-transition.ts).
  QA_GATE_MFG: [
    { name: "mfgQaStatus", label: "QA Status", type: "select", options: MFG_APPROVAL_STATUSES },
    { name: "mfgQcStatus", label: "QC Status", type: "select", options: MFG_APPROVAL_STATUSES },
    { name: "mfgRemarks", label: "Remarks", type: "text" },
    { name: "mfgApprovedQty", label: "Approved Qty", type: "number" },
    { name: "mfgRejectedQty", label: "Rejected Qty (quality)", type: "number" },
    { name: "mfgWastageQty", label: "Wastage Qty (to Recycle Store)", type: "number" },
  ],
  // Bulk QC Sampling & Testing — plus the COA's own final verdict (COA
  // format.docx's "Result: ... does not comply/complies"). The
  // per-test-parameter list and the three sign-offs live on their own
  // panel — see CoaPanel.
  BULK_QC: [
    { name: "bulkQcStatus", label: "Bulk QC Status", type: "select", options: BULK_QC_STATUSES },
    { name: "bulkQcRemarks", label: "Remarks", type: "text" },
    { name: "coaResult", label: "COA Result", type: "select", options: COA_RESULTS },
    { name: "coaRemark", label: "COA Remark", type: "text" },
  ],
  PACKAGING: [
    { name: "packagingStartDate", label: "Start Date", type: "date" },
    { name: "packagingStatus", label: "Packaging Status", type: "combo", options: PACKAGING_STATUSES },
    { name: "packagingEndDate", label: "End Date", type: "date" },
    { name: "packagingRemarks", label: "Remarks", type: "text" },
  ],
  QA_GATE_PACKAGING: [
    { name: "packQaStatus", label: "QA Status", type: "select", options: PACK_APPROVAL_STATUSES },
    { name: "packQcStatus", label: "QC Status", type: "select", options: PACK_APPROVAL_STATUSES },
    { name: "packRemarks", label: "Remarks", type: "text" },
    { name: "packApprovedQty", label: "Approved Qty", type: "number" },
    { name: "packRejectedQty", label: "Rejected Qty (quality)", type: "number" },
    { name: "packWastageQty", label: "Wastage Qty (to Recycle Store)", type: "number" },
  ],
  BILLING_EWAY_BILL: [
    { name: "invoiceNo", label: "Invoice No.", type: "text" },
    { name: "invoiceDate", label: "Invoice Date", type: "date" },
    { name: "ewayBillNo", label: "E-Way Bill No.", type: "text" },
    { name: "ewayBillDate", label: "E-Way Bill Date", type: "date" },
    { name: "billingRemarks", label: "Remarks", type: "text" },
  ],
  DISPATCH_PLAN: [
    { name: "dispatchDate", label: "Dispatch Date", type: "date" },
    { name: "dispatchedQty", label: "Dispatched Qty", type: "number" },
    { name: "shipperQty", label: "Shipper Qty", type: "number" },
    { name: "totalShipperWeight", label: "Total Shipper Weight", type: "number" },
    { name: "transportType", label: "Type of Transport", type: "select", options: TRANSPORT_TYPES },
    { name: "remainingQty", label: "Remaining Qty", type: "number" },
    { name: "anyRemarks", label: "Any Remarks", type: "text" },
  ],
};

export function getForwardTarget(stage: CombinedLotStageId): CombinedLotStageId {
  if (stage === "DISPATCH_PLAN") return "DISPATCH_PLAN"; // terminal — completes in place
  const idx = COMBINED_LOT_STAGE_ORDER.indexOf(stage);
  return COMBINED_LOT_STAGE_ORDER[idx + 1] ?? stage;
}

export function getRejectTarget(stage: CombinedLotStageId): CombinedLotStageId | null {
  const idx = COMBINED_LOT_STAGE_ORDER.indexOf(stage);
  return idx > 0 ? COMBINED_LOT_STAGE_ORDER[idx - 1]! : null;
}
