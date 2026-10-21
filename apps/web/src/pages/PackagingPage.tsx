import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, Check, Download, PackageCheck, Save, Send } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useHandOverBatch, usePackagingBoard, usePlansBoard, useUpdatePackaging, type PlanBoardRow } from "../lib/hooks";
import type { ProductionBatch } from "../lib/types";
import { PACKAGING_STATUSES } from "../lib/productionBatchStage";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { ActionMenu, type ActionMenuItem } from "../components/ActionMenu";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { UtilizationFillForm } from "../components/UtilizationFillForm";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";

const CELL = "field !h-8 !py-0 !px-2 !text-xs disabled:!bg-transparent disabled:!border-transparent disabled:!text-slate-700 disabled:!opacity-100 disabled:!shadow-none";
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const isCompleted = (status: string | null) => String(status ?? "").trim().toLowerCase() === "completed";

// Production's Packaging tile: the batches that have passed Bulk QC. Each row is one batch number. First the RM Utilization of the whole batch is
// filled (produced, waste, reject, sample; every material fills itself from the plan and can be edited), and only then Packaging opens: its own
// production sheet (shift, manpower, start and end date-time, status, remarks) and, after the packing, the PM Utilization (label, tub, carton...).
// The end of Packaging (status Completed, end time, remarks) opens only once every plan PM has its quantity; then the batch is handed over to QA.
export function PackagingPage() {
  const { hasRole } = useAuth();
  const canAct = hasRole("PRODUCTION", "ADMIN");
  const { data, isLoading } = usePackagingBoard();
  const { data: plans } = usePlansBoard();
  const filters = useTileFilters();
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const everyRow = data ?? [];
  const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct(everyRow.map((b) => b.preProduction.purchaseOrderItem.purchaseOrder.poNumber)) },
    { key: "product", label: "Product", options: distinct(everyRow.map((b) => b.preProduction.purchaseOrderItem.productName)) },
    { key: "batchno", label: "Batch No", options: distinct(everyRow.map((b) => b.batchNo)) },
  ];
  const rows = everyRow.filter(
    (b) =>
      (!picked("po").length || picked("po").includes(b.preProduction.purchaseOrderItem.purchaseOrder.poNumber ?? "")) &&
      (!picked("product").length || picked("product").includes(b.preProduction.purchaseOrderItem.productName)) &&
      (!picked("batchno").length || picked("batchno").includes(b.batchNo ?? "")),
  );
  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;
  const planRowOf = (b: ProductionBatch) => (plans ?? []).find((p) => p.batches.some((x) => x.id === b.id));

  function download() {
    const lines = rows.map((b) => ({
      "Batch No": b.batchNo ?? "",
      "PO Number": b.preProduction.purchaseOrderItem.purchaseOrder.poNumber ?? "",
      Product: b.preProduction.purchaseOrderItem.productName,
      "Batch Qty": b.plannedQty,
      Shift: b.packagingShift ?? "",
      Manpower: b.packagingManpowerCount ?? "",
      "Start": b.packagingStartAt ? new Date(b.packagingStartAt).toLocaleString("en-GB") : "",
      "End": b.packagingEndAt ? new Date(b.packagingEndAt).toLocaleString("en-GB") : "",
      "Packaging Status": b.packagingStatus ?? "",
      "RM Utilization": b.utilization ? (b.utilization.complete ? "Done" : "Pending") : "",
      "PM Utilization": b.utilization ? `${b.utilization.pm.logged} of ${b.utilization.pm.required}` : "",
      Remarks: b.packagingRemarks ?? "",
    }));
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Packaging", "FLS Packaging (batch-wise)", describeFilters(filters, fields), lines);
    XLSX.writeFile(wb, stampedName("FLS_Packaging"));
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-sky-500/10 text-sky-600">
            <PackageCheck className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Packaging</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} batch{rows.length === 1 ? "" : "es"}
              {isFiltered ? ` of ${everyRow.length}` : ""} that passed Bulk QC. Fill the RM Utilization first, then the packaging sheet and the PM Utilization of each batch, then hand it over to QA.
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm shrink-0" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey="packaging" fields={fields} dateLabel="Completed" hideDates />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={PackageCheck} title={isFiltered ? "Nothing matches these filters" : "No batch at Packaging"} hint="A batch shows here once it has passed IPQC, the manufacturing QA gate and Bulk QC." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2.5">Batch No</th>
                  <th className="px-3 py-2.5">Product</th>
                  <th className="px-3 py-2.5 text-right">Qty</th>
                  <th className="px-3 py-2.5">RM Utilization</th>
                  <th className="px-3 py-2.5">Shift</th>
                  <th className="px-3 py-2.5">Manpower</th>
                  <th className="px-3 py-2.5">Start date &amp; time</th>
                  <th className="px-3 py-2.5">Packaging status</th>
                  <th className="px-3 py-2.5">PM Utilization</th>
                  <th className="px-3 py-2.5">End date &amp; time</th>
                  <th className="px-3 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pg.rows.map((b) => (
                  <PackagingRow key={b.id} batch={b} plan={planRowOf(b)} canAct={canAct} />
                ))}
              </tbody>
            </table>
          </div>
          <ClientPager pg={pg} />
        </div>
      )}
    </div>
  );
}

function PackagingRow({ batch, plan, canAct }: { batch: ProductionBatch; plan: PlanBoardRow | undefined; canAct: boolean }) {
  const toast = useToast();
  const update = useUpdatePackaging();
  const handOver = useHandOverBatch();
  const [open, setOpen] = useState(!(batch.utilization ? batch.utilization.complete : true));
  const [v, setV] = useState({
    packagingShift: batch.packagingShift ?? "",
    packagingManpowerCount: batch.packagingManpowerCount != null ? String(batch.packagingManpowerCount) : "",
    packagingStartAt: toLocalInput(batch.packagingStartAt),
    packagingStatus: batch.packagingStatus ?? "",
    packagingEndAt: toLocalInput(batch.packagingEndAt),
    packagingRemarks: batch.packagingRemarks ?? "",
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((cur) => ({ ...cur, [k]: e.target.value }));
  const pm = batch.utilization?.pm;
  const pmDone = pm ? pm.complete : true;
  // Packaging opens only once the RM Utilization of the whole batch is filled.
  const rmDone = batch.utilization ? batch.utilization.complete : true;
  const startFilled = !!batch.packagingShift && !!batch.packagingManpowerCount && !!batch.packagingStartAt;
  const sheetLocked = !canAct || !rmDone;
  const finishLocked = sheetLocked || !pmDone || !startFilled;
  const tip = !rmDone ? "Fill the RM Utilization first" : !startFilled ? "Fill and Save the start fields first (shift, manpower, start date & time)" : !pmDone ? "Fill the PM Utilization first" : undefined;
  const done = isCompleted(batch.packagingStatus);
  const item = batch.preProduction.purchaseOrderItem;

  async function save() {
    try {
      const body: Record<string, unknown> = { id: batch.id };
      for (const [k, val] of Object.entries(v)) {
        if (val === "") continue;
        if (finishLocked && (k === "packagingEndAt" || k === "packagingRemarks" || (k === "packagingStatus" && isCompleted(val)))) continue; // shut until the PM Utilization and start fields are in
        body[k] = k === "packagingManpowerCount" ? Number(val) : k === "packagingStartAt" || k === "packagingEndAt" ? new Date(val).toISOString() : val;
      }
      await update.mutateAsync(body as never);
      toast.success("Saved.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
    }
  }
  async function hand() {
    if (!window.confirm("Hand this batch over to QA? It then waits at QA's packaging gate.")) return;
    try {
      await handOver.mutateAsync(batch.id);
      toast.success("Handed over to QA.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not hand over");
    }
  }
  const items: ActionMenuItem[] = canAct
    ? [
        { key: "save", label: update.isPending ? "Saving…" : "Save", icon: Save, onClick: save, disabled: update.isPending },
        { key: "hand", label: handOver.isPending ? "Handing over…" : "Hand over to QA", icon: Send, tone: "primary", onClick: hand, disabled: !done || handOver.isPending, title: done ? undefined : "Packaging status must be Completed first" },
      ]
    : [];

  return (
    <Fragment>
      <tr className={open ? "bg-slate-50/70" : "hover:bg-slate-50"}>
        <td className="px-3 py-1.5 font-mono font-black text-orange-800">{batch.batchNo ?? `Batch ${batch.id.slice(0, 8)}`}</td>
        <td className="px-3 py-1.5 font-bold text-slate-800">
          {item.productName}
          <span className="block text-micro font-normal text-slate-400">{item.purchaseOrder.poNumber ?? "—"}</span>
        </td>
        <td className="px-3 py-1.5 text-right font-mono text-slate-600">
          {fmtQty(batch.plannedQty)} {item.unit}
        </td>
        <td className="px-3 py-1.5">
          <button type="button" onClick={() => setOpen((o) => !o)} className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-tiny font-bold ${rmDone ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`} title={rmDone ? "RM Utilization is saved (editable until handover)" : "Fill the RM Utilization of the whole batch first"}>
            {rmDone ? "Done" : "Fill"} {open ? "▴" : "▾"}
          </button>
        </td>
        <td className="px-3 py-1.5">
          <select disabled={sheetLocked} title={sheetLocked ? tip : undefined} className={`${CELL} w-24`} value={v.packagingShift} onChange={set("packagingShift")}>
            <option value="">—</option>
            <option value="Day">Day</option>
            <option value="Night">Night</option>
          </select>
        </td>
        <td className="px-3 py-1.5">
          <input disabled={sheetLocked} title={sheetLocked ? tip : undefined} className={`${CELL} w-20 font-mono`} type="number" min="1" step="1" value={v.packagingManpowerCount} onChange={set("packagingManpowerCount")} />
        </td>
        <td className="px-3 py-1.5">
          <input disabled={sheetLocked} title={sheetLocked ? tip : undefined} className={`${CELL} w-44`} type="datetime-local" value={v.packagingStartAt} onChange={set("packagingStartAt")} />
        </td>
        <td className="px-3 py-1.5">
          <select disabled={sheetLocked} title={sheetLocked ? tip : undefined} className={`${CELL} w-40`} value={v.packagingStatus} onChange={set("packagingStatus")}>
            <option value="">—</option>
            {PACKAGING_STATUSES.map((s) => (
              <option key={s} value={s} disabled={isCompleted(s) && finishLocked}>
                {s}
              </option>
            ))}
          </select>
        </td>
        <td className="px-3 py-1.5">
          {pm && pm.required > 0 ? (
            <button type="button" onClick={() => setOpen((o) => !o)} className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-tiny font-bold ${pmDone ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`} title={pmDone ? "Every plan PM has its quantity" : `Missing: ${pm.missing.join(", ")}`}>
              {pm.logged} of {pm.required} {open ? "▴" : "▾"}
            </button>
          ) : (
            <button type="button" onClick={() => setOpen((o) => !o)} className="text-tiny font-bold text-slate-400 hover:text-brand-600">
              {open ? "Close" : "Open"}
            </button>
          )}
        </td>
        <td className="px-3 py-1.5">
          <input disabled={finishLocked} title={tip} className={`${CELL} w-44`} type="datetime-local" value={v.packagingEndAt} onChange={set("packagingEndAt")} />
        </td>
        <td className="px-3 py-1.5 text-right">
          <ActionMenu items={items} />
        </td>
      </tr>
      {open && (
        <tr className="bg-slate-50/70">
          <td colSpan={11} className="whitespace-normal px-4 py-3">
            <div className="space-y-4">
              <div className="space-y-1.5">
                <p className="text-micro font-bold uppercase tracking-wide text-brand-700">1 · RM Utilization (whole batch, before Packaging)</p>
                {batch.utilization ? <UtilizationFillForm batch={batch} category="RM" plantId={plan?.plant?.id} canEdit={canAct} /> : <p className="text-xs text-slate-400">Loading…</p>}
              </div>
              <div className="flex items-center gap-3">
                <label className="text-xs font-bold text-slate-600">Packaging remarks</label>
                <input disabled={finishLocked} title={tip} className="field !h-8 flex-1 !py-0 !text-xs" value={v.packagingRemarks} onChange={set("packagingRemarks")} placeholder={finishLocked ? "Opens once the RM and PM Utilization are complete" : ""} />
                {done && <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700"><Check className="h-3 w-3" strokeWidth={2.5} /> Completed</span>}
              </div>
              <div className="space-y-1.5">
                <p className="text-micro font-bold uppercase tracking-wide text-brand-700">2 · PM Utilization (after Packaging)</p>
                {!rmDone ? <p className="text-xs text-slate-400">Fill the RM Utilization first.</p> : batch.utilization ? <UtilizationFillForm batch={batch} category="PM" plantId={plan?.plant?.id} canEdit={canAct} /> : null}
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
