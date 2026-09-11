import { prisma } from "../../common/lib/prisma";
import { transitionPreProductionStage } from "./pre-production-transition";
import { transitionCombinedLotStage } from "./combined-lot-transition";
import type { RoleName } from "@prisma/client";

// --- Bulk "Forward the current stage" import — one row per (PO Number,
// Product Name) pair, touching only whatever stage that item's run is
// currently sitting at (the same single-step action the manual Forward
// button already performs), not a run's whole history in one shot. A
// row resolves to whichever tier is actually active: the item's
// PreProduction run if it hasn't finished pooling into a CombinedLot
// yet, or that CombinedLot once it exists — both are 1:1 with the PO
// item now, so (PO Number, Product Name) alone disambiguates, no more
// Batch No. column needed the way the old per-Batch version required.
// Runs every row through the same transitionPreProductionStage/
// transitionCombinedLotStage gating a manual Forward uses, so a row is
// blocked by the PO Readiness/Dispensing-requirement gates or department
// RBAC exactly the way a manual attempt would be; this never bypasses
// them. ---

export interface BatchImportRow {
  poNumber: string;
  productName: string;
  note?: string;
  confirmPartialDispatch?: boolean;
  // Whichever of that run's *current* stage's fields the row supplied —
  // same shape PATCH /:id/stage's body accepts. Columns for other stages
  // are simply ignored by the transition's own field-schema parsing,
  // same as an extra key in any other request body.
  fields: Record<string, unknown>;
}

export interface BatchImportRowResult {
  row: number;
  poNumber: string;
  productName: string;
  status: "forwarded" | "blocked" | "unmatched" | "error";
  message: string;
}

export interface BatchImportSummary {
  rowsProcessed: number;
  forwarded: number;
  blocked: number;
  unmatched: number;
  results: BatchImportRowResult[];
}

export async function importBatchStages(rows: BatchImportRow[], actorId: string, actorRoles: RoleName[]): Promise<BatchImportSummary> {
  const results: BatchImportRowResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rowNum = i + 1;

    const purchaseOrder = await prisma.purchaseOrder.findFirst({ where: { poNumber: { equals: row.poNumber, mode: "insensitive" } }, select: { id: true } });
    if (!purchaseOrder) {
      results.push({ row: rowNum, poNumber: row.poNumber, productName: row.productName, status: "unmatched", message: `No purchase order found with PO Number "${row.poNumber}".` });
      continue;
    }

    const item = await prisma.purchaseOrderItem.findFirst({
      where: { purchaseOrderId: purchaseOrder.id, productName: { equals: row.productName, mode: "insensitive" } },
      select: { id: true },
    });
    if (!item) {
      results.push({ row: rowNum, poNumber: row.poNumber, productName: row.productName, status: "unmatched", message: `PO "${row.poNumber}" has no line item named "${row.productName}".` });
      continue;
    }

    const run = await prisma.preProduction.findUnique({ where: { purchaseOrderItemId: item.id }, include: { combinedLot: true } });
    if (!run) {
      results.push({ row: rowNum, poNumber: row.poNumber, productName: row.productName, status: "unmatched", message: "Found the PO/product, but production hasn't started on it yet." });
      continue;
    }

    // Once a CombinedLot exists, the PreProduction run itself has
    // nothing left to forward (SAMPLE_QC_APPROVAL is its own terminal
    // stage, completing in place) — route the row to the lot instead.
    if (run.combinedLot) {
      const result = await transitionCombinedLotStage({
        lot: run.combinedLot,
        action: "FORWARD",
        note: row.note,
        confirmPartialDispatch: row.confirmPartialDispatch,
        rawBody: row.fields,
        actorId,
        actorRoles,
      });
      if (!result.ok) {
        results.push({ row: rowNum, poNumber: row.poNumber, productName: row.productName, status: "blocked", message: result.error });
        continue;
      }
      results.push({ row: rowNum, poNumber: row.poNumber, productName: row.productName, status: "forwarded", message: `Forwarded to ${result.effectiveTarget}.` });
      continue;
    }

    const result = await transitionPreProductionStage({
      run,
      action: "FORWARD",
      note: row.note,
      rawBody: row.fields,
      actorId,
      actorRoles,
    });

    if (!result.ok) {
      results.push({ row: rowNum, poNumber: row.poNumber, productName: row.productName, status: "blocked", message: result.error });
      continue;
    }
    if (result.dispensingShortfall.length > 0) {
      const list = result.dispensingShortfall.map((s) => `${s.itemName} (needs ${s.requiredQty} ${s.unit}, have ${s.consumedQty})`).join("; ");
      results.push({ row: rowNum, poNumber: row.poNumber, productName: row.productName, status: "blocked", message: `Saved — still short: ${list}` });
      continue;
    }
    results.push({ row: rowNum, poNumber: row.poNumber, productName: row.productName, status: "forwarded", message: `Forwarded to ${result.effectiveTarget}.` });
  }

  return {
    rowsProcessed: results.length,
    forwarded: results.filter((r) => r.status === "forwarded").length,
    blocked: results.filter((r) => r.status === "blocked").length,
    unmatched: results.filter((r) => r.status === "unmatched").length,
    results,
  };
}
