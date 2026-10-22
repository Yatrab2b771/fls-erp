import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { ArrowLeft, ChevronDown, ClipboardCheck, Download, PackageCheck, Send } from "lucide-react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useMyStoreInfo, useStoreBoard, useStoreStageForward, type StoreBoardRow, type StoreBoardStage } from "../lib/hooks";
import { useTileFilters } from "../lib/tileFilters";
import { useClientPaging } from "../lib/useClientPaging";
import { ClientPager } from "../components/Pagination";
import { TileFilterBar, type FilterField } from "../components/TileFilterBar";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { fmtQty } from "../lib/format";
import { addReportSheet, describeFilters, stampedName } from "../lib/excelReport";
import { CustomerName } from "../components/CustomerName";

const isoDay = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const today = () => new Date().toISOString().slice(0, 10);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

const COPY = {
  MATERIAL_RECEIVED: {
    title: "Material Received (GRN)",
    tileKey: "day-store-grn",
    blurb: "Products whose plan material you must record. Record the GRN once all of it is with your store; the product then goes to Production's Indent Issue.",
    empty: "No product is waiting for its GRN.",
    open: "Record GRN",
    excel: "FLS_Material_Received_GRN",
  },
  DISPENSING: {
    title: "Dispensing",
    tileKey: "day-store-dispensing",
    blurb: "Products whose indent Production has issued. Dispense the plan's material to Production: what the Plant lacks is issued from your store in the same step.",
    empty: "No product is waiting for Dispensing.",
    open: "Dispense",
    excel: "FLS_Dispensing",
  },
} as const;

// The Day Store's GRN and Dispensing tiles - the same step as on the run page, done from the list. Materials and quantities come
// from the plan (for the quantity PPIC released).
export function DayStoreStagePage({ stage }: { stage: StoreBoardStage }) {
  const copy = COPY[stage];
  const { hasRole } = useAuth();
  const { data: myStore } = useMyStoreInfo({ enabled: hasRole("STORE") });
  const canAct = hasRole("ADMIN") || (hasRole("STORE") && !!myStore?.scoped);
  const { data, isLoading } = useStoreBoard(stage);
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
    const lines = rows.flatMap<Record<string, unknown>>((r) =>
      stage === "DISPENSING"
        ? r.required.map((m) => ({
            "PO Number": r.poNumber ?? "",
            Product: r.productName,
            Plant: r.plantName ?? "",
            Material: m.itemName,
            Category: m.category,
            Unit: m.unit,
            "Required Qty": r3(m.requiredQty),
            "Dispensed So Far": r3(m.consumedQty),
            "Still To Dispense": r3(Math.max(0, m.requiredQty - m.consumedQty)),
            "Store Has": m.dayStoreQty,
            "Plant Has": m.plantQty,
          }))
        : r.materials.map((m) => ({
            "PO Number": r.poNumber ?? "",
            Product: r.productName,
            Plant: r.plantName ?? "",
            Material: m.material,
            Category: m.category,
            Unit: m.unit,
            "Required Qty": m.requiredQty,
            "With Store": r3(m.receivedQty + m.atDayStoreQty),
            Short: m.shortQty,
          })),
    );
    const wb = XLSX.utils.book_new();
    addReportSheet(wb, copy.title, `FLS ${copy.title}`, describeFilters(filters, fields), lines);
    XLSX.writeFile(wb, stampedName(copy.excel));
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.5} /> Dashboard
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="stat-icon bg-emerald-500/10 text-emerald-600">{stage === "DISPENSING" ? <Send className="h-5 w-5" strokeWidth={2} /> : <PackageCheck className="h-5 w-5" strokeWidth={2} />}</div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">{copy.title}</h1>
            <p className="text-sm text-slate-500">
              {rows.length.toLocaleString()} product{rows.length === 1 ? "" : "s"}
              {isFiltered ? ` of ${everyRow.length}` : ""}. {copy.blurb}
            </p>
          </div>
        </div>
        <button type="button" className="btn-primary btn-sm shrink-0" disabled={rows.length === 0} onClick={download}>
          <Download className="h-3.5 w-3.5" strokeWidth={2.25} /> Download Excel
        </button>
      </div>

      <TileFilterBar filters={filters} tileKey={copy.tileKey} fields={fields} dateLabel="Waiting since" hideDates />

      {isLoading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title={isFiltered ? "Nothing matches these filters" : copy.empty} />
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
                  <th className="px-4 py-2.5">Materials</th>
                  {stage === "DISPENSING" && <th className="px-4 py-2.5">Indent</th>}
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r) => {
                  const open = openId === r.id;
                  const total = stage === "DISPENSING" ? r.required.length : r.materials.length;
                  const pending = stage === "DISPENSING" ? r.required.filter((m) => !m.covered).length : r.materials.filter((m) => !m.covered).length;
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
                        <td className="px-4 py-2.5">
                          <span className={`pill ${pending === 0 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
                            {total} material{total === 1 ? "" : "s"}
                            {pending > 0 ? ` · ${pending} ${stage === "DISPENSING" ? "to dispense" : "short"}` : stage === "DISPENSING" ? " · all dispensed" : " · all covered"}
                          </span>
                        </td>
                        {stage === "DISPENSING" && <td className="px-4 py-2.5 text-slate-600">{r.prodIndentSlipSign ? `Slip ${r.prodIndentSlipSign}` : "—"}</td>}
                        <td className="px-4 py-2.5 text-right">
                          <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenId(open ? null : r.id)}>
                            {canAct ? copy.open : "View"} <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2.5} />
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-slate-100">
                          <td colSpan={showPlant ? 7 : 6} className="whitespace-normal bg-slate-50/70 px-4 py-4">
                            {stage === "MATERIAL_RECEIVED" ? <GrnForm row={r} canAct={canAct} onDone={() => setOpenId(null)} /> : <DispenseForm row={r} canAct={canAct} onDone={() => setOpenId(null)} />}
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

function GrnForm({ row, canAct, onDone }: { row: StoreBoardRow; canAct: boolean; onDone: () => void }) {
  const toast = useToast();
  const forward = useStoreStageForward();
  const [grnNo, setGrnNo] = useState(row.grnNo ?? "");
  const [grnDate, setGrnDate] = useState(isoDay(row.grnDate) || today());
  const [remarks, setRemarks] = useState(row.materialReceivedRemarks ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!grnNo.trim()) return setError("Enter the GRN number.");
    try {
      await forward.mutateAsync({ id: row.id, grnNo: grnNo.trim(), grnDate: grnDate || undefined, materialReceivedRemarks: remarks.trim() || undefined });
      toast.success(`GRN recorded for ${row.productName}. It now waits for Production's indent.`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record the GRN");
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[18rem_1fr]">
      <div className="space-y-2.5">
        <p className="label">GRN</p>
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">GRN number</label>
          <input className="field !py-1.5 text-xs" value={grnNo} disabled={!canAct} onChange={(e) => setGrnNo(e.target.value)} />
        </div>
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">GRN date</label>
          <input type="date" className="field !py-1.5 text-xs" value={grnDate} disabled={!canAct} onChange={(e) => setGrnDate(e.target.value)} />
        </div>
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">Remarks</label>
          <input className="field !py-1.5 text-xs" value={remarks} disabled={!canAct} onChange={(e) => setRemarks(e.target.value)} />
        </div>
        {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
        {canAct && (
          <button type="button" className="btn-primary btn-sm w-full" disabled={forward.isPending || !row.allCovered} onClick={submit} title={row.allCovered ? undefined : "All the plan's material must be with your store first"}>
            <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {forward.isPending ? "Saving…" : "Record GRN & forward"}
          </button>
        )}
        {canAct && !row.allCovered && <p className="text-micro font-bold text-amber-600">Material is still short. It can be recorded once everything is with your store.</p>}
      </div>
      <div>
        <p className="label">
          Plan material for {fmtQty(row.releasedQty)} {row.productUnit}
        </p>
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
              {row.materials.map((m) => (
                <tr key={`${m.category}-${m.material}`}>
                  <td className="px-3 py-1.5 font-bold text-slate-700">{m.material}</td>
                  <td className="px-3 py-1.5 text-slate-500">{m.category}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">
                    {fmtQty(m.requiredQty)} {m.unit}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">{fmtQty(r3(m.receivedQty + m.atDayStoreQty))}</td>
                  <td className="px-3 py-1.5">{m.covered ? <span className="pill border-emerald-200 bg-emerald-50 text-emerald-700">Covered</span> : <span className="pill border-amber-200 bg-amber-50 text-amber-700">{fmtQty(m.shortQty)} short</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

interface Line {
  qty: string;
  purpose: "PRODUCTION" | "SAMPLE" | "WASTE";
  gross: string;
  tare: string;
  arNo: string;
}

function DispenseForm({ row, canAct, onDone }: { row: StoreBoardRow; canAct: boolean; onDone: () => void }) {
  const toast = useToast();
  const forward = useStoreStageForward();
  // Pre-filled with what is still to dispense for each material; the Day Store may type the weighed quantity over it.
  const [lines, setLines] = useState<Record<string, Line>>(() =>
    Object.fromEntries(row.required.map((m) => [m.itemId, { qty: String(r3(Math.max(0, m.requiredQty - m.consumedQty))), purpose: "PRODUCTION" as const, gross: "", tare: "", arNo: "" }])),
  );
  const [rmDate, setRmDate] = useState(isoDay(row.rmDispensingDate) || today());
  const [pmDate, setPmDate] = useState(isoDay(row.pmIssuedDate) || today());
  const [remarks, setRemarks] = useState(row.rmDispensingRemarks ?? "");
  const [error, setError] = useState<string | null>(null);
  const set = (id: string, patch: Partial<Line>) => setLines((p) => ({ ...p, [id]: { ...p[id]!, ...patch } }));

  async function submit() {
    setError(null);
    const consumption = row.required
      .map((m) => ({ m, l: lines[m.itemId]! }))
      .filter(({ l }) => Number(l.qty) > 0)
      .map(({ m, l }) => ({
        itemId: m.itemId,
        quantity: Number(l.qty),
        unit: m.unit,
        purpose: l.purpose,
        grossWeight: l.gross ? Number(l.gross) : undefined,
        tareWeight: l.tare ? Number(l.tare) : undefined,
        arNo: l.arNo.trim() || undefined,
      }));
    try {
      const res = await forward.mutateAsync({
        id: row.id,
        consumption,
        rmDispensingDate: rmDate || undefined,
        pmIssuedDate: pmDate || undefined,
        rmDispensingRemarks: remarks.trim() || undefined,
      });
      if (res.currentStageId === "DISPENSING" && res.dispensingShortfall?.length) {
        const left = res.dispensingShortfall.slice(0, 3).map((s) => `${s.itemName} (${r3(s.requiredQty - s.consumedQty)} ${s.unit})`).join(", ");
        toast.error(`Saved, but not complete yet. Still to dispense: ${left}${res.dispensingShortfall.length > 3 ? " and more" : ""}.`);
      } else {
        toast.success(`${row.productName} dispensed. The material is now with Production.`);
        onDone();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not dispense");
    }
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full whitespace-nowrap text-xs">
          <thead className="bg-slate-50 text-micro font-bold uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">Material</th>
              <th className="px-3 py-2 text-right">Required</th>
              <th className="px-3 py-2 text-right">Dispensed</th>
              <th className="px-3 py-2 text-right">Store</th>
              <th className="px-3 py-2 text-right">Plant</th>
              <th className="px-3 py-2 text-left">Dispense now</th>
              <th className="px-3 py-2 text-left">Purpose</th>
              <th className="px-3 py-2 text-left">Gross / Tare / AR No.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {row.required.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-center text-slate-400">
                  No plan material found for this product.
                </td>
              </tr>
            )}
            {row.required.map((m) => {
              const l = lines[m.itemId]!;
              const toDispense = Math.max(0, m.requiredQty - m.consumedQty);
              const short = Number(l.qty) > m.plantQty + m.dayStoreQty + 1e-9;
              return (
                <tr key={m.itemId} className={m.covered ? "opacity-60" : ""}>
                  <td className="px-3 py-1.5 font-bold text-slate-700">
                    {m.itemName} <span className="font-normal text-slate-400">({m.category})</span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">
                    {fmtQty(r3(m.requiredQty))} {m.unit}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">{m.consumedQty ? fmtQty(r3(m.consumedQty)) : "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">{fmtQty(m.dayStoreQty)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-700">{fmtQty(m.plantQty)}</td>
                  <td className="px-3 py-1.5">
                    <input className={`field !h-7 w-24 !py-0 !text-right !text-xs ${short ? "!border-rose-300" : ""}`} type="number" min="0" step="any" value={l.qty} disabled={!canAct || toDispense <= 0} onChange={(e) => set(m.itemId, { qty: e.target.value })} />
                    {short && <span className="block text-micro font-bold text-rose-600">Store holds less</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    <select className="field !h-7 !py-0 text-xs" value={l.purpose} disabled={!canAct} onChange={(e) => set(m.itemId, { purpose: e.target.value as Line["purpose"] })}>
                      <option value="PRODUCTION">Production</option>
                      <option value="SAMPLE">Sample (QC)</option>
                      <option value="WASTE">Waste</option>
                    </select>
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex gap-1">
                      <input className="field !h-7 w-16 !py-0 !text-xs" type="number" min="0" step="any" placeholder="Gross" value={l.gross} disabled={!canAct} onChange={(e) => set(m.itemId, { gross: e.target.value })} />
                      <input className="field !h-7 w-16 !py-0 !text-xs" type="number" min="0" step="any" placeholder="Tare" value={l.tare} disabled={!canAct} onChange={(e) => set(m.itemId, { tare: e.target.value })} />
                      <input className="field !h-7 w-24 !py-0 !text-xs" placeholder="AR No." value={l.arNo} disabled={!canAct} onChange={(e) => set(m.itemId, { arNo: e.target.value })} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-4">
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">RM dispensing date</label>
          <input type="date" className="field !py-1.5 text-xs" value={rmDate} disabled={!canAct} onChange={(e) => setRmDate(e.target.value)} />
        </div>
        <div>
          <label className="mb-0.5 block text-micro text-slate-400">PM issued date</label>
          <input type="date" className="field !py-1.5 text-xs" value={pmDate} disabled={!canAct} onChange={(e) => setPmDate(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-0.5 block text-micro text-slate-400">Remarks</label>
          <input className="field !py-1.5 text-xs" value={remarks} disabled={!canAct} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}
      {canAct && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-micro text-slate-400">What the Plant does not hold yet is issued from your store in this step. Material is dispensed once every line reaches its required quantity.</p>
          <button type="button" className="btn-primary btn-sm shrink-0" disabled={forward.isPending} onClick={submit}>
            <Send className="h-3.5 w-3.5" strokeWidth={2.5} /> {forward.isPending ? "Dispensing…" : "Dispense & forward"}
          </button>
        </div>
      )}
    </div>
  );
}
