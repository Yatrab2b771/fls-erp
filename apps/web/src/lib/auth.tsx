import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, clearToken, getToken, setToken, setUnauthorizedHandler } from "./api";
import type { CurrentUser, RoleName } from "./types";

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  hasRole: (...roles: RoleName[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
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

  async function login(email: string, password: string) {
    const { token, user: loggedInUser } = await api<{ token: string; user: CurrentUser }>("/api/auth/login", { method: "POST", body: { email, password } });
    setToken(token);
    setUser(loggedInUser);
  }

  function logout() {
    clearToken();
    setUser(null);
    // Same reasoning as the 401 handler above — a fresh login in this tab
    // (same person or a different one) must never render the previous
    // session's cached inventory/batches/etc. before its own fetch lands.
    queryClient.clear();
  }

  function hasRole(...roles: RoleName[]) {
    if (!user) return false;
    return user.roles.includes("ADMIN") || roles.some((r) => user.roles.includes(r));
  }

  return <AuthContext.Provider value={{ user, loading, login, logout, hasRole }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
