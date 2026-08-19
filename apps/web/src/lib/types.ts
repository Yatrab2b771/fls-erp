export type RoleName = "ADMIN" | "BD" | "PPIC" | "STORE" | "PURCHASE" | "ACCOUNTS" | "PRODUCTION" | "QA_QC" | "DISPATCH";

export interface CurrentUser {
  id: string;
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
  mfgQaStatus: string | null;
  mfgQcStatus: string | null;
  mfgRemarks: string | null;
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

export type InventoryCategory = "RM" | "PM";
export type InventoryTxnType = "RECEIVED" | "ISSUED_DAY_STORE" | "ISSUED_PRODUCTION";
export type DispatchTransferType = "FG" | "BILL";

export interface InventoryItem {
  id: string;
  category: InventoryCategory;
  name: string;
  unit: string | null;
  createdAt: string;
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
  createdBy: { id: string; fullName: string };
}

export interface InventoryStockLine {
  item: InventoryItem;
  receivedQty: number;
  issuedDayStoreQty: number;
  issuedProductionQty: number;
  issuedQty: number;
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
  createdBy: { id: string; fullName: string };
}

// --- User management (admin only) ---

export interface ManagedUser {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  createdAt: string;
  roles: RoleName[];
}

export const ALL_ROLES: RoleName[] = ["ADMIN", "BD", "PPIC", "STORE", "PURCHASE", "ACCOUNTS", "PRODUCTION", "QA_QC", "DISPATCH"];
