import { useEffect, useState } from "react";
import { setPageSizePref, usePageSize } from "./pageSize";

/**
 * Pages a list that is already in the browser (a department queue, a report -
 * data that is loaded whole by its own hook). The big tables use usePagedList
 * (the server sends one page); this gives every other table the same 50-row
 * pages and the same Previous / numbers / Next footer instead of rendering
 * thousands of rows at once. A new filter / search (the list's length changes)
 * sends it back to page 1.
 */
export function useClientPaging<T>(rows: readonly T[] | undefined) {
  const [page, setPageRaw] = useState(1);
  const pageSize = usePageSize(); // each person's own choice, 10 to start
  const total = rows?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    setPageRaw(1);
  }, [total, pageSize]);

  return {
    rows: (rows ?? []).slice((safePage - 1) * pageSize, safePage * pageSize),
    page: safePage,
    pageSize,
    total,
    setPage: (p: number) => setPageRaw(Math.min(Math.max(1, p), totalPages)),
    setPageSize: (s: number) => {
      setPageSizePref(s);
      setPageRaw(1);
    },
  };
}
