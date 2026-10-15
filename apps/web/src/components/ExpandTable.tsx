import { Fragment, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { ClientPager } from "./Pagination";
import { useClientPaging } from "../lib/useClientPaging";

// A list as one table (an Excel-like list): a column for each thing, paged. "Open" shows the row's full card under it (`renderExpanded`), with all
// its actions, so turning a card list into a table loses nothing.

export interface ExpandColumn<T> {
  header: string;
  cell: (row: T) => ReactNode;
  /** Extra classes for the cell, e.g. "text-right font-mono". */
  className?: string;
  align?: "left" | "right";
}

export function ExpandTable<T>({
  rows,
  columns,
  rowKey,
  renderExpanded,
  openLabel = "Open",
}: {
  rows: readonly T[];
  columns: ExpandColumn<T>[];
  rowKey: (row: T) => string;
  renderExpanded: (row: T) => ReactNode;
  openLabel?: string;
}) {
  const pg = useClientPaging(rows);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
              {columns.map((c) => (
                <th key={c.header} className={`px-4 py-3 ${c.align === "right" ? "text-right" : ""}`}>
                  {c.header}
                </th>
              ))}
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pg.rows.map((row) => {
              const id = rowKey(row);
              const isOpen = openId === id;
              return (
                <Fragment key={id}>
                  <tr className="transition hover:bg-slate-50">
                    {columns.map((c) => (
                      <td key={c.header} className={`px-4 py-3 text-slate-600 ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""}`}>
                        {c.cell(row)}
                      </td>
                    ))}
                    <td className="px-4 py-3 text-right">
                      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenId(isOpen ? null : id)} aria-expanded={isOpen}>
                        {openLabel} <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`} strokeWidth={2.5} />
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={columns.length + 1} className="whitespace-normal bg-slate-50/60 px-4 py-4">
                        <div className="sticky left-4 max-w-[min(100%,64rem)]">{renderExpanded(row)}</div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <ClientPager pg={pg} />
    </div>
  );
}
