import type { Request } from "express";

export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function parsePagination(req: Request): Pagination {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || DEFAULT_PAGE_SIZE));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function setPaginationHeaders(res: { setHeader(name: string, value: string): void }, total: number, p: Pagination): void {
  res.setHeader("X-Total-Count", String(total));
  res.setHeader("X-Page", String(p.page));
  res.setHeader("X-Page-Size", String(p.pageSize));
}

// ---------------------------------------------------------------------------
// Shared list-query helpers - every paginated list route reads the same query
// params, so the web's usePagedList hook can talk to all of them alike:
//   ?page=&pageSize=   (pageSize 1..200, default 50)
//   ?search=           free text, matched server-side against the list's own fields
//   ?sort=&dir=        one of the route's allowed sort fields, asc | desc
// The total comes back in the X-Total-Count header (setPaginationHeaders).
// ---------------------------------------------------------------------------

/** Free-text search from the query string (trimmed, capped), or undefined when empty. */
export function parseSearch(req: Request, param = "search"): string | undefined {
  const raw = req.query[param];
  if (typeof raw !== "string") return undefined;
  const text = raw.trim().slice(0, 100);
  return text.length > 0 ? text : undefined;
}

export type SortDir = "asc" | "desc";

/** `?sort=field&dir=asc|desc`, restricted to the fields a route allows - anything else falls back. */
export function parseSort<T extends string>(req: Request, allowed: readonly T[], fallback: { field: T; dir: SortDir }): { field: T; dir: SortDir } {
  const field = typeof req.query.sort === "string" && (allowed as readonly string[]).includes(req.query.sort) ? (req.query.sort as T) : fallback.field;
  const dir: SortDir = req.query.dir === "asc" || req.query.dir === "desc" ? req.query.dir : field === fallback.field ? fallback.dir : "asc";
  return { field, dir };
}
