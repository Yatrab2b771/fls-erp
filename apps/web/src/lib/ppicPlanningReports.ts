import * as XLSX from "xlsx";
import type { PendingPoMaterialRow, PreProduction, ProductionBatch } from "./types";
import { getItemStage, getPoAgingDays, hasCalculatedBom, hasCalculatedRm, PPIC_PLANNING_METRIC_LABEL, type PpicPlanningMetric, type PpicPlanningResult } from "./ppicPlanning";

function download(sheetName: string, rows: Record<string, unknown>[], filename: string) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

// One material list -> "Name (qty unit) [Short by X unit]; ..." — Excel
// has no nested-list cell, so each product's RM/PM materials collapse
// into one semicolon-joined text column, same shape spreadsheet users
// already expect from this app's other "list in one cell" exports.
function materialsToText(materials: PendingPoMaterialRow["rmMaterials"] | undefined, planned: boolean | undefined): string {
  if (!materials || materials.length === 0) return planned ? "—" : "Not Planned Yet";
  return materials.map((m) => `${m.name} (${m.requiredQty} ${m.unit})${m.short ? ` [SHORT by ${m.shortfallQty} ${m.unit}]` : m.onHand === null ? " [not in catalog]" : " [OK]"}`).join("; ");
}

// One Excel export per PPIC planning tile — takes the exact same
// (already search-filtered, if the caller has a search box open) result
// the tile's own drill-down table is rendering (see
// PpicPlanningDetailPage.tsx / ppicPlanning.ts's filterPpicPlanningResult),
// so what gets downloaded always matches what's on screen. pending-pos
// needs extra data (PreProduction/ProductionBatch stage + the material
// breakdown) the other tiles don't, so it's passed in optionally by the
// one caller that has it loaded.
export function exportPpicPlanningReport(
  metric: PpicPlanningMetric,
  result: PpicPlanningResult,
  pendingPosExtras?: { preRuns: PreProduction[]; batches: ProductionBatch[]; materialRows: PendingPoMaterialRow[] },
): number {
  const label = PPIC_PLANNING_METRIC_LABEL[metric];

  if (metric === "pending-pos" && result.kind === "item") {
    const { preRuns, batches, materialRows } = pendingPosExtras ?? { preRuns: [], batches: [], materialRows: [] };
    const materialsByItemId = new Map(materialRows.map((r) => [r.purchaseOrderItemId, r]));

    const lines = result.rows.map(({ po, item }) => {
      const materials = materialsByItemId.get(item.id);
      const isDelayed = !!po.expectedDeliveryDate && new Date(po.expectedDeliveryDate) < new Date();
      return {
        "PO Number": po.poNumber ?? po.id.slice(0, 8),
        Customer: po.customer.companyName,
        Product: item.productName,
        Quantity: item.quantity,
        Unit: item.unit,
        "Aging (Days)": getPoAgingDays(po),
        "Expected Delivery": po.expectedDeliveryDate ? po.expectedDeliveryDate.slice(0, 10) : "",
        Delayed: po.expectedDeliveryDate ? (isDelayed ? "Yes" : "No") : "",
        "Regulatory Body": po.regulatoryBody ?? "",
        "Current Stage": getItemStage(item, preRuns, batches),
        "RM Materials": materialsToText(materials?.rmMaterials, materials?.rmPlanned),
        "PM Materials": materialsToText(materials?.pmMaterials, materials?.bomPlanned),
      };
    });

    download(label, lines, `FLS_PPIC_pending_pos_${todayStamp()}.xlsx`);
    return lines.length;
  }

  const lines =
    result.kind === "po"
      ? result.rows.map((po) => ({
          "PO Number": po.poNumber ?? po.id.slice(0, 8),
          Customer: po.customer.companyName,
          "Order Date": po.orderDate?.slice(0, 10) ?? "",
          Status: po.status,
          "Product Count": po.items.length,
          Completed: po.completion.isCompleted ? "Yes" : "No",
        }))
      : result.rows.map(({ po, item }) => ({
          "PO Number": po.poNumber ?? po.id.slice(0, 8),
          Customer: po.customer.companyName,
          Product: item.productName,
          Quantity: item.quantity,
          Unit: item.unit,
          "Packaging BOM": hasCalculatedBom(item) ? "Yes" : "No",
          "RM BOM": hasCalculatedRm(item) ? "Yes" : "No",
          "Plan Sent to Production": item.planSentToProductionAt ? item.planSentToProductionAt.slice(0, 10) : "No",
        }));

  download(label, lines, `FLS_PPIC_${metric.replace(/-/g, "_")}_${todayStamp()}.xlsx`);
  return lines.length;
}
