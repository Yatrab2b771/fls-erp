import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Beaker, Download, FileStack, FlaskConical } from "lucide-react";
import { usePoFullReport } from "../lib/hooks";
import { downloadFile } from "../lib/api";
import { EmptyState } from "../components/EmptyState";
import type { PoFullReportBatch, StageHistoryRow } from "../lib/types";

// The on-screen twin of po-full-report-pdf.ts — same data (from
// usePoFullReport, GET /:id/full-report), same field labels, so switching
// between "read it here" and "download it as a PDF" never shows
// different numbers. Every product line's PreProduction walk, then every
// ProductionBatch under it with its own execution + Tier-3 walk.

const TIER1_LABELS: Record<string, string> = {
  grnNo: "GRN No.",
  grnDate: "GRN Date",
  materialReceivedRemarks: "Material Received Remarks",
  prodIndentSlipSign: "Production Indent Slip Sign",
  productionPlanDate: "Production Plan Date",
  unit: "Manufacturing Unit",
  dispatchPlanDate: "Dispatch Plan Date",
  lineClearanceStatus: "Line Clearance Status",
  lineClearanceRemarks: "Line Clearance Remarks",
  rmDispensingDate: "RM Dispensing Date",
  rmDispensingRemarks: "RM Dispensing Remarks",
  pmIssuedDate: "PM Issued Date",
  pmDispensingRemarks: "PM Dispensing Remarks",
  sampleQcStatus: "Sample QC Status",
  sampleQcRemarks: "Sample QC Remarks",
};

const TIER3_LABELS: Record<string, string> = {
  ipqcStatus: "IPQC Status",
  ipqcRemarks: "IPQC Remarks",
  mfgQaStatus: "QA Gate (Mfg) — QA Status",
  mfgQcStatus: "QA Gate (Mfg) — QC Status",
  mfgRemarks: "QA Gate (Mfg) Remarks",
  mfgApprovedQty: "Mfg Approved Qty",
  mfgRejectedQty: "Mfg Rejected Qty",
  mfgWastageQty: "Mfg Wastage Qty",
  bulkQcStatus: "Bulk QC Status",
  bulkQcRemarks: "Bulk QC Remarks",
  packagingStartDate: "Packaging Start",
  packagingStatus: "Packaging Status",
  packagingEndDate: "Packaging End",
  packagingRemarks: "Packaging Remarks",
  packQaStatus: "QA Gate (Packaging) — QA Status",
  packQcStatus: "QA Gate (Packaging) — QC Status",
  packRemarks: "QA Gate (Packaging) Remarks",
  packApprovedQty: "Pack Approved Qty",
  packRejectedQty: "Pack Rejected Qty",
  packWastageQty: "Pack Wastage Qty",
  invoiceNo: "Invoice No.",
  invoiceDate: "Invoice Date",
  ewayBillNo: "E-Way Bill No.",
  ewayBillDate: "E-Way Bill Date",
  billingRemarks: "Billing Remarks",
  dispatchDate: "Dispatch Date",
  dispatchedQty: "Dispatched Qty",
  shipperQty: "Shipper Qty",
  totalShipperWeight: "Total Shipper Weight",
  transportType: "Transport Type",
  remainingQty: "Remaining Qty",
  anyRemarks: "Any Remarks",
};

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleDateString();
  return String(v);
}

function FieldTable({ fields, labels }: { fields: Record<string, unknown>; labels: Record<string, string> }) {
  const rows = Object.entries(fields).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (rows.length === 0) return <p className="text-[11px] text-slate-400">No data recorded yet.</p>;
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-2 border-b border-slate-50 py-1 text-[11px]">
          <span className="text-slate-400">{labels[k] ?? k}</span>
          <span className="font-bold text-slate-700">{fmt(v)}</span>
        </div>
      ))}
    </div>
  );
}

function HistoryTable({ history }: { history: StageHistoryRow[] }) {
  if (history.length === 0) return null;
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="table-modern w-full text-[11px]">
        <thead>
          <tr>
            <th>Action</th>
            <th>From</th>
            <th>To</th>
            <th>By</th>
            <th>When</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h, i) => (
            <tr key={i}>
              <td className="font-bold text-slate-600">{h.action}</td>
              <td className="text-slate-500">{h.fromLabel}</td>
              <td className="text-slate-500">{h.toLabel}</td>
              <td className="text-slate-500">{h.actorName}</td>
              <td className="font-mono text-slate-400">{new Date(h.createdAt).toLocaleString()}</td>
              <td className="text-slate-400">{h.note ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BatchCard({ batch, index, unit }: { batch: PoFullReportBatch; index: number; unit: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/40 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold text-slate-700">
          Batch {index + 1}
          {batch.batchNo && <span className="font-mono text-slate-500"> — {batch.batchNo}</span>}
        </p>
        <div className="flex items-center gap-2">
          <span className="pill border-slate-200 bg-white text-slate-600">{batch.status}</span>
          <span className="pill border-amber-200 bg-amber-50 text-amber-700">{batch.currentStageId}</span>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
        <div>
          <span className="text-slate-400">Planned</span> <span className="font-bold text-slate-700">{batch.plannedQty}</span> {unit}
        </div>
        <div>
          <span className="text-slate-400">Input</span> <span className="font-bold text-slate-700">{fmt(batch.inputQty)}</span>
        </div>
        <div>
          <span className="text-slate-400">Output</span> <span className="font-bold text-slate-700">{fmt(batch.outputQty)}</span>
        </div>
        <div>
          <span className="text-slate-400">Wastage</span> <span className="font-bold text-slate-700">{fmt(batch.wastageQty)}</span>
        </div>
      </div>
      <div className="mt-3">
        <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">Tier-3 Pipeline (IPQC → Dispatch)</p>
        <FieldTable fields={batch.tier3Fields} labels={TIER3_LABELS} />
      </div>
      <HistoryTable history={batch.history} />
    </div>
  );
}

export function PoFullReportPage() {
  const { id } = useParams<{ id: string }>();
  const { data: report, isLoading } = usePoFullReport(id);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-4 w-40" />
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }
  if (!report) return <EmptyState icon={FileStack} title="Purchase order not found" accent="rose" />;

  const { po, items, totals } = report;

  return (
    <div className="space-y-6">
      <Link to={`/purchase-orders/${po.id}`} className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Back to {po.poNumber ?? "Purchase Order"}
      </Link>

      <div className="card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="stat-icon bg-brand-50 text-brand-600">
              <FileStack className="h-5 w-5" strokeWidth={2} />
            </div>
            <div>
              <h1 className="text-xl font-black tracking-tight text-slate-900">Full Report — {po.poNumber ?? po.id.slice(0, 8)}</h1>
              <p className="text-sm text-slate-500">
                {po.customerName} · {po.status}
              </p>
            </div>
          </div>
          <button
            className="btn-primary btn-sm"
            onClick={() => downloadFile(`/api/purchase-orders/${po.id}/full-report.pdf`, `FLS_PO_Full_Report_${po.poNumber ?? po.id}.pdf`)}
          >
            <Download className="h-3.5 w-3.5" strokeWidth={2.5} /> Download PDF
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Products</p>
            <p className="text-lg font-black text-slate-800">{totals.itemCount}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Batches</p>
            <p className="text-lg font-black text-slate-800">{totals.batchCount}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Planned Total</p>
            <p className="text-lg font-black text-slate-800">{totals.plannedTotal}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Dispatched Total</p>
            <p className="text-lg font-black text-emerald-700">{totals.dispatchedTotal}</p>
          </div>
        </div>
      </div>

      {items.map((item, idx) => (
        <div key={item.id} className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-gradient-to-r from-brand-50/60 to-white px-5 py-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Product {idx + 1}</p>
              <h2 className="text-base font-black text-slate-900">{item.productName}</h2>
              <p className="text-[11px] text-slate-500">
                Ordered {item.quantity} {item.unit} · {item.productType} · {item.batchCount} batch{item.batchCount === 1 ? "" : "es"} · Dispatched {item.dispatchedTotal} {item.unit}
              </p>
            </div>
          </div>

          <div className="space-y-4 p-5">
            {!item.preProduction ? (
              <p className="text-xs text-slate-400">Production hasn't started on this line item yet.</p>
            ) : (
              <>
                <div>
                  <div className="flex items-center justify-between">
                    <p className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
                      <Beaker className="h-3.5 w-3.5" strokeWidth={2.5} /> Pre-Production — {item.preProduction.combinedQty} / {item.preProduction.plannedQty} produced
                    </p>
                    <span className="pill border-brand-200 bg-brand-50 text-brand-700">{item.preProduction.currentStageId}</span>
                  </div>
                  <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50/40 p-3.5">
                    <FieldTable fields={item.preProduction.tier1Fields} labels={TIER1_LABELS} />
                    <HistoryTable history={item.preProduction.history} />
                  </div>
                </div>

                <div>
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-slate-600">
                    <FlaskConical className="h-3.5 w-3.5" strokeWidth={2.5} /> Production Batches ({item.batches.length})
                  </p>
                  {item.batches.length === 0 ? (
                    <p className="text-[11px] text-slate-400">No production batches created yet.</p>
                  ) : (
                    <div className="space-y-3">
                      {item.batches.map((b, bIdx) => (
                        <BatchCard key={b.id} batch={b} index={bIdx} unit={item.unit} />
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
