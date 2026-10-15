import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiPage } from "./api";
import { appendParams, type QueryParams } from "./tileFilters";

import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, setPageSizePref, usePageSize } from "./pageSize";

export { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS };

/**
 * Server-side paginated + searched list, with its state kept in the URL
 * (?page= &size= &q=) so a refresh or the Back button returns to the same page.
 *
 *  - `key` is the react-query key prefix: invalidating it refreshes every page.
 *  - `params` are extra server filters (category, status, ...); changing them
 *    sends the list back to page 1.
 *  - `prefix` lets two lists share one URL (e.g. "tx_" -> ?tx_page=2).
 *  - The previous page stays on screen while the next one loads.
 */
export function usePagedList<T>({
  key,
  path,
  params,
  enabled = true,
  prefix = "",
  searchParam = "search",
  noSearch = false,
}: {
  key: unknown[];
  path: string;
  params?: QueryParams;
  enabled?: boolean;
  prefix?: string;
  searchParam?: string;
  /** The list has no search box: ignore any ?q= left in the URL. */
  noSearch?: boolean;
  /** Ignored: the page size is the person's own choice (see pageSize.ts). Kept so older call sites still compile. */
  defaultPageSize?: number;
}) {
  const [sp, setSp] = useSearchParams();
  const name = (n: string) => `${prefix}${n}`;

  const page = Math.max(1, Number(sp.get(name("page"))) || 1);
  const pageSize = usePageSize(); // each person's own choice, 10 to start
  const q = noSearch ? "" : (sp.get(name("q")) ?? "");

  function update(patch: { page?: number; q?: string }, replace: boolean) {
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [field, value] of Object.entries(patch)) {
          const urlKey = name(field);
          const isDefault = value === undefined || value === "" || (field === "page" && value === 1);
          if (isDefault) next.delete(urlKey);
          else next.set(urlKey, String(value));
        }
        return next;
      },
      { replace },
    );
  }

  // Typing is debounced into the URL; the input itself stays instant.
  const [searchInput, setSearchInput] = useState(q);
  useEffect(() => setSearchInput(q), [q]);
  useEffect(() => {
    if (searchInput === q) return;
    const timer = setTimeout(() => update({ q: searchInput, page: 1 }, true), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // Changing a server filter starts again from page 1 (but not on first render).
  const paramsKey = JSON.stringify(params ?? {});
  const firstParams = useRef(paramsKey);
  useEffect(() => {
    if (firstParams.current === paramsKey) return;
    firstParams.current = paramsKey;
    if (page !== 1) update({ page: 1 }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (q) qs.set(searchParam, q);
  appendParams(qs, params);

  const query = useQuery({
    queryKey: [...key, { page, pageSize, q, params: paramsKey }],
    queryFn: () => apiPage<T>(`${path}?${qs.toString()}`),
    enabled,
    placeholderData: keepPreviousData,
  });

  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Rows were removed so the page no longer exists: step back to the last one.
  useEffect(() => {
    if (query.data && page > totalPages) update({ page: totalPages }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, totalPages]);

  return {
    rows: query.data?.rows ?? [],
    total,
    page,
    pageSize,
    totalPages,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
    setPage: (p: number) => update({ page: Math.min(Math.max(1, p), totalPages) }, false),
    setPageSize: (s: number) => {
      setPageSizePref(s);
      update({ page: 1 }, false);
    },
    search: searchInput,
    setSearch: setSearchInput,
    isFiltered: q.length > 0,
  };
}
