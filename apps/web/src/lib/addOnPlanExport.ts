import * as XLSX from "xlsx";
import type { AddOnPlanMaterialLine, AddOnResult, AddOnSection } from "./types";

// The Add on Plan result as one Excel sheet: the product and quantity on top, then Raw Material and Packaging Material, each line with its
// stock and what is short.

const status = (l: AddOnPlanMaterialLine) => (l.onHand === null ? "Not in catalog" : l.short ? "Short" : "Complete");

function section(title: string, s: AddOnSection, withLevel: boolean): (string | number)[][] {
  const rows: (string | number)[][] = [[title]];
  if (!s.available) return [...rows, [s.problem ?? "Cannot be worked out"], []];
  rows.push(withLevel ? ["Material", "Level", "Spec", "Required", "Unit", "In Stock", "Short", "Status"] : ["Material", "Brand", "Required", "Unit", "In Stock", "Short", "Status"]);
  for (const l of s.lines) {
    const tail = [l.requiredQty, l.unit, l.onHand ?? "", l.short ? l.shortfallQty : "", status(l)];
    rows.push(withLevel ? [l.name, l.group ?? "", l.detail ?? "", ...tail] : [l.name, l.detail ?? "", ...tail]);
  }
  rows.push([]);
  return rows;
}

export function exportAddOnPlan(r: AddOnResult) {
  const unitLabel = r.unit === "KG" ? "Kg" : "Packs";
  const rows: (string | number)[][] = [
    ["Add on Plan - material check"],
    ["Product", r.productName],
    ["Customer", r.customerName],
    ["Quantity", `${r.quantity} ${unitLabel}`],
    ...(r.note ? [["Working", r.note]] : []),
    ["Checked on", new Date(r.calculatedAt).toLocaleString()],
    ["Summary", `${r.summary.total} materials: ${r.summary.total - r.summary.short - r.summary.notInCatalog} complete, ${r.summary.short} short, ${r.summary.notInCatalog} not in catalog`],
    [],
    ...section("Raw Material", r.rm, false),
    ...section("Packaging Material", r.pm, true),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [{ wch: 38 }, { wch: 22 }, { wch: 22 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 16 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Add on Plan");
  const safe = r.productName.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  XLSX.writeFile(workbook, `FLS_add_on_plan_${safe}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}
