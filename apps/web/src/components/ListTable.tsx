import type { ReactNode } from "react";
import { ClientPager } from "./Pagination";
import { useClientPaging } from "../lib/useClientPaging";

// A plain list as one table (an Excel-like list): a column for each thing, paged, and an optional Action column on the right for buttons.

export interface ListColumn<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
  align?: "left" | "right";
}

export function ListTable<T>({ rows, rowKey, columns, actions, actionHeader = "Action" }: { rows: readonly T[]; rowKey: (row: T) => string; columns: ListColumn<T>[]; actions?: (row: T) => ReactNode; actionHeader?: string }) {
  const pg = useClientPaging(rows);
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
              {actions && <th className="px-4 py-3 text-right">{actionHeader}</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pg.rows.map((row) => (
              <tr key={rowKey(row)} className="transition hover:bg-slate-50">
                {columns.map((c) => (
                  <td key={c.header} className={`px-4 py-3 text-slate-600 ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""}`}>
                    {c.cell(row)}
                  </td>
                ))}
                {actions && (
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex gap-1.5">{actions(row)}</div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ClientPager pg={pg} />
    </div>
  );
}
