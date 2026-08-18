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
