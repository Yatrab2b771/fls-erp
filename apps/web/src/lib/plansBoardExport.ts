import * as XLSX from "xlsx";
import { api } from "./api";
import type { AddOnPlanDetail } from "./types";
import type { PlanBoardRow } from "./hooks";
import { PRE_PRODUCTION_STAGE_LABEL } from "./preProductionStage";
import { batchYieldPct, materialUsed, q3, yieldPct } from "./utilization";
import { addReportSheet, stampedName } from "./excelReport";
import type { PreProductionStageId } from "./types";
import { customerTypeLabel } from "./customerTags";

const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const hours = (a: string | null, b: string | null) => (a && b ? Math.round(((new Date(b).getTime() - new Date(a).getTime()) / 3_600_000) * 10) / 10 : "");

// A plan is "under process" until its run has produced everything: not started, preparing, ready for batches, or batches still running.
export function isUnderProcess(row: PlanBoardRow): boolean {
  if (!row.run) return true;
  const allDone = row.batches.length > 0 && row.batches.every((b) => b.status === "COMPLETED");
  return !(allDone && row.run.combinedQty >= row.run.plannedQty - 1e-6);
}

// Each tile only its own stage.
//   New Plan: not started, or (per-batch flow) still being divided into batches, or (older runs) before Line Clearance is approved.
//   Batch:    (per-batch flow) at least one batch cleared for production; (older runs) Line Clearance approved and batches to make or running.
// A plan that has produced everything is in neither (it is in the Production Report). The batches' own preparation (Indent Issue, Batch No,
// Dispensing, Line Clearance) is listed by batch on its own tiles.
const plannedInBatches = (row: PlanBoardRow) => row.batches.reduce((sum, b) => sum + b.plannedQty, 0);
export const isNewPlan = (row: PlanBoardRow) => isUnderProcess(row) && (row.run?.batchFlow ? plannedInBatches(row) + 1e-6 < row.releasedQty : ["NOT_STARTED", "PREPARING"].includes(planStatusOf(row).key));
export const isBatchStage = (row: PlanBoardRow) =>
  isUnderProcess(row) && (row.run?.batchFlow ? row.batches.some((b) => b.status === "IN_PROGRESS" && b.prepStageId === "READY") : ["READY", "IN_PRODUCTION"].includes(planStatusOf(row).key));

export function planStatusOf(row: PlanBoardRow): { key: "NOT_STARTED" | "PREPARING" | "READY" | "IN_PRODUCTION"; label: string } {
  if (!row.run) return { key: "NOT_STARTED", label: "Not started" };
  // Per-batch flow: the run has no stages; what is left to say is how far its batches are.
  if (row.run.batchFlow) {
    if (row.batches.length === 0) return { key: "READY", label: "Run started" };
    const open = row.batches.filter((b) => b.status === "IN_PROGRESS").length;
    return { key: "IN_PRODUCTION", label: open ? `${open} batch${open === 1 ? "" : "es"} in progress` : "All batches completed" };
  }
  const stage = row.run.currentStageId as PreProductionStageId;
  if (stage !== "SAMPLE_QC_APPROVAL" || row.run.sampleQcStatus !== "Approved") return { key: "PREPARING", label: PRE_PRODUCTION_STAGE_LABEL[stage] ?? stage };
  if (row.batches.length === 0) return { key: "READY", label: "Ready for batches" };
  const running = row.batches.filter((b) => b.status === "IN_PROGRESS").length;
  return { key: "IN_PRODUCTION", label: running ? `${running} batch${running === 1 ? "" : "es"} running` : "All batches completed" };
}

// One Excel file for the list as filtered on screen. Four sheets that join on PO + Product (+ Batch):
//   Plans, Plan Materials (what PPIC planned), Batches (shift / manpower / times), Utilization (batch x material, A-E, used, yield).
export async function exportPlansBoard(rows: PlanBoardRow[], filterText = "None (all records)"): Promise<void> {
  const plans = await Promise.all(
    rows.map((r) => api<{ bom: AddOnPlanDetail | null; rm: AddOnPlanDetail | null }>(`/api/purchase-orders/${r.poId}/items/${r.itemId}/plan?released=1`).catch(() => ({ bom: null, rm: null }))),
  );
  const head = (r: PlanBoardRow) => ({ "PO Number": r.poNumber ?? "", Customer: r.customerName, "Customer Type": customerTypeLabel(r.customerName), Product: r.productName });

  const planSheet = rows.map((r) => ({
    ...head(r),
    Status: planStatusOf(r).label,
    "Product Type": r.productCategory ?? "",
    Quantity: r.quantity,
    "Released Qty": r.releasedQty,
    Unit: r.unit,
    Plant: r.plant?.name ?? "",
    "Sent to Production": dt(r.sentAt),
    Batches: r.batches.length,
  }));

  const materialSheet = rows.flatMap((r, i) => [
    ...(plans[i]!.rm?.materials ?? []).map((m) => ({ ...head(r), Plan: "RM", Material: m.name, "Required Qty": m.requiredQty, Unit: m.unit, "Available (Warehouse)": m.onHand ?? "", "Short By": m.short ? m.shortfallQty : "" })),
    ...(plans[i]!.bom?.materials ?? []).map((m) => ({ ...head(r), Plan: "PM", Material: m.name, "Required Qty": m.requiredQty, Unit: m.unit, "Available (Warehouse)": m.onHand ?? "", "Short By": m.short ? m.shortfallQty : "" })),
  ]);

  const batchSheet = rows.flatMap((r) =>
    r.batches.map((b) => ({
      ...head(r),
      Status: b.status === "COMPLETED" ? "Completed" : "In progress",
      Plant: r.plant?.name ?? "",
      "Batch No": b.batchNo ?? "",
      Shift: b.shift ?? "",
      "Manpower Count": b.manpowerCount ?? "",
      "Start Time": dt(b.shiftStartAt),
      "End Time": dt(b.shiftEndAt),
      Hours: hours(b.shiftStartAt, b.shiftEndAt),
      "Planned Qty": b.plannedQty,
      "Input Qty": b.inputQty ?? "",
      "Output Qty": b.outputQty ?? "",
      Unit: r.unit,
      "Batch Yield (RM) %": batchYieldPct(b.materials) ?? "",
    })),
  );

  const utilizationSheet = rows.flatMap((r) => [
    ...r.batches.flatMap((b) => b.materials.map((m) => ({ b: b.batchNo ?? "", m, r }))),
    ...r.unassigned.map((m) => ({ b: "(no batch)", m, r })),
  ]).map(({ b, m, r }) => ({
    ...head(r),
    "Batch No": b,
    Material: m.itemName,
    Category: m.category === "RM" ? "Raw Material" : "Packaging Material",
    Unit: m.unit,
    "A - Production": q3(m.consumedQty),
    "B - Wastage": q3(m.wastedQty),
    "C - Rejected": q3(m.rejectedQty),
    "D - Sample": q3(m.sampleQty),
    "E - Return to Store": q3(m.returnedQty),
    "Material Used (A+B+C+D-E)": materialUsed(m),
    "Yield % (A / Used)": yieldPct(m) ?? "",
  }));

  const wb = XLSX.utils.book_new();
  addReportSheet(wb, "Plans", "FLS New Plan - plans from PPIC", filterText, planSheet, { totals: ["Quantity", "Released Qty", "Batches"] });
  addReportSheet(wb, "Plan Materials", "FLS New Plan - what PPIC planned (RM + PM)", filterText, materialSheet);
  addReportSheet(wb, "Batches", "FLS New Plan - batches (shift, manpower, time)", filterText, batchSheet, { totals: ["Manpower Count", "Hours", "Planned Qty", "Input Qty", "Output Qty"] });
  addReportSheet(wb, "Utilization", "FLS New Plan - material utilization (batch-wise)", filterText, utilizationSheet);
  XLSX.writeFile(wb, stampedName("FLS_New_Plan"));
}
