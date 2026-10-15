import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, clearToken, getToken, setToken, setUnauthorizedHandler, setViewScopeHeader } from "./api";
import type { CurrentUser, RoleName } from "./types";

interface AuthState {
  /** The user as the screens see them: while an admin is "viewing as" a department, only that department's role. */
  user: CurrentUser | null;
  loading: boolean;
  /** Signs in with the login ID or the email, and the password. */
  login: (loginIdOrEmail: string, password: string) => Promise<void>;
  logout: () => void;
  hasRole: (...roles: RoleName[]) => boolean;
  /** True for a real admin, even while viewing as a department (so the switcher stays available). */
  isAdmin: boolean;
  /** The department an admin is viewing as; null = the normal Admin view. */
  viewAs: RoleName | null;
  /** When viewing as one Day Store or one Plant: which one (the server scopes the admin to it). */
  viewScope: ViewScope | null;
  setViewAs: (role: RoleName | null, scope?: ViewScope | null) => void;
}

export interface ViewScope {
  kind: "DAYSTORE" | "PLANT";
  id: string;
  label: string;
}

const VIEW_AS_KEY = "fls.viewAs";

interface SavedView {
  role: RoleName;
  scope: ViewScope | null;
}

function readSavedView(): SavedView | null {
  try {
    const raw = localStorage.getItem(VIEW_AS_KEY);
    if (!raw) return null;
    if (raw.startsWith("{")) return JSON.parse(raw) as SavedView;
    return { role: raw as RoleName, scope: null }; // the older format: just the role
  } catch {
    return null;
  }
}

const scopeHeader = (s: ViewScope | null) => (s ? `${s.kind}:${s.id}` : null);

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [realUser, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<SavedView | null>(() => {
    const v = readSavedView();
    setViewScopeHeader(scopeHeader(v?.scope ?? null)); // before the first request goes out
    return v;
  });
  const viewAsRaw = saved?.role ?? null;
  const isAdmin = !!realUser?.roles.includes("ADMIN");
  // Only a real admin can view as a department; for anyone else the saved choice is ignored.
  const viewAs = isAdmin && viewAsRaw && viewAsRaw !== "ADMIN" ? viewAsRaw : null;
  const viewScope = viewAs ? (saved?.scope ?? null) : null;
  // The screens (menu, dashboard, role checks) follow the chosen department. The login, the token and every server call stay the admin's.
  const user = realUser && viewAs ? { ...realUser, roles: [viewAs] } : realUser;
  const queryClient = useQueryClient();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearToken();
      setUser(null);
      // A 401 mid-session (expired/revoked token) means every cached
      // response was fetched as the outgoing user — clear it so the next
      // login (possibly a different person, same tab) starts from empty
      // instead of briefly rendering stale data from the old session.
      queryClient.clear();
    });
  }, [queryClient]);

  useEffect(() => {
    (async () => {
      if (!getToken()) {
        setLoading(false);
        return;
      }
      try {
        const me = await api<CurrentUser>("/api/auth/me");
        setUser(me);
      } catch {
        clearToken();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function login(loginIdOrEmail: string, password: string) {
    const { token, user: loggedInUser } = await api<{ token: string; user: CurrentUser }>("/api/auth/login", { method: "POST", body: { login: loginIdOrEmail, password } });
    setToken(token);
    setUser(loggedInUser);
  }

  function setViewAs(role: RoleName | null, scope: ViewScope | null = null) {
    // The header changes first, then everything on screen is fetched again as the chosen store / plant / department.
    setViewScopeHeader(role ? scopeHeader(scope) : null);
    setSaved(role ? { role, scope } : null);
    try {
      if (role) localStorage.setItem(VIEW_AS_KEY, JSON.stringify({ role, scope }));
      else localStorage.removeItem(VIEW_AS_KEY);
    } catch {
      // not remembered, but still applied for this visit
    }
    queryClient.invalidateQueries();
  }

  function logout() {
    clearToken();
    setUser(null);
    setViewAs(null);
    // Same reasoning as the 401 handler above — a fresh login in this tab
    // (same person or a different one) must never render the previous
    // session's cached inventory/batches/etc. before its own fetch lands.
    queryClient.clear();
  }

  function hasRole(...roles: RoleName[]) {
    if (!user) return false;
    // Viewing as a department: no admin shortcut, only that department's own role counts.
    if (viewAs) return roles.includes(viewAs);
    return user.roles.includes("ADMIN") || roles.some((r) => user.roles.includes(r));
  }

  return <AuthContext.Provider value={{ user, loading, login, logout, hasRole, isAdmin, viewAs, viewScope, setViewAs }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
