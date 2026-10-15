import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useClientPaging } from "../lib/useClientPaging";
import { PAGE_SIZE_OPTIONS, setPageSizePref } from "../lib/pageSize";

/** The footer every paginated table shares: Previous / current page / Next. Hidden while everything fits on one page. */
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  isFetching = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  /** Accepted so existing call sites keep compiling: the size choice is saved for the whole app. */
  onPageSize?: (size: number) => void;
  isFetching?: boolean;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Nothing to page and no smaller size to offer: hide the footer.
  if (total === 0 || (totalPages <= 1 && total <= PAGE_SIZE_OPTIONS[0])) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  const step =
    "group inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-xl px-3.5 text-xs font-semibold text-slate-600 transition-all duration-200 ease-out hover:bg-white hover:text-brand-700 hover:shadow-sm active:scale-95 disabled:pointer-events-none disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40";

  return (
    <div className="relative flex flex-wrap items-center justify-between gap-3 border-t border-slate-200/80 bg-slate-50/60 px-5 py-3">
      <div className={`pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden transition-opacity duration-300 ${isFetching ? "opacity-100" : "opacity-0"}`}>
        <div className="h-full w-1/3 animate-pulse rounded-full bg-brand-500" />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs font-semibold text-slate-500">
        <label className="flex items-center gap-2">
          Rows per page
          <select
            className="field !h-8 !w-auto !py-0 text-xs font-bold"
            value={pageSize}
            onChange={(e) => {
              setPageSizePref(Number(e.target.value));
              onPage(1);
            }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className="tabular-nums">
          {from.toLocaleString()} to {to.toLocaleString()} of {total.toLocaleString()}
        </span>
      </div>
      {totalPages > 1 && (
      <nav className="inline-flex items-center gap-1 rounded-2xl border border-slate-200/80 bg-slate-100/70 p-1 shadow-inner" aria-label="Pagination">
        <button type="button" className={step} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-x-0.5" strokeWidth={2.5} /> Previous
        </button>
        <PageJump page={page} totalPages={totalPages} onPage={onPage} />
        <button type="button" className={step} disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label="Next page">
          Next <ChevronRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" strokeWidth={2.5} />
        </button>
      </nav>
      )}
    </div>
  );
}

/** The current page badge; click it to type a page number and press Enter to jump straight there. */
function PageJump({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (page: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  function commit() {
    const n = parseInt(text, 10);
    setEditing(false);
    if (Number.isFinite(n)) onPage(Math.min(totalPages, Math.max(1, n)));
  }

  if (!editing) {
    return (
      <button
        type="button"
        aria-current="page"
        title="Click to jump to a page"
        onClick={() => {
          setText(String(page));
          setEditing(true);
        }}
        className="inline-flex h-9 min-w-9 items-center justify-center gap-1 rounded-xl bg-brand-600 px-3 text-xs font-bold tabular-nums text-white shadow-md shadow-brand-600/30 transition hover:bg-brand-700 active:scale-95"
      >
        {page}
        <span className="font-medium text-white/70">/ {totalPages}</span>
      </button>
    );
  }
  return (
    <input
      autoFocus
      type="number"
      min={1}
      max={totalPages}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setEditing(false);
      }}
      aria-label={`Go to page (1-${totalPages})`}
      className="h-9 w-20 rounded-xl border border-brand-500 bg-white px-2 text-center text-xs font-bold tabular-nums text-slate-800 shadow-sm outline-none ring-2 ring-brand-500/30 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  );
}

/** The footer for a list paged in the browser (see useClientPaging). */
export function ClientPager({ pg }: { pg: { page: number; pageSize: number; total: number; setPage: (p: number) => void } }) {
  return <Pagination page={pg.page} pageSize={pg.pageSize} total={pg.total} onPage={pg.setPage} />;
}

/** A card list paged in the browser: renders the current page's rows with `render`, then the footer. */
export function PagedCards<T>({ rows, render, className = "space-y-3" }: { rows: readonly T[]; render: (row: T) => ReactNode; className?: string }) {
  const pg = useClientPaging(rows);
  return (
    <div>
      <div className={className}>{pg.rows.map(render)}</div>
      <div className="mt-3 overflow-hidden rounded-2xl">
        <ClientPager pg={pg} />
      </div>
    </div>
  );
}
