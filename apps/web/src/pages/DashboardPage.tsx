import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlarmClock, Beaker, CheckCircle2, ClipboardList, FlaskConical, Package, ShoppingCart, Sparkles, Truck, Warehouse } from "lucide-react";
import { useAuth } from "../lib/auth";
import {
  useCombinedLots,
  useBomPlans,
  useDispatchTransfers,
  useInventoryRequests,
  useInventoryStock,
  useInventoryTransactions,
  usePoReadiness,
  usePreProductions,
  usePurchaseOrders,
  useRecipeRequests,
  useRmPlans,
  useRndSampleRequests,
  useRndTransfers,
} from "../lib/hooks";
import { PRE_PRODUCTION_STAGE_ROLE } from "../lib/preProductionStage";
import { COMBINED_LOT_STAGE_ROLE } from "../lib/combinedLotStage";
import { StatTile } from "../components/StatTile";
import { DelayBadge, RequestStatusBadge, StageBadge } from "../components/Badges";
import type { CombinedLotStageId, PreProduction, PreProductionStageId } from "../lib/types";

type AnyStageId = PreProductionStageId | CombinedLotStageId;

// The pipeline's 12 stages across both tiers, grouped into 5 visual
// phases so the stepper reads as one clean flow instead of 12 cramped
// nodes. LINE_CLEARANCE/IPQC/BULK_QC are the three extra QC checkpoints
// added against the client's Production Process Flow doc.
const FLOW_STAGES: { label: string; stages: AnyStageId[]; accent: string }[] = [
  { label: "Procurement", stages: ["MATERIAL_RECEIVED"], accent: "amber" },
  { label: "Planning", stages: ["INDENT_ISSUE", "LINE_CLEARANCE"], accent: "slate" },
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

  const allPreRuns = preRuns ?? [];
  const allLots = lots ?? [];

  // Production actionable by this department right now, sitting at a
  // stage this role owns. DISPATCH_PLAN is terminal (nothing comes after
  // it), and a PreProduction run that's already Approved has nothing
  // left for this tier either — both excluded from every department's
  // queue once reached.
  const myQueuePreRuns = allPreRuns.filter((r) => isPreProductionPending(r) && hasRole(...PRE_PRODUCTION_STAGE_ROLE[r.currentStageId]));
  const myQueueLots = allLots.filter((l) => l.currentStageId !== "DISPATCH_PLAN" && hasRole(...COMBINED_LOT_STAGE_ROLE[l.currentStageId]));

  // Inventory has its own queue of department-owned work that isn't a
  // pipeline stage at all — QA/QC's inward/outward QC checks, and
  // Store's request review / issue / accept steps. Without this, those
  // roles' "Your Queue" only ever showed production work, even though
  // Inventory had real items waiting on them.
  const canQc = !orgWide && hasRole("QA_QC");
  const canReviewInventory = !orgWide && hasRole("STORE");
  // R&D shares inward QC with QA/QC (PATCH /transactions/:id/qc), but not
  // outward FG dispatch QC — so it folds into the same inward-QC fetch
  // below rather than getting its own, and never touches pendingDispatchQc.
  const canRnd = !orgWide && hasRole("RND");
  const { data: pendingReceiptQc } = useInventoryTransactions({ type: "RECEIVED", receiptStatus: "PENDING_QC" }, { enabled: canQc || canRnd });
  const { data: pendingDispatchQc } = useDispatchTransfers({ type: "FG", qcStatus: "PENDING_QC" }, { enabled: canQc });
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

  const pendingQcPill = <span className="pill border-amber-200 bg-amber-50 text-amber-700">Pending QC</span>;
  const inventoryRows: QueueRow[] = [
    ...(pendingReceiptQc ?? []).map((t) => ({ key: `rqc-${t.id}`, to: "/inventory", title: t.item.name, subtitle: `Inward QC · ${t.quantity} ${t.unit}`, badge: pendingQcPill })),
    ...(pendingDispatchQc ?? []).map((d) => ({ key: `dqc-${d.id}`, to: "/inventory", title: d.productName, subtitle: `Outward QC · ${d.customer.companyName}`, badge: pendingQcPill })),
    ...(pendingMaterialRequests ?? []).map((r) => ({ key: `req-${r.id}`, to: "/inventory", title: r.item.name, subtitle: `Review request · ${r.requestedQty}`, badge: <RequestStatusBadge status={r.status} /> })),
    ...(approvedMaterialRequests ?? []).map((r) => ({ key: `iss-${r.id}`, to: "/inventory", title: r.item.name, subtitle: `Issue stock · ${r.requestedQty}`, badge: <RequestStatusBadge status={r.status} /> })),
    ...(qcApprovedReceipts ?? []).map((t) => ({ key: `acc-${t.id}`, to: "/inventory", title: t.item.name, subtitle: `Accept into stock · ${t.quantity} ${t.unit}`, badge: <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">QC Approved</span> })),
  ];

  const rndPill = <span className="pill border-violet-200 bg-violet-50 text-violet-700">R&D</span>;
  const rndOpenCatalogGaps = (rndCatalogGaps ?? []).filter((r) => r.status !== "READY");
  const rndAwaitingConfirmation = (rndPendingTransfers ?? []).filter((t) => t.direction === "TO_RND");
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

  const myQueueRows = [...preRunRows, ...lotRows, ...inventoryRows, ...rndRows];

  const totalProducts = orders?.reduce((sum, po) => sum + po.items.length, 0) ?? 0;
  // "Active" = a run still short of its own terminal gate, or a lot not
  // yet at Dispatch Plan — same completion definition
  // purchase-orders.routes.ts's computeCompletion uses.
  const activeCount = allPreRuns.filter(isPreProductionPending).length + allLots.filter((l) => l.currentStageId !== "DISPATCH_PLAN").length;
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
      allLots.filter((l) => group.stages.includes(l.currentStageId)).length,
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

        {orgWide ? (
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
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile icon={ClipboardList} label="Awaiting You" value={myQueueRows.length} accent="blue" />
            <StatTile icon={AlarmClock} label="Delayed (Yours)" value={myDelayed.length} accent="rose" />
            {canRnd && (
              <>
                <StatTile icon={Beaker} label="R&D Requests" value={rndOpenCatalogGaps.length} accent="violet" />
                <StatTile icon={FlaskConical} label="Awaiting Confirmation" value={rndAwaitingConfirmation.length} accent="brand" />
                <StatTile icon={ClipboardList} label="Sample Requests Pending" value={rndPendingSampleRequests?.length ?? 0} accent="amber" />
                <StatTile icon={CheckCircle2} label="Inward QC (yours)" value={pendingReceiptQc?.length ?? 0} accent="emerald" />
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

        <div className="card overflow-hidden">
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
