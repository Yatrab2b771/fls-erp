import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Wallet,
  FileText,
  AlarmClock,
  ArrowDownToLine,
  ArrowLeftRight,
  Ban,
  Beaker,
  Boxes,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  FlaskConical,
  HandHelping,
  Factory,
  Users,
  Hash,
  Layers,
  Package,
  PackageCheck,
  PackagePlus,
  PackageMinus,
  PauseCircle,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  ShoppingCart,
  Truck,
  BellRing,
  Warehouse,
  RotateCcw,
  Recycle,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { useCustomerReturnSummary } from "../lib/customerReturnHooks";
import { useRecycleSummary } from "../lib/hooks";
import {
  useAllProductionBatches,
  useCombinedLots,
  useInventoryRequests,
  useInventoryTransactions,
  useMaterialConsumptionReport,
  usePreProductions,
  usePurchaseOrders,
  usePpicSummary,
  useIncomingSummary,
  useAvailableStockSummary,
  useStockReceivedSummary,
  useStockIssuedSummary,
  useMyStoreInfo,
  usePlansBoard,
  useMaterialBoard,
  usePrepSummary,
  usePackagingBoard,
  usePlantStockBoard,
  useHandoverBoard,
  useNewMaterial,
  useReceivedMaterial,
  useRndReturns,
  useRndUtilization,
  useRndQuarantine,
  useMyStoreSummary,
  useMaterialRequestsSummary,
  useRecentOrders,
  usePreInventoryRequirements,
  
  useRecipeRequests,
  useRndSampleRequests,
  useRndStoreTransactions,
  useRndTransfers,
  useStoreDashboardSummary,
} from "../lib/hooks";
import { useQcStageCounts } from "../lib/qcBoardHooks";
import { useBomBoard } from "../lib/bomBoardHooks";
import { useBomPlanningSummary, useInProductionBom } from "../lib/bomSwitchHooks";
import { useSampleRequests } from "../lib/sampleRequestHooks";
import { useExtraRequests } from "../lib/extraHooks";
import { useAccountsQueue, useFgDispatchBoard, useFgStockRequests, useFgStoreBoard, useFgWarehouseRequests } from "../lib/fgHooks";
import { PRE_PRODUCTION_STAGE_ROLE } from "../lib/preProductionStage";
import { COMBINED_LOT_STAGE_ROLE } from "../lib/combinedLotStage";
import { getActiveProductionRows, getCompletedPos, isItemDispatched, isPoDelayed } from "../lib/bdPlanning";
import { getPendingPos, toItemRows } from "../lib/ppicPlanning";
import { getPurchasePlanningRows } from "../lib/purchasePlanning";
import { getRegulatoryPlanningRows } from "../lib/regulatoryPlanning";
import { useAlertSummary } from "./AlertsPage";
import { useFinanceRows } from "../lib/financeHooks";
import { StatTile, type StatAccent } from "../components/StatTile";
import { useLeadSummary } from "../lib/leadHooks";
import { useItemChangeRequests } from "../lib/itemChangeHooks";
import { useHeldProducts } from "../lib/heldProductHooks";
import { isBatchStage, isNewPlan } from "../lib/plansBoardExport";
import { DelayBadge, RequestStatusBadge, StageBadge } from "../components/Badges";
import type { PreProduction } from "../lib/types";
import { CustomerName } from "../components/CustomerName";

// A PreProduction run counts as "still pending" for queue/count purposes
// until it's actually cleared its own terminal gate (Sample QC Approval
// completes in place, so currentStageId alone can't tell "waiting" from
// "done" the way every earlier stage can).
function isPreProductionPending(r: PreProduction) {
  return !(r.currentStageId === "SAMPLE_QC_APPROVAL" && r.sampleQcStatus === "Approved");
}

export function DashboardPage() {
  const { hasRole } = useAuth();
  // The real Admin login (not "viewing as" a department): its dashboard reads every department's counts.
  const isAdminView = hasRole("ADMIN");
  const { data: alertSummary } = useAlertSummary({ enabled: isAdminView });
  // PPIC's own tiles come from one server summary; the full PO list (and the
  // full stock ledger) is only loaded by the dashboards that still derive their
  // numbers from it.
  const ppicOnlyEarly = hasRole("PPIC") && !hasRole("ADMIN", "BD");
  const { data: orders } = usePurchaseOrders({ enabled: !ppicOnlyEarly });
  const { data: ppicSummary } = usePpicSummary({ enabled: ppicOnlyEarly || hasRole("ADMIN") });
  // A Day Store login (Store user limited to specific stores) gets its own store-wise dashboard and none of
  // the Warehouse-side tiles; the Warehouse seat (no store assignment) keeps the full one.
  const { data: myStore } = useMyStoreInfo({ enabled: hasRole("STORE") });
  const isDayStoreLogin = myStore?.scoped === true;
  const warehouseSeat = myStore !== undefined && !myStore.scoped;
  const { data: myStoreSummary } = useMyStoreSummary({ enabled: isDayStoreLogin });
  const { data: availableSummary } = useAvailableStockSummary({ enabled: (hasRole("STORE") && myStore !== undefined) || isAdminView });
  const { data: receivedSummary } = useStockReceivedSummary({ enabled: warehouseSeat });
  const { data: issuedSummary } = useStockIssuedSummary({ enabled: warehouseSeat });
  const { data: requestsSummary } = useMaterialRequestsSummary({ enabled: warehouseSeat || isAdminView });
  const { data: incomingSummary } = useIncomingSummary({ enabled: ppicOnlyEarly || hasRole("STORE") || isAdminView });
  const { data: recentPage } = useRecentOrders();
  const { data: preRuns } = usePreProductions();
  const { data: lots } = useCombinedLots();
  const { data: batches } = useAllProductionBatches();
  // PO Readiness is PPIC-gated on the API (ADMIN bypasses) — BD is
  // org-wide too but isn't PPIC, so this has to opt out for them
  // specifically rather than reusing the broader orgWide flag.

  // ADMIN, BD and PPIC run the whole order book (BD creates orders, PPIC
  // plans every run off of them) — everyone else's job is a specific
  // production stage, so their dashboard is scoped to "production
  // currently waiting on my department", not the full company view.
  // hasRole()'s ADMIN bypass still applies underneath this, but this is a
  // deliberate narrower *default view* for the other six departments.
  const orgWide = hasRole("ADMIN", "BD", "PPIC");
  // PPIC's own tile set, same "like BD" shape — readiness/planning
  // numbers instead of BD's sales-side ones, but the BOM/Recipe gap
  // tiles further below are shared (PPIC is the one who actually
  // triggers Generate).
  const isPpicOnlyView = orgWide && hasRole("PPIC") && !hasRole("ADMIN", "BD");
  // Material Usage tile — PPIC's own view above, plus Production's
  // generic queue view further below (Production has no dedicated
  // isProductionOnlyView, it just falls into the else branch alongside
  // RND/Dispatch — this is gated separately there by hasRole("PRODUCTION")
  // so RND/Dispatch, who can't read this endpoint, never see the tile).
  // Production's dashboard is just its three tiles (New Plan, Material Received, Handover), so the consumption tiles are PPIC's only.
  const canSeeMaterialUsage = isPpicOnlyView;
  const { data: materialConsumption } = useMaterialConsumptionReport(undefined, { enabled: canSeeMaterialUsage || isAdminView });
  // Split by BatchConsumptionPurpose (see MaterialConsumptionReportPage's
  // own comment) — 4 distinctly-named tiles instead of one ambiguous
  // "Material Logged" count, each counting the products that have at
  // least some quantity logged under that one purpose, each linking to
  // the same report pre-filtered to it (?purpose=...).
  const materialUsedInProductionCount = new Set((materialConsumption ?? []).filter((r) => r.consumedQty > 0).map((r) => r.preProductionId)).size;
  const materialSentForTestingCount = new Set((materialConsumption ?? []).filter((r) => r.sampleQty > 0).map((r) => r.preProductionId)).size;
  const materialWastedCount = new Set((materialConsumption ?? []).filter((r) => r.wastedQty > 0).map((r) => r.preProductionId)).size;
  const materialRejectedCount = new Set((materialConsumption ?? []).filter((r) => r.rejectedQty > 0).map((r) => r.preProductionId)).size;

  const allPreRuns = preRuns ?? [];
  const allLots = lots ?? [];
  const allBatches = batches ?? [];

  // Production actionable by this department right now, sitting at a
  // stage this role owns. DISPATCH_PLAN is terminal (nothing comes after
  // it), and a PreProduction run that's already Approved has nothing
  // left for this tier either — both excluded from every department's
  // queue once reached. myQueueBatches mirrors myQueueLots exactly, just
  // for a batch's own independent pipeline (see schema.prisma's comment
  // on ProductionBatch) — same stage enum, same role map.
  // Material Received & GRN and Dispensing are the Day Store's (of the run's Plant): not in the Warehouse seat's queue.
  const dayStoreStage = (stage: string) => stage === "MATERIAL_RECEIVED" || stage === "DISPENSING";
  const myQueuePreRuns = allPreRuns.filter((r) => isPreProductionPending(r) && hasRole(...PRE_PRODUCTION_STAGE_ROLE[r.currentStageId]) && !(warehouseSeat && dayStoreStage(r.currentStageId)));
  const myQueueLots = allLots.filter((l) => l.currentStageId !== "DISPATCH_PLAN" && hasRole(...COMBINED_LOT_STAGE_ROLE[l.currentStageId]));
  const myQueueBatches = allBatches.filter((b) => b.currentStageId !== "DISPATCH_PLAN" && hasRole(...COMBINED_LOT_STAGE_ROLE[b.currentStageId]));

  // QC gets its own full-breakdown view below (isQcOnlyView) instead of
  // the generic "Your Queue" list — see useQcDashboard just below, which
  // covers everything Inventory's inward/outward QC checks would have
  // fed into this queue anyway.
  const isQcOnlyView = !orgWide && hasRole("QA_QC");
  const { data: qcCounts } = useQcStageCounts({ enabled: isQcOnlyView || isAdminView });
  // Purchase gets its own Pre-Inventory tile set — same shape as PPIC's,
  // same shared-filter/drill-down/Excel-export pattern (see
  // purchasePlanning.ts and PurchasePlanningDetailPage). PPIC also reads
  // this (just the "PO Logged" count, not the full tile set) so they can
  // see the moment Purchase has logged a PO + ETA against their own
  // requirement, without switching to the Purchase role — that's the
  // signal PPIC needs before planning the next step. Store reads it too —
  // they're the ones physically receiving the delivery, so the same ETA
  // signal tells them when to expect it.
  const isPurchaseOnlyView = !orgWide && hasRole("PURCHASE");
  const isStoreOnlyViewEarly = !orgWide && hasRole("STORE");
  const { data: purchaseRequirements } = usePreInventoryRequirements(undefined, { enabled: isPurchaseOnlyView || isStoreOnlyViewEarly || isAdminView });
  const purchaseStats = {
    total: purchaseRequirements?.length ?? 0,
    covered: getPurchasePlanningRows("covered", purchaseRequirements ?? []).length,
    shortfall: getPurchasePlanningRows("shortfall", purchaseRequirements ?? []).length,
    ordered: getPurchasePlanningRows("ordered", purchaseRequirements ?? []).length,
  };
  // Regulatory gets its own queue too — same shared-filter/drill-down/
  // Excel-export pattern, reading off the same `orders` fetch every role
  // already loads (no extra request needed).
  const isRegulatoryOnlyView = !orgWide && hasRole("REGULATORY");
  const regulatoryStats = {
    pendingReview: getRegulatoryPlanningRows("pending-review", orders ?? []).length,
    approved: getRegulatoryPlanningRows("approved", orders ?? []).length,
    notApproved: getRegulatoryPlanningRows("not-approved", orders ?? []).length,
  };
  // Inventory has its own queue of department-owned work that isn't a
  // pipeline stage at all — Store's request review / issue / accept
  // steps, and (for R&D) the inward QC check it shares with QA/QC.
  const canReviewInventory = !orgWide && hasRole("STORE");
  // Store's own tile set — RM/PM/each Day Store/FG/Quarantine, all item
  // counts (not quantity sums, which would mix incompatible units — see
  // dashboard-summary's own comment), each tile linking straight to its
  // drill-down list on StorePlanningDetailPage (list first, download
  // option there — same click-through-then-download shape as every
  // other department's planning tiles, not an inline download).
  const isStoreOnlyView = canReviewInventory;
  const { data: storeSummary } = useStoreDashboardSummary({ enabled: isStoreOnlyView || isAdminView });
  // Rejected material waiting in the Recycle Store for QA's decision
  const { data: recycleSummary } = useRecycleSummary({ enabled: isAdminView || (!orgWide && hasRole("QA_QC")) });
  // Customer returns: each department's own count (Warehouse: in progress, QA: waiting, Production: rework, Dispatch: to decide, Accounts: no credit note)
  const { data: crSummary } = useCustomerReturnSummary({ enabled: isAdminView || (!orgWide && hasRole("STORE", "QA_QC", "PRODUCTION", "DISPATCH", "ACCOUNTS")) });
  const canRnd = !orgWide && hasRole("RND");
  const canProduction = !orgWide && hasRole("PRODUCTION");
  const { data: plansBoard } = usePlansBoard({ enabled: canProduction });
  // Every plan still under process (not started, preparing, ready for batches, or batches running) - not only the unstarted ones
  const underProcessPlans = (plansBoard ?? []).filter(isNewPlan).length;
  const batchPlans = (plansBoard ?? []).filter(isBatchStage).length;
  const { data: materialBoard } = useMaterialBoard({ enabled: canProduction });
  // Production's extra material (outside any plan) that is still open.
  const { data: extraRequests } = useExtraRequests({ enabled: canProduction });
  const extraOpen = (extraRequests ?? []).filter((r) => r.open).length;
  // Products whose material has not all arrived yet
  const canDispatchTile = !orgWide && hasRole("DISPATCH");
  // R&D: material the Warehouse received that is still waiting on a decision (Pending, Testing or Hold)
  const { data: newMaterial } = useNewMaterial({ enabled: canRnd });
  // R&D tiles show the number of rows in their list; the title says how many of them are waiting on R&D
  const { data: receivedMaterial } = useReceivedMaterial({ enabled: canRnd });
  // R&D Quarantine: everything not usable stock (total), and how many of those wait on R&D (not approved yet, or expired)
  const { data: rndQuarantine } = useRndQuarantine({ enabled: canRnd });
  const quarantineTotal = rndQuarantine?.length ?? 0;
  const quarantineWaiting = (rndQuarantine ?? []).filter((q) => q.reason !== "REJECTED").length;
  // Materials in the R&D Store utilization list (total), and how many still have stock
  const { data: rndUtilization } = useRndUtilization({ enabled: canRnd });
  const utilizationTotal = rndUtilization?.length ?? 0;
  const utilizationInStock = (rndUtilization ?? []).filter((u) => u.stockQty > 0).length;
  // Returns R&D has sent back to the Warehouse (total), and how many the Warehouse has not confirmed yet
  const { data: rndReturns } = useRndReturns({ enabled: canRnd });
  const returnsTotal = rndReturns?.length ?? 0;
  const returnsWaiting = (rndReturns ?? []).filter((r) => r.status === "SENT").length;
  const receivedMaterialTotal = receivedMaterial?.length ?? 0;
  const toReceive = (receivedMaterial ?? []).filter((r) => r.status === "ISSUED").length;
  const newMaterialTotal = newMaterial?.length ?? 0;
  const newMaterialOpen = (newMaterial ?? []).filter((m) => m.status === "PENDING_QC" || m.status === "TESTING" || m.status === "ON_HOLD").length;
  // Products that have batches to report on
  const reportProducts = (plansBoard ?? []).filter((r) => r.batches.length > 0).length;
  const { data: handoverBoard } = useHandoverBoard({ enabled: canProduction });
  // Finished goods after Packaging: the Day Store receives and hands over, QA approves, Dispatch ships, the Warehouse takes what Dispatch sends.
  const { data: fgToReceive } = useFgStoreBoard("FG_STORE", { enabled: isDayStoreLogin });
  const { data: fgToHandOver } = useFgStoreBoard("FG_HANDOVER", { enabled: isDayStoreLogin });
  const { data: fgDispatch } = useFgDispatchBoard({ enabled: canDispatchTile });
  const isWarehouseSeat = hasRole("STORE") && myStore !== undefined && myStore.scoped === false;
  const { data: fgRequests } = useFgWarehouseRequests({ enabled: isWarehouseSeat || isAdminView });
  const fgDayStoreOpen = (fgToReceive?.length ?? 0) + (fgToHandOver?.length ?? 0);
  // Dispatch asking the Warehouse for stock to send to a customer (the Warehouse sends it, Dispatch confirms): open until it is with Dispatch
  const { data: fgStockRequests } = useFgStockRequests({ enabled: isWarehouseSeat || canDispatchTile || isAdminView });
  // Customer shipments Dispatch has prepared: with Accounts for the invoice, ready to send, or sent back to Dispatch
  const canAccountsTile = !orgWide && hasRole("ACCOUNTS");
  const { data: accountsQueue } = useAccountsQueue({ enabled: canAccountsTile || canDispatchTile || isAdminView });
  // Finance: the short RM / PM Purchase has logged a vendor, PO number and ETA for, and what Finance decided on each
  const { data: financeRows } = useFinanceRows({ enabled: canAccountsTile || isPurchaseOnlyView || isAdminView });
  const financePaid = (financeRows ?? []).filter((r) => r.status === "PAID_FULL" || r.status === "PAID_PARTIAL").length; // what Finance has paid (part or full): Purchase's view
  const financeCount = (status: string) => (financeRows ?? []).filter((r) => r.status === status).length;
  const financePending = financeCount("PENDING");
  // The per-batch preparation: how many batches wait at each step (Indent Issue, Batch No, Dispensing, Line Clearance), and at Packaging.
  const { data: prep } = usePrepSummary({ enabled: canProduction || hasRole("RND", "STORE", "QA_QC") || isAdminView });
  const { data: heldProducts } = useHeldProducts({ enabled: canProduction || hasRole("PPIC") || isAdminView });
  const heldProductCount = heldProducts?.length ?? 0;
  // Batches Production still has to decide on (PPIC put the product on hold, the batch is in preparation and not held yet)
  const heldToDecide = (heldProducts ?? []).reduce((n, p) => n + p.batches.filter((b) => b.canHold).length, 0);
  const { data: packagingBoard } = usePackagingBoard({ enabled: canProduction || isAdminView });
  const { data: plantStock } = usePlantStockBoard({ enabled: canProduction || isAdminView });
  const plantStockItems = plantStock?.rows.length ?? 0;
  const plantLeftover = (plantStock?.rows ?? []).filter((r) => r.pendingReturn > 0).length;
  const packagingOpen = (packagingBoard ?? []).filter((b) => String(b.packagingStatus ?? "").trim().toLowerCase() !== "completed").length;
  const financeOpen = (financeRows ?? []).filter((r) => r.status !== "PAID_FULL").length; // everything not paid in full: the list filters it by status
  const withAccountsCount = (accountsQueue ?? []).filter((r) => r.status === "WITH_ACCOUNTS").length;
  const readyToSendCount = (accountsQueue ?? []).filter((r) => r.status === "READY_TO_SEND").length;
  const sentBackCount = (accountsQueue ?? []).filter((r) => r.status === "SENT_BACK").length;
  const fgStockRequestsOpen = (fgStockRequests ?? []).filter((r) => r.status === "REQUESTED" || r.status === "SENT").length;
  const fgRequestsOpen = (fgRequests ?? []).filter((r) => r.status === "REQUESTED" || r.status === "SENT").length;
  // Production: batches whose packaging is done and waiting to be handed over. Dispatch: batches Production has handed over.
  const handoverReady = (handoverBoard ?? []).filter((b) => !b.handedOverAt && b.currentStageId === "PACKAGING" && String(b.packagingStatus ?? "").toLowerCase().trim() === "completed").length;
  const materialsPending = new Set((materialBoard ?? []).filter((m) => m.status !== "FULL").map((m) => m.itemId)).size;
  // PPIC also reads this (just the count, same as RND) so they can see
  // whether the RM/PM they asked Purchase for has actually arrived at
  // Warehouse yet — same /inward-qc page both link to, RND with the
  // Approve/Reject/Hold actions, PPIC read-only.
  const { data: pendingReceiptQc } = useInventoryTransactions({ type: "RECEIVED", receiptStatus: "PENDING_QC" }, { enabled: canRnd || isAdminView });
  const { data: pendingMaterialRequests } = useInventoryRequests("PENDING", { enabled: canReviewInventory });
  const { data: approvedMaterialRequests } = useInventoryRequests("APPROVED", { enabled: canReviewInventory });
  const { data: qcApprovedReceipts } = useInventoryTransactions({ type: "RECEIVED", receiptStatus: "QC_APPROVED" }, { enabled: canReviewInventory });

  // R&D's own non-pipeline queue — a catalog gap PPIC is waiting on, a
  // sample Store sent that still needs confirming, and R&D's own sample
  // request still waiting on Store to fulfill. Mirrors the Inventory
  // block above: real department work that isn't a production-pipeline
  // stage at all.
  const { data: rndCatalogGaps } = useRecipeRequests({ enabled: canRnd });
  const { data: rndPendingTransfers } = useRndTransfers("PENDING", { enabled: canRnd });
  const { data: rndPendingSampleRequests } = useRndSampleRequests("PENDING", { enabled: canRnd });
  // Direct Purchase / Dispatch-to-Customer counts for their own dashboard
  // tiles — same RndStoreTransaction rows RndStorePage already lists,
  // just filtered by isDirectPurchase / type here.
  const { data: rndTransactions } = useRndStoreTransactions({ enabled: canRnd });

  interface QueueRow {
    key: string;
    to: string;
    title: string;
    subtitle: string;
    badge: ReactNode;
  }

  const preRunRows: QueueRow[] = myQueuePreRuns.map((r) => ({
    key: `pre-${r.id}`,
    to: `/pre-productions/${r.id}`,
    title: r.purchaseOrderItem.productName,
    subtitle: r.purchaseOrderItem.purchaseOrder.customer.companyName,
    badge: <StageBadge stage={r.currentStageId} />,
  }));
  const lotRows: QueueRow[] = myQueueLots.map((l) => ({
    key: `lot-${l.id}`,
    to: `/combined-lots/${l.id}`,
    title: l.preProduction.purchaseOrderItem.productName,
    subtitle: l.preProduction.purchaseOrderItem.purchaseOrder.customer.companyName,
    badge: <StageBadge stage={l.currentStageId} />,
  }));
  const batchRows: QueueRow[] = myQueueBatches.map((b) => ({
    key: `batch-${b.id}`,
    to: `/production-batches/${b.id}`,
    title: b.preProduction.purchaseOrderItem.productName,
    subtitle: `${b.preProduction.purchaseOrderItem.purchaseOrder.customer.companyName}${b.batchNo ? ` · ${b.batchNo}` : ""}`,
    badge: <StageBadge stage={b.currentStageId} />,
  }));

  const pendingQcPill = <span className="pill border-amber-200 bg-amber-50 text-amber-700">Pending QC</span>;
  const inventoryRows: QueueRow[] = [
    ...(pendingReceiptQc ?? []).map((t) => ({ key: `rqc-${t.id}`, to: "/new-material", title: t.item.name, subtitle: `New material · ${t.quantity} ${t.unit}`, badge: pendingQcPill })),
    ...(pendingMaterialRequests ?? []).map((r) => ({ key: `req-${r.id}`, to: "/inventory", title: r.item.name, subtitle: `Review request · ${r.requestedQty}`, badge: <RequestStatusBadge status={r.status} /> })),
    ...(approvedMaterialRequests ?? []).map((r) => ({ key: `iss-${r.id}`, to: "/inventory", title: r.item.name, subtitle: `Issue stock · ${r.requestedQty}`, badge: <RequestStatusBadge status={r.status} /> })),
    ...(qcApprovedReceipts ?? []).map((t) => ({ key: `acc-${t.id}`, to: "/inventory", title: t.item.name, subtitle: `Accept into stock · ${t.quantity} ${t.unit}`, badge: <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">QC Approved</span> })),
  ];

  const rndPill = <span className="pill border-violet-200 bg-violet-50 text-violet-700">R&D</span>;
  const rndOpenCatalogGaps = (rndCatalogGaps ?? []).filter((r) => r.status !== "READY");
  // Committed to a date (etaDate set) and that date has already passed,
  // still not READY — the "Delayed" equivalent for R&D Requests, since
  // the org-wide delay logic above is scoped to production dates only
  // and never sees this queue at all.
  const { data: bomBoard } = useBomBoard({ enabled: canRnd || hasRole("ADMIN") });
  const { data: sampleRequests } = useSampleRequests({ enabled: canRnd || isAdminView || hasRole("BD") });
  const sampleOpen = (sampleRequests ?? []).filter((r) => r.status !== "DISPATCHED").length;
  const { data: rndPlanning } = useBomPlanningSummary(canRnd || hasRole("ADMIN"));
  const { data: rndInProduction } = useInProductionBom(canRnd || hasRole("ADMIN"));
  const bomNeedWork = (bomBoard ?? []).filter((r) => r.needsWork).length;
  const bomReady = (bomBoard?.length ?? 0) - bomNeedWork;
  const rndAwaitingConfirmation = (rndPendingTransfers ?? []).filter((t) => t.direction === "TO_RND");
  const rndDispatchCount = (rndTransactions ?? []).filter((t) => t.type === "DISPATCHED").length;
  // RND's only CombinedLot/ProductionBatch-stage ownership is Bulk QC
  // (see COMBINED_LOT_STAGE_ROLE) — so for a non-org-wide RND session,
  // lotRows + batchRows are already exactly this queue, nothing further
  // to filter.
  const rndBulkQcCount = lotRows.length + batchRows.length;
  const rndRows: QueueRow[] = [
    ...rndOpenCatalogGaps.map((r) => ({
      key: `rr-${r.id}`,
      to: "/rnd",
      title: r.productName,
      subtitle: `${r.customerName ?? "Unknown customer"} · ${r.status === "PENDING" ? "Needs an ETA" : "In progress"}`,
      badge: rndPill,
    })),
    ...rndAwaitingConfirmation.map((t) => ({ key: `rt-${t.id}`, to: "/rnd-store", title: t.itemName, subtitle: `Confirm receipt · ${t.quantity} ${t.unit}`, badge: rndPill })),
    ...(rndPendingSampleRequests ?? []).map((r) => ({ key: `rsr-${r.id}`, to: "/rnd-store", title: r.itemName, subtitle: `Awaiting Store · ${r.quantity} ${r.unit}`, badge: rndPill })),
  ];

  const myQueueRows = [...preRunRows, ...lotRows, ...batchRows, ...inventoryRows, ...rndRows];

  const totalProducts = orders?.reduce((sum, po) => sum + po.items.filter((i) => !i.cancelledAt).length, 0) ?? 0;
  // "Active" = a run still short of its own terminal gate, a lot not yet
  // at Dispatch Plan, or a completed batch still in its own pipeline —
  // same completion definition purchase-orders.routes.ts's
  // computeCompletion uses (either path counts).

  // BD gets its own tile set instead of the generic org-wide one — same
  // "pending" definition as the old Pending PO Aging report (not
  // REJECTED, not yet completed). Every count below is derived from the
  // same pendingItems array, so they reconcile by construction: Have
  // Packaging BOM + Have RM BOM + Missing Both always foot back to
  // Products (Pending). getPendingPos/hasCalculatedBom/hasCalculatedRm
  // come from ppicPlanning.ts — the same filters PpicPlanningDetailPage
  // uses for each tile's own drill-down list, so a tile's number and its
  // "click to see the list" page can never disagree.
  const isBdOnlyView = orgWide && hasRole("BD") && !hasRole("ADMIN", "PPIC");
  const pendingOrders = getPendingPos(orders ?? []);
  // BD's own tile set — completedOrders/delayedPendingOrders/
  // completedItems/activeProductionRows come from bdPlanning.ts, the
  // same filters BdPlanningDetailPage uses for each tile's own
  // drill-down list. Delayed = a Pending PO whose own promised Expected
  // Delivery Date has already passed (customer-facing miss), not the
  // internal production/dispatch-plan-date delay "Needs Attention"
  // already tracks.
  const completedOrders = getCompletedPos(orders ?? []);
  const delayedPendingOrders = pendingOrders.filter(isPoDelayed);
  const completedItems = toItemRows((orders ?? []).filter((po) => po.status !== "REJECTED")).filter((r) => isItemDispatched(r.item));
  const activeProductionRows = getActiveProductionRows(orders ?? []);
  // PPIC's own hand-off checkpoint — item.planSentToProductionAt is set
  // the moment PPIC clicks "Send Plan to Production" (see
  // purchase-orders.routes.ts's own comment on that route), independent
  // of whether Production has actually opened a run against it yet.
  // Answers "how many products' plans have actually reached Production"
  // directly, instead of the old Active-in-Production tile, which
  // counted physical runs/lots/batches (including ones created before
  // this gate existed) and so never reconciled with the BOM/RM numbers.

  const orgDelayed: { id: string; to: string; title: string; subtitle: string; delay: { isDelayed: boolean; against: "dispatchPlanDate" | "productionPlanDate" | null; daysLate: number | null } }[] = [
    ...allPreRuns.filter((r) => r.delay.isDelayed).map((r) => ({ id: r.id, to: `/pre-productions/${r.id}`, title: r.purchaseOrderItem.productName, subtitle: r.purchaseOrderItem.purchaseOrder.customer.companyName, delay: r.delay })),
    ...allLots
      .filter((l) => l.delay.isDelayed)
      .map((l) => ({ id: l.id, to: `/combined-lots/${l.id}`, title: l.preProduction.purchaseOrderItem.productName, subtitle: l.preProduction.purchaseOrderItem.purchaseOrder.customer.companyName, delay: l.delay })),
  ];
  // Everything on the Delayed page: orders past delivery, runs / lots / batches behind their plan dates, purchases past their ETA.
  const delayedAll =
    delayedPendingOrders.length +
    allPreRuns.filter((r) => r.delay.isDelayed).length +
    allLots.filter((l) => l.delay.isDelayed).length +
    allBatches.filter((b) => (b as { delay?: { isDelayed: boolean } }).delay?.isDelayed).length +
    (incomingSummary?.overdue ?? 0);
  const myDelayed = orgDelayed.filter((d) => myQueueRows.some((r) => r.to === d.to));

  const recentOrders = recentPage ?? [];
  const attentionRows = orgWide ? orgDelayed : myDelayed;

  const { data: leadSummary } = useLeadSummary({ enabled: hasRole("BD") });
  const { data: bdPendingRequests } = useItemChangeRequests("PENDING", { enabled: hasRole("BD") });
  const bdTiles = (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Link to="/leads/follow-ups" className="block" title="Leads whose next follow-up is today or earlier">
        <StatTile icon={AlarmClock} label="Follow up today" value={leadSummary?.followUpToday ?? 0} accent={leadSummary?.overdue ? "rose" : leadSummary?.followUpToday ? "amber" : "slate"} />
      </Link>
      <Link to="/leads" className="block" title="Leads that are Converted and wait for their PO: enter the PO from the lead">
        <StatTile icon={ShoppingCart} label="Waiting for PO" value={leadSummary?.waitingForPo ?? 0} accent={leadSummary?.waitingForPo ? "amber" : "slate"} />
      </Link>
      <Link to="/sample-requests" className="block" title="Samples you asked R&D for. The number is how many are not handed over yet.">
        <StatTile icon={Beaker} label="Sample Request" value={(sampleRequests ?? []).filter((r) => r.status !== "DISPATCHED" && r.status !== "CANNOT_MAKE").length} accent="violet" />
      </Link>
      <Link to="/leads" className="block" title="Every lead you are working on, with its status and next follow-up">
        <StatTile icon={Users} label="Leads" value={leadSummary?.total ?? 0} accent="brand" />
      </Link>
      <Link to="/bd-requests" className="block" title="Ask PPIC to hold or cancel a product, and see what it decided. The number is how many wait for PPIC.">
        <StatTile icon={PauseCircle} label="Hold / Cancel Requests" value={bdPendingRequests?.length ?? 0} accent={bdPendingRequests?.length ? "amber" : "slate"} />
      </Link>
      <Link to="/bd-planning/total-pos" className="block">
        <StatTile icon={ShoppingCart} label="Total POs" value={`${completedOrders.length}/${orders?.length ?? 0}`} accent="rose" />
      </Link>
      <Link to="/bd-planning/completed-pos" className="block">
        <StatTile icon={CheckCircle2} label="Completed POs" value={completedOrders.length} accent="emerald" />
      </Link>
      <Link to="/bd-planning/delayed-pos" className="block">
        <StatTile icon={AlarmClock} label="Pending POs — Delayed" value={delayedPendingOrders.length} accent={delayedPendingOrders.length ? "rose" : "slate"} />
      </Link>
      <Link to="/bd-planning/total-products" className="block">
        <StatTile icon={Beaker} label="Total Products" value={`${completedItems.length}/${totalProducts}`} accent="brand" />
      </Link>
      <Link to="/bd-planning/completed-products" className="block">
        <StatTile icon={Beaker} label="Completed Products" value={completedItems.length} accent="emerald" />
      </Link>
      <Link to="/bd-planning/active-products" className="block">
        <StatTile icon={Truck} label="Active Products in Production" value={activeProductionRows.length} accent="blue" />
      </Link>
    </div>
  );
  const ppicTiles = (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Link to="/ppic-planning/not-planned-pos" className="block">
        <StatTile icon={ShoppingCart} label="Not Planned" value={ppicSummary?.notPlannedProducts ?? 0} accent={ppicSummary?.notPlannedProducts ? "rose" : "slate"} />
      </Link>
      <Link to="/ppic-planning/material-planning" className="block" title="Materials of every planned product — covered vs short, stock shared out first-come-first-served">
        <StatTile icon={Layers} label="Material Planning" value={ppicSummary?.materialPlanning ?? 0} accent={ppicSummary?.materialShortProducts ? "rose" : "emerald"} />
      </Link>
      <Link to="/ppic-planning/po-readiness" className="block" title="Products whose raw and packaging material is all covered by stock">
        <StatTile icon={CheckCircle2} label="PO Readiness" value={ppicSummary?.poReadiness ?? 0} accent={ppicSummary?.poReadiness ? "emerald" : "slate"} />
      </Link>
      <Link to="/ppic-planning/plan-sent" className="block" title="Products whose plan has been sent to Production">
        <StatTile icon={Truck} label="In Production" value={ppicSummary?.inProduction ?? 0} accent="blue" />
      </Link>
      <Link to="/ppic-planning/on-hold" className="block" title="Products PPIC has put on Hold - release or cancel them from here">
        <StatTile icon={PauseCircle} label="Hold" value={ppicSummary?.onHold ?? 0} accent={ppicSummary?.onHold ? "amber" : "slate"} />
      </Link>
      <Link to="/ppic-planning/cancelled" className="block" title="Products PPIC has cancelled for good, with the reason">
        <StatTile icon={Ban} label="Cancelled" value={ppicSummary?.cancelled ?? 0} accent={ppicSummary?.cancelled ? "rose" : "slate"} />
      </Link>
      <Link to="/bd-requests" className="block" title="BD asks you to put a product on hold or cancel it - accept or reject">
        <StatTile icon={AlarmClock} label="BD Requests" value={ppicSummary?.bdRequests ?? 0} accent={ppicSummary?.bdRequests ? "amber" : "slate"} />
      </Link>
      <Link to="/held-products" className="block" title="Production holds the batches of a held product that are still in preparation: see which it held and which still move">
        <StatTile icon={PauseCircle} label="Held Products (Batches)" value={heldProductCount} accent={heldToDecide ? "amber" : heldProductCount ? "violet" : "slate"} />
      </Link>
      <Link to="/inward-qc" className="block" title="Material received at Warehouse, awaiting R&D's Inward QC — track whether what you asked Purchase for has actually arrived">
        <StatTile icon={ClipboardCheck} label="QA Awaited" value={ppicSummary?.qaAwaited ?? 0} accent="emerald" />
      </Link>
      <Link to="/incoming-material" className="block" title="Material Purchase has put on order (PI lines) that has not arrived yet, by ETA">
        <StatTile icon={Truck} label="ETA" value={incomingSummary?.lines ?? 0} accent={incomingSummary?.overdue ? "rose" : "amber"} />
      </Link>
      <Link to="/ppic-planning/total-pos" className="block" title="Completed purchase orders out of every purchase order PPIC can see">
        <StatTile icon={ShoppingCart} label="Total POs" value={`${ppicSummary?.completedPos ?? 0}/${ppicSummary?.totalPos ?? 0}`} accent="brand" />
      </Link>
      <Link to="/ppic-planning/total-products" className="block" title="Completed products out of every live product across those purchase orders (cancelled ones excluded)">
        <StatTile icon={Package} label="Total Products" value={`${ppicSummary?.completedProducts ?? 0}/${ppicSummary?.totalProducts ?? 0}`} accent="brand" />
      </Link>
    </div>
  );

  return (
    <div className="grid grid-cols-1 items-start gap-5">
      {/* Main column */}
      <div className="min-w-0 space-y-5">
        {isBdOnlyView ? (
          bdTiles
        ) : isPpicOnlyView ? (
          ppicTiles
        ) : orgWide ? (
          <div className="space-y-5">
            {(
              [
                {
                  title: "Orders",
                  tiles: [
                    { to: "/bd-planning/total-pos", icon: ShoppingCart, label: "Purchase Orders", value: `${completedOrders.length}/${orders?.length ?? 0}`, accent: "rose", hint: "Completed purchase orders out of all of them" },
                    { to: "/bd-planning/total-products", icon: Beaker, label: "Products", value: `${completedItems.length}/${totalProducts}`, accent: "brand", hint: "Completed products out of all of them" },
                    { to: "/bd-planning/active-products", icon: Truck, label: "Active Production", value: activeProductionRows.length, accent: "blue", hint: "Products running in production right now" },
                    { to: "/alerts", icon: BellRing, label: "Alerts", value: alertSummary?.total ?? 0, accent: alertSummary?.late ? "rose" : alertSummary?.total ? "amber" : "emerald", hint: `Everything that needs attention: ${alertSummary?.late ?? 0} late, ${alertSummary?.blocked ?? 0} blocked, ${alertSummary?.stuck ?? 0} waiting too long, ${alertSummary?.short ?? 0} short` },
                    { to: "/delayed", icon: AlarmClock, label: "Delayed", value: delayedAll, accent: delayedAll ? "rose" : "slate", hint: "Everything running late: orders past delivery date, production behind its plan dates, purchases past their ETA" },
                  ],
                },
                {
                  title: "Planning (PPIC)",
                  tiles: [
                    { to: "/ppic-planning/not-planned-pos", icon: ShoppingCart, label: "Not Planned", value: ppicSummary?.notPlannedProducts ?? 0, accent: ppicSummary?.notPlannedProducts ? "rose" : "slate" },
                    { to: "/ppic-planning/material-planning", icon: Layers, label: "Material Short", value: ppicSummary?.materialPlanning ?? 0, accent: ppicSummary?.materialShortProducts ? "rose" : "emerald" },
                    { to: "/ppic-planning/po-readiness", icon: CheckCircle2, label: "PO Readiness", value: ppicSummary?.poReadiness ?? 0, accent: ppicSummary?.poReadiness ? "emerald" : "slate" },
                    { to: "/ppic-planning/plan-sent", icon: Truck, label: "In Production", value: ppicSummary?.inProduction ?? 0, accent: "blue" },
                    { to: "/ppic-planning/on-hold", icon: PauseCircle, label: "On Hold", value: ppicSummary?.onHold ?? 0, accent: ppicSummary?.onHold ? "amber" : "slate" },
                    { to: "/ppic-planning/cancelled", icon: Ban, label: "Cancelled", value: ppicSummary?.cancelled ?? 0, accent: ppicSummary?.cancelled ? "rose" : "slate" },
                    { to: "/bd-requests", icon: AlarmClock, label: "BD Requests", value: ppicSummary?.bdRequests ?? 0, accent: ppicSummary?.bdRequests ? "amber" : "slate" },
                  ],
                },
                {
                  title: "QA / QC",
                  tiles: [
                    { to: "/qc/ipqc", icon: Beaker, label: "IPQC", value: qcCounts?.IPQC ?? 0, accent: qcCounts?.IPQC ? "sky" : "slate" },
                    { to: "/qc/qa-gate-mfg", icon: ShieldAlert, label: "QA Gate: Manufacturing", value: qcCounts?.QA_GATE_MFG ?? 0, accent: qcCounts?.QA_GATE_MFG ? "sky" : "slate" },
                    { to: "/qc/qa-gate-packaging", icon: ShieldAlert, label: "QA Gate: Packaging", value: qcCounts?.QA_GATE_PACKAGING ?? 0, accent: qcCounts?.QA_GATE_PACKAGING ? "sky" : "slate" },
                    { to: "/qc/fg-release", icon: PackageCheck, label: "FG QC & Release", value: qcCounts?.FG_QC_RELEASE ?? 0, accent: qcCounts?.FG_QC_RELEASE ? "amber" : "slate" },
                    { to: "/qc/on-hold", icon: PauseCircle, label: "QA On Hold", value: qcCounts?.ON_HOLD ?? 0, accent: qcCounts?.ON_HOLD ? "amber" : "slate" },
                    { to: "/returned-goods", icon: ShieldCheck, label: "Returned Goods (QA)", value: crSummary?.withQa ?? 0, accent: crSummary?.withQa ? "amber" : "slate", hint: "Goods a customer sent back, waiting for QA to pass, rework or scrap them" },
                    { to: "/recycle-store", icon: Recycle, label: "Recycle Store (QA)", value: recycleSummary?.toDecide ?? 0, accent: recycleSummary?.toDecide ? "amber" : "slate", hint: "Rejected material waiting for QA to decide: reuse it or destroy it" },
                  ],
                },
                {
                  title: "Regulatory",
                  tiles: [
                    { to: "/regulatory-planning/pending-review", icon: ShieldAlert, label: "Regulatory: Pending Review", value: regulatoryStats.pendingReview, accent: regulatoryStats.pendingReview ? "amber" : "slate" },
                    { to: "/regulatory-planning/not-approved", icon: ShieldX, label: "Regulatory: Not Approved", value: regulatoryStats.notApproved, accent: regulatoryStats.notApproved ? "rose" : "slate" },
                  ],
                },
                {
                  title: "Material & Purchase",
                  tiles: [
                    { to: "/vendor-payments", icon: Wallet, label: "Vendor Payments", value: financeOpen, accent: financePending ? "amber" : "slate" },
                    { to: "/purchase-planning/shortfall", icon: Package, label: "Purchase Shortfall", value: purchaseStats.shortfall, accent: purchaseStats.shortfall ? "amber" : "slate" },
                    { to: "/incoming-material", icon: Truck, label: "ETA", value: incomingSummary?.lines ?? 0, accent: incomingSummary?.overdue ? "rose" : "amber" },
                    { to: "/inward-qc", icon: ClipboardCheck, label: "Inward QC Pending", value: ppicSummary?.qaAwaited ?? 0, accent: ppicSummary?.qaAwaited ? "amber" : "slate" },
                    { to: "/quarantine", icon: ShieldAlert, label: "Quarantine Stock", value: storeSummary?.quarantineCount ?? 0, accent: storeSummary?.quarantineCount ? "amber" : "slate" },
                  ],
                },
                {
                  title: "Warehouse & Finished Goods",
                  tiles: [
                    { to: "/available-stock", icon: Boxes, label: "Available Stock (Items)", value: availableSummary?.itemsInStock ?? 0, accent: "emerald", hint: "Every RM / PM on hand, by location, with batches" },
                    { to: "/accounts-dispatch", icon: FileText, label: "Dispatch Invoices (Pending)", value: withAccountsCount, accent: withAccountsCount ? "amber" : "slate" },
                    { to: "/finished-goods", icon: PackageCheck, label: "Finished Goods", value: storeSummary?.fgProductCount ?? 0, accent: fgStockRequestsOpen + (crSummary?.open ?? 0) ? "amber" : "emerald", hint: "Finished goods in stock (products), with the requests Dispatch has made and the goods customers sent back" },
                    { to: "/fg-warehouse-requests", icon: PackageCheck, label: "FG Requests (Open)", value: fgRequestsOpen, accent: fgRequestsOpen ? "amber" : "slate" },
                    { to: "/returned-goods-dispatch", icon: RotateCcw, label: "Returned Goods (Dispatch)", value: crSummary?.awaitingDispatch ?? 0, accent: crSummary?.awaitingDispatch ? "amber" : "slate", hint: "Returned goods QA has passed: Dispatch stores them or sends them again" },
                    { to: "/credit-notes", icon: FileText, label: "Credit Notes", value: crSummary?.noCreditNote ?? 0, accent: crSummary?.noCreditNote ? "amber" : "slate", hint: "Customer returns that have no credit note yet" },
                    { to: "/material-requests-plan", icon: AlarmClock, label: "Material Request (Plan)", value: requestsSummary?.plan ?? 0, accent: requestsSummary?.planOverdue ? "rose" : requestsSummary?.plan ? "amber" : "slate" },
                    { to: "/material-requests", icon: HandHelping, label: "Material Requests (Open)", value: requestsSummary?.open ?? 0, accent: requestsSummary?.open ? "amber" : "slate" },
                  ],
                },
                {
                  title: "Production & R&D",
                  tiles: [
                    { to: "/batch-indent", icon: ClipboardList, label: "Indent Issue (Batch)", value: prep?.INDENT_ISSUE ?? 0, accent: prep?.INDENT_ISSUE ? "amber" : "slate", hint: "Batches waiting for Production to sign their indent" },
                    { to: "/held-products", icon: PauseCircle, label: "Held Products", value: heldProductCount, accent: heldToDecide ? "amber" : heldProductCount ? "violet" : "slate", hint: "Products PPIC has put on hold, with their batches: Production holds the batches still in preparation" },
                    { to: "/batch-no", icon: Hash, label: "Batch No", value: prep?.BATCH_NO ?? 0, accent: prep?.BATCH_NO ? "amber" : "slate", hint: "Batches waiting for R&D to allocate their batch number" },
                    { to: "/batch-dispensing", icon: Send, label: "Dispensing (Batch)", value: prep?.DISPENSING ?? 0, accent: prep?.DISPENSING ? "amber" : "slate", hint: "Batches with a batch number: the Day Store dispenses their material" },
                    { to: "/material-received", icon: PackageCheck, label: "Material Received", value: prep?.RECEIVE ? prep.RECEIVE : materialsPending, accent: prep?.RECEIVE || materialsPending ? "amber" : "emerald", hint: "Batch-wise material status. Batches whose material the Day Store has sent are confirmed here" },
                    { to: "/rework", icon: Wrench, label: "Rework", value: crSummary?.inRework ?? 0, accent: crSummary?.inRework ? "amber" : "slate", hint: "Returned goods QA wants reprocessed" },
                    { to: "/batches", icon: Layers, label: "Batch", value: batchPlans, accent: batchPlans ? "amber" : "slate", hint: "Plans with a batch cleared for production" },
                    { to: "/plant-stock", icon: Factory, label: "Plant Stock", value: plantStockItems, accent: plantLeftover ? "violet" : plantStockItems ? "emerald" : "slate", hint: "What each Plant holds: reserved, free, leftover to send back" },
                    { to: "/packaging", icon: PackageCheck, label: "Packaging", value: packagingOpen, accent: packagingOpen ? "amber" : "slate", hint: "Batches at Packaging: sheet and PM Utilization" },
                    { to: "/material-consumption?purpose=WASTE", icon: PackageMinus, label: "Material Wasted", value: materialWastedCount, accent: materialWastedCount ? "amber" : "slate" },
                    { to: "/material-consumption?purpose=REJECTED", icon: PackageMinus, label: "Material Rejected at Plant", value: materialRejectedCount, accent: materialRejectedCount ? "rose" : "slate" },
                    { to: "/sample-requests", icon: Beaker, label: "Sample Request", value: sampleOpen, accent: sampleOpen ? "violet" : "slate" },
                    { to: "/bom-board", icon: ClipboardList, label: "Generate BOM", value: `${(bomBoard?.length ?? 0) - (bomBoard ?? []).filter((r) => r.needsWork).length}/${bomBoard?.length ?? 0}`, accent: (bomBoard ?? []).some((r) => r.needsWork) ? "amber" : "emerald" },
                    { to: "/ppic-planning/material-planning", icon: Layers, label: "Material Planning (urgent)", value: rndPlanning?.short ?? 0, accent: rndPlanning?.short ? "rose" : "slate", hint: "Products short of material: change the plan to V1 / V2 to make them ready" },
                    { to: "/ppic-planning/po-readiness", icon: CheckCircle2, label: "PO Readiness", value: rndPlanning?.ready ?? 0, accent: rndPlanning?.ready ? "emerald" : "slate", hint: "Products whose material is all covered: R&D can send the ones it changed to Production" },
                    { to: "/bom-production", icon: Layers, label: "In Production: BOM change", value: rndInProduction?.length ?? 0, accent: rndInProduction?.length ? "violet" : "slate", hint: "Products with Production: change the BOM version of the batches not dispensed yet (PPIC is not told)" },
                  ],
                },
              ] as { title: string; tiles: { to: string; icon: LucideIcon; label: string; value: string | number; accent: StatAccent; hint?: string }[] }[]
            ).map((section) => (
              <div key={section.title} className="space-y-2">
                <p className="text-micro font-bold uppercase tracking-widest text-slate-400">{section.title}</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {section.tiles.map((t) => (
                    <Link key={t.label} to={t.to} className="block" title={t.hint}>
                      <StatTile icon={t.icon} label={t.label} value={t.value} accent={t.accent} />
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : isQcOnlyView ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Link to="/qc/ipqc" className="block" title="Batches whose in-process check waits for QA">
              <StatTile icon={Beaker} label="IPQC" value={qcCounts?.IPQC ?? 0} accent={qcCounts?.IPQC ? "sky" : "slate"} />
            </Link>
            <Link to="/qc/qa-gate-mfg" className="block" title="Batches that finished manufacturing and wait at QA's gate">
              <StatTile icon={ShieldAlert} label="QA Gate: Manufacturing" value={qcCounts?.QA_GATE_MFG ?? 0} accent={qcCounts?.QA_GATE_MFG ? "sky" : "slate"} />
            </Link>
            <Link to="/qc/qa-gate-packaging" className="block" title="Batches that finished packaging and wait at QA's gate">
              <StatTile icon={ShieldAlert} label="QA Gate: Packaging" value={qcCounts?.QA_GATE_PACKAGING ?? 0} accent={qcCounts?.QA_GATE_PACKAGING ? "sky" : "slate"} />
            </Link>
            <Link to="/qc/fg-release" className="block" title="Finished goods at the Day Store waiting for your approval">
              <StatTile icon={PackageCheck} label="FG QC & Release" value={qcCounts?.FG_QC_RELEASE ?? 0} accent={qcCounts?.FG_QC_RELEASE ? "amber" : "slate"} />
            </Link>
            <Link to="/qc/on-hold" className="block" title="Everything QA has put on hold, at any stage">
              <StatTile icon={PauseCircle} label="On Hold" value={qcCounts?.ON_HOLD ?? 0} accent={qcCounts?.ON_HOLD ? "amber" : "slate"} />
            </Link>
            <Link to="/returned-goods" className="block" title="Goods a customer sent back: pass them, send them for rework, or scrap them">
              <StatTile icon={ShieldCheck} label="Returned Goods" value={crSummary?.withQa ?? 0} accent={crSummary?.withQa ? "amber" : "slate"} />
            </Link>
            <Link to="/recycle-store" className="block" title="Rejected material waiting in the Recycle Store: reuse it or destroy it">
              <StatTile icon={Recycle} label="Recycle Store" value={recycleSummary?.toDecide ?? 0} accent={recycleSummary?.toDecide ? "amber" : "slate"} />
            </Link>
          </div>
        ) : isPurchaseOnlyView ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Link to="/purchase-planning/shortfall" className="block" title="Log or update a PO straight from this list">
              <StatTile icon={Package} label="Shortfall" value={purchaseStats.shortfall} accent={purchaseStats.shortfall ? "amber" : "slate"} />
            </Link>
            <Link to="/purchase-planning/covered" className="block">
              <StatTile icon={CheckCircle2} label="Complete" value={purchaseStats.covered} accent="emerald" />
            </Link>
            <Link to="/vendor-payments?status=paid" className="block" title="Vendor payments Finance has paid (part or full) on your POs: open the list for the amounts and remarks">
              <StatTile icon={Wallet} label="Payments Done" value={financePaid} accent={financePaid ? "emerald" : "slate"} />
            </Link>
          </div>
        ) : isRegulatoryOnlyView ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Link to="/regulatory-planning/pending-review" className="block">
              <StatTile icon={ShieldAlert} label="Pending Review" value={regulatoryStats.pendingReview} accent={regulatoryStats.pendingReview ? "amber" : "slate"} />
            </Link>
            <Link to="/regulatory-planning/approved" className="block">
              <StatTile icon={ShieldCheck} label="Approved" value={regulatoryStats.approved} accent="emerald" />
            </Link>
            <Link to="/regulatory-planning/not-approved" className="block">
              <StatTile icon={ShieldX} label="Not Approved" value={regulatoryStats.notApproved} accent={regulatoryStats.notApproved ? "rose" : "slate"} />
            </Link>
          </div>
        ) : isStoreOnlyView && isDayStoreLogin ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Link to="/available-stock" className="block" title="Every RM / PM on hand in your store and its Plant">
              <StatTile icon={Boxes} label="Available Stock (Items)" value={availableSummary?.itemsInStock ?? 0} accent="emerald" />
            </Link>
            <Link to="/my-store/received" className="block" title="What the Warehouse has issued into your store">
              <StatTile icon={ArrowDownToLine} label="Stock Received (Entries)" value={myStoreSummary?.received ?? 0} accent="blue" />
            </Link>
            <Link to="/my-store/production-requests" className="block" title={`Material your Plant production plans need: approve, fill from your store, or ask the Warehouse. ${myStoreSummary?.productsCovered ?? 0} products are fully covered at your store, ${myStoreSummary?.productsShort ?? 0} have something short (use the "Short at my store" filter).`}>
              <StatTile icon={AlarmClock} label="Production Requests (Open)" value={myStoreSummary?.productionRequests ?? 0} accent={myStoreSummary?.productionRequests ? "amber" : "slate"} />
            </Link>
            <Link to="/my-store/finished-goods" className="block" title="Finished goods QA has passed: receive them, and hand them to Dispatch once QA approves them">
              <StatTile icon={PackageCheck} label="Finished Goods" value={fgDayStoreOpen} accent={fgDayStoreOpen ? "amber" : "slate"} />
            </Link>
            <Link to="/batch-dispensing" className="block" title="Batches that have their batch number: dispense each batch's material to the Plant">
              <StatTile icon={Send} label="Dispensing" value={prep?.DISPENSING ?? 0} accent={prep?.DISPENSING ? "amber" : "slate"} />
            </Link>
            <Link to="/my-store/requests" className="block" title="Ask the Warehouse for material, and follow your requests">
              <StatTile icon={HandHelping} label="My Material Requests (Open)" value={myStoreSummary?.requests ?? 0} accent="amber" />
            </Link>
            <Link to="/my-store/issued-to-plant" className="block" title="What your store has issued on to its own Plant">
              <StatTile icon={Send} label="Stock Issued to Plant (Entries)" value={myStoreSummary?.issuedToPlant ?? 0} accent="violet" />
            </Link>
          </div>
        ) : isStoreOnlyView ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Link to="/available-stock" className="block" title="Every RM / PM on hand across Warehouse, Day Stores, R&D Store and Plants, in one list">
              <StatTile icon={Boxes} label="Available Stock (Items)" value={availableSummary?.itemsInStock ?? 0} accent="emerald" />
            </Link>
            <Link to="/stock-received" className="block" title="Every delivery the Warehouse has received from a vendor, with filters">
              <StatTile icon={ArrowDownToLine} label="Stock Received (Entries)" value={receivedSummary?.total ?? 0} accent="blue" />
            </Link>
            <Link to="/quarantine" className="block" title="Stock held for QC, on hold, or sent for a lab test - with filters">
              <StatTile icon={ShieldAlert} label="Quarantine Stock" value={storeSummary?.quarantineCount ?? 0} accent={storeSummary?.quarantineCount ? "amber" : "slate"} />
            </Link>
            <Link
              to="/finished-goods"
              className="block"
              title={`Finished goods in stock (products). ${fgStockRequestsOpen} request${fgStockRequestsOpen === 1 ? "" : "s"} from Dispatch open, ${isWarehouseSeat ? (crSummary?.open ?? 0) : 0} customer return${(crSummary?.open ?? 0) === 1 ? "" : "s"} in progress: all on that page.`}
            >
              <StatTile icon={PackageCheck} label="Finished Goods" value={storeSummary?.fgProductCount ?? 0} accent={fgStockRequestsOpen + (isWarehouseSeat ? (crSummary?.open ?? 0) : 0) ? "amber" : "emerald"} />
            </Link>
            <Link to="/stock-issued" className="block" title="Everything the Warehouse has issued out - to Day Stores and the R&D Store - with filters">
              <StatTile icon={Send} label="Stock Issued (Entries)" value={issuedSummary?.total ?? 0} accent="violet" />
            </Link>
            <Link to="/incoming-material" className="block" title="Material Purchase has put on order (PI lines) that has not arrived yet, by ETA">
              <StatTile icon={Truck} label="ETA" value={incomingSummary?.lines ?? 0} accent={incomingSummary?.overdue ? "rose" : "amber"} />
            </Link>
            <Link to="/fg-warehouse-requests" className="block" title="Dispatch asking to send finished goods to the Warehouse: accept them, and confirm when they arrive">
              <StatTile icon={PackageCheck} label="FG Requests (Open)" value={fgRequestsOpen} accent={fgRequestsOpen ? "amber" : "slate"} />
            </Link>
            <Link to="/material-requests-plan" className="block" title="Urgent: Day Stores asking for material a production plan needs - late ones first">
              <StatTile icon={AlarmClock} label="Material Request (Plan)" value={requestsSummary?.plan ?? 0} accent={requestsSummary?.planOverdue ? "rose" : requestsSummary?.plan ? "amber" : "slate"} />
            </Link>
            <Link to="/material-requests" className="block" title="What Day Stores and the R&D Store have asked the Warehouse for, with filters">
              <StatTile icon={HandHelping} label="Material Requests (Open)" value={requestsSummary?.open ?? 0} accent={requestsSummary?.open ? "amber" : "slate"} />
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {canProduction && (
              <Link to="/new-plans" className="block" title="Plans PPIC has sent to Production that have not cleared Line Clearance yet: start the run and take it through the pre-production steps">
                <StatTile icon={ClipboardCheck} label="New Plan" value={underProcessPlans} accent={underProcessPlans ? "emerald" : "slate"} />
              </Link>
            )}
            {canProduction && (
              <Link to="/batch-indent" className="block" title="Batches waiting for their indent: sign it, then R&D gives the batch number">
                <StatTile icon={ClipboardList} label="Indent Issue" value={prep?.INDENT_ISSUE ?? 0} accent={prep?.INDENT_ISSUE ? "amber" : "slate"} />
              </Link>
            )}
            {canProduction && (
              <Link to="/held-products" className="block" title={`Products PPIC has put on hold, with their batches: hold the batches still in preparation, release them later. ${heldToDecide} batch${heldToDecide === 1 ? "" : "es"} to decide.`}>
                <StatTile icon={PauseCircle} label="Held Products" value={heldProductCount} accent={heldToDecide ? "amber" : heldProductCount ? "violet" : "slate"} />
              </Link>
            )}
            {canProduction && (
              <Link
                to="/material-received"
                className="block"
                title={prep?.RECEIVE ? `${prep.RECEIVE} batch${prep.RECEIVE === 1 ? "" : "es"} whose material the Day Store has sent: confirm what arrived. Also each batch's material required, received, still to come, in production and available.` : "For each batch: material required, received, still to come, in production and available"}
              >
                {/* Waiting for Production's confirmation: the number of batches; otherwise the materials not yet fully received */}
                <StatTile icon={PackageCheck} label="Material Received" value={prep?.RECEIVE ? prep.RECEIVE : materialsPending} accent={prep?.RECEIVE || materialsPending ? "amber" : "emerald"} />
              </Link>
            )}
            {canProduction && (
              <Link to="/batches" className="block" title="Batches cleared for production: start each, fill its RM Utilization, then its end time">
                <StatTile icon={Layers} label="Batch" value={batchPlans} accent={batchPlans ? "amber" : "slate"} />
              </Link>
            )}
            {canProduction && (
              <Link to="/packaging" className="block" title="Batches that passed Bulk QC: packaging sheet and PM Utilization, then hand over to QA">
                <StatTile icon={PackageCheck} label="Packaging" value={packagingOpen} accent={packagingOpen ? "amber" : "slate"} />
              </Link>
            )}
            {canProduction && (
              <Link to="/plant-stock" className="block" title={`What your Plant holds of each material: reserved for batches, free, and leftover to send back to the Day Store. ${plantLeftover} with leftover to send back.`}>
                <StatTile icon={Factory} label="Plant Stock" value={plantStockItems} accent={plantLeftover ? "violet" : plantStockItems ? "emerald" : "slate"} />
              </Link>
            )}
            {canProduction && (
              <Link to="/extra-material" className="block" title="Ask your Plant's Day Store for material that is not in any plan, and follow it until it reaches the Plant">
                <StatTile icon={PackagePlus} label="Extra Material" value={extraOpen} accent={extraOpen ? "violet" : "slate"} />
              </Link>
            )}
            {canProduction && (
              <Link to="/handover" className="block" title="Batches whose packaging is complete: hand them over to QA">
                <StatTile icon={Truck} label="Handover" value={handoverReady} accent={handoverReady ? "emerald" : "slate"} />
              </Link>
            )}
            {canProduction && (
              <Link to="/production-report" className="block" title="The full report of each product: batches, shifts, manpower, output, material and hand-over to Dispatch">
                <StatTile icon={ClipboardList} label="Production Report" value={reportProducts} accent="violet" />
              </Link>
            )}
            {canProduction && (
              <Link to="/rework" className="block" title="Goods a customer sent back that QA wants reprocessed">
                <StatTile icon={Wrench} label="Rework" value={crSummary?.inRework ?? 0} accent={crSummary?.inRework ? "amber" : "slate"} />
              </Link>
            )}
            {canDispatchTile && (
              <Link to="/finished-goods-dispatch" className="block" title="Finished goods the Day Store has handed over: send them to the customer or, after the Warehouse accepts, to the Warehouse">
                <StatTile icon={PackageCheck} label="Finished Goods" value={fgDispatch?.length ?? 0} accent={fgDispatch?.length ? "emerald" : "slate"} />
              </Link>
            )}
            {canDispatchTile && (
              <Link to="/finished-goods" className="block" title="Finished goods you asked the Warehouse for, to send to a customer: confirm them when they arrive">
                <StatTile icon={Warehouse} label="Stock from Warehouse" value={fgStockRequestsOpen} accent={fgStockRequestsOpen ? "violet" : "slate"} />
              </Link>
            )}
            {canDispatchTile && (
              <Link to="/finished-goods-dispatch" className="block" title="Customer shipments you prepared: with Accounts for the invoice, ready for you to send, or sent back for a correction">
                <StatTile icon={FileText} label="Shipments with Accounts" value={withAccountsCount + readyToSendCount + sentBackCount} accent={readyToSendCount || sentBackCount ? "amber" : "slate"} />
              </Link>
            )}
            {canDispatchTile && (
              <Link to="/returned-goods-dispatch" className="block" title="Goods a customer sent back that QA has passed: store them in the Warehouse or send them again">
                <StatTile icon={RotateCcw} label="Returned Goods" value={crSummary?.awaitingDispatch ?? 0} accent={crSummary?.awaitingDispatch ? "amber" : "slate"} />
              </Link>
            )}
            {canAccountsTile && (
              <Link to="/accounts-dispatch" className="block" title="Customer shipments Dispatch prepared: add the invoice and e-way bill so Dispatch can send them">
                <StatTile icon={FileText} label="Dispatch Invoices (Pending)" value={withAccountsCount} accent={withAccountsCount ? "amber" : "slate"} />
              </Link>
            )}
            {canAccountsTile && (
              <Link to="/credit-notes" className="block" title="Customer returns that have no credit note yet">
                <StatTile icon={FileText} label="Credit Notes" value={crSummary?.noCreditNote ?? 0} accent={crSummary?.noCreditNote ? "amber" : "slate"} />
              </Link>
            )}
            {canAccountsTile && (
              <Link to="/vendor-payments" className="block" title={`Vendor payments not paid in full: ${financePending} pending, ${financeCount("PAID_PARTIAL")} part paid, ${financeCount("ON_HOLD")} on hold, ${financeCount("REJECTED")} rejected. Open the list and filter by status.`}>
                <StatTile icon={Wallet} label="Vendor Payments" value={financeOpen} accent={financePending ? "amber" : "slate"} />
              </Link>
            )}
            {!canRnd && !canProduction && (
              <>
                <StatTile icon={ClipboardList} label="Awaiting You" value={myQueueRows.length} accent="blue" />
                <StatTile icon={AlarmClock} label="Delayed (Yours)" value={myDelayed.length} accent="rose" />
              </>
            )}
            {canSeeMaterialUsage && (
              <>
                <Link to="/material-consumption?purpose=PRODUCTION" className="block">
                  <StatTile icon={PackageMinus} label="Material Used in Production" value={materialUsedInProductionCount} accent="blue" />
                </Link>
                <Link to="/material-consumption?purpose=SAMPLE" className="block">
                  <StatTile icon={FlaskConical} label="Material Sent for Testing" value={materialSentForTestingCount} accent="violet" />
                </Link>
                <Link to="/material-consumption?purpose=WASTE" className="block">
                  <StatTile icon={PackageMinus} label="Material Wasted (Handling Loss)" value={materialWastedCount} accent={materialWastedCount ? "amber" : "slate"} />
                </Link>
                <Link to="/material-consumption?purpose=REJECTED" className="block">
                  <StatTile icon={PackageMinus} label="Material Rejected at Plant" value={materialRejectedCount} accent={materialRejectedCount ? "rose" : "slate"} />
                </Link>
              </>
            )}
            {canRnd && (
              <>
                <Link to="/batch-no" className="block" title="Batches whose indent is signed: allocate the batch number (the system gives the next serial)">
                  <StatTile icon={Hash} label="Batch No" value={prep?.BATCH_NO ?? 0} accent={prep?.BATCH_NO ? "amber" : "slate"} />
                </Link>
                <Link to="/sample-requests" className="block" title="Samples customers have asked R&D for. The number is how many are not dispatched yet.">
                  <StatTile icon={Beaker} label="Sample Request" value={sampleOpen} accent={sampleOpen ? "violet" : "slate"} />
                </Link>
                <Link to="/new-material" className="block" title={`Material the Warehouse received from vendors. ${newMaterialOpen} waiting for a decision (Pending, Testing or Hold).`}>
                  <StatTile icon={PackageCheck} label="New Material" value={newMaterialTotal} accent={newMaterialOpen ? "amber" : "slate"} />
                </Link>
                <Link to="/received-material" className="block" title={`Your requests to the Warehouse. ${toReceive} issued and waiting for you to confirm receiving.`}>
                  <StatTile icon={PackageCheck} label="Received Material" value={receivedMaterialTotal} accent={toReceive ? "emerald" : "slate"} />
                </Link>
                <Link to="/material-utilization" className="block" title={`What became of the material that reached the R&D Store. ${utilizationInStock} still in stock.`}>
                  <StatTile icon={FlaskConical} label="Material Utilization" value={utilizationTotal} accent={utilizationInStock ? "violet" : "slate"} />
                </Link>
                <Link to="/return-material" className="block" title={`Material R&D sent back to the Warehouse. ${returnsWaiting} waiting for the Warehouse to confirm.`}>
                  <StatTile icon={ArrowLeftRight} label="Return Material" value={returnsTotal} accent={returnsWaiting ? "amber" : "slate"} />
                </Link>
                <Link to="/rnd-quarantine" className="block" title={`Material that is not usable stock yet: not approved, rejected or expired. ${quarantineWaiting} waiting for R&D.`}>
                  <StatTile icon={ShieldAlert} label="Quarantine" value={quarantineTotal} accent={quarantineWaiting ? "rose" : "slate"} />
                </Link>
                <Link to="/bom-board" className="block" title="Products on approved POs: is their RM BOM and Packaging BOM ready? The number is how many are ready out of all of them.">
                  <StatTile icon={ClipboardList} label="Generate BOM" value={`${bomReady}/${bomBoard?.length ?? 0}`} accent={bomNeedWork ? "amber" : "emerald"} />
                </Link>
                <Link to="/ppic-planning/material-planning" className="block" title="Products short of material: change the plan to V1 / V2 to make them ready">
                  <StatTile icon={Layers} label="Material Planning (urgent)" value={rndPlanning?.short ?? 0} accent={rndPlanning?.short ? "rose" : "slate"} />
                </Link>
                <Link to="/ppic-planning/po-readiness" className="block" title="Products whose material is all covered: R&D can send the ones it changed to Production">
                  <StatTile icon={CheckCircle2} label="PO Readiness" value={rndPlanning?.ready ?? 0} accent={rndPlanning?.ready ? "emerald" : "slate"} />
                </Link>
                <Link to="/bom-production" className="block" title="Products with Production: change the BOM version of the batches not dispensed yet (PPIC is not told)">
                  <StatTile icon={Layers} label="In Production: BOM change" value={rndInProduction?.length ?? 0} accent={rndInProduction?.length ? "violet" : "slate"} />
                </Link>
                <Link to="/bulk-qc" className="block">
                  <StatTile icon={Truck} label="Bulk QC / COA Pending" value={rndBulkQcCount} accent="blue" />
                </Link>
                <Link to="/rnd-dispatches" className="block">
                  <StatTile icon={Send} label="Dispatch to Customer" value={rndDispatchCount} accent="violet" />
                </Link>
              </>
            )}
          </div>
        )}

        {!isQcOnlyView && (
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-4 py-3">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-500">
                {orgWide ? <ShoppingCart className="h-3.5 w-3.5" /> : <ClipboardList className="h-3.5 w-3.5" />}
                {orgWide ? "Recent Orders" : "Your Queue"}
              </h3>
              {orgWide && (
                <Link to="/purchase-orders" className="text-micro font-bold text-brand-600 hover:underline">
                  View all
                </Link>
              )}
            </div>
            {orgWide ? (
              recentOrders.length === 0 ? (
                <p className="p-6 text-center text-xs text-slate-400">No purchase orders yet.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {recentOrders.map((po) => (
                    <Link key={po.id} to={`/purchase-orders/${po.id}`} className="flex items-center justify-between px-4 py-3 text-xs transition-all duration-200 hover:bg-slate-50 hover:pl-5 hover:shadow-[inset_2px_0_0_theme(colors.brand.500)]">
                      <div>
                        <p className="font-bold text-slate-700">{po.poNumber ?? po.id.slice(0, 8)}</p>
                        <p className="text-slate-400"><CustomerName name={po.customer.companyName} /></p>
                      </div>
                      <span className="pill border-slate-200 bg-slate-50 text-slate-500">{po.items.length} product(s)</span>
                    </Link>
                  ))}
                </div>
              )
            ) : myQueueRows.length === 0 ? (
              <p className="p-6 text-center text-xs text-slate-400">Nothing waiting on your department right now.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {myQueueRows.slice(0, 6).map((row) => (
                  <Link key={row.key} to={row.to} className="flex items-center justify-between px-4 py-3 text-xs transition-all duration-200 hover:bg-slate-50 hover:pl-5 hover:shadow-[inset_2px_0_0_theme(colors.brand.500)]">
                    <div className="min-w-0">
                      <p className="truncate font-bold text-slate-700">{row.title}</p>
                      <p className="truncate text-slate-400">{row.subtitle}</p>
                    </div>
                    <div className="shrink-0">{row.badge}</div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}

        <div id="needs-attention" className="card overflow-hidden scroll-mt-24">
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-4 py-3">
            <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-500">
              <AlarmClock className="h-3.5 w-3.5" /> Needs Attention
            </h3>
            {attentionRows.length > 0 && <span className="pill border-rose-200 bg-rose-50 text-rose-700">{attentionRows.length}</span>}
          </div>
          {attentionRows.length === 0 ? (
            <p className="p-5 text-center text-xs text-slate-400">{orgWide ? "Nothing delayed right now." : "Nothing delayed in your queue."}</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {attentionRows.slice(0, 5).map((r) => (
                <Link key={r.id} to={r.to} className="block px-4 py-2.5 text-xs transition-all duration-200 hover:bg-slate-50 hover:pl-5 hover:shadow-[inset_2px_0_0_theme(colors.rose.500)]">
                  <p className="truncate font-bold text-slate-700">{r.title}</p>
                  <p className="truncate text-slate-400">{r.subtitle}</p>
                  <div className="mt-1">
                    <DelayBadge delay={r.delay} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
