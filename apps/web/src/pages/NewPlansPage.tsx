import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ChevronDown, ClipboardCheck, Download, Layers, PackageOpen } from "lucide-react";
import { useCreatePreProduction, usePlansBoard, type PlanBoardRow } from "../lib/hooks";
import { ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import { PlanFromPpic } from "../components/PlanFromPpic";
import { BatchPanel, DividePanel } from "../components/PlansBoardPanels";
import type { PoReadinessItem } from "../lib/types";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { AgingCell, agingDays, inAgingBuckets } from "../components/AgingCell";
import { AGING_FIELD, TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { fmtQty } from "../lib/format";
import { exportPlansBoard, isBatchStage, isNewPlan, planStatusOf } from "../lib/plansBoardExport";
import { yieldPct } from "../lib/utilization";
import { describeFilters } from "../lib/excelReport";
import { CustomerName } from "../components/CustomerName";

type Section = "plan" | "batch";

// Utilization's own fields: a material matches when it has a quantity in any picked field (A-E), and / or its yield is in a picked range.
const QTY_FIELDS = [
  { key: "consumedQty", label: "A · Production", has: (m: PlanBoardRow["batches"][number]["materials"][number]) => m.consumedQty > 0 },
  { key: "wastedQty", label: "B · Wastage", has: (m: PlanBoardRow["batches"][number]["materials"][number]) => m.wastedQty > 0 },
  { key: "rejectedQty", label: "C · Rejected", has: (m: PlanBoardRow["batches"][number]["materials"][number]) => m.rejectedQty > 0 },
  { key: "sampleQty", label: "D · Sample", has: (m: PlanBoardRow["batches"][number]["materials"][number]) => m.sampleQty > 0 },
  { key: "returnedQty", label: "E · Return to Store", has: (m: PlanBoardRow["batches"][number]["materials"][number]) => m.returnedQty > 0 },
];
const YIELD_BUCKETS = [
  { label: "Below 80%", ok: (y: number | null) => y != null && y < 80 },
  { label: "80% to 90%", ok: (y: number | null) => y != null && y >= 80 && y < 90 },
  { label: "90% to 95%", ok: (y: number | null) => y != null && y >= 90 && y < 95 },
  { label: "95% and above", ok: (y: number | null) => y != null && y >= 95 },
  { label: "No yield yet", ok: (y: number | null) => y == null },
];

const STATUS_OPTIONS = ["Not started", "Preparing (stages)", "Ready for batches", "In production", "Dividing into batches"] as const;
const MODE_STATUS: Record<"plan" | "batch", string[]> = { plan: [STATUS_OPTIONS[0], STATUS_OPTIONS[4], STATUS_OPTIONS[1]], batch: [STATUS_OPTIONS[2], STATUS_OPTIONS[3]] };
const STATUS_PILL: Record<ReturnType<typeof planStatusOf>["key"], string> = {
  NOT_STARTED: "border-amber-200 bg-amber-50 text-amber-700",
  PREPARING: "border-sky-200 bg-sky-50 text-sky-700",
  READY: "border-emerald-200 bg-emerald-50 text-emerald-700",
  IN_PRODUCTION: "border-violet-200 bg-violet-50 text-violet-700",
};
const statusGroup = (r: PlanBoardRow) => (r.run?.batchFlow ? (isNewPlan(r) ? STATUS_OPTIONS[4] : STATUS_OPTIONS[3]) : { NOT_STARTED: STATUS_OPTIONS[0], PREPARING: STATUS_OPTIONS[1], READY: STATUS_OPTIONS[2], IN_PRODUCTION: STATUS_OPTIONS[3] }[planStatusOf(r).key]);

// Production's two lists, one row per product, each only its own stage:
//   New Plan (mode "plan")   plans PPIC has sent that have not cleared Line Clearance yet: start the run, see the plan
//   Batch    (mode "batch")  plans whose Line Clearance is approved: make batches. A batch starts with its start fields, Production logs its
//                            Utilization inside the same row, and only then can it take its output and be completed.
// The whole list, as filtered, downloads as one Excel file.
export function NewPlansPage({ mode = "plan" }: { mode?: "plan" | "batch" }) {
  const { data, isLoading } = usePlansBoard();
  const toast = useToast();
  const start = useCreatePreProduction();
  const filters = useTileFilters();
  const [open, setOpen] = useState<{ itemId: string; section: Section } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const all = (data ?? []).filter(mode === "batch" ? isBatchStage : isNewPlan);
  const distinctMany = (pick: (r: PlanBoardRow) => (string | null | undefined)[]) => [...new Set(all.flatMap(pick).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const distinct = (pick: (r: PlanBoardRow) => string | null | undefined) => distinctMany((r) => [pick(r)]);

  // A Plant login sees only its own Plant, so the Plant column and filter only show when more than one Plant is in the list.
  const showPlant = distinct((r) => r.plant?.name).length > 1;

  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct((r) => r.poNumber) },
    { key: "customer", label: "Customer", options: distinct((r) => r.customerName) },
    { key: "product", label: "Product", options: distinct((r) => r.productName) },
    { key: "type", label: "Product Type", options: distinct((r) => r.productCategory) },
    ...(showPlant ? [{ key: "plant", label: "Plant", options: distinct((r) => r.plant?.name) }] : []),
    { key: "status", label: "Status", options: MODE_STATUS[mode] },
    ...(mode === "batch"
      ? [
          // The batches, and the Utilization inside each
          { key: "batchno", label: "Batch No", options: distinctMany((r) => r.batches.map((b) => b.batchNo)) },
          { key: "shift", label: "Shift", options: ["Day", "Night"] },
          { key: "bstatus", label: "Batch Status", options: ["In progress", "Completed"] },
          { key: "matname", label: "Material", options: distinctMany((r) => [...r.batches.flatMap((b) => b.materials), ...r.unassigned].map((m) => m.itemName)) },
          { key: "matcat", label: "Material Category", options: ["Raw Material", "Packaging Material"] },
          { key: "usage", label: "Utilization", options: ["Logged", "Not logged yet"] },
          { key: "hasqty", label: "Utilization field (A–E)", options: [...QTY_FIELDS.map((f) => f.label)] },
          { key: "yieldb", label: "Yield", options: [...YIELD_BUCKETS.map((b) => b.label)] },
        ]
      : []),
    AGING_FIELD,
  ];
  const from = filters.applied.dateFrom;
  const to = filters.applied.dateTo;
  // Batch / Utilization filters: a plan stays when at least one of its batches matches, and only the matching batches and materials are
  // shown in its dropdowns (and downloaded).
  const batchActive = ["batchno", "shift", "bstatus"].some((k) => picked(k).length > 0);
  const utilActive = ["matname", "matcat", "usage", "hasqty", "yieldb"].some((k) => picked(k).length > 0);
  const batchOk = (b: PlanBoardRow["batches"][number]) =>
    (!picked("batchno").length || picked("batchno").includes(b.batchNo ?? "")) &&
    (!picked("shift").length || picked("shift").includes(b.shift ?? "")) &&
    (!picked("bstatus").length || picked("bstatus").includes(b.status === "COMPLETED" ? "Completed" : "In progress"));
  const matOk = (m: PlanBoardRow["batches"][number]["materials"][number]) =>
    (!picked("matname").length || picked("matname").includes(m.itemName)) &&
    (!picked("matcat").length || picked("matcat").includes(m.category === "RM" ? "Raw Material" : "Packaging Material")) &&
    (!picked("hasqty").length || QTY_FIELDS.some((f) => picked("hasqty").includes(f.label) && f.has(m))) &&
    (!picked("yieldb").length || YIELD_BUCKETS.some((b) => picked("yieldb").includes(b.label) && b.ok(yieldPct(m))));
  const matFilterActive = ["matname", "matcat", "hasqty", "yieldb"].some((k) => picked(k).length > 0);
  const usageOk = (b: PlanBoardRow["batches"][number]) => {
    const u = picked("usage");
    if (!u.length || u.length === 2) return true;
    return u.includes("Logged") ? b.materials.length > 0 : b.materials.length === 0;
  };
  const narrow = (r: PlanBoardRow): PlanBoardRow => {
    if (!batchActive && !utilActive) return r;
    const batches = r.batches
      .filter((b) => batchOk(b) && usageOk(b))
      .map((b) => (matFilterActive ? { ...b, materials: b.materials.filter(matOk) } : b))
      .filter((b) => !matFilterActive || b.materials.length > 0);
    return { ...r, batches, unassigned: matFilterActive ? r.unassigned.filter(matOk) : r.unassigned };
  };

  const rows = all.filter(
    (r) =>
      (!picked("po").length || picked("po").includes(r.poNumber ?? "")) &&
      (!picked("customer").length || picked("customer").includes(r.customerName)) &&
      (!picked("product").length || picked("product").includes(r.productName)) &&
      (!picked("type").length || picked("type").includes(r.productCategory ?? "")) &&
      (!picked("plant").length || picked("plant").includes(r.plant?.name ?? "")) &&
      (!picked("status").length || picked("status").includes(statusGroup(r))) &&
      (!from || r.sentAt.slice(0, 10) >= from) &&
      (!to || r.sentAt.slice(0, 10) <= to) &&
      inAgingBuckets(agingDays(r.sentAt), picked("aging")),
  )
    .map(narrow)
    .filter((r) => (!batchActive && !utilActive) || r.batches.length > 0);
  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;
  const notStarted = all.filter((r) => !r.run).length;

  // Starts the run at the Plant PPIC planned. The row stays where it is, so its Batch dropdown can carry on from here.
  async function startRun(r: PlanBoardRow, confirmNotReady = false): Promise<void> {
    try {
      await start.mutateAsync({ purchaseOrderItemId: r.itemId, plantId: r.plant?.id, confirmNotReady, batchFlow: true });
      toast.success("Production started.");
    } catch (err) {
      const shortItems = (err instanceof ApiError && (err.details as { items?: PoReadinessItem[] } | undefined)?.items) || null;
      if (shortItems && shortItems.length > 0) {
        const list = shortItems.map((i) => `• ${i.itemName} — needs ${i.requiredQty} ${i.unit}, only ${i.onHand} on hand`).join("\n");
        if (window.confirm(`This PO isn't showing as material-ready yet:\n\n${list}\n\nStart production anyway?`)) return startRun(r, true);
        return;
      }
      toast.error(err instanceof ApiError ? err.message : "Could not start production");
    }
  }

  async function download() {
    setDownloading(true);
    try {
      await exportPlansBoard(rows, describeFilters(filters, fields, "Sent on"));
    } catch {
      toast.error("Could not build the Excel file.");
    } finally {
      setDownloading(false);
    }
  }

  const toggle = (itemId: string, section: Section) => setOpen(open?.itemId === itemId && open.section === section ? null : { itemId, section });
  const dropBtn = (r: PlanBoardRow, section: Section, label: string) => {
    const isOpen = open?.itemId === r.itemId && open.section === section;
    return (
      <button
        type="button"
        onClick={() => toggle(r.itemId, section)}
        className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-tiny font-bold transition ${isOpen ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
      >
        {label} <ChevronDown className={`h-3 w-3 transition-transform ${isOpen ? "rotate-180" : ""}`} strokeWidth={2.5} />
      </button>
    );
  };

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="stat-icon bg-emerald-500/10 text-emerald-600">
            {mode === "batch" ? <Layers className="h-5 w-5" strokeWidth={2} /> : <ClipboardCheck className="h-5 w-5" strokeWidth={2} />}
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{mode === "batch" ? "Batch" : "New Plan"}</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} plan{rows.length === 1 ? "" : "s"}
              {isFiltered ? ` of ${all.length}` : ""}
              {mode === "batch" ? " with a batch cleared for production. Open Batch on a row: start the batch, fill its RM Utilization, then its end time." : notStarted > 0 ? ` from PPIC · ${notStarted} not started. Start the run and divide it into batches: each batch then goes through Indent Issue, Batch No, Dispensing and Line Clearance.` : " from PPIC. Divide each into batches: each batch then goes through Indent Issue, Batch No, Dispensing and Line Clearance."}
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm" disabled={downloading || rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> {downloading ? "Preparing…" : "Download Excel"}
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey={mode === "batch" ? "batches" : "new-plans"} fields={fields} dateLabel="Sent on" />

      {isLoading ? (
        <div className="skeleton h-48 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={PackageOpen} title={isFiltered ? "No matches" : mode === "batch" ? "No plans ready for batches" : "No plans yet"} hint={isFiltered ? "Nothing matches these filters." : mode === "batch" ? "A plan shows here once its Line Clearance is approved." : "Plans show here as soon as PPIC sends a product to Production."} accent="brand" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-micro font-bold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">PO Number</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Product Type</th>
                <th className="px-4 py-3 text-right">Quantity</th>
                {showPlant && <th className="px-4 py-3">Plant</th>}
                <th className="px-4 py-3">Aging</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">{mode === "batch" ? "Batch" : "Run"}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pg.rows.map((r) => {
                const status = planStatusOf(r);
                const isOpen = open?.itemId === r.itemId;
                return (
                  <Fragment key={r.itemId}>
                    <tr className={`transition hover:bg-slate-50 ${isOpen ? "bg-slate-50/70" : ""}`}>
                      <td className="px-4 py-3 font-semibold text-slate-700">{r.poNumber ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span className={`pill ${STATUS_PILL[status.key]}`}>{status.label}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-600"><CustomerName name={r.customerName} /></td>
                      <td className="whitespace-normal px-4 py-3 font-bold text-slate-800">{r.productName}</td>
                      <td className="px-4 py-3 text-slate-600">{r.productCategory ?? "—"}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-800">
                        {fmtQty(r.quantity)} {r.unit}
                        {r.releasedQty < r.quantity - 1e-6 && <span className="block font-sans text-micro font-bold text-amber-600">Released {fmtQty(r.releasedQty)} of {fmtQty(r.quantity)}</span>}
                      </td>
                      {showPlant && <td className="px-4 py-3">{r.plant ? <span className="font-semibold text-slate-700">{r.plant.name}</span> : <span className="text-rose-600">Not assigned</span>}</td>}
                      <td className="px-4 py-3">
                        <AgingCell since={r.sentAt} />
                      </td>
                      <td className="px-4 py-3">{dropBtn(r, "plan", "Plan")}</td>
                      <td className="px-4 py-3">
                        {mode === "batch" ? (
                          dropBtn(r, "batch", r.batches.length ? `Batch (${r.batches.length})` : "Batch")
                        ) : !r.run ? (
                          <button type="button" className="btn-primary btn-sm" disabled={start.isPending} onClick={() => void startRun(r)}>
                            {start.isPending ? "Starting…" : "Start run"}
                          </button>
                        ) : r.run.batchFlow ? (
                          dropBtn(r, "batch", r.batches.length ? `Batches (${r.batches.length})` : "Add batches")
                        ) : (
                          <Link to={`/pre-productions/${r.run.id}`} className="font-bold text-brand-700 hover:underline">
                            Open the run →
                          </Link>
                        )}
                      </td>
                    </tr>
                    {isOpen && open && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={showPlant ? 10 : 9} className="whitespace-normal px-4 py-4">
                          {open.section === "plan" && <PlanFromPpic poId={r.poId} itemId={r.itemId} />}
                          {open.section === "batch" &&
                            (mode === "batch" ? <BatchPanel row={r} onStart={() => void startRun(r)} starting={start.isPending} only={batchActive || utilActive ? new Set(r.batches.map((b) => b.id)) : undefined} /> : <DividePanel row={r} onStart={() => void startRun(r)} starting={start.isPending} />)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <ClientPager pg={pg} />
        </div>
      )}
    </div>
  );
}
