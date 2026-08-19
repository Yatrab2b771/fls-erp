import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { FlaskConical, LayoutDashboard, LogOut, Menu, Microscope, Package, ShieldCheck, Truck, Warehouse, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import type { RoleName } from "../lib/types";

// Order Tracking is the whole pipeline now (PO intake through Dispatch,
// one flow per batch — see BatchDetailPage), so it stays visible to
// everyone; every department has a real, gated action somewhere in a
// batch's stages. Packaging BOM and RM Costing are PPIC/Purchase/BD
// planning tools — STORE/ACCOUNTS/PRODUCTION/QA_QC/DISPATCH have zero
// role-gated actions in either, so the tab is just noise for them. This
// hides the tab only — the API underneath stays open to any authenticated
// user (unchanged), so nothing is actually inaccessible, just decluttered.
// Inventory is different: the API itself is locked to STORE/ADMIN (it's
// the Warehouse department's own tool, not a company-wide view), so the
// tab is hidden the same way, not just decluttered.
const TABS: { to: string; label: string; icon: typeof Truck; roles?: RoleName[]; end?: boolean }[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/purchase-orders", label: "Order Tracking", icon: Truck },
  { to: "/inventory", label: "Inventory", icon: Warehouse, roles: ["STORE"] },
  { to: "/packaging-bom", label: "Packaging BOM", icon: Package, roles: ["PPIC", "PURCHASE"] },
  { to: "/rm-costing", label: "RM Costing", icon: FlaskConical, roles: ["PPIC", "BD"] },
  { to: "/users", label: "Users", icon: ShieldCheck, roles: ["ADMIN"] },
];

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  const chars = parts.length > 1 ? [parts[0]?.[0], parts[parts.length - 1]?.[0]] : [parts[0]?.[0], parts[0]?.[1]];
  return chars.filter(Boolean).join("").toUpperCase();
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout, hasRole } = useAuth();
  const location = useLocation();
  const visibleTabs = TABS.filter((tab) => !tab.roles || hasRole(...tab.roles));
  const displayName = user?.fullName ?? user?.email ?? "";

  // Off-canvas on mobile/tablet, fixed-open on desktop — closed by default
  // so a small screen never loads with the drawer already covering content.
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => setMobileOpen(false), [location.pathname]);

  const activeTab = [...visibleTabs].sort((a, b) => b.to.length - a.to.length).find((t) => (t.end ? location.pathname === t.to : location.pathname.startsWith(t.to)));

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Ambient wash — a couple of soft, static brand-tinted glows behind
          the whole app so the light theme reads as considered rather than
          flat, without tipping into a dark or busy surface. */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full blur-3xl" style={{ backgroundColor: "rgba(99,102,241,0.08)" }} />
        <div className="absolute -right-24 top-1/3 h-80 w-80 rounded-full blur-3xl" style={{ backgroundColor: "rgba(167,139,250,0.07)" }} />
      </div>

      {mobileOpen && <div className="fixed inset-0 z-40 bg-slate-900/30 backdrop-blur-[2px] lg:hidden" onClick={() => setMobileOpen(false)} />}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 shrink-0 flex-col border-r border-slate-200/70 bg-white/90 backdrop-blur-xl transition-transform duration-300 ease-out lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-16 items-center gap-2.5 border-b border-slate-100 px-5">
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900 shadow-[0_4px_14px_-3px_rgba(79,70,229,.55),inset_0_1px_0_rgba(255,255,255,.2)]">
            <div className="absolute inset-0 -z-10 rounded-xl bg-brand-500 opacity-40 blur-md" />
            <Microscope className="h-4.5 w-4.5 text-white" strokeWidth={2} />
          </div>
          <div>
            <p className="text-sm font-black leading-none tracking-tight text-slate-900">FLS ERP</p>
            <p className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.15em] text-brand-600">Enterprise Platform</p>
          </div>
          <button className="btn-icon ml-auto lg:hidden" onClick={() => setMobileOpen(false)}>
            <X className="h-4 w-4" strokeWidth={2.25} />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {visibleTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  `group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-bold transition-all duration-150 ${
                    isActive ? "bg-gradient-to-r from-brand-50 to-transparent text-brand-700" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-gradient-to-b from-brand-500 to-brand-700 shadow-[0_0_8px_rgba(79,70,229,.5)]" />}
                    <Icon className={`h-4 w-4 shrink-0 transition-colors ${isActive ? "text-brand-600" : "text-slate-400 group-hover:text-slate-600"}`} strokeWidth={2.25} />
                    <span className="truncate">{tab.label}</span>
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-slate-100 p-3">
          <div className="flex items-center gap-2.5 rounded-xl p-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 text-xs font-black text-white shadow-soft">
              {initials(displayName)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold leading-tight text-slate-800">{displayName}</p>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {(user?.roles.length ? user.roles : ["No roles"]).map((r) => (
                  <span key={r} className="rounded border border-brand-200 bg-brand-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-700">
                    {r}
                  </span>
                ))}
              </div>
            </div>
            <button onClick={logout} className="btn-icon shrink-0 hover:!bg-rose-50 hover:!text-rose-600" title="Log out">
              <LogOut className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>
        </div>
      </aside>

      <div className="lg:pl-72">
        <div className="glass sticky top-0 z-30 flex h-16 items-center gap-3 px-4 shadow-soft md:px-6">
          <button className="btn-icon lg:hidden" onClick={() => setMobileOpen(true)}>
            <Menu className="h-5 w-5" strokeWidth={2.25} />
          </button>
          <p className="text-sm font-black tracking-tight text-slate-900">{activeTab?.label ?? "FLS ERP"}</p>
        </div>

        <main className="mx-auto max-w-[1600px] p-4 md:p-6 xl:p-8">
          <div key={location.pathname} className="animate-fade-in">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
