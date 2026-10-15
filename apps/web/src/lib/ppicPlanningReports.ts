import * as XLSX from "xlsx";
import type { MaterialPlanningProduct, MaterialPlanningRow, PendingPoMaterialRow, PreProduction, ProductionBatch } from "./types";
import { agingDays } from "../components/AgingCell";
import { PRODUCT_STATE_LABEL } from "./materialPlanning";
import { getItemStage, hasCalculatedBom, hasCalculatedRm, PPIC_PLANNING_METRIC_LABEL, type PpicPlanningMetric, type PpicPlanningResult } from "./ppicPlanning";
import { customerTypeLabel } from "./customerTags";

function download(sheetName: string, rows: Record<string, unknown>[], filename: string) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

// Material Planning export — the same (filtered) rows the list shows, one Excel
// row per material, with the product's queue state so a held / not-approved
// product's "if released" numbers can't be mistaken for a live allocation.
export function exportMaterialPlanningReport(rows: (MaterialPlanningRow & { onOrder?: { quantity: number; nextEta: string } | null })[], products: MaterialPlanningProduct[]): number {
  const productById = new Map(products.map((p) => [p.purchaseOrderItemId, p]));
  const lines = rows.map((r) => {
    const p = productById.get(r.purchaseOrderItemId);
    return {
      "PO Number": r.poNumber ?? r.purchaseOrderId.slice(0, 8),
      Status: r.status === "NOT_IN_CATALOG" ? "Not in catalog" : r.status === "SHORT" ? "Short" : "Covered",
      Customer: r.customerName,
      "Customer Type": customerTypeLabel(r.customerName),
      Product: r.productName,
      Category: r.productCategory ?? "",
      "Aging (Days)": agingDays(p?.plannedAt) ?? "",
      "Product State": p ? PRODUCT_STATE_LABEL[p.state] : "",
      Regulatory: p ? (p.regulatoryStatus ?? (p.sentToRegulatoryAt ? "Pending" : "Not Sent")) : "",
      Type: r.type === "RM" ? "Raw Material" : "Packaging Material",
      Material: r.material,
      Unit: r.unit,
      Required: r.requiredQty,
      "On Hand (Live Stock)": r.onHand ?? "",
      Covered: r.coveredQty ?? "",
      Short: r.shortQty ?? "",
      "On Order (Purchase PIs)": r.onOrder?.quantity ?? "",
      "Next ETA": r.onOrder ? new Date(r.onOrder.nextEta).toLocaleDateString() : "",
      "If Released (Preview)": r.isPreview ? "Yes" : "",
    };
  });
  download("Material Planning", lines, `FLS_PPIC_material_planning_${todayStamp()}.xlsx`);
  return lines.length;
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

    const lines = result.rows.map(({ po, item, sinceAt }) => {
      const materials = materialsByItemId.get(item.id);
      const isDelayed = !!po.expectedDeliveryDate && new Date(po.expectedDeliveryDate) < new Date();
      return {
        "PO Number": po.poNumber ?? po.id.slice(0, 8),
        "Current Stage": getItemStage(item, preRuns, batches),
        Customer: po.customer.companyName,
        "Customer Type": customerTypeLabel(po.customer.companyName),
        "In List Since": (sinceAt ?? "").slice(0, 10),
        Product: item.productName,
        Quantity: item.quantity,
        Unit: item.unit,
        "Aging (Days)": agingDays(sinceAt) ?? "",
        "Expected Delivery": po.expectedDeliveryDate ? po.expectedDeliveryDate.slice(0, 10) : "",
        Delayed: po.expectedDeliveryDate ? (isDelayed ? "Yes" : "No") : "",
        "Regulatory Body": po.regulatoryBody ?? "",
        "RM Materials": materialsToText(materials?.rmMaterials, materials?.rmPlanned),
        "PM Materials": materialsToText(materials?.pmMaterials, materials?.bomPlanned),
      };
    });

    download(label, lines, `FLS_PPIC_pending_pos_${todayStamp()}.xlsx`);
    return lines.length;
  }

  if (metric === "cancelled" && result.kind === "item") {
    const lines = result.rows.map(({ po, item, sinceAt }) => ({
      "PO Number": po.poNumber ?? po.id.slice(0, 8),
      Customer: po.customer.companyName,
      "Customer Type": customerTypeLabel(po.customer.companyName),
      "In List Since": (sinceAt ?? "").slice(0, 10),
      "Aging (Days)": agingDays(sinceAt) ?? "",
      Product: item.productName,
      Category: item.productCategory ?? "",
      Quantity: item.quantity,
      Unit: item.unit,
      "Cancelled On": item.cancelledAt?.slice(0, 10) ?? "",
      Reason: item.cancelReason ?? "",
    }));
    download(label, lines, `FLS_PPIC_cancelled_${todayStamp()}.xlsx`);
    return lines.length;
  }

  if (metric === "on-hold" && result.kind === "item") {
    const lines = result.rows.map(({ po, item, sinceAt }) => ({
      "PO Number": po.poNumber ?? po.id.slice(0, 8),
      Customer: po.customer.companyName,
      "Customer Type": customerTypeLabel(po.customer.companyName),
      "In List Since": (sinceAt ?? "").slice(0, 10),
      "Aging (Days)": agingDays(sinceAt) ?? "",
      Product: item.productName,
      Category: item.productCategory ?? "",
      Quantity: item.quantity,
      Unit: item.unit,
      "On Hold Since": item.materialHeldAt?.slice(0, 10) ?? "",
      Planning: hasCalculatedRm(item) && hasCalculatedBom(item) ? "Planned" : hasCalculatedRm(item) || hasCalculatedBom(item) ? "Partially Planned" : "Not Planned",
    }));
    download(label, lines, `FLS_PPIC_on_hold_${todayStamp()}.xlsx`);
    return lines.length;
  }

  if (metric === "plan-sent" && result.kind === "item") {
    const { preRuns, batches } = pendingPosExtras ?? { preRuns: [], batches: [] };
    const lines = result.rows.map(({ po, item, sinceAt }) => ({
      "PO Number": po.poNumber ?? po.id.slice(0, 8),
      "Current Stage": getItemStage(item, preRuns, batches),
      Customer: po.customer.companyName,
      "Customer Type": customerTypeLabel(po.customer.companyName),
      "In List Since": (sinceAt ?? "").slice(0, 10),
      "Aging (Days)": agingDays(sinceAt) ?? "",
      Product: item.productName,
      Category: item.productCategory ?? "",
      Quantity: item.quantity,
      Unit: item.unit,
      Plant: item.plannedPlant?.name ?? "",
      "Sent On": item.planSentToProductionAt?.slice(0, 10) ?? "",
    }));
    download(label, lines, `FLS_PPIC_in_production_${todayStamp()}.xlsx`);
    return lines.length;
  }

  if (metric === "not-planned-pos" && result.kind === "item") {
    const lines = result.rows.map(({ po, item, sinceAt }) => ({
      "PO Number": po.poNumber ?? po.id.slice(0, 8),
      Status: hasCalculatedRm(item) || hasCalculatedBom(item) ? "Partially Planned" : "Not Planned",
      Customer: po.customer.companyName,
      "Customer Type": customerTypeLabel(po.customer.companyName),
      "In List Since": (sinceAt ?? "").slice(0, 10),
      "Aging (Days)": agingDays(sinceAt) ?? "",
      Product: item.productName,
      Category: item.productCategory ?? "",
      Quantity: item.quantity,
      Unit: item.unit,
      "Order Date": po.orderDate?.slice(0, 10) ?? "",
      "RM BOM": hasCalculatedRm(item) ? "Yes" : "No",
      "PM BOM": hasCalculatedBom(item) ? "Yes" : "No",
    }));
    download(label, lines, `FLS_PPIC_not_planned_${todayStamp()}.xlsx`);
    return lines.length;
  }

  const lines =
    result.kind === "po"
      ? result.rows.map((po) => ({
          "PO Number": po.poNumber ?? po.id.slice(0, 8),
          Status: po.status,
          Customer: po.customer.companyName,
          "Customer Type": customerTypeLabel(po.customer.companyName),
          "In List Since": ((po as { sinceAt?: string }).sinceAt ?? "").slice(0, 10),
          "Aging (Days)": agingDays((po as { sinceAt?: string }).sinceAt) ?? "",
          "Order Date": po.orderDate?.slice(0, 10) ?? "",
          "Product Count": po.items.length,
          Completed: po.completion.isCompleted ? "Yes" : "No",
        }))
      : result.rows.map(({ po, item, sinceAt }) => ({
          "PO Number": po.poNumber ?? po.id.slice(0, 8),
          Customer: po.customer.companyName,
          "Customer Type": customerTypeLabel(po.customer.companyName),
          "In List Since": (sinceAt ?? "").slice(0, 10),
          "Aging (Days)": agingDays(sinceAt) ?? "",
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
