import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ChevronDown, ClipboardList, Download, Send } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useForwardIndent, useIndentBoard, type IndentBoardRow } from "../lib/hooks";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";
import { CustomerName } from "../components/CustomerName";
import { customerTypeLabel } from "../lib/customerTags";

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const isoDay = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const CATEGORY_LABEL = { RM: "Raw Material", PM: "Packaging Material" } as const;

// Production's Indent Issue tile. A run lands here once the Day Store has recorded the material (Stage 1). The indent IS the plan:
// the materials and quantities below come from the plan for the quantity PPIC released, and cannot be typed over. Production fills the
// slip and the dates and forwards the run to Dispensing, which the Day Store does next.
export function IndentIssuePage() {
  const { hasRole } = useAuth();
  const canAct = hasRole("PRODUCTION", "ADMIN");
  const { data, isLoading } = useIndentBoard();
  const filters = useTileFilters();
  const [openId, setOpenId] = useState<string | null>(null);
  const picked = (key: string) => filters.applied.picks[key] ?? [];
  const everyRow = data ?? [];
  const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const showPlant = distinct(everyRow.map((r) => r.plantName)).length > 1;

  const fields: FilterField[] = [
    { key: "po", label: "PO Number", options: distinct(everyRow.map((r) => r.poNumber)) },
    { key: "product", label: "Product", options: distinct(everyRow.map((r) => r.productName)) },
    ...(showPlant ? [{ key: "plant", label: "Plant", options: distinct(everyRow.map((r) => r.plantName)) }] : []),
  ];
  const rows = everyRow.filter(
    (r) => (!picked("po").length || picked("po").includes(r.poNumber ?? "")) && (!picked("product").length || picked("product").includes(r.productName)) && (!picked("plant").length || picked("plant").includes(r.plantName ?? "")),
  );
  const pg = useClientPaging(rows);
  const isFiltered = filters.activeCount > 0;

  function download() {
    const lines = rows.flatMap((r) =>
      r.materials.map((m) => ({
        "PO Number": r.poNumber ?? "",
        Customer: r.customerName,
        "Customer Type": customerTypeLabel(r.customerName),
        Product: r.productName,
        Plant: r.plantName ?? "",
        "Released Qty": r.releasedQty,
        "GRN No.": r.grnNo ?? "",
        "GRN Date": day(r.grnDate),
        Material: m.material,
        Category: CATEGORY_LABEL[m.category],
        Unit: m.unit,
        "Required Qty": m.requiredQty,
        "With Store": Math.round((m.receivedQty + m.atDayStoreQty) * 1000) / 1000,
        Short: m.shortQty,
        "Indent Slip": r.prodIndentSlipSign ?? "",
      })),
    );
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, "Indent Issue", "FLS Indent Issue", describeFilters(filters, fields), lines);
    XLSX.writeFile(wb, stampedName("FLS_Indent_Issue"));
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-amber-500/10 text-amber-600">
            <ClipboardList className="h-5 w-5" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Indent Issue</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} product{rows.length === 1 ? "" : "s"}
              {isFiltered ? ` of ${everyRow.length}` : ""} waiting for your indent. The materials come from the plan; fill the slip and dates and forward to Dispensing.
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm shrink-0" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey="indent-issue" fields={fields} dateLabel="Waiting since" hideDates />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title={isFiltered ? "Nothing matches these filters" : "No indent waiting"} hint="A product shows up here once the Store has recorded its material (Material Received & GRN)." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-micro font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2.5">PO</th>
                  <th className="px-4 py-2.5">Product</th>
                  {showPlant && <th className="px-4 py-2.5">Plant</th>}
                  <th className="px-4 py-2.5 text-right">Released</th>
                  <th className="px-4 py-2.5">GRN</th>
                  <th className="px-4 py-2.5">Materials</th>
                  <th className="px-4 py-2.5">Indent</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r) => {
                  const open = openId === r.id;
                  const short = r.materials.filter((m) => !m.covered).length;
                  return (
                    <Fragment key={r.id}>
                      <tr className="border-b border-slate-50">
                        <td className="px-4 py-2.5 font-mono text-slate-600">{r.poNumber ?? "—"}</td>
                        <td className="px-4 py-2.5 font-bold text-slate-800">
                          {r.productName}
                          <span className="block text-micro font-normal text-slate-400"><CustomerName name={r.customerName} /></span>
                        </td>
                        {showPlant && <td className="px-4 py-2.5 text-slate-600">{r.plantName ?? "—"}</td>}
                        <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                          {fmtQty(r.releasedQty)} {r.productUnit}
                          {r.releasedQty < r.orderQty - 1e-6 && <span className="block text-micro text-slate-400">of {fmtQty(r.orderQty)}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {r.grnNo ?? "—"}
                          <span className="block text-micro text-slate-400">{day(r.grnDate)}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`pill ${short === 0 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
                            {r.materials.length} material{r.materials.length === 1 ? "" : "s"}
                            {short > 0 ? ` · ${short} short` : " · all with Store"}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{r.prodIndentSlipSign ? "Slip noted" : "Pending"}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenId(open ? null : r.id)}>
                            {canAct ? "Fill & forward" : "View"} <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-slate-100">
                          <td colSpan={showPlant ? 8 : 7} className="whitespace-normal bg-slate-50/70 px-4 py-4">
                            <IndentForm row={r} canAct={canAct} onDone={() => setOpenId(null)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ClientPager pg={pg} />
        </div>
      )}
    </div>
  );
}

function IndentForm({ row, canAct, onDone }: { row: IndentBoardRow; canAct: boolean; onDone: () => void }) {
  const toast = useToast();
  const forward = useForwardIndent();
  const [slip, setSlip] = useState(row.prodIndentSlipSign ?? "");
  const [planDate, setPlanDate] = useState(isoDay(row.productionPlanDate) || new Date().toISOString().slice(0, 10));
  const [dispatchDate, setDispatchDate] = useState(isoDay(row.dispatchPlanDate));
  const [unit, setUnit] = useState(row.unit ?? row.productUnit);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!slip.trim()) return setError("Enter the indent slip sign / number.");
    try {
      await forward.mutateAsync({ id: row.id, prodIndentSlipSign: slip.trim(), productionPlanDate: planDate || undefined, dispatchPlanDate: dispatchDate || undefined, unit: unit.trim() || undefined });
      toast.success(`Indent issued for ${row.productName}. It is now with the Store for Dispensing.`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not forward this indent");
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[18rem_1fr]">
      <div className="space-y-2.5">
        <p className="label">Indent</p>
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">Indent slip sign / number</label>
          <input className="field !py-1.5 text-xs" value={slip} disabled={!canAct} onChange={(e) => setSlip(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-0.5 block text-micro text-slate-400">Production plan date</label>
            <input type="date" className="field !py-1.5 text-xs" value={planDate} disabled={!canAct} onChange={(e) => setPlanDate(e.target.value)} />
          </div>
          <div>
            <label className="mb-0.5 block text-micro text-slate-400">Dispatch plan date</label>
            <input type="date" className="field !py-1.5 text-xs" value={dispatchDate} disabled={!canAct} onChange={(e) => setDispatchDate(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">Unit</label>
          <input className="field !py-1.5 text-xs" value={unit} disabled={!canAct} onChange={(e) => setUnit(e.target.value)} />
        </div>
        {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
        {canAct && (
          <button type="button" className="btn-primary btn-sm w-full" disabled={forward.isPending} onClick={submit}>
            <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {forward.isPending ? "Forwarding…" : "Forward to Dispensing"}
          </button>
        )}
      </div>

      <div>
        <p className="label">Material of the plan for {fmtQty(row.releasedQty)} {row.productUnit}</p>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full whitespace-nowrap text-xs">
            <thead className="bg-slate-50 text-micro font-bold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">Material</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-right">Required</th>
                <th className="px-3 py-2 text-right">With Store</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {row.materials.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-slate-400">
                    No plan material found for this product.
                  </td>
                </tr>
              )}
              {row.materials.map((m) => (
                <tr key={`${m.category}-${m.material}`}>
                  <td className="px-3 py-1.5 font-bold text-slate-700">{m.material}</td>
                  <td className="px-3 py-1.5 text-slate-500">{m.category}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">
                    {fmtQty(m.requiredQty)} {m.unit}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">{fmtQty(Math.round((m.receivedQty + m.atDayStoreQty) * 1000) / 1000)}</td>
                  <td className="px-3 py-1.5">
                    {m.covered ? <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Covered</span> : <span className="pill border-amber-200 bg-amber-50 text-amber-700">{fmtQty(m.shortQty)} short</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-micro text-slate-400">These quantities come from the plan and are the same ones the Store dispenses.</p>
      </div>
    </div>
  );
}
