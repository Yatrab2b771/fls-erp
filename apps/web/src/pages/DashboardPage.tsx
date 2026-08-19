import { Link } from "react-router-dom";
import { AlarmClock, ArrowRight, Beaker, ClipboardList, FlaskConical, Package, ShoppingCart, Sparkles, Truck, Warehouse } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useBatches, useBomPlans, useInventoryStock, usePurchaseOrders, useRmPlans } from "../lib/hooks";
import { BATCH_STAGE_ROLE } from "../lib/batchStage";
import { StatTile } from "../components/StatTile";
import { DelayBadge, StageBadge } from "../components/Badges";
import type { BatchStageId } from "../lib/types";

// The pipeline's 10 stages, grouped into 5 visual phases so the stepper
// reads as one clean flow instead of 10 cramped nodes.
const FLOW_STAGES: { label: string; stages: BatchStageId[]; accent: string }[] = [
  { label: "Procurement", stages: ["PO_RELEASE", "MATERIAL_RECEIVED"], accent: "amber" },
  { label: "Planning", stages: ["INDENT_ISSUE"], accent: "slate" },
  { label: "Manufacturing", stages: ["DISPENSING", "PRODUCTION_EXECUTION", "QA_GATE_MFG"], accent: "blue" },
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
  const { data: batches } = useBatches();
  const { data: bomPlans } = useBomPlans();
  const { data: rmPlans } = useRmPlans();
  const { data: stock } = useInventoryStock();

  // ADMIN, BD and PPIC run the whole order book (BD creates orders, PPIC
  // plans every batch off of them) — everyone else's job is a specific
  // production stage, so their dashboard is scoped to "batches currently
  // waiting on my department", not the full company view. hasRole()'s
  // ADMIN bypass still applies underneath this, but this is a deliberate
  // narrower *default view* for the other six departments.
  const orgWide = hasRole("ADMIN", "BD", "PPIC");

  const allBatches = batches ?? [];
  // Batches actionable by this department right now (not yet dispatched,
  // sitting at a stage this role owns).
  const myQueueBatches = allBatches.filter((b) => b.currentStageId !== "DISPATCH_PLAN" && hasRole(BATCH_STAGE_ROLE[b.currentStageId]));

  const totalProducts = orders?.reduce((sum, po) => sum + po.items.length, 0) ?? 0;
  const activeBatches = allBatches.filter((b) => b.currentStageId !== "DISPATCH_PLAN").length;
  const orgDelayed = allBatches.filter((b) => b.delay.isDelayed);
  const myDelayed = myQueueBatches.filter((b) => b.delay.isDelayed);
  const negativeStock = stock?.filter((s) => s.onHand < 0).length ?? 0;

  const stageCounts = FLOW_STAGES.map((group) => ({
    ...group,
    count: allBatches.filter((b) => group.stages.includes(b.currentStageId)).length,
  }));
  const maxCount = Math.max(1, ...stageCounts.map((s) => s.count));

  const recentOrders = [...(orders ?? [])].slice(0, 5);
  const attentionBatches = orgWide ? orgDelayed : myDelayed;
  const displayName = user?.fullName ?? user?.email ?? "";

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[312px_1fr] xl:grid-cols-[340px_1fr]">
      {/* Main column */}
      <div className="min-w-0 space-y-5 lg:order-2">
        {/* Light "premium" hero — a white card carrying a low-opacity brand
            gradient mesh + soft glow blobs, rather than a solid dark panel.
            Plain hex-stop inline gradients (not Tailwind's CSS-custom-
            property gradient utilities) — some browser color/theme
            extensions reset --tw-gradient-* custom properties and wash a
            Tailwind gradient out, which a literal `background` value isn't
            subject to. */}
        <div className="relative overflow-hidden rounded-2xl border border-slate-200/70 bg-white p-6 shadow-lift sm:p-8">
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.07]"
            style={{ backgroundImage: "linear-gradient(135deg, #4338ca 0%, #7c3aed 50%, #4338ca 100%)" }}
          />
          <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full blur-3xl" style={{ backgroundColor: "rgba(99,102,241,0.16)" }} />
          <div className="pointer-events-none absolute -bottom-24 left-1/4 h-56 w-56 rounded-full blur-3xl" style={{ backgroundColor: "rgba(167,139,250,0.12)" }} />
          <div className="relative">
            <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.15em] text-brand-600">
              <Sparkles className="h-3.5 w-3.5" /> {greeting()}, {displayName.split(" ")[0] || "there"}
            </p>
            <h1 className="mt-1.5 text-2xl font-black tracking-tight text-slate-900 sm:text-3xl">{orgWide ? "Command Center" : "My Dashboard"}</h1>
            <p className="mt-1.5 max-w-xl text-sm text-slate-500">
              {orgWide
                ? "Order Tracking is one real pipeline — PO Release through Dispatch Plan, every department's status visible at a glance."
                : "What's actually on your department's plate right now — not the whole company's order book."}
            </p>
          </div>
        </div>

        {orgWide ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile icon={ShoppingCart} label="Purchase Orders" value={orders?.length ?? 0} accent="rose" />
            <StatTile icon={Beaker} label="Products" value={totalProducts} accent="brand" />
            <StatTile icon={Truck} label="Active Batches" value={activeBatches} accent="blue" />
            <StatTile icon={AlarmClock} label="Delayed" value={orgDelayed.length} accent="rose" />
            <StatTile icon={Package} label="BOM + RM Plans" value={(bomPlans?.length ?? 0) + (rmPlans?.length ?? 0)} accent="emerald" />
            <StatTile icon={Warehouse} label="Negative Stock" value={negativeStock} accent={negativeStock ? "rose" : "slate"} />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile icon={ClipboardList} label="Awaiting You" value={myQueueBatches.length} accent="blue" />
            <StatTile icon={AlarmClock} label="Delayed (Yours)" value={myDelayed.length} accent="rose" />
          </div>
        )}

        {orgWide && (
          <div className="card p-5 sm:p-6">
            <h2 className="mb-4 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              <Sparkles className="h-3.5 w-3.5" /> Production Flow — where every batch is right now
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
                      <div
                        className={`h-full rounded-full bg-gradient-to-r ${color.fill} transition-all duration-500`}
                        style={{ width: `${Math.max(6, (s.count / maxCount) * 100)}%` }}
                      />
                    </div>
                    {idx < stageCounts.length - 1 && (
                      <span className={`absolute -right-[7px] top-[26px] hidden h-2 w-2 rounded-full ring-2 ring-white sm:block ${color.dot}`} />
                    )}
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
          ) : myQueueBatches.length === 0 ? (
            <p className="p-6 text-center text-xs text-slate-400">Nothing waiting on your department right now.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {myQueueBatches.slice(0, 6).map((b) => (
                <Link key={b.id} to={`/batches/${b.id}`} className="flex items-center justify-between px-4 py-3 text-xs transition-all duration-200 hover:bg-slate-50 hover:pl-5 hover:shadow-[inset_2px_0_0_theme(colors.brand.500)]">
                  <div>
                    <p className="font-bold text-slate-700">{b.batchNo ?? b.id.slice(0, 8)}</p>
                    <p className="text-slate-400">{b.purchaseOrderItem.productName}</p>
                  </div>
                  <StageBadge stage={b.currentStageId} />
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

        <div className="card p-4">
          <h3 className="mb-3 px-1 text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Quick Actions</h3>
          <div className="space-y-1.5">
            {hasRole("BD") && <QuickAction to="/purchase-orders" icon={ShoppingCart} label="New Purchase Order" accent="rose" />}
            {hasRole("STORE") && <QuickAction to="/inventory" icon={Warehouse} label="Log Inventory Entry" accent="brand" />}
            {hasRole("PPIC", "PURCHASE") && <QuickAction to="/packaging-bom" icon={Package} label="Packaging BOM" accent="emerald" />}
            {hasRole("PPIC", "BD") && <QuickAction to="/rm-costing" icon={FlaskConical} label="RM Costing" accent="violet" />}
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-4 py-3">
            <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-500">
              <AlarmClock className="h-3.5 w-3.5" /> Needs Attention
            </h3>
            {attentionBatches.length > 0 && <span className="pill border-rose-200 bg-rose-50 text-rose-700">{attentionBatches.length}</span>}
          </div>
          {attentionBatches.length === 0 ? (
            <p className="p-5 text-center text-xs text-slate-400">
              {orgWide ? "Nothing delayed right now." : "Nothing delayed in your queue."}
            </p>
          ) : (
            <div className="divide-y divide-slate-100">
              {attentionBatches.slice(0, 5).map((b) => (
                <Link key={b.id} to={`/batches/${b.id}`} className="block px-4 py-2.5 text-xs transition-all duration-200 hover:bg-slate-50 hover:pl-5 hover:shadow-[inset_2px_0_0_theme(colors.rose.500)]">
                  <p className="truncate font-bold text-slate-700">{b.batchNo ?? b.id.slice(0, 8)}</p>
                  <p className="truncate text-slate-400">{b.purchaseOrderItem.productName}</p>
                  <div className="mt-1">
                    <DelayBadge delay={b.delay} />
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

const ACCENT_ICON: Record<string, string> = {
  brand: "bg-brand-50 text-brand-600 group-hover:bg-brand-100",
  emerald: "bg-emerald-50 text-emerald-600 group-hover:bg-emerald-100",
  rose: "bg-rose-50 text-rose-600 group-hover:bg-rose-100",
  violet: "bg-violet-50 text-violet-600 group-hover:bg-violet-100",
};

function QuickAction({ to, icon: Icon, label, accent }: { to: string; icon: typeof ShoppingCart; label: string; accent: keyof typeof ACCENT_ICON }) {
  return (
    <Link to={to} className="group flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-slate-50">
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${ACCENT_ICON[accent]}`}>
        <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
      </div>
      <p className="flex-1 text-[12.5px] font-bold text-slate-700">{label}</p>
      <ArrowRight className="h-3.5 w-3.5 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-slate-500" strokeWidth={2.5} />
    </Link>
  );
}
