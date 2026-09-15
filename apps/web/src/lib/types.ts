export type RoleName = "ADMIN" | "BD" | "PPIC" | "STORE" | "PURCHASE" | "ACCOUNTS" | "PRODUCTION" | "QA_QC" | "DISPATCH" | "RND";

export interface CurrentUser {
  id: string;
  employeeId: number;
  email: string;
  fullName: string;
  roles: RoleName[];
}

export interface Customer {
  id: string;
  companyName: string;
  contactPerson: string | null;
  contactNo: string | null;
  gstNo: string | null;
  email: string | null;
  deliveryAddress: string | null;
}

export interface PlanSummary {
  id: string;
  name: string;
  status: "DRAFT" | "CALCULATED";
}

export type ProductType = "EXISTING" | "NEW";

export interface PurchaseOrderItem {
  id: string;
  purchaseOrderId: string;
  productName: string;
  dosageForm: string | null;
  quantity: number;
  unit: string;
  volume: number | null;
  packSize: string | null;
  packType: string | null;
  bomRef: string | null;
  // EXISTING (default) has a catalog match expected; NEW skips straight
  // to raising a RecipeRequest at Generate time instead of attempting a
  // match that's known not to exist yet. See PurchaseOrderItem.productType
  // in schema.prisma.
  productType: ProductType;
  // The Production Pipeline links — which planning-module records exist
  // for this specific product, if any.
  bomPlans?: PlanSummary[];
  rmPlans?: PlanSummary[];
}

export interface PurchaseOrderDocument {
  id: string;
  filename: string;
  mimeType: string;
  uploadedAt: string;
  uploadedById: string;
}

// Draft → BD Approve/Reject → (approved) forwarded to PPIC/RM. A Batch
// can't be created off any line item until the PO is APPROVED.
export type PurchaseOrderStatus = "DRAFT" | "APPROVED" | "REJECTED";

export interface PurchaseOrder {
  id: string;
  customerId: string;
  poNumber: string | null;
  orderDate: string | null;
  expectedDeliveryDate: string | null;
  regulatoryBody: string | null;
  regulatoryStatus: string | null;
  status: PurchaseOrderStatus;
  reviewedBy: { id: string; fullName: string } | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  customer: { id: string; companyName: string };
  items: PurchaseOrderItem[];
  documents: PurchaseOrderDocument[];
  // Computed on every read, never stored — see purchase-orders.routes.ts
  // computeCompletion. "Completed" = every item's PreProduction run has
  // pooled into a CombinedLot that's reached DISPATCH_PLAN, same
  // definition the Dashboard's own active-run count already uses.
  completion: { isCompleted: boolean; completionDate: string | null; daysTaken: number | null };
}

// Bulk customer update result (POST /api/customers/import-updates) — one
// row per existing customer, resolved by Company Name; never creates.
export interface ImportCustomerUpdateRowResult {
  row: number;
  companyName: string;
  status: "updated" | "unmatched" | "ambiguous" | "invalid";
  message: string;
}

export interface ImportCustomerUpdatesResult {
  rowsProcessed: number;
  updated: number;
  unmatched: number;
  ambiguous: number;
  invalid: number;
  results: ImportCustomerUpdateRowResult[];
}

// Bulk PO import result (POST /api/purchase-orders/import) — every
// created PO lands as DRAFT, same review step as the manual form.
export interface ImportPurchaseOrdersResult {
  posCreated: number;
  itemsCreated: number;
  customersCreated: number;
  skippedExisting: string[]; // PO numbers that already existed — not touched
}

// --- PO Material Readiness — from the PPIC requirement conversation
// (2026-08-25). See PoMaterialRequirement in schema.prisma for the full
// business context: PPIC bulk-uploads, per PO, exactly which RM/PM
// items and quantities that PO needs; this is the live, computed
// readiness view built off that plus the existing stock ledger. ---

export interface PoReadinessItem {
  itemId: string;
  itemName: string;
  category: InventoryCategory;
  requiredQty: number;
  unit: string;
  onHand: number;
  covered: boolean;
}

export interface PoReadinessRow {
  purchaseOrder: { id: string; poNumber: string | null; status: PurchaseOrderStatus; customer: { id: string; companyName: string } };
  items: PoReadinessItem[];
  totalItems: number;
  readyItems: number;
  isReady: boolean;
}

export interface ImportPoRequirementsResult {
  rowsImported: number;
  itemsCreated: number;
  unmatchedPoNumbers: string[];
}

// Report — customer-wise, PO-wise wastage & rejection (GET
// /api/purchase-orders/reports/wastage-rejection). One row per
// ProductionBatch that's actually recorded input/output; wastageQty is
// recomputed server-side (inputQty - outputQty), mfgRejectedQty is the
// parent CombinedLot's own stored quality-rejection number.
export interface PoWastageRejectionRow {
  customerName: string;
  poNumber: string;
  productName: string;
  batchNo: string | null;
  unit: string | null;
  inputQty: number | null;
  outputQty: number | null;
  wastageQty: number | null;
  mfgRejectedQty: number | null;
}

// BD & PPIC's own download report (GET /api/purchase-orders/reports/bd-ppic)
// — one row per PO line item, columns matching their shared Excel
// template. value/ageingDays defined server-side, see that route's comment.
export interface PoBdPpicReportRow {
  poNumber: string | null;
  poDate: string | null;
  customerName: string;
  productName: string;
  quantity: number;
  unit: string;
  dispatchedQty: number;
  dispatchDate: string | null;
  value: number | null;
  ageingDays: number;
}

// Report — one RM/PM item's stock split by location (GET
// /api/inventory/items/:id/stock-by-location). Same balances stock.ts
// already computes per-location, just gathered for a single item across
// every Day Store and Plant in one response instead of one location
// across every item.
export interface ItemStockByLocation {
  item: InventoryItem;
  warehouse: number;
  dayStores: { id: string; name: string; receivedFromWarehouse: number; issuedToProduction: number; onHand: number }[];
  plants: { id: string; name: string; onHand: number }[];
}

// One open shipment, from GET /api/inventory/transit — normalizes three
// different underlying gates (Day Store/Plant transit-tracked entries,
// R&D transfers, and Material Received rows still in the inward QC
// queue) into one shape. confirmPath is set only for day_store/plant
// rows — vendor_qc and rnd rows are acted on through their own existing
// screens (linkPath points there) rather than a new action here.
// GET /api/inventory/reconciliation — of everything ever received for
// this item, where did it all go. consumedProduction/consumedSample/
// consumedWaste split what left a Plant's Dispensing three ways (see
// BatchConsumptionPurpose in schema.prisma) — all three already netted
// into onHandPlants above, this is purely a reporting breakdown of the
// same total. R&D's own outflow already has its own split, carried
// through here as-is. variance should be ~0 for a clean item — nonzero
// is the real signal this report exists to surface, per item, instead of
// a lump sum discovered a year later in a Tally suspense account.
export interface MaterialReconciliationRow {
  item: { id: string; name: string; category: InventoryCategory; unit: string | null };
  receivedQty: number;
  onHandWarehouse: number;
  onHandDayStores: number;
  onHandPlants: number;
  consumedProduction: number;
  consumedSample: number;
  consumedWaste: number;
  rndTesting: number;
  rndFormulationTrial: number;
  rndWastage: number;
  rndRejected: number;
  rndDispatchedCustomer: number;
  rndReturnedToWarehouse: number; // info only — already folded back into receivedQty
  accountedFor: number;
  variance: number;
}

// Phase G — GET /api/purchase-orders/:id/reconciliation. One row per PO
// line item, rolling up its whole three-tier production run: how much is
// planned vs the item's own ordered qty, RM/PM dispensed split three
// ways (see BatchConsumptionPurpose), what actually went to QC and what
// it resolved to (see QcSampleConsumeReason), every ProductionBatch's
// own recorded output, the CombinedLot's QA gates' Rejected/Wastage
// split (Phase F), and what Dispatch Plan recorded as shipped. `totals`
// sums the same fields across every item.
export interface PoReconciliationProductionBatchRow {
  batchId: string;
  batchNo: string | null;
  outputQty: number;
}

export interface PoReconciliationItemRow {
  purchaseOrderItemId: string;
  productName: string;
  orderedQty: number;
  unit: string;
  currentStageId: CombinedLotStageId | null;
  plannedQtyTotal: number;
  dispensedProduction: number;
  dispensedSample: number;
  dispensedWaste: number;
  sampleSentToQc: number;
  sampleTestingQty: number;
  sampleWastageQty: number;
  sampleRejectedQty: number;
  outputQty: number;
  mfgRejectedQty: number;
  mfgWastageQty: number;
  packRejectedQty: number;
  packWastageQty: number;
  dispatchedQty: number;
  productionBatches: PoReconciliationProductionBatchRow[];
}

export type PoReconciliationTotals = Omit<PoReconciliationItemRow, "purchaseOrderItemId" | "productName" | "orderedQty" | "unit" | "currentStageId" | "productionBatches">;

export interface PoReconciliation {
  poId: string;
  poNumber: string | null;
  items: PoReconciliationItemRow[];
  totals: PoReconciliationTotals;
}

// --- PO-level consolidated Billing — one commercial invoice for the
// whole PO (separate from each CombinedLot's own Billing & E-Way Bill
// stage, which is per-shipment paperwork). Price per Pouch (from the item's own
// RM Costing plan) x estimated pouches shipped — see
// purchase-orders.routes.ts's GET/POST /:id/billing. ---
export interface PoBillingLine {
  purchaseOrderItemId: string;
  productName: string;
  unit: string;
  dispatchedQtyKg: number;
  packSizeG: number | null;
  pricePerPouch: number | null;
  estimatedPouches: number | null;
  amount: number | null;
  priced: boolean;
}

export interface PurchaseOrderInvoice {
  id: string;
  purchaseOrderId: string;
  invoiceNo: string | null;
  invoiceDate: string | null;
  totalAmount: number;
  lineItems: PoBillingLine[];
  generatedById: string;
  generatedBy: { fullName: string; email: string };
  generatedAt: string;
  updatedAt: string;
}

export interface PoBilling {
  poId: string;
  poNumber: string | null;
  lines: PoBillingLine[];
  totalAmount: number;
  invoice: PurchaseOrderInvoice | null;
}

// --- Recycle Store — a read-only combined view over the two waste
// ledgers this app writes to automatically (see recycle-store.routes.ts):
// a real RM/PM spill at Dispensing (traced to a PreProduction run) or a
// Plant->Recycle Store move (kind: "material", InventoryItem-backed),
// and a QA gate's own Wastage bucket (kind: "batch_output", Phase F —
// the pooled lot's in-process/finished output, no InventoryItem to hang
// off, traced to a CombinedLot). No create/consume/return actions here —
// unlike R&D Store, this is a one-way sink with nothing to act on, only
// to see. ---

export type RecycleStoreEntryKind = "material" | "batch_output";

export interface RecycleStoreTransaction {
  kind: RecycleStoreEntryKind;
  id: string;
  itemName: string | null; // material only
  category: InventoryCategory | null; // material only
  quantity: number;
  unit: string;
  plantName: string | null; // material only
  stageLabel: string | null; // batch_output only
  productName: string | null;
  poNumber: string | null;
  customerName: string | null;
  note: string | null;
  date: string;
  createdByName: string;
}

export interface RecycleStoreByItemRow {
  itemId: string;
  itemName: string;
  category: InventoryCategory;
  unit: string;
  totalQty: number;
  entryCount: number;
}

export interface RecycleStoreByBatchRow {
  combinedLotId: string;
  stageId: "QA_GATE_MFG" | "QA_GATE_PACKAGING";
  stageLabel: string;
  unit: string;
  totalQty: number;
  entryCount: number;
  productName: string | null;
  poNumber: string | null;
  customerName: string | null;
}

export interface TransitItem {
  kind: "day_store" | "plant" | "vendor_qc" | "rnd" | "qc_sample";
  id: string;
  item: { id: string; name: string; category: InventoryCategory; unit: string | null };
  quantity: number;
  unit: string;
  from: string;
  to: string;
  dispatchedAt: string;
  dispatchedBy: PersonRef;
  confirmPath: string | null;
  linkPath: string;
  // qc_sample only — which product this sample belongs to, so the row is
  // identifiable without following linkPath first.
  productName?: string | null;
}

// --- The three-tier production pipeline (see schema.prisma's own
// comment blocks above PreProduction/ProductionBatch/CombinedLot) — the
// flow given directly by the business, split across three linked
// records instead of one long single-Batch walk:
//
//   Tier 1 — PreProduction: Material Received -> Sample QC Approval, one
//   run per PO line item (see pre-production-stage.ts on the API side).
//   Tier 2 — ProductionBatch: one or more small manufacturing runs
//   against a PreProduction, limited by real equipment capacity. No
//   stage machine of its own — just IN_PROGRESS -> COMPLETED. Completing
//   one automatically adds its output to the parent's combinedQty.
//   Tier 3 — CombinedLot: IPQC -> Dispatch Plan, created automatically
//   once every planned ProductionBatch has completed and combined (see
//   combined-lot-stage.ts). ---

export type PreProductionStageId = "MATERIAL_RECEIVED" | "INDENT_ISSUE" | "LINE_CLEARANCE" | "DISPENSING" | "SAMPLE_QC_APPROVAL";

export type CombinedLotStageId = "IPQC" | "QA_GATE_MFG" | "BULK_QC" | "PACKAGING" | "QA_GATE_PACKAGING" | "BILLING_EWAY_BILL" | "DISPATCH_PLAN";

export interface StageDelay {
  isDelayed: boolean;
  against: "dispatchPlanDate" | "productionPlanDate" | null;
  daysLate: number | null;
}

// Derived, never entered directly — wastageQty = inputQty - outputQty.
// Null until both are recorded. See computeWastage in batch.engine.ts.
export interface StageWastage {
  wastageQty: number | null;
  wastagePct: number | null;
}

// Bulk Reconciliation (BMR-1.docx 8.0) — derived from
// bulkTheoreticalWeight/bulkActualWeight/bulkQcSampleWeight, the
// client's real yield formula {(b+c)/a×100}%. Null until theoretical and
// actual weight are both recorded. See computeBulkReconciliation in
// batch.engine.ts.
export interface BulkReconciliation {
  yieldPct: number | null;
  processLoss: number | null;
}

export interface PreProductionStageEvent {
  id: string;
  fromStageId: PreProductionStageId;
  toStageId: PreProductionStageId;
  action: "FORWARD" | "REJECT" | "JUMP";
  note: string | null;
  actorId: string;
  actorName: string;
  createdAt: string;
}

export interface CombinedLotStageEvent {
  id: string;
  fromStageId: CombinedLotStageId;
  toStageId: CombinedLotStageId;
  action: "FORWARD" | "REJECT" | "JUMP";
  note: string | null;
  actorId: string;
  actorName: string;
  createdAt: string;
}

export type ChecklistRow = {
  itemKey: string;
  label: string;
  deptOk: boolean | null;
  qaOk: boolean | null;
};

// One row of the Certificate of Analysis — matches COA format.docx's
// S.No / Test Parameters / Observations / Specification, in the order
// QA entered them (sortOrder). Which tests apply varies by product, so
// unlike ChecklistRow above this isn't a fixed set — see
// BatchCoaTestResult in schema.prisma.
export interface CoaTestResult {
  id: string;
  testName: string;
  specification: string | null;
  observation: string | null;
  sortOrder: number;
}

// Tier 2 — one small manufacturing run against a PreProduction. No stage
// machine — just IN_PROGRESS -> COMPLETED.
export interface ProductionBatch {
  id: string;
  preProductionId: string;
  batchNo: string | null;
  plannedQty: number;
  status: "IN_PROGRESS" | "COMPLETED";
  manufacturingStartDate: string | null;
  manufacturingStatus: string | null;
  manufacturingEndDate: string | null;
  manufacturingRemarks: string | null;
  // Wastage — derived, never entered directly (inputQty - outputQty).
  inputQty: number | null;
  outputQty: number | null;
  wastage: StageWastage;
  completedById: string | null;
  completedByName: string | null;
  completedAt: string | null;
  createdById: string;
  createdByName: string;
  createdAt: string;
}

// Tier 1 — one run per PO line item.
export interface PreProduction {
  id: string;
  purchaseOrderItemId: string;
  currentStageId: PreProductionStageId;
  // The item's own full ordered quantity — one PreProduction run covers
  // all of it now, no per-run split at this tier any more.
  plannedQty: number;
  // Running total of every ProductionBatch's own outputQty once it
  // completes — see schema.prisma's comment on PreProduction.combinedQty.
  combinedQty: number;
  // plannedQty - combinedQty, computed server-side — how much production
  // is still unaccounted for before a CombinedLot can form.
  remainingQty: number;
  grnNo: string | null;
  grnDate: string | null;
  materialReceivedRemarks: string | null;
  sourceReceiptId: string | null;
  productionPlanDate: string | null;
  unit: string | null;
  dispatchPlanDate: string | null;
  prodIndentSlipSign: string | null;
  rmDispensingDate: string | null;
  rmDispensingRemarks: string | null;
  pmIssuedDate: string | null;
  pmDispensingRemarks: string | null;
  // The pre-production hard gate — blocks FORWARD unless this reads
  // literally "Approved". This is also this tier's own terminal stage —
  // it completes in place once Approved, ready for Production to start
  // ProductionBatch runs.
  sampleQcStatus: string | null;
  sampleQcRemarks: string | null;
  lineClearanceStatus: string | null;
  lineClearanceRemarks: string | null;
  purchaseOrderItem: {
    id: string;
    productName: string;
    quantity: number;
    unit: string;
    purchaseOrder: { id: string; poNumber: string | null; customer: { id: string; companyName: string } };
  };
  stageEvents: PreProductionStageEvent[];
  delay: StageDelay;
  plantId: string | null;
  plant: { id: string; name: string } | null;
  consumptions: {
    id: string;
    itemId: string;
    quantity: number;
    unit: string;
    purpose: "PRODUCTION" | "SAMPLE" | "WASTE";
    createdAt: string;
    item: InventoryItem;
    createdBy: { fullName: string; email: string };
    grossWeight: number | null;
    tareWeight: number | null;
    netWeight: number | null;
    arNo: string | null;
    qaVerifiedById: string | null;
    qaVerifiedAt: string | null;
    qaVerifiedByName: string | null;
  }[];
  indentRequests: {
    id: string;
    itemId: string;
    category: string;
    requestedQty: number;
    status: string;
    createdAt: string;
    item: { name: string; unit: string | null };
  }[];
  sourceReceipt: { id: string; grnNo: string | null; date: string; quantity: number; unit: string; item: { name: string } } | null;
  // Every small manufacturing run against this item, plus the pooled lot
  // (if any) they've combined into.
  productionBatches: ProductionBatch[];
  combinedLot: { id: string; currentStageId: CombinedLotStageId } | null;
  dispensingShortfall?: DispensingRequirementItem[];
  lineClearanceChecklist: ChecklistRow[];
}

// Tier 3 — the pooled lot every one of a PreProduction's
// ProductionBatches combines into, created once combinedQty reaches
// plannedQty. Everything from IPQC on happens exactly once against this.
export interface CombinedLot {
  id: string;
  preProductionId: string;
  currentStageId: CombinedLotStageId;
  preProduction: {
    id: string;
    plannedQty: number;
    combinedQty: number;
    dispatchPlanDate: string | null;
    productionPlanDate: string | null;
    purchaseOrderItem: {
      id: string;
      productName: string;
      quantity: number;
      unit: string;
      purchaseOrder: { id: string; poNumber: string | null; customer: { id: string; companyName: string } };
    };
  };
  // Bulk Reconciliation (BMR-1.docx 8.0).
  bulkTheoreticalWeight: number | null;
  bulkActualWeight: number | null;
  bulkQcSampleWeight: number | null;
  bulkTransferToPackingQty: number | null;
  bulkReconciliation: BulkReconciliation;
  ipqcStatus: string | null;
  ipqcRemarks: string | null;
  mfgQaStatus: string | null;
  mfgQcStatus: string | null;
  mfgRemarks: string | null;
  mfgApprovedQty: number | null;
  mfgRejectedQty: number | null;
  mfgWastageQty: number | null;
  bulkQcStatus: string | null;
  bulkQcRemarks: string | null;
  coaResult: string | null;
  coaRemark: string | null;
  coaAnalyzedById: string | null;
  coaAnalyzedAt: string | null;
  coaAnalyzedByName: string | null;
  coaReviewedById: string | null;
  coaReviewedAt: string | null;
  coaReviewedByName: string | null;
  coaApprovedById: string | null;
  coaApprovedAt: string | null;
  coaApprovedByName: string | null;
  coaResults: CoaTestResult[];
  packagingStartDate: string | null;
  packagingStatus: string | null;
  packagingEndDate: string | null;
  packagingRemarks: string | null;
  packQaStatus: string | null;
  packQcStatus: string | null;
  packRemarks: string | null;
  packApprovedQty: number | null;
  packRejectedQty: number | null;
  packWastageQty: number | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  ewayBillNo: string | null;
  ewayBillDate: string | null;
  billingRemarks: string | null;
  dispatchDate: string | null;
  dispatchedQty: number | null;
  shipperQty: number | null;
  totalShipperWeight: number | null;
  transportType: string | null;
  remainingQty: number | null;
  anyRemarks: string | null;
  dispatchTransferId: string | null;
  stageEvents: CombinedLotStageEvent[];
  delay: StageDelay;
  dispatchTransfer: {
    id: string;
    productName: string;
    quantity: number;
    qcStatus: string | null;
    dispatchedAt: string | null;
    invoiceNumber: string | null;
    invoicedAt: string | null;
  } | null;
  recycleLogs: {
    id: string;
    stageId: "QA_GATE_MFG" | "QA_GATE_PACKAGING";
    quantity: number;
    unit: string;
    note: string | null;
    createdAt: string;
  }[];
  lineClearanceChecklist: ChecklistRow[];
}

// Bulk "forward the current stage" import result — see
// POST /api/pre-productions/import / batch-import.ts on the API side.
export interface BatchImportRowResult {
  row: number;
  poNumber: string;
  productName: string;
  status: "forwarded" | "blocked" | "unmatched" | "error";
  message: string;
}

export interface BatchImportSummary {
  rowsProcessed: number;
  forwarded: number;
  blocked: number;
  unmatched: number;
  results: BatchImportRowResult[];
}

// What this run's product needs (per its linked, calculated
// RmPlan/BomPlan) versus what's been logged against it so far — see
// GET /api/pre-productions/:id/dispensing-requirements.
export interface DispensingRequirementItem {
  itemId: string;
  itemName: string;
  category: string;
  unit: string;
  requiredQty: number;
  consumedQty: number;
  covered: boolean;
}

// --- Packaging BOM module ---
//
// There used to be a separate "Brand" catalog entity here — the SKU
// spec catalog now hangs directly off Customer instead (a Brand and the
// Customer placing the PO are almost always the same real company; see
// the Sku model's own schema comment).

// Field names mirror Sku's own Prisma columns 1:1 — see catalog.routes.ts's
// serializeSku(). All the spec fields are optional: a SKU created via the
// PO form's quick-add ("+ New") has none of these yet, only a name.
export interface CatalogSku {
  id: string;
  customerId: string;
  customerName: string;
  productName: string;
  jar?: string | null;
  wadMm?: string | null;
  scoopMl?: string | null;
  silicaGelGms?: string | null;
  silicaGelQtyNos?: string | null;
  authenticationSticker?: string | null;
  capSticker?: string | null;
  capLockSticker?: string | null;
  neckSleeve?: string | null;
  shrink?: string | null;
  innerPackaging?: string | null;
  leaflet?: string | null;
  corrugatedBoxMm?: string | null;
  packagingSizeNos?: string | null;
  // Any spreadsheet column that isn't one of the typed fields above (a
  // new column the importer hasn't been taught yet, or a one-off custom
  // field added by hand) — see catalogImport.ts / RndPage's SkuEditor.
  extra?: Record<string, unknown>;
  // The real packaging BOM checklist — a list, not more fixed fields,
  // because the real PM SHEET has types (Sachet, Tin Jar, Laminate, two
  // simultaneous Silica sizes, ...) the fields above can't represent.
  // See the SkuPackagingComponent model's own schema comment.
  packagingComponents?: PackagingComponent[];
}

export interface PackagingComponent {
  id: string;
  type: string;
  quantity: number | null;
  unit: string;
  pmCode: string | null;
}

// The real PM SHEET's 21 known packaging types — the checklist the
// Packaging BOM editor starts from. Not a closed set: "+ Add a type" in
// that editor can add anything not on this list.
export const KNOWN_PACKAGING_TYPES = [
  "Jar",
  "Cap",
  "Wad",
  "Label",
  "Sachet",
  "Tin Jar",
  "Laminate",
  "Zip Pouch",
  "Monocarton",
  "Silica 5gm",
  "Silica 2gm",
  "Scoop",
  "Authentication Label",
  "Neck Sleeves",
  "Cap Lock",
  "Cap Sticker",
  "Leaflet",
  "Shrink Sleeves",
  "Poly Bag",
  "Inner",
  "Corrugated Box (Outer Shipper)",
] as const;

// The known spec fields, in the order RndPage's SkuEditor shows them.
export const CATALOG_SKU_SPEC_FIELDS: { key: keyof CatalogSku; label: string }[] = [
  { key: "jar", label: "Jar" },
  { key: "wadMm", label: "Wad (MM)" },
  { key: "scoopMl", label: "Scoop (ML)" },
  { key: "silicaGelGms", label: "Silica Gel (Gms.)" },
  { key: "silicaGelQtyNos", label: "Silica Gel Qty. (Nos.)" },
  { key: "authenticationSticker", label: "Authentication Sticker" },
  { key: "capSticker", label: "Cap Sticker" },
  { key: "capLockSticker", label: "Cap Lock Sticker" },
  { key: "neckSleeve", label: "Neck Sleeve" },
  { key: "shrink", label: "Shrink" },
  { key: "innerPackaging", label: "Inner Packaging" },
  { key: "leaflet", label: "Leaflet" },
  { key: "corrugatedBoxMm", label: "Corrugated Box (MM)" },
  { key: "packagingSizeNos", label: "Packaging Size (Nos.)" },
];

export type BomCategory = "1-Primary" | "2-Secondary" | "3-Tertiary";

export interface BomResultLine {
  category: BomCategory;
  component: string;
  spec: string;
  baseQty: number;
  wastageRate: number;
  bufferQty: number;
  totalQty: number;
  sources: Record<string, number>;
}

export interface BomResult {
  totalYield: number;
  brands: string[];
  lines: BomResultLine[];
}

export interface BomPlanItem {
  id: string;
  skuId: string;
  customerName: string;
  productName: string;
  targetYield: number;
}

export interface LinkedOrder {
  productName: string;
  poNumber: string | null;
  purchaseOrderId: string;
}

// "Did you mean X?" — populated only when a plan is linked to a PO item,
// still has nothing queued, and a near-name match exists in the catalog
// (see bom-plan.routes.ts findSkuSuggestions / rm-plan.routes.ts
// findRecipeSuggestions). Lets a typo be fixed with one click instead of
// reading as "formulation doesn't exist" and going to R&D unnecessarily.
export interface SuggestedSku {
  skuId: string;
  customerName: string;
  productName: string;
  score: number;
  targetYield: number;
}

export interface SuggestedRecipe {
  recipeId: string;
  recipeName: string;
  score: number;
  defaultBatchSizeKg: number;
}

export type RecipeRequestStatus = "PENDING" | "ETA_GIVEN" | "READY";

// PPIC's "we don't have a Recipe/SKU for this product yet" ask to R&D —
// see recipe-request.routes.ts.
export interface RecipeRequest {
  id: string;
  productName: string;
  customerName: string | null;
  bomNeeded: boolean;
  rmNeeded: boolean;
  bomFulfilledAt: string | null;
  rmFulfilledAt: string | null;
  status: RecipeRequestStatus;
  requestedAt: string;
  etaDate: string | null;
  etaNote: string | null;
  respondedAt: string | null;
  readyAt: string | null;
  requestedByName: string;
  respondedByName: string | null;
  purchaseOrderId: string;
  poNumber: string | null;
}

export interface BomPlan {
  id: string;
  name: string;
  dateFrom: string | null;
  dateTo: string | null;
  status: "DRAFT" | "CALCULATED";
  calculatedAt: string | null;
  createdAt: string;
  sentToPreInventoryAt: string | null;
  result: BomResult | null;
  items: BomPlanItem[];
  purchaseOrderItemId: string | null;
  linkedOrder: LinkedOrder | null;
  suggestedSkus?: SuggestedSku[];
}

// --- RM Costing module ---

export interface RecipeSummary {
  id: string;
  name: string;
  totalServing: number;
  ingredientCount: number;
}

export interface CostingParams {
  mfgLossPct: number;
  packSizeG: number;
  testCost: number;
  jarCost: number;
  scoopCost: number;
  labelCost: number;
  convCost: number;
  ccbCost: number;
  profitPct: number;
  gstPct: number;
}

export interface BatchIngredientResult {
  name: string;
  brand: string;
  proteinPct: number;
  costPerKg: number;
  ratePerGm: number;
  gPerServing: number;
  perBatchGrams: number;
  qtyInKg: number;
  amount: number;
}

export interface BatchCostingResult {
  recipeName: string;
  gmPerServing: number;
  batchSizeKg: number;
  servingsPerBatch: number;
  proteinPctInBatch: number;
  costPerKgWithoutPkg: number;
  totalRmCost: number;
  testCost: number;
  mfgLossPct: number;
  mfgLossAmount: number;
  packagingTotal: number;
  cogsPerPouch: number;
  profitAmount: number;
  gstAmount: number;
  pricePerPouch: number;
  ingredients: BatchIngredientResult[];
}

export interface ProcurementLine {
  name: string;
  brand: string;
  estCostPerKg: number;
  totalKg: number;
  sources: Record<string, number>;
}

export interface RmResult {
  batches: BatchCostingResult[];
  procurement: ProcurementLine[];
}

export interface RmPlanItem {
  id: string;
  recipeId: string;
  recipeName: string;
  batchSizeKg: number;
}

export interface RmPlan {
  id: string;
  name: string;
  dateFrom: string | null;
  dateTo: string | null;
  status: "DRAFT" | "CALCULATED";
  costingParams: CostingParams;
  calculatedAt: string | null;
  createdAt: string;
  sentToPreInventoryAt: string | null;
  result: RmResult | null;
  items: RmPlanItem[];
  purchaseOrderItemId: string | null;
  linkedOrder: LinkedOrder | null;
  suggestedRecipes?: SuggestedRecipe[];
}

// The old separate "MPS Pipeline" module (MpsCycle/MpsWorkflow/13 ported
// steps) has been retired — the real MPS turned out to be the Batch
// pipeline itself (see BatchStageId above and lib/batchStage.ts).

// --- Inventory module ---
// Warehouse-level Material Received / Material Issued (day store &
// production) log, plus the Dispatch-side FG/Bill transfer log,
// reconstructed from "Inventory tool.xlsx" — see the Prisma schema comment.

// Every inventory action attributes to a real account, with its
// employeeId included so reports/exports can show "Name (FLS-0007)" —
// the same disambiguation Users/AppLayout already use.
export interface PersonRef {
  id: string;
  employeeId: number;
  fullName: string;
}

export type InventoryCategory = "RM" | "PM";
// ISSUED_RND — sample sent to the R&D Store (see the RndTransfer /
// RndStoreTransaction comment block in schema.prisma). Not a valid
// InventoryRequestPurpose below — that's its own explicit union, not
// derived from this one, precisely so ISSUED_RND (an R&D Store-only
// concept, never raised as a Material Request) can't leak into it.
export type InventoryTxnType = "RECEIVED" | "ISSUED_DAY_STORE" | "ISSUED_PRODUCTION" | "ISSUED_RND";
export type DispatchTransferType = "FG" | "BILL";
// Inward QC gate — RECEIVED rows only; null for ISSUED_* rows.
export type InventoryReceiptStatus = "PENDING_QC" | "ON_HOLD" | "QC_APPROVED" | "QC_REJECTED" | "ACCEPTED";
// Outward QC gate — FG dispatch transfers only; null for BILL rows.
export type DispatchQcStatus = "PENDING_QC" | "ON_HOLD" | "QC_APPROVED" | "QC_REJECTED";

export interface InventoryItem {
  id: string;
  category: InventoryCategory;
  name: string;
  unit: string | null;
  code: string | null;
  // A default vendor suggestion only, from the Item Master sheet's own
  // "Make" column — pre-fills Material Received's Vendor Name field,
  // never a fixed part of the item (a real delivery's own vendorName can
  // always differ).
  preferredVendor: string | null;
  // Pricing/costing — matches the client's own stock-report format
  // (Cost Price, M.R.P., Purchase Price, Sales Price). Purchase/Accounts
  // only: the API strips these fields entirely (not nulled) for every
  // other role, so they're typed optional here rather than nullable —
  // "absent" means "you can't see it," not "never priced."
  costPrice?: number | null;
  mrp?: number | null;
  purchasePrice?: number | null;
  salesPrice?: number | null;
  createdAt: string;
}

// Named, growable identities (not a fixed count) — Store/Admin can add
// more any time. See DayStore/Plant in schema.prisma.
export interface DayStore {
  id: string;
  name: string;
  createdAt: string;
}

export interface Plant {
  id: string;
  name: string;
  createdAt: string;
}

// One per InventoryCategory (RM/PM) — always exactly two rows, unlike the
// growable DayStore/Plant lists. Which warehouse an item belongs to is
// never stored; it's derived by matching InventoryItem.category to
// Warehouse.category. See warehouses.routes.ts / schema.prisma Warehouse.
export interface Warehouse {
  id: string;
  name: string;
  category: InventoryCategory;
  createdAt: string;
}

// One row = one STORE user scoped to this Store — see DayStoreAssignment
// in schema.prisma. No rows for a store's user means unrestricted, not
// "assigned to nothing"; this list is only ever the *narrowing* rows.
export interface DayStoreAssignment {
  userId: string;
  dayStoreId: string;
  assignedAt: string;
  user: PersonRef;
  assignedBy: PersonRef | null;
}

// The assignable pool for a Store assignment picker — every user who
// currently holds the STORE role, nothing more (not the full admin user
// directory GET /api/users returns). See locations.routes.ts GET
// /day-stores/store-users.
export interface StoreUser {
  id: string;
  employeeId: number;
  fullName: string;
}

export interface InventoryTransaction {
  id: string;
  itemId: string;
  type: InventoryTxnType;
  date: string;
  unit: string;
  quantity: number;
  size: string | null;
  vendorName: string | null;
  createdAt: string;
  item: InventoryItem;
  createdBy: PersonRef;
  receiptStatus: InventoryReceiptStatus | null;
  qcCheckedBy: PersonRef | null;
  qcCheckedAt: string | null;
  qcNote: string | null;
  acceptedBy: PersonRef | null;
  acceptedAt: string | null;
  // S6/S7 — which Day Store received an ISSUED_DAY_STORE row, which
  // Plant received an ISSUED_PRODUCTION row. Both optional tags.
  dayStoreId: string | null;
  plantId: string | null;
  dayStore: DayStore | null;
  plant: Plant | null;
  // One-time go-live migration flag — see schema.prisma. RECEIVED rows
  // only; skips inward QC (receiptStatus goes straight to ACCEPTED).
  isOpeningStock: boolean;
  // Leftover R&D Store material Store confirmed back — same "skip QC"
  // shape as isOpeningStock, kept as its own flag so reports don't
  // conflate the two. See RndTransfer/RndStoreTransaction.
  isRndReturn: boolean;
  // Internal transit tracking — ISSUED_DAY_STORE/ISSUED_PRODUCTION only.
  // deliveredAt null (with isTransitTracked true) means still in transit;
  // see useTransit/useConfirmDelivery and GET /inventory/transit.
  isTransitTracked: boolean;
  deliveredAt: string | null;
  deliveredById: string | null;
  deliveredBy: PersonRef | null;
  // Partial QC rejection — set on an APPROVE when only part of the
  // delivery failed inspection. Null/0 means nothing was rejected. A
  // full REJECT leaves this null (receiptStatus = QC_REJECTED already
  // says 100%).
  rejectedQty: number | null;
  // Traceability off the physical stock sheet — all optional.
  batchNo: string | null;
  grnNo: string | null;
  mfgDate: string | null;
  expiryDate: string | null;
  remark: string | null;
  // ERP Diagram doc's incoming-QC reject branch — Accounts' own paper
  // trail against a RECEIVED row that came back QC_REJECTED (or carries
  // a partial rejectedQty). Always present as an array (possibly empty),
  // newest first — see txnInclude on the API side.
  debitNotes: DebitNote[];
}

// Raised by Accounts against a rejected (full or partial) Material
// Received row — see POST /inventory/transactions/:id/debit-notes.
// Append-only: no edit/delete route, same convention as every other
// paper-trail ledger in this app (BatchRecycleLog, QcSampleTransaction).
export interface DebitNote {
  id: string;
  transactionId: string;
  debitNoteNo: string | null;
  date: string;
  vendorName: string | null;
  itemId: string;
  quantity: number;
  unit: string;
  amount: number | null;
  reason: string | null;
  createdAt: string;
  createdBy: { fullName: string; email: string };
}

export interface InventoryStockLine {
  item: InventoryItem;
  receivedQty: number;
  // Sum of every partial QC rejection against this item — already
  // excluded from receivedQty, shown separately for visibility.
  rejectedQty: number;
  issuedDayStoreQty: number;
  issuedProductionQty: number;
  issuedRndQty: number;
  issuedQty: number;
  onHand: number;
}

// Real-time balance for one Day Store — see stock.ts
// getOnHandByDayStoreAndItem. Two legs, not just their net: how much the
// Warehouse has issued to this store, and how much this store has in
// turn issued on to Production — a Day Store never receives directly
// from a vendor, so there's no separate "received" figure the way the
// Warehouse-wide InventoryStockLine has.
export interface DayStoreStockLine {
  item: InventoryItem;
  receivedFromWarehouse: number;
  issuedToProduction: number;
  onHand: number;
}

// Real-time balance for one Plant — see stock.ts
// getOnHandByPlantAndItem. Same shape as DayStoreStockLine; the outflow
// side just comes from Batches (BatchMaterialConsumption) instead of
// another Inventory transaction type.
export interface PlantStockLine {
  item: InventoryItem;
  onHand: number;
}

export interface DispatchTransfer {
  id: string;
  type: DispatchTransferType;
  date: string;
  customerId: string;
  productName: string;
  quantity: number;
  createdAt: string;
  customer: { id: string; companyName: string };
  createdBy: PersonRef;
  qcStatus: DispatchQcStatus | null;
  qcCheckedBy: PersonRef | null;
  qcCheckedAt: string | null;
  qcNote: string | null;
  // Manual traceability tag, FG rows only — "this shipment came from
  // that Material Request". Not derived (Production isn't tracked
  // here), not required. requestedBy/reviewedBy/fulfillment aren't
  // included on this nested shape — fetch the full InventoryRequest
  // from the Material Requests tab for those.
  sourceRequestId: string | null;
  sourceRequest: (Pick<InventoryRequest, "id" | "category" | "requestedQty" | "purpose" | "status"> & { item: InventoryItem }) | null;
  // S8 — which Plant this FG shipment came from, FG rows only.
  plantId: string | null;
  plant: Plant | null;
  // S9 — Dispatch confirms the shipment went out; Finance then invoices.
  // Both FG-only, both null until their step happens.
  dispatchedById: string | null;
  dispatchedAt: string | null;
  dispatchNote: string | null;
  dispatchedBy: PersonRef | null;
  invoiceNumber: string | null;
  invoicedById: string | null;
  invoicedAt: string | null;
  invoicedBy: PersonRef | null;
}

// Customer stock reconciliation (GET
// /api/inventory/reports/customer-reconciliation) — one row per customer,
// FG dispatches only. "Dispatched" = Dispatch has confirmed it actually
// went out; "Invoiced" = Accounts has raised an invoice against it;
// outstanding is the gap Finance is actually chasing.
export interface CustomerReconciliationRow {
  customerName: string;
  dispatchedQty: number;
  dispatchedCount: number;
  invoicedQty: number;
  invoicedCount: number;
  outstandingQty: number;
  outstandingCount: number;
}

// --- Material Requests (indents) — the department-wise gate: PPIC
// requests, Store approves/rejects/issues. See inventory.routes.ts. ---

// PARTIALLY_ISSUED sits between APPROVED and ISSUED — Store doesn't
// need the full requestedQty on hand to issue something; the request
// only reaches ISSUED once every issue together covers requestedQty.
export type InventoryRequestStatus = "PENDING" | "APPROVED" | "PARTIALLY_ISSUED" | "REJECTED" | "ISSUED";
// A request's purpose is never RECEIVED — see inventory.schemas.ts.
export type InventoryRequestPurpose = "ISSUED_DAY_STORE" | "ISSUED_PRODUCTION";

export interface InventoryRequest {
  id: string;
  itemId: string;
  category: InventoryCategory;
  requestedQty: number;
  purpose: InventoryRequestPurpose;
  neededBy: string | null;
  note: string | null;
  status: InventoryRequestStatus;
  rejectionReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
  item: InventoryItem;
  requestedBy: PersonRef;
  reviewedBy: PersonRef | null;
  // A request can be issued against more than once now (partial
  // fulfillment) — issuedQty/remainingQty are derived server-side from
  // this list, never stored, so they can't drift.
  fulfillments: InventoryTransaction[];
  issuedQty: number;
  remainingQty: number;
  // S7 — which Plant this request is for, purpose ISSUED_PRODUCTION only.
  plantId: string | null;
  plant: Plant | null;
}

// --- Pre-Inventory — S1-S4: PPIC states a requirement, Warehouse says
// what's available, Purchase logs a PO for the shortfall, Finance reads
// the resulting vendor list. See PreInventoryRequirement in schema.prisma. ---

export interface PreInventoryRequirement {
  id: string;
  date: string;
  category: InventoryCategory;
  itemId: string;
  unit: string;
  requiredQty: number;
  size: string | null;
  note: string | null;
  createdAt: string;
  item: InventoryItem;
  requestedBy: PersonRef;
  // S2 — no manual Warehouse step any more: live off the real stock
  // ledger, computed fresh on every fetch, never stored.
  currentStock: number;
  shortQty: number;
  // S3 — Purchase, meaningful once shortQty > 0
  poNumber: string | null;
  vendorName: string | null;
  eta: string | null;
  purchaseById: string | null;
  purchaseAt: string | null;
  purchaseBy: PersonRef | null;
}

// --- Notifications ---

export interface AppNotification {
  id: string;
  recipientId: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

// --- User management (admin only) ---

export interface ManagedUser {
  id: string;
  employeeId: number;
  email: string;
  fullName: string;
  isActive: boolean;
  createdAt: string;
  roles: RoleName[];
}

// --- Recycle Bin (Admin only) — every soft-deletable entity type in the
// system, unified into one list. See recycle-bin.routes.ts for the full
// reasoning: nothing in this app hard-deletes real data any more. ---

export type RecycleBinEntityType =
  | "inventory-transaction"
  | "dispatch-transfer"
  | "inventory-request"
  | "po-material-requirement"
  | "purchase-order-item"
  | "purchase-order-document"
  | "bom-plan-item"
  | "rm-plan-item"
  | "pre-inventory-requirement";

export interface RecycleBinRow {
  entityType: RecycleBinEntityType;
  id: string;
  label: string;
  detail: string;
  deletedAt: string;
  deletedBy: PersonRef | null;
}

export const ALL_ROLES: RoleName[] = ["ADMIN", "BD", "PPIC", "STORE", "PURCHASE", "ACCOUNTS", "PRODUCTION", "QA_QC", "DISPATCH", "RND"];

// --- QC Dashboard — read-only aggregate over every QC checkpoint (inward
// Material Received, outward FG Dispatch, and the two Batch QA gates),
// see qc.routes.ts. Not new data — every row here is one already shown
// somewhere else; this just counts and lists what's pending/on hold. ---

export interface QcDashboard {
  counts: {
    onHoldTotal: number;
    pendingReceiptQc: number;
    onHoldReceiptQc: number;
    pendingDispatchQc: number;
    onHoldDispatchQc: number;
    onHoldMfgBatches: number;
    onHoldPackBatches: number;
    // Every batch sitting at one of the four hard-gate stages, not just
    // ones explicitly on Hold — see qc.routes.ts's own comment on why.
    pendingSampleQcBatches: number;
    pendingLineClearanceBatches: number;
    pendingIpqcBatches: number;
    pendingBulkQcBatches: number;
  };
  receipts: { pending: InventoryTransaction[]; onHold: InventoryTransaction[] };
  dispatches: { pending: DispatchTransfer[]; onHold: DispatchTransfer[] };
  batches: { onHoldMfg: CombinedLot[]; onHoldPack: CombinedLot[]; pendingSampleQc: PreProduction[]; pendingLineClearance: PreProduction[]; pendingIpqc: CombinedLot[]; pendingBulkQc: CombinedLot[] };
}

// --- System Health / Audit Log — Admin-only operational tooling, see
// system.routes.ts. Neither is new data; both just expose what
// recordAudit() and the DB connection already have. ---

export interface SystemHealth {
  status: "ok" | "error";
  db: { connected: boolean; database?: string; latencyMs?: number };
  process?: {
    uptimeSeconds: number;
    nodeVersion: string;
    env: string;
    memoryMb: { rss: number; heapUsed: number; heapTotal: number };
  };
  counts?: { users: number; activeUsers: number; batches: number; purchaseOrders: number; auditLogEntries: number };
  error?: string;
  checkedAt: string;
}

// --- R&D Store — a second, independent stock ledger for R&D's own
// sample lifecycle (Warehouse -> R&D -> research/customer/back to
// Warehouse). See the RndTransfer/RndStoreTransaction comment block in
// schema.prisma. ---

export type RndTransferDirection = "TO_RND" | "TO_WAREHOUSE";
export type RndTransferStatus = "PENDING" | "CONFIRMED";

export interface RndTransfer {
  id: string;
  direction: RndTransferDirection;
  itemId: string;
  itemName: string;
  category: InventoryCategory;
  quantity: number;
  unit: string;
  note: string | null;
  sentAt: string;
  sentByName: string;
  confirmedAt: string | null;
  confirmedByName: string | null;
  status: RndTransferStatus;
}

export type RndStoreTxnType = "INBOUND" | "CONSUMED" | "DISPATCHED" | "RETURNED";
export type RndConsumeReason = "TESTING" | "FORMULATION_TRIAL" | "WASTAGE" | "REJECTED";

export interface RndStoreTransaction {
  id: string;
  type: RndStoreTxnType;
  itemId: string;
  itemName: string;
  category: InventoryCategory;
  quantity: number;
  unit: string;
  consumeReason: RndConsumeReason | null;
  customerId: string | null;
  customerName: string | null;
  // When this actually happened (editable, defaults to today) — separate
  // from createdAt. Null on INBOUND/RETURNED rows, which already have a
  // real date via their linked RndTransfer.
  date: string | null;
  // DISPATCHED only.
  brandName: string | null;
  courierDetails: string | null;
  // CONSUMED only.
  projectName: string | null;
  formulationRef: string | null;
  batchNo: string | null;
  note: string | null;
  createdAt: string;
  createdByName: string;
}

// R&D asking Store for material — the real trigger for step 1 (R&D knows
// what it needs mid-research on a product PPIC asked for). Store fulfills
// (which creates the RndTransfer above) or rejects it.
export type RndSampleRequestStatus = "PENDING" | "FULFILLED" | "REJECTED" | "CANCELLED";

export interface RndSampleRequest {
  id: string;
  itemId: string;
  itemName: string;
  category: InventoryCategory;
  quantity: number;
  unit: string;
  note: string | null;
  status: RndSampleRequestStatus;
  requestedAt: string;
  requestedByName: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
  rejectionReason: string | null;
  transferId: string | null;
}

export interface RndStoreStockRow {
  item: InventoryItem;
  onHand: number;
}

export interface RndStoreReportRow {
  itemId: string;
  itemName: string;
  category: InventoryCategory;
  unit: string;
  inboundQty: number;
  testingQty: number;
  formulationTrialQty: number;
  wastageQty: number;
  rejectedQty: number;
  dispatchedQty: number;
  returnedQty: number;
  onHand: number;
}

// --- QC Sample Store — the pre-production sample lifecycle scoped to one
// PreProduction run (see schema.prisma's QcSampleTransfer/
// QcSampleTransaction comment block). Same sent->confirm->consume shape
// as the R&D Store above, but scoped to one run rather than a general
// item ledger, and the TO_QC send itself is created automatically as
// part of logging Dispensing's SAMPLE-purpose consumption — see
// qc-sample.routes.ts. ---

export type QcSampleDirection = "TO_QC" | "TO_PLANT";
export type QcSampleTransferStatus = "PENDING" | "CONFIRMED";

export interface QcSampleTransfer {
  id: string;
  preProductionId: string;
  direction: QcSampleDirection;
  itemId: string;
  itemName: string;
  category: InventoryCategory;
  quantity: number;
  unit: string;
  note: string | null;
  sentAt: string;
  sentByName: string;
  confirmedAt: string | null;
  confirmedByName: string | null;
  status: QcSampleTransferStatus;
}

export type QcSampleTxnType = "INBOUND" | "CONSUMED" | "RETURNED";
export type QcSampleConsumeReason = "TESTING" | "WASTAGE" | "REJECTED";

export interface QcSampleTransaction {
  id: string;
  itemId: string;
  itemName: string;
  category: InventoryCategory;
  type: QcSampleTxnType;
  quantity: number;
  unit: string;
  consumeReason: QcSampleConsumeReason | null;
  note: string | null;
  createdAt: string;
  createdByName: string;
}

export interface QcSampleSummary {
  transfers: QcSampleTransfer[];
  transactions: QcSampleTransaction[];
  onHand: Record<string, number>;
}

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  actor: (PersonRef & { email: string }) | null;
}
