import type { FieldDef } from "../components/FieldGrid";
import type { CombinedLotStageId } from "./types";

// Field definitions for a ProductionBatch's OWN Tier-3 pipeline — reuses
// CombinedLotStageId/COMBINED_LOT_STAGE_LABEL/COMBINED_LOT_STAGE_ROLE/
// COMBINED_LOT_STAGE_ORDER from combinedLotStage.ts as-is (same 7 stages,
// same role map), but trims the field list to match
// PRODUCTION_BATCH_STAGE_FIELD_SCHEMA on the API side: no Bulk
// Reconciliation (IPQC) and no COA fields (BULK_QC) — both stay
// pooled-CombinedLot-only concepts, not meaningful against one small
// run. See schema.prisma's comment on ProductionBatch for the full
// reasoning.

const IPQC_STATUSES = ["Approved", "Not Approved", "Hold"] as const;
const MFG_APPROVAL_STATUSES = ["Approved", "Not Approved", "Hold"] as const;
const BULK_QC_STATUSES = ["Approved", "Not Approved", "Hold"] as const;
const PACK_APPROVAL_STATUSES = ["Approved", "Not approved", "Hold"] as const;
const TRANSPORT_TYPES = ["By Land", "By Courier", "By Air"] as const;
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

export const PRODUCTION_BATCH_STAGE_FIELDS: Partial<Record<CombinedLotStageId, FieldDef[]>> = {
  IPQC: [
    { name: "ipqcStatus", label: "IPQC Status", type: "select", options: IPQC_STATUSES },
    { name: "ipqcRemarks", label: "Remarks", type: "text" },
  ],
  QA_GATE_MFG: [
    { name: "mfgQaStatus", label: "QA Status", type: "select", options: MFG_APPROVAL_STATUSES },
    { name: "mfgQcStatus", label: "QC Status", type: "select", options: MFG_APPROVAL_STATUSES },
    { name: "mfgRemarks", label: "Remarks", type: "text" },
    { name: "mfgApprovedQty", label: "Approved Qty", type: "number" },
    { name: "mfgRejectedQty", label: "Rejected Qty (quality)", type: "number" },
    { name: "mfgWastageQty", label: "Wastage Qty", type: "number" },
  ],
  BULK_QC: [
    { name: "bulkQcStatus", label: "Bulk QC Status", type: "select", options: BULK_QC_STATUSES },
    { name: "bulkQcRemarks", label: "Remarks", type: "text" },
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
    { name: "packWastageQty", label: "Wastage Qty", type: "number" },
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
