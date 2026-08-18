import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
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

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearToken();
      setUser(null);
    });
  }, []);

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
