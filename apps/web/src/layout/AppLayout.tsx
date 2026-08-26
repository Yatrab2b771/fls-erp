import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Bell, CheckCircle2, ChevronDown, ClipboardList, FlaskConical, LayoutDashboard, LogOut, Menu, Microscope, Package, ShieldCheck, Truck, Warehouse, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { formatEmployeeId } from "../lib/format";
import { useMarkAllNotificationsRead, useMarkNotificationRead, useNotifications } from "../lib/hooks";
import type { AppNotification, RoleName } from "../lib/types";

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

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
// tab is hidden the same way, not just decluttered. PPIC and QA_QC also
// get in now, but only for their own narrow slice (Material Requests;
// inward/outward QC) — the API still blocks both from the full
// received/issued ledger and dispatch log (see inventory.routes.ts),
// the page just adapts what it shows per role.
const TABS: { to: string; label: string; icon: typeof Truck; roles?: RoleName[]; end?: boolean }[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/purchase-orders", label: "Order Tracking", icon: Truck },
  { to: "/pre-inventory", label: "Pre-Inventory", icon: ClipboardList, roles: ["PPIC", "STORE", "PURCHASE", "ACCOUNTS", "PRODUCTION"] },
  { to: "/po-readiness", label: "PO Readiness", icon: CheckCircle2, roles: ["PPIC"] },
  { to: "/inventory", label: "Inventory", icon: Warehouse, roles: ["STORE", "PPIC", "QA_QC", "DISPATCH", "ACCOUNTS"] },
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
  const navigate = useNavigate();
  const visibleTabs = TABS.filter((tab) => !tab.roles || hasRole(...tab.roles));
  const displayName = user?.fullName ?? user?.email ?? "";

  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  const { data: notifData } = useNotifications();
  const notifications = notifData?.notifications ?? [];
  const unreadCount = notifData?.unreadCount ?? 0;
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  useEffect(() => {
    setMobileOpen(false);
    setProfileOpen(false);
    setNotifOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!profileOpen) return;
    function onClick(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) setProfileOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [profileOpen]);

  useEffect(() => {
    if (!notifOpen) return;
    function onClick(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [notifOpen]);

  function handleNotifClick(n: AppNotification) {
    if (!n.readAt) markRead.mutate(n.id);
    setNotifOpen(false);
    if (n.link) navigate(n.link);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Ambient wash — a couple of soft, static brand-tinted glows behind
          the whole app so the light theme reads as considered rather than
          flat, without tipping into a dark or busy surface. */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full blur-3xl" style={{ backgroundColor: "rgba(99,102,241,0.06)" }} />
        <div className="absolute -right-24 top-1/3 h-80 w-80 rounded-full blur-3xl" style={{ backgroundColor: "rgba(167,139,250,0.05)" }} />
      </div>

      <nav className="glass sticky top-0 z-40 shadow-soft">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-3 px-4 md:px-6">
          <div className="flex items-center gap-2.5">
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900 shadow-[0_4px_14px_-3px_rgba(79,70,229,.55),inset_0_1px_0_rgba(255,255,255,.2)]">
              <div className="absolute inset-0 -z-10 rounded-xl bg-brand-500 opacity-40 blur-md" />
              <Microscope className="h-4.5 w-4.5 text-white" strokeWidth={2} />
            </div>
            <div className="hidden sm:block">
              <p className="text-sm font-black leading-none tracking-tight text-slate-900">FLS ERP</p>
              <p className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.15em] text-brand-600">Enterprise Platform</p>
            </div>
          </div>

          {/* Desktop nav — horizontal pills. Left-aligned, not centered:
              justify-center on an overflowing flex row starts the scroll
              position mid-content, clipping the first tab(s) off the left
              edge with zero indication there's more to scroll to — that's
              exactly the "Inventory got cut off" bug this replaces.
              Edge fades hint that it actually scrolls, since the
              scrollbar itself is hidden. */}
          <div className="relative min-w-0 flex-1">
            <div className="scrollbar-none hidden items-center gap-1 overflow-x-auto md:flex">
              {visibleTabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <NavLink
                    key={tab.to}
                    to={tab.to}
                    end={tab.end}
                    className={({ isActive }) =>
                      `flex shrink-0 items-center gap-1.5 rounded-xl px-2.5 py-2 text-[12.5px] font-bold transition-all duration-150 lg:px-3.5 ${
                        isActive ? "bg-brand-50 text-brand-700 shadow-[inset_0_0_0_1px_rgba(79,70,229,.12)]" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                      }`
                    }
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
                    <span className="truncate">{tab.label}</span>
                  </NavLink>
                );
              })}
            </div>
            <div className="pointer-events-none absolute inset-y-0 left-0 hidden w-6 bg-gradient-to-r from-white/90 to-transparent md:block" />
            <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-6 bg-gradient-to-l from-white/90 to-transparent md:block" />
          </div>

          <div className="ml-auto flex items-center gap-2 md:ml-0">
            {/* Notification bell */}
            <div className="relative" ref={notifRef}>
              <button
                onClick={() => setNotifOpen((o) => !o)}
                className="btn-icon relative"
                title="Notifications"
              >
                <Bell className="h-4.5 w-4.5" strokeWidth={2.25} />
                {unreadCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-black text-white shadow-sm">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="animate-scale-in absolute right-0 top-full z-50 mt-2 w-80 origin-top-right rounded-2xl border border-slate-200/80 bg-white shadow-lift">
                  <div className="flex items-center justify-between border-b border-slate-100 px-3.5 py-2.5">
                    <p className="text-xs font-black text-slate-800">Notifications</p>
                    {unreadCount > 0 && (
                      <button
                        onClick={() => markAllRead.mutate()}
                        className="text-[10px] font-bold uppercase tracking-wide text-brand-600 hover:text-brand-800"
                      >
                        Mark all read
                      </button>
                    )}
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <p className="px-3.5 py-6 text-center text-xs font-medium text-slate-400">You're all caught up.</p>
                    ) : (
                      notifications.map((n) => (
                        <button
                          key={n.id}
                          onClick={() => handleNotifClick(n)}
                          className={`flex w-full flex-col gap-0.5 border-b border-slate-50 px-3.5 py-2.5 text-left transition-colors last:border-b-0 hover:bg-slate-50 ${
                            n.readAt ? "" : "bg-brand-50/50"
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            {!n.readAt && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />}
                            <p className={`flex-1 text-xs leading-snug ${n.readAt ? "font-medium text-slate-600" : "font-bold text-slate-800"}`}>{n.title}</p>
                          </div>
                          {n.body && <p className="pl-3.5 text-[11px] leading-snug text-slate-500">{n.body}</p>}
                          <p className="pl-3.5 text-[10px] font-semibold text-slate-400">{timeAgo(n.createdAt)}</p>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Profile dropdown — desktop */}
            <div className="relative hidden md:block" ref={profileRef}>
              <button
                onClick={() => setProfileOpen((o) => !o)}
                className="flex items-center gap-2 rounded-xl border border-transparent py-1.5 pl-1.5 pr-2.5 transition-colors hover:border-slate-200 hover:bg-slate-50"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 text-[11px] font-black text-white shadow-soft">
                  {initials(displayName)}
                </div>
                <div className="text-left">
                  <p className="max-w-[9rem] truncate text-xs font-bold leading-tight text-slate-800">{displayName}</p>
                  <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">{user?.roles[0] ?? "No role"}</p>
                </div>
                <ChevronDown className={`h-3.5 w-3.5 text-slate-400 transition-transform ${profileOpen ? "rotate-180" : ""}`} strokeWidth={2.5} />
              </button>

              {profileOpen && (
                <div className="animate-scale-in absolute right-0 top-full z-50 mt-2 w-56 origin-top-right rounded-2xl border border-slate-200/80 bg-white p-2 shadow-lift">
                  <div className="px-2.5 py-2">
                    <p className="truncate text-xs font-bold text-slate-800">{displayName}</p>
                    {user && <p className="mt-0.5 font-mono text-[10px] font-bold text-slate-400">{formatEmployeeId(user.employeeId)}</p>}
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {(user?.roles.length ? user.roles : ["No roles"]).map((r) => (
                        <span key={r} className="rounded border border-brand-200 bg-brand-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-700">
                          {r}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="my-1 border-t border-slate-100" />
                  <button onClick={logout} className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-bold text-rose-600 transition-colors hover:bg-rose-50">
                    <LogOut className="h-3.5 w-3.5" strokeWidth={2.25} /> Log out
                  </button>
                </div>
              )}
            </div>

            <button className="btn-icon md:hidden" onClick={() => setMobileOpen((o) => !o)}>
              {mobileOpen ? <X className="h-5 w-5" strokeWidth={2.25} /> : <Menu className="h-5 w-5" strokeWidth={2.25} />}
            </button>
          </div>
        </div>

        {/* Mobile nav — dropdown panel below the bar */}
        {mobileOpen && (
          <div className="animate-slide-up border-t border-slate-100 bg-white px-4 py-3 md:hidden">
            <div className="space-y-1">
              {visibleTabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <NavLink
                    key={tab.to}
                    to={tab.to}
                    end={tab.end}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] font-bold transition-colors ${
                        isActive ? "bg-brand-50 text-brand-700" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                      }`
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0" strokeWidth={2.25} />
                    {tab.label}
                  </NavLink>
                );
              })}
            </div>
            <div className="mt-3 flex items-center gap-2.5 border-t border-slate-100 pt-3">
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
        )}
      </nav>

      <main className="mx-auto max-w-[1600px] p-4 md:p-6 xl:p-8">
        <div key={location.pathname} className="animate-fade-in">
          {children}
        </div>
      </main>
    </div>
  );
}
