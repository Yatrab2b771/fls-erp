import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AlarmClock,
  ArrowDownToLine,
  Beaker,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  FlaskConical,
  Package,
  PackageCheck,
  PackageMinus,
  PauseCircle,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  ShoppingCart,
  Sparkles,
  Truck,
  Warehouse,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useAllProductionBatches,
  useCombinedLots,
  useBomPlans,
  useInventoryRequests,
  useInventoryStock,
  useInventoryTransactions,
  useMaterialConsumptionReport,
  usePoReadiness,
  usePreProductions,
  usePurchaseOrders,
  useCatalogSkuCount,
  usePreInventoryRequirements,
  useQcDashboard,
  useRecipeRequests,
  useRecipes,
  useRmPlans,
  useRndSampleRequests,
  useRndTransfers,
  useStoreDashboardSummary,
} from "../lib/hooks";
import { PRE_PRODUCTION_STAGE_ROLE } from "../lib/preProductionStage";
import { COMBINED_LOT_STAGE_ROLE } from "../lib/combinedLotStage";
import { getPendingPos, hasCalculatedBom, hasCalculatedRm, toItemRows } from "../lib/ppicPlanning";
import { getActiveProductionRows, getCompletedPos, isPoDelayed } from "../lib/bdPlanning";
import { getPurchasePlanningRows } from "../lib/purchasePlanning";
import { getRegulatoryPlanningRows } from "../lib/regulatoryPlanning";
import { StatTile } from "../components/StatTile";
import { SkeletonRows } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { DelayBadge, RequestStatusBadge, StageBadge } from "../components/Badges";
import { ReceivedCard, FgTransferCard } from "./InventoryPage";
import type { CombinedLot, CombinedLotStageId, PreProduction, PreProductionStageId, QcDashboard } from "../lib/types";

const QC_GATE_LABEL: Record<string, string> = { QA_GATE_MFG: "QA Gate — Manufacturing", QA_GATE_PACKAGING: "QA Gate — Packaging" };

type AnyStageId = PreProductionStageId | CombinedLotStageId;

// The pipeline's 11 stages across both tiers, grouped into 5 visual
// phases so the stepper reads as one clean flow instead of 11 cramped
// nodes. SAMPLE_QC_APPROVAL/IPQC/BULK_QC are the extra QC checkpoints
// added against the client's Production Process Flow doc.
const FLOW_STAGES: { label: string; stages: AnyStageId[]; accent: string }[] = [
  { label: "Procurement", stages: ["MATERIAL_RECEIVED"], accent: "amber" },
  { label: "Planning", stages: ["INDENT_ISSUE"], accent: "slate" },
  { label: "Manufacturing", stages: ["DISPENSING", "SAMPLE_QC_APPROVAL", "IPQC", "QA_GATE_MFG", "BULK_QC"], accent: "blue" },
  { label: "Packaging", stages: ["PACKAGING", "QA_GATE_PACKAGING"], accent: "violet" },
  { label: "Dispatch", stages: ["BILLING_EWAY_BILL", "DISPATCH_PLAN"], accent: "emerald" },
];

const FLOW_COLOR: Record<string, { fill: string; dot: string }> = {
  slate: { fill: "from-slate-300 to-slate-500", dot: "bg-slate-400" },
  amber: { fill: "from-amber-300 to-amber-500", dot: "bg-amber-500" },
  blue: { fill: "from-blue-300 to-blue-500", dot: "bg-blue-500" },
  violet: { fill: "from-violet-300 to-violet-500", dot: "bg-violet-500" },
  emerald: { fill: "from-emerald-300 to-emerald-500", dot: "bg-emerald-500" },
};

// A PreProduction run counts as "still pending" for queue/count purposes
// until it's actually cleared its own terminal gate (Sample QC Approval
// completes in place, so currentStageId alone can't tell "waiting" from
// "done" the way every earlier stage can).
function isPreProductionPending(r: PreProduction) {
  return !(r.currentStageId === "SAMPLE_QC_APPROVAL" && r.sampleQcStatus === "Approved");
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  const chars = parts.length > 1 ? [parts[0]?.[0], parts[parts.length - 1]?.[0]] : [parts[0]?.[0], parts[0]?.[1]];
  return chars.filter(Boolean).join("").toUpperCase();
}

export function DashboardPage() {
  const { user, hasRole } = useAuth();
  const { data: orders } = usePurchaseOrders();
  const { data: preRuns } = usePreProductions();
  const { data: lots } = useCombinedLots();
  const { data: batches } = useAllProductionBatches();
  const { data: bomPlans } = useBomPlans();
  const { data: rmPlans } = useRmPlans();
  const { data: stock } = useInventoryStock();
  // PO Readiness is PPIC-gated on the API (ADMIN bypasses) — BD is
  // org-wide too but isn't PPIC, so this has to opt out for them
  // specifically rather than reusing the broader orgWide flag.
  const canSeePoReadiness = hasRole("PPIC");
  const { data: poReadinessRows } = usePoReadiness(false, { enabled: canSeePoReadiness });

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
  const canSeeMaterialUsage = isPpicOnlyView || (!orgWide && hasRole("PRODUCTION"));
  const { data: materialConsumption } = useMaterialConsumptionReport(undefined, { enabled: canSeeMaterialUsage });
  const materialUsageProductCount = new Set((materialConsumption ?? []).map((r) => r.preProductionId)).size;

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
  const myQueuePreRuns = allPreRuns.filter((r) => isPreProductionPending(r) && hasRole(...PRE_PRODUCTION_STAGE_ROLE[r.currentStageId]));
  const myQueueLots = allLots.filter((l) => l.currentStageId !== "DISPATCH_PLAN" && hasRole(...COMBINED_LOT_STAGE_ROLE[l.currentStageId]));
  const myQueueBatches = allBatches.filter((b) => b.currentStageId !== "DISPATCH_PLAN" && hasRole(...COMBINED_LOT_STAGE_ROLE[b.currentStageId]));

  // QC gets its own full-breakdown view below (isQcOnlyView) instead of
  // the generic "Your Queue" list — see useQcDashboard just below, which
  // covers everything Inventory's inward/outward QC checks would have
  // fed into this queue anyway.
  const isQcOnlyView = !orgWide && hasRole("QA_QC");
  const { data: qcData, isLoading: qcLoading } = useQcDashboard({ enabled: isQcOnlyView });
  // Purchase gets its own Pre-Inventory tile set — same shape as PPIC's,
  // same shared-filter/drill-down/Excel-export pattern (see
  // purchasePlanning.ts and PurchasePlanningDetailPage).
  const isPurchaseOnlyView = !orgWide && hasRole("PURCHASE");
  const { data: purchaseRequirements } = usePreInventoryRequirements(undefined, { enabled: isPurchaseOnlyView });
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
  const { data: storeSummary } = useStoreDashboardSummary({ enabled: isStoreOnlyView });
  const canRnd = !orgWide && hasRole("RND");
  const { data: pendingReceiptQc } = useInventoryTransactions({ type: "RECEIVED", receiptStatus: "PENDING_QC" }, { enabled: canRnd });
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
  const { data: rndRecipes } = useRecipes({ enabled: canRnd });
  const { data: rndSkuCount } = useCatalogSkuCount({ enabled: canRnd });

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
    ...(pendingReceiptQc ?? []).map((t) => ({ key: `rqc-${t.id}`, to: "/inventory", title: t.item.name, subtitle: `Inward QC · ${t.quantity} ${t.unit}`, badge: pendingQcPill })),
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
  const rndOverdueRequests = rndOpenCatalogGaps.filter((r) => r.etaDate && new Date(r.etaDate) < new Date());
  const rndAwaitingConfirmation = (rndPendingTransfers ?? []).filter((t) => t.direction === "TO_RND");
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

  const totalProducts = orders?.reduce((sum, po) => sum + po.items.length, 0) ?? 0;
  // "Active" = a run still short of its own terminal gate, a lot not yet
  // at Dispatch Plan, or a completed batch still in its own pipeline —
  // same completion definition purchase-orders.routes.ts's
  // computeCompletion uses (either path counts).
  const activeCount =
    allPreRuns.filter(isPreProductionPending).length +
    allLots.filter((l) => l.currentStageId !== "DISPATCH_PLAN").length +
    allBatches.filter((b) => b.currentStageId !== "DISPATCH_PLAN").length;

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
  const pendingItems = pendingOrders.flatMap((po) => po.items);
  // BD's own tile set — completedOrders/delayedPendingOrders/
  // completedItems/activeProductionRows come from bdPlanning.ts, the
  // same filters BdPlanningDetailPage uses for each tile's own
  // drill-down list. Delayed = a Pending PO whose own promised Expected
  // Delivery Date has already passed (customer-facing miss), not the
  // internal production/dispatch-plan-date delay "Needs Attention"
  // already tracks.
  const completedOrders = getCompletedPos(orders ?? []);
  const delayedPendingOrders = pendingOrders.filter(isPoDelayed);
  const completedItems = toItemRows(completedOrders);
  const activeProductionRows = getActiveProductionRows(allPreRuns, allLots, allBatches);
  const itemsWithBom = pendingItems.filter(hasCalculatedBom).length;
  const itemsWithRecipe = pendingItems.filter(hasCalculatedRm).length;
  const itemsMissingBoth = pendingItems.filter((i) => !hasCalculatedBom(i) && !hasCalculatedRm(i)).length;
  // PPIC's own hand-off checkpoint — item.planSentToProductionAt is set
  // the moment PPIC clicks "Send Plan to Production" (see
  // purchase-orders.routes.ts's own comment on that route), independent
  // of whether Production has actually opened a run against it yet.
  // Answers "how many products' plans have actually reached Production"
  // directly, instead of the old Active-in-Production tile, which
  // counted physical runs/lots/batches (including ones created before
  // this gate existed) and so never reconciled with the BOM/RM numbers.
  // Scoped to ALL products (not just pendingItems) — a completed,
  // already-dispatched PO's item necessarily had its plan sent to
  // Production at some point, so this pair always foots back exactly to
  // Total Products, unlike the BOM/RM-BOM tiles above (those are a
  // still-open-orders paperwork check, deliberately pending-only).
  const allItems = (orders ?? []).flatMap((po) => po.items);
  const itemsPlanSent = allItems.filter((i) => i.planSentToProductionAt).length;
  const itemsPlanNotSent = allItems.length - itemsPlanSent;

  const orgDelayed: { id: string; to: string; title: string; subtitle: string; delay: { isDelayed: boolean; against: "dispatchPlanDate" | "productionPlanDate" | null; daysLate: number | null } }[] = [
    ...allPreRuns.filter((r) => r.delay.isDelayed).map((r) => ({ id: r.id, to: `/pre-productions/${r.id}`, title: r.purchaseOrderItem.productName, subtitle: r.purchaseOrderItem.purchaseOrder.customer.companyName, delay: r.delay })),
    ...allLots
      .filter((l) => l.delay.isDelayed)
      .map((l) => ({ id: l.id, to: `/combined-lots/${l.id}`, title: l.preProduction.purchaseOrderItem.productName, subtitle: l.preProduction.purchaseOrderItem.purchaseOrder.customer.companyName, delay: l.delay })),
  ];
  const myDelayed = orgDelayed.filter((d) => myQueueRows.some((r) => r.to === d.to));
  const negativeStock = stock?.filter((s) => s.onHand < 0).length ?? 0;
  const readyPoCount = poReadinessRows?.filter((r) => r.isReady).length ?? 0;

  const stageCounts = FLOW_STAGES.map((group) => ({
    ...group,
    count:
      allPreRuns.filter((r) => isPreProductionPending(r) && group.stages.includes(r.currentStageId)).length +
      allLots.filter((l) => group.stages.includes(l.currentStageId)).length +
      allBatches.filter((b) => group.stages.includes(b.currentStageId)).length,
  }));
  const maxCount = Math.max(1, ...stageCounts.map((s) => s.count));

  const recentOrders = [...(orders ?? [])].slice(0, 5);
  const attentionRows = orgWide ? orgDelayed : myDelayed;
  const displayName = user?.fullName ?? user?.email ?? "";

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[312px_1fr] xl:grid-cols-[340px_1fr]">
      {/* Main column */}
      <div className="min-w-0 space-y-5 lg:order-2">
        {/* Plain hex-stop inline gradient (not Tailwind's CSS-custom-property
            gradient utilities) — some browser color/theme extensions reset
            --tw-gradient-* custom properties and wash this card out to
            near-white, which a literal `background` value isn't subject to. */}
        <div
          className="relative overflow-hidden rounded-2xl p-6 shadow-lift sm:p-8"
          style={{ backgroundColor: "#312e81", backgroundImage: "linear-gradient(135deg, #4338ca 0%, #3730a3 55%, #0f172a 100%)" }}
        >
          {/* The grid texture rides on its own layer, not on this element:
              .hero-grid also sets background-size: 32px, which tiled the
              inline gradient above into a visible 32px checkerboard
              instead of one smooth wash. */}
          <div className="hero-grid pointer-events-none absolute inset-0" />
          <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full blur-3xl" style={{ backgroundColor: "rgba(129,140,248,0.25)" }} />
          <div className="pointer-events-none absolute -bottom-20 left-1/3 h-56 w-56 rounded-full blur-3xl" style={{ backgroundColor: "rgba(167,139,250,0.15)" }} />
          <div className="relative">
            <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.15em]" style={{ color: "#c7d2fe" }}>
              <Sparkles className="h-3.5 w-3.5" /> {greeting()}, {displayName.split(" ")[0] || "there"}
            </p>
            <h1 className="mt-1.5 text-2xl font-black tracking-tight sm:text-3xl" style={{ color: "#ffffff" }}>
              {orgWide ? "Command Center" : "My Dashboard"}
            </h1>
            <p className="mt-1.5 max-w-xl text-sm" style={{ color: "#e0e7ff" }}>
              {orgWide
                ? "Order Tracking is one real pipeline — Material Received through Dispatch Plan, every department's status visible at a glance."
                : "What's actually on your department's plate right now — not the whole company's order book."}
            </p>
          </div>
        </div>

        {isBdOnlyView ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Link to="/bd-planning/total-pos" className="block">
              <StatTile icon={ShoppingCart} label="Total POs" value={orders?.length ?? 0} accent="rose" />
            </Link>
            <Link to="/bd-planning/pending-pos" className="block">
              <StatTile icon={AlarmClock} label="Pending POs" value={pendingOrders.length} accent={pendingOrders.length ? "amber" : "slate"} />
            </Link>
            <Link to="/bd-planning/completed-pos" className="block">
              <StatTile icon={CheckCircle2} label="Completed POs" value={completedOrders.length} accent="emerald" />
            </Link>
            <Link to="/bd-planning/delayed-pos" className="block">
              <StatTile icon={AlarmClock} label="Pending POs — Delayed" value={delayedPendingOrders.length} accent={delayedPendingOrders.length ? "rose" : "slate"} />
            </Link>
            <Link to="/bd-planning/total-products" className="block">
              <StatTile icon={Beaker} label="Total Products" value={totalProducts} accent="brand" />
            </Link>
            <Link to="/bd-planning/pending-products" className="block">
              <StatTile icon={Beaker} label="Pending Products" value={pendingItems.length} accent="amber" />
            </Link>
            <Link to="/bd-planning/completed-products" className="block">
              <StatTile icon={Beaker} label="Completed Products" value={completedItems.length} accent="emerald" />
            </Link>
            <Link to="/bd-planning/active-products" className="block">
              <StatTile icon={Truck} label="Active Products in Production" value={activeProductionRows.length} accent="blue" />
            </Link>
          </div>
        ) : isPpicOnlyView ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Link to="/ppic-planning/total-pos" className="block">
              <StatTile icon={ShoppingCart} label="Total POs" value={orders?.length ?? 0} accent="rose" />
            </Link>
            <Link to="/ppic-planning/total-products" className="block">
              <StatTile icon={Beaker} label="Total Products" value={totalProducts} accent="brand" />
            </Link>
            <Link to="/ppic-planning/pending-pos" className="block">
              <StatTile icon={AlarmClock} label="Pending POs" value={pendingOrders.length} accent={pendingOrders.length ? "amber" : "slate"} />
            </Link>
            <Link to="/ppic-planning/have-bom" className="block">
              <StatTile icon={Package} label="Have Packaging BOM" value={itemsWithBom} accent="emerald" />
            </Link>
            <Link to="/ppic-planning/have-rm-bom" className="block">
              <StatTile icon={FlaskConical} label="Have RM BOM" value={itemsWithRecipe} accent="violet" />
            </Link>
            <Link to="/ppic-planning/missing-both" className="block">
              <StatTile icon={AlarmClock} label="Missing Packaging BOM & RM BOM" value={itemsMissingBoth} accent={itemsMissingBoth ? "rose" : "slate"} />
            </Link>
            <Link to="/ppic-planning/plan-sent" className="block">
              <StatTile icon={CheckCircle2} label="Plan Sent to Production" value={itemsPlanSent} accent="emerald" />
            </Link>
            <Link to="/ppic-planning/plan-not-sent" className="block">
              <StatTile icon={ClipboardList} label="Not Sent to Production" value={itemsPlanNotSent} accent={itemsPlanNotSent ? "amber" : "slate"} />
            </Link>
            <Link to="/material-consumption" className="block">
              <StatTile icon={PackageMinus} label="Products — Material Logged" value={materialUsageProductCount} accent="blue" />
            </Link>
          </div>
        ) : orgWide ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile icon={ShoppingCart} label="Purchase Orders" value={orders?.length ?? 0} accent="rose" />
            <StatTile icon={Beaker} label="Products" value={totalProducts} accent="brand" />
            <StatTile icon={Truck} label="Active Production" value={activeCount} accent="blue" />
            <StatTile icon={AlarmClock} label="Delayed" value={orgDelayed.length} accent="rose" />
            <StatTile icon={Package} label="BOM + RM Plans" value={(bomPlans?.length ?? 0) + (rmPlans?.length ?? 0)} accent="emerald" />
            <StatTile icon={Warehouse} label="Negative Stock" value={negativeStock} accent={negativeStock ? "rose" : "slate"} />
            {canSeePoReadiness && (
              <Link to="/po-readiness" className="block">
                <StatTile icon={CheckCircle2} label="POs Ready to Execute" value={readyPoCount} accent={readyPoCount ? "emerald" : "slate"} />
              </Link>
            )}
          </div>
        ) : isQcOnlyView ? (
          qcLoading || !qcData ? (
            <SkeletonRows rows={2} cols={5} />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <StatTile icon={PauseCircle} label="On Hold — Total" value={qcData.counts.onHoldTotal} accent="amber" />
                <StatTile icon={ArrowDownToLine} label="Material Received Hold" value={qcData.counts.onHoldReceiptQc} accent="amber" />
                <StatTile icon={Truck} label="FG Dispatch Hold" value={qcData.counts.onHoldDispatchQc} accent="amber" />
                <StatTile icon={ShieldAlert} label="QA Gate Mfg Hold" value={qcData.counts.onHoldMfgBatches} accent="amber" />
                <StatTile icon={ShieldAlert} label="QA Gate Packaging Hold" value={qcData.counts.onHoldPackBatches} accent="amber" />
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
                <StatTile icon={ClipboardCheck} label="Pending Receipt QC" value={qcData.counts.pendingReceiptQc} accent="slate" />
                <StatTile icon={ClipboardCheck} label="Pending Dispatch QC" value={qcData.counts.pendingDispatchQc} accent="slate" />
                <StatTile icon={Beaker} label="Pending Line Clearance" value={qcData.counts.pendingSampleQcBatches} accent="sky" />
                <StatTile icon={Beaker} label="Pending IPQC" value={qcData.counts.pendingIpqcBatches} accent="sky" />
                <StatTile icon={Beaker} label="Pending Bulk QC" value={qcData.counts.pendingBulkQcBatches} accent="sky" />
              </div>
            </>
          )
        ) : isPurchaseOnlyView ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Link to="/purchase-planning/total" className="block">
              <StatTile icon={ClipboardList} label="Total Requirements" value={purchaseStats.total} accent="brand" />
            </Link>
            <Link to="/purchase-planning/covered" className="block">
              <StatTile icon={CheckCircle2} label="Fully Covered" value={purchaseStats.covered} accent="emerald" />
            </Link>
            <Link to="/purchase-planning/shortfall" className="block">
              <StatTile icon={Package} label="Shortfalls" value={purchaseStats.shortfall} accent={purchaseStats.shortfall ? "amber" : "slate"} />
            </Link>
            <Link to="/purchase-planning/ordered" className="block">
              <StatTile icon={ShoppingCart} label="PO Logged" value={purchaseStats.ordered} accent="violet" />
            </Link>
          </div>
        ) : isRegulatoryOnlyView ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
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
        ) : isStoreOnlyView ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Link to="/inventory" className="block">
              <StatTile icon={ClipboardList} label="Awaiting You" value={myQueueRows.length} accent="blue" />
            </Link>
            <a href="#needs-attention" className="block">
              <StatTile icon={AlarmClock} label="Delayed (Yours)" value={myDelayed.length} accent="rose" />
            </a>
            <Link to="/store-planning/rm" className="block">
              <StatTile icon={Package} label="RM Stock (Items)" value={storeSummary?.rmItemCount ?? 0} accent="brand" />
            </Link>
            <Link to="/store-planning/pm" className="block">
              <StatTile icon={Package} label="PM Stock (Items)" value={storeSummary?.pmItemCount ?? 0} accent="violet" />
            </Link>
            {(storeSummary?.dayStores ?? []).map((ds) => (
              <Link key={ds.id} to={`/store-planning/store-${ds.id}`} className="block">
                <StatTile icon={Warehouse} label={`${ds.name} (Items)`} value={ds.itemCount} accent="blue" />
              </Link>
            ))}
            <Link to="/store-planning/fg" className="block">
              <StatTile icon={PackageCheck} label="FG Stock (Products)" value={storeSummary?.fgProductCount ?? 0} accent="emerald" />
            </Link>
            <Link to="/store-planning/quarantine" className="block">
              <StatTile icon={ShieldAlert} label="Quarantine Stock" value={storeSummary?.quarantineCount ?? 0} accent={storeSummary?.quarantineCount ? "amber" : "slate"} />
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile icon={ClipboardList} label="Awaiting You" value={myQueueRows.length} accent="blue" />
            <StatTile icon={AlarmClock} label="Delayed (Yours)" value={myDelayed.length} accent="rose" />
            {canSeeMaterialUsage && (
              <Link to="/material-consumption" className="block">
                <StatTile icon={PackageMinus} label="Products — Material Logged" value={materialUsageProductCount} accent="blue" />
              </Link>
            )}
            {canRnd && (
              <>
                <StatTile icon={Beaker} label="R&D Requests" value={rndOpenCatalogGaps.length} accent="violet" />
                <StatTile icon={AlarmClock} label="Requests Overdue" value={rndOverdueRequests.length} accent={rndOverdueRequests.length ? "rose" : "slate"} />
                <StatTile icon={FlaskConical} label="Awaiting Confirmation" value={rndAwaitingConfirmation.length} accent="brand" />
                <StatTile icon={ClipboardList} label="Sample Requests Pending" value={rndPendingSampleRequests?.length ?? 0} accent="amber" />
                <StatTile icon={CheckCircle2} label="Inward QC (yours)" value={pendingReceiptQc?.length ?? 0} accent="emerald" />
                <StatTile icon={Truck} label="Bulk QC / COA Pending" value={rndBulkQcCount} accent="blue" />
                <StatTile icon={Package} label="Catalog Size" value={`${rndRecipes?.length ?? 0} recipes · ${rndSkuCount ?? 0} SKUs`} accent="slate" />
              </>
            )}
          </div>
        )}

        {orgWide && (
          <div className="card p-5 sm:p-6">
            <h2 className="mb-4 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              <Sparkles className="h-3.5 w-3.5" /> Production Flow — where everything is right now
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
              {stageCounts.map((s, idx) => {
                const color = FLOW_COLOR[s.accent]!;
                return (
                  <div key={s.label} className="relative">
                    <div className="flex items-center justify-between">
                      <p className="text-[10.5px] font-bold uppercase tracking-wide text-slate-500">{s.label}</p>
                      <p className="text-lg font-black text-slate-900">{s.count}</p>
                    </div>
                    <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <div className={`h-full rounded-full bg-gradient-to-r ${color.fill} transition-all duration-500`} style={{ width: `${Math.max(6, (s.count / maxCount) * 100)}%` }} />
                    </div>
                    {idx < stageCounts.length - 1 && <span className={`absolute -right-[7px] top-[26px] hidden h-2 w-2 rounded-full ring-2 ring-white sm:block ${color.dot}`} />}
                  </div>
                );
              })}
            </div>
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
                <Link to="/purchase-orders" className="text-[10px] font-bold text-brand-600 hover:underline">
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
                        <p className="text-slate-400">{po.customer.companyName}</p>
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

        {isQcOnlyView && qcData && <QcChecklistSections data={qcData} />}
      </div>

      {/* Right rail — profile, quick actions, needs-attention, all sticky */}
      <aside className="space-y-4 lg:order-1 lg:sticky lg:top-[6.5rem]">
        <div className="card relative overflow-hidden p-5">
          <div className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-brand-100/70 blur-2xl" />
          <div className="relative flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900 text-sm font-black text-white shadow-glow shadow-brand-500/40">
              {initials(displayName)}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-black text-slate-900">{displayName}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {(user?.roles.length ? user.roles : ["No roles"]).map((r) => (
                  <span key={r} className="rounded border border-brand-200 bg-brand-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-700">
                    {r}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

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
      </aside>
    </div>
  );
}

// The full per-checkpoint breakdown that used to live at its own
// /qc-dashboard route — folded into QC's own "/" view instead, since it
// was just showing the same on-hold/pending work the generic "Your
// Queue" list already covered, in a second, separately-navigated page.
// Every action here is the exact same mutation the Inventory page's own
// cards use (ReceivedCard/FgTransferCard, reused directly, not forked);
// production rows link out to the run/lot itself since a QA gate's
// fields go through the pipeline's own stage form, not a one-field
// approve/reject.
function QcChecklistSections({ data }: { data: QcDashboard }) {
  const { hasRole } = useAuth();
  const canQc = hasRole("QA_QC");
  const canWrite = hasRole("STORE");
  const canDispatch = hasRole("DISPATCH");
  const canInvoice = hasRole("ACCOUNTS");

  return (
    <>
      <Section title="Material Received" icon={ArrowDownToLine}>
        {!data.receipts.onHold.length && !data.receipts.pending.length ? (
          <EmptyState icon={ArrowDownToLine} title="Nothing waiting" hint="Every Material Received entry has been reviewed." accent="brand" />
        ) : (
          <div className="space-y-3">
            {[...data.receipts.onHold, ...data.receipts.pending].map((t) => (
              <ReceivedCard key={t.id} txn={t} canQc={canQc} canWrite={canWrite} />
            ))}
          </div>
        )}
      </Section>

      <Section title="FG Dispatch" icon={Truck}>
        {!data.dispatches.onHold.length && !data.dispatches.pending.length ? (
          <EmptyState icon={Truck} title="Nothing waiting" hint="Every FG transfer has cleared outward QC." accent="brand" />
        ) : (
          <div className="space-y-3">
            {[...data.dispatches.onHold, ...data.dispatches.pending].map((d) => (
              <FgTransferCard key={d.id} transfer={d} canQc={canQc} canWrite={canWrite} canDispatch={canDispatch} canInvoice={canInvoice} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Line Clearance — Bulk Manufacturing, before Production" icon={Beaker}>
        {!data.batches.pendingSampleQc.length ? (
          <EmptyState icon={Beaker} title="Nothing waiting" hint="No run is sitting at Line Clearance right now." accent="brand" />
        ) : (
          <div className="space-y-2">
            {data.batches.pendingSampleQc.map((r) => (
              <QcGateRow key={r.id} {...qcPreProductionRow(r, r.sampleQcStatus, r.sampleQcRemarks)} />
            ))}
          </div>
        )}
      </Section>

      <Section title="In-Process QA (IPQC)" icon={Beaker}>
        {!data.batches.pendingIpqc.length ? (
          <EmptyState icon={Beaker} title="Nothing waiting" hint="No lot is sitting at IPQC right now." accent="brand" />
        ) : (
          <div className="space-y-2">
            {data.batches.pendingIpqc.map((l) => (
              <QcGateRow key={l.id} {...qcCombinedLotRow(l, l.ipqcStatus, l.ipqcRemarks)} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Bulk QC — before Packaging" icon={Beaker}>
        {!data.batches.pendingBulkQc.length ? (
          <EmptyState icon={Beaker} title="Nothing waiting" hint="No lot is sitting at Bulk QC right now." accent="brand" />
        ) : (
          <div className="space-y-2">
            {data.batches.pendingBulkQc.map((l) => (
              <QcGateRow key={l.id} {...qcCombinedLotRow(l, l.bulkQcStatus, l.bulkQcRemarks)} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Lots held at a QA Gate" icon={ShieldAlert}>
        {!data.batches.onHoldMfg.length && !data.batches.onHoldPack.length ? (
          <EmptyState icon={ShieldAlert} title="No lots on hold" hint="Nothing is parked at either QA gate right now." accent="brand" />
        ) : (
          <div className="space-y-2">
            {[...data.batches.onHoldMfg, ...data.batches.onHoldPack].map((l) => (
              <QcGateRow key={l.id} {...qcHoldRow(l)} />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof ArrowDownToLine; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-slate-400" strokeWidth={2.5} />
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">{title}</h2>
      </div>
      {children}
    </div>
  );
}

interface QcGateRowData {
  link: string;
  productName: string;
  poNumber: string | null;
  customerName: string;
  subtitle?: string;
  status: string | null;
  note: string | null;
  hold: boolean;
}

function qcPreProductionRow(r: PreProduction, status: string | null, note: string | null): QcGateRowData {
  return { link: `/pre-productions/${r.id}`, productName: r.purchaseOrderItem.productName, poNumber: r.purchaseOrderItem.purchaseOrder.poNumber, customerName: r.purchaseOrderItem.purchaseOrder.customer.companyName, status, note, hold: status === "Hold" };
}

function qcCombinedLotRow(l: CombinedLot, status: string | null, note: string | null): QcGateRowData {
  const item = l.preProduction.purchaseOrderItem;
  return { link: `/combined-lots/${l.id}`, productName: item.productName, poNumber: item.purchaseOrder.poNumber, customerName: item.purchaseOrder.customer.companyName, status, note, hold: status === "Hold" };
}

// Used for the "on hold" section, where the status is whichever of the
// gate's two fields (QA/QC) actually reads Hold, and the subtitle names
// the gate itself since both QA gates share this one row shape.
function qcHoldRow(l: CombinedLot): QcGateRowData {
  const status = l.currentStageId === "QA_GATE_MFG" ? (l.mfgQaStatus ?? l.mfgQcStatus) : (l.packQaStatus ?? l.packQcStatus);
  const note = l.currentStageId === "QA_GATE_MFG" ? l.mfgRemarks : l.packRemarks;
  const item = l.preProduction.purchaseOrderItem;
  return {
    link: `/combined-lots/${l.id}`,
    productName: item.productName,
    poNumber: item.purchaseOrder.poNumber,
    customerName: item.purchaseOrder.customer.companyName,
    subtitle: QC_GATE_LABEL[l.currentStageId] ?? l.currentStageId,
    status,
    note,
    hold: true,
  };
}

// Every row here needs QC's attention — unlike a plain hold list,
// there's no separate "pending vs held" split for the three hard-gate
// stages (Line Clearance, IPQC, Bulk QC): anything other than a literal
// "Approved" blocks the next stage, so a run that just arrived with no
// status set yet is exactly as much "waiting on QC" as one already
// marked Hold — the badge reflects that with a neutral "Awaiting
// Review" default instead of assuming a hold.
// Tailwind classes as static strings, not string-interpolated — a
// dynamic `border-${color}-300` never survives the build's class scan.
const QC_GATE_ROW_STYLE = {
  orange: { hover: "hover:border-orange-300 hover:bg-orange-50/40", pill: "border-orange-200 bg-orange-50 text-orange-700", dot: "bg-orange-500" },
  rose: { hover: "hover:border-rose-300 hover:bg-rose-50/40", pill: "border-rose-200 bg-rose-50 text-rose-700", dot: "bg-rose-500" },
  sky: { hover: "hover:border-sky-300 hover:bg-sky-50/40", pill: "border-sky-200 bg-sky-50 text-sky-700", dot: "bg-sky-500" },
} as const;

function QcGateRow({ link, productName, poNumber, customerName, subtitle, status, note, hold }: QcGateRowData) {
  const style = QC_GATE_ROW_STYLE[hold ? "orange" : status === "Not Approved" ? "rose" : "sky"];
  return (
    <Link to={link} className={`card flex flex-wrap items-center gap-3 p-4 transition sm:p-5 ${style.hover}`}>
      <div className="min-w-0 flex-1">
        <p className="font-bold text-slate-800">{productName}</p>
        <p className="mt-1 text-xs text-slate-500">
          {poNumber ?? "No PO number"} · {customerName}
          {subtitle && ` · ${subtitle}`}
        </p>
        {note && <p className="mt-1 text-xs text-slate-400">{note}</p>}
      </div>
      <span className={`pill ${style.pill}`}>
        <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} /> {status ?? "Awaiting Review"}
      </span>
    </Link>
  );
}
