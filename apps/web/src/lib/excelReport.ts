import * as XLSX from "xlsx";
import type { TileFilters } from "./tileFilters";
import type { FilterField } from "../components/TileFilterBar";
import { formatMaterialPick } from "../components/MaterialStatusDropdown";

// One look for every report Excel: a title, the filters that were applied and the date, then the table with a filter row on its header,
// columns sized to their content, and (where it makes sense) a Total row at the bottom.

/** "PO Number: A, B · Shift: Night · Plan sent on: 01-Oct-2026 to 07-Oct-2026" - what the user had applied when they downloaded. */
export function describeFilters(filters: TileFilters, fields: FilterField[], dateLabel = "Date"): string {
  const parts: string[] = [];
  const { dateFrom, dateTo, picks } = filters.applied;
  if (dateFrom || dateTo) parts.push(`${dateLabel}: ${dateFrom || "…"} to ${dateTo || "…"}`);
  for (const f of fields) {
    const values = picks[f.key] ?? [];
    if (values.length) parts.push(`${f.label}: ${values.map((v) => (f.kind === "material" ? formatMaterialPick(v, f.groups) : v)).join(", ")}`);
  }
  return parts.length ? parts.join(" · ") : "None (all records)";
}

export function addReportSheet(
  wb: XLSX.WorkBook,
  sheetName: string,
  title: string,
  filterText: string,
  rows: Record<string, unknown>[],
  // `totalValues` are the Total row's own figures for columns that cannot simply be summed (a ratio, like yield)
  options: { totals?: string[]; headers?: string[]; totalValues?: Record<string, number | string> } = {},
): void {
  const headers = options.headers ?? (rows[0] ? Object.keys(rows[0]) : []);
  const generated = new Date().toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const table: unknown[][] = [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ""))];

  if ((options.totals?.length || options.totalValues) && rows.length) {
    const sums = headers.map((h, i) => {
      if (i === 0) return "Total";
      if (options.totalValues && h in options.totalValues) return options.totalValues[h]!;
      if (!options.totals?.includes(h)) return "";
      return Math.round(rows.reduce((s, r) => s + (typeof r[h] === "number" ? (r[h] as number) : 0), 0) * 1000) / 1000;
    });
    table.push(sums);
  }

  const aoa: unknown[][] = [[title], [`Filters: ${filterText}`], [`Generated: ${generated} · ${rows.length} row${rows.length === 1 ? "" : "s"}`], [], ...table];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const headerRow = 4;
  ws["!cols"] = headers.map((h, i) => ({ wch: Math.min(42, Math.max(h.length, ...table.slice(1).map((r) => String(r[i] ?? "").length)) + 2) }));
  ws["!merges"] = [0, 1, 2].map((r) => ({ s: { r, c: 0 }, e: { r, c: Math.max(headers.length - 1, 0) } }));
  if (headers.length) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: headerRow, c: 0 }, e: { r: headerRow + rows.length, c: headers.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
}

export const stampedName = (base: string) => `${base}_${new Date().toISOString().slice(0, 10)}.xlsx`;
