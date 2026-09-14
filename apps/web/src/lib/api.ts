// One fetch wrapper for the whole app — every module's data hooks go
// through this, not raw fetch, so the auth header/401 handling/error
// shape only exist in one place.

// Dev: unset, so requests go to relative paths (/api/...) which Vite's
// dev server proxies to localhost:4000 — see vite.config.ts. Prod build:
// set VITE_API_URL to the deployed API's origin (no trailing slash),
// since the built static site and the API live on different hosts then.
const API_BASE = import.meta.env.VITE_API_URL ?? "";

const TOKEN_KEY = "fls_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** For multipart uploads — pass a FormData body and this flag to skip the JSON Content-Type header. */
  isFormData?: boolean;
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!opts.isFormData) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : opts.isFormData ? (opts.body as FormData) : JSON.stringify(opts.body),
  });

  // A 401 doesn't always mean "your session expired" — POST /auth/login
  // (wrong email/password) and PATCH /auth/change-password (wrong current
  // password) both legitimately 401 as their own business response, not a
  // rejected token (see auth.routes.ts). Only auth.ts's token-verification
  // middleware 401s mean the session itself is invalid, and that's every
  // OTHER endpoint — so treat those two as ordinary errors (real server
  // message, no forced logout) and everything else as session expiry.
  const isSelfContainedAuthCall = path === "/api/auth/login" || path === "/api/auth/change-password";
  if (res.status === 401 && !isSelfContainedAuthCall) {
    onUnauthorized();
    throw new ApiError("Session expired — please log in again.", 401);
  }

  if (res.status === 204) return undefined as T;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.details);
  return data as T;
}

/** Like api(), but for a paginated GET where the caller only wants "how
 * many rows are there" (the X-Total-Count header), not a page of rows —
 * a lightweight catalog-size read, e.g. the dashboard's SKU count. */
export async function apiCount(path: string): Promise<number> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { headers });

  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError("Session expired — please log in again.", 401);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.details);
  }
  return Number(res.headers.get("X-Total-Count") ?? 0);
}

/** Triggers a browser download from an authenticated endpoint — a plain <a href> can't carry the Authorization header. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? `Download failed (${res.status})`, res.status);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
