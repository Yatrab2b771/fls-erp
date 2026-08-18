import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { FlaskConical, LayoutDashboard, LogOut, Microscope, Package, ShieldCheck, Truck, Warehouse } from "lucide-react";
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

  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="glass sticky top-0 z-40 flex h-16 items-center justify-between px-4 shadow-soft md:px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900 shadow-[0_4px_14px_-3px_rgba(79,70,229,.55),inset_0_1px_0_rgba(255,255,255,.2)]">
            <Microscope className="h-4.5 w-4.5 text-white" strokeWidth={2} />
          </div>
          <div className="hidden sm:block">
            <p className="text-sm font-black leading-none tracking-tight text-slate-900">FLS ERP</p>
            <p className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.15em] text-brand-600">Enterprise Platform</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden text-right sm:block">
            <p className="text-xs font-bold leading-tight text-slate-800">{displayName}</p>
            <div className="mt-0.5 flex flex-wrap justify-end gap-1">
              {(user?.roles.length ? user.roles : ["No roles"]).map((r) => (
                <span key={r} className="rounded border border-brand-200 bg-brand-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-700">
                  {r}
                </span>
              ))}
            </div>
          </div>
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 text-xs font-black text-white shadow-soft">
            {initials(displayName)}
          </div>
          <button onClick={logout} className="btn-icon hover:!bg-rose-50 hover:!text-rose-600" title="Log out">
            <LogOut className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
      </nav>

      <div className="glass sticky top-16 z-30 px-4 py-2.5 md:px-6">
        <div className="scrollbar-none flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-slate-100/80 p-1">
          {visibleTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  `flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-bold transition-all duration-150 sm:px-4 ${
                    isActive ? "bg-white text-slate-900 shadow-soft" : "text-slate-500 hover:text-slate-800"
                  }`
                }
              >
                <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
                <span className="truncate">{tab.label}</span>
              </NavLink>
            );
          })}
        </div>
      </div>

      <main className="mx-auto max-w-[1600px] p-4 md:p-6 xl:p-8">
        <div key={location.pathname} className="animate-fade-in">
          {children}
        </div>
      </main>
    </div>
  );
}
