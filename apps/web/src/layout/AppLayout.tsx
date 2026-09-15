import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  Beaker,
  Bell,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  ClipboardList,
  FlaskConical,
  History,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Microscope,
  Package,
  PauseCircle,
  Recycle,
  RotateCcw,
  ShieldCheck,
  Truck,
  Warehouse,
  X,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { EmptyState } from "../components/EmptyState";
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

interface NavItem {
  to: string;
  label: string;
  icon: typeof Truck;
  roles?: RoleName[];
  end?: boolean;
}

// Grouped by the department flow the business actually runs, not
// alphabetically — a sidebar with 16 flat entries reads as a dumping
// ground; the same 16 under five headings reads as a system. Section
// headings are labels only, never links: every one of them is a
// department's *set* of tools, not a page of its own.
//
// Role gating is unchanged from the old horizontal tab row: hiding a tab
// only declutters the nav — the API underneath keeps its own gates (see
// each module's requireRole), so nothing here grants or removes real
// access. A section with no visible items disappears entirely rather
// than leaving an empty heading behind.
const NAV_GROUPS: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard, end: true }],
  },
  {
    heading: "Order to Dispatch",
    items: [
      { to: "/purchase-orders", label: "Order Tracking", icon: Truck },
      { to: "/customers", label: "Customers", icon: Building2, roles: ["BD"] },
    ],
  },
  {
    heading: "Planning & Procurement",
    items: [
      { to: "/pre-inventory", label: "Pre-Inventory", icon: ClipboardList, roles: ["PPIC", "STORE", "PURCHASE", "ACCOUNTS", "PRODUCTION"] },
      { to: "/po-readiness", label: "PO Readiness", icon: CheckCircle2, roles: ["PPIC"] },
    ],
  },
  {
    heading: "Warehouse & Quality",
    items: [
      { to: "/inventory", label: "Inventory", icon: Warehouse, roles: ["STORE", "PPIC", "QA_QC", "RND", "PRODUCTION", "DISPATCH", "ACCOUNTS"] },
      { to: "/qc-dashboard", label: "QC Dashboard", icon: PauseCircle, roles: ["QA_QC"] },
      { to: "/recycle-store", label: "Recycle Store", icon: Recycle, roles: ["STORE", "PRODUCTION", "QA_QC", "PPIC"] },
    ],
  },
  {
    heading: "R&D",
    items: [
      // Wider than "R&D authors it, so only R&D opens it" — these two
      // pages are also where a plan gets *used*. Send to Pre-Inventory
      // is PPIC's button and lives here, not on the PO, so gating the
      // page to RND left PPIC unable to reach the one control the page
      // grants them; and the PO detail page links BD/Purchase straight
      // here from its calculated BOM/RM chips, which landed them on a
      // restricted screen. Authoring stays RND-only inside the pages
      // themselves (canEditCosting / canManageCatalog), and every write
      // behind them is role-gated server-side, so opening the door here
      // adds read access and nothing more.
      { to: "/packaging-bom", label: "Packaging BOM", icon: Package, roles: ["RND", "PPIC", "PURCHASE", "BD"] },
      // PPIC no longer gets a nav link here — Costing is being removed
      // from their interface; they keep Packaging BOM above, and RND
      // stays the one who triggers "Send to Pre-Inventory" off a
      // calculated RM Costing plan going forward (see RmCostingPage.tsx).
      { to: "/rm-costing", label: "RM Costing", icon: FlaskConical, roles: ["RND", "BD"] },
      { to: "/rnd", label: "R&D Requests", icon: Beaker, roles: ["RND", "PPIC"] },
      { to: "/rnd-store", label: "R&D Store", icon: FlaskConical, roles: ["STORE", "RND"] },
    ],
  },
  {
    heading: "Administration",
    items: [
      { to: "/users", label: "Users", icon: ShieldCheck, roles: ["ADMIN"] },
      { to: "/recycle-bin", label: "Recycle Bin", icon: RotateCcw, roles: ["ADMIN"] },
      { to: "/system-health", label: "System Health", icon: Activity, roles: ["ADMIN"] },
      { to: "/audit-log", label: "Audit Log", icon: History, roles: ["ADMIN"] },
    ],
  },
];

// Routes that aren't nav entries of their own still need a name for the
// topbar — a detail page reached from a list belongs to that list's
// section, so it borrows its parent's title rather than showing nothing.
const DETAIL_ROUTE_TITLES: { prefix: string; label: string; section: string }[] = [
  { prefix: "/purchase-orders/", label: "Purchase Order", section: "Order to Dispatch" },
  { prefix: "/pre-productions/", label: "Production Run", section: "Order to Dispatch" },
  { prefix: "/combined-lots/", label: "Combined Lot", section: "Order to Dispatch" },
  { prefix: "/inventory/items/", label: "Item", section: "Warehouse & Quality" },
];

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  const chars = parts.length > 1 ? [parts[0]?.[0], parts[parts.length - 1]?.[0]] : [parts[0]?.[0], parts[0]?.[1]];
  return chars.filter(Boolean).join("").toUpperCase();
}

const SIDEBAR_COLLAPSED_KEY = "fls.sidebar.collapsed";

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout, hasRole } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const displayName = user?.fullName ?? user?.email ?? "";

  const visibleGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.roles || hasRole(...item.roles)),
  })).filter((group) => group.items.length > 0);

  // Collapsed state persists per browser — an operator who works one
  // module all day shouldn't have to re-collapse the rail every reload.
  // Reads defensively: a private window (or blocked site data) throws on
  // access rather than returning null, and the nav must still render.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* storage unavailable — the toggle still works for this session */
    }
  }, [collapsed]);

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

  // Matched on segment boundaries and longest-first, or "/rnd" would
  // claim "/rnd-store" (a plain startsWith on a shorter sibling route)
  // and the header would disagree with the highlighted rail item.
  const matchNav = (items: (NavItem & { section: string })[]) =>
    items
      .filter((item) => (item.end ? location.pathname === item.to : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)))
      .sort((a, b) => b.to.length - a.to.length)[0];

  const activeNav = matchNav(visibleGroups.flatMap((g) => g.items.map((item) => ({ ...item, section: g.heading }))));

  // Hiding a tab was never access control — the URL stayed reachable, so
  // an ADMIN-only screen left in the address bar (or bookmarked, or
  // still there after logging back in as someone else, which is exactly
  // how this surfaced) rendered its full shell for a BD user and only
  // failed at the API call, reading as "the app is broken" rather than
  // "this isn't yours". The nav config is the one source of truth for
  // both now: a path that matches a nav entry this role can't see gets
  // the restricted state instead of the page.
  //
  // Only *known* entries are gated — detail routes (a PO, a batch, an
  // item) aren't nav entries and must still open normally; each of those
  // pages carries its own guard, and every API behind them is gated
  // server-side regardless (see requireRole), which is the real control.
  const matchedAnyNav = matchNav(NAV_GROUPS.flatMap((g) => g.items.map((item) => ({ ...item, section: g.heading }))));
  const isRestricted = !!matchedAnyNav && !activeNav;

  // What the topbar names the current screen — a detail route's borrowed
  // parent title first, then the nav entry itself, then a plain fallback.
  const detailRoute = DETAIL_ROUTE_TITLES.find((r) => location.pathname.startsWith(r.prefix));
  const pageTitle = isRestricted ? "Restricted" : (detailRoute?.label ?? activeNav?.label ?? "FLS Mitr");
  const pageSection = isRestricted ? "" : (detailRoute?.section ?? activeNav?.section ?? "");

  const railWidth = collapsed ? "lg:w-[76px]" : "lg:w-[264px]";

  // `iconsOnly` is passed in rather than read off `collapsed` directly:
  // the mobile drawer is always the full-width labelled list, and would
  // otherwise inherit the desktop rail's collapsed setting and render as
  // a column of unlabelled icons inside a 272px panel.
  const navList = ({ iconsOnly, onNavigate }: { iconsOnly: boolean; onNavigate?: () => void }) => (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {visibleGroups.map((group) => (
        <div key={group.heading}>
          {/* The heading is what turns a flat list into a system — but at
              76px there's no room for it, and a truncated word reads as a
              glitch, so the collapsed rail drops it and leans on the
              spacing between groups instead. */}
          {!iconsOnly && <p className="mb-1.5 px-3 text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{group.heading}</p>}
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  title={iconsOnly ? item.label : undefined}
                  className={({ isActive }) =>
                    `group relative flex items-center rounded-xl text-[13px] font-bold transition-all duration-150 ${iconsOnly ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2.5"} ${
                      isActive ? "bg-brand-50 text-brand-700 shadow-[inset_0_0_0_1px_rgba(79,70,229,.12)]" : "text-slate-500 hover:bg-slate-100/70 hover:text-slate-900"
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      {/* Active accent rail — the one piece of chrome that
                          survives collapsing, so the current module is
                          still obvious at 76px. */}
                      {isActive && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-brand-600" />}
                      <Icon className="h-4 w-4 shrink-0" strokeWidth={2.25} />
                      {!iconsOnly && <span className="truncate">{item.label}</span>}
                    </>
                  )}
                </NavLink>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Ambient wash — a couple of soft, static brand-tinted glows behind
          the whole app so the light theme reads as considered rather than
          flat, without tipping into a dark or busy surface. */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full blur-3xl" style={{ backgroundColor: "rgba(99,102,241,0.06)" }} />
        <div className="absolute -right-24 top-1/3 h-80 w-80 rounded-full blur-3xl" style={{ backgroundColor: "rgba(167,139,250,0.05)" }} />
      </div>

      {/* --- Desktop sidebar --- */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-slate-200/80 bg-white/90 backdrop-blur-xl transition-[width] duration-200 ease-out lg:flex ${railWidth}`}
      >
        <div className={`flex h-16 shrink-0 items-center border-b border-slate-100 ${collapsed ? "justify-center px-0" : "gap-2.5 px-5"}`}>
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900 shadow-[0_4px_14px_-3px_rgba(79,70,229,.55),inset_0_1px_0_rgba(255,255,255,.2)]">
            <div className="absolute inset-0 -z-10 rounded-xl bg-brand-500 opacity-40 blur-md" />
            <Microscope className="h-[18px] w-[18px] text-white" strokeWidth={2} />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-sm font-black leading-none tracking-tight text-slate-900">FLS Mitr</p>
              <p className="mt-1 text-[9px] font-bold uppercase tracking-[0.15em] text-brand-600">Enterprise Platform</p>
            </div>
          )}
        </div>

        {navList({ iconsOnly: collapsed })}

        <div className="shrink-0 border-t border-slate-100 p-3">
          <button
            onClick={() => setCollapsed((c) => !c)}
            className={`flex w-full items-center rounded-xl px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-400 transition-colors hover:bg-slate-100/70 hover:text-slate-700 ${
              collapsed ? "justify-center" : "gap-2"
            }`}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" strokeWidth={2.25} /> : <ChevronsLeft className="h-4 w-4" strokeWidth={2.25} />}
            {!collapsed && "Collapse"}
          </button>
        </div>
      </aside>

      {/* --- Mobile drawer --- */}
      {mobileOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm lg:hidden" onClick={() => setMobileOpen(false)} />
          <aside className="animate-slide-up fixed inset-y-0 left-0 z-50 flex w-[272px] flex-col border-r border-slate-200 bg-white lg:hidden">
            <div className="flex h-16 shrink-0 items-center justify-between gap-2.5 border-b border-slate-100 px-5">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900">
                  <Microscope className="h-[18px] w-[18px] text-white" strokeWidth={2} />
                </div>
                <div>
                  <p className="text-sm font-black leading-none tracking-tight text-slate-900">FLS Mitr</p>
                  <p className="mt-1 text-[9px] font-bold uppercase tracking-[0.15em] text-brand-600">Enterprise Platform</p>
                </div>
              </div>
              <button className="btn-icon" onClick={() => setMobileOpen(false)} aria-label="Close menu">
                <X className="h-5 w-5" strokeWidth={2.25} />
              </button>
            </div>

            {navList({ iconsOnly: false, onNavigate: () => setMobileOpen(false) })}

            <div className="shrink-0 border-t border-slate-100 p-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 text-xs font-black text-white shadow-soft">
                  {initials(displayName)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-bold leading-tight text-slate-800">{displayName}</p>
                  <p className="mt-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">{user?.roles.join(" · ") || "No role"}</p>
                </div>
                <button onClick={logout} className="btn-icon shrink-0 hover:!bg-rose-50 hover:!text-rose-600" title="Log out">
                  <LogOut className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
            </div>
          </aside>
        </>
      )}

      {/* --- Main column --- */}
      <div className={`transition-[padding] duration-200 ease-out ${collapsed ? "lg:pl-[76px]" : "lg:pl-[264px]"}`}>
        <header className="glass sticky top-0 z-30 border-b border-slate-200/60">
          <div className="flex h-16 items-center gap-3 px-4 md:px-6">
            <button className="btn-icon lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
              <Menu className="h-5 w-5" strokeWidth={2.25} />
            </button>

            {/* Where you are, in the sidebar's own words — section above,
                screen below — so the rail and the header never disagree
                about what this page is called. */}
            <div className="min-w-0">
              {pageSection && <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{pageSection}</p>}
              <h1 className="truncate text-[15px] font-black leading-tight tracking-tight text-slate-900">{pageTitle}</h1>
            </div>

            <div className="ml-auto flex items-center gap-2">
              {/* Notification bell */}
              <div className="relative" ref={notifRef}>
                <button onClick={() => setNotifOpen((o) => !o)} className="btn-icon relative" title="Notifications">
                  <Bell className="h-[18px] w-[18px]" strokeWidth={2.25} />
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
                        <button onClick={() => markAllRead.mutate()} className="text-[10px] font-bold uppercase tracking-wide text-brand-600 hover:text-brand-800">
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

              <div className="hidden h-6 w-px bg-slate-200 sm:block" />

              {/* Profile dropdown */}
              <div className="relative" ref={profileRef}>
                <button
                  onClick={() => setProfileOpen((o) => !o)}
                  className="flex items-center gap-2 rounded-xl border border-transparent py-1.5 pl-1.5 pr-2 transition-colors hover:border-slate-200 hover:bg-slate-50 sm:pr-2.5"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 text-[11px] font-black text-white shadow-soft">
                    {initials(displayName)}
                  </div>
                  <div className="hidden text-left sm:block">
                    <p className="max-w-[9rem] truncate text-xs font-bold leading-tight text-slate-800">{displayName}</p>
                    <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">{user?.roles[0] ?? "No role"}</p>
                  </div>
                  <ChevronDown className={`hidden h-3.5 w-3.5 text-slate-400 transition-transform sm:block ${profileOpen ? "rotate-180" : ""}`} strokeWidth={2.5} />
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
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-[1600px] p-4 md:p-6 xl:p-8">
          <div key={location.pathname} className="animate-fade-in">
            {isRestricted ? (
              <EmptyState
                icon={Lock}
                title={`${matchedAnyNav?.label} is restricted to ${matchedAnyNav?.roles?.join(" / ") ?? "another role"}`}
                hint="Your account doesn't have that role, so this screen isn't in your sidebar. Pick a module from the left, or ask an administrator if you need access."
                accent="slate"
              />
            ) : (
              children
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
