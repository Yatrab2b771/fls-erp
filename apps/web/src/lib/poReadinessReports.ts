import * as XLSX from "xlsx";
import type { PoReadinessRow } from "./types";

function download(sheetName: string, rows: Record<string, unknown>[], filename: string) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

const CATEGORY_LABEL: Record<string, string> = { RM: "Raw Material", PM: "Packaging Material" };

// Reports #2 and #4 share one shape — "customer-wise pending RM/PM
// list", #4 just being #2 pre-filtered to a picked set of customers.
// Only the *uncovered* line items are included per PO — same allocation
// PoReadinessPage already computed and has loaded (see PoReadinessRow:
// item.covered/onHand come out of computeReadiness's ordered, running-
// balance allocation, so two POs sharing the same short item never both
// claim it here either).
export function exportCustomerShortfallReport(rows: PoReadinessRow[], customerIds?: string[]) {
  const scoped = customerIds?.length ? rows.filter((r) => customerIds.includes(r.purchaseOrder.customer.id)) : rows;
  const lines = scoped.flatMap((r) =>
    r.items
      .filter((item) => !item.covered)
      .map((item) => ({
        Customer: r.purchaseOrder.customer.companyName,
        "PO Number": r.purchaseOrder.poNumber ?? r.purchaseOrder.id.slice(0, 8),
        Brand: r.purchaseOrder.brandName ?? "",
        Item: item.itemName,
        Category: CATEGORY_LABEL[item.category] ?? item.category,
        "Required Qty": item.requiredQty,
        "On Hand": item.onHand,
        "Short By": Math.max(0, item.requiredQty - item.onHand),
        Unit: item.unit,
      })),
  );
  lines.sort((a, b) => a.Customer.localeCompare(b.Customer) || a["PO Number"].localeCompare(b["PO Number"]));

  const label = customerIds?.length ? `Selected Customers (${customerIds.length})` : "All Customers";
  download(
    "RM-PM Shortfall",
    lines,
    `FLS_PO_Readiness_Shortfall_${customerIds?.length ? "Selected" : "By_Customer"}_${todayStamp()}.xlsx`,
  );
  return { label, lineCount: lines.length };
}

// Report #3 — overall RM/PM shortfall, one row per item (not per PO):
// every uncovered requirement line for that item, across every PO,
// summed. Reuses the exact per-PO shortfall figures computeReadiness
// already allocated in creation order, so summing them is safe — it's
// not re-checking the same stock twice, just totaling what each PO in
// the queue was already found short by.
export function exportOverallShortfallReport(rows: PoReadinessRow[]) {
  const byItem = new Map<string, { itemName: string; category: string; unit: string; shortQty: number; poCount: number; poNumbers: Set<string> }>();
  for (const row of rows) {
    for (const item of row.items) {
      if (item.covered) continue;
      const shortQty = Math.max(0, item.requiredQty - item.onHand);
      const existing = byItem.get(item.itemId);
      const poLabel = row.purchaseOrder.poNumber ?? row.purchaseOrder.id.slice(0, 8);
      if (existing) {
        existing.shortQty += shortQty;
        existing.poNumbers.add(poLabel);
      } else {
        byItem.set(item.itemId, { itemName: item.itemName, category: item.category, unit: item.unit, shortQty, poCount: 0, poNumbers: new Set([poLabel]) });
      }
    }
  }

  const lines = [...byItem.values()]
    .map((v) => ({
      Item: v.itemName,
      Category: CATEGORY_LABEL[v.category] ?? v.category,
      "Total Short Qty": Math.round(v.shortQty * 100) / 100,
      Unit: v.unit,
      "POs Affected": v.poNumbers.size,
      "PO Numbers": [...v.poNumbers].join(", "),
    }))
    .sort((a, b) => b["Total Short Qty"] - a["Total Short Qty"]);

  download("Overall RM-PM Shortfall", lines, `FLS_PO_Readiness_Overall_Shortfall_${todayStamp()}.xlsx`);
}
