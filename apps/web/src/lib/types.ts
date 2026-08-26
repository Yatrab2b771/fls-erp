export type RoleName = "ADMIN" | "BD" | "PPIC" | "STORE" | "PURCHASE" | "ACCOUNTS" | "PRODUCTION" | "QA_QC" | "DISPATCH";

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
  _count?: { batches: number };
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
  brandName: string | null;
  orderDate: string | null;
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
  // computeCompletion. "Completed" = every Batch on every line item has
  // reached DISPATCH_PLAN with a recorded customer confirmation, same
  // definition the Dashboard's own active-batch count already uses.
  completion: { isCompleted: boolean; completionDate: string | null; daysTaken: number | null };
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
  purchaseOrder: { id: string; poNumber: string | null; brandName: string | null; status: PurchaseOrderStatus; customer: { id: string; companyName: string } };
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
// /api/purchase-orders/reports/wastage-rejection). One row per Batch
// that's actually recorded a wastage or rejection figure; wastageQty is
// recomputed server-side the same way Batch.wastage always is
// (inputQty - outputQty), mfgRejectedQty is QC's own stored number.
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

// The Batch pipeline stages — the flow given directly by the business
// (see batchStage.ts for the full definition and the schema.prisma
// comment on BatchStageId for what was simplified out of an earlier,
// more granular reconstruction).
export type BatchStageId =
  | "PO_RELEASE"
  | "MATERIAL_RECEIVED"
  | "INDENT_ISSUE"
  | "DISPENSING"
  | "PRODUCTION_EXECUTION"
  | "QA_GATE_MFG"
  | "PACKAGING"
  | "QA_GATE_PACKAGING"
  | "BILLING_EWAY_BILL"
  | "DISPATCH_PLAN";

export interface BatchDelay {
  isDelayed: boolean;
  against: "dispatchPlanDate" | "productionPlanDate" | null;
  daysLate: number | null;
}

// Derived, never entered directly — wastageQty = inputQty - outputQty.
// Null until both are recorded. See computeWastage in batch.engine.ts.
export interface BatchWastage {
  wastageQty: number | null;
  wastagePct: number | null;
}

export interface BatchStageEvent {
  id: string;
  fromStageId: BatchStageId;
  toStageId: BatchStageId;
  // JUMP is the admin-only override — moves a batch straight to any
  // stage, bypassing the normal forward/reject sequence.
  action: "FORWARD" | "REJECT" | "JUMP";
  note: string | null;
  actorId: string;
  actorName: string;
  createdAt: string;
}

export interface Batch {
  id: string;
  purchaseOrderItemId: string;
  batchNo: string | null;
  currentStageId: BatchStageId;
  productionPlanDate: string | null;
  unit: string | null;
  dispatchPlanDate: string | null;
  prodIndentSlipSign: string | null;
  rmPoDate: string | null;
  rmExpectedDate: string | null;
  rmStatus: string | null;
  rmRemarks: string | null;
  pmPoDate: string | null;
  pmExpectedDate: string | null;
  pmStatus: string | null;
  pmRemarks: string | null;
  rmDispensingDate: string | null;
  rmDispensingRemarks: string | null;
  pmIssuedDate: string | null;
  pmDispensingRemarks: string | null;
  manufacturingStartDate: string | null;
  manufacturingStatus: string | null;
  manufacturingEndDate: string | null;
  manufacturingRemarks: string | null;
  // Wastage — Production's entry (mechanical/process loss).
  inputQty: number | null;
  outputQty: number | null;
  mfgQaStatus: string | null;
  mfgQcStatus: string | null;
  mfgRemarks: string | null;
  // Quality rejection — QC's entry, independent of wastage above.
  mfgRejectedQty: number | null;
  packagingStartDate: string | null;
  packagingStatus: string | null;
  packagingEndDate: string | null;
  packagingRemarks: string | null;
  packQaStatus: string | null;
  packQcStatus: string | null;
  packRemarks: string | null;
  dispatchDate: string | null;
  dispatchedQty: number | null;
  shipperQty: number | null;
  totalShipperWeight: number | null;
  transportType: string | null;
  remainingQty: number | null;
  customerConfirmation: string | null;
  anyRemarks: string | null;
  purchaseOrderItem: {
    id: string;
    productName: string;
    quantity: number;
    unit: string;
    purchaseOrder: { id: string; poNumber: string | null; customer: { id: string; companyName: string } };
  };
  stageEvents: BatchStageEvent[];
  delay: BatchDelay;
  wastage: BatchWastage;
  // Which physical Plant this batch runs at — set by PPIC, usually at
  // creation. Needed before Dispensing can log real consumptions below.
  plantId: string | null;
  plant: { id: string; name: string } | null;
  // Real RM/PM consumption logged at Dispensing — reduces the Plant's
  // real-time balance (see stock.ts getOnHandByPlantAndItem on the API
  // side). Never edited/deleted, same as InventoryTransaction.
  consumptions: {
    id: string;
    itemId: string;
    quantity: number;
    unit: string;
    createdAt: string;
    item: InventoryItem;
    createdBy: { fullName: string; email: string };
  }[];
}

// --- Packaging BOM module ---

export interface CatalogBrand {
  id: string;
  name: string;
  skuCount: number;
}

export interface CatalogSku {
  id: string;
  brandId: string;
  brandName: string;
  productName: string;
}

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
  brandName: string;
  productName: string;
  targetYield: number;
}

export interface LinkedOrder {
  productName: string;
  poNumber: string | null;
  purchaseOrderId: string;
}

export interface BomPlan {
  id: string;
  name: string;
  dateFrom: string | null;
  dateTo: string | null;
  status: "DRAFT" | "CALCULATED";
  calculatedAt: string | null;
  createdAt: string;
  result: BomResult | null;
  items: BomPlanItem[];
  purchaseOrderItemId: string | null;
  linkedOrder: LinkedOrder | null;
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
  result: RmResult | null;
  items: RmPlanItem[];
  purchaseOrderItemId: string | null;
  linkedOrder: LinkedOrder | null;
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
export type InventoryTxnType = "RECEIVED" | "ISSUED_DAY_STORE" | "ISSUED_PRODUCTION";
export type DispatchTransferType = "FG" | "BILL";
// Inward QC gate — RECEIVED rows only; null for ISSUED_* rows.
export type InventoryReceiptStatus = "PENDING_QC" | "QC_APPROVED" | "QC_REJECTED" | "ACCEPTED";
// Outward QC gate — FG dispatch transfers only; null for BILL rows.
export type DispatchQcStatus = "PENDING_QC" | "QC_APPROVED" | "QC_REJECTED";

export interface InventoryItem {
  id: string;
  category: InventoryCategory;
  name: string;
  unit: string | null;
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
}

export interface InventoryStockLine {
  item: InventoryItem;
  receivedQty: number;
  // Sum of every partial QC rejection against this item — already
  // excluded from receivedQty, shown separately for visibility.
  rejectedQty: number;
  issuedDayStoreQty: number;
  issuedProductionQty: number;
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
export type InventoryRequestPurpose = Exclude<InventoryTxnType, "RECEIVED">;

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

export const ALL_ROLES: RoleName[] = ["ADMIN", "BD", "PPIC", "STORE", "PURCHASE", "ACCOUNTS", "PRODUCTION", "QA_QC", "DISPATCH"];
